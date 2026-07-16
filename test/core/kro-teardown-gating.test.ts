import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { DeploymentTimeoutError } from '../../src/core/errors.js';
import { Cel } from '../../src/core/references/cel.js';
import { namespace } from '../../src/factories/kubernetes/core/namespace.js';

/**
 * DETERMINISTIC, OFFLINE proof that KRO teardown routes through the engine's ONE
 * GATING deletion primitive (PR #113 v3):
 *
 *  - THE KEY TEST (finding #1): mock the generated CRD's read so it NEVER returns 404
 *    (a stuck CRD on a slow cluster). `deleteInstance` MUST THROW (a
 *    DeploymentTimeoutError) and the hoisted namespace MUST NEVER be deleted — the gate
 *    held. This is exactly what the old non-gating `waitForResourceFullyDeleted` (which
 *    silently returned on timeout and then deleted the namespace behind a Terminating
 *    CRD) failed to do.
 *  - POSITIVE: once the CRD 404s, teardown REACHES the namespace step (delete-after-CRD
 *    ordering preserved).
 *  - OWNERSHIP (finding #4): a declared namespace that is NOT recorded as created by
 *    this RGD (no matching `typekro.io/created-by-rgd` annotation) is NEVER deleted.
 *
 * The real cluster create/delete ORDER is validated by the maintainer on OrbStack via
 * test/integration/kro-namespace-sibling-lifecycle.test.ts (WRITTEN, not run here).
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
  // Short timeout so the stuck-CRD gate throws in ~1 poll rather than minutes.
  return composition.factory('kro', { namespace: workloadNs, timeout: 250 });
}

interface Call {
  kind: string;
  name: string;
}

/**
 * A mock KubernetesObjectApi (read + delete) whose per-kind 404 behavior is
 * configurable. `crdEverGone` false simulates a CRD stuck Terminating. The hoisted
 * Namespace read returns the given annotations (ownership record).
 */
function makeMockApi(opts: {
  crdEverGone: boolean;
  namespaceAnnotations?: Record<string, string>;
}) {
  const reads: Call[] = [];
  const deletes: Call[] = [];
  let crReadCount = 0;
  const notFound = () => {
    const err = new Error('not found') as Error & { statusCode?: number };
    err.statusCode = 404;
    return err;
  };
  const api = {
    read: async (obj: { kind?: string; metadata?: { name?: string } }) => {
      const kind = obj.kind ?? '?';
      reads.push({ kind, name: obj.metadata?.name ?? '?' });
      if (kind === 'TeardownGate') {
        // First read captures the CR's spec; after the delete gate it is gone (404).
        crReadCount += 1;
        if (crReadCount === 1) return { spec: { name: 'inst', namespace: 'app-ns' } };
        throw notFound();
      }
      if (kind === 'ResourceGraphDefinition') throw notFound(); // RGD drains promptly
      if (kind === 'CustomResourceDefinition') {
        if (opts.crdEverGone) throw notFound();
        return { metadata: { name: obj.metadata?.name } }; // STUCK: never 404
      }
      if (kind === 'Namespace') {
        return { metadata: { name: obj.metadata?.name, annotations: opts.namespaceAnnotations ?? {} } };
      }
      throw notFound();
    },
    delete: async (obj: { kind?: string; metadata?: { name?: string } }) => {
      deletes.push({ kind: obj.kind ?? '?', name: obj.metadata?.name ?? '?' });
      return {};
    },
  };
  return { api, reads, deletes };
}

/** Wire the mock cluster surfaces onto a factory's private methods. */
function wire(
  factory: unknown,
  api: unknown,
  declaredNamespaces: string[]
): { rgdName: string } {
  const rec = factory as Rec;
  rec.createKubernetesObjectApi = () => api;
  rec.discoveredPlural = 'teardowngates';
  rec.createCustomObjectsApi = async () => ({
    // No OTHER instances remain — so RGD/CRD/namespace teardown proceeds.
    listClusterCustomObject: async () => ({ items: [] }),
  });
  // Declared hoisted namespaces (finding #4a) — normally derived from the CR's spec.
  rec.concreteHoistedNamespaces = () =>
    new Map(declaredNamespaces.map((n) => [n, { apiVersion: 'v1', kind: 'Namespace' }]));
  return { rgdName: rec.rgdName as string };
}

