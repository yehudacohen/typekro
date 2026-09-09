/**
 * ClickStack on an S3-backed ClickHouse — cluster-gated integration suite (#184).
 *
 * Follows the existing `describeOrSkip` harness: the whole suite SKIPS cleanly
 * when no cluster is reachable (set REQUIRE_CLUSTER_TESTS=true to force it on
 * where a cluster is guaranteed).
 *
 * LIVE-PATH PREREQUISITES (skipping without a cluster is the hard requirement;
 * a live pass needs all of these):
 * - A reachable cluster with the TypeKro runtime installed (Flux source/helm
 *   controllers), i.e. the `bun run scripts/e2e-setup.ts` environment.
 * - Outbound access for the Altinity operator chart, the official clickstack
 *   chart, and the MinIO / mc / mongo / HyperDX images.
 *
 * WHAT IT PROVES — the #183 claim that needs a LIVE cluster to be worth
 * anything: the gateway collector's goose migrations create `otel_logs` &c.
 * with NO `SETTINGS storage_policy` clause, and because the `clickhouse`
 * factory made the S3 policy the server DEFAULT, those tables land on the
 * object-storage disks anyway. Then the same node-loss proof as the ClickHouse
 * suite: delete the ClickHouse pod, and the ingested telemetry is still there.
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

setDefaultTimeout(1_800_000);

describeOrSkip('ClickStack on S3-backed ClickHouse (MinIO)', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  const operatorNs = `clickstack-s3-op-${runId}`;
  const chiNs = `clickstack-s3-chi-${runId}`;
  const stackNs = `clickstack-s3-${runId}`;
  const chiName = 'ch-s3';
  const chiUser = 'otelcollector';
  const chiUserPassword = 'otel-probe-password';
  const stackName = 'clickstack';
  const bucket = 'clickhouse-data';

  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let storageClass: string;
  let minio: MinioFixture;
  let chiUserPasswordSha256: string;
  let clickhouseHost: string | undefined;
  let operatorFactory: unknown;
  let clickhouseFactory: unknown;
  let stackFactory: unknown;
  let operatorDeployed = false;
  let clickhouseDeployed = false;
  let stackDeployed = false;
  let helmRepositoryPreexisting = false;
  let gatewayEndpoint: string | undefined;
  const apiKey = crypto.randomUUID();
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

  async function query(sql: string, label: string): Promise<string> {
    return (
      await runTestPodAndReadLogs(
        {
          namespace: chiNs,
          name: `${chiName}-q-${label}-${crypto.randomUUID().slice(0, 6)}`,
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
        [operatorNs, chiNs, stackNs].map((namespace) => createTestNamespace(namespace, kubeConfig))
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

    minio = await deployMinio({ namespace: chiNs, bucket, kubeConfig });
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    for (const [factory, name] of [
      [stackFactory, stackName],
      [clickhouseFactory, chiName],
    ] as const) {
      if (factory === undefined) continue;
      if (factory === stackFactory && !stackDeployed) continue;
      if (factory === clickhouseFactory && !clickhouseDeployed) continue;
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory as never,
        name,
        [],
        kubeConfig,
        180_000
      ).catch((error) => cleanupErrors.push(error));
    }

    if (operatorFactory !== undefined && operatorDeployed) {
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
      throw new AggregateError(cleanupErrors, 'ClickStack S3 suite cleanup failed');
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
    operatorFactory = factory;

    const instance = await factory.deploy({
      name: 'clickhouse-operator',
      namespace: operatorNs,
      version: '0.27.1',
      shared: false,
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

  it('deploys an S3-backed ClickHouse for ClickStack to write to', async () => {
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');

    const clickhouse = makeClickHouseCluster({
      // A NAMED user is required: the operator restricts the built-in `default`
      // user with a host_regexp scoped to the CHI's own pods, so the gateway
      // collector in another namespace cannot authenticate as it.
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
    clickhouseFactory = factory;

    const instance = await factory.deploy({
      name: chiName,
      namespace: chiNs,
      version: '25.7',
      storage: { size: '2Gi', storageClassName: storageClass },
      podResources: { requests: { cpu: '200m', memory: '1Gi' }, limits: { memory: '2Gi' } },
      users: { [chiUser]: { passwordSha256Hex: chiUserPasswordSha256 } },
    });
    clickhouseDeployed = true;

    expect(instance.status.ready).toBe(true);
    expect(instance.status.storage.mode).toBe('s3');
    clickhouseHost = instance.status.clickhouse.host;
  }, 1_200_000);

  it('deploys clickstack with retention and a persistent collector queue', async () => {
    expect(clickhouseHost).toBeDefined();
    const { makeClickstackBootstrap } = await import('../../../src/factories/clickstack/index.js');

    const bootstrap = makeClickstackBootstrap({
      mongo: { mode: 'internal' as const, storage: { storageClassName: storageClass } },
      storage: {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        // Short retention so the DDL is observable inside a test run.
        retention: { logs: '7d', traces: '7d', metrics: '30d' },
        retentionSchedule: '*/2 * * * *',
        persistentQueue: { enabled: true },
      },
    });
    const factory = bootstrap.factory('direct', {
      namespace: stackNs,
      waitForReady: true,
      timeout: 1_200_000,
      kubeConfig,
    });
    stackFactory = factory;

    const instance = await factory.deploy({
      name: stackName,
      namespace: stackNs,
      clickhouse: {
        host: clickhouseHost as string,
        username: chiUser,
        password: chiUserPassword,
      },
      apiKey,
    });
    stackDeployed = true;

    expect(instance.status.ready).toBe(true);
    expect(instance.status.storage.mode).toBe('s3');
    expect(instance.status.storage.persistentQueue).toBe(true);
    gatewayEndpoint = instance.status.gateway.otlpHttpEndpoint;
    expect(gatewayEndpoint).toContain('4318');
  }, 1_500_000);

  it('lands the collector-created OTel tables on the S3 policy with no per-table DDL', async () => {
    // The goose migrations create these; TypeKro never issues their DDL. The
    // ONLY reason they are on the object store is the server-default policy.
    const deadline = Date.now() + 600_000;
    let policy = '';
    while (Date.now() < deadline) {
      policy = await query(
        "SELECT storage_policy FROM system.tables WHERE database = 'default' AND name = 'otel_logs'",
        'policy'
      );
      if (policy !== '') break;
      await Bun.sleep(10_000);
    }

    expect(policy).toBe('s3_main');
  }, 900_000);

  it('ingests OTLP logs through the gateway and stores the parts on the S3 disks', async () => {
    expect(gatewayEndpoint).toBeDefined();

    // LIVE-VERIFIED: the Team bootstrap sets `collectorAuthenticationEnforced`,
    // so the gateway rejects an unauthenticated OTLP post with
    // "missing or empty authorization header". The probe therefore sends the
    // same ingestion key the bootstrap installed.
    const payload = [
      '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name",',
      '"value":{"stringValue":"typekro-s3-probe"}}]},"scopeLogs":[{"logRecords":[{',
      '"timeUnixNano":"\'"$TS"\'","body":{"stringValue":"typekro-s3-probe-line"},',
      '"severityText":"INFO"}]}]}]}',
    ].join('');

    await runTestPodAndReadLogs(
      {
        namespace: stackNs,
        name: `otlp-probe-${crypto.randomUUID().slice(0, 6)}`,
        image: 'curlimages/curl:8.11.1',
        command: [
          'sh',
          '-c',
          [
            'set -eu',
            // OTLP/HTTP wants nanoseconds; `date +%s` gives seconds.
            'TS="$(date +%s)000000000"',
            `curl -sS --fail-with-body -X POST "${gatewayEndpoint}/v1/logs" ` +
              `-H 'Content-Type: application/json' ` +
              `-H "authorization: $HYPERDX_API_KEY" --data '${payload}'`,
          ].join('\n'),
        ],
        env: [{ name: 'HYPERDX_API_KEY', value: apiKey }],
        timeoutMs: 240_000,
      },
      kubeConfig
    );

    const deadline = Date.now() + 600_000;
    let rows = '0';
    while (Date.now() < deadline) {
      rows = await query(
        "SELECT count() FROM otel_logs WHERE ServiceName = 'typekro-s3-probe'",
        'rows'
      );
      if (rows !== '0') break;
      await Bun.sleep(10_000);
    }
    expect(Number(rows)).toBeGreaterThan(0);

    const disks = await query(
      "SELECT DISTINCT disk_name FROM system.parts WHERE table = 'otel_logs' AND active",
      'disks'
    );
    // A `cache` disk is a transparent wrapper, so `system.parts` reports the
    // underlying object-storage disk — the point is that it is not `default`.
    expect(disks).toBe('s3');
  }, 900_000);

  it('keeps the telemetry queryable after the ClickHouse pod is deleted', async () => {
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const pods = await coreApi.listNamespacedPod({
      namespace: chiNs,
      labelSelector: `clickhouse.altinity.com/chi=${chiName}`,
    });
    const podName = pods.items[0]?.metadata?.name;
    expect(podName).toBeDefined();

    await coreApi.deleteNamespacedPod({ namespace: chiNs, name: podName as string });

    const deadline = Date.now() + 600_000;
    let rows = '0';
    while (Date.now() < deadline) {
      try {
        rows = await query(
          "SELECT count() FROM otel_logs WHERE ServiceName = 'typekro-s3-probe'",
          'after'
        );
        if (rows !== '0') break;
      } catch {
        // Still restarting; retry.
      }
      await Bun.sleep(10_000);
    }

    expect(Number(rows)).toBeGreaterThan(0);
  }, 900_000);

  it('applies the configured TTL to the collector-created tables', async () => {
    // The retention CronJob converges on its own schedule once the tables
    // exist, so poll rather than assuming the first run already landed.
    // LIVE-VERIFIED: the collector's own migration already sets
    // `TTL toDateTime(Timestamp) + toIntervalDay(30)`, so "the table has a TTL"
    // is true before the retention CronJob has ever run. Poll for OUR interval.
    const deadline = Date.now() + 600_000;
    let ttl = '';
    while (Date.now() < deadline) {
      ttl = await query(
        "SELECT create_table_query FROM system.tables WHERE database = 'default' " +
          "AND name = 'otel_logs'",
        'ttl'
      );
      if (/toIntervalDay\(7\)|INTERVAL 7 DAY/.test(ttl)) break;
      await Bun.sleep(15_000);
    }

    expect(ttl).toContain('TTL');
    expect(ttl).toMatch(/toIntervalDay\(7\)|INTERVAL 7 DAY/);
  }, 900_000);
});
