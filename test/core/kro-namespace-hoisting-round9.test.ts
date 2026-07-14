import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import {
  computeApplySetId,
  namespaceOwnershipMatchesInstance,
  planInstanceMigrationAction,
} from '../../src/core/deployment/kro-factory.js';
import { Cel } from '../../src/core/references/cel.js';
import { toResourceGraph } from '../../src/core/serialization/core.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * Round-9 rework coverage for PR #113 — the two release blockers (#1 race-safe
 * ownership strip, #2 graph-path status rewriting + dangling-ref assertion) plus
 * findings #3 (don't resume operator-suspended instances) and #4 (contradictory
 * ownership labels must NOT pass the fail-closed check).
 */

const schema = {
  name: 'round9',
  kind: 'Round9',
  spec: type({ name: 'string', namespace: 'string' }),
  status: type({ ready: 'boolean', 'namespaceName?': 'string' }),
};

function priv(target: unknown, method: string): (...args: unknown[]) => unknown {
  const fn = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`missing private method ${method}`);
  return fn.bind(target);
}

const ownsNs = () =>
  kubernetesComposition(schema, (spec) => {
    namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
    return { ready: true };
  });

const PART_OF = 'applyset.kubernetes.io/part-of';
const INSTANCE_ID = 'kro.run/instance-id';

