/**
 * Live upgrade + DELETION test — findings #1 + #4 + #9 (PR #113).
 *
 * The guard this PR adds exists to prevent a finalizer-stranding DEADLOCK on DELETE:
 * when a composition's own workload Namespace is a KRO ApplySet member AND holds the
 * instance CR (which carries `kro.run/finalizer`), deleting or pruning that Namespace
 * puts it into Terminating while the CR's finalizer can never clear (the Namespace it
 * lives in is going away) — a deadlock. This test proves BOTH halves end-to-end on a
 * real cluster:
 *
 *  (A) UPGRADE survival — a deployment whose workload Namespace is a GENUINE KRO
 *      ApplySet member (a real PRE-HOIST graph KRO created: Namespace IN the RGD, so
 *      KRO records the Namespace group-kind in the parent's remembered prune scope AND
 *      stamps a REAL `applyset.kubernetes.io/part-of` on it) must, when upgraded to
 *      the hoisted graph, NOT let KRO prune the Namespace: it survives with the SAME
 *      UID (not Terminating, not recreated) and loses its `part-of` membership.
 *
 *  (B) DELETION safety — the ACTUAL original defect. Deleting the instance CR must
 *      clear `kro.run/finalizer` within a BOUNDED time while the retained workload
 *      Namespace stays ACTIVE (never Terminating). `deleteInstance()` deletes the CR,
 *      WAITS for the finalizer to clear, then tears down the RGD/CRD — it must never
 *      delete the retained Namespace, and the Namespace must NOT be deleted by the
 *      test's own cleanup until the CR's finalizer has cleared (deleting it earlier is
 *      exactly what re-creates the deadlock). If the delete deadlocks, `deleteInstance`
 *      rejects with a bounded CRDInstanceError timeout and this test FAILS loudly.
 *
 * ✅ EXECUTED on a local OrbStack cluster via an isolated kubeconfig (KRO/Flux/
 * cert-manager/CNPG pre-installed). It is GATED like the other integration tests
 * (`isClusterAvailable()` + `describe.skip`). It must NEVER be run against a
 * production cluster.
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
 *  4. Assert the Namespace survived with the SAME UID and no longer carries `part-of`,
 *     and the instance CR is present (phase A).
 *  5. DELETE the instance via `factory.deleteInstance()`; assert the CR disappears
 *     (finalizer clears) within a bounded timeout WHILE the retained Namespace stays
 *     Active with the SAME UID; then strict-clean the retained Namespace + RGD/CRD and
 *     assert they are gone (phase B).
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
const KRO_FINALIZER = 'kro.run/finalizer';
const RGD_GROUP = 'kro.run';
const RGD_VERSION = 'v1alpha1';
const RGD_PLURAL = 'resourcegraphdefinitions';

const MigrationSpec = type({ name: 'string', namespace: 'string' });
const MigrationStatus = type({ ready: 'boolean' });

/**
 * Finding #6 — PARALLEL SAFETY. The workload Namespace was already randomized, but
 * the CLUSTER-SCOPED API identity (RGD name, kind, group → generated CRD name) was
 * FIXED, so two concurrent runs shared one RGD/CRD and pruned/deleted each other's
 * resources. Randomize the COMPLETE identity with a single per-run token so every
 * run is fully isolated.
 */
const runToken = Math.random().toString(36).slice(2, 8); // lowercase alphanumeric
const RGD_NAME = `ns-migration-${runToken}`;
const INSTANCE_KIND = `NsMigration${runToken}`;
const INSTANCE_GROUP = `t${runToken}.typekro.dev`;
const INSTANCE_API_VERSION = `${INSTANCE_GROUP}/v1alpha1`;
const INSTANCE_PLURAL = `${INSTANCE_KIND.toLowerCase()}s`;
const GENERATED_CRD_NAME = `${INSTANCE_PLURAL}.${INSTANCE_GROUP}`;

