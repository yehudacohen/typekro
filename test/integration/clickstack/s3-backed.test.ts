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
import * as yaml from 'js-yaml';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleBatchV1Api,
  createBunCompatibleCustomObjectsApi,
} from '../../../src/core/kubernetes/index.js';
import { DEFAULT_QUEUE_EXPORTER_NAMES } from '../../../src/factories/clickstack/utils/storage.js';
import { deployMinio, type MinioFixture } from '../minio-fixture.js';
import {
  createAppsV1ApiClient,
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
        // NO `retention` here, and the factory would reject it: this CHI is
        // `s3_plain_rewritable`, an IMMUTABLE metadata type that refuses every
        // `ALTER TABLE` except settings and comments — proven below. The
        // collector's own migrations keep their 30-day TTL.
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

  it("keeps the chart's custom-config mount alongside the queue volume", async () => {
    // LIVE FINDING: Helm REPLACES a list-valued override, and the chart mounts
    // its `global.otelCollector.customConfig` ConfigMap through the same
    // `extraVolumes`/`extraVolumeMounts` the queue uses. Overriding them with
    // only the queue volume evicted that mount, the OpAMP supervisor could not
    // read `custom.config.yaml`, and the agent never started its OTLP
    // receivers — while the Pod stayed Ready off the supervisor's own
    // health_check. Assert BOTH mounts are present on the live Pod.
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const pods = await coreApi.listNamespacedPod({ namespace: stackNs });
    const collector = pods.items.find((pod) => pod.metadata?.name?.includes('otel-collector'));
    expect(collector).toBeDefined();

    const mounts = (collector?.spec?.containers ?? [])
      .flatMap((container) => container.volumeMounts ?? [])
      .map((mount) => mount.mountPath);
    expect(mounts).toContain('/etc/otelcol-contrib/custom');
    expect(mounts).toContain('/var/lib/otelcol/file_storage');

    const volumes = collector?.spec?.volumes ?? [];
    expect(
      volumes.some((volume) => volume.configMap?.name === 'clickstack-otel-custom-config')
    ).toBe(true);
    expect(
      volumes.some(
        (volume) => volume.persistentVolumeClaim?.claimName === `${stackName}-otel-queue`
      )
    ).toBe(true);
  }, 300_000);

  it('renders ONE overlay document, and the OpAMP supervisor merges it', async () => {
    // THE #185 DEFECT, live. The overlay is one YAML document shared by the
    // ingest pipelines and the queue's wiring, and both contribute a top-level
    // `service` key. Concatenating the two texts declared `service` twice, so
    // the supervisor rejected the WHOLE file on every poll —
    //
    //   Could not merge local config file: .../custom/custom.config.yaml
    //   yaml: unmarshal errors: line 18: mapping key "service" already
    //   defined at line 1
    //
    // — and the agent ran with NEITHER the pipelines NOR the queue while the
    // Pod reported Ready off the supervisor's own health_check. Two halves are
    // asserted here: the ConfigMap TypeKro renders is a single well-formed
    // document, and the supervisor's own log shows it merged rather than
    // rejected.
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const configMap = await coreApi.readNamespacedConfigMap({
      namespace: stackNs,
      name: 'clickstack-otel-custom-config',
    });
    const overlay = configMap.data?.['custom.config.yaml'];
    expect(overlay).toBeDefined();
    console.log(`[overlay] rendered custom.config.yaml:\n${overlay}`);

    // (a) EXACTLY ONE top-level `service`. Counted in the RAW TEXT, because
    // `yaml.load` silently keeps the last of two duplicate keys while Go's
    // yaml.v2 — what the supervisor uses — errors. This counts it the way the
    // supervisor sees it.
    const topLevelKeys = (overlay as string)
      .split('\n')
      .filter((line) => /^[A-Za-z_][^\s:]*:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(topLevelKeys.filter((key) => key === 'service').length).toBe(1);
    expect(new Set(topLevelKeys).size).toBe(topLevelKeys.length);

    // (b) Both contributions survived into that one document.
    const parsed = yaml.load(overlay as string) as {
      service?: { pipelines?: Record<string, { receivers?: string[] }>; extensions?: string[] };
      extensions?: Record<string, unknown>;
      exporters?: Record<string, { sending_queue?: { storage?: string } }>;
    };
    expect(Object.keys(parsed.service?.pipelines ?? {}).sort()).toEqual([
      'logs/in',
      'metrics',
      'traces',
    ]);
    expect(parsed.service?.pipelines?.['logs/in']?.receivers).toContain('otlp/hyperdx');
    expect(Object.keys(parsed.extensions ?? {})).toContain('file_storage/hyperdx');
    expect(parsed.service?.extensions).toContain('file_storage/hyperdx');
    for (const exporterName of DEFAULT_QUEUE_EXPORTER_NAMES) {
      expect(parsed.exporters?.[exporterName]?.sending_queue?.storage).toBe('file_storage/hyperdx');
    }

    // (c) The supervisor's own verdict. It logs the merge failure on EVERY
    // poll, so a clean log over the collector's whole life is the evidence
    // that the file was accepted.
    const pods = await coreApi.listNamespacedPod({ namespace: stackNs });
    const collectorName = pods.items.find((pod) => pod.metadata?.name?.includes('otel-collector'))
      ?.metadata?.name;
    expect(collectorName).toBeDefined();
    const supervisorLog = await coreApi.readNamespacedPodLog({
      namespace: stackNs,
      name: collectorName as string,
    });
    const rejections = supervisorLog
      .split('\n')
      .filter((line) =>
        /unmarshal errors|already defined|Could not merge local config file/i.test(line)
      );
    console.log(
      `[supervisor] ${supervisorLog.split('\n').length} log lines, ` +
        `${rejections.length} config-merge rejections`
    );
    if (rejections.length > 0) console.log(`[supervisor] ${rejections.slice(0, 5).join('\n')}`);
    expect(rejections).toEqual([]);
  }, 300_000);

  it('renders no retention CronJob for an immutable plain_rewritable ClickHouse', async () => {
    const batchApi = createBunCompatibleBatchV1Api(kubeConfig);
    const cronJobs = await batchApi.listNamespacedCronJob({ namespace: stackNs });
    const names = cronJobs.items.map((job) => job.metadata?.name ?? '');
    // The Team bootstrap CronJob is always there; a retention one would
    // CrashLoop forever on this disk type, so it must not exist.
    expect(names.some((name) => name.includes('team-bootstrap'))).toBe(true);
    expect(names.some((name) => name.includes('otel-retention'))).toBe(false);
  }, 300_000);

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
            // LIVE-VERIFIED: the collector Pod reports Ready off its
            // health_check extension, which the OpAMP supervisor brings up
            // BEFORE the OTLP receivers are listening — a single-shot post
            // gets "Could not connect to server" on a freshly rolled gateway.
            // Retry until the receiver accepts, rather than racing it.
            'i=0',
            'while [ "$i" -lt 60 ]; do',
            `  if curl -sS --fail-with-body -X POST "${gatewayEndpoint}/v1/logs" ` +
              `-H 'Content-Type: application/json' ` +
              `-H "authorization: $HYPERDX_API_KEY" --data '${payload}'; then`,
            '    echo "OTLP post accepted"; exit 0',
            '  fi',
            '  i=$((i + 1)); sleep 5',
            'done',
            'echo "gateway never accepted the OTLP post"; exit 1',
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

  it('backs each queued exporter with a bbolt database on the PVC', async () => {
    // THE PROOF THAT THE QUEUE IS REAL, and the one assertion the agent's
    // effective configuration cannot be read for: the collector does not
    // expose its merged config over the network, and its filesystem is not
    // reachable from another Pod. What IS reachable is the file the
    // `file_storage` extension creates — and the extension names its bbolt
    // database after the component that opened it (`exporter_<name>_<signal>`),
    // so the FILENAME is direct observational evidence of which exporter bound
    // its `sending_queue` to file storage. That is a stronger statement than
    // reading a config file: the binding is not merely configured, it ran.
    //
    // The overlay assertions above cover the rendered intent; this covers the
    // effect. Together they close the silent-no-op hole: with the duplicate
    // `service` key, the supervisor discarded the overlay and this directory
    // stayed empty while the Pod reported Ready.
    const queueDirectory = '/var/lib/otelcol/file_storage';
    const claimName = `${stackName}-otel-queue`;

    // The extension creates the database at startup, but the collector may
    // still be rolling; poll rather than race it.
    const deadline = Date.now() + 300_000;
    let listing = '';
    while (Date.now() < deadline) {
      listing = (
        await runTestPodAndReadLogs(
          {
            namespace: stackNs,
            name: `queuedb-${crypto.randomUUID().slice(0, 6)}`,
            image: 'busybox:1.37',
            command: [
              'sh',
              '-c',
              // `-a` so nothing is hidden, and dump the first 4 bytes of every
              // regular file: bbolt stamps 0xED0CDAED as the page-0 magic.
              `set -eu; ls -la ${queueDirectory}; ` +
                `for f in ${queueDirectory}/*; do ` +
                `  [ -f "$f" ] || continue; ` +
                `  echo "MAGIC $f $(od -An -tx1 -N4 "$f" | tr -d ' \\n')"; ` +
                'done',
            ],
            volumes: [{ name: 'queue', persistentVolumeClaim: { claimName } }],
            volumeMounts: [{ name: 'queue', mountPath: queueDirectory }],
            timeoutMs: 240_000,
          },
          kubeConfig
        )
      ).trim();
      if (/^MAGIC /m.test(listing)) break;
      await Bun.sleep(10_000);
    }
    console.log(`[queue] contents of ${queueDirectory}:\n${listing}`);

    const magicLines = listing
      .split('\n')
      .filter((line) => line.startsWith('MAGIC '))
      .map((line) => {
        const [, path, magic] = line.split(' ');
        return { file: (path ?? '').replace(`${queueDirectory}/`, ''), magic: magic ?? '' };
      });
    expect(magicLines.length).toBeGreaterThan(0);

    // Every configured exporter has at least one database file named for it.
    for (const exporterName of DEFAULT_QUEUE_EXPORTER_NAMES) {
      const own = magicLines.filter((entry) => entry.file.startsWith(`exporter_${exporterName}`));
      expect(
        own.length,
        `no file_storage database for exporter '${exporterName}' in ${JSON.stringify(
          magicLines.map((entry) => entry.file)
        )}`
      ).toBeGreaterThan(0);
      // …and it really is a bbolt database, not an empty placeholder. bolt
      // writes its magic as a native-endian uint32, so accept either order
      // rather than pinning the test to the runner's architecture.
      for (const entry of own) {
        // 0xED0CDAED: "ed0cdaed" big-endian, "edda0ced" little-endian.
        expect(entry.magic).toMatch(/^(ed0cdaed|edda0ced)$/);
      }
    }
  }, 600_000);

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

  it('proves an immutable plain_rewritable table REFUSES the retention ALTER', async () => {
    // This is why `resolveClickStackStorage` rejects
    // `retention` + `diskType: 's3_plain_rewritable'` at construction. The OTel
    // tables here live on the s3_plain_rewritable policy (asserted above), and
    // `materialize_ttl_after_modify = 0` does not save the statement: it only
    // skips the materialization MUTATION, while it is the metadata ALTER
    // itself that the immutable metadata type refuses.
    let message = '';
    try {
      await query(
        'ALTER TABLE `otel_logs` MODIFY TTL toDateTime(Timestamp) + INTERVAL 7 DAY DELETE ' +
          'SETTINGS materialize_ttl_after_modify = 0',
        'ttlrefused'
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe('');
    expect(message).toMatch(/immutable disk|SUPPORT_IS_DISABLED/);

    // The identical statement on the server's LOCAL policy succeeds, so the
    // refusal is a property of the disk type and not of the statement.
    await query(
      'CREATE TABLE IF NOT EXISTS ttl_local_probe (ts DateTime, v String) ' +
        "ENGINE = MergeTree ORDER BY ts SETTINGS storage_policy = 'default'",
      'ttllocalcreate'
    );
    await query(
      'ALTER TABLE ttl_local_probe MODIFY TTL toDateTime(ts) + INTERVAL 7 DAY DELETE ' +
        'SETTINGS materialize_ttl_after_modify = 0',
      'ttllocalalter'
    );
  }, 900_000);

  it('reads back the COMPLETE TTL clause the idempotence probe compares', async () => {
    // The retention CronJob's idempotence check extracts the whole TTL clause
    // out of `engine_full` and compares it for EQUALITY. Both halves run
    // against a real server here rather than against a rendered string: the
    // extraction SQL is the exact expression the generated script uses, and
    // the expected clauses come from the resolver.
    //
    // The collector's own migration sets `toDateTime(Timestamp) +
    // toIntervalDay(30)`, so a resolver asked for 30d must say "already
    // applied" and one asked for 7d must say "needs a change" — which is
    // precisely the discrimination the old substring probe got wrong.
    const extracted = await query(
      "SELECT trim(replaceRegexpAll(extract(replaceRegexpOne(engine_full, ' SETTINGS .*', ''), " +
        "'TTL (.*)'), '[[:space:]]+', ' ')) FROM system.tables " +
        "WHERE database = 'default' AND name = 'otel_logs'",
      'ttlclause'
    );

    const { resolveClickStackStorage, ttlAlreadyApplied } = await import(
      '../../../src/factories/clickstack/utils/storage.js'
    );
    function entryFor(duration: string) {
      const entry = resolveClickStackStorage('integration', {
        mode: 's3',
        retention: { logs: duration },
      }).retentionEntries.find((candidate) => candidate.table === 'otel_logs');
      if (entry === undefined) throw new Error('expected an otel_logs entry');
      return entry;
    }

    // The clause comes back WHOLE: no ` SETTINGS …` tail, no `TTL ` prefix.
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted).not.toContain('SETTINGS');
    expect(extracted).not.toContain('TTL ');
    expect(extracted).toBe('toDateTime(Timestamp) + toIntervalDay(30)');

    expect(ttlAlreadyApplied(extracted, entryFor('30d'))).toBe(true);
    expect(ttlAlreadyApplied(extracted, entryFor('7d'))).toBe(false);
    // The near miss that broke the old substring probe: 'toIntervalDay(3)'
    // occurs inside the live 'toIntervalDay(30)'.
    expect(ttlAlreadyApplied(extracted, entryFor('3d'))).toBe(false);
  }, 900_000);

  it('keeps the collector queue directory across a collector Pod restart', async () => {
    // THE POINT OF THE PVC: an emptyDir dies with the Pod and a generic
    // ephemeral volume's claim is deleted with the Pod that owns it, so
    // neither would survive this. A standalone claim does.
    const coreApi = createCoreV1ApiClient(kubeConfig);
    const claimName = `${stackName}-otel-queue`;
    const queueDirectory = '/var/lib/otelcol/file_storage';
    const sentinel = `${queueDirectory}/typekro-queue-sentinel`;
    const sentinelValue = crypto.randomUUID();

    /** Mount the queue claim from a throwaway Pod and run a script on it. */
    async function onQueueVolume(label: string, script: string): Promise<string> {
      return (
        await runTestPodAndReadLogs(
          {
            namespace: stackNs,
            name: `queue-${label}-${crypto.randomUUID().slice(0, 6)}`,
            image: 'busybox:1.37',
            command: ['sh', '-c', script],
            volumes: [{ name: 'queue', persistentVolumeClaim: { claimName } }],
            volumeMounts: [{ name: 'queue', mountPath: queueDirectory }],
            timeoutMs: 240_000,
          },
          kubeConfig
        )
      ).trim();
    }

    const claimBefore = await coreApi.readNamespacedPersistentVolumeClaim({
      namespace: stackNs,
      name: claimName,
    });
    // The collector Pod has been running since the deploy step, so a
    // WaitForFirstConsumer claim is bound by now.
    expect(claimBefore.status?.phase).toBe('Bound');
    const volumeBefore = claimBefore.spec?.volumeName ?? '';
    expect(volumeBefore).not.toBe('');

    // A sentinel written THROUGH the claim is indistinguishable, as far as the
    // volume is concerned, from a queue file the collector wrote.
    await onQueueVolume(
      'write',
      `set -eu; printf '%s' '${sentinelValue}' > ${sentinel}; ls -l ${queueDirectory}`
    );

    const collectorSelector = 'app.kubernetes.io/name=hdx-oss-v2-otel-collector';
    const collectorsBefore = await coreApi.listNamespacedPod({
      namespace: stackNs,
      labelSelector: collectorSelector,
    });
    // The subchart's label values are chart-version-dependent, so fall back to
    // matching the Pod name the release produces rather than failing on a
    // label rename.
    const allPods = await coreApi.listNamespacedPod({ namespace: stackNs });
    const collectorPods =
      collectorsBefore.items.length > 0
        ? collectorsBefore.items
        : allPods.items.filter((pod) => pod.metadata?.name?.includes('otel-collector'));
    const oldPodName = collectorPods[0]?.metadata?.name;
    expect(oldPodName).toBeDefined();

    await coreApi.deleteNamespacedPod({ namespace: stackNs, name: oldPodName as string });

    // Wait for the Deployment to bring a DIFFERENT Pod up and running.
    const deadline = Date.now() + 600_000;
    let newPodName: string | undefined;
    while (Date.now() < deadline) {
      const pods = await coreApi.listNamespacedPod({ namespace: stackNs });
      const candidate = pods.items.find(
        (pod) =>
          pod.metadata?.name?.includes('otel-collector') &&
          pod.metadata.name !== oldPodName &&
          pod.status?.phase === 'Running'
      );
      if (candidate !== undefined) {
        newPodName = candidate.metadata?.name;
        break;
      }
      await Bun.sleep(10_000);
    }
    expect(newPodName).toBeDefined();
    expect(newPodName).not.toBe(oldPodName);

    // The claim survived the Pod, still bound to the SAME PersistentVolume…
    const claimAfter = await coreApi.readNamespacedPersistentVolumeClaim({
      namespace: stackNs,
      name: claimName,
    });
    expect(claimAfter.status?.phase).toBe('Bound');
    expect(claimAfter.spec?.volumeName).toBe(volumeBefore);

    // …and so did the contents of the queue directory.
    const readBack = await onQueueVolume('read', `set -eu; cat ${sentinel}`);
    expect(readBack).toBe(sentinelValue);

    // The replacement Pod mounts that same claim, so the queue it resumes from
    // is the directory that just survived.
    const newPod = await coreApi.readNamespacedPod({
      namespace: stackNs,
      name: newPodName as string,
    });
    const mountedClaims = (newPod.spec?.volumes ?? [])
      .map((volume) => volume.persistentVolumeClaim?.claimName)
      .filter((name): name is string => name !== undefined);
    expect(mountedClaims).toContain(claimName);
  }, 1_200_000);

  it('completes a REAL rollout on Recreate instead of deadlocking on the queue', async () => {
    // WHY THIS IS NOT THE PREVIOUS TEST: deleting the collector Pod is not a
    // rollout. The Deployment controller replaces a deleted Pod only after it
    // is gone, so that path never puts two collectors on the claim and would
    // pass just as happily under RollingUpdate. The overlap only appears when
    // the POD TEMPLATE changes: RollingUpdate's default maxSurge rounds up to
    // one extra Pod, so it creates the replacement while the old collector
    // still holds the ReadWriteOnce claim and the bbolt lock — a Multi-Attach
    // deadlock on another node, and a silent two-writer window on the same one
    // (readiness comes from the supervisor's health_check, not from the queue
    // extension). This test changes the template for real, requires the rollout
    // to finish, and requires it never to have two live collectors at once —
    // the last of which is exactly what a RollingUpdate surge would produce.
    // PROGRESS MARKERS, deliberately. This case has the suite's longest wall
    // clock, and when it stalled the runner printed nothing at all for it — a
    // pass/fail line only appears once a case ends, so a silent hang is
    // indistinguishable from a slow one. Every phase announces itself.
    const step = (message: string) =>
      console.log(`[rollout ${new Date().toISOString()}] ${message}`);
    step('start');

    const coreApi = createCoreV1ApiClient(kubeConfig);
    const appsApi = createAppsV1ApiClient(kubeConfig);
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const claimName = `${stackName}-otel-queue`;
    const queueDirectory = '/var/lib/otelcol/file_storage';

    /** Collector Pods that are not already on their way out. */
    async function liveCollectorPods(): Promise<string[]> {
      const pods = await coreApi.listNamespacedPod({ namespace: stackNs });
      return pods.items
        .filter(
          (pod) =>
            pod.metadata?.name?.includes('otel-collector') &&
            pod.metadata.deletionTimestamp === undefined
        )
        .map((pod) => pod.metadata?.name ?? '');
    }

    /** Mount the queue claim from a throwaway Pod and run a script on it. */
    async function onQueueVolume(label: string, script: string): Promise<string> {
      return (
        await runTestPodAndReadLogs(
          {
            namespace: stackNs,
            name: `rollout-${label}-${crypto.randomUUID().slice(0, 6)}`,
            image: 'busybox:1.37',
            command: ['sh', '-c', script],
            volumes: [{ name: 'queue', persistentVolumeClaim: { claimName } }],
            volumeMounts: [{ name: 'queue', mountPath: queueDirectory }],
            timeoutMs: 240_000,
          },
          kubeConfig
        )
      ).trim();
    }

    step('reading the collector Deployment');
    const deployments = await appsApi.listNamespacedDeployment({ namespace: stackNs });
    const collectorDeployment = deployments.items.find((deployment) =>
      deployment.metadata?.name?.includes('otel-collector')
    );
    expect(collectorDeployment).toBeDefined();
    const deploymentName = collectorDeployment?.metadata?.name as string;

    // (a) The rendered `rollout.strategy` reached the live object.
    expect(collectorDeployment?.spec?.strategy?.type).toBe('Recreate');
    // …and carries no rollingUpdate block, which the API server would reject
    // next to Recreate. The chart's own template guard is what removes it.
    expect(collectorDeployment?.spec?.strategy?.rollingUpdate).toBeUndefined();
    expect(collectorDeployment?.spec?.replicas).toBe(1);

    const sentinel = `${queueDirectory}/typekro-rollout-sentinel`;
    const sentinelValue = crypto.randomUUID();
    step('writing the queue sentinel through the claim');
    await onQueueVolume(
      'write',
      `set -eu; printf '%s' '${sentinelValue}' > ${sentinel}; ls -l ${queueDirectory}`
    );

    step('reading the claim and the live collector Pods');
    const claimBefore = await coreApi.readNamespacedPersistentVolumeClaim({
      namespace: stackNs,
      name: claimName,
    });
    const volumeBefore = claimBefore.spec?.volumeName ?? '';
    expect(volumeBefore).not.toBe('');

    const podsBefore = await liveCollectorPods();
    expect(podsBefore.length).toBe(1);
    const oldPodName = podsBefore[0] as string;
    const generationBefore = collectorDeployment?.metadata?.generation ?? 0;

    // (b) A GENUINE template change, made the way a user would make one: a new
    // pod annotation through the HelmRelease's values, which Flux rolls into
    // the Deployment's pod template. `add` on an existing object replaces it,
    // and the chart's own checksum annotation is deep-merged back in by Helm.
    const probeValue = crypto.randomUUID();
    step(`patching the HelmRelease with rollout probe ${probeValue}`);
    await customApi.patchNamespacedCustomObject({
      group: 'helm.toolkit.fluxcd.io',
      version: 'v2',
      namespace: stackNs,
      plural: 'helmreleases',
      name: stackName,
      body: [
        {
          op: 'add',
          path: '/spec/values/otel-collector/podAnnotations',
          value: { 'typekro.dev/rollout-probe': probeValue },
        },
      ],
    });

    const startedAt = Date.now();
    step('waiting for Flux to roll the annotation into the pod template');

    // Flux has to run the upgrade before the Deployment's template changes.
    const templateDeadline = Date.now() + 900_000;
    let templateUpdated = false;
    while (Date.now() < templateDeadline) {
      const deployment = await appsApi.readNamespacedDeployment({
        namespace: stackNs,
        name: deploymentName,
      });
      if (
        deployment.spec?.template?.metadata?.annotations?.['typekro.dev/rollout-probe'] ===
        probeValue
      ) {
        templateUpdated = true;
        expect(deployment.metadata?.generation ?? 0).toBeGreaterThan(generationBefore);
        // The upgrade must not have quietly reverted the strategy.
        expect(deployment.spec?.strategy?.type).toBe('Recreate');
        break;
      }
      await Bun.sleep(5_000);
    }
    expect(templateUpdated).toBe(true);
    const templateAt = Date.now();
    step(`pod template carries the probe after ${Math.round((templateAt - startedAt) / 1000)}s`);
    step('waiting for the rollout to complete');

    // (c) The rollout itself must FINISH — this is the assertion RollingUpdate
    // would fail. Equivalent to `kubectl rollout status`: the controller has
    // observed the new generation, every replica is updated, and none is
    // unavailable. Along the way, count live collector Pods: Recreate must
    // never have two of them contending for the claim.
    const rolloutDeadline = Date.now() + 900_000;
    let rolledOut = false;
    let maxLivePods = 0;
    let lastState = 'no status yet';
    while (Date.now() < rolloutDeadline) {
      maxLivePods = Math.max(maxLivePods, (await liveCollectorPods()).length);
      const deployment = await appsApi.readNamespacedDeployment({
        namespace: stackNs,
        name: deploymentName,
      });
      const status = deployment.status ?? {};
      const desired = deployment.spec?.replicas ?? 1;
      lastState = JSON.stringify({
        observedGeneration: status.observedGeneration,
        updated: status.updatedReplicas,
        ready: status.readyReplicas,
        available: status.availableReplicas,
        unavailable: status.unavailableReplicas,
      });
      if (
        (status.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
        status.updatedReplicas === desired &&
        status.readyReplicas === desired &&
        status.availableReplicas === desired &&
        (status.unavailableReplicas ?? 0) === 0
      ) {
        rolledOut = true;
        break;
      }
      await Bun.sleep(5_000);
    }
    const finishedAt = Date.now();
    step(`rollout loop finished (rolledOut=${rolledOut})`);
    console.log(
      `[rollout] helm upgrade reached the template in ${Math.round(
        (templateAt - startedAt) / 1000
      )}s; rollout completed in ${Math.round(
        (finishedAt - templateAt) / 1000
      )}s; max concurrent live collector Pods: ${maxLivePods}`
    );
    expect(rolledOut, `rollout never completed; last status ${lastState}`).toBe(true);

    // Recreate's whole contract: the old collector is gone before the new one
    // exists, so the single-writer queue never has two claimants.
    expect(maxLivePods).toBeLessThanOrEqual(1);

    // A genuinely NEW Pod ran, carrying the annotation that caused the roll.
    const podsAfter = await liveCollectorPods();
    expect(podsAfter.length).toBe(1);
    const newPodName = podsAfter[0] as string;
    expect(newPodName).not.toBe(oldPodName);
    const newPod = await coreApi.readNamespacedPod({ namespace: stackNs, name: newPodName });
    expect(newPod.metadata?.annotations?.['typekro.dev/rollout-probe']).toBe(probeValue);

    // It mounts the SAME claim, still bound to the same PersistentVolume…
    const mountedClaims = (newPod.spec?.volumes ?? [])
      .map((volume) => volume.persistentVolumeClaim?.claimName)
      .filter((name): name is string => name !== undefined);
    expect(mountedClaims).toContain(claimName);
    const claimAfter = await coreApi.readNamespacedPersistentVolumeClaim({
      namespace: stackNs,
      name: claimName,
    });
    expect(claimAfter.status?.phase).toBe('Bound');
    expect(claimAfter.spec?.volumeName).toBe(volumeBefore);

    // …and the queue directory came through the rollout intact, which is what
    // makes the brief outage Recreate costs an acceptable trade.
    step('reading the sentinel back through the claim');
    expect(await onQueueVolume('read', `set -eu; cat ${sentinel}`)).toBe(sentinelValue);
    step('done');
  }, 2_400_000);
});
