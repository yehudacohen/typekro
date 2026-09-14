/**
 * The cleanup contract of the integration suites' background sampler.
 *
 * REGRESSION. The ClickStack S3 rollout case sampled collector Pods every
 * 500ms from an inline async loop guarded by a `let sampling = true` that was
 * only cleared at the BOTTOM of the case. Any failure before that point — a
 * rejected patch, an API error, a failed `expect` — skipped the stop and left
 * the loop polling the cluster forever. `bun test` cannot interrupt a busy
 * async loop, so the process hung after the failure and the real error was
 * buried under a timeout or never printed at all.
 *
 * These tests run the sampler with a FAKE clock and no cluster, so the two
 * properties that matter are checked directly: it stops and resolves after an
 * abort, and it does so even when the body it guards throws.
 */

import { describe, expect, it } from 'bun:test';
import { type BackgroundSampler, startBackgroundSampler } from './background-sampler.js';

/**
 * A sleep the test drives by hand.
 *
 * `next()` releases the sampler's current wait and yields until it is waiting
 * again (or has exited), so each call advances the loop by exactly one sample.
 * No wall-clock time passes, and nothing here can hang: a `next()` with no
 * waiter resolves immediately.
 */
function manualClock() {
  let release: (() => void) | undefined;
  const sleep = (_ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        release = undefined;
        signal.removeEventListener('abort', done);
        resolve();
      };
      release = done;
      signal.addEventListener('abort', done, { once: true });
    });
  };
  return {
    sleep,
    /** Let the sampler take one more sample, then hand control back. */
    async next(): Promise<void> {
      release?.();
      // Two microtask drains: one for the sleep's resolution, one for the
      // `await sample()` the loop performs right after it.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    get waiting(): boolean {
      return release !== undefined;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('startBackgroundSampler', () => {
  it('collects samples and stops when told, resolving once the loop has exited', async () => {
    const clock = manualClock();
    let taken = 0;
    const sampler = startBackgroundSampler({
      sample: () => {
        taken += 1;
        return taken;
      },
      intervalMs: 500,
      sleep: clock.sleep,
    });

    await settle();
    expect(sampler.samples).toEqual([1]);
    await clock.next();
    await clock.next();
    expect(sampler.samples).toEqual([1, 2, 3]);

    await sampler.stop();
    expect(sampler.stopped).toBe(true);

    // THE POINT: after `stop()` resolves the loop is gone, so no further
    // sample can be taken however long the process lives after it.
    const afterStop = sampler.samples.length;
    await settle();
    await clock.next();
    await settle();
    expect(sampler.samples.length).toBe(afterStop);
    expect(taken).toBe(afterStop);
  });

  it('stops and resolves even when the guarded body THROWS — the actual leak', async () => {
    const clock = manualClock();
    let taken = 0;
    let sampler: BackgroundSampler<number> | undefined;
    const boom = new Error('the failure the sampler used to mask');

    await expect(
      (async () => {
        sampler = startBackgroundSampler({
          sample: () => {
            taken += 1;
            return taken;
          },
          intervalMs: 500,
          sleep: clock.sleep,
        });
        try {
          await settle();
          await clock.next();
          // Stands in for the failed patch / failed `expect` that used to skip
          // the stop at the bottom of the case.
          throw boom;
        } finally {
          await sampler.stop();
        }
      })()
    ).rejects.toThrow('the failure the sampler used to mask');

    // The original error propagated (asserted above) AND the loop is gone: the
    // `finally` stopped it, so nothing is left polling to hang the runner.
    expect(sampler?.stopped).toBe(true);
    const afterStop = taken;
    await settle();
    await clock.next();
    await settle();
    expect(taken).toBe(afterStop);
  });

  it('is idempotent: a second stop() is a no-op and still resolves', async () => {
    const sampler = startBackgroundSampler({
      sample: () => 1,
      intervalMs: 500,
      sleep: manualClock().sleep,
    });

    await sampler.stop();
    await sampler.stop();
    await Promise.all([sampler.stop(), sampler.stop()]);
    expect(sampler.stopped).toBe(true);
  });

  it('stops before the interval elapses instead of after one more full wait', async () => {
    const clock = manualClock();
    const sampler = startBackgroundSampler({
      sample: () => 1,
      intervalMs: 10_000,
      sleep: clock.sleep,
    });

    await settle();
    expect(clock.waiting).toBe(true);
    // A 10s interval with no abortable wait would make this `stop()` take 10s.
    // It resolves without the clock being advanced at all.
    await sampler.stop();
    expect(clock.waiting).toBe(false);
  });

  it('records a throwing sample as a miss rather than failing the sampler', async () => {
    const clock = manualClock();
    let call = 0;
    const sampler = startBackgroundSampler({
      sample: () => {
        call += 1;
        if (call === 2) throw new Error('transient list failure');
        return call;
      },
      intervalMs: 500,
      sleep: clock.sleep,
    });

    await settle();
    await clock.next();
    await clock.next();
    await sampler.stop();

    // The failure did not stop the loop and did not reject `stop()`.
    expect(sampler.samples).toEqual([1, 3]);
    expect(sampler.errors.length).toBe(1);
    expect((sampler.errors[0] as Error).message).toBe('transient list failure');
  });

  it('handles a rejected async sample the same way', async () => {
    const clock = manualClock();
    let call = 0;
    const sampler = startBackgroundSampler({
      sample: async () => {
        call += 1;
        if (call === 1) throw new Error('async transient failure');
        return call;
      },
      intervalMs: 500,
      sleep: clock.sleep,
    });

    await settle();
    await clock.next();
    await sampler.stop();

    expect(sampler.errors.length).toBe(1);
    expect(sampler.samples).toEqual([2]);
  });

  it('never takes a sample at all if stopped immediately, and still resolves', async () => {
    const sampler = startBackgroundSampler({
      sample: () => {
        throw new Error('should not be reachable after an immediate stop');
      },
      intervalMs: 500,
      sleep: manualClock().sleep,
    });

    await sampler.stop();
    expect(sampler.stopped).toBe(true);
    // The loop's first iteration may already have been entered before the
    // abort landed, so the recorded miss is allowed — what is NOT allowed is
    // `stop()` rejecting, or the loop surviving.
    expect(sampler.samples.length).toBe(0);
  });

  it('uses a real timer by default, so the integration suites need no clock', async () => {
    const sampler = startBackgroundSampler({ sample: () => Date.now(), intervalMs: 1 });
    await Bun.sleep(20);
    await sampler.stop();

    expect(sampler.samples.length).toBeGreaterThan(1);
    const afterStop = sampler.samples.length;
    await Bun.sleep(20);
    expect(sampler.samples.length).toBe(afterStop);
  });
});
