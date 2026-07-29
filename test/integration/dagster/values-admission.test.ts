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
  const created: Array<{ what: string; remove: () => Promise<unknown> }> = [];

  const applyRgd = async (yamlDoc: string): Promise<void> => {
    for (const doc of k8s.loadAllYaml(yamlDoc)) {
      const body = doc as { kind?: string; metadata?: { name?: string } };
      if (body.kind !== 'ResourceGraphDefinition') continue;
      const name = body.metadata?.name;
      if (!name) continue;
      await custom
        .createClusterCustomObject({
          group: RGD_GROUP,
          version: RGD_VERSION,
          plural: RGD_PLURAL,
          body: body as object,
        })
        .catch(async (e: unknown) => {
          // A leftover RGD from an earlier run carries an OLD schema, so "reuse on AlreadyExists" would
          // silently assert against the wrong definition (and KRO refuses breaking CRD type changes on
          // update anyway). Delete and recreate so the test always exercises the CURRENT schema.
          if (!String(e).includes('AlreadyExists') && !String(e).includes('409')) throw e;
          await custom.deleteClusterCustomObject({
            group: RGD_GROUP,
            version: RGD_VERSION,
            plural: RGD_PLURAL,
            name,
          });
          for (let i = 0; i < 60; i++) {
            const gone = await custom
              .getClusterCustomObject({ group: RGD_GROUP, version: RGD_VERSION, plural: RGD_PLURAL, name })
              .then(() => false)
              .catch(() => true);
            if (gone) break;
            await Bun.sleep(1000);
          }
          await custom.createClusterCustomObject({
            group: RGD_GROUP,
            version: RGD_VERSION,
            plural: RGD_PLURAL,
            body: body as object,
          });
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

  /** Poll until the CRD for `plural` is Established — KRO registers it AFTER the RGD is accepted. */
  const waitForCrd = async (plural: string): Promise<k8s.V1CustomResourceDefinition> => {
    const name = `${plural}.${RGD_GROUP}`;
    for (let i = 0; i < 120; i++) {
      const crd = await apiext.readCustomResourceDefinition({ name }).catch(() => undefined);
      const established = crd?.status?.conditions?.some(
        (c) => c.type === 'Established' && c.status === 'True'
      );
      if (crd && established) return crd;
      await Bun.sleep(1000);
    }
    throw new Error(`CRD ${name} did not become Established`);
  };

  beforeAll(async () => {
    lease = await createTestNamespace(`typekro-obj-admission-${Math.random().toString(36).slice(2, 8)}`, kc);
    await applyRgd(probeComposition.factory('kro').toYaml());
    await applyRgd(dagsterBootstrap.toYaml());
    await waitForCrd('objectschemaprobes');
    await waitForCrd('dagsterbootstraps');
  });

  afterAll(async () => {
    // Aggregate rather than swallow: a teardown that hides its own failures is how clusters accumulate junk.
    const failures: string[] = [];
    for (const { what, remove } of created.reverse()) {
      await remove().catch((e: unknown) => failures.push(`${what}: ${String(e)}`));
    }
    if (lease) {
      await deleteTestNamespaceAndWait(lease, kc).catch((e: unknown) =>
        failures.push(`namespace ${lease?.name}: ${String(e)}`)
      );
    }
    if (failures.length > 0) throw new Error(`cleanup failed:\n${failures.join('\n')}`);
  });

  it('registers the Dagster escape hatches as schemaless `object` in the CRD (no instances created)', async () => {
    const crd = await apiext.readCustomResourceDefinition({ name: 'dagsterbootstraps.kro.run' });
    const props = crd.spec.versions[0]?.schema?.openAPIV3Schema?.properties?.spec
      ?.properties as Record<string, any>;

    for (const path of [props.values, props.postgresql.properties.values]) {
      expect(path.type).toBe('object');
      expect(path['x-kubernetes-preserve-unknown-fields']).toBe(true);
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