const ownsNamespaceComposition = kubernetesComposition(
  {
    name: RGD_NAME,
    apiVersion: INSTANCE_API_VERSION,
    kind: INSTANCE_KIND,
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

describeOrSkip('KRO namespace ownership-transfer migration + finalizer-safe deletion (findings #1 + #4 + #9)', () => {
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
        name: RGD_NAME,
      });
    } catch {
      /* best effort */
    }
    // Sweep the generated CRD too so a failed run leaves nothing cluster-scoped behind.
    try {
      await objectApi.delete({
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: GENERATED_CRD_NAME },
      } as k8s.KubernetesObject);
    } catch {
      /* best effort */
    }
  });

  it('upgrades a GENUINE pre-hoist graph AND deletes it without stranding the workload Namespace finalizer', async () => {
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
    const instanceApiVersion = INSTANCE_API_VERSION;
    const instancePlural = INSTANCE_PLURAL;
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
          group: INSTANCE_GROUP,
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
        kind: INSTANCE_KIND,
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

    // 5. The instance CR is still present in its namespace AND carries the KRO
    //    finalizer (finding #8): asserting the finalizer EXISTS is what makes the
    //    deletion phase below a GENUINE test of finalizer-safe deletion rather than a
    //    no-op — if KRO hadn't stamped `kro.run/finalizer`, delete could never
    //    deadlock and the test would prove nothing.
    const instance = (await customApi.getNamespacedCustomObject({
      group: INSTANCE_GROUP,
      version: RGD_VERSION,
      namespace: workloadNamespace,
      plural: instancePlural,
      name: instanceName,
    })) as { metadata?: { name?: string; finalizers?: string[] } };
    expect(instance.metadata?.name).toBe(instanceName);
    expect(instance.metadata?.finalizers ?? []).toContain(KRO_FINALIZER);

    // ────────────────────────────────────────────────────────────────────────
    // PHASE B — finalizer-SAFE DELETION (finding #4): the ACTUAL original defect.
    // Migration survival (above) only proves the Namespace survives an UPGRADE. The
    // whole reason this guard exists is a DELETE-time finalizer deadlock, which must
    // be an ASSERTED step, not swallowed cleanup.
    // ────────────────────────────────────────────────────────────────────────

    // Bound the delete so a finalizer deadlock surfaces as a timeout error (a bounded
    // CRDInstanceError rejection) instead of hanging — rather than the pre-fix hang.
    const deletionFactory = ownsNamespaceComposition.factory('kro', {
      namespace: workloadNamespace,
      kubeConfig: kc,
      timeout: 120000,
    });

    // 6. Delete the instance. deleteInstance() deletes the CR, WAITS for KRO to clear
    //    kro.run/finalizer, THEN tears down the shared RGD/CRD. It must NOT touch the
    //    retained Namespace, and the finalizer MUST clear (no deadlock) — so this
    //    resolves. If deletion deadlocked, it would reject with a bounded timeout.
    await deletionFactory.deleteInstance(instanceName);

    // 7. The CR is actually GONE (finalizer cleared, not stuck Terminating).
    await waitFor(
      async () => {
        try {
          await customApi.getNamespacedCustomObject({
            group: INSTANCE_GROUP,
            version: RGD_VERSION,
            namespace: workloadNamespace,
            plural: instancePlural,
            name: instanceName,
          });
          return false; // still present
        } catch (e: unknown) {
          const code =
            (e as { statusCode?: number; code?: number; body?: { code?: number } })?.statusCode ??
            (e as { code?: number })?.code ??
            (e as { body?: { code?: number } })?.body?.code;
          return code === 404;
        }
      },
      60000,
      'the instance CR to disappear (finalizer cleared, no deadlock)'
    );

    // 8. The retained workload Namespace SURVIVED the CR deletion: SAME UID, still
    //    Active (no deletionTimestamp) — the finalizer deadlock is gone.
    const afterDelete = await coreApi.readNamespace({ name: workloadNamespace });
    expect(afterDelete.metadata?.uid).toBe(originalUid as string);
    expect(afterDelete.metadata?.deletionTimestamp).toBeUndefined();
    expect(afterDelete.status?.phase).toBe('Active');

    // 9. STRICT CLEANUP — only NOW (the CR + its finalizer are gone) is it safe to
    //    delete the retained Namespace. Deleting it while the CR's finalizer was still
    //    processing is exactly what re-creates the deadlock, so ordering matters.
    await deleteNamespaceAndWait(workloadNamespace, kc, 120000);

    // Namespace is gone.
    await waitFor(
      async () => {
        try {
          await coreApi.readNamespace({ name: workloadNamespace });
          return false;
        } catch (e: unknown) {
          const code =
            (e as { statusCode?: number; code?: number; body?: { code?: number } })?.statusCode ??
            (e as { code?: number })?.code ??
            (e as { body?: { code?: number } })?.body?.code;
          return code === 404;
        }
      },
      120000,
      'the retained Namespace to be fully deleted'
    );

    // The RGD was torn down by deleteInstance() (no remaining instances share it).
    await waitFor(
      async () => {
        try {
          await customApi.getClusterCustomObject({
            group: RGD_GROUP,
            version: RGD_VERSION,
            plural: RGD_PLURAL,
            name: RGD_NAME,
          });
          return false;
        } catch (e: unknown) {
          const code =
            (e as { statusCode?: number; code?: number; body?: { code?: number } })?.statusCode ??
            (e as { code?: number })?.code ??
            (e as { body?: { code?: number } })?.body?.code;
          return code === 404;
        }
      },
      60000,
      'the shared RGD to be deleted by deleteInstance()'
    );

    // The GENERATED CRD is fully gone too (finding #8): a prior run left
    // `nsmigrations.test.typekro.dev` Terminating for ~200s because the test ended
    // before the CRD finished deleting. WAIT for it (bounded) so nothing cluster-
    // scoped is left terminating when the test returns.
    await waitFor(
      async () => {
        try {
          await objectApi.read({
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            metadata: { name: GENERATED_CRD_NAME },
          });
          return false;
        } catch (e: unknown) {
          const code =
            (e as { statusCode?: number; code?: number; body?: { code?: number } })?.statusCode ??
            (e as { code?: number })?.code ??
            (e as { body?: { code?: number } })?.body?.code;
          return code === 404;
        }
      },
      240000,
      'the generated CRD to be fully deleted (nothing left Terminating)'
    );
  }, 900000);
});
