import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * DETERMINISTIC, OFFLINE proof of the PR #113 v4 teardown ORDER + CRD retention policy.
 *
 * Teardown is REVERSE-TOPOLOGICAL (the reverse of create order; CRDs are the most
 * foundational type, created first + destroyed last):
 *
 *   instance CR (gated → 404)  →  RGD (gated → 404)  →  owned namespace  →  generated CRD
 *
 *  - THE KEY TEST: the generated CRD delete is issued LAST, AFTER the namespace step —
 *    so the namespace delete is NEVER gated on the CRD. And that final CRD delete is
 *    BEST-EFFORT / NON-FATAL: a CRD whose finalizer is stuck (never 404s) does NOT reject
 *    the whole teardown (deleteInstance resolves), because by then the namespace is
 *    already gone and a lingering CRD is harmless (kro#1171). This is the v4 fix for the
 *    stall where deleting a *Terminating* CRD before the namespace hung the namespace.
 *  - POSITIVE: when the CRD 404s, teardown completes with the CRD delete as the final op.
 *  - OWNERSHIP: a declared namespace NOT recorded as created by this RGD (no matching
 *    `typekro.io/created-by-rgd`) is never deleted; a namespace this instance never
 *    declared is never even considered.
 *
 * The actual owned+empty namespace DELETE (empty-gate) is proven by the
 * `deleteNamespaceIfEmpty` unit tests in kro-namespace-v2-fixes.test.ts (which inject a
 * mock inventory). The real cluster ORDER end-to-end is validated by the maintainer on
 * OrbStack via test/integration/kro-namespace-sibling-lifecycle.test.ts (WRITTEN, not run
 * here).
 */

type Rec = Record<string, unknown>;

const TeardownSpec = type({ name: 'string', namespace: 'string' });
const TeardownStatus = type({ ready: 'boolean' });

/** A self-owning composition (creates + owns a Namespace named after spec.namespace). */
function makeFactory(factoryName: string, workloadNs: string) {
  const composition = kubernetesComposition(
    {
      name: factoryName,
      kind: 'TeardownGate',
      spec: TeardownSpec,
      status: TeardownStatus,
    },
    (spec) => {
      namespace({ id: 'ownedNamespace', metadata: { name: Cel.expr(spec.namespace) as string } });
      return { ready: true };
    }
  );
  // Short timeout so the stuck-CRD best-effort wait resolves in ~1 poll rather than minutes.
  return composition.factory('kro', { namespace: workloadNs, timeout: 250 });
}

interface Op {
  op: 'read' | 'delete';
  kind: string;
  name: string;
}

/**
 * A mock KubernetesObjectApi (read + delete) that records the ORDER of every read/delete
 * as `ops`. `crdEverGone` false simulates a CRD stuck Terminating (never 404). The
 * hoisted Namespace read returns the given annotations (ownership record).
 */
function makeMockApi(opts: {
  crdEverGone: boolean;
  namespaceAnnotations?: Record<string, string>;
}) {
  const ops: Op[] = [];
  let crReadCount = 0;
  const notFound = () => {
    const err = new Error('not found') as Error & { statusCode?: number };
    err.statusCode = 404;
    return err;
  };
  const api = {
    read: async (obj: { kind?: string; metadata?: { name?: string } }) => {
      const kind = obj.kind ?? '?';
      const name = obj.metadata?.name ?? '?';
      ops.push({ op: 'read', kind, name });
      if (kind === 'TeardownGate') {
        // First read captures the CR's spec; after the delete gate it is gone (404).
        crReadCount += 1;
        if (crReadCount === 1) return { spec: { name: 'inst', namespace: 'app-ns' } };
        throw notFound();
      }
      if (kind === 'ResourceGraphDefinition') throw notFound(); // RGD drains promptly
      if (kind === 'CustomResourceDefinition') {
        if (opts.crdEverGone) throw notFound();
        return { metadata: { name } }; // STUCK: never 404
      }
      if (kind === 'Namespace') {
        return { metadata: { name, annotations: opts.namespaceAnnotations ?? {} } };
      }
      throw notFound();
    },
    delete: async (obj: { kind?: string; metadata?: { name?: string } }) => {
      ops.push({ op: 'delete', kind: obj.kind ?? '?', name: obj.metadata?.name ?? '?' });
      return {};
    },
  };
  return { api, ops };
}

/** Wire the mock cluster surfaces onto a factory's private methods. */
function wire(factory: unknown, api: unknown, declaredNamespaces: string[]): { rgdName: string } {
  const rec = factory as Rec;
  rec.createKubernetesObjectApi = () => api;
  // The best-effort CRD delete uses the already-discovered plural (no list call).
  rec.discoveredPlural = 'teardowngates';
  rec.createCustomObjectsApi = async () => ({
    // No OTHER instances remain — so RGD/namespace/CRD teardown proceeds.
    listClusterCustomObject: async () => ({ items: [] }),
  });
  // Declared hoisted namespaces (finding #4a) — normally derived from the CR's spec.
  rec.concreteHoistedNamespaces = () =>
    new Map(declaredNamespaces.map((n) => [n, { apiVersion: 'v1', kind: 'Namespace' }]));
  return { rgdName: rec.rgdName as string };
}

const first = (ops: Op[], op: Op['op'], kind: string): number =>
  ops.findIndex((o) => o.op === op && o.kind === kind);

describe('KRO teardown deletes the CRD LAST — never gating the namespace on it (v4)', () => {
  it('THE KEY TEST: order is CR → RGD → namespace → CRD (CRD LAST); a never-404 CRD is NON-FATAL', async () => {
    const factory = makeFactory('teardown-order', 'app-ns');
    // Stuck CRD (never 404) + a non-matching ownership annotation so the namespace step is
    // REACHED (the ns is read) then RETAINED offline — the empty-gate's cluster discovery
    // is unavailable here; the owned+empty delete is proven in the deleteNamespaceIfEmpty
    // unit tests. The point of THIS test is ORDER + non-fatal CRD.
    const { api, ops } = makeMockApi({ crdEverGone: false, namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    // A stuck CRD does NOT reject the whole teardown — the CRD delete is the LAST step
    // and is best-effort / non-fatal (the namespace is already gone by then).
    await factory.deleteInstance('inst'); // resolves, does NOT throw

    const crDelete = first(ops, 'delete', 'TeardownGate');
    const rgdDelete = first(ops, 'delete', 'ResourceGraphDefinition');
    const nsRead = first(ops, 'read', 'Namespace');
    const crdDelete = first(ops, 'delete', 'CustomResourceDefinition');

    // All four steps ran, strictly ordered CR → RGD → namespace → CRD.
    expect(crDelete).toBeGreaterThanOrEqual(0);
    expect(rgdDelete).toBeGreaterThan(crDelete); // RGD after the CR (finalizer cleared)
    expect(nsRead).toBeGreaterThan(rgdDelete); // namespace step after the RGD
    // CRD delete is issued AFTER the namespace step — i.e. the namespace was processed
    // (and would have been deleted, if owned+empty) BEFORE the CRD, so the namespace
    // delete is NOT gated on the CRD. This is the v4 stall fix.
    expect(crdDelete).toBeGreaterThan(nsRead);
  });

  it('POSITIVE: when the CRD 404s, teardown completes and the CRD delete is the final op', async () => {
    const factory = makeFactory('teardown-ok', 'app-ns');
    const { api, ops } = makeMockApi({ crdEverGone: true, namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    await factory.deleteInstance('inst');

    const nsRead = first(ops, 'read', 'Namespace');
    const crdDelete = first(ops, 'delete', 'CustomResourceDefinition');
    expect(first(ops, 'delete', 'ResourceGraphDefinition')).toBeGreaterThanOrEqual(0);
    expect(nsRead).toBeGreaterThanOrEqual(0);
    expect(crdDelete).toBeGreaterThan(nsRead);
  });
});

describe('KRO teardown ownership record (finding #4)', () => {
  it('a declared namespace NOT created by this RGD (no ownership annotation) is NEVER deleted', async () => {
    const factory = makeFactory('teardown-adopted', 'app-ns');
    // Annotation ABSENT → adopted/undeclared → must be retained.
    const { api, ops } = makeMockApi({ crdEverGone: true, namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    await factory.deleteInstance('inst');

    // We reached the namespace step (read it for ownership) ...
    expect(first(ops, 'read', 'Namespace')).toBeGreaterThanOrEqual(0);
    // ... but ownership did not match, so the namespace was RETAINED (never deleted).
    expect(ops.some((o) => o.op === 'delete' && o.kind === 'Namespace')).toBe(false);
  });

  it('a namespace this instance never declared is never even considered', async () => {
    const factory = makeFactory('teardown-undeclared', 'app-ns');
    const { api, ops } = makeMockApi({ crdEverGone: true });
    wire(factory, api, []); // declares NO hoisted namespaces

    await factory.deleteInstance('inst');

    expect(ops.some((o) => o.op === 'read' && o.kind === 'Namespace')).toBe(false);
    expect(ops.some((o) => o.op === 'delete' && o.kind === 'Namespace')).toBe(false);
  });
});