// -----------------------------------------------------------------------------
// Finding #4 — contradictory ownership labels must NOT pass the fail-closed check.
// -----------------------------------------------------------------------------
describe('finding #4: every PRESENT ownership identity must AGREE (no OR-match hole)', () => {
  const applySetId = computeApplySetId('analytics', 'dev', 'Round9', 'test.typekro.dev');
  const uid = 'instance-uid-123';

  it('matches when the ONLY present identity matches (part-of, or instance-id)', () => {
    expect(namespaceOwnershipMatchesInstance({ [PART_OF]: applySetId }, applySetId, uid)).toBe(true);
    expect(namespaceOwnershipMatchesInstance({ [INSTANCE_ID]: uid }, applySetId, uid)).toBe(true);
    // Both present AND both agree.
    expect(
      namespaceOwnershipMatchesInstance(
        { [PART_OF]: applySetId, [INSTANCE_ID]: uid },
        applySetId,
        uid
      )
    ).toBe(true);
  });

  it('MIXED SIGNAL: foreign part-of + our UID → NOT a match (conflict)', () => {
    // The exact hole: an OR-match wrongly deemed this transferable because the UID
    // matched, even though part-of belongs to ANOTHER ApplySet that would prune it.
    expect(
      namespaceOwnershipMatchesInstance(
        { [PART_OF]: 'applyset-someone-else-v1', [INSTANCE_ID]: uid },
        applySetId,
        uid
      )
    ).toBe(false);
  });

  it('MIXED SIGNAL: our part-of + foreign UID → NOT a match (conflict)', () => {
    expect(
      namespaceOwnershipMatchesInstance(
        { [PART_OF]: applySetId, [INSTANCE_ID]: 'other-uid' },
        applySetId,
        uid
      )
    ).toBe(false);
  });

  it('a present instance-id we cannot verify (unknown UID) is treated as a disagreement', () => {
    expect(namespaceOwnershipMatchesInstance({ [INSTANCE_ID]: uid }, applySetId, undefined)).toBe(
      false
    );
    // part-of still matches even with an unknown UID, but a PRESENT unverifiable
    // instance-id disagrees → overall NOT a match (fail closed).
    expect(
      namespaceOwnershipMatchesInstance(
        { [PART_OF]: applySetId, [INSTANCE_ID]: uid },
        applySetId,
        undefined
      )
    ).toBe(false);
  });

  it('no present identity at all → not owned-by-this-instance', () => {
    expect(namespaceOwnershipMatchesInstance({}, applySetId, uid)).toBe(false);
    expect(
      namespaceOwnershipMatchesInstance({ 'app.kubernetes.io/managed-by': 'kro' }, applySetId, uid)
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Finding #3 — the migration must NOT resume an operator-suspended instance.
// -----------------------------------------------------------------------------
describe('finding #3: only resume instances TypeKro suspended (never an operator suspend)', () => {
  it('not-suspended + pending transfer → we suspend AND resume', () => {
    expect(
      planInstanceMigrationAction({
        preexistingSuspended: false,
        suspendedByUs: false,
        pendingTransfer: true,
        completedTransfer: false,
      })
    ).toEqual({ suspend: true, resume: true });
  });

  it('OPERATOR-suspended (no marker) + pending transfer → stays suspended, NEVER resumed', () => {
    // Still transferred (via toStrip, decided separately) but we must not clear the
    // operator's deliberate suspend.
    expect(
      planInstanceMigrationAction({
        preexistingSuspended: true,
        suspendedByUs: false,
        pendingTransfer: true,
        completedTransfer: false,
      })
    ).toEqual({ suspend: false, resume: false });
  });

  it('suspended BY US + pending transfer → already suspended, resume after (no re-suspend)', () => {
    expect(
      planInstanceMigrationAction({
        preexistingSuspended: true,
        suspendedByUs: true,
        pendingTransfer: true,
        completedTransfer: false,
      })
    ).toEqual({ suspend: false, resume: true });
  });

  it('crash recovery: transferred + suspended BY US, no pending → resume', () => {
    expect(
      planInstanceMigrationAction({
        preexistingSuspended: true,
        suspendedByUs: true,
        pendingTransfer: false,
        completedTransfer: true,
      })
    ).toEqual({ suspend: false, resume: true });
  });

  it('transferred + OPERATOR-suspended, no pending → leave suspended (do nothing)', () => {
    expect(
      planInstanceMigrationAction({
        preexistingSuspended: true,
        suspendedByUs: false,
        pendingTransfer: false,
        completedTransfer: true,
      })
    ).toEqual({ suspend: false, resume: false });
  });
});

// -----------------------------------------------------------------------------
// Blocker #1 — the race-safe ownership strip (re-read + re-validate + conditional
// patch retry-on-409 + confirm-held-or-abort).
// -----------------------------------------------------------------------------
describe('blocker #1: stripKroOwnershipFromNamespace is race-safe', () => {
  const applySetId = computeApplySetId('analytics', 'app', 'Round9', 'test.typekro.dev');
  const target = {
    nsName: 'analytics',
    instanceRef: 'app/analytics',
    expectedApplySetId: applySetId,
    instanceUid: 'uid-1',
  };

  /**
   * A stateful fake KubernetesObjectApi holding one Namespace's labels +
   * resourceVersion. `patch` applies a merge-patch (null deletes a label), honors
   * the resourceVersion precondition (409 on mismatch), and can simulate a
   * concurrent re-stamp of ApplySet ownership after N successful patches.
   */
  function makeFakeApi(opts: {
    conflictOnAttempts?: number[];
    restampAfterPatch?: number; // re-add part-of after this many successful patches
  }) {
    let rv = 1;
    const labels: Record<string, string> = { [PART_OF]: applySetId, 'kro.run/owned': 'true' };
    let patchCount = 0;
    let restampsLeft = opts.restampAfterPatch ?? 0;
    const conflicts = new Set(opts.conflictOnAttempts ?? []);
    const api = {
      read: async () => ({ metadata: { labels: { ...labels }, resourceVersion: String(rv) } }),
      patch: async (obj: {
        metadata: { resourceVersion?: string; labels?: Record<string, string | null> };
      }) => {
        patchCount += 1;
        if (conflicts.has(patchCount)) {
          rv += 1; // someone else wrote first → precondition now stale
          throw Object.assign(new Error('the object has been modified'), { statusCode: 409 });
        }
        const patchLabels = obj.metadata.labels ?? {};
        for (const [k, v] of Object.entries(patchLabels)) {
          if (v === null) delete labels[k];
          else labels[k] = v;
        }
        rv += 1;
        if (restampsLeft > 0) {
          // Simulate an in-flight KRO reconcile re-adopting the Namespace.
          labels[PART_OF] = applySetId;
          rv += 1;
          restampsLeft -= 1;
        }
        return {};
      },
    };
    return { api, get patchCount() { return patchCount; }, get labels() { return labels; } };
  }

  it('a 409 on the strip retries with a fresh read and succeeds', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const fake = makeFakeApi({ conflictOnAttempts: [1] });
    const strip = priv(factory, 'stripKroOwnershipFromNamespace');
    await strip(fake.api, target);
    // First patch 409'd, second succeeded.
    expect(fake.patchCount).toBe(2);
    // Ownership actually removed; retention marker stamped.
    expect(fake.labels[PART_OF]).toBeUndefined();
    expect(fake.labels['kro.run/owned']).toBeUndefined();
    expect(fake.labels['typekro.io/kro-instance-namespace']).toBe('true');
  });

  it('a re-stamp AFTER the strip is detected by confirm-held and re-stripped', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const fake = makeFakeApi({ restampAfterPatch: 1 });
    const strip = priv(factory, 'stripKroOwnershipFromNamespace');
    await strip(fake.api, target);
    // Patch #1 stripped, KRO re-stamped, confirm caught it → patch #2 re-stripped.
    expect(fake.patchCount).toBe(2);
    expect(fake.labels[PART_OF]).toBeUndefined();
  });

  it('ABORTS fail-closed when KRO keeps re-stamping ownership past the retry budget', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    // Re-stamp on every patch → confirm-held never holds → exhaust the budget.
    const fake = makeFakeApi({ restampAfterPatch: 999 });
    const strip = priv(factory, 'stripKroOwnershipFromNamespace');
    let caught: unknown;
    await (strip(fake.api, target) as Promise<void>).catch((e) => {
      caught = e;
    });
    expect((caught as Error | undefined)?.message).toMatch(/Could not confirm/);
    // The migration NEVER proceeds to apply the new RGD in this state (the caller
    // rethrows this before touching the RGD).
  });

  it('is idempotent: an already-stripped (retention-marked) Namespace is a no-op', async () => {
    const factory = ownsNs().factory('kro', { namespace: 'app' });
    const fake = {
      api: {
        read: async () => ({
          metadata: {
            labels: { 'typekro.io/kro-instance-namespace': 'true', 'app.kubernetes.io/managed-by': 'typekro' },
            resourceVersion: '7',
          },
        }),
        patch: async () => {
          throw new Error('patch must not be called for an already-transferred namespace');
        },
      },
    };
    const strip = priv(factory, 'stripKroOwnershipFromNamespace');
    await expect(strip(fake.api, target) as Promise<void>).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Blocker #2 — the GRAPH/composition serialization path applies the SAME status
// rewriting + dangling-ref assertion the factory path has.
// -----------------------------------------------------------------------------
describe('blocker #2: graph.toYaml() gets the SAME status handling the factory path has', () => {
  const graphDef = {
    name: 'round9-graph',
    apiVersion: 'test.typekro.dev/v1alpha1',
    kind: 'Round9Graph',
    spec: type({ name: 'string', namespace: 'string' }),
    status: type({ ready: 'boolean', 'phase?': 'string' }),
  };
  const ownsNsResources = (schemaProxy: { spec: { namespace: unknown } }) => ({
    ownedNamespace: namespace({
      id: 'ownedNamespace',
      metadata: { name: Cel.expr(schemaProxy.spec.namespace) as string },
    }),
  });

  it('a status ref to the hoisted Namespace that the rewrite cannot cover FAILS LOUDLY (dangling-ref assertion) on the GRAPH path', () => {
    // The pre-fix bug: the graph path passed status CEL through UNCHANGED after
    // hoisting, shipping an RGD with `resources:[]` and a `${ownedNamespace.*}` ref
    // KRO rejects at runtime. The graph path now runs the SAME post-serialization
    // dangling-ref assertion the factory path does, so an uncovered reference form
    // (here a `status.*` ref that isn't the rewritable `metadata.name`) fails at
    // serialization instead — never shipping a broken RGD.
    const graph = toResourceGraph(graphDef, ownsNsResources, (_s, r) => {
      return { ready: true, phase: (r.ownedNamespace as unknown as { status: { phase: string } }).status.phase };
    });
    expect(() => graph.toYaml()).toThrow(/dangling reference to removed resource "ownedNamespace"/);
  });

  it('the FACTORY path throws the SAME dangling-ref error for the same graph (parity)', () => {
    const composition = kubernetesComposition(schema, (spec) => {
      const ns = namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
      return {
        ready: true,
        namespaceName: (ns as unknown as { status: { phase: string } }).status.phase,
      };
    });
    expect(() => composition.factory('kro', { namespace: 'app' }).toYaml()).toThrow(
      /dangling reference to removed resource "ownedNamespace"/
    );
  });

  it('the common metadata.name status case serializes cleanly on the GRAPH path (no dangling, no throw)', () => {
    const graph = toResourceGraph(graphDef, ownsNsResources, (_s, r) => {
      return { ready: true, phase: r.ownedNamespace.metadata.name as unknown as string };
    });
    const rgd = graph.toYaml();
    expect(rgd).not.toContain('kind: Namespace');
    expect(rgd).not.toContain('ownedNamespace.metadata');
    expect(rgd).not.toContain('__KUBERNETES_REF_ownedNamespace_');
  });
});
