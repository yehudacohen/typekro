/**
 * Live CREATE-ORDER + DELETE-ORDER test for the v2 namespace model (PR #113 v2).
 *
 * typekro NEVER emits a `Namespace` into RGD YAML. Every owned Namespace is applied
 * as a SIBLING — created before the RGD (deps-first) and, for the instance's OWN (1:1)
 * namespace, deleted AFTER it. This proves BOTH orderings end-to-end on a real
 * cluster:
 *
 *  (A) CREATE-ORDER — the workload Namespace exists (created by typekro as a sibling,
 *      carrying `typekro.io/kro-instance-namespace=true` and NEVER a KRO ApplySet
 *      member, i.e. no `applyset.kubernetes.io/part-of`) and the RGD's child resource
 *      lands INSIDE it, with the instance reaching Ready.
 *
 *  (B) DELETE-ORDER — deleting the instance clears `kro.run/finalizer` within a
 *      BOUNDED time, then the RGD is torn down, the generated CRD is waited to 404
 *      (finding #1), then the instance's OWN namespace is EMPTY-GATED: an EMPTY
 *      namespace is deleted (404) — NO finalizer deadlock — while a namespace still
 *      holding a non-default resource (another stack/user) is RETAINED (findings
 *      #3 + #4), replacing the old marker + name-equality ownership check.
 *
 * ⚠️ WRITTEN + GATED but NOT executed here. It is gated like the other integration
 * tests (`isClusterAvailable()` + `describe.skip`) and MUST be run only by the
 * maintainer on a local OrbStack cluster (KRO/Flux/cert-manager pre-installed) via an
 * isolated kubeconfig. It must NEVER be run against a production cluster — the real
 * `sela-eks` context is LIVE PROD.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { configMap } from '../../src/factories/kubernetes/config/index.js';
import { namespace as namespaceResource } from '../../src/factories/kubernetes/core/namespace.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from './shared-kubeconfig';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

const APPLYSET_PART_OF_LABEL = 'applyset.kubernetes.io/part-of';
const INSTANCE_NS_LABEL = 'typekro.io/kro-instance-namespace';

/** Randomize the COMPLETE cluster-scoped identity so concurrent runs never collide. */
const runToken = Math.random().toString(36).slice(2, 8); // lowercase alphanumeric

const LifecycleSpec = type({ name: 'string', namespace: 'string' });
const LifecycleStatus = type({ ready: 'boolean' });

type NsRead =
  | { metadata?: { uid?: string; deletionTimestamp?: string; labels?: Record<string, string> } }
  | undefined;

