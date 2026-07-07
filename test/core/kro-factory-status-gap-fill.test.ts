/**
 * Regression test for `fillStatusGapsFromLiveReExecution`
 * (`src/core/deployment/kro-factory.ts`).
 *
 * THE BUG (live-verified against a real cluster while deploying a
 * clickstack-style composition): a KRO-mode status field can be a MIXED
 * object with both a dynamic leaf (owned by the live KRO instance, e.g.
 * `app.host` built from CEL over an owned HelmRelease) and a static leaf
 * (a build-time constant never sent to KRO at all, e.g. `app.appPort`).
 * The post-deploy live-re-execution merge treated the field's TOP-LEVEL
 * key as "belongs to KRO, don't touch" whenever ANY part of it was
 * dynamic, discarding the static sibling entirely — `instance.status.app`
 * came back as `{ host: "..." }` with `appPort`/`apiPort` silently
 * missing (`undefined`), even though the live re-execution had correctly
 * computed the full object.
 *
 * THE FIX recurses into plain objects instead of only checking the
 * top-level key, filling in a gap (`undefined`/`null`/`''`) at any depth
 * from the live re-execution value while still preferring the
 * already-merged (static+KRO) value for every leaf that already has one —
 * dynamic leaves must never be overwritten by a client-side re-execution.
 */

import { describe, expect, it } from 'bun:test';
import { fillStatusGapsFromLiveReExecution } from '../../src/core/deployment/kro-factory.js';

describe('fillStatusGapsFromLiveReExecution', () => {
  it('fills a static leaf missing from a mixed static+dynamic nested object, without touching the dynamic leaf', () => {
    // `current` mirrors what the buggy code produced: the dynamic leaf
    // hydrated from KRO, the static sibling never populated.
    const current = { app: { host: 'clickstack-e2e.stack.svc.cluster.local' } };
    // `live` mirrors what live re-execution actually computed: the full object.
    const live = {
      app: {
        host: 'STALE-should-not-be-used',
        appPort: 3000,
        apiPort: 8000,
      },
    };

    const merged = fillStatusGapsFromLiveReExecution(current, live) as Record<string, unknown>;
    const app = merged.app as Record<string, unknown>;

    // Dynamic leaf: the already-merged (KRO-owned) value wins — never
    // overwritten by the client-side re-execution's value.
    expect(app.host).toBe('clickstack-e2e.stack.svc.cluster.local');
    // Static leaves: filled in from live re-execution — the actual bug.
    expect(app.appPort).toBe(3000);
    expect(app.apiPort).toBe(8000);
  });

  it('leaves a fully-dynamic primitive leaf untouched even if live re-execution recomputed it', () => {
    const current = { ready: true };
    const live = { ready: false };
    const merged = fillStatusGapsFromLiveReExecution(current, live) as Record<string, unknown>;
    expect(merged.ready).toBe(true);
  });

  it('fills a completely missing top-level key from live re-execution', () => {
    const current = {};
    const live = { version: '3.0.1' };
    const merged = fillStatusGapsFromLiveReExecution(current, live) as Record<string, unknown>;
    expect(merged.version).toBe('3.0.1');
  });

  it('treats null/undefined/empty-string leaves as gaps at any nesting depth', () => {
    const current = { a: { b: null, c: undefined, d: '', e: 'kept' } };
    const live = { a: { b: 'filled-b', c: 'filled-c', d: 'filled-d', e: 'ignored' } };
    const merged = fillStatusGapsFromLiveReExecution(current, live) as Record<string, unknown>;
    const a = merged.a as Record<string, unknown>;
    expect(a.b).toBe('filled-b');
    expect(a.c).toBe('filled-c');
    expect(a.d).toBe('filled-d');
    expect(a.e).toBe('kept');
  });

  it('does not recurse into arrays — treats a present array as already resolved', () => {
    const current = { list: [1, 2] };
    const live = { list: [9, 9, 9] };
    const merged = fillStatusGapsFromLiveReExecution(current, live) as Record<string, unknown>;
    expect(merged.list).toEqual([1, 2]);
  });

  it('ignores __proto__/constructor/prototype keys during the recursive merge (prototype-pollution hardening)', () => {
    const current = { app: {} };
    // `live` mirrors what re-executing the composition against attacker-influenced
    // live cluster status could produce if a resource's status field happened to
    // contain one of these key names.
    const live = JSON.parse(
      '{"app": {"__proto__": {"polluted": true}, "constructor": {"polluted": true}, "prototype": {"polluted": true}, "safe": "ok"}}'
    );

    const merged = fillStatusGapsFromLiveReExecution(current, live) as Record<string, unknown>;
    const app = merged.app as Record<string, unknown>;

    expect(app.safe).toBe('ok');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(app.constructor).toBe(Object);
    expect(Object.hasOwn(app, '__proto__')).toBe(false);
  });
});
