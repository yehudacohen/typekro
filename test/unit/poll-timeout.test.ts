/**
 * Unit tests for the readiness-poll per-call timeout (poll-timeout.ts).
 *
 * Regression guard for the silent multi-hour hang: a readiness poll's `await k8sApi.read(...)` that never
 * settles (wedged/expired kubeconfig exec credential) must be bounded so the poll's deadline is honored.
 */
import { describe, expect, it } from 'bun:test';
import { callWithTimeout, PollTimeoutError, perCallTimeout } from '../../src/core/deployment/poll-timeout.js';

describe('callWithTimeout', () => {
  it('resolves with the op result when it settles before the timeout', async () => {
    const result = await callWithTimeout(() => Promise.resolve('ok'), 1_000, 'fast op');
    expect(result).toBe('ok');
  });

  it('rejects with a PollTimeoutError (credential hint) when the op never settles (the hang case)', async () => {
    // A promise that NEVER resolves or rejects — models a wedged exec-credential k8s call.
    const neverSettles = () => new Promise<string>(() => {});
    const err = await callWithTimeout(neverSettles, 20, 'read Foo/bar').catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as Error).message).toMatch(/read Foo\/bar exceeded its 20ms request timeout/);
    expect((err as Error).message).toMatch(/exec credential/);
  });

  it('fails fast without starting the op when there is no budget left', async () => {
    let started = false;
    const err = await callWithTimeout(
      () => {
        started = true;
        return Promise.resolve('nope');
      },
      0,
      'read Foo/bar'
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(started).toBe(false);
  });

  it('propagates the op own rejection (not the timeout) when it fails fast', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    await expect(callWithTimeout(boom, 1_000, 'op')).rejects.toThrow('boom');
  });

  it('clears its timer so a resolved call does not keep the event loop alive', async () => {
    await expect(callWithTimeout(() => Promise.resolve(1), 50, 'op')).resolves.toBe(1);
    await new Promise((r) => setTimeout(r, 60));
  });
});

describe('perCallTimeout', () => {
  it('uses the cap when the remaining budget is larger', () => {
    expect(perCallTimeout(600_000, 30_000)).toBe(30_000);
  });

  it('shrinks STRICTLY to the remaining budget so one call cannot overshoot the poll deadline', () => {
    expect(perCallTimeout(5_000, 30_000)).toBe(5_000);
    // Below one second it must NOT be floored up to 1s (that would exceed the remaining deadline).
    expect(perCallTimeout(200, 30_000)).toBe(200);
  });

  it('returns a non-positive value once the deadline is spent (then callWithTimeout fails fast)', () => {
    expect(perCallTimeout(0, 30_000)).toBe(0);
    expect(perCallTimeout(-500, 30_000)).toBe(-500);
  });
});
