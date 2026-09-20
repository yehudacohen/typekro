/**
 * Per-call timeout for readiness-poll Kubernetes API requests.
 *
 * Readiness polls loop as `while (Date.now() - startTime < timeout) { await k8sApi.read(...) }`. The
 * deadline is only re-checked between iterations, so it relies on each `await` eventually settling. When
 * the kubeconfig's exec credential WEDGES — e.g. `aws eks get-token` hangs, or the AWS/SSO session
 * expired mid-deploy so the auth plugin never returns — the awaited request never resolves OR rejects,
 * the loop never re-evaluates its deadline, and the whole deploy hangs SILENTLY (observed multi-hour).
 *
 * Bounding each call converts that wedge into a rejection, so the poll's existing error handling runs and
 * the configured `timeout` is honored: a failed/expired credential is not a transient "not ready yet" —
 * it counts against the deadline (or fails fast) instead of hanging forever.
 *
 * SCOPE / LIMITATION: this bounds the caller's `await` (so the poll and the deploy terminate). It does
 * NOT cancel the in-flight request or kill a wedged exec-auth subprocess: `@kubernetes/client-node`'s
 * `KubernetesObjectApi.read` does not thread an `AbortSignal` to its fetch, and its `ExecAuth` spawns the
 * credential process (`child_process.spawn`) with no cancellation hook. A wedged subprocess can therefore
 * keep the Node process alive until it exits or the process is terminated. The durable cure for the
 * exec-auth failure mode is to avoid per-request exec auth during polling (e.g. a pre-minted bearer token
 * in the kubeconfig), so no credential subprocess is spawned in the first place.
 */

import {
  DEFAULT_HTTP_DELETE_TIMEOUT,
  DEFAULT_HTTP_READ_TIMEOUT,
  DEFAULT_HTTP_WRITE_TIMEOUT,
} from '../config/defaults.js';
import type { TypeKroLogger } from '../logging/types.js';

/**
 * A Kubernetes request that did not return within its budget — whichever layer noticed first.
 *
 * TWO layers can time the same request out, and callers must not have to care which won. The Bun
 * HTTP library arms its socket timer synchronously while the request is being issued; a wrapper
 * added by {@link withCallDeadline} arms its timer afterwards. With equal budgets the socket timer
 * therefore fires FIRST, so a gate that recognised only the wrapper's error would treat a genuine
 * timeout as an ordinary failure — and a gate that fails OPEN on ordinary failures would silently
 * skip its assertion. Both layers raise this type; {@link isRequestTimeoutError} recognises it.
 */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  /** Structural marker, so recognition survives duplicate module instances where `instanceof` does not. */
  readonly isRequestTimeout = true as const;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** True for a timeout raised by EITHER timing layer — the socket's or a {@link withCallDeadline} wrapper's. */
export function isRequestTimeoutError(error: unknown): error is RequestTimeoutError {
  if (error instanceof RequestTimeoutError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isRequestTimeout?: unknown }).isRequestTimeout === true
  );
}

/**
 * What the timing layer knows about the request's context, so the timeout's hint can point at the
 * cause that is actually possible instead of the one that is merely common.
 */
export interface RequestTimeoutDiagnostics {
  /**
   * Whether the kubeconfig's current user authenticates through an `exec` credential plugin.
   * `true` names the wedged/expired-credential cause; `false` rules it out and describes a stalled
   * connection instead; `undefined` (the credential shape is not known at this layer) hedges.
   * See {@link usesExecCredential}.
   */
  readonly usesExecCredential?: boolean | undefined;
}

/**
 * The hint appended to a {@link PollTimeoutError}. Only a kubeconfig that actually carries an
 * `exec` block can suffer a wedged or expired exec credential; a pre-minted token or a client
 * certificate cannot, and for those the honest reading is a connection that stalled — a connect
 * or first write that never completed, or a server that accepted the connection and never
 * answered. Naming the exec cause for such a kubeconfig sent operators chasing credentials that
 * were fine (#213).
 */
function requestTimeoutHint(diagnostics: RequestTimeoutDiagnostics | undefined): string {
  switch (diagnostics?.usesExecCredential) {
    case true:
      return (
        `The usual cause is a wedged or expired kubeconfig exec credential (e.g. an AWS SSO/EKS token ` +
        `that expired mid-deploy). Re-run with fresh credentials.`
      );
    case false:
      return (
        `The kubeconfig does not use an exec credential plugin, so a wedged exec credential cannot be ` +
        `the cause: the connection stalled before the API server answered (a connect or first write ` +
        `that never completed, or a server that accepted the connection and never responded).`
      );
    default:
      return (
        `If the kubeconfig authenticates through an exec credential plugin (e.g. an AWS SSO/EKS token), ` +
        `a wedged or expired exec credential is the usual cause — re-run with fresh credentials. ` +
        `Otherwise the connection stalled before the API server answered.`
      );
  }
}

