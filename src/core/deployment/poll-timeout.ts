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

/** Thrown when a readiness-poll API call exceeds its per-call budget (distinguishable so callers can fail fast vs. retry). */
export class PollTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(
      `${label} exceeded its ${timeoutMs}ms request timeout — the Kubernetes API call did not return. ` +
        `The usual cause is a wedged or expired kubeconfig exec credential (e.g. an AWS SSO/EKS token ` +
        `that expired mid-deploy). Re-run with fresh credentials.`
    );
    this.name = 'PollTimeoutError';
    this.timeoutMs = timeoutMs;
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