/** Read a Namespace, returning `undefined` on 404 (throws on any other error). */
async function readNamespace(api: k8s.KubernetesObjectApi, name: string): Promise<NsRead> {
  try {
    return (await api.read({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name },
    })) as unknown as NsRead;
  } catch (error: unknown) {
    const code = (error as { statusCode?: number; body?: { code?: number } }).statusCode ??
      (error as { body?: { code?: number } }).body?.code;
    if (code === 404) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// (A) CREATE-ORDER: the owned namespace is a typekro sibling (never in the RGD),
// created before the RGD's resources reconcile into it.
// ---------------------------------------------------------------------------
describeOrSkip('KRO namespace sibling CREATE-ORDER (v2: namespaces never in the RGD)', () => {
  const rgdName = `ns-create-${runToken}`;
  const instanceKind = `NsCreate${runToken}`;
  const group = `c${runToken}.typekro.dev`;
  const apiVersion = `${group}/v1alpha1`;
  const workloadNamespace = `typekro-ns-create-${Date.now().toString().slice(-6)}`;
  const instanceName = 'ns-create-instance';

  const ownsNamespace = kubernetesComposition(
    { name: rgdName, apiVersion, kind: instanceKind, spec: LifecycleSpec, status: LifecycleStatus },
    (spec) => {
      // The composition OWNS the namespace the instance lands in (1:1 self-owned).
      namespaceResource({
        id: 'ownedNamespace',
        metadata: { name: Cel.expr(spec.namespace) as string },
      });
      // A child that must land INSIDE the (sibling-created) workload namespace.
      configMap({
        id: 'marker',
        metadata: { name: 'create-marker', namespace: Cel.expr(spec.namespace) as string },
        data: { ok: 'true' },
      });
      return { ready: true };
    }
  );

  let kc: k8s.KubeConfig;
  let coreApi: k8s.CoreV1Api;
  let objectApi: k8s.KubernetesObjectApi;

  beforeAll(() => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kc);
    objectApi = createKubernetesObjectApiClient(kc);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    try {
      const factory = ownsNamespace.factory('kro', { namespace: workloadNamespace, kubeConfig: kc });
      await factory.deleteInstance(instanceName).catch(() => {});
    } catch {
      /* best effort */
    }
    await deleteNamespaceAndWait(workloadNamespace, kc).catch(() => {});
  });

  it('creates the workload namespace as a typekro sibling (never a KRO ApplySet member) with the child inside it', async () => {
    const factory = ownsNamespace.factory('kro', {
      namespace: workloadNamespace,
      kubeConfig: kc,
      timeout: 180_000,
    });
    await factory.deploy({ name: instanceName, namespace: workloadNamespace });

    // The workload namespace exists and was created by typekro (sibling), NOT by KRO:
    // it carries typekro's marker and NEVER an ApplySet `part-of` membership label —
    // proving it was never a graph child (create-order: sibling before the RGD).
    const ns = await readNamespace(objectApi, workloadNamespace);
    expect(ns).toBeDefined();
    expect(ns?.metadata?.labels?.[INSTANCE_NS_LABEL]).toBe('true');
    expect(ns?.metadata?.labels?.[APPLYSET_PART_OF_LABEL]).toBeUndefined();

    // The RGD's child resource reconciled INTO the pre-created workload namespace.
    const cm = await coreApi.readNamespacedConfigMap({
      name: 'create-marker',
      namespace: workloadNamespace,
    });
    expect((cm as { data?: Record<string, string> }).data?.ok).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// (B) DELETE-ORDER: the instance's own namespace is EMPTY-GATED — an empty one is
// deleted AFTER the RGD/CRD (no deadlock); an OCCUPIED one is RETAINED.
// ---------------------------------------------------------------------------
describeOrSkip('KRO namespace sibling DELETE-ORDER (empty deleted after RGD; occupied retained)', () => {
  const group = `d${runToken}.typekro.dev`;
  const apiVersion = `${group}/v1alpha1`;

  const ownsNamespace = (rgdName: string, instanceKind: string) =>
    kubernetesComposition(
      { name: rgdName, apiVersion, kind: instanceKind, spec: LifecycleSpec, status: LifecycleStatus },
      (spec) => {
        namespaceResource({
          id: 'ownedNamespace',
          metadata: { name: Cel.expr(spec.namespace) as string },
        });
        return { ready: true };
      }
    );

  let kc: k8s.KubeConfig;
  let coreApi: k8s.CoreV1Api;
  let objectApi: k8s.KubernetesObjectApi;

  // Unique per-test namespaces so the two cases never collide.
  const emptyNs = `typekro-ns-del-empty-${Date.now().toString().slice(-6)}`;
  const occupiedNs = `typekro-ns-del-occ-${Date.now().toString().slice(-6)}`;

  beforeAll(() => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kc);
    objectApi = createKubernetesObjectApiClient(kc);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    // The occupied namespace is intentionally retained by the delete path — sweep it.
    await deleteNamespaceAndWait(occupiedNs, kc).catch(() => {});
    await deleteNamespaceAndWait(emptyNs, kc).catch(() => {});
  });

  it('deletes an EMPTY own namespace after the RGD/CRD (no finalizer deadlock)', async () => {
    const factory = ownsNamespace(`ns-del-empty-${runToken}`, `NsDelEmpty${runToken}`).factory(
      'kro',
      { namespace: emptyNs, kubeConfig: kc, timeout: 180_000 }
    );
    await factory.deploy({ name: 'ns-del-empty-instance', namespace: emptyNs });
    expect(await readNamespace(objectApi, emptyNs)).toBeDefined();

    // deleteInstance MUST resolve (not reject with a bounded finalizer-timeout): CR →
    // wait 404 → RGD → wait RGD 404 → wait CRD 404 (finding #1) → empty-gate deletes
    // the (empty) namespace LAST.
    await factory.deleteInstance('ns-del-empty-instance');

    // Namespace termination is async (Terminating → drain → the `kubernetes` finalizer
    // clears → 404). Assert deletion was INITIATED (deletionTimestamp, or already 404),
    // then poll to full 404 — proving no finalizer deadlock.
    const rightAfter = await readNamespace(objectApi, emptyNs);
    if (rightAfter !== undefined) {
      expect(rightAfter.metadata?.deletionTimestamp).toBeDefined();
    }
    const deadline = Date.now() + 120_000;
    let own = rightAfter;
    while (own !== undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      own = await readNamespace(objectApi, emptyNs);
    }
    expect(own).toBeUndefined(); // drained cleanly — no deadlock
  });

  it('RETAINS an OCCUPIED own namespace (another stack/user has a resource there)', async () => {
    const factory = ownsNamespace(`ns-del-occ-${runToken}`, `NsDelOcc${runToken}`).factory('kro', {
      namespace: occupiedNs,
      kubeConfig: kc,
      timeout: 180_000,
    });
    await factory.deploy({ name: 'ns-del-occ-instance', namespace: occupiedNs });
    expect(await readNamespace(objectApi, occupiedNs)).toBeDefined();

    // Simulate ANOTHER stack/user: create a non-default ConfigMap in the namespace that
    // is NOT a KRO child (so KRO's finalizer never removes it). It must keep the
    // empty-gate from deleting the namespace on teardown.
    await coreApi.createNamespacedConfigMap({
      namespace: occupiedNs,
      body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'foreign-tenant-config', namespace: occupiedNs },
        data: { owner: 'another-stack' },
      },
    });

    // deleteInstance drains THIS instance (CR → RGD → CRD), then the empty-gate finds a
    // non-default occupant and RETAINS the namespace rather than deleting it.
    await factory.deleteInstance('ns-del-occ-instance');

    // The namespace is RETAINED — still present and NOT terminating — because it is
    // occupied by the foreign ConfigMap.
    const retained = await readNamespace(objectApi, occupiedNs);
    expect(retained).toBeDefined();
    expect(retained?.metadata?.deletionTimestamp).toBeUndefined();
    // The foreign resource is untouched.
    const cm = await coreApi.readNamespacedConfigMap({
      name: 'foreign-tenant-config',
      namespace: occupiedNs,
    });
    expect((cm as { data?: Record<string, string> }).data?.owner).toBe('another-stack');
    // sanity: the sibling namespace still carries typekro's marker.
    expect(retained?.metadata?.labels?.[INSTANCE_NS_LABEL]).toBe('true');
  });
});
