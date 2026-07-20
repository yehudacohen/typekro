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
 */
export async function callWithTimeout<T>(op: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} exceeded its ${timeoutMs}ms request timeout — the Kubernetes API call did not return. ` +
                  `The usual cause is a wedged or expired kubeconfig exec credential (e.g. an AWS SSO/EKS token ` +
                  `that expired mid-deploy). Re-run with fresh credentials.`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The per-call budget: the configured HTTP read timeout, but never more than the poll's remaining
 * deadline (so one wedged call can't overshoot the overall `timeout`), and never less than a small floor
 * (so a nearly-elapsed poll still gives the final attempt a fair chance to settle).
 */
export function perCallTimeout(remainingMs: number, capMs: number): number {
  const FLOOR_MS = 1_000;
  return Math.max(FLOOR_MS, Math.min(capMs, remainingMs));
}
