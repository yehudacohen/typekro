import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * DETERMINISTIC, OFFLINE proof of the PR #113 v4 teardown ORDER + CRD retention policy.
 *
 * Teardown order (finding #2 — THIS instance's namespace is cleaned right after the CR is
 * gone, BEFORE the remaining-instance / RGD block; the generated CRD stays Active):
 *
 *   instance CR (gated → 404)  →  owned namespace  →  RGD (gated → 404)
 *   generated CRD: retained Active with zero instances
 *
 *  - THE KEY TEST: no generated-CRD delete is issued. The RGD + CRD stay Healthy/Active
 *    while the namespace terminates, and the CRD remains reusable after teardown instead
 *    of risking a stuck `Terminating` state (kro#1171).
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
  return composition.factory('kro', { namespace: workloadNs, timeout: 250 });
}

interface Op {
  op: 'read' | 'delete';
  kind: string;
  name: string;
}

/**
 * A mock KubernetesObjectApi (read + delete) that records the ORDER of every read/delete
 * as `ops`. The hoisted Namespace read returns the given annotations (ownership record).
 */
function makeMockApi(opts: { namespaceAnnotations?: Record<string, string> } = {}) {
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
      if (kind === 'CustomResourceDefinition') return { metadata: { name } };
      if (kind === 'Namespace') {
        return { metadata: { name, annotations: opts.namespaceAnnotations ?? {} } };
      }
      throw notFound();
    },
    delete: async (obj: { kind?: string; metadata?: { name?: string } }) => {
      ops.push({ op: 'delete', kind: obj.kind ?? '?', name: obj.metadata?.name ?? '?' });
      return {};
    },
    // Cluster-wide Namespace list for the retry-safe created-by-rgd sweep + confirm gate
    // (finding #2). These order/ownership tests have NO leaked owned namespace, so the
    // sweep is a no-op and the definitions proceed to delete.
    list: async (_apiVersion: string, _kind: string) => ({ items: [], metadata: {} }),
  };
  return { api, ops };
}

/** Wire the mock cluster surfaces onto a factory's private methods. */
function wire(factory: unknown, api: unknown, declaredNamespaces: string[]): { rgdName: string } {
  const rec = factory as Rec;
  rec.createKubernetesObjectApi = () => api;
  // Avoid unrelated discovery in this teardown-order fixture.
  rec.discoveredPlural = 'teardowngates';
  rec.createCustomObjectsApi = async () => ({
    // No OTHER instances remain — so RGD/namespace teardown proceeds.
    listClusterCustomObject: async () => ({ items: [] }),
  });
  // Declared hoisted namespaces (finding #4a) — normally derived from the CR's spec.
  rec.concreteHoistedNamespaces = () =>
    new Map(declaredNamespaces.map((n) => [n, { apiVersion: 'v1', kind: 'Namespace' }]));
  return { rgdName: rec.rgdName as string };
}

const first = (ops: Op[], op: Op['op'], kind: string): number =>
  ops.findIndex((o) => o.op === op && o.kind === kind);

describe('KRO teardown retains the generated CRD Active', () => {
  it('THE KEY TEST: order is CR → namespace → RGD, with no generated-CRD delete', async () => {
    const factory = makeFactory('teardown-order', 'app-ns');
    // A non-matching ownership annotation makes the namespace step observable as a read
    // while retaining it in this offline fixture. Owned+empty deletion is proven in the
    // deleteNamespaceIfEmpty unit tests; this test proves ordering and CRD retention.
    const { api, ops } = makeMockApi({ namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    await factory.deleteInstance('inst');

    const crDelete = first(ops, 'delete', 'TeardownGate');
    const rgdDelete = first(ops, 'delete', 'ResourceGraphDefinition');
    const nsRead = first(ops, 'read', 'Namespace');
    const crdDelete = first(ops, 'delete', 'CustomResourceDefinition');

    // Runtime resources are removed in strict CR → namespace → RGD order.
    expect(crDelete).toBeGreaterThanOrEqual(0);
    expect(nsRead).toBeGreaterThan(crDelete); // namespace step after the CR (finalizer cleared)
    expect(rgdDelete).toBeGreaterThan(nsRead); // RGD after the namespace step
    // The generated definition remains Active and immediately reusable.
    expect(crdDelete).toBe(-1);
  });
});

describe('KRO teardown ownership record (finding #4)', () => {
  it('a declared namespace NOT created by this RGD (no ownership annotation) is NEVER deleted', async () => {
    const factory = makeFactory('teardown-adopted', 'app-ns');
    // Annotation ABSENT → adopted/undeclared → must be retained.
    const { api, ops } = makeMockApi({ namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    await factory.deleteInstance('inst');

    // We reached the namespace step (read it for ownership) ...
    expect(first(ops, 'read', 'Namespace')).toBeGreaterThanOrEqual(0);
    // ... but ownership did not match, so the namespace was RETAINED (never deleted).
    expect(ops.some((o) => o.op === 'delete' && o.kind === 'Namespace')).toBe(false);
  });

  it('a namespace this instance never declared is never even considered', async () => {
    const factory = makeFactory('teardown-undeclared', 'app-ns');
    const { api, ops } = makeMockApi();
    wire(factory, api, []); // declares NO hoisted namespaces

    await factory.deleteInstance('inst');

    expect(ops.some((o) => o.op === 'read' && o.kind === 'Namespace')).toBe(false);
    expect(ops.some((o) => o.op === 'delete' && o.kind === 'Namespace')).toBe(false);
  });
});
