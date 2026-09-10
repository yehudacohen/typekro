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
import { DEFAULT_CLICKSTACK_VERSION } from '../../../src/factories/clickstack/resources/helm.js';
import type { ClickStackBootstrapStatus } from '../../../src/factories/clickstack/types.js';
import { DEFAULT_QUEUE_EXPORTER_NAMES } from '../../../src/factories/clickstack/utils/storage.js';
import { type BackgroundSampler, startBackgroundSampler } from '../../utils/background-sampler.js';
import { deployMinio, type MinioFixture } from '../minio-fixture.js';
import { waitUntilGone } from '../shared-absence.js';
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
  runWithExpectedTestNamespace,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';
import {
  assertClickStackS3StatusContract,
  readClickStackHelmRelease,
} from './shared-clickstack-s3-e2e.js';

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

  /**
   * WHY THIS SUITE NARRATES ITSELF, AND FAILS FAST.
   *
   * Two things together made a previous run look like a hang, and neither was
   * a hang:
   *
   * 1. `bun test` prints NOTHING per case when stdout is not a TTY — no
   *    `(pass)`, no `(fail)`, only the final `N pass / N fail` summary. A run
   *    that has not reached its summary is therefore completely silent, and
   *    looks identical whether it is one minute from finishing or wedged.
   *    (Verified against this suite's own earlier logs: an 11-case run that
   *    exited 0 in 325s contains zero per-case lines.)
   * 2. The cases are ORDERED AND STATEFUL — every one after the deploy uses
   *    the stack it created — and each carries a multi-minute poll budget
   *    (600s for rows to land, 900s for a rollout, 240s per probe Pod). When a
   *    shared precondition broke, every later case waited out its FULL budget
   *    before failing. Once the rollout case (up to 900s + 900s + three probe
   *    Pods) joined them, the file's worst case ran well past an hour with no
   *    output at all. The previous run was killed at ~24 minutes having
   *    printed nothing, and the case that happened to be running took the
   *    blame for a cost the whole suite shared.
   *
   * `orderedCase` fixes both. It timestamps the start and end of every case,
   * so the run is never silent, and it records the first failure so every
   * later dependent case fails IMMEDIATELY instead of polling a stack that is
   * not coming. The suite always reaches its summary.
   */
  let firstFailure: string | undefined;

  function phase(message: string): void {
    console.log(`[s3-backed ${new Date().toISOString()}] ${message}`);
  }

  function orderedCase(name: string, body: () => Promise<void>, timeoutMs: number): void {
    it(
      name,
      async () => {
        if (firstFailure !== undefined) {
          phase(`SKIP-FAST ${name}`);
          throw new Error(
            `Not attempted: an earlier case in this ordered suite failed first — ` +
              `${firstFailure}. Every case here polls for minutes, so the rest fail ` +
              `fast rather than waiting out their budgets and starving the runner of ` +
              `a summary. Fix the first failure and re-run.`
          );
        }
        phase(`START ${name}`);
        const startedAt = Date.now();
        try {
          await body();
        } catch (error: unknown) {
          firstFailure = `"${name}" (${error instanceof Error ? error.message : String(error)})`;
          phase(`FAIL  ${name} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
          throw error;
        }
        phase(`PASS  ${name} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      },
      timeoutMs
    );
  }

  orderedCase(
    'deploys the Altinity operator scoped to the CHI namespace',
    async () => {
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

      // `waitForReady: true` is the whole gate. Before the #191 fix the shared
      // Helm readiness evaluator accepted a state that was not yet
      // `Ready=True` with the current generation observed, so `deploy()`
      // returned before Flux had finished installing and this suite had to
      // poll the live HelmRelease itself. The evaluator now also requires
      // `Reconciling` to be clear and the attempted revision to be the
      // released one, so the returned snapshot IS evidence.
      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Ready');
      expect(instance.status.failed).toBe(false);
    },
    900_000
  );

  orderedCase(
    'deploys an S3-backed ClickHouse for ClickStack to write to',
    async () => {
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
    },
    1_200_000
  );

  orderedCase(
    'deploys clickstack with retention and a persistent collector queue',
    async () => {
      expect(clickhouseHost).toBeDefined();
      const { makeClickstackBootstrap } = await import(
        '../../../src/factories/clickstack/index.js'
      );

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

      // THE WHOLE DECLARED STATUS CONTRACT, through the SHARED assertion the
      // KRO-mode case below also calls. Direct mode hydrates status client-side
      // (the cel-js reference resolver over the live HelmRelease and contract
      // ConfigMap) and KRO evaluates the same expressions server-side, so
      // neither mode gets to pass on a subset of the fields the schema
      // promises. `version` in particular is read off the owned HelmRelease's
      // chart pin, so this proves the projection in both modes.
      assertClickStackS3StatusContract(instance.status, {
        instanceName: stackName,
        namespace: stackNs,
        chartVersion: DEFAULT_CLICKSTACK_VERSION,
        helmRelease: await readClickStackHelmRelease(stackNs, stackName, kubeConfig),
        storage: { mode: 's3', diskType: 's3_plain_rewritable', persistentQueue: true },
      });
      gatewayEndpoint = instance.status.gateway.otlpHttpEndpoint;
    },
    1_500_000
  );

  orderedCase(
    "keeps the chart's custom-config mount alongside the queue volume",
    async () => {
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
    },
    300_000
  );

  orderedCase(
    'renders ONE overlay document, and the OpAMP supervisor merges it',
    async () => {
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
        expect(parsed.exporters?.[exporterName]?.sending_queue?.storage).toBe(
          'file_storage/hyperdx'
        );
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

      // A clean log is only half the statement — an overlay that was never read
      // also produces no merge error. LIVE-VERIFIED line, emitted by the image's
      // entrypoint before the supervisor starts: the file was actually picked up.
      const pickedUp = supervisorLog
        .split('\n')
        .filter((line) =>
          line.includes(
            'Using custom OTEL config file: /etc/otelcol-contrib/custom/custom.config.yaml'
          )
        );
      console.log(`[supervisor] overlay pick-up lines: ${JSON.stringify(pickedUp)}`);
      expect(pickedUp.length).toBeGreaterThan(0);
      // The supervisor also connected, which is what makes the merge happen at
      // all — a supervisor stuck dialling OpAMP never reaches the merge step.
      expect(supervisorLog).toContain('Connected to the OpAMP server.');
    },
    300_000
  );

  orderedCase(
    'renders no retention CronJob for an immutable plain_rewritable ClickHouse',
    async () => {
      const batchApi = createBunCompatibleBatchV1Api(kubeConfig);
      const cronJobs = await batchApi.listNamespacedCronJob({ namespace: stackNs });
      const names = cronJobs.items.map((job) => job.metadata?.name ?? '');
      // The Team bootstrap CronJob is always there; a retention one would
      // CrashLoop forever on this disk type, so it must not exist.
      expect(names.some((name) => name.includes('team-bootstrap'))).toBe(true);
      expect(names.some((name) => name.includes('otel-retention'))).toBe(false);
    },
    300_000
  );

  orderedCase(
    'lands the collector-created OTel tables on the S3 policy with no per-table DDL',
    async () => {
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
        phase(`  otel_logs not migrated yet; ${Math.round((deadline - Date.now()) / 1000)}s left`);
        await Bun.sleep(10_000);
      }

      expect(policy).toBe('s3_main');
    },
    900_000
  );

  orderedCase(
    'ingests OTLP logs through the gateway and stores the parts on the S3 disks',
    async () => {
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
        phase(`  no probe rows yet; ${Math.round((deadline - Date.now()) / 1000)}s left`);
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
    },
    900_000
  );

  orderedCase(
    'backs each queued exporter with a bbolt database on the PVC',
    async () => {
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
                // `-a` so nothing is hidden, plus bbolt's magic from every
                // regular file. LIVE-VERIFIED OFFSET: the magic is at byte 16,
                // not byte 0 — bolt's meta page begins with a 16-byte page
                // header (id uint64, flags uint16, count uint16, overflow
                // uint32) and page 0's id is zero, so the first eight bytes of a
                // healthy database read as 00 00 00 00 00 00 00 00.
                `set -eu; ls -la ${queueDirectory}; ` +
                  `for f in ${queueDirectory}/*; do ` +
                  `  [ -f "$f" ] || continue; ` +
                  `  echo "MAGIC $f $(dd if="$f" bs=1 skip=16 count=4 2>/dev/null | ` +
                  `od -An -tx1 | tr -d ' \\n')"; ` +
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
        phase(`  queue directory still empty; ${Math.round((deadline - Date.now()) / 1000)}s left`);
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
        // rather than pinning the test to the cluster node's architecture.
        // LIVE-OBSERVED on arm64: `ed da 0c ed`.
        for (const entry of own) {
          // 0xED0CDAED: "ed0cdaed" big-endian, "edda0ced" little-endian.
          expect(entry.magic, `${entry.file} is not a bbolt database`).toMatch(
            /^(ed0cdaed|edda0ced)$/
          );
        }
      }
    },
    600_000
  );

  orderedCase(
    'keeps the telemetry queryable after the ClickHouse pod is deleted',
    async () => {
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
        phase(`  ClickHouse not back yet; ${Math.round((deadline - Date.now()) / 1000)}s left`);
        await Bun.sleep(10_000);
      }

      expect(Number(rows)).toBeGreaterThan(0);
    },
    900_000
  );

  orderedCase(
    'proves an immutable plain_rewritable table REFUSES the retention ALTER',
    async () => {
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
    },
    900_000
  );

  orderedCase(
    'reads back the COMPLETE TTL clause the idempotence probe compares',
    async () => {
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
    },
    900_000
  );

  orderedCase(
    'keeps the collector queue directory across a collector Pod restart',
    async () => {
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
        phase(
          `  replacement collector not Running yet; ${Math.round((deadline - Date.now()) / 1000)}s left`
        );
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
    },
    1_200_000
  );

  orderedCase(
    'completes a REAL rollout on Recreate instead of deadlocking on the queue',
    async () => {
      // ⚠️ THE SAMPLER'S CLEANUP IS THE OUTERMOST THING IN THIS CASE, and it has
      // to be. It used to be an inline `let sampling = true` loop cleared at the
      // BOTTOM of the body, so a failed patch, a failed API call or a failed
      // `expect` — every interesting way this case can fail — skipped the stop and
      // left it polling the cluster forever. `bun test` cannot interrupt a busy
      // async loop, so the run then HUNG after the failure and buried the real
      // error under a timeout: the leak did not merely leak, it destroyed this
      // case's ability to report why it failed. The handle is declared out here and
      // stopped in a `finally` around the whole body, so no exit path can miss it.
      // See `test/utils/background-sampler.ts`, whose cleanup contract is
      // unit-tested without a cluster.
      let sampler: BackgroundSampler<number> | undefined;
      try {
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
        // ⚠️ SAMPLE ACROSS THE TRANSITION, NOT AFTER IT. The two-writer assertion
        // is this case's headline claim, and counting live Pods only inside the
        // rollout-status loop can miss the window entirely. LIVE-OBSERVED: Flux's
        // upgrade AND the whole Recreate rollout finished inside the 5s gap
        // between two template polls, so the status loop's very first read
        // already reported the rollout complete ("completed in 0s") and every
        // Pod count it took was 1 because there was nothing left to see. A count
        // of 1 taken after the fact is not evidence of anything. Sampling
        // therefore starts BEFORE the patch and runs continuously at 500ms until
        // the rollout is done, and the case asserts it took enough samples for
        // the claim to mean something.
        //
        // HERE, and not at the top of the body: the window that has to be
        // covered is the transition, and samples taken while the earlier probe
        // Pods run would inflate the count until the "enough samples" guard
        // below stopped meaning anything. Cleanup does not depend on that
        // choice — the `finally` above covers every failure from this line
        // onwards, and a failure before it cannot leak a sampler that does not
        // exist yet.
        sampler = startBackgroundSampler({
          // A transient list failure is recorded as a miss by the sampler, not
          // raised: it must not decide the rollout assertion, and a rejection
          // in a promise nothing is awaiting yet would take the process down.
          sample: async () => (await liveCollectorPods()).length,
          intervalMs: 500,
        });

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
        //
        // ⚠️ BUDGETED, NOT GENEROUS. This case used to allow 900s here and another
        // 900s below, plus three probe Pods at 240s each — a worst case that
        // EXCEEDED the case's own declared timeout, so the runner could not even
        // report a clean per-case timeout for it, and did it all in silence. The
        // budgets below sum to well under that timeout on purpose. Flux's default
        // reconcile interval for this release is minutes, not tens of minutes; if
        // 600s is not enough, the upgrade is stuck and waiting longer only hides
        // it.
        const templateDeadline = Date.now() + 600_000;
        let templateUpdated = false;
        let lastTemplateReport = 0;
        while (Date.now() < templateDeadline) {
          if (Date.now() - lastTemplateReport > 60_000) {
            lastTemplateReport = Date.now();
            step(
              `still waiting for the pod template (${Math.round((Date.now() - startedAt) / 1000)}s)`
            );
          }
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
        step(
          `pod template carries the probe after ${Math.round((templateAt - startedAt) / 1000)}s`
        );
        step('waiting for the rollout to complete');

        // (c) The rollout itself must FINISH — this is the assertion RollingUpdate
        // would fail. Equivalent to `kubectl rollout status`: the controller has
        // observed the new generation, every replica is updated, and none is
        // unavailable. Along the way, count live collector Pods: Recreate must
        // never have two of them contending for the claim.
        // 300s: Recreate on ONE replica is a delete followed by a create, and the
        // image is already on the node. A rollout that has not finished in five
        // minutes is the deadlock this case exists to detect, and reporting that
        // promptly is the point.
        const rolloutDeadline = Date.now() + 300_000;
        let rolledOut = false;
        let lastState = 'no status yet';
        let lastRolloutReport = 0;
        while (Date.now() < rolloutDeadline) {
          if (Date.now() - lastRolloutReport > 60_000) {
            lastRolloutReport = Date.now();
            step(
              `still rolling out (${Math.round((Date.now() - templateAt) / 1000)}s): ${lastState}`
            );
          }
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
        // Stop and AWAIT the loop before reading its samples, so the numbers
        // reported and asserted below are final rather than a racing snapshot.
        // The `finally` calls this again; `stop()` is idempotent.
        await sampler.stop();
        const liveSamples = sampler.samples.length;
        const maxLivePods = sampler.samples.reduce((most, count) => Math.max(most, count), 0);
        step(`rollout loop finished (rolledOut=${rolledOut})`);
        console.log(
          `[rollout] helm upgrade reached the template in ${Math.round(
            (templateAt - startedAt) / 1000
          )}s; rollout completed in ${Math.round(
            (finishedAt - templateAt) / 1000
          )}s; max concurrent live collector Pods: ${maxLivePods} over ${liveSamples} samples ` +
            `spanning ${Math.round((finishedAt - startedAt) / 1000)}s` +
            // Reported, never fatal — but a run where most samples failed is a
            // run whose two-writer claim rests on very little, and that should
            // be visible in the log rather than inferred from the count.
            `; ${sampler.errors.length} sample(s) failed`
        );
        expect(rolledOut, `rollout never completed; last status ${lastState}`).toBe(true);

        // Recreate's whole contract: the old collector is gone before the new one
        // exists, so the single-writer queue never has two claimants.
        //
        // The SAMPLE COUNT is asserted first, and deliberately. `maxLivePods <= 1`
        // is vacuous if nothing was watching while the Pods changed over, so the
        // claim is only worth making next to evidence that the window was
        // covered. The lower bound on `maxLivePods` is the same guard from the
        // other side: zero would mean the sampler never saw a collector at all.
        expect(
          liveSamples,
          `only ${liveSamples} live-Pod samples were taken across the rollout — too few to ` +
            `substantiate the never-two-collectors claim`
        ).toBeGreaterThanOrEqual(4);
        expect(maxLivePods).toBeGreaterThanOrEqual(1);
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
      } finally {
        // Idempotent, and it AWAITS the loop's exit — so by the time this case
        // returns, pass or fail, nothing of it is still talking to the cluster.
        await sampler?.stop();
      }
    },
    2_400_000
  );

  // ── KRO mode: the same S3-backed bootstrap through the RGD path ───────────
  //
  // The guide requires live DIRECT AND KRO execution for a dependency-managing
  // integration, and every case above is direct-only. This block runs the SAME
  // `makeClickstackBootstrap({ storage: { mode: 's3' } })` against the SAME
  // S3-backed ClickHouse through `factory('kro')`, and proves the complete
  // lifecycle: the RGD is accepted and Active, the instance reconciles, EVERY
  // declared status field is observed on the live CR, the KRO-GENERATED
  // in-cluster HelmRelease's final `spec.values` is what the chart actually
  // received, the pods are genuinely healthy, and `deleteInstance()` takes the
  // whole graph with it through KRO's finalizer.
  //
  // It runs LAST on purpose: it depends on the ClickHouse the direct cases
  // built, and the direct cases must not wait on it.
  orderedCase(
    'deploys the same S3-backed stack through factory("kro") and cleans up after itself',
    async () => {
      expect(clickhouseHost).toBeDefined();
      const { makeClickstackBootstrap } = await import(
        '../../../src/factories/clickstack/index.js'
      );
      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const coreApi = createCoreV1ApiClient(kubeConfig);

      // The bootstrap OWNS its Namespace, so the harness proves absence first
      // and captures the resulting UID lease even on a partial failure — a
      // name-only helper would be unsafe here because teardown deletes it.
      const kroStackNs = `clickstack-s3-kro-${crypto.randomUUID().slice(0, 8)}`;
      const bootstrap = makeClickstackBootstrap({
        name: 'clickstack-s3-kro',
        kind: 'ClickStackS3Kro',
        mongo: { mode: 'internal' as const, storage: { storageClassName: storageClass } },
        storage: {
          mode: 's3',
          // Same immutable metadata type as the CHI these values point at, so
          // no retention CronJob is rendered (the factory rejects that pair).
          diskType: 's3_plain_rewritable',
          persistentQueue: { enabled: true },
        },
      });
      const kroFactory = bootstrap.factory('kro', {
        namespace: kroStackNs,
        waitForReady: true,
        timeout: 1_200_000,
        kubeConfig,
      });
      const kroInstanceName = 'clickstack-kro';
      const kroApiKey = crypto.randomUUID();
      let deploymentAttempted = false;
      // REST plural of the generated CRD, DISCOVERED rather than guessed —
      // Kubernetes pluralization of a kind containing a digit is not something
      // a test should encode by hand.
      let kroPlural = '';

      const discoverGeneratedPlural = async (): Promise<string> => {
        const raw = (await customApi.listClusterCustomObject({
          group: 'apiextensions.k8s.io',
          version: 'v1',
          plural: 'customresourcedefinitions',
        })) as { body?: unknown };
        const list = (raw.body ?? raw) as {
          items?: { spec?: { group?: string; names?: { kind?: string; plural?: string } } }[];
        };
        const generated = (list.items ?? []).find(
          (crd) => crd.spec?.group === 'kro.run' && crd.spec?.names?.kind === 'ClickStackS3Kro'
        );
        const plural = generated?.spec?.names?.plural;
        if (plural === undefined) {
          throw new Error('No generated CRD found for kind ClickStackS3Kro in group kro.run');
        }
        return plural;
      };

      try {
        const instance = await runWithExpectedTestNamespace(
          kroStackNs,
          kubeConfig,
          (lease) => namespaceLeases.push(lease),
          async () => {
            deploymentAttempted = true;
            return kroFactory.deploy({
              name: kroInstanceName,
              namespace: kroStackNs,
              clickhouse: {
                host: clickhouseHost as string,
                username: chiUser,
                password: chiUserPassword,
              },
              apiKey: kroApiKey,
            });
          }
        );

        expect(instance.status.ready).toBe(true);
        phase('KRO instance reported ready');

        // 1. THE RGD REACHED Active=True on the live cluster.
        const rgdRaw = (await customApi.getClusterCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          plural: 'resourcegraphdefinitions',
          name: 'clickstack-s3-kro',
        })) as { body?: unknown };
        const rgd = (rgdRaw.body ?? rgdRaw) as {
          status?: { state?: string; conditions?: { type: string; status: string }[] };
        };
        expect(rgd.status?.state).toBe('Active');
        expect(
          (rgd.status?.conditions ?? []).find((condition) => condition.type === 'GraphAccepted')
            ?.status
        ).toBe('True');
        kroPlural = await discoverGeneratedPlural();

        // 2. STATUS HYDRATION ON THE LIVE CR. KRO projects status a reconcile
        // after readiness, so poll briefly for the last field to arrive.
        const readKroInstance = async (): Promise<{ status?: Record<string, unknown> }> => {
          const raw = (await customApi.getNamespacedCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            namespace: kroStackNs,
            plural: kroPlural,
            name: kroInstanceName,
          })) as { body?: unknown };
          return (raw.body ?? raw) as never;
        };

        let liveCr = await readKroInstance();
        const statusDeadline = Date.now() + 180_000;
        while (
          (liveCr.status?.storage as { mode?: string } | undefined)?.mode === undefined &&
          Date.now() < statusDeadline
        ) {
          await Bun.sleep(5_000);
          liveCr = await readKroInstance();
        }

        // THE WHOLE DECLARED STATUS CONTRACT, on the LIVE CR — through the SAME
        // shared assertion the direct-mode case above calls, so KRO's
        // server-side evaluation and direct mode's client-side hydration are
        // held to one bar. Only the instance name and namespace differ between
        // the two calls; every field is asserted in both.
        const status = liveCr.status as unknown as ClickStackBootstrapStatus;
        assertClickStackS3StatusContract(status, {
          instanceName: kroInstanceName,
          namespace: kroStackNs,
          chartVersion: DEFAULT_CLICKSTACK_VERSION,
          helmRelease: await readClickStackHelmRelease(kroStackNs, kroInstanceName, kubeConfig),
          storage: { mode: 's3', diskType: 's3_plain_rewritable', persistentQueue: true },
        });
        phase('KRO CR status carries the whole declared contract');

        // 3. THE KRO-GENERATED IN-CLUSTER HELMRELEASE. Local RGD YAML proves
        // serialization; only the live object proves KRO's expression
        // evaluation and the Flux handoff produced the chart config expected.
        const releaseRaw = (await customApi.getNamespacedCustomObject({
          group: 'helm.toolkit.fluxcd.io',
          version: 'v2',
          namespace: kroStackNs,
          plural: 'helmreleases',
          name: kroInstanceName,
        })) as { body?: unknown };
        const release = (releaseRaw.body ?? releaseRaw) as {
          spec?: {
            chart?: { spec?: { chart?: string; version?: string } };
            values?: Record<string, unknown>;
          };
          status?: { conditions?: { type: string; status: string }[] };
        };
        expect(release.spec?.chart?.spec?.chart).toBe('clickstack');
        expect(release.spec?.chart?.spec?.version).toBe(DEFAULT_CLICKSTACK_VERSION);

        const values = release.spec?.values as {
          fullnameOverride?: string;
          clickhouse?: { enabled?: boolean };
          mongodb?: { enabled?: boolean };
          hyperdx?: {
            config?: Record<string, string>;
            secrets?: Record<string, string>;
          };
          global?: { otelCollector?: { customConfig?: string } };
          'otel-collector'?: {
            extraVolumes?: { name?: string; persistentVolumeClaim?: { claimName?: string } }[];
            extraVolumeMounts?: { mountPath?: string }[];
          };
        };
        // The naming anchor the whole status contract depends on: the mapper
        // pins it so the HyperDX Service is `<name>` and the gateway Service is
        // `<name>-otel-collector`.
        expect(values.fullnameOverride).toBe(kroInstanceName);
        // The chart's bundled ClickHouse and Mongo are OFF: this stack writes
        // to the external, S3-backed CHI the direct cases built, and runs the
        // composition's own Mongo StatefulSet.
        expect(values.clickhouse?.enabled).toBe(false);
        expect(values.mongodb?.enabled).toBe(false);
        // The DEPENDENCY CONTRACT, as the chart actually received it: KRO
        // evaluated the mixed template into a concrete DSN for the external
        // ClickHouse, not a marker or a half-resolved expression.
        expect(values.hyperdx?.config?.CLICKHOUSE_ENDPOINT).toBe(
          `tcp://${clickhouseHost}:9000?dial_timeout=10s`
        );
        expect(values.hyperdx?.config?.CLICKHOUSE_SERVER_ENDPOINT).toBe(`${clickhouseHost}:9000`);
        expect(values.hyperdx?.config?.CLICKHOUSE_USER).toBe(chiUser);
        expect(values.hyperdx?.config?.MONGO_URI).toBe(
          `mongodb://${kroInstanceName}-mongodb.${kroStackNs}.svc.cluster.local:27017/hyperdx`
        );
        // No TypeKro marker and no unevaluated KRO expression survived into
        // the values the chart rendered. `${env:...}` in the collector overlay
        // is OTel's own runtime expansion and is expected, so the check is on
        // the markers rather than on every `${`.
        const serializedValues = JSON.stringify(values);
        expect(serializedValues).not.toContain('__KUBERNETES_REF');
        expect(serializedValues).not.toContain('__typekroSchemaKey');
        expect(serializedValues).not.toContain('schema.spec.');
        expect(serializedValues).not.toContain('[object Object]');
        // The persistent queue wiring survived the whole-map merge, alongside
        // the chart's own custom-config mount.
        const queueVolume = (values['otel-collector']?.extraVolumes ?? []).find(
          (volume) => volume.persistentVolumeClaim?.claimName === `${kroInstanceName}-otel-queue`
        );
        expect(queueVolume).toBeDefined();
        expect(
          (values['otel-collector']?.extraVolumeMounts ?? []).map((mount) => mount.mountPath)
        ).toContain('/var/lib/otelcol/file_storage');
        expect(values.global?.otelCollector?.customConfig).toBeDefined();
        phase('KRO-generated HelmRelease spec.values verified in-cluster');

        // 4. POD GROUND TRUTH. Status is the composition's claim; this is the
        // cluster's. All pods Running, all containers ready, restarts inside
        // the guide's KRO-mode budget (a simultaneous deploy restarts HyperDX
        // while Mongo comes up).
        const pods = await coreApi.listNamespacedPod({ namespace: kroStackNs });
        // LONG-RUNNING workloads only. The composition also owns a CronJob
        // (the ClickStack Team credential convergence), whose completed Job
        // Pod sits in `Succeeded` by design — asserting `Running` over it
        // would be asserting the wrong contract, so it gets its own check
        // below.
        const workloads = pods.items.filter(
          (pod) =>
            !pod.metadata?.deletionTimestamp &&
            pod.metadata?.ownerReferences?.some(
              (owner) => owner.kind === 'ReplicaSet' || owner.kind === 'StatefulSet'
            )
        );
        // HyperDX app, the gateway collector, and Mongo.
        expect(workloads.length).toBeGreaterThanOrEqual(3);
        for (const pod of workloads) {
          expect(pod.status?.phase).toBe('Running');
          const containers = pod.status?.containerStatuses ?? [];
          expect(containers.length).toBeGreaterThan(0);
          expect(containers.every((container) => container.ready)).toBe(true);
          const restarts = containers.reduce(
            (total, container) => total + container.restartCount,
            0
          );
          expect(restarts).toBeLessThanOrEqual(10);
        }

        // The credential-convergence Job the readiness contract gates on ran
        // to completion — the other half of the pod ground truth.
        const bootstrapPods = pods.items.filter((pod) =>
          pod.metadata?.ownerReferences?.some((owner) => owner.kind === 'Job')
        );
        expect(bootstrapPods.length).toBeGreaterThan(0);
        for (const pod of bootstrapPods) {
          expect(pod.status?.phase).toBe('Succeeded');
        }

        // The contract ConfigMap the status is projected from is a real graph
        // child carrying the resolved values.
        const contract = await coreApi.readNamespacedConfigMap({
          namespace: kroStackNs,
          name: `${kroInstanceName}-contract`,
        });
        expect(contract.data?.appPort).toBe('3000');
        expect(contract.data?.storageDiskType).toBe('s3_plain_rewritable');
        expect(contract.data?.storagePersistentQueue).toBe('true');
        // `version` is NOT in the contract ConfigMap: the status projects it
        // from the HelmRelease's own chart pin (asserted against the live
        // release by the shared status contract above). Asserting the absence
        // keeps the two from drifting back into two copies of one fact.
        expect(contract.data?.version).toBeUndefined();
      } finally {
        if (deploymentAttempted) {
          // 5. `deleteInstance()` + KRO finalizer, through the shared helper —
          // never a manual deletion of children, the RGD, or a finalizer
          // patch. The suite's own namespace leases are released in afterAll,
          // AFTER factory teardown.
          await deleteTestFactoryInstanceAndRecoverNamespaces(
            kroFactory as never,
            kroInstanceName,
            [],
            kubeConfig,
            300_000
          );
        }
      }

      // 6. FINALIZER CLEANUP VERIFIED. Graph deletion runs behind KRO's
      // finalizer, so each of these lags `deleteInstance` returning; poll to a
      // bounded deadline rather than asserting instant absence. `waitUntilGone`
      // counts ONLY a 404 as gone and re-throws everything else, so a 5xx or an
      // auth failure cannot pass these assertions.
      const pollGone = (read: () => Promise<unknown>): Promise<boolean> =>
        waitUntilGone(read, 300_000);

      expect(
        await pollGone(() =>
          customApi.getNamespacedCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            namespace: kroStackNs,
            plural: kroPlural,
            name: kroInstanceName,
          })
        )
      ).toBe(true);
      expect(
        await pollGone(() =>
          customApi.getClusterCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            plural: 'resourcegraphdefinitions',
            name: 'clickstack-s3-kro',
          })
        )
      ).toBe(true);
      expect(
        await pollGone(() =>
          customApi.getNamespacedCustomObject({
            group: 'helm.toolkit.fluxcd.io',
            version: 'v2',
            namespace: kroStackNs,
            plural: 'helmreleases',
            name: kroInstanceName,
          })
        )
      ).toBe(true);
      expect(
        await pollGone(() =>
          coreApi.readNamespacedConfigMap({
            namespace: kroStackNs,
            name: `${kroInstanceName}-contract`,
          })
        )
      ).toBe(true);
      phase('KRO instance, RGD, HelmRelease and contract ConfigMap all gone');
    },
    2_400_000
  );
});