/** Thrown when a readiness-poll API call exceeds its per-call budget (distinguishable so callers can fail fast vs. retry). */
export class PollTimeoutError extends RequestTimeoutError {
  constructor(label: string, timeoutMs: number, diagnostics?: RequestTimeoutDiagnostics) {
    super(
      `${label} exceeded its ${timeoutMs}ms request timeout — the Kubernetes API call did not return. ` +
        requestTimeoutHint(diagnostics),
      timeoutMs
    );
    this.name = 'PollTimeoutError';
  }
}

/**
 * Whether a kubeconfig's CURRENT user authenticates through an `exec` credential plugin. Duck-typed
 * on `getCurrentUser` so the timing layer does not depend on the Kubernetes client's types, and
 * `undefined` when there is no kubeconfig to ask or it has no current user — the caller then gets
 * the hedged hint rather than a claim either way.
 */
export function usesExecCredential(
  kubeConfig: { getCurrentUser?: () => object | null | undefined } | null | undefined
): boolean | undefined {
  if (!kubeConfig || typeof kubeConfig.getCurrentUser !== 'function') return undefined;
  const user = kubeConfig.getCurrentUser();
  if (!user) return undefined;
  const exec = (user as { readonly exec?: unknown }).exec;
  return exec !== undefined && exec !== null;
}

/**
 * What a request timeout looked like from the caller's side, for the warn line that precedes the
 * re-issue. The two shapes {@link isRequestTimeoutError} accepts carry different numbers in
 * `timeoutMs`: a budget that EXPIRED (the socket timer's or the deadline wrapper's), or, for a
 * premature close, how long the request RAN before the transport died with budget to spare. Calling
 * the latter a budget would be false, so the shapes are told apart by name — the transport's error
 * class is defined downstream of this module and cannot be imported here.
 */
function describeRequestTimeout(error: RequestTimeoutError): {
  readonly summary: string;
  readonly meta: Record<string, unknown>;
} {
  if (error.name === 'PrematureCloseError') {
    return {
      summary: `the connection closed after ${error.timeoutMs}ms without a complete response`,
      meta: { elapsedMs: error.timeoutMs },
    };
  }
  return {
    summary: `the read did not return within its ${error.timeoutMs}ms budget`,
    meta: { timeoutMs: error.timeoutMs },
  };
}

/**
 * Run an IDEMPOTENT read, and re-issue it exactly once if the first attempt is a request timeout.
 *
 * The failure this rides out is a single request — typically the FIRST one a freshly constructed
 * client makes — that never completes although the API server is healthy and the same GET succeeds
 * from another client within a second (#213). Before this, one such 30 s stall of a ~2 KB
 * drift-check GET failed a 20-minute converge.
 *
 * Whether the re-issued request travels on a new connection is the HTTP library's business, not a
 * promise made here. Under Bun the library issues every request on its own connection (`agent:
 * false`, `Connection: close`), so the retry never reuses the socket that stalled; the stock Node
 * client may hand it a pooled socket. Either way it is one more request and nothing else.
 *
 * BOUNDS. Only a request timeout is retried — {@link isRequestTimeoutError}, i.e. the socket timer's
 * `RequestTimeoutError`, the deadline wrapper's `PollTimeoutError` and the transport's
 * `PrematureCloseError`, all of which mean "the server never answered" — and only once, so the
 * worst case is two read budgets. An HTTP error the server DID answer with (404, 403, 5xx), a TLS
 * failure or an abort is thrown immediately: those are answers, or the caller's own decision, not
 * a stall. The caller's abort signal is checked before the second attempt so a cancelled converge
 * does not issue one more request. READS ONLY: a create, update or delete that timed out may have
 * been applied by a server that simply had not answered yet, so re-issuing it is not safe here.
 *
 * When the retry times out as well, the error is the retry's own, with a note that the request was
 * already re-issued once, so nobody reads the message as "try again".
 */
export async function retryOnceOnRequestTimeout<T>(
  read: () => Promise<T>,
  options: {
    /** Names the resource being read in the warn line and the final error. */
    readonly label: string;
    readonly logger: Pick<TypeKroLogger, 'warn'>;
    readonly abortSignal?: AbortSignal | undefined;
  }
): Promise<T> {
  const { label, logger, abortSignal } = options;
  try {
    return await read();
  } catch (firstError: unknown) {
    if (!isRequestTimeoutError(firstError)) throw firstError;
    // An abort that landed while the first attempt was in flight is the caller's decision, not a
    // stall to ride out; it must surface as the abort, and no second request may leave.
    abortSignal?.throwIfAborted();
    const { summary, meta } = describeRequestTimeout(firstError);
    logger.warn(`${label}: ${summary} — re-issuing the read once`, {
      label,
      ...meta,
      error: firstError.message,
    });
    try {
      return await read();
    } catch (retryError: unknown) {
      if (isRequestTimeoutError(retryError)) {
        retryError.message += `\n${label} was already re-issued once after a first attempt timed out; the retry did not return either.`;
      }
      throw retryError;
    }
  }
}

