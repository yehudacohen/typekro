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
 *  (B) DELETE-ORDER — deleting the instance clears `kro.run/finalizer` (CR → 404,
 *      a hard gate),
 *      then cleans the instance's OWN namespace(s) RIGHT AWAY (finding #2: per-instance
 *      cleanup runs BEFORE the shared-RGD / CRD teardown, so a non-last instance never
 *      leaks its namespace), then — only when no other instance remains — deletes the RGD
 *      (→ 404, hard gate). So the order is CR → namespace → RGD, while the generated
 *      CRD remains Active with zero instances. The namespace is deleted while the RGD + CRD are both
 *      still HEALTHY/Active, so the namespace controller enumerates zero instances
 *      instantly and the namespace terminates reliably (a *Terminating* CRD is what stalls
 *      a namespace; kro#1171) — it can never terminate against a Terminating CRD. The
 *      Active generated CRD is reusable by a later deployment and can be explicitly
 *      garbage-collected when the kind is retired. The instance CR carries a durable
 *      `typekro.io/hoisted-namespaces` record (finding #4) so teardown knows its exact
 *      owned namespaces cross-process. The namespace is deleted ONLY if BOTH (a) it is
 *      created by THIS RGD — it carries the `typekro.io/created-by-rgd` ownership record,
 *      stamped atomically create-first (finding #3) — AND (b) it is empty (secondary
 *      guard, finding #5); it is RETAINED if another stack/user still holds a resource
 *      there, or if it was merely ADOPTED (no ownership record).
 *
 * ⚠️ WRITTEN + GATED but NOT executed here. It is gated like the other integration
 * tests (`isClusterAvailable()` + `describe.skip`) and MUST be run only by the
 * maintainer on a local OrbStack cluster (KRO/Flux/cert-manager pre-installed) via an
 * isolated kubeconfig. It must NEVER be run against a production cluster — the real
 * `sela-eks` context is LIVE PROD.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);

import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';

import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { Cel } from '../../src/core/references/cel.js';
import { configMap } from '../../src/factories/kubernetes/config/index.js';
import { namespace as namespaceResource } from '../../src/factories/kubernetes/core/namespace.js';
import {
  captureTestNamespaceLease,
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isNotFoundError,
  type TestNamespaceLease,
} from './shared-kubeconfig';

const clusterAvailable = await isClusterAvailable();
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
    const code =
      (error as { statusCode?: number; body?: { code?: number } }).statusCode ??
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
  const crds = (await api.list(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition'
  )) as unknown as {
    items?: Array<{
      metadata?: { name?: string };
      spec?: { group?: string; names?: { kind?: string } };
    }>;
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
  let workloadNamespaceLease: TestNamespaceLease | undefined;

  beforeAll(() => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kc);
    objectApi = createKubernetesObjectApiClient(kc);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    const factory = ownsNamespace.factory('kro', {
      namespace: workloadNamespace,
      kubeConfig: kc,
    });
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      factory,
      instanceName,
      workloadNamespaceLease ? [workloadNamespaceLease] : [],
      kc,
      60_000
    );
  });

  it('creates the workload namespace as a typekro sibling (never a KRO ApplySet member) with the child inside it', async () => {
    const factory = ownsNamespace.factory('kro', {
      namespace: workloadNamespace,
      kubeConfig: kc,
      timeout: 180_000,
    });
    await factory.deploy({ name: instanceName, namespace: workloadNamespace });
    workloadNamespaceLease = await captureTestNamespaceLease(workloadNamespace, kc);
    if (!workloadNamespaceLease) {
      throw new Error(`Expected TypeKro to create namespace ${workloadNamespace}`);
    }

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
// deleted before the RGD while the generated CRD remains Active; an OCCUPIED one is retained.
// ---------------------------------------------------------------------------
describeOrSkip(
  'KRO namespace sibling DELETE-ORDER (empty deleted before RGD; CRD retained)',
  () => {
    const group = `d${runToken}.typekro.dev`;
    const apiVersion = `${group}/v1alpha1`;

    const ownsNamespace = (rgdName: string, instanceKind: string) =>
      kubernetesComposition(
        {
          name: rgdName,
          apiVersion,
          kind: instanceKind,
          spec: LifecycleSpec,
          status: LifecycleStatus,
        },
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
    const namespaceLeases = new Map<string, TestNamespaceLease>();

    const captureOwnedNamespace = async (namespace: string): Promise<void> => {
      const lease = await captureTestNamespaceLease(namespace, kc);
      if (!lease) throw new Error(`Expected TypeKro to create namespace ${namespace}`);
      namespaceLeases.set(namespace, lease);
    };

    // Unique per-test namespaces so the cases never collide.
    const emptyNs = `typekro-ns-del-empty-${Date.now().toString().slice(-6)}`;
    const occupiedNs = `typekro-ns-del-occ-${Date.now().toString().slice(-6)}`;
    const adoptedNs = `typekro-ns-del-adopt-${Date.now().toString().slice(-6)}`;
    const retryNs = `typekro-ns-del-retry-${Date.now().toString().slice(-6)}`;
    // v7 #2: two instances SHARE one workload namespace; their CRs live in a separate control ns.
    const sharedNs = `typekro-ns-del-shared-${Date.now().toString().slice(-6)}`;
    const sharedControlNs = `typekro-ns-del-shared-ctrl-${Date.now().toString().slice(-6)}`;

    beforeAll(() => {
      if (!clusterAvailable) return;
      kc = getIntegrationTestKubeConfig();
      coreApi = createCoreV1ApiClient(kc);
      objectApi = createKubernetesObjectApiClient(kc);
    });

    afterAll(async () => {
      if (!clusterAvailable) return;
      const cleanupErrors: unknown[] = [];

      // The occupied-namespace case deliberately leaves this fixture behind to prove that
      // TypeKro will not delete foreign content. The test harness owns the fixture itself,
      // so remove it explicitly before releasing the namespace lease.
      await deleteTestResourceAndWait(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'foreign-tenant-config', namespace: occupiedNs },
        },
        kc
      ).catch((error) => cleanupErrors.push(error));

      for (const lease of namespaceLeases.values()) {
        try {
          await deleteTestNamespaceAndWait(lease, kc);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      // Occupied/adopted namespace cases intentionally retain their RGD during normal
      // teardown. Once the exact test fixtures above are gone, retire those unique RGDs
      // before deleting generated CRDs so KRO cannot recreate their definitions.
      for (const name of [
        `ns-del-empty-${runToken}`,
        `ns-del-occ-${runToken}`,
        `ns-del-adopt-${runToken}`,
        `ns-del-shared-${runToken}`,
        `ns-del-retry-${runToken}`,
      ]) {
        try {
          await deleteTestResourceAndWait(
            {
              apiVersion: 'kro.run/v1alpha1',
              kind: 'ResourceGraphDefinition',
              metadata: { name },
            },
            kc,
            180_000
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      // Normal application teardown intentionally retains generated CRDs Active. This is
      // explicit test-fixture GC for the unique, retired kinds created by this suite.
      for (const kind of [
        `NsDelEmpty${runToken}`,
        `NsDelOcc${runToken}`,
        `NsDelAdopt${runToken}`,
        `NsShared${runToken}`,
        `NsDelRetry${runToken}`,
      ]) {
        try {
          const crdName = await findGeneratedCrdName(objectApi, group, kind);
          if (!crdName) continue;
          await deleteGeneratedCrdAndWait(
            {
              apiVersion: 'apiextensions.k8s.io/v1',
              kind: 'CustomResourceDefinition',
              metadata: { name: crdName },
            },
            `${group}/v1alpha1`,
            kind,
            kc
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'KRO namespace sibling lifecycle cleanup failed');
      }
    });

    it('deletes an EMPTY own namespace and retains the generated CRD Active — no deadlock', async () => {
      const group = `d${runToken}.typekro.dev`;
      const kind = `NsDelEmpty${runToken}`;
      const factory = ownsNamespace(`ns-del-empty-${runToken}`, kind).factory('kro', {
        namespace: emptyNs,
        kubeConfig: kc,
        timeout: 300_000,
      });
      await factory.deploy({ name: 'ns-del-empty-instance', namespace: emptyNs });
      await captureOwnedNamespace(emptyNs);
      expect(await readNamespace(objectApi, emptyNs)).toBeDefined();
      // The generated CRD exists after deploy.
      expect(await findGeneratedCrdName(objectApi, group, kind)).toBeDefined();

      // deleteInstance MUST resolve (not reject): CR → 404 (hard gate) → empty-gate deletes
      // the (empty) OWNED namespace (finding #2: per-instance, before the RGD block) →
      // RGD → 404 (hard gate), while retaining the generated CRD Active. The
      // namespace delete is NOT gated on the CRD; the RGD + CRD are both still healthy while
      // the namespace terminates, so the namespace drains cleanly.
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

      // (2) The generated CRD remains Active and reusable; normal teardown never places it
      // into a potentially stuck Terminating state.
      const crdName = await findGeneratedCrdName(objectApi, group, kind);
      expect(crdName).toBeDefined();
      if (!crdName) throw new Error(`Generated CRD for ${group}/${kind} was not retained.`);
      const crd = await objectApi.read({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: crdName },
      });
      expect(crd.metadata?.deletionTimestamp).toBeUndefined();
    });

    it('RETAINS an OCCUPIED own namespace (another stack/user has a resource there)', async () => {
      const factory = ownsNamespace(`ns-del-occ-${runToken}`, `NsDelOcc${runToken}`).factory(
        'kro',
        {
          namespace: occupiedNs,
          kubeConfig: kc,
          timeout: 180_000,
        }
      );
      await factory.deploy({ name: 'ns-del-occ-instance', namespace: occupiedNs });
      await captureOwnedNamespace(occupiedNs);
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

      // deleteInstance drains THIS instance (CR → 404), then the empty-gate finds a
      // non-default occupant and RETAINS the namespace rather than deleting it; the RGD
      // (→ 404); the generated CRD remains Active for reuse.
      const deletionStartedAt = Date.now();
      const deletion = await factory.deleteInstance('ns-del-occ-instance');
      expect(deletion.status).toBe('complete');
      expect(deletion.retained).toContainEqual(
        expect.objectContaining({
          resource: expect.objectContaining({ kind: 'Namespace', name: occupiedNs }),
          policy: 'occupied-namespace',
        })
      );
      expect(Date.now() - deletionStartedAt).toBeLessThan(30_000);

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
      namespaceLeases.set(adoptedNs, await createTestNamespace(adoptedNs, kc));

      const factory = ownsNamespace(`ns-del-adopt-${runToken}`, `NsDelAdopt${runToken}`).factory(
        'kro',
        {
          namespace: adoptedNs,
          kubeConfig: kc,
          timeout: 180_000,
        }
      );
      await factory.deploy({ name: 'ns-del-adopt-instance', namespace: adoptedNs });

      // The adopted namespace carries typekro's marker but NOT the ownership record.
      const afterDeploy = await readNamespace(objectApi, adoptedNs);
      expect(afterDeploy?.metadata?.annotations?.[OWNER_ANNOTATION]).toBeUndefined();

      // Teardown drains the instance (CR → 404 → RGD → 404) then RETAINS the adopted
      // namespace — it is not an ownership candidate. The generated CRD stays Active.
      await factory.deleteInstance('ns-del-adopt-instance');

      const retained = await readNamespace(objectApi, adoptedNs);
      expect(retained).toBeDefined();
      expect(retained?.metadata?.deletionTimestamp).toBeUndefined();
    });

    it('v7 #2: two instances SHARING a namespace — deleting one PRESERVES the shared ns; deleting the LAST cleans it', async () => {
      // Two instances of ONE shared RGD both hoist the SAME workload namespace `sharedNs`;
      // their CRs live in a SEPARATE control namespace, so at A's deletion `sharedNs` is EMPTY
      // + OWNED — the empty-gate ALONE would delete it. The v7 exclusion (finding #2) must
      // PRESERVE it because remaining instance B still records it, then clean it when B (the
      // last instance) is deleted.
      const kind = `NsShared${runToken}`;
      const factory = ownsNamespace(`ns-del-shared-${runToken}`, kind).factory('kro', {
        namespace: sharedControlNs,
        instanceNamespace: sharedControlNs, // both CRs live here, NOT in the shared workload ns
        kubeConfig: kc,
        timeout: 300_000,
      });
      await factory.deploy({ name: 'shared-a', namespace: sharedNs });
      await captureOwnedNamespace(sharedNs);
      await captureOwnedNamespace(sharedControlNs);
      await factory.deploy({ name: 'shared-b', namespace: sharedNs });
      expect(await readNamespace(objectApi, sharedNs)).toBeDefined();

      // Delete A (NON-last). `sharedNs` is empty + owned, but remaining instance B records it →
      // it is EXCLUDED from A's deletable set and PRESERVED (not even empty-deleted).
      await factory.deleteInstance('shared-a');
      const afterA = await readNamespace(objectApi, sharedNs);
      expect(afterA).toBeDefined();
      expect(afterA?.metadata?.deletionTimestamp).toBeUndefined();

      // Delete B (the LAST instance). Nothing records `sharedNs` now → it is cleaned.
      await factory.deleteInstance('shared-b');
      const nsDeadline = Date.now() + 120_000;
      let own = await readNamespace(objectApi, sharedNs);
      while (own !== undefined && Date.now() < nsDeadline) {
        await new Promise((r) => setTimeout(r, 3000));
        own = await readNamespace(objectApi, sharedNs);
      }
      expect(own).toBeUndefined(); // the shared namespace is deleted once the last instance is gone
    });

    it('RETRY-SAFE: with the CR already gone, cleans the owned namespace before removing the RGD and retains the CRD', async () => {
      const group = `d${runToken}.typekro.dev`;
      const kind = `NsDelRetry${runToken}`;
      const factory = ownsNamespace(`ns-del-retry-${runToken}`, kind).factory('kro', {
        namespace: retryNs,
        kubeConfig: kc,
        timeout: 300_000,
      });
      await factory.deploy({ name: 'ns-del-retry-instance', namespace: retryNs });
      await captureOwnedNamespace(retryNs);

      // The owned namespace carries the DURABLE `created-by-rgd` ownership record (the record
      // that survives the CR — unlike the CR's `hoisted-namespaces` annotation).
      const owned = await readNamespace(objectApi, retryNs);
      expect(owned).toBeDefined();
      expect(owned?.metadata?.annotations?.[OWNER_ANNOTATION]).toBeDefined();
      expect(await findGeneratedCrdName(objectApi, group, kind)).toBeDefined();

      // Simulate a CRASHED earlier teardown: delete the instance CR OUT-OF-BAND and wait for
      // its 404, so the CR (and its `hoisted-namespaces` record) is GONE before we retry.
      await objectApi
        .delete({
          apiVersion,
          kind,
          metadata: { name: 'ns-del-retry-instance', namespace: retryNs },
        } as k8s.KubernetesObject)
        .catch((error) => {
          if (!isNotFoundError(error)) throw error;
        });
      const crDeadline = Date.now() + 120_000;
      // Poll the CR to a real 404 (KRO clears kro.run/finalizer — the hoisted namespace is
      // NOT a graph child, so KRO never touches it).
      while (Date.now() < crDeadline) {
        try {
          await objectApi.read({
            apiVersion,
            kind,
            metadata: { name: 'ns-del-retry-instance', namespace: retryNs },
          });
          await new Promise((r) => setTimeout(r, 3000));
        } catch {
          break; // CR is gone
        }
      }

      // RETRY the teardown with the CR already absent. The sweep must find the owned
      // namespace via the durable `created-by-rgd` annotation (NOT the vanished CR record),
      // clean it, and only THEN remove the RGD. The generated CRD remains Active.
      await factory.deleteInstance('ns-del-retry-instance');

      // The owned namespace was still found + cleaned → drains to 404 (no leak).
      const nsDeadline = Date.now() + 120_000;
      let own = await readNamespace(objectApi, retryNs);
      while (own !== undefined && Date.now() < nsDeadline) {
        await new Promise((r) => setTimeout(r, 3000));
        own = await readNamespace(objectApi, retryNs);
      }
      expect(own).toBeUndefined();

      // The generated CRD remains Active and reusable after retry-safe teardown.
      const crdName = await findGeneratedCrdName(objectApi, group, kind);
      expect(crdName).toBeDefined();
      if (!crdName) throw new Error(`Generated CRD for ${group}/${kind} was not retained.`);
      const crd = await objectApi.read({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: crdName },
      });
      expect(crd.metadata?.deletionTimestamp).toBeUndefined();
    });
  }
);
