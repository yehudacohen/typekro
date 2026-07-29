/**
 * LIVE KRO ADMISSION test for the Dagster raw-Helm-`values` escape hatches.
 *
 * Why this exists, specifically: the unit tests asserted that CEL strings like `schema.spec.postgresql.values`
 * appeared in the generated YAML. That is not the same claim. A field can be referenced by CEL and still be
 * DECLARED `string` in the RGD schema — in which case KRO admission silently PRUNES whatever object a caller
 * sent, the CEL resolves to nothing, and every offline test still passes. Both documented Dagster escape
 * hatches were broken that way, and it stayed invisible because nothing ever read a CR back from a cluster.
 *
 * So this test does the only thing that actually proves the contract: apply the RGD, submit a CR carrying
 * NESTED UNKNOWN structure (maps, booleans, numbers, arrays — none of it modelled by any convenience shape),
 * then read the admitted object back from the API server and assert the values survived.
 *
 * Worth knowing WHY this stayed hidden: the same defect surfaces differently per client. `kubectl apply` uses
 * STRICT decoding, so against the broken schema it fails loudly —
 *   `strict decoding error: unknown field "spec.values.postgresql"`
 * — which is the "rejected 422/BadRequest" people hit when poking by hand. TypeKro's own apply path is NOT
 * strict, so in production the identical mismatch was PRUNED IN SILENCE and the converge reported success.
 * This test deliberately drives kubectl, so a regression is a hard error rather than a quiet omission.
 *
 * Deliberately image-free: it never deploys Dagster, so it needs only a cluster with KRO. Run with
 * `bun test test/integration/dagster/values-admission.test.ts` against orbstack.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { dagsterBootstrap } from '../../../src/factories/dagster/index.js';
import { isClusterAvailable } from '../shared-kubeconfig.js';

setDefaultTimeout(300000);

const clusterAvailable = await isClusterAvailable();
const describeLiveOrSkip = clusterAvailable ? describe : describe.skip;

// Unique per run: afterAll deletes the namespace with `--wait=false`, so a fixed name races against the
// previous run's Terminating namespace (apply then fails with `namespaces ... not found`).
const NAMESPACE = `typekro-values-admission-${Math.random().toString(36).slice(2, 8)}`;
const INSTANCE = 'values-probe';

/** `kubectl` against the ambient kubeconfig; returns stdout, throws with stderr on failure. */
const kubectl = async (args: string[], stdin?: string): Promise<string> => {
  const proc = Bun.spawn(['kubectl', ...args], {
    stdin: stdin ? new TextEncoder().encode(stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`kubectl ${args.join(' ')} failed (${code}): ${err}`);
  return out;
};

/**
 * The structure a caller sends and admission must NOT strip. Chosen to cover what the old `string` typing
 * destroyed: nested maps, a boolean, a number, an array of objects, and a dotted key.
 */
const PROBE_VALUES = {
  postgresql: {
    // The exact settings that could not be expressed before — no convenience shape models these.
    primary: { persistence: { enabled: false }, nodeSelector: { 'kubernetes.io/os': 'linux' } },
    persistence: { enabled: false },
  },
  extraObjects: [{ kind: 'ConfigMap', metadata: { name: 'probe' } }],
  someNumber: 42,
  someBool: true,
} as const;

describeLiveOrSkip('Dagster raw Helm values survive KRO admission', () => {
  beforeAll(async () => {
    await kubectl(['create', 'namespace', NAMESPACE]);
    // Apply only the DagsterBootstrap RGD (the stream also carries the HelmRepository one; both are fine).
    await kubectl(['apply', '-f', '-'], dagsterBootstrap.toYaml());
    // Wait for KRO to accept the graph — a rejected RGD would make the CR apply fail confusingly.
    await kubectl([
      'wait',
      'resourcegraphdefinition/dagster-bootstrap',
      '--for=condition=GraphAccepted',
      '--timeout=120s',
    ]);
    // GraphAccepted does NOT imply the CRD is registered and served — KRO creates it afterwards, so reading
    // the CRD immediately races and sees NotFound. And `kubectl wait` ERRORS on a resource that does not
    // exist yet rather than waiting for it, so poll for existence first, then wait for Established (the
    // condition that actually means "the API server will accept objects of this kind").
    for (let i = 0; i < 60; i++) {
      const exists = await kubectl(['get', 'crd', 'dagsterbootstraps.kro.run', '--ignore-not-found', '-o', 'name']);
      if (exists.trim()) break;
      await Bun.sleep(1000);
    }
    await kubectl([
      'wait',
      'crd/dagsterbootstraps.kro.run',
      '--for=condition=Established',
      '--timeout=120s',
    ]);
  });

  afterAll(async () => {
    await kubectl([
      'delete',
      'dagsterbootstrap',
      INSTANCE,
      '-n',
      NAMESPACE,
      '--ignore-not-found',
      '--wait=false',
    ]).catch(() => {});
    await kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=false']).catch(
      () => {}
    );
  });

  it('declares the escape hatches as schemaless `object` in the ADMITTED CRD', async () => {
    // Read the CRD the API server actually registered, not the YAML we generated — this is what prunes.
    const crd = JSON.parse(
      await kubectl(['get', 'crd', 'dagsterbootstraps.kro.run', '-o', 'json'])
    ) as {
      spec: { versions: Array<{ schema: { openAPIV3Schema: any } }> };
    };
    const spec = crd.spec.versions[0]!.schema.openAPIV3Schema.properties.spec.properties;

    expect(spec.values.type).toBe('object');
    expect(spec.values['x-kubernetes-preserve-unknown-fields']).toBe(true);
    expect(spec.postgresql.properties.values.type).toBe('object');
    expect(spec.postgresql.properties.values['x-kubernetes-preserve-unknown-fields']).toBe(true);
  });

  it('preserves nested unknown values through admission (the regression that shipped)', async () => {
    const cr = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'DagsterBootstrap',
      metadata: { name: INSTANCE, namespace: NAMESPACE },
      spec: { name: INSTANCE, namespace: NAMESPACE, values: PROBE_VALUES },
    };
    await kubectl(['apply', '-f', '-'], JSON.stringify(cr));

    const admitted = JSON.parse(
      await kubectl(['get', 'dagsterbootstrap', INSTANCE, '-n', NAMESPACE, '-o', 'json'])
    ) as { spec: { values?: Record<string, unknown> } };

    // Before the fix this read back as `{}` / absent: the whole subtree was pruned in silence.
    expect(admitted.spec.values).toEqual(PROBE_VALUES);
  });

  it('preserves the per-subchart `postgresql.values` hatch too', async () => {
    const cr = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'DagsterBootstrap',
      metadata: { name: `${INSTANCE}-pg`, namespace: NAMESPACE },
      spec: {
        name: `${INSTANCE}-pg`,
        namespace: NAMESPACE,
        postgresql: { enabled: true, values: { primary: { persistence: { enabled: false } } } },
      },
    };
    await kubectl(['apply', '-f', '-'], JSON.stringify(cr));

    const admitted = JSON.parse(
      await kubectl(['get', 'dagsterbootstrap', `${INSTANCE}-pg`, '-n', NAMESPACE, '-o', 'json'])
    ) as { spec: { postgresql?: { enabled?: boolean; values?: Record<string, unknown> } } };

    expect(admitted.spec.postgresql?.values).toEqual({ primary: { persistence: { enabled: false } } });
    // The typed convenience field alongside it must still be typed, not swallowed by the opaque sibling.
    expect(admitted.spec.postgresql?.enabled).toBe(true);

    await kubectl([
      'delete',
      'dagsterbootstrap',
      `${INSTANCE}-pg`,
      '-n',
      NAMESPACE,
      '--ignore-not-found',
      '--wait=false',
    ]);
  });
});
