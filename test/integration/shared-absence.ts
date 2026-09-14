/**
 * Absence polling shared by the integration suites.
 *
 * It lives outside any one suite's helper file because it decides whether a
 * DELETION ASSERTION passes, which makes it the last piece of test code that
 * should only ever run when a cluster happens to be available. Keeping it free
 * of cluster imports lets `test/unit/wait-until-gone.test.ts` pin its
 * behaviour in the normal unit run.
 */
import { isNotFoundError } from '../../src/core/deployment/k8s-helpers.js';

/**
 * Poll until `read` reports the resource is gone.
 *
 * KRO and Flux process deletions through finalizers, so absence lags a beat
 * behind the call that requested it.
 *
 * **Only a Kubernetes 404 counts as gone.** Every other failure — a 401/403, a
 * 5xx, a request timeout, a dropped connection — is re-thrown IMMEDIATELY,
 * because it is evidence about the API call and not about the resource. A
 * poller that treats any thrown error as absence passes a deletion assertion
 * on an auth failure, which is precisely the assertion it was written to make.
 *
 * Re-throwing rather than retrying a bounded number of times is deliberate: a
 * retry loop still has to decide what to report once the budget is spent, and
 * both answers are wrong. Reporting "gone" reintroduces the original bug;
 * reporting "not gone" turns an API-side failure into a `false` that the
 * caller reads as a stuck finalizer, sending whoever debugs it at the wrong
 * subsystem. Re-throwing keeps the real API error attached to the test
 * failure, so a transient blip fails the suite loudly and legibly instead of
 * passing it quietly. The read itself is a single GET against the API server
 * the suite is already talking to; if that is flaky, the rest of the suite is
 * not trustworthy either.
 *
 * @param read - Reads the resource. Must reject with the Kubernetes API error.
 * @param timeoutMs - Total budget before reporting "still present".
 * @param options.pollIntervalMs - Delay between reads. Default 5s.
 * @returns `true` once the resource is confirmed absent, `false` on timeout.
 * @throws The underlying error, unchanged, for any failure that is not a 404.
 */
export async function waitUntilGone(
  read: () => Promise<unknown>,
  timeoutMs = 180_000,
  options: { pollIntervalMs?: number } = {}
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await read();
    } catch (error) {
      if (isNotFoundError(error)) return true;
      throw error;
    }
    await Bun.sleep(pollIntervalMs);
  }
  return false;
}
