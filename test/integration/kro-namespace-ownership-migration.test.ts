/**
 * Live upgrade test — finding #1 (PR #113 round 4).
 *
 * Proves the ownership-transfer MIGRATION: upgrading a deployment whose workload
 * Namespace is a live KRO ApplySet member (as a pre-hoist version of the graph
 * left it) to the hoisted graph must NOT let KRO prune that Namespace. The
 * Namespace must survive the upgrade with the SAME UID (not Terminating, not
 * recreated) and must no longer carry `applyset.kubernetes.io/part-of`, while the
 * instance CR stays healthy.
 *
 * Gated exactly like the other integration tests (`isClusterAvailable()` +
 * `describe.skip`); it runs via `./scripts/run-integration-tests.sh` against a
 * real cluster (Flux + KRO + cert-manager + CNPG — see shared-bootstrap.ts).
 *
 * Reproduction strategy (no hand-built pre-hoist RGD needed): deploy the current
 * (hoisting) factory once to establish the RGD/CRD/instance and the workload
 * Namespace, then STAMP the exact KRO ApplySet ownership labels onto the live
 * Namespace to recreate the pre-hoist "KRO owns this Namespace" state that makes
 * the prune dangerous. The second deploy (the upgrade) must run the migration —
 * suspend the instance, strip KRO's ownership labels, re-apply the retained
 * Namespace, resume — leaving the Namespace intact.
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
  createCustomObjectsApiClient,
  createKubernetesObjectApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from './shared-kubeconfig';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

const APPLYSET_PART_OF_LABEL = 'applyset.kubernetes.io/part-of';

const MigrationSpec = type({ name: 'string', namespace: 'string' });
const MigrationStatus = type({ ready: 'boolean' });

const ownsNamespaceComposition = kubernetesComposition(
  {
    name: 'ns-migration',
    apiVersion: 'test.typekro.dev/v1alpha1',
    kind: 'NsMigration',
    spec: MigrationSpec,
    status: MigrationStatus,
  },
  (spec) => {
    // The composition OWNS the Namespace the instance lands in (the self-owned
    // pattern). A ConfigMap child keeps the RGD non-trivial and lands in the same
    // workload namespace.
    namespaceResource({
      id: 'ownedNamespace',
      metadata: { name: Cel.expr(spec.namespace) as string },
    });
    configMap({
      id: 'marker',
      metadata: {
        name: 'migration-marker',
        namespace: Cel.expr(spec.namespace) as string,
      },
      data: { ok: 'true' },
    });
    return { ready: true };
  }
);

describeOrSkip('KRO namespace ownership-transfer migration (finding #1)', () => {
  let kc: k8s.KubeConfig;
  let coreApi: k8s.CoreV1Api;
  let objectApi: k8s.KubernetesObjectApi;
  let customApi: k8s.CustomObjectsApi;

  const workloadNamespace = `typekro-ns-migration-${Date.now().toString().slice(-6)}`;
  const instanceName = 'ns-migration-instance';

  beforeAll(() => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kc);
    objectApi = createKubernetesObjectApiClient(kc);
    customApi = createCustomObjectsApiClient(kc);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    try {
      const factory = ownsNamespaceComposition.factory('kro', {
        namespace: workloadNamespace,
        kubeConfig: kc,
      });
      await factory.deleteInstance(instanceName).catch(() => {});
    } catch {
      /* best effort */
    }
    await deleteNamespaceAndWait(workloadNamespace, kc).catch(() => {});
    try {
      await customApi.deleteClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name: 'ns-migration',
      });
    } catch {
      /* best effort */
    }
  });

  it('upgrades without pruning the live workload Namespace', async () => {
    const factory = ownsNamespaceComposition.factory('kro', {
      namespace: workloadNamespace,
      kubeConfig: kc,
      timeout: 300000,
    });
    const spec = { name: instanceName, namespace: workloadNamespace };

    // 1. Initial deploy establishes the RGD/CRD, instance, and workload Namespace.
    await factory.deploy(spec);

    const before = await coreApi.readNamespace({ name: workloadNamespace });
    const originalUid = before.metadata?.uid;
    expect(originalUid).toBeDefined();

    // 2. Recreate the PRE-HOIST state: stamp KRO's ApplySet ownership labels onto
    //    the live Namespace so it looks like a Namespace a pre-hoist graph owned.
    //    This is exactly what would make KRO's next reconcile prune it.
    await objectApi.patch(
      {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: workloadNamespace,
          labels: {
            [APPLYSET_PART_OF_LABEL]: 'applyset-ns-migration',
            'kro.run/owned': 'true',
            'kro.run/instance-id': 'legacy-instance-uid',
            'app.kubernetes.io/managed-by': 'kro',
          },
        },
      } as unknown as k8s.KubernetesObject,
      undefined,
      undefined,
      undefined,
      undefined,
      'application/merge-patch+json'
    );

    const stamped = await coreApi.readNamespace({ name: workloadNamespace });
    expect(stamped.metadata?.labels?.[APPLYSET_PART_OF_LABEL]).toBe('applyset-ns-migration');

    // 3. Upgrade via the normal deploy path — this must run the ownership-transfer
    //    migration (suspend instance → strip KRO ownership → re-apply retained
    //    Namespace → resume) BEFORE KRO can prune the Namespace.
    await factory.deploy(spec);

    // 4. The Namespace survived the upgrade: SAME UID (not recreated), not
    //    Terminating, and no longer a KRO ApplySet member.
    const after = await coreApi.readNamespace({ name: workloadNamespace });
    expect(after.metadata?.uid).toBe(originalUid as string);
    expect(after.metadata?.deletionTimestamp).toBeUndefined();
    expect(after.metadata?.labels?.[APPLYSET_PART_OF_LABEL]).toBeUndefined();
    expect(after.metadata?.labels?.['kro.run/owned']).toBeUndefined();
    // Retention markers were stamped during the transfer.
    expect(after.metadata?.labels?.['typekro.io/kro-instance-namespace']).toBe('true');

    // 5. The instance CR is still present and reconciling in its namespace.
    const instance = (await customApi.getNamespacedCustomObject({
      group: 'test.typekro.dev',
      version: 'v1alpha1',
      namespace: workloadNamespace,
      plural: 'nsmigrations',
      name: instanceName,
    })) as { metadata?: { name?: string }; status?: { state?: string } };
    expect(instance.metadata?.name).toBe(instanceName);
  }, 600000);
});
