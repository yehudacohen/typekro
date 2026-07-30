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
/**
 * RUN-UNIQUE identities. Nothing this fixture applies may share a name with a real deployment: a shared
 * cluster's `dagster-bootstrap` / `dagster-helm-repository` RGDs serve live Dagster instances, and rewriting
 * one migrates the CRD those instances depend on (this bundle carries `allow-breaking-changes`) and discards
 * labels/annotations owned by whatever system manages it. `resourceVersion` guards concurrent WRITES; it says
 * nothing about OWNERSHIP. So the live admission coverage runs against a uniquely-named probe copy of the
 * real generated bundle, and `applyRgd` fails closed if a name it is about to create already exists.
 */
const RUN_ID = Math.random().toString(36).slice(2, 8);
const PROBE_KIND = `ObjectSchemaProbe${RUN_ID}`;
const PROBE_RGD = `object-schema-probe-${RUN_ID}`;
/** KRO derives the CRD plural from the schema kind, lowercased. */
const pluralFor = (kind: string): string => `${kind.toLowerCase()}s`;

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
  /** CRD plurals KRO registers for this run's unique kinds; resolved in `beforeAll`. */
  let probePlural = '';
  let dagsterPlural = '';
  /** Every object this test creates, newest first, so teardown is deterministic. */
  const created: Array<{
    what: string;
    remove: () => Promise<unknown>;
    /** Present for custom resources: polled until the object is really gone (finalizers settled). */
    gone?: () => Promise<boolean>;
  }> = [];

  /** True only for a definitive 404. Any other error is NOT evidence of absence. */
  const isNotFound = (e: unknown): boolean => {
    const code = (e as { code?: number; statusCode?: number; response?: { statusCode?: number } })?.code
      ?? (e as { statusCode?: number })?.statusCode
      ?? (e as { response?: { statusCode?: number } })?.response?.statusCode;
    return code === 404 || /\b404\b|NotFound/.test(String(e));
  };

  /**
   * Poll until an RGD is definitively gone. Returns false on timeout so callers FAIL rather than proceed —
   * treating a transient API error as absence would let teardown delete the CRD while KRO can still see the
   * RGD, and KRO would then re-register the CRD after the test reported success.
   */
  const waitForRgdAbsent = async (name: string): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      const state = await custom
        .getClusterCustomObject({ group: RGD_GROUP, version: RGD_VERSION, plural: RGD_PLURAL, name })
        .then(() => 'present' as const)
        .catch((e: unknown) => (isNotFound(e) ? ('absent' as const) : ('unknown' as const)));
      if (state === 'absent') return true;
      await Bun.sleep(1000);
    }
    return false;
  };

  /** Same contract for a CRD: only a 404 proves absence, and a timeout is a failure. */
  const waitForCrdAbsent = async (name: string): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      const state = await apiext
        .readCustomResourceDefinition({ name })
        .then(() => 'present' as const)
        .catch((e: unknown) => (isNotFound(e) ? ('absent' as const) : ('unknown' as const)));
      if (state === 'absent') return true;
      await Bun.sleep(1000);
    }
    return false;
  };

  /**
   * Apply the RGDs in a rendered bundle under RUN-UNIQUE identities, and report the CRD plurals they will
   * register.
   *
   * Every `metadata.name` and `spec.schema.kind` is suffixed with {@link RUN_ID}, so this fixture can only
   * ever create objects belonging to this run. That is what makes the live coverage safe on a shared cluster:
   * the assertions still exercise the REAL generated schema (same `object` typings, same preserve-unknown
   * flags, same KRO admission path), just under a throwaway kind that no deployment depends on.
   *
   * It also FAILS CLOSED: if a name it is about to create already exists, it aborts instead of adopting or
   * overwriting. With a unique suffix that should be unreachable, so hitting it means an assumption broke —
   * which is exactly when silently rewriting somebody else's definition would do the most damage.
   */
  const applyRgd = async (yamlDoc: string): Promise<string[]> => {
    const plurals: string[] = [];
    for (const doc of k8s.loadAllYaml(yamlDoc)) {
      const body = doc as {
        kind?: string;
        metadata?: { name?: string };
        spec?: { schema?: { kind?: string } };
      };
      if (body.kind !== 'ResourceGraphDefinition') continue;
      const originalName = body.metadata?.name;
      const originalKind = body.spec?.schema?.kind;
      if (!originalName || !originalKind) continue;

      // Suffix BOTH identities: the RGD name (what we create) and the schema kind (what KRO derives the CRD
      // plural from). Leaving either shared would collide with a real deployment.
      //
      // Idempotent: the probe composition already declares run-unique identities (PROBE_RGD/PROBE_KIND, which
      // the CR assertions below also reference), so suffixing unconditionally double-suffixed the kind and the
      // API rejected the CR with `must be ObjectSchemaProbe<id><id>`.
      const name = originalName.endsWith(`-${RUN_ID}`) ? originalName : `${originalName}-${RUN_ID}`;
      const kind = originalKind.endsWith(RUN_ID) ? originalKind : `${originalKind}${RUN_ID}`;
      const unique = {
        ...body,
        metadata: { ...(body.metadata ?? {}), name },
        spec: { ...(body.spec ?? {}), schema: { ...(body.spec?.schema ?? {}), kind } },
      };

      const exists = await custom
        .getClusterCustomObject({ group: RGD_GROUP, version: RGD_VERSION, plural: RGD_PLURAL, name })
        .then(() => true)
        .catch((e: unknown) => {
          if (isNotFound(e)) return false;
          throw e; // an API failure is not evidence the name is free
        });
      if (exists) {
        throw new Error(
          `rgd/${name} already exists; refusing to adopt or overwrite it. This fixture only ever creates ` +
            `run-unique names, so a collision means the naming assumption broke — investigate before rerunning.`
        );
      }

      await custom.createClusterCustomObject({
        group: RGD_GROUP,
        version: RGD_VERSION,
        plural: RGD_PLURAL,
        body: unique as object,
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
      plurals.push(pluralFor(kind));
    }
    return plurals;
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
    const probePlurals = await applyRgd(probeComposition.factory('kro').toYaml());
    probePlural = probePlurals[0] ?? '';
    if (!probePlural) throw new Error('probe RGD registered no CRD plural');
    // `allowBreakingChanges` is retained because the bundle under test carries it — and it is precisely why
    // this must run under a run-unique kind: applied to the SHARED `dagsterbootstraps` CRD it would migrate
    // the schema real Dagster instances depend on.
    const dagsterPlurals = await applyRgd(
      dagsterBootstrap.factory('kro', { allowBreakingChanges: true }).toYaml()
    );
    // The bootstrap RGD is the one declaring the schemaless `values` hatches the assertions read.
    dagsterPlural = dagsterPlurals.find((pl) => pl.startsWith('dagsterbootstrap')) ?? '';
    if (!dagsterPlural) throw new Error(`no dagsterbootstraps plural in ${dagsterPlurals.join(', ')}`);
    await waitForConvergedCrd(probePlural);
    await waitForConvergedCrd(dagsterPlural);
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
    // lets KRO re-register it, leaving behind the object this teardown just removed. Absence is proven by a
    // 404 only — a transient API error is not evidence — and a timeout is an explicit failure.
    for (const { what } of created.filter((c) => !c.gone && c.what.startsWith('rgd/'))) {
      const name = what.slice('rgd/'.length);
      if (!(await waitForRgdAbsent(name))) {
        failures.push(`${what}: not confirmed absent (delete stuck, or the API never returned 404)`);
      }
    }

    // Deleting an RGD does NOT reap the CRD KRO registered for it. Both kinds are run-unique, so this run
    // owns both and can remove them without touching any shared definition.
    for (const plural of [probePlural, dagsterPlural].filter(Boolean)) {
      const crd = `${plural}.${RGD_GROUP}`;
      await apiext
        .deleteCustomResourceDefinition({ name: crd })
        .catch((e: unknown) => {
          if (!isNotFound(e)) failures.push(`crd/${crd}: ${String(e)}`);
        });
      if (!(await waitForCrdAbsent(crd))) {
        failures.push(`crd/${crd}: not confirmed absent (KRO may have re-registered it)`);
      }
    }

    if (failures.length > 0) throw new Error(`cleanup failed:\n${failures.join('\n')}`);
  });

  it('registers the Dagster escape hatches as schemaless `object` in the CRD (no instances created)', async () => {
    const props = await waitForConvergedCrd(dagsterPlural);

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
      plural: probePlural,
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
          plural: probePlural,
          name,
        }),
      gone: () =>
        custom
          .getNamespacedCustomObject({
            group: RGD_GROUP,
            version: RGD_VERSION,
            namespace,
            plural: probePlural,
            name,
          })
          .then(() => false)
          .catch(() => true),
    });

    const admitted = (await custom.getNamespacedCustomObject({
      group: RGD_GROUP,
      version: RGD_VERSION,
      namespace,
      plural: probePlural,
      name,
    })) as { spec?: { values?: unknown } };

    // Before the core fix this field was declared `string`, so the whole subtree was dropped in silence.
    expect(admitted.spec?.values).toEqual(PROBE_VALUES);
  });
});
