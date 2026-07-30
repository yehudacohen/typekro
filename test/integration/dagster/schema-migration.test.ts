/**
 * LIVE migration test: an ALREADY-DEPLOYED RGD whose field was declared `string` being moved to the corrected
 * schemaless `object`.
 *
 * Why this needs a test of its own. Fixing the arktype `object` mapping changes the declared TYPE of existing
 * fields (52 of them in the Dagster RGD alone), and KRO refuses breaking CRD updates. The refusal is very easy
 * to miss:
 *   - `kubectl apply` / the API create reports SUCCESS,
 *   - the RGD reports `Ready=True`,
 *   - the registered CRD silently keeps its OLD schema,
 *   - and the only evidence is a controller log line:
 *       `cannot update CRD ...: breaking changes detected: Type changed from string to object; ...`
 * So an operator upgrading TypeKro would see a clean upgrade while nothing actually changed — the same
 * silent-no-op shape as the bug being fixed. This test pins both halves: the refusal, and the authorized path.
 *
 * The legacy RGD is hand-authored rather than generated from an older TypeKro, so the test states the
 * before-state explicitly instead of depending on git history.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { createBunCompatibleApiClient } from '../../../src/core/kubernetes/bun-api-client.js';
import {
  createCustomObjectsApiClient,
  deleteGeneratedCrdAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

setDefaultTimeout(300000);

const clusterAvailable = await isClusterAvailable();
const describeLiveOrSkip = clusterAvailable ? describe : describe.skip;

const GROUP = 'kro.run';
const VERSION = 'v1alpha1';
const RGD_PLURAL = 'resourcegraphdefinitions';
/**
 * RUN-UNIQUE identity. A fixed name made this fixture destructively ADOPT whatever was already on the
 * cluster under that name: setup unconditionally deleted the RGD and its generated CRD (swallowing errors),
 * so two concurrent runs — or a run overlapping an interrupted earlier one — would delete each other's
 * resources with no ownership evidence. Suffixing every identity means a run can only ever touch objects it
 * created, and the pre-delete below is a no-op belt-and-braces rather than a landmine.
 */
const RUN_ID = Math.random().toString(36).slice(2, 8);
const RGD_NAME = `schema-migration-probe-${RUN_ID}`;
const CR_KIND = `SchemaMigrationProbe${RUN_ID}`;
/**
 * DISCOVERED from the cluster, never derived. KRO pluralises the kind with real English rules, not `+ 's'`:
 * with a random run suffix, `…probea32l9o` becomes `…probea32l9oes`, so any client-side guess is correct only
 * for some suffixes — the fixture was flaky by construction and leaked the CRD its teardown couldn't find.
 * Resolved in `beforeAll` once KRO has registered the CRD.
 */
let CR_PLURAL = '';

/** An RGD declaring `values` as the type given — the only difference between legacy and corrected. */
const rgd = (valuesType: 'string' | 'object', allowBreaking: boolean): object => ({
  apiVersion: `${GROUP}/${VERSION}`,
  kind: 'ResourceGraphDefinition',
  metadata: {
    name: RGD_NAME,
    ...(allowBreaking ? { annotations: { 'kro.run/allow-breaking-changes': 'true' } } : {}),
  },
  spec: {
    schema: {
      apiVersion: VERSION,
      kind: CR_KIND,
      spec: { name: 'string', values: valuesType },
      status: {},
    },
    resources: [
      {
        id: 'probeCfg',
        template: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: '${schema.spec.name}-probe', namespace: 'default' },
          data: { role: 'probe' },
        },
      },
    ],
  },
});

