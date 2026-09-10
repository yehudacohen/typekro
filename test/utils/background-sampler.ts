/**
 * A background polling sampler for integration tests, with a cleanup contract.
 *
 * ⚠️ WHY THIS IS A MODULE AND NOT FOUR LINES INLINE. It started as four lines
 * inline — a `let sampling = true`, an async IIFE looping on it, and
 * `sampling = false; await sampler` at the bottom of the case. That leaks on
 * every unhappy path: a failed patch, an API error or a failed `expect` before
 * the bottom of the case skips the stop entirely and the loop keeps polling the
 * cluster forever. Under `bun test` that is not a tidy little leak — the runner
 * cannot interrupt a busy async loop, so the process hangs after the failure
 * and the REAL error is buried under a timeout (or never printed at all),
 * which is exactly the "silent hang" the suite's progress markers exist to
 * prevent.
 *
 * So the lifecycle is owned here instead:
 *
 * - {@link startBackgroundSampler} returns a handle whose `stop()` is
 *   IDEMPOTENT and always resolves once the loop has actually exited. Call it
 *   in a `finally` around the whole case body and the leak is unrepresentable.
 * - The loop checks the abort signal between iterations AND treats the
 *   inter-sample wait as abortable, so `stop()` returns promptly instead of
 *   after one more full interval.
 * - A sample that throws is counted as a miss, not a failure: a transient
 *   `list` error must not decide the assertion the samples feed. A sampler that
 *   throws would also reject a promise nobody is awaiting yet.
 *
 * This module is deliberately cluster-free — it takes a `sample` callback and
 * nothing else — so the contract above is unit-testable without a cluster. See
 * `test/utils/background-sampler.test.ts`.
 */

/** A running sampler. `stop()` is idempotent and awaits the loop's exit. */
export interface BackgroundSampler<T> {
  /** Values returned by successful samples, in order. */
  readonly samples: readonly T[];
  /** Samples that threw. Kept for reporting, never fatal. */
  readonly errors: readonly unknown[];
  /** True once {@link stop} has been called. */
  readonly stopped: boolean;
  /**
   * Signal the loop to stop and wait for it to exit.
   *
   * Safe to call any number of times, from a `finally`, after the loop has
   * already ended, or before it has taken its first sample. Never throws —
   * a sampler that threw during cleanup would mask the error that triggered
   * the cleanup.
   */
  stop(): Promise<void>;
}

/** Options for {@link startBackgroundSampler}. */
export interface BackgroundSamplerOptions<T> {
  /** One observation. May throw or reject; that is recorded, not propagated. */
  sample: () => T | Promise<T>;
  /** Delay between samples, in milliseconds. */
  intervalMs: number;
  /**
   * Abortable sleep. Defaults to a real timer; a test passes a fake one to
   * drive the loop deterministically instead of waiting on wall time.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Sleep that resolves early — and never rejects — when the signal aborts.
 *
 * Resolving rather than rejecting on abort is what lets the loop treat "time
 * to stop" and "time for the next sample" identically: it re-checks the signal
 * at the top either way, so there is no abort path that skips the check.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Start sampling in the background until stopped.
 *
 * @param options - The sample callback and its interval
 * @returns A handle carrying the samples so far and an idempotent `stop()`
 *
 * @example
 * ```typescript
 * const sampler = startBackgroundSampler({ sample: livePods, intervalMs: 500 });
 * try {
 *   // …the whole case body, however it ends…
 * } finally {
 *   await sampler.stop();
 * }
 * ```
 */
export function startBackgroundSampler<T>(
  options: BackgroundSamplerOptions<T>
): BackgroundSampler<T> {
  const { sample, intervalMs, sleep = abortableSleep } = options;
  const samples: T[] = [];
  const errors: unknown[] = [];
  const controller = new AbortController();
  const signal = controller.signal;

  const loop = (async () => {
    // The signal is checked at the TOP of every iteration, so an abort that
    // lands while a sample is in flight ends the loop before the next one —
    // there is no window in which `stop()` has resolved and a sample is still
    // scheduled.
    while (!signal.aborted) {
      try {
        samples.push(await sample());
      } catch (error) {
        errors.push(error);
      }
      if (signal.aborted) break;
      await sleep(intervalMs, signal);
    }
  })();

  // Nothing awaits `loop` until `stop()` does, so an unexpected throw inside it
  // would surface as an unhandled rejection and take the process down with a
  // message about the sampler rather than about the test. The body above cannot
  // throw, and this makes that structural.
  const settled = loop.catch((error) => {
    errors.push(error);
  });

  let stopping: Promise<void> | undefined;
  return {
    samples,
    errors,
    get stopped() {
      return signal.aborted;
    },
    stop(): Promise<void> {
      // Idempotent: the same promise is handed back to every caller, so a
      // `finally` that runs after an explicit stop is a no-op rather than a
      // second abort or a second await.
      stopping ??= (() => {
        controller.abort();
        return settled;
      })();
      return stopping;
    },
  };
}