describe('KRO teardown gates on a real 404 via the engine primitive (finding #1)', () => {
  it('THE KEY TEST: a stuck CRD makes deleteInstance THROW and the namespace is NEVER deleted', async () => {
    const factory = makeFactory('teardown-stuck', 'app-ns');
    const { api, deletes } = makeMockApi({ crdEverGone: false });
    wire(factory, api, ['app-ns']);

    // The gate holds on the never-404 CRD: deleteInstance rejects (does NOT silently
    // proceed) with a timeout error.
    await expect(factory.deleteInstance('inst')).rejects.toBeInstanceOf(DeploymentTimeoutError);

    // The CRD delete WAS attempted (we reached that step) ...
    expect(deletes.some((d) => d.kind === 'CustomResourceDefinition')).toBe(true);
    // ... but because the CRD never 404'd, the namespace was NEVER deleted — the exact
    // failure the old silent-return wait allowed.
    expect(deletes.some((d) => d.kind === 'Namespace')).toBe(false);
  });

  it('POSITIVE: once the CRD 404s, teardown REACHES the namespace step (delete-after-CRD ordering)', async () => {
    const factory = makeFactory('teardown-ok', 'app-ns');
    // Use a non-matching ownership annotation so the ownership guard RETAINS BEFORE the
    // cluster-backed emptiness discovery runs (which is unavailable offline). The point
    // of this test is ORDERING: with the CRD 404'd, the namespace step is REACHED (the
    // namespace is read) — the opposite of the stuck-CRD case above. The actual
    // owned+empty delete is covered by the deleteNamespaceIfEmpty unit tests.
    const { api, reads, deletes } = makeMockApi({ crdEverGone: true, namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    await factory.deleteInstance('inst');
    // Reached the namespace teardown (read it) — the CRD gate did NOT block.
    expect(reads.some((r) => r.kind === 'Namespace' && r.name === 'app-ns')).toBe(true);
    // The RGD and CRD were both deleted and gated to 404 before the namespace step.
    expect(deletes.some((d) => d.kind === 'ResourceGraphDefinition')).toBe(true);
    expect(deletes.some((d) => d.kind === 'CustomResourceDefinition')).toBe(true);
  });
});

describe('KRO teardown ownership record (finding #4)', () => {
  it('an declared namespace NOT created by this RGD (no ownership annotation) is NEVER deleted', async () => {
    const factory = makeFactory('teardown-adopted', 'app-ns');
    // Annotation ABSENT → adopted/undeclared → must be retained.
    const { api, deletes, reads } = makeMockApi({ crdEverGone: true, namespaceAnnotations: {} });
    wire(factory, api, ['app-ns']);

    await factory.deleteInstance('inst');

    // We reached the namespace step (read it for ownership) ...
    expect(reads.some((r) => r.kind === 'Namespace')).toBe(true);
    // ... but ownership did not match, so the namespace was RETAINED (never deleted).
    expect(deletes.some((d) => d.kind === 'Namespace')).toBe(false);
  });

  it('a namespace this instance never declared is never even considered', async () => {
    const factory = makeFactory('teardown-undeclared', 'app-ns');
    const { api, deletes, reads } = makeMockApi({ crdEverGone: true });
    wire(factory, api, []); // declares NO hoisted namespaces

    await factory.deleteInstance('inst');

    expect(reads.some((r) => r.kind === 'Namespace')).toBe(false);
    expect(deletes.some((d) => d.kind === 'Namespace')).toBe(false);
  });
});
