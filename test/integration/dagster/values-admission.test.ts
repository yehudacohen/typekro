/**
 * LIVE KRO ADMISSION coverage for schemaless (`object`) schema fields.
 *
 * Why this exists: the offline tests asserted that CEL strings like `schema.spec.postgresql.values` appeared
 * in the generated YAML. That is a weaker claim than it looks. A field can be referenced by CEL and still be
 * DECLARED `string` in the RGD schema — in which case admission drops whatever object a caller sent, the CEL
 * resolves to nothing, and every offline test still passes. That is precisely how the Dagster escape hatches
 * stayed broken, and it stayed invisible because nothing ever read a CR back from a cluster.
 *
 * The defect also surfaces differently per client, which is worth knowing: `kubectl apply` is STRICT-decoding
 * and errors loudly (`strict decoding error: unknown field ...`), while TypeKro's own apply path is not
 * strict, so in production the identical mismatch was PRUNED IN SILENCE and the converge reported success.
 *
 * SAFETY — this test deliberately never creates a Dagster INSTANCE. Applying the Dagster RGD only registers a
 * CRD; creating a `DagsterBootstrap` CR would make KRO reconcile real HelmReleases, which is not something an
 * admission test should do to a persistent cluster. So the two concerns are split:
 *   1. Dagster: apply the RGD, read the REGISTERED CRD, assert the escape hatches are schemaless. No CRs.
 *   2. Round-trip: a MINIMAL probe graph whose only resource is a ConfigMap, so a CR is harmless.
 * Namespaces come from the shared harness (UID lease) and every created object is tracked and torn down with
 * aggregated errors rather than swallowed ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { ConfigMap } from '../../../src/factories/simple/index.js';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { dagsterBootstrap } from '../../../src/factories/dagster/index.js';
import { createBunCompatibleApiClient } from '../../../src/core/kubernetes/bun-api-client.js';
import {
  createCustomObjectsApiClient,
  createTestNamespace,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

setDefaultTimeout(300000);

const clusterAvailable = await isClusterAvailable();
const describeLiveOrSkip = clusterAvailable ? describe : describe.skip;

const RGD_GROUP = 'kro.run';
const RGD_VERSION = 'v1alpha1';
const RGD_PLURAL = 'resourcegraphdefinitions';
const PROBE_KIND = 'ObjectSchemaProbe';
const PROBE_RGD = 'object-schema-probe';

/**
 * The structure a caller sends and admission must NOT strip: nested maps, a boolean, a number, an array of
 * objects, and a dotted key — everything the old `string` typing destroyed.
 */
const PROBE_VALUES = {
  postgresql: {
    primary: { persistence: { enabled: false }, nodeSelector: { 'kubernetes.io/os': 'linux' } },
    persistence: { enabled: false },
  },
  extraObjects: [{ kind: 'ConfigMap', metadata: { name: 'probe' } }],
  someNumber: 42,
  someBool: true,
};

/** Minimal graph: one schemaless `values` field, one harmless ConfigMap. No Dagster, no Helm. */
const probeComposition = kubernetesComposition(
  {
    name: PROBE_RGD,
    kind: PROBE_KIND,
    spec: type({ name: 'string', appNamespace: 'string', 'values?': 'object' }),
    status: type({ ready: 'boolean' }),
  },
  (spec) => {
    ConfigMap({
      name: `${spec.name}-probe`,
      namespace: spec.appNamespace,
      data: { role: 'probe' },
      id: 'probeCfg',
    });
    return { ready: true };
  }
);

