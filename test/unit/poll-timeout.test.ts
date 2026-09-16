/**
 * Unit tests for the readiness-poll per-call timeout (poll-timeout.ts).
 *
 * Regression guard for the silent multi-hour hang: a readiness poll's `await k8sApi.read(...)` that never
 * settles (wedged/expired kubeconfig exec credential) must be bounded so the poll's deadline is honored.
 */
import { describe, expect, it } from 'bun:test';
import {
  callDeadlineBudget,
  callDeadlineVerb,
  callWithTimeout,
  isRequestTimeoutError,
  PollTimeoutError,
  perCallTimeout,
  RequestTimeoutError,
  withCallDeadline,
} from '../../src/core/deployment/poll-timeout.js';

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

  it('propagates the op own rejection (not the timeout) when it fails fast', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    await expect(callWithTimeout(boom, 1_000, 'op')).rejects.toThrow('boom');
  });

  it('interrupts a wedged call with the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stop polling', 'AbortError');
    const result = callWithTimeout(
      () => new Promise<string>(() => {}),
      10_000,
      'wedged read',
      controller.signal
    ).catch((error: unknown) => error);

    controller.abort(reason);

    expect(await result).toBe(reason);
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

  it('returns a non-positive value once the deadline is spent (callers must break to their overall timeout)', () => {
    expect(perCallTimeout(0, 30_000)).toBe(0);
    expect(perCallTimeout(-500, 30_000)).toBe(-500);
  });
});

describe('withCallDeadline', () => {
  /** Hard watchdog: a lost bound must turn a test RED, never leave it hanging. */
  async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`call did not settle within ${ms}ms — it is UNBOUNDED`)),
            ms
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const budget = { read: 20, write: 60, delete: 100 };

  it('derives a per-verb budget and caps every verb by the deployment timeout', () => {
    expect(callDeadlineBudget(undefined)).toEqual({
      read: 30_000,
      write: 120_000,
      delete: 180_000,
    });
    expect(callDeadlineBudget({ default: 5_000, create: 7_000, delete: 9_000 })).toEqual({
      read: 5_000,
      write: 7_000,
      delete: 9_000,
    });
    // `update` stands in for `create` when only it is configured.
    expect(callDeadlineBudget({ update: 8_000 }).write).toBe(8_000);
    // The cap applies to every verb, not just reads.
    expect(callDeadlineBudget({ delete: 180_000 }, 1_000)).toEqual({
      read: 1_000,
      write: 1_000,
      delete: 1_000,
    });
  });

  it('treats a zero or negative timeout as unset instead of collapsing the budget', () => {
    // `0` is not nullish: a naive `?? DEFAULT` would leave every call with a ~0ms budget.
    expect(callDeadlineBudget({ default: 0 }, 0)).toEqual({
      read: 30_000,
      write: 120_000,
      delete: 180_000,
    });
    expect(callDeadlineBudget({ default: -1, create: Number.NaN }).read).toBe(30_000);
  });

  it('classifies methods by verb so writes and deletes are not cut short by the read budget', () => {
    expect(callDeadlineVerb('read')).toBe('read');
    expect(callDeadlineVerb('list')).toBe('read');
    expect(callDeadlineVerb('listClusterCustomObject')).toBe('read');
    expect(callDeadlineVerb('getNamespacedCustomObject')).toBe('read');
    expect(callDeadlineVerb('create')).toBe('write');
    expect(callDeadlineVerb('replace')).toBe('write');
    expect(callDeadlineVerb('patchNamespacedCustomObject')).toBe('write');
    expect(callDeadlineVerb('delete')).toBe('delete');
    expect(callDeadlineVerb('deleteCollectionNamespacedCustomObject')).toBe('delete');
  });

  it('bounds a wedged call with its own verb budget', async () => {
    const wedged = {
      read: () => new Promise(() => undefined),
      replace: () => new Promise(() => undefined),
    };
    const api = withCallDeadline(wedged, { budget, label: 'Widget demo' });

    await expect(settlesWithin(api.read(), 1_000)).rejects.toThrow(
      /Widget demo read exceeded its 20ms request timeout/
    );
    await expect(settlesWithin(api.replace(), 1_000)).rejects.toThrow(
      /Widget demo replace exceeded its 60ms request timeout/
    );
  });

  it('bounds a method the allow-list never knew about', async () => {
    // A client method this module has not heard of must not escape the bound.
    const wedged = { someFutureClientMethod: () => new Promise(() => undefined) };
    const api = withCallDeadline(wedged, { budget, label: 'Widget demo' });
    await expect(settlesWithin(api.someFutureClientMethod(), 1_000)).rejects.toThrow(
      /Widget demo someFutureClientMethod exceeded its 20ms request timeout/
    );
  });

  it('passes through synchronous members and resolves healthy calls unchanged', async () => {
    const api = withCallDeadline(
      {
        version: 'v1',
        describe: () => 'sync helper',
        read: async () => ({ ok: true }),
      },
      { budget, label: 'Widget demo' }
    );
    expect(api.version).toBe('v1');
    expect(api.describe()).toBe('sync helper');
    await expect(api.read()).resolves.toEqual({ ok: true });
  });

  it('still honors the abort signal when the budget is unusable', async () => {
    // A misconfigured budget must not silently drop the abort plumbing — that is its own hang.
    const controller = new AbortController();
    const api = withCallDeadline(
      { read: () => new Promise(() => undefined) },
      {
        budget: { read: 0, write: 0, delete: 0 },
        label: 'Widget demo',
        abortSignal: controller.signal,
      }
    );
    const pending = settlesWithin(api.read(), 1_000);
    controller.abort(new Error('converge cancelled'));
    await expect(pending).rejects.toThrow('converge cancelled');
  });
});

describe('request-timeout recognition across timing layers', () => {
  it('recognises both the socket timeout and a deadline-wrapper timeout', () => {
    // The Bun HTTP library's timer is armed synchronously while the request is issued, so with
    // equal budgets it fires BEFORE any wrapper around the call. A caller must not have to know
    // which layer won: both raise the same recognisable type.
    expect(isRequestTimeoutError(new PollTimeoutError('Widget demo read', 30_000))).toBe(true);
    expect(
      isRequestTimeoutError(new RequestTimeoutError('HTTP request timeout: GET /api', 30_000))
    ).toBe(true);
    // A structural marker, so recognition survives duplicate module instances.
    expect(isRequestTimeoutError({ isRequestTimeout: true })).toBe(true);
    // ...and nothing else is mistaken for a timeout.
    expect(isRequestTimeoutError(new Error('connection refused'))).toBe(false);
    expect(isRequestTimeoutError(Object.assign(new Error('gone'), { statusCode: 404 }))).toBe(
      false
    );
    expect(isRequestTimeoutError(undefined)).toBe(false);
  });

  it('carries the budget that elapsed', () => {
    expect(new PollTimeoutError('Widget demo read', 1_234).timeoutMs).toBe(1_234);
    expect(new RequestTimeoutError('HTTP request timeout', 5_678).timeoutMs).toBe(5_678);
  });
});
