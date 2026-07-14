/**
 * Live upgrade test — findings #1 + #9 (PR #113).
 *
 * Proves the ownership-transfer MIGRATION reproduces and survives the DANGEROUS
 * upgrade: a deployment whose workload Namespace is a GENUINE KRO ApplySet member
 * (a real PRE-HOIST graph that KRO created — Namespace IN the RGD, so KRO records
 * the Namespace group-kind in the parent's remembered prune scope AND stamps a REAL
 * `applyset.kubernetes.io/part-of` on the Namespace) must, when upgraded to the
 * hoisted graph, NOT let KRO prune that Namespace. It must survive with the SAME
 * UID (not Terminating, not recreated) and lose its `part-of` membership, while the
 * instance CR stays healthy.
 *
 * ⚠️ This test is GATED like the other integration tests (`isClusterAvailable()` +
 * `describe.skip`) and is intended to run via `./scripts/run-integration-tests.sh`
 * against a real cluster (Flux + KRO + cert-manager + CNPG — see shared-bootstrap).
 * It is WRITTEN but was NOT executed in this change set (the only reachable cluster
 * here is a live production cluster; running it there is forbidden).
 *
 * Reproduction strategy (finding #9 — a GENUINE pre-hoist graph, not an invented
 * ApplySet value):
 *  1. Take the factory's own (hoisted) RGD and RE-INSERT the owned Namespace as a
 *     graph child, yielding the exact PRE-HOIST RGD shape KRO would have managed
 *     before this fix — same RGD name/schema, Namespace back in `spec.resources`.
 *  2. Apply that pre-hoist RGD directly, PRE-CREATE the workload Namespace (so the
 *     self-owned instance CR can be POSTed — otherwise the CR needs the namespace and
 *     the namespace needs the CR: chicken-and-egg), then create the instance CR IN the
 *     workload namespace. Let KRO reconcile: it ADOPTS the pre-created Namespace as an
 *     ApplySet member (same UID) and stamps the REAL `part-of` (== the instance's
 *     ApplySet ID) + `kro.run/*` ownership labels. Capture the Namespace UID + part-of.
 *  3. Upgrade via the normal `factory.deploy()` path. This runs the migration:
 *     discover the live instance, verify the Namespace's ownership identity matches
 *     it (real part-of), suspend → strip → apply the hoisted RGD → resume.
 *  4. Assert the Namespace survived with the SAME UID and no longer carries
 *     `part-of`, and the instance CR is present.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import * as yaml from 'js-yaml';
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
const RGD_GROUP = 'kro.run';
const RGD_VERSION = 'v1alpha1';
const RGD_PLURAL = 'resourcegraphdefinitions';

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

/**
 * Reconstruct the GENUINE pre-hoist RGD from the factory's own hoisted RGD by
 * re-inserting the owned Namespace as a graph child (finding #9). This is the exact
 * RGD KRO would have managed before the hoist fix: same name + schema, Namespace
 * back in `spec.resources` so KRO owns it as an ApplySet member and stamps a real
 * `part-of` on it.
 */
function buildPreHoistRgdManifest(hoistedRgdYaml: string): Record<string, unknown> {
  const rgd = yaml.load(hoistedRgdYaml) as {
    spec?: { resources?: Record<string, unknown>[] };
  };
  const resources = rgd.spec?.resources ?? [];
  // Insert the owned Namespace FIRST (deps-first) as a graph child named after the
  // schema namespace — the pre-hoist shape.
  resources.unshift({
    id: 'ownedNamespace',
    template: {
      apiVersion: 'v1',
      kind: 'Namespace',
      // KRO RGD templates use ${schema.spec.*} CEL for schema-driven fields.
      metadata: { name: '${schema.spec.namespace}' },
    },
  });
  if (rgd.spec) rgd.spec.resources = resources;
  return rgd as Record<string, unknown>;
}