/**
 * Run `op`, rejecting with {@link PollTimeoutError} if it hasn't settled within `timeoutMs`.
 *
 * PRECONDITION: `timeoutMs` must be positive — callers pass a per-call budget derived from the poll's
 * REMAINING deadline (see {@link perCallTimeout}) and must handle an exhausted (≤0) budget themselves by
 * exiting their loop and throwing their own overall-timeout error. A `PollTimeoutError` therefore always
 * means "an operation that actually started did not return in time" (a wedged call), never "the overall
 * poll deadline had already elapsed" — the two are distinct and must not be conflated.
 */
export async function callWithTimeout<T>(
  op: () => Promise<T>,
  timeoutMs: number,
  label: string,
  abortSignal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachAbort = (): void => undefined;
  try {
    abortSignal?.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      if (!abortSignal) return;
      const onAbort = () =>
        reject(abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      abortSignal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => abortSignal.removeEventListener('abort', onAbort);
    });
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PollTimeoutError(label, timeoutMs)), timeoutMs);
      }),
      aborted,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    detachAbort();
  }
}

/**
 * The per-call budget: the configured cap (HTTP read timeout), capped STRICTLY by the poll's remaining
 * deadline so one call can never overshoot the overall `timeout`. Returns ≤ 0 when the deadline is
 * already spent; callers MUST treat a ≤0 budget as "deadline reached" — exit the poll loop and throw the
 * poll's own overall-timeout error — rather than starting a (doomed) call. Never hand a ≤0 value to
 * {@link callWithTimeout}.
 */
export function perCallTimeout(remainingMs: number, capMs: number): number {
  return Math.min(capMs, remainingMs);
}

/**
 * The per-verb request budget {@link withCallDeadline} applies. Reads are expected to be quick;
 * creates and updates may sit behind admission webhooks; deletes may wait on finalizers — the same
 * split the repo's HTTP defaults already make, so a caller's configured `httpTimeouts` is honored
 * per verb instead of being flattened onto the read budget. `create` and `update` are kept APART
 * because `HttpTimeoutConfig` exposes them separately: collapsing them into one write budget makes
 * one of the two configured values unreachable.
 */
export interface CallDeadlineBudget {
  /** GET / LIST and anything not classified as a create, an update or a delete. */
  readonly read: number;
  /** POST — `create*`. */
  readonly create: number;
  /** PUT / PATCH — `replace*`, `patch*`, server-side apply. */
  readonly update: number;
  /** DELETE. */
  readonly delete: number;
}

/** A positive, finite number, or `fallback`. Guards against `0`, `-1`, `NaN` and `Infinity`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Derive a per-verb budget from a caller's {@link HttpTimeoutConfig}-shaped options, each verb
 * capped by `capMs` (normally the deployment timeout) so one request can never outlive the
 * operation it belongs to. Non-positive / non-finite values fall back to the repo defaults —
 * notably `timeout: 0`, which is NOT nullish and would otherwise collapse every budget to zero.
 */
export function callDeadlineBudget(
  timeouts:
    | {
        readonly default?: number | undefined;
        readonly create?: number | undefined;
        readonly update?: number | undefined;
        readonly delete?: number | undefined;
      }
    | undefined,
  capMs?: number
): CallDeadlineBudget {
  const cap = positiveOr(capMs, Number.POSITIVE_INFINITY);
  // NO cross-fallback between `create` and `update`: they are separate knobs in `HttpTimeoutConfig`
  // and each falls back only to the shared write default. Letting one stand in for the other means a
  // caller who configured `{ create: 180_000, update: 30_000 }` silently gets 180s on every PATCH —
  // exactly the conflation this budget exists to avoid.
  return {
    read: Math.min(positiveOr(timeouts?.default, DEFAULT_HTTP_READ_TIMEOUT), cap),
    create: Math.min(positiveOr(timeouts?.create, DEFAULT_HTTP_WRITE_TIMEOUT), cap),
    update: Math.min(positiveOr(timeouts?.update, DEFAULT_HTTP_WRITE_TIMEOUT), cap),
    delete: Math.min(positiveOr(timeouts?.delete, DEFAULT_HTTP_DELETE_TIMEOUT), cap),
  };
}

/** Method-name fragments that identify a create (POST). Matched case-insensitively. */
const CREATE_METHOD_PATTERN = /create|post/i;
/** Method-name fragments that identify an update (PUT / PATCH, including server-side apply). */
const UPDATE_METHOD_PATTERN = /replace|patch|update|put|apply/i;
/** Method-name fragments that identify a delete. Matched case-insensitively, checked FIRST. */
const DELETE_METHOD_PATTERN = /delete|remove/i;

