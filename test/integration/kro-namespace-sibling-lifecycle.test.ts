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
 *  (B) DELETE-ORDER (v4) — REVERSE-TOPOLOGICAL: the reverse of create order, so CRDs
 *      (the most foundational type) are destroyed LAST. Deleting the instance clears
 *      `kro.run/finalizer` (CR → 404, a hard gate) BEFORE the RGD is deleted (→ 404, hard
 *      gate), then the instance's OWN namespace, then the generated CRD LAST. The
 *      namespace is deleted BEFORE the CRD — while the CRD is still HEALTHY, so the
 *      namespace controller enumerates its zero instances instantly and the namespace
 *      terminates reliably (a *Terminating* CRD is what stalls a namespace; kro#1171).
 *      The final CRD delete is BEST-EFFORT / NON-FATAL: it is initiated and awaited
 *      generously, but a slow/stuck apiextensions cleanup finalizer is tolerated (it
 *      blocks nothing — the namespace is already gone). The namespace is deleted ONLY if
 *      BOTH (a) it is declared+created by THIS RGD — it carries the
 *      `typekro.io/created-by-rgd` ownership record (finding #4) — AND (b) it is empty
 *      (secondary guard, finding #5); it is RETAINED if another stack/user still holds a
 *      resource there, or if it was merely ADOPTED (no ownership record).
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
const OWNER_ANNOTATION = 'typekro.io/created-by-rgd';

/** Randomize the COMPLETE cluster-scoped identity so concurrent runs never collide. */
const runToken = Math.random().toString(36).slice(2, 8); // lowercase alphanumeric

const LifecycleSpec = type({ name: 'string', namespace: 'string' });
const LifecycleStatus = type({ ready: 'boolean' });

type NsRead =
  | {
      metadata?: {
        uid?: string;
        deletionTimestamp?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
    }
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

/**
 * Find the live generated CRD name (`<plural>.<group>`) for a (group, kind), or undefined
 * if no such CRD exists (already gone / never created). Lists CRDs and matches.
 */
async function findGeneratedCrdName(
  api: k8s.KubernetesObjectApi,
  group: string,
  kind: string
): Promise<string | undefined> {
  const crds = (await api.list('apiextensions.k8s.io/v1', 'CustomResourceDefinition')) as unknown as {
    items?: Array<{ metadata?: { name?: string }; spec?: { group?: string; names?: { kind?: string } } }>;
  };
  return crds.items?.find((c) => c.spec?.group === group && c.spec?.names?.kind === kind)?.metadata
    ?.name;
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
    // typekro CREATED this namespace (it did not pre-exist), so it stamped the ownership
    // record used by teardown (finding #4b): only a namespace carrying this is a
    // deletion candidate.
    expect(ns?.metadata?.annotations?.[OWNER_ANNOTATION]).toBeDefined();

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

  // Unique per-test namespaces so the cases never collide.
  const emptyNs = `typekro-ns-del-empty-${Date.now().toString().slice(-6)}`;
  const occupiedNs = `typekro-ns-del-occ-${Date.now().toString().slice(-6)}`;
  const adoptedNs = `typekro-ns-del-adopt-${Date.now().toString().slice(-6)}`;

  beforeAll(() => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kc);
    objectApi = createKubernetesObjectApiClient(kc);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    // The occupied + adopted namespaces are intentionally retained by the delete path — sweep them.
    await deleteNamespaceAndWait(occupiedNs, kc).catch(() => {});
    await deleteNamespaceAndWait(adoptedNs, kc).catch(() => {});
    await deleteNamespaceAndWait(emptyNs, kc).catch(() => {});
  });

  it('deletes an EMPTY own namespace BEFORE the (best-effort, last) CRD delete — no deadlock', async () => {
    const group = `d${runToken}.typekro.dev`;
    const kind = `NsDelEmpty${runToken}`;
    const factory = ownsNamespace(`ns-del-empty-${runToken}`, kind).factory('kro', {
      namespace: emptyNs,
      kubeConfig: kc,
      timeout: 180_000,
    });
    await factory.deploy({ name: 'ns-del-empty-instance', namespace: emptyNs });
    expect(await readNamespace(objectApi, emptyNs)).toBeDefined();
    // The generated CRD exists after deploy.
    expect(await findGeneratedCrdName(objectApi, group, kind)).toBeDefined();

    // deleteInstance MUST resolve (not reject): CR → 404 (hard gate) → RGD → 404 (hard
    // gate) → empty-gate deletes the (empty) OWNED namespace → generated CRD deleted LAST
    // (best-effort/non-fatal). The namespace delete is NOT gated on the CRD; the CRD is
    // still healthy while the namespace terminates, so the namespace drains cleanly.
    await factory.deleteInstance('ns-del-empty-instance');

    // (1) The namespace is DELETED (hard). Termination is async (Terminating → drain →
    // the `kubernetes` finalizer clears → 404). Assert deletion was INITIATED
    // (deletionTimestamp, or already 404), then poll to full 404 — proving no deadlock.
    const rightAfter = await readNamespace(objectApi, emptyNs);
    if (rightAfter !== undefined) {
      expect(rightAfter.metadata?.deletionTimestamp).toBeDefined();
    }
    const nsDeadline = Date.now() + 120_000;
    let own = rightAfter;
    while (own !== undefined && Date.now() < nsDeadline) {
      await new Promise((r) => setTimeout(r, 3000));
      own = await readNamespace(objectApi, emptyNs);
    }
    expect(own).toBeUndefined(); // namespace drained cleanly — no deadlock

    // (2) The generated CRD deletion was INITIATED and (given a GENEROUS non-fatal wait)
    // is eventually gone — NOT retained. It is the LAST teardown step and best-effort, so
    // its apiextensions cleanup finalizer may lag the namespace; poll generously.
    const crdDeadline = Date.now() + 180_000;
    let crdName = await findGeneratedCrdName(objectApi, group, kind);
    while (crdName !== undefined && Date.now() < crdDeadline) {
      await new Promise((r) => setTimeout(r, 5000));
      crdName = await findGeneratedCrdName(objectApi, group, kind);
    }
    expect(crdName).toBeUndefined(); // the generated CRD was deleted (last, best-effort)
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

    // deleteInstance drains THIS instance (CR → 404 → RGD → 404), then the empty-gate
    // finds a non-default occupant and RETAINS the namespace rather than deleting it (the
    // generated CRD delete still runs last, best-effort).
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

  it('RETAINS an ADOPTED, pre-existing namespace (no ownership record → never deleted)', async () => {
    // The namespace PRE-EXISTS (created out-of-band, not by typekro). typekro adopts it
    // (the CR lands in it) but must NOT stamp the `created-by-rgd` ownership record, so
    // teardown NEVER deletes a namespace it merely adopted (finding #4b / finding #3).
    await coreApi.createNamespace({ body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: adoptedNs } } });

    const factory = ownsNamespace(`ns-del-adopt-${runToken}`, `NsDelAdopt${runToken}`).factory('kro', {
      namespace: adoptedNs,
      kubeConfig: kc,
      timeout: 180_000,
    });
    await factory.deploy({ name: 'ns-del-adopt-instance', namespace: adoptedNs });

    // The adopted namespace carries typekro's marker but NOT the ownership record.
    const afterDeploy = await readNamespace(objectApi, adoptedNs);
    expect(afterDeploy?.metadata?.annotations?.[OWNER_ANNOTATION]).toBeUndefined();

    // Teardown drains the instance (CR → 404 → RGD → 404) then RETAINS the adopted
    // namespace — it is not an ownership candidate (the generated CRD delete still runs
    // last, best-effort).
    await factory.deleteInstance('ns-del-adopt-instance');

    const retained = await readNamespace(objectApi, adoptedNs);
    expect(retained).toBeDefined();
    expect(retained?.metadata?.deletionTimestamp).toBeUndefined();
  });
});
