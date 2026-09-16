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

/** Thrown when a readiness-poll API call exceeds its per-call budget (distinguishable so callers can fail fast vs. retry). */
export class PollTimeoutError extends RequestTimeoutError {
  constructor(label: string, timeoutMs: number) {
    super(
      `${label} exceeded its ${timeoutMs}ms request timeout — the Kubernetes API call did not return. ` +
        `The usual cause is a wedged or expired kubeconfig exec credential (e.g. an AWS SSO/EKS token ` +
        `that expired mid-deploy). Re-run with fresh credentials.`,
      timeoutMs
    );
    this.name = 'PollTimeoutError';
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
 * writes may sit behind admission webhooks; deletes may wait on finalizers — the same split the
 * repo's HTTP defaults already make, so a caller's configured `httpTimeouts` is honored per verb
 * instead of being flattened onto the read budget.
 */
export interface CallDeadlineBudget {
  /** GET / LIST and anything not classified as a write or a delete. */
  readonly read: number;
  /** POST / PUT / PATCH. */
  readonly write: number;
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
  const write = Math.min(
    positiveOr(timeouts?.create ?? timeouts?.update, DEFAULT_HTTP_WRITE_TIMEOUT),
    cap
  );
  return {
    read: Math.min(positiveOr(timeouts?.default, DEFAULT_HTTP_READ_TIMEOUT), cap),
    write,
    delete: Math.min(positiveOr(timeouts?.delete, DEFAULT_HTTP_DELETE_TIMEOUT), cap),
  };
}

/** Method-name fragments that identify a write. Matched case-insensitively. */
const WRITE_METHOD_PATTERN = /create|replace|patch|update|put|post|apply/i;
/** Method-name fragments that identify a delete. Matched case-insensitively, checked FIRST. */
const DELETE_METHOD_PATTERN = /delete|remove/i;

/**
 * Classify a client method by name so it is bounded by its own verb's budget. Anything that is
 * neither a delete nor a write — `read`, `list`, `get*`, `listClusterCustomObject`, and any method
 * a future client version adds — is treated as a READ, the shortest budget. Erring toward the short
 * budget is deliberate: a misclassified call fails fast and visibly rather than hanging.
 */
export function callDeadlineVerb(method: string): keyof CallDeadlineBudget {
  if (DELETE_METHOD_PATTERN.test(method)) return 'delete';
  if (WRITE_METHOD_PATTERN.test(method)) return 'write';
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
  abortSignal?: AbortSignal
): Promise<T> {
  const bounded = Number.isFinite(budgetMs) && budgetMs > 0;
  if (!bounded && !abortSignal) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachAbort = (): void => undefined;
  const races: Promise<T>[] = [operation];
  if (bounded) {
    races.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PollTimeoutError(label, budgetMs)), budgetMs);
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
  }
): T {
  const { budget, label, abortSignal } = options;
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
        const result = method.apply(target, args);
        if (!isThenable(result)) return result;
        return raceDeadline(result, budgetMs, `${label} ${property}`, abortSignal);
      };
      wrapped.set(value, bound);
      return bound;
    },
  });
}