describeOrSkip('KRO namespace ownership-transfer migration (findings #1 + #9)', () => {
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
        group: RGD_GROUP,
        version: RGD_VERSION,
        plural: RGD_PLURAL,
        name: 'ns-migration',
      });
    } catch {
      /* best effort */
    }
  });

  it('upgrades a GENUINE pre-hoist graph without pruning the live workload Namespace', async () => {
    const factory = ownsNamespaceComposition.factory('kro', {
      namespace: workloadNamespace,
      kubeConfig: kc,
      timeout: 300000,
    });
    const spec = { name: instanceName, namespace: workloadNamespace };

    // 1. Build the GENUINE pre-hoist RGD (Namespace re-inserted as a graph child)
    //    and apply it directly, then create the instance CR in the workload ns.
    const preHoistRgd = buildPreHoistRgdManifest(factory.toYaml());
    await objectApi.patch(
      preHoistRgd as k8s.KubernetesObject,
      undefined,
      undefined,
      'typekro-test',
      true,
      'application/apply-patch+yaml'
    );

    // Wait for the CRD the RGD generates to be established before posting the CR.
    const instanceApiVersion = 'test.typekro.dev/v1alpha1';
    const instancePlural = 'nsmigrations';
    const waitFor = async (fn: () => Promise<boolean>, timeoutMs: number, label: string) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await fn().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    await waitFor(
      async () => {
        await customApi.listClusterCustomObject({
          group: 'test.typekro.dev',
          version: RGD_VERSION,
          plural: instancePlural,
        });
        return true;
      },
      120000,
      'NsMigration CRD to be established'
    );

    // 2a. Pre-create the workload Namespace so the instance CR (which lives IN that
    //     namespace — the self-owned pattern) can be POSTed at all. KRO cannot create
    //     the namespace until the CR exists, and the CR cannot be created until the
    //     namespace exists (chicken-and-egg). Pre-creating a bare Namespace breaks the
    //     cycle: KRO then ADOPTS it via server-side apply on the pre-hoist RGD's
    //     Namespace child, keeping the SAME UID and stamping the REAL `part-of` +
    //     `kro.run/*` ownership labels onto it — a genuine pre-hoist ApplySet member.
    await coreApi.createNamespace({ body: { metadata: { name: workloadNamespace } } });

    // 2b. Create the instance CR IN the workload namespace so KRO reconciles the
    //     pre-hoist RGD, ADOPTS the pre-created Namespace as a real ApplySet member,
    //     and stamps the real part-of + kro.run/* ownership labels on it.
    await objectApi.patch(
      {
        apiVersion: instanceApiVersion,
        kind: 'NsMigration',
        metadata: { name: instanceName, namespace: workloadNamespace },
        spec,
      } as unknown as k8s.KubernetesObject,
      undefined,
      undefined,
      'typekro-test',
      true,
      'application/apply-patch+yaml'
    );

    // Wait for KRO to create the Namespace AND stamp a REAL part-of on it.
    await waitFor(
      async () => {
        const ns = await coreApi.readNamespace({ name: workloadNamespace });
        return ns.metadata?.labels?.[APPLYSET_PART_OF_LABEL] !== undefined;
      },
      180000,
      'KRO to create + stamp the workload Namespace (genuine pre-hoist ownership)'
    );

    const before = await coreApi.readNamespace({ name: workloadNamespace });
    const originalUid = before.metadata?.uid;
    const realPartOf = before.metadata?.labels?.[APPLYSET_PART_OF_LABEL];
    expect(originalUid).toBeDefined();
    // A GENUINE KRO ApplySet id (KEP-3659), not an invented value.
    expect(realPartOf).toMatch(/^applyset-.*-v1$/);

    // 3. Upgrade via the normal deploy path — this runs the ownership-transfer
    //    migration (identity-checked against the REAL part-of): suspend → strip →
    //    apply hoisted RGD → resume, BEFORE KRO can prune the Namespace.
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

    // 5. The instance CR is still present in its namespace.
    const instance = (await customApi.getNamespacedCustomObject({
      group: 'test.typekro.dev',
      version: RGD_VERSION,
      namespace: workloadNamespace,
      plural: instancePlural,
      name: instanceName,
    })) as { metadata?: { name?: string } };
    expect(instance.metadata?.name).toBe(instanceName);
  }, 600000);
});