describeLiveOrSkip('schemaless object fields survive KRO admission', () => {
  const kc = getIntegrationTestKubeConfig();
  // Bun-compatible clients: a plain `kc.makeApiClient` fails TLS against a self-signed cluster CA under Bun
  // (oven-sh/bun#10642), which is exactly what the harness factories exist to paper over.
  const custom = createCustomObjectsApiClient(kc);
  const apiext = createBunCompatibleApiClient(kc, k8s.ApiextensionsV1Api);
  let lease: TestNamespaceLease | undefined;
  /** Every object this test creates, newest first, so teardown is deterministic. */
  const created: Array<{
    what: string;
    remove: () => Promise<unknown>;
    /** Present for custom resources: polled until the object is really gone (finalizers settled). */
    gone?: () => Promise<boolean>;
  }> = [];

  /** Poll until an RGD is really gone (KRO finalizers settled). Bounded so a stuck delete fails loudly. */
  const waitForRgdAbsent = async (name: string): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      const gone = await custom
        .getClusterCustomObject({ group: RGD_GROUP, version: RGD_VERSION, plural: RGD_PLURAL, name })
        .then(() => false)
        .catch(() => true);
      if (gone) return true;
      await Bun.sleep(1000);
    }
    return false;
  };

  /**
   * Apply the RGDs in a rendered bundle.
   *
   * `ownership` decides what may happen to an RGD that ALREADY EXISTS, and it is a safety boundary, not a
   * style choice:
   *
   * - `'test-owned'` — the name is unique to this test (see PROBE_RGD). A leftover from an earlier run
   *   carries an OLD schema, so reusing it would silently assert against the wrong definition; delete and
   *   recreate, and register it for teardown.
   * - `'shared'` — the name is PRODUCTION-shaped (`dagster-bootstrap` and its HelmRepository singleton). On a
   *   persistent cluster these definitions serve real Dagster instances, so this test must never delete
   *   them: it UPDATES in place (which is all the assertions need — KRO re-registers the CRD from the new
   *   schema) and never registers them for teardown. Deleting them previously took out the shared
   *   HelmRepository singleton, breaking every Dagster release pointing at it.
   */
  const applyRgd = async (yamlDoc: string, ownership: 'test-owned' | 'shared'): Promise<void> => {
    for (const doc of k8s.loadAllYaml(yamlDoc)) {
      const body = doc as { kind?: string; metadata?: { name?: string } };
      if (body.kind !== 'ResourceGraphDefinition') continue;
      const name = body.metadata?.name;
      if (!name) continue;

      const existing = await custom
        .getClusterCustomObject({ group: RGD_GROUP, version: RGD_VERSION, plural: RGD_PLURAL, name })
        .then((o) => o as { metadata?: { resourceVersion?: string } })
        .catch(() => undefined);

      if (existing && ownership === 'shared') {
        // Update in place — never delete somebody else's definition. `resourceVersion` makes this a
        // compare-and-swap, so a concurrent writer surfaces as a conflict instead of being clobbered.
        await custom.replaceClusterCustomObject({
          group: RGD_GROUP,
          version: RGD_VERSION,
          plural: RGD_PLURAL,
          name,
          body: {
            ...(body as object),
            metadata: {
              ...(body.metadata ?? {}),
              resourceVersion: existing.metadata?.resourceVersion,
            },
          } as object,
        });
        continue; // deliberately NOT registered for teardown: this run did not create it
      }

      if (existing) {
        // test-owned leftover: its schema is stale and KRO refuses breaking CRD type changes on update,
        // so delete and recreate to exercise the CURRENT schema.
        await custom.deleteClusterCustomObject({
          group: RGD_GROUP,
          version: RGD_VERSION,
          plural: RGD_PLURAL,
          name,
        });
        await waitForRgdAbsent(name);
      }

      await custom.createClusterCustomObject({
        group: RGD_GROUP,
        version: RGD_VERSION,
        plural: RGD_PLURAL,
        body: body as object,
      });
      created.push({
        what: `rgd/${name}`,
        remove: () =>
          custom.deleteClusterCustomObject({
            group: RGD_GROUP,
            version: RGD_VERSION,
            plural: RGD_PLURAL,
            name,
          }),
      });
    }
  };

  /** `spec.schema.openAPIV3Schema.properties.spec.properties` of a registered CRD, if it exists yet. */
  const crdSpecProps = async (plural: string): Promise<Record<string, any> | undefined> =>
    apiext
      .readCustomResourceDefinition({ name: `${plural}.${RGD_GROUP}` })
      .then((crd) => {
        const established = crd.status?.conditions?.some(
          (c) => c.type === 'Established' && c.status === 'True'
        );
        if (!established) return undefined;
        return crd.spec.versions[0]?.schema?.openAPIV3Schema?.properties?.spec?.properties as
          | Record<string, any>
          | undefined;
      })
      .catch(() => undefined);

  /**
   * Wait until the CRD for `plural` is Established AND its `spec.values` has converged to `object`.
   *
   * KRO registers and updates CRDs ASYNCHRONOUSLY after accepting an RGD, so waiting on Established alone
   * returns instantly against a CRD left by an earlier run and the assertions then read a stale schema. Note
   * this cannot wait on a new uid or a bumped resourceVersion either: KRO updates the CRD IN PLACE, and when
   * the schema is already correct it performs no write at all — both signals would hang.
   *
   * Waiting on one field is not the same as asserting the contract: the tests below check the
   * preserve-unknown flags, the per-subchart hatch, the typed siblings, and a real CR round trip.
   */
  const waitForConvergedCrd = async (plural: string): Promise<Record<string, any>> => {
    for (let i = 0; i < 180; i++) {
      const props = await crdSpecProps(plural);
      if (props?.values?.type === 'object') return props;
      await Bun.sleep(1000);
    }
    throw new Error(`CRD ${plural}.${RGD_GROUP} never converged to a schemaless \`values\``);
  };

  beforeAll(async () => {
    lease = await createTestNamespace(`typekro-obj-admission-${Math.random().toString(36).slice(2, 8)}`, kc);
    await applyRgd(probeComposition.factory('kro').toYaml(), 'test-owned');
    // Apply WITH the migration flag: a `dagsterbootstraps` CRD left by an older TypeKro carries `string`
    // types, and KRO refuses the breaking update SILENTLY (RGD still reports Ready). Without authorizing it
    // the assertions below would read a stale schema and fail for the wrong reason.
    await applyRgd(dagsterBootstrap.factory('kro', { allowBreakingChanges: true }).toYaml(), 'shared');
    await waitForConvergedCrd('objectschemaprobes');
    await waitForConvergedCrd('dagsterbootstraps');
  });

  afterAll(async () => {
    // ORDER MATTERS, and getting it wrong hangs for the full timeout. Custom resources must be gone —
    // finalizers settled — BEFORE their CRD is removed; deleting the CRD first strands the finalizer and the
    // namespace can then never terminate. So: CRs (and wait), then the namespace, then the RGDs, then the CRD
    // this test owns. Failures are aggregated rather than swallowed.
    const failures: string[] = [];

    for (const { what, remove, gone } of created.filter((c) => c.gone).reverse()) {
      await remove().catch((e: unknown) => failures.push(`${what}: ${String(e)}`));
      let settled = false;
      for (let i = 0; i < 60 && !settled; i++) {
        settled = await gone!();
        if (!settled) await Bun.sleep(1000);
      }
      if (!settled) failures.push(`${what}: still present after delete (finalizer pending?)`);
    }

    if (lease) {
      await deleteTestNamespaceAndWait(lease, kc).catch((e: unknown) =>
        failures.push(`namespace ${lease?.name}: ${String(e)}`)
      );
    }

    for (const { what, remove } of created.filter((c) => !c.gone).reverse()) {
      await remove().catch((e: unknown) => failures.push(`${what}: ${String(e)}`));
    }

    // The RGD must be GONE before its CRD is removed. Deleting the CRD while KRO can still observe the RGD
    // lets KRO re-register the CRD, leaving the very object this teardown just removed — the same race the
    // migration fixture documents. So: wait out the RGD, then delete the CRD, then confirm it stayed gone.
    for (const { what } of created.filter((c) => !c.gone && c.what.startsWith('rgd/'))) {
      const name = what.slice('rgd/'.length);
      if (!(await waitForRgdAbsent(name))) failures.push(`${what}: still present after delete`);
    }

    // Deleting an RGD does NOT reap the CRD KRO registered for it, so remove it explicitly or every run
    // leaves one behind. Only the PROBE kind — deliberately not dagsterbootstraps, which on a persistent
    // cluster may hold real instances this test knows nothing about and only updated.
    await apiext
      .deleteCustomResourceDefinition({ name: `objectschemaprobes.${RGD_GROUP}` })
      .catch((e: unknown) => failures.push(`crd/objectschemaprobes.${RGD_GROUP}: ${String(e)}`));

    let crdGone = false;
    for (let i = 0; i < 60 && !crdGone; i++) {
      crdGone = await apiext
        .readCustomResourceDefinition({ name: `objectschemaprobes.${RGD_GROUP}` })
        .then(() => false)
        .catch(() => true);
      if (!crdGone) await Bun.sleep(1000);
    }
    if (!crdGone) {
      failures.push(`crd/objectschemaprobes.${RGD_GROUP}: still present (KRO may have re-registered it)`);
    }

    if (failures.length > 0) throw new Error(`cleanup failed:\n${failures.join('\n')}`);
  });

  it('registers the Dagster escape hatches as schemaless `object` in the CRD (no instances created)', async () => {
    const props = await waitForConvergedCrd('dagsterbootstraps');

    for (const path of [props.values, props.postgresql.properties.values]) {
      expect(path.type).toBe('object');
      // The generated client deserializes the wire field `x-kubernetes-preserve-unknown-fields` to
      // `x_kubernetes_preserve_unknown_fields`; accept either so this does not break on a client bump.
      const preserveUnknown =
        path.x_kubernetes_preserve_unknown_fields ?? path['x-kubernetes-preserve-unknown-fields'];
      expect(preserveUnknown).toBe(true);
    }
    // The typed convenience fields alongside them must stay typed, or the CRD documents nothing.
    expect(props.postgresql.properties.enabled.type).toBe('boolean');
    expect(props.name.type).toBe('string');
  });

  it('preserves nested unknown values through a real create/read round trip', async () => {
    const namespace = lease!.name;
    const name = 'probe-values';
    await custom.createNamespacedCustomObject({
      group: RGD_GROUP,
      version: RGD_VERSION,
      namespace,
      plural: 'objectschemaprobes',
      body: {
        apiVersion: `${RGD_GROUP}/${RGD_VERSION}`,
        kind: PROBE_KIND,
        metadata: { name, namespace },
        spec: { name, appNamespace: namespace, values: PROBE_VALUES },
      },
    });
    created.push({
      what: `${PROBE_KIND}/${name}`,
      remove: () =>
        custom.deleteNamespacedCustomObject({
          group: RGD_GROUP,
          version: RGD_VERSION,
          namespace,
          plural: 'objectschemaprobes',
          name,
        }),
      gone: () =>
        custom
          .getNamespacedCustomObject({
            group: RGD_GROUP,
            version: RGD_VERSION,
            namespace,
            plural: 'objectschemaprobes',
            name,
          })
          .then(() => false)
          .catch(() => true),
    });

    const admitted = (await custom.getNamespacedCustomObject({
      group: RGD_GROUP,
      version: RGD_VERSION,
      namespace,
      plural: 'objectschemaprobes',
      name,
    })) as { spec?: { values?: unknown } };

    // Before the core fix this field was declared `string`, so the whole subtree was dropped in silence.
    expect(admitted.spec?.values).toEqual(PROBE_VALUES);
  });
});
