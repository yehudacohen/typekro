/**
 * Unit tests for the readiness-poll per-call timeout (poll-timeout.ts).
 *
 * Regression guard for the silent multi-hour hang: a readiness poll's `await k8sApi.read(...)` that never
 * settles (wedged/expired kubeconfig exec credential) must be bounded so the poll's deadline is honored.
 */
import { describe, expect, it } from 'bun:test';
import { callWithTimeout, perCallTimeout } from '../../src/core/deployment/poll-timeout.js';

describe('callWithTimeout', () => {
  it('resolves with the op result when it settles before the timeout', async () => {
    const result = await callWithTimeout(() => Promise.resolve('ok'), 1_000, 'fast op');
    expect(result).toBe('ok');
  });

  it('rejects with a credential-hint error when the op never settles (the hang case)', async () => {
    // A promise that NEVER resolves or rejects — models a wedged exec-credential k8s call.
    const neverSettles = () => new Promise<string>(() => {});
    await expect(callWithTimeout(neverSettles, 20, 'read Foo/bar')).rejects.toThrow(
      /read Foo\/bar exceeded its 20ms request timeout/
    );
    await expect(callWithTimeout(neverSettles, 20, 'read Foo/bar')).rejects.toThrow(
      /exec credential/
    );
  });

  it('propagates the op’s own rejection (not the timeout) when it fails fast', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    await expect(callWithTimeout(boom, 1_000, 'op')).rejects.toThrow('boom');
  });

  it('clears its timer so a resolved call does not keep the event loop alive', async () => {
    // If the timer weren't cleared, an unref'd handle could fire later; resolving fast must not throw.
    await expect(callWithTimeout(() => Promise.resolve(1), 50, 'op')).resolves.toBe(1);
    await new Promise((r) => setTimeout(r, 60));
  });
});

describe('perCallTimeout', () => {
  it('uses the cap when the remaining budget is larger', () => {
    expect(perCallTimeout(600_000, 30_000)).toBe(30_000);
  });

  it('shrinks to the remaining budget so one call cannot overshoot the poll deadline', () => {
    expect(perCallTimeout(5_000, 30_000)).toBe(5_000);
  });

  it('never drops below the 1s floor even when the deadline is nearly elapsed', () => {
    expect(perCallTimeout(10, 30_000)).toBe(1_000);
    expect(perCallTimeout(-500, 30_000)).toBe(1_000);
  });
});
