/**
 * S3-backed ClickHouse — cluster-gated integration suite (#184).
 *
 * Follows the existing `describeOrSkip` harness: the whole suite SKIPS cleanly
 * when no cluster is reachable (set REQUIRE_CLUSTER_TESTS=true to force it on
 * where a cluster is guaranteed).
 *
 * LIVE-PATH PREREQUISITES (skipping without a cluster is the hard requirement;
 * a live pass needs all of these):
 * - A reachable cluster with the TypeKro runtime installed (Flux source/helm
 *   controllers — the operator bootstrap deploys HelmRepository/HelmRelease),
 *   i.e. the `bun run scripts/e2e-setup.ts` environment.
 * - Outbound access to pull the Altinity operator chart, the ClickHouse server
 *   image, and the MinIO / mc images.
 *
 * WHAT IT PROVES
 * 1. A `makeClickHouseCluster({ storage: { mode: 's3_plain_rewritable' } })`
 *    reconciles against MinIO with Secret-backed credentials — i.e. the
 *    rendered `storage_configuration` is accepted by a real server.
 * 2. Parts land on the `s3_cache`/`s3` disks, not the local default disk —
 *    read straight out of `system.parts`.
 * 3. `plain_rewritable` durability: DELETE the ClickHouse pod, and the rows are
 *    still queryable once it comes back, with no restore step. That is the
 *    whole point of the disk type, and the thing `diskType: 's3'` cannot do.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import { deployMinio, type MinioFixture } from '../minio-fixture.js';
import {
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  isClusterAvailable,
  requireTestStorageClass,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

// Live-verified elsewhere in this family: operator + CHI + namespace teardown
// exceeds bun's 5s default hook timeout on a real cluster.
setDefaultTimeout(1_500_000);

describeOrSkip('ClickHouse S3-backed storage (MinIO)', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  const operatorNs = `clickhouse-s3-op-${runId}`;
  const chiNs = `clickhouse-s3-chi-${runId}`;
  const chiName = 'ch-s3';
  const chiUser = 'probe';
  // sha256('probe-password'), computed at startup so no hash is hard-coded.
  let chiUserPasswordSha256: string;
  const chiUserPassword = 'probe-password';
  const bucket = 'clickhouse-data';

  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let storageClass: string;
  let minio: MinioFixture;
  let operatorFactory: { deleteInstance?: unknown } | undefined;
  let clickhouseFactory:
    | {
        deploy: (spec: unknown) => Promise<{ status: { ready: boolean; storage: unknown } }>;
      }
    | undefined;
  let operatorDeployed = false;
  let clickhouseDeployed = false;
  let helmRepositoryPreexisting = false;
  const namespaceLeases: TestNamespaceLease[] = [];

  /**
   * Poll the operator HelmRelease's own `Ready` condition.
   *
   * The direct factory's returned snapshot can predate Flux's install (see the
   * call site), and every later step depends on a live operator, so the gate is
   * the resource's own condition.
   */
  async function waitForOperatorReady(timeoutMs = 600_000): Promise<void> {
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const deadline = Date.now() + timeoutMs;
    let lastMessage = 'no status yet';
    while (Date.now() < deadline) {
      try {
        const raw = (await customApi.getNamespacedCustomObject({
          group: 'helm.toolkit.fluxcd.io',
          version: 'v2',
          namespace: operatorNs,
          plural: 'helmreleases',
          name: 'clickhouse-operator',
        })) as { body?: unknown };
        const release = (raw as { body?: unknown }).body ?? raw;
        const conditions =
          (
            release as {
              status?: { conditions?: { type: string; status: string; message?: string }[] };
            }
          ).status?.conditions ?? [];
        const ready = conditions.find((condition) => condition.type === 'Ready');
        if (ready?.status === 'True') return;
        lastMessage = ready?.message ?? lastMessage;
      } catch {
        // The HelmRelease may not exist yet.
      }
      await Bun.sleep(5_000);
    }
    throw new Error(`Operator HelmRelease never became Ready: ${lastMessage}`);
  }

  /** Run a query against the CHI from a throwaway clickhouse-client Pod. */
  async function query(sql: string, name: string): Promise<string> {
    return (
      await runTestPodAndReadLogs(
        {
          namespace: chiNs,
          name: `${chiName}-q-${name}-${crypto.randomUUID().slice(0, 6)}`,
          image: 'clickhouse/clickhouse-server:25.7',
          command: [
            'clickhouse-client',
            '--host',
            `clickhouse-${chiName}.${chiNs}.svc.cluster.local`,
            '--port',
            '9000',
            '--user',
            chiUser,
            '--password',
            chiUserPassword,
            '--query',
            sql,
          ],
          timeoutMs: 240_000,
        },
        kubeConfig
      )
    ).trim();
  }

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    storageClass = await requireTestStorageClass({ kubeConfig });
    chiUserPasswordSha256 = new Bun.CryptoHasher('sha256').update(chiUserPassword).digest('hex');

    namespaceLeases.push(
      ...(await Promise.all(
        [operatorNs, chiNs].map((namespace) => createTestNamespace(namespace, kubeConfig))
      ))
    );

    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    try {
      await customApi.getNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'helmrepositories',
        name: 'altinity',
      });
      helmRepositoryPreexisting = true;
    } catch {
      // The temporary bootstrap creates and later removes the repository.
    }

    // MinIO lives in the CHI namespace so the disk endpoint is a short hop and
    // the Secret is directly referenceable by the CHI pod template.
    minio = await deployMinio({ namespace: chiNs, bucket, kubeConfig });
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (clickhouseFactory && clickhouseDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        clickhouseFactory as never,
        chiName,
        [],
        kubeConfig,
        120_000
      ).catch((error) => cleanupErrors.push(error));
    }
    if (operatorFactory && operatorDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        operatorFactory as never,
        'clickhouse-operator',
        [],
        kubeConfig,
        120_000,
        { scopes: ['cluster'], includeUnscopedResources: true }
      ).catch((error) => cleanupErrors.push(error));
    }
    if (!helmRepositoryPreexisting) {
      await deleteTestResourceAndWait(
        {
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'HelmRepository',
          metadata: { namespace: 'flux-system', name: 'altinity' },
        },
        kubeConfig,
        60_000
      ).catch((error) => cleanupErrors.push(error));
    }

    await Promise.all(
      namespaceLeases.map((lease) =>
        deleteTestNamespaceAndWait(lease, kubeConfig).catch((error) => cleanupErrors.push(error))
      )
    );

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'S3 storage suite cleanup failed');
    }
  });

  it('deploys the Altinity operator scoped to the CHI namespace', async () => {
    const { clickhouseOperatorBootstrap } = await import(
      '../../../src/factories/clickhouse/index.js'
    );

    const factory = clickhouseOperatorBootstrap.factory('direct', {
      namespace: operatorNs,
      waitForReady: true,
      timeout: 600_000,
      kubeConfig,
    });
    operatorFactory = factory as never;

    const instance = await factory.deploy({
      name: 'clickhouse-operator',
      namespace: operatorNs,
      version: '0.27.1',
      shared: false,
      // With an empty watch include list the operator watches only its own
      // namespace (live-verified in the sibling suite) — scope it explicitly.
      customValues: {
        configs: { files: { 'config.yaml': { watch: { namespaces: { include: [chiNs] } } } } },
      },
    });
    operatorDeployed = true;

    // LIVE OBSERVATION: `deploy()` returned in ~20s with `status.ready: false`
    // while the operator HelmRelease only reached `Ready=True` about 90s later
    // (the Flux HelmRepository this bootstrap creates has to fetch an artifact
    // first). This suite is about S3 storage, not the bootstrap's readiness
    // plumbing, so it polls the live HelmRelease rather than trusting the
    // returned snapshot — see the PR's open questions for the underlying gap.
    expect(instance).toBeDefined();
    await waitForOperatorReady();
  }, 900_000);

  it('reconciles an s3_plain_rewritable cluster against MinIO with Secret-backed keys', async () => {
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');

    // BUILD-TIME storage: bucket/endpoint/credentials/disk type compile into
    // the CHI's storage_configuration XML. Only the thin local volume sizing
    // stays runtime spec.
    const clickhouse = makeClickHouseCluster({
      users: [{ name: chiUser }],
      storage: {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        bucket: minio.bucket,
        prefix: 'chi',
        endpoint: minio.endpoint,
        cache: { size: '512Mi' },
        auth: { secretRef: { name: minio.secretName } },
      },
    });
    const factory = clickhouse.factory('direct', {
      namespace: chiNs,
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });
    clickhouseFactory = factory as never;

    const instance = await factory.deploy({
      name: chiName,
      namespace: chiNs,
      // >= 24.5 is required for the plain_rewritable metadata type; the
      // factory rejects anything older at construction time.
      version: '25.7',
      storage: { size: '2Gi', storageClassName: storageClass },
      podResources: {
        requests: { cpu: '200m', memory: '1Gi' },
        limits: { memory: '2Gi' },
      },
      users: { [chiUser]: { passwordSha256Hex: chiUserPasswordSha256 } },
    });
    clickhouseDeployed = true;

    expect(instance.status.ready).toBe(true);
    // The storage contract is a client-hydrated build-time constant.
    expect(instance.status.storage.mode).toBe('s3');
    expect(instance.status.storage.diskType).toBe('s3_plain_rewritable');
    expect(instance.status.storage.selfDescribingBucket).toBe(true);
  }, 1_200_000);

  it('makes the S3 policy the MergeTree default, so a plain CREATE TABLE lands on it', async () => {
    // NO `SETTINGS storage_policy` clause — exactly what external tooling
    // (HyperDX/OTel goose migrations, SigNoz) emits.
    await query(
      'CREATE TABLE IF NOT EXISTS probe (ts DateTime, msg String) ENGINE = MergeTree ORDER BY ts',
      'create'
    );
    await query("INSERT INTO probe VALUES (now(), 'before-restart')", 'insert');

    const policy = await query(
      "SELECT storage_policy FROM system.tables WHERE database = 'default' AND name = 'probe'",
      'policy'
    );
    expect(policy).toBe('s3_main');

    const disks = await query(
      "SELECT DISTINCT disk_name FROM system.parts WHERE table = 'probe' AND active",
      'disks'
    );
    // LIVE-VERIFIED: a `cache` disk is a transparent wrapper, so `system.parts`
    // reports the UNDERLYING object-storage disk (`s3`) rather than `s3_cache`.
    // What matters is that it is not the server's local `default` disk.
    expect(disks).toBe('s3');
  }, 600_000);

  it('survives losing the ClickHouse pod with no restore step (plain_rewritable)', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const pods = await coreApi.listNamespacedPod({
      namespace: chiNs,
      labelSelector: `clickhouse.altinity.com/chi=${chiName}`,
    });
    const podName = pods.items[0]?.metadata?.name;
    expect(podName).toBeDefined();

    await coreApi.deleteNamespacedPod({ namespace: chiNs, name: podName as string });

    // The StatefulSet reschedules and the disk re-attaches from the bucket's
    // own metadata — nothing local is needed to find the parts again.
    let rows = '';
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      try {
        rows = await query("SELECT count() FROM probe WHERE msg = 'before-restart'", 'after');
        if (rows === '1') break;
      } catch {
        // The server is still coming back; retry.
      }
      await Bun.sleep(10_000);
    }

    expect(rows).toBe('1');
  }, 900_000);
});