describeLiveOrSkip('migrating an existing RGD from `string` to schemaless `object`', () => {
  const kc = getIntegrationTestKubeConfig();
  const custom = createCustomObjectsApiClient(kc);
  const apiext = createBunCompatibleApiClient(kc, k8s.ApiextensionsV1Api);

  const applyRgd = async (body: object): Promise<void> => {
    await custom
      .createClusterCustomObject({ group: GROUP, version: VERSION, plural: RGD_PLURAL, body })
      .catch(async (e: unknown) => {
        if (!String(e).includes('AlreadyExists') && !String(e).includes('409')) throw e;
        // UPDATE the existing RGD — that is the whole point here. Replacing it would delete the CRD and
        // destroy the very before-state the test depends on.
        const live = (await custom.getClusterCustomObject({
          group: GROUP,
          version: VERSION,
          plural: RGD_PLURAL,
          name: RGD_NAME,
        })) as { metadata?: { resourceVersion?: string } };
        await custom.replaceClusterCustomObject({
          group: GROUP,
          version: VERSION,
          plural: RGD_PLURAL,
          name: RGD_NAME,
          body: {
            ...body,
            metadata: {
              ...(body as { metadata: object }).metadata,
              resourceVersion: live.metadata?.resourceVersion,
            },
          },
        });
      });
  };

  /** The declared type of `spec.values` on the REGISTERED CRD, or undefined until it is Established. */
  const registeredValuesType = async (): Promise<string | undefined> =>
    apiext
      .readCustomResourceDefinition({ name: `${CR_PLURAL}.${GROUP}` })
      .then((crd) => {
        const established = crd.status?.conditions?.some(
          (c) => c.type === 'Established' && c.status === 'True'
        );
        if (!established) return undefined;
        const props = crd.spec.versions[0]?.schema?.openAPIV3Schema?.properties?.spec
          ?.properties as Record<string, { type?: string }> | undefined;
        return props?.values?.type;
      })
      .catch(() => undefined);

  const waitForValuesType = async (want: string): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      if ((await registeredValuesType()) === want) return true;
      await Bun.sleep(1000);
    }
    return false;
  };

  /**
   * Find the CRD plural KRO registered for {@link CR_KIND} by MATCHING `spec.names.kind` — authoritative,
   * unlike client-side pluralisation. Polls because KRO registers the CRD asynchronously after the RGD.
   */
  const discoverCrPlural = async (): Promise<string> => {
    for (let i = 0; i < 60; i++) {
      const found = await apiext
        .listCustomResourceDefinition()
        .then((list) =>
          list.items.find((c) => c.spec.group === GROUP && c.spec.names.kind === CR_KIND)?.spec.names.plural
        )
        .catch(() => undefined);
      if (found) return found;
      await Bun.sleep(1000);
    }
    throw new Error(`KRO never registered a CRD for kind ${CR_KIND} in group ${GROUP}`);
  };

  /** True only for a definitive 404. Any other error is NOT evidence of absence. */
  const isNotFound = (e: unknown): boolean => {
    const code = (e as { code?: number })?.code
      ?? (e as { statusCode?: number })?.statusCode
      ?? (e as { response?: { statusCode?: number } })?.response?.statusCode;
    return code === 404 || /\b404\b|NotFound/.test(String(e));
  };

  /** Poll until the probe RGD is definitively gone; false on timeout so the caller fails. */
  const waitForRgdAbsent = async (): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      const state = await custom
        .getClusterCustomObject({ group: GROUP, version: VERSION, plural: RGD_PLURAL, name: RGD_NAME })
        .then(() => 'present' as const)
        .catch((e: unknown) => (isNotFound(e) ? ('absent' as const) : ('unknown' as const)));
      if (state === 'absent') return true;
      await Bun.sleep(1000);
    }
    return false;
  };

  beforeAll(async () => {
    // No pre-delete: the identity is RUN-UNIQUE, so there is nothing from a previous run to clear, and
    // unconditionally deleting a fixed name is what let concurrent runs destroy each other's fixtures.
    // Seed the legacy state WITH the annotation. Reverting `object` back to `string` is itself a breaking
    // change, so if a previous run left the CRD at `object` (KRO's GC of the CRD can lag the RGD delete) an
    // un-annotated seed would be refused and the fixture would never establish. The annotation here is
    // fixture setup — the behaviour under test is the UN-annotated upgrade in the first `it`.
    await applyRgd(rgd('string', true));
    // Resolve the plural from the cluster before any CRD read — every helper below keys off it.
    CR_PLURAL = await discoverCrPlural();
    expect(await waitForValuesType('string')).toBe(true);
  });

  afterAll(async () => {
    const failures: string[] = [];
    await custom
      .deleteClusterCustomObject({ group: GROUP, version: VERSION, plural: RGD_PLURAL, name: RGD_NAME })
      .catch((e: unknown) => failures.push(`rgd/${RGD_NAME}: ${String(e)}`));
    // WAIT for the RGD to actually be gone before touching its CRD. Delete them back-to-back and KRO, still
    // reconciling the not-yet-observed RGD deletion, simply RE-REGISTERS the CRD — leaving one behind on
    // every run.
    //
    // Absence must be proven by a 404. Treating ANY error as absence (the previous `.catch(() => false)`)
    // meant a transient API failure read as "gone": cleanup would proceed to delete the CRD while the RGD was
    // still there, KRO would re-register it, and the test would report success having leaked the CRD. A
    // timeout is likewise a FAILURE, not a shrug.
    if (!(await waitForRgdAbsent())) {
      failures.push(`rgd/${RGD_NAME}: not confirmed absent (delete stuck, or the API never returned 404)`);
    }
    // Deleting the RGD does NOT reap the CRD KRO registered for it, so remove it explicitly or every run
    // leaves one behind. Safe to delete unconditionally: this kind is run-unique and owned solely by this run.
    // On a persistent OrbStack cluster an emptied CRD can hang on
    // `customresourcecleanup.apiextensions.k8s.io`, so a plain delete-then-wait fails the hook and leaves the
    // CRD Terminating. The shared harness helper owns that recovery and is FAIL-CLOSED: it clears the
    // finalizer only after listing CR_KIND and proving zero instances remain.
    const crdName = `${CR_PLURAL}.${GROUP}`;
    await deleteGeneratedCrdAndWait(
      {
        apiVersion: 'apiextensions.k8s.io/v1',
        kind: 'CustomResourceDefinition',
        metadata: { name: crdName },
      },
      `${GROUP}/${VERSION}`,
      CR_KIND,
      kc
    ).catch((e: unknown) => failures.push(`crd/${crdName}: ${String(e)}`));
    if (failures.length > 0) throw new Error(`cleanup failed:\n${failures.join('\n')}`);
  });

  it('SILENTLY refuses the corrected schema without authorization — the upgrade trap', async () => {
    await applyRgd(rgd('object', false));

    // The RGD update itself is accepted, which is exactly why this is dangerous.
    const live = (await custom.getClusterCustomObject({
      group: GROUP,
      version: VERSION,
      plural: RGD_PLURAL,
      name: RGD_NAME,
    })) as { spec?: { schema?: { spec?: Record<string, unknown> } } };
    expect(live.spec?.schema?.spec?.values).toBe('object');

    // ...but the CRD an operator's CRs are validated against does NOT move. Give KRO ample time to prove it
    // is a refusal rather than a slow reconcile.
    expect(await waitForValuesType('object')).toBe(false);
    expect(await registeredValuesType()).toBe('string');
  });

  it('applies the corrected schema when the migration is explicitly authorized', async () => {
    await applyRgd(rgd('object', true));
    expect(await waitForValuesType('object')).toBe(true);
  });
});