/**
 * Classify a client method by name so it is bounded by its own verb's budget, matching the split the
 * HTTP layer already makes by method (POST → create, PUT/PATCH → update, DELETE → delete). Anything
 * else — `read`, `list`, `get*`, `listClusterCustomObject`, and any method a future client version
 * adds — is treated as a READ, the shortest budget. Erring toward the short budget is deliberate: a
 * misclassified call fails fast and visibly rather than hanging. A combined name (`createOrReplace`)
 * resolves to `create`, the verb such a helper attempts first.
 */
export function callDeadlineVerb(method: string): keyof CallDeadlineBudget {
  if (DELETE_METHOD_PATTERN.test(method)) return 'delete';
  if (CREATE_METHOD_PATTERN.test(method)) return 'create';
  if (UPDATE_METHOD_PATTERN.test(method)) return 'update';
  return 'read';
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Race an already-started operation against its budget and an abort signal. Unlike
 * {@link callWithTimeout} a non-positive / non-finite budget is allowed: the abort race still
 * applies, only the timer is skipped. Used by {@link withCallDeadline}, where dropping the abort
 * plumbing because a budget was misconfigured would be its own silent hang.
 */
function raceDeadline<T>(
  operation: Promise<T>,
  budgetMs: number,
  label: string,
  abortSignal?: AbortSignal,
  diagnostics?: RequestTimeoutDiagnostics
): Promise<T> {
  const bounded = Number.isFinite(budgetMs) && budgetMs > 0;
  if (!bounded && !abortSignal) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachAbort = (): void => undefined;
  const races: Promise<T>[] = [operation];
  if (bounded) {
    races.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PollTimeoutError(label, budgetMs, diagnostics)),
          budgetMs
        );
      })
    );
  }
  if (abortSignal) {
    races.push(
      new Promise<never>((_, reject) => {
        if (abortSignal.aborted) {
          reject(abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        const onAbort = () =>
          reject(abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        abortSignal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => abortSignal.removeEventListener('abort', onAbort);
      })
    );
  }
  return Promise.race(races).finally(() => {
    if (timer) clearTimeout(timer);
    detachAbort();
  });
}

/**
 * Wrap a Kubernetes API client so every request it issues is bounded by its verb's budget.
 *
 * Readiness polls already bound their own calls (see {@link callWithTimeout}); everything a handler
 * does AROUND a deploy — drift checks, safety gates, CRD migrations, teardown — historically did
 * not, so a single wedged request (a hung exec credential, a half-open socket, an API server that
 * accepts the connection and never answers) hangs the whole reconcile with no log line and no
 * error. Bounding at the client makes each of those calls reject with a {@link PollTimeoutError}
 * naming the client and the method.
 *
 * EVERY function-valued property is wrapped, not an allow-list of known method names: a client
 * method this module has never heard of must not silently escape the bound. A wrapped call whose
 * return value is not thenable is handed back untouched, so synchronous helpers keep working.
 *
 * Same SCOPE / LIMITATION as {@link callWithTimeout}: this bounds the caller's `await`, it does not
 * cancel the in-flight request or kill a wedged exec-auth subprocess.
 */
export function withCallDeadline<T extends object>(
  api: T,
  options: {
    readonly budget: CallDeadlineBudget;
    readonly label: string;
    readonly abortSignal?: AbortSignal;
    /**
     * Whether the kubeconfig behind `api` uses an exec credential plugin, so a timeout's hint names
     * a cause that is possible for THIS client. See {@link usesExecCredential}.
     */
    readonly usesExecCredential?: boolean | undefined;
  }
): T {
  const { budget, label, abortSignal } = options;
  const diagnostics: RequestTimeoutDiagnostics = { usesExecCredential: options.usesExecCredential };
  const wrapped = new WeakMap<object, unknown>();
  return new Proxy(api, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const cached = wrapped.get(value);
      if (cached) return cached;
      const method = value as (...args: unknown[]) => unknown;
      const budgetMs = budget[callDeadlineVerb(property)];
      const bound = (...args: unknown[]): unknown => {
        // Check the signal BEFORE the call, not just inside `raceDeadline`. Racing an
        // already-aborted signal still STARTS the request: the caller's promise rejects, but the
        // write or delete has already left for the API server. In a replacement sequence
        // (delete → wait for the 404 → create) an abort landing in that window would cancel the
        // deployment and create the object anyway.
        abortSignal?.throwIfAborted();
        const result = method.apply(target, args);
        if (!isThenable(result)) return result;
        return raceDeadline(result, budgetMs, `${label} ${property}`, abortSignal, diagnostics);
      };
      wrapped.set(value, bound);
      return bound;
    },
  });
}
