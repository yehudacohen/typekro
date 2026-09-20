/**
 * Unit tests for the readiness-poll per-call timeout (poll-timeout.ts).
 *
 * Regression guard for the silent multi-hour hang: a readiness poll's `await k8sApi.read(...)` that never
 * settles (wedged/expired kubeconfig exec credential) must be bounded so the poll's deadline is honored.
 */
import { describe, expect, it } from 'bun:test';
import { PrematureCloseError } from '../../src/core/kubernetes/bun-http-library.js';
import {
  callDeadlineBudget,
  callDeadlineVerb,
  callWithTimeout,
  isRequestTimeoutError,
  PollTimeoutError,
  perCallTimeout,
  RequestTimeoutError,
  retryOnceOnRequestTimeout,
  usesExecCredential,
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

  const budget = { read: 20, create: 45, update: 60, delete: 100 };

  it('derives a per-verb budget and caps every verb by the deployment timeout', () => {
    expect(callDeadlineBudget(undefined)).toEqual({
      read: 30_000,
      create: 120_000,
      update: 120_000,
      delete: 180_000,
    });
    expect(callDeadlineBudget({ default: 5_000, create: 7_000, delete: 9_000 })).toEqual({
      read: 5_000,
      create: 7_000,
      update: 120_000,
      delete: 9_000,
    });
    // The cap applies to every verb, not just reads.
    expect(callDeadlineBudget({ delete: 180_000 }, 1_000)).toEqual({
      read: 1_000,
      create: 1_000,
      update: 1_000,
      delete: 1_000,
    });
  });

  it('keeps `create` and `update` apart instead of collapsing them into one write budget', () => {
    // `HttpTimeoutConfig` exposes create and update separately. A single `write` budget derived from
    // `create ?? update` gave every POST/PUT/PATCH the create value and made a configured `update`
    // unreachable whenever `create` was also set.
    expect(callDeadlineBudget({ create: 70_000, update: 20_000 })).toEqual({
      read: 30_000,
      create: 70_000,
      update: 20_000,
      delete: 180_000,
    });
    // Neither verb falls back to the other: an unset verb takes the shared write DEFAULT, never the
    // sibling's configured value.
    expect(callDeadlineBudget({ update: 8_000 })).toEqual({
      read: 30_000,
      create: 120_000,
      update: 8_000,
      delete: 180_000,
    });
    expect(callDeadlineBudget({ create: 8_000 }).update).toBe(120_000);
  });

  it('treats a zero or negative timeout as unset instead of collapsing the budget', () => {
    // `0` is not nullish: a naive `?? DEFAULT` would leave every call with a ~0ms budget.
    expect(callDeadlineBudget({ default: 0 }, 0)).toEqual({
      read: 30_000,
      create: 120_000,
      update: 120_000,
      delete: 180_000,
    });
    expect(callDeadlineBudget({ default: -1, create: Number.NaN }).read).toBe(30_000);
    // A non-positive `update` must fall back to the write DEFAULT, not to a configured `create`.
    expect(callDeadlineBudget({ create: 9_000, update: 0 }).update).toBe(120_000);
  });

  it('classifies methods by verb so writes and deletes are not cut short by the read budget', () => {
    expect(callDeadlineVerb('read')).toBe('read');
    expect(callDeadlineVerb('list')).toBe('read');
    expect(callDeadlineVerb('listClusterCustomObject')).toBe('read');
    expect(callDeadlineVerb('getNamespacedCustomObject')).toBe('read');
    expect(callDeadlineVerb('delete')).toBe('delete');
    expect(callDeadlineVerb('deleteCollectionNamespacedCustomObject')).toBe('delete');
  });

  it('separates create-shaped from update-shaped method names', () => {
    expect(callDeadlineVerb('create')).toBe('create');
    expect(callDeadlineVerb('createNamespacedCustomObject')).toBe('create');
    expect(callDeadlineVerb('patch')).toBe('update');
    expect(callDeadlineVerb('patchNamespacedCustomObject')).toBe('update');
    expect(callDeadlineVerb('replace')).toBe('update');
    expect(callDeadlineVerb('replaceNamespacedCustomObjectStatus')).toBe('update');
    expect(callDeadlineVerb('patchServerSideApply')).toBe('update');
    expect(callDeadlineVerb('serverSideApply')).toBe('update');
    // Deletes still win over both, and unknown methods still take the short read budget.
    expect(callDeadlineVerb('deleteCollection')).toBe('delete');
    expect(callDeadlineVerb('someFutureClientMethod')).toBe('read');
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

  it('bounds a create with the create budget and an update with the update budget', async () => {
    const wedged = {
      create: () => new Promise(() => undefined),
      patch: () => new Promise(() => undefined),
    };
    const api = withCallDeadline(wedged, { budget, label: 'Widget demo' });

    await expect(settlesWithin(api.create(), 1_000)).rejects.toThrow(
      /Widget demo create exceeded its 45ms request timeout/
    );
    await expect(settlesWithin(api.patch(), 1_000)).rejects.toThrow(
      /Widget demo patch exceeded its 60ms request timeout/
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

  it('does not START a call when the signal is already aborted', async () => {
    // Racing an already-aborted signal still LAUNCHES the request: the caller's promise rejects, but
    // the write has already left for the API server. In a replacement sequence (delete → wait for
    // the 404 → create) an abort landing in that window would cancel the deployment and create the
    // object anyway. The call must never be made at all.
    const controller = new AbortController();
    controller.abort(new Error('converge cancelled'));
    let creates = 0;
    const api = withCallDeadline(
      {
        create: () => {
          creates += 1;
          return Promise.resolve({ ok: true });
        },
      },
      { budget, label: 'Widget demo', abortSignal: controller.signal }
    );

    expect(() => api.create()).toThrow('converge cancelled');
    expect(creates).toBe(0);
  });

  it('still honors the abort signal when the budget is unusable', async () => {
    // A misconfigured budget must not silently drop the abort plumbing — that is its own hang.
    const controller = new AbortController();
    const api = withCallDeadline(
      { read: () => new Promise(() => undefined) },
      {
        budget: { read: 0, create: 0, update: 0, delete: 0 },
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

describe('retryOnceOnRequestTimeout', () => {
  /** A logger that records its warn lines and nothing else. */
  function recordingLogger() {
    const warnings: Array<{ msg: string; meta: unknown }> = [];
    return {
      warnings,
      logger: {
        warn: (msg: string, meta?: unknown) => {
          warnings.push({ msg, meta });
        },
      },
    };
  }

  it('returns the value of a GET that times out once and then succeeds, logging one warn', async () => {
    // The failure pattern from #213: the FIRST request a fresh client makes never completes
    // against a healthy API server; the same GET answers in well under a second when re-issued.
    const { logger, warnings } = recordingLogger();
    let attempts = 0;
    const read = async () => {
      attempts += 1;
      if (attempts === 1)
        throw new PollTimeoutError('Widget demo (alchemy-drift-check) read', 30_000);
      return { metadata: { uid: 'uid-1' } };
    };

    await expect(
      retryOnceOnRequestTimeout(read, { label: 'Widget demo/widgets ns/demo', logger })
    ).resolves.toEqual({ metadata: { uid: 'uid-1' } });
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/Widget demo\/widgets ns\/demo/);
    expect(warnings[0]?.msg).toMatch(/did not return within its 30000ms budget/);
    expect(warnings[0]?.msg).toMatch(/re-issuing the read once/);
    expect(warnings[0]?.meta).toMatchObject({ timeoutMs: 30_000 });
  });

  it('describes a premature close by how long the connection lasted, not as an expired budget', async () => {
    // `PrematureCloseError.timeoutMs` is the ELAPSED time before the socket died, with budget to
    // spare; the warn line must not present those milliseconds as a budget the read exceeded.
    const { logger, warnings } = recordingLogger();
    let attempts = 0;
    const read = async () => {
      attempts += 1;
      if (attempts === 1)
        throw new PrematureCloseError('GET', '/api/v1/widgets/demo', 412, 'while reading the body');
      return 'ok';
    };

    await expect(
      retryOnceOnRequestTimeout(read, { label: 'Widget demo/widgets ns/demo', logger })
    ).resolves.toBe('ok');
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toMatch(/connection closed after 412ms without a complete response/);
    expect(warnings[0]?.msg).toMatch(/re-issuing the read once/);
    expect(warnings[0]?.msg).not.toMatch(/budget/);
    expect(warnings[0]?.meta).toMatchObject({ elapsedMs: 412 });
    expect(warnings[0]?.meta).not.toHaveProperty('timeoutMs');
  });

  it("also rides out the socket-layer timeout, not only the deadline wrapper's", async () => {
    // Both timing layers raise `isRequestTimeoutError`; the caller must not care which one won.
    const { logger } = recordingLogger();
    let attempts = 0;
    const read = async () => {
      attempts += 1;
      if (attempts === 1) throw new RequestTimeoutError('HTTP request timeout: GET /api', 30_000);
      return 'ok';
    };
    await expect(retryOnceOnRequestTimeout(read, { label: 'read', logger })).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('surfaces the request timeout when the retry times out too, after exactly two attempts', async () => {
    const { logger, warnings } = recordingLogger();
    let attempts = 0;
    const read = async (): Promise<never> => {
      attempts += 1;
      throw new PollTimeoutError(`Widget demo read (attempt ${attempts})`, 30_000);
    };

    const error = await retryOnceOnRequestTimeout(read, { label: 'Widget demo', logger }).catch(
      (e: unknown) => e
    );
    expect(isRequestTimeoutError(error)).toBe(true);
    expect(error).toBeInstanceOf(PollTimeoutError);
    // Bounded: two read budgets, never a third attempt.
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    // The error is the RETRY's, and it says so, so nobody reads it as "try again".
    expect((error as Error).message).toMatch(/attempt 2/);
    expect((error as Error).message).toMatch(/already re-issued once/);
  });

  it('does not retry an error the server actually answered with', async () => {
    const { logger, warnings } = recordingLogger();
    let attempts = 0;
    const read = async (): Promise<never> => {
      attempts += 1;
      throw Object.assign(new Error('not found'), { statusCode: 404 });
    };
    await expect(retryOnceOnRequestTimeout(read, { label: 'read', logger })).rejects.toThrow(
      'not found'
    );
    expect(attempts).toBe(1);
    expect(warnings).toHaveLength(0);
  });

  it('throws the abort instead of issuing a second attempt when the signal tripped meanwhile', async () => {
    // An abort that lands while the first attempt is in flight is the caller's decision. The retry
    // must not put one more request on the wire, and the caller must see the abort, not a timeout.
    const { logger, warnings } = recordingLogger();
    const controller = new AbortController();
    const reason = new Error('converge cancelled');
    let attempts = 0;
    const read = async (): Promise<never> => {
      attempts += 1;
      controller.abort(reason);
      throw new PollTimeoutError('Widget demo read', 30_000);
    };

    await expect(
      retryOnceOnRequestTimeout(read, { label: 'read', logger, abortSignal: controller.signal })
    ).rejects.toBe(reason);
    expect(attempts).toBe(1);
    expect(warnings).toHaveLength(0);
  });

  it('is applied to reads only: a bounded create that times out is attempted exactly once', async () => {
    // Nothing wraps writes in the retry: a POST that timed out may have been applied by a server
    // that simply had not answered yet, so the deadline wrapper alone bounds it and it fails once.
    let creates = 0;
    const api = withCallDeadline(
      {
        create: () => {
          creates += 1;
          return new Promise(() => undefined);
        },
      },
      { budget: { read: 20, create: 20, update: 20, delete: 20 }, label: 'Widget demo' }
    );
    await expect(api.create()).rejects.toBeInstanceOf(PollTimeoutError);
    expect(creates).toBe(1);
  });
});

describe('request-timeout hint', () => {
  it('names the exec credential only when the kubeconfig user actually has an exec block', () => {
    const withExec = new PollTimeoutError('Widget demo read', 30_000, { usesExecCredential: true });
    expect(withExec.message).toMatch(
      /usual cause is a wedged or expired kubeconfig exec credential/
    );

    // A pre-minted token or client certificate cannot suffer a wedged exec plugin: say what
    // happened (the request did not return) instead of sending the operator after credentials.
    const withoutExec = new PollTimeoutError('Widget demo read', 30_000, {
      usesExecCredential: false,
    });
    expect(withoutExec.message).toMatch(/the Kubernetes API call did not return/);
    expect(withoutExec.message).toMatch(/does not use an exec credential plugin/);
    expect(withoutExec.message).not.toMatch(/usual cause is a wedged/);
    expect(withoutExec.message).toMatch(/connection stalled/);

    // The credential shape is unknown at this layer: hedge, do not assert either way.
    const unknown = new PollTimeoutError('Widget demo read', 30_000);
    expect(unknown.message).toMatch(/If the kubeconfig authenticates through an exec credential/);
    expect(unknown.message).not.toMatch(/usual cause is a wedged/);
  });

  it('reads the exec block off the kubeconfig current user', () => {
    expect(usesExecCredential({ getCurrentUser: () => ({ exec: { command: 'aws' } }) })).toBe(true);
    expect(usesExecCredential({ getCurrentUser: () => ({ token: 'pre-minted' }) })).toBe(false);
    expect(usesExecCredential({ getCurrentUser: () => null })).toBeUndefined();
    expect(usesExecCredential(undefined)).toBeUndefined();
    expect(usesExecCredential({})).toBeUndefined();
  });

  it('threads the kubeconfig shape through withCallDeadline into the timeout it raises', async () => {
    const budget = { read: 20, create: 20, update: 20, delete: 20 };
    const wedged = { read: () => new Promise(() => undefined) };

    const tokenUser = withCallDeadline(wedged, {
      budget,
      label: 'Widget demo',
      usesExecCredential: false,
    });
    const tokenError = (await tokenUser.read().catch((e: unknown) => e)) as Error;
    expect(tokenError.message).toMatch(/does not use an exec credential plugin/);
    expect(tokenError.message).not.toMatch(/usual cause is a wedged/);

    const execUser = withCallDeadline(wedged, {
      budget,
      label: 'Widget demo',
      usesExecCredential: true,
    });
    const execError = (await execUser.read().catch((e: unknown) => e)) as Error;
    expect(execError.message).toMatch(
      /usual cause is a wedged or expired kubeconfig exec credential/
    );
  });
});
