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
 * 4. The rendered `BACKUP ... TO S3(...)` statement is accepted by a real
 *    server with NO credentials in the query text — they come from the `<s3>`
 *    config section the storage compiler writes — and the coordinated
 *    `ON CLUSTER` form FAILS without a Keeper, which is the premise of the
 *    construction-time guard that rejects a keeperless sharded topology with a
 *    backup schedule.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleBatchV1Api,
  createBunCompatibleCustomObjectsApi,
} from '../../../src/core/kubernetes/index.js';
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
  /** Name of the backup created by the live single-host BACKUP test. */
  let backupName = '';
  let helmRepositoryPreexisting = false;
  const namespaceLeases: TestNamespaceLease[] = [];

  /**
   * Backup destination base URL, built the same way the factory builds it:
   * path-style `<endpoint>/<bucket>/<prefix>/`.
   */
  function backupEndpointUrl(): string {
    return `${minio.endpoint.replace(/\/+$/, '')}/${minio.bucket}/backups/`;
  }

  /**
   * Run a query against an arbitrary ClickHouse host from a throwaway
   * clickhouse-client Pod. Takes the host explicitly because the KRO-mode
   * block below drives a SECOND installation in the same namespace.
   */
  async function queryHost(host: string, sql: string, name: string): Promise<string> {
    return (
      await runTestPodAndReadLogs(
        {
          namespace: chiNs,
          name: `${chiName}-q-${name}-${crypto.randomUUID().slice(0, 6)}`,
          image: 'clickhouse/clickhouse-server:25.7',
          command: [
            'clickhouse-client',
            '--host',
            host,
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

  /** Run a query against the direct-mode CHI. */
  async function query(sql: string, name: string): Promise<string> {
    return queryHost(`clickhouse-${chiName}.${chiNs}.svc.cluster.local`, sql, name);
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

    // `waitForReady: true` is now the whole gate. Before the #191 fix the
    // shared Helm readiness evaluator accepted a state that was not yet
    // `Ready=True` with the current generation observed, so `deploy()` returned
    // roughly 90s before Flux had finished installing and this suite had to
    // poll the live HelmRelease itself. The evaluator now additionally requires
    // `Reconciling` to be clear, the current generation to be observed exactly,
    // and the attempted revision to be the released one — so the returned
    // snapshot IS evidence, and the assertions below are the proof.
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.version).toBe('0.27.1');

    // Ground truth for the readiness contract: at the moment `deploy()`
    // returned, the HelmRelease really was installed AND the CRDs the operator
    // owns really did exist. That second half is what a consumer proceeding on
    // `ready` depends on, and what the old behaviour got wrong.
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const releaseRaw = (await customApi.getNamespacedCustomObject({
      group: 'helm.toolkit.fluxcd.io',
      version: 'v2',
      namespace: operatorNs,
      plural: 'helmreleases',
      name: 'clickhouse-operator',
    })) as { body?: unknown };
    const release = (releaseRaw.body ?? releaseRaw) as {
      metadata?: { generation?: number };
      status?: {
        observedGeneration?: number;
        lastAttemptedRevision?: string;
        history?: { chartVersion?: string }[];
        conditions?: { type: string; status: string }[];
      };
    };
    const conditions = release.status?.conditions ?? [];
    expect(conditions.find((condition) => condition.type === 'Ready')?.status).toBe('True');
    expect(conditions.find((condition) => condition.type === 'Released')?.status).toBe('True');
    expect(conditions.find((condition) => condition.type === 'Reconciling')?.status).not.toBe(
      'True'
    );
    expect(release.metadata?.generation).toBeGreaterThan(0);
    expect(release.status?.observedGeneration).toBe(release.metadata?.generation as number);
    expect(release.status?.lastAttemptedRevision).toBe('0.27.1');
    expect(release.status?.history?.[0]?.chartVersion).toBe('0.27.1');

    await customApi.getClusterCustomObject({
      group: 'apiextensions.k8s.io',
      version: 'v1',
      plural: 'customresourcedefinitions',
      name: 'clickhouseinstallations.clickhouse.altinity.com',
    });
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
        // A backup schedule renders the CronJob AND the server-side `<s3>`
        // config section the BACKUP statement's credentials come from. The
        // schedule is deliberately far out: the test triggers a Job from the
        // rendered template rather than waiting for a tick.
        backup: { schedule: '0 3 * * *', prefix: 'backups' },
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

  // ── The BACKUP statement the CronJob renders ─────────────────────────────
  //
  // The backup schedule declared above renders both the CronJob and the
  // server-side `<s3>` config section that supplies the destination's
  // credentials. These two tests execute the STATEMENTS that CronJob would
  // issue, which is where the "sharded clusters get a partial backup" finding
  // lives.
  it('renders the CronJob with the single-host statement for this 1-shard cluster', async () => {
    const batchApi = createBunCompatibleBatchV1Api(kubeConfig);
    const cron = await batchApi.readNamespacedCronJob({
      namespace: chiNs,
      name: `${chiName}-s3-backup`,
    });
    const podSpec = cron.spec?.jobTemplate.spec?.template.spec;
    const script = (podSpec?.containers ?? [])[0]?.command?.[2] ?? '';

    expect(script).toContain('BACKUP DATABASE $CLICKHOUSE_DATABASE TO S3(');
    // 1 shard, 1 replica, no keeper: nothing to coordinate, so no ON CLUSTER.
    expect(script).not.toContain('ON CLUSTER');
  }, 300_000);

  it('accepts the rendered single-host BACKUP against MinIO, credentials from config', async () => {
    // The statement carries no keys: the server matches the destination URL
    // against the `<s3>` section the storage compiler rendered. A backup that
    // needed keys in the query text would fail here.
    backupName = `it${Date.now()}`;
    await query(`BACKUP DATABASE default TO S3('${backupEndpointUrl()}${backupName}')`, 'backupok');

    // The destination is now a real, listable backup.
    const status = await query(
      `SELECT status FROM system.backups WHERE name LIKE '%${backupName}%' ORDER BY start_time DESC LIMIT 1`,
      'backupstatus'
    );
    expect(status).toBe('BACKUP_CREATED');
  }, 900_000);

  it('proves ON CLUSTER needs a Keeper — the premise of the construction-time guard', async () => {
    // `makeClickHouseCluster` REJECTS a multi-shard/multi-replica topology
    // with a backup schedule and no keeper, because the only statement that
    // backs up every shard is `BACKUP ... ON CLUSTER` and its fan-out is
    // coordinated through [Zoo]Keeper. This cluster has no keeper, so the
    // coordinated statement must fail rather than quietly degrade to a
    // one-shard backup — which is exactly why the guard is a hard error.
    let message = '';
    try {
      await query(
        `BACKUP DATABASE default ON CLUSTER 'cluster' TO S3('${backupEndpointUrl()}oncluster')`,
        'oncluster'
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe('');
    // The server names the missing coordination substrate; accept any of the
    // spellings ClickHouse uses for it rather than pinning one release's text.
    expect(message).toMatch(/[Zz]oo[Kk]eeper|KEEPER|coordination|NO_ELEMENTS_IN_CONFIG/);
  }, 900_000);

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

  // ── KRO mode: the same S3 composition through the RGD path ───────────────
  //
  // The guide requires live DIRECT AND KRO execution for a dependency-managing
  // integration, and the tests above are direct-only. This block runs the SAME
  // `makeClickHouseCluster({ storage: { mode: 's3' } })` composition through
  // `factory('kro')` and proves the complete lifecycle: the RGD is accepted and
  // Active, the instance reconciles, EVERY declared status field is observed on
  // the live CR (the point of projecting the build-time contract from an owned
  // resource), the KRO-GENERATED in-cluster CHI carries the rendered storage
  // configuration, the pods are genuinely healthy, and `deleteInstance()` takes
  // the whole graph — instance, RGD, CHI child and contract ConfigMap — with it
  // through KRO's finalizer.
  describe('KRO mode', () => {
    // Its OWN RGD identity, not the default `clickhouse-cluster`. The spec
    // schema is a product of the topology (this one declares a user and carries
    // the s3_plain_rewritable version floor), and KRO refuses a breaking CRD
    // update — so sharing an RGD name with the default topology the sibling
    // bootstrap suite deploys would make whichever ran second fail with
    // "breaking changes detected: Property users was removed".
    const rgdName = 'clickhouse-s3-cluster';
    const rgdKind = 'ClickHouseS3Cluster';
    const kroInstanceName = 'ch-s3-kro';
    /**
     * REST plural of the generated CRD, DISCOVERED rather than guessed —
     * KRO/Kubernetes pluralization of a kind containing a digit is not
     * something a test should encode by hand.
     */
    let rgdPlural = '';

    async function discoverGeneratedPlural(): Promise<string> {
      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const raw = (await customApi.listClusterCustomObject({
        group: 'apiextensions.k8s.io',
        version: 'v1',
        plural: 'customresourcedefinitions',
      })) as { body?: unknown };
      const list = (raw.body ?? raw) as {
        items?: { spec?: { group?: string; names?: { kind?: string; plural?: string } } }[];
      };
      const generated = (list.items ?? []).find(
        (crd) => crd.spec?.group === 'kro.run' && crd.spec?.names?.kind === rgdKind
      );
      const plural = generated?.spec?.names?.plural;
      if (plural === undefined) {
        throw new Error(`No generated CRD found for kind ${rgdKind} in group kro.run`);
      }
      return plural;
    }

    /** Read the live KRO instance CR. */
    async function readKroInstance(): Promise<{ status?: Record<string, unknown> }> {
      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const raw = (await customApi.getNamespacedCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        namespace: chiNs,
        plural: rgdPlural,
        name: kroInstanceName,
      })) as { body?: unknown };
      return (raw.body ?? raw) as never;
    }

    it('reconciles the S3 composition through KRO, hydrates the whole status contract, and cleans up', async () => {
      const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');
      const kroApi = createBunCompatibleCustomObjectsApi(kubeConfig);

      // Same build-time storage topology as the direct-mode test, on its own
      // bucket prefix so the two runs cannot share object keys.
      const clickhouse = makeClickHouseCluster({
        name: rgdName,
        kind: rgdKind,
        users: [{ name: chiUser }],
        storage: {
          mode: 's3',
          diskType: 's3_plain_rewritable',
          bucket: minio.bucket,
          prefix: 'chi-kro',
          endpoint: minio.endpoint,
          cache: { size: '512Mi' },
          auth: { secretRef: { name: minio.secretName } },
          backup: { schedule: '0 4 * * *', prefix: 'backups-kro' },
        },
      });
      const kroFactory = clickhouse.factory('kro', {
        namespace: chiNs,
        waitForReady: true,
        timeout: 900_000,
        kubeConfig,
      });

      let deploymentAttempted = false;
      try {
        deploymentAttempted = true;
        const instance = await kroFactory.deploy({
          name: kroInstanceName,
          namespace: chiNs,
          // Satisfies the s3_plain_rewritable floor the generated schema now
          // carries as a `pattern=` marker — see the rejection test below.
          version: '25.7',
          storage: { size: '2Gi', storageClassName: storageClass },
          podResources: {
            requests: { cpu: '200m', memory: '1Gi' },
            limits: { memory: '2Gi' },
          },
          users: { [chiUser]: { passwordSha256Hex: chiUserPasswordSha256 } },
        });

        expect(instance.status.ready).toBe(true);

        // 1. THE RGD REACHED Active=True on the live cluster.
        const rgdRaw = (await kroApi.getClusterCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          plural: 'resourcegraphdefinitions',
          name: rgdName,
        })) as { body?: unknown };
        const rgd = (rgdRaw.body ?? rgdRaw) as {
          status?: { state?: string; conditions?: { type: string; status: string }[] };
        };
        expect(rgd.status?.state).toBe('Active');
        expect(
          (rgd.status?.conditions ?? []).find((condition) => condition.type === 'GraphAccepted')
            ?.status
        ).toBe('True');
        rgdPlural = await discoverGeneratedPlural();

        // 2. STATUS HYDRATION ON THE LIVE CR. KRO projects status a reconcile
        // after readiness, so poll briefly for the first field.
        let liveCr = await readKroInstance();
        const statusDeadline = Date.now() + 180_000;
        while (
          (liveCr.status?.storage as { bucket?: string } | undefined)?.bucket === undefined &&
          Date.now() < statusDeadline
        ) {
          await Bun.sleep(5_000);
          liveCr = await readKroInstance();
        }

        // Read the KRO-generated CHI first: the two host counters are
        // projections of ITS status, and the operator's own behaviour decides
        // whether the optional one is populated at all.
        const chiRaw = (await kroApi.getNamespacedCustomObject({
          group: 'clickhouse.altinity.com',
          version: 'v1',
          namespace: chiNs,
          plural: 'clickhouseinstallations',
          name: kroInstanceName,
        })) as { body?: unknown };
        const chi = (chiRaw.body ?? chiRaw) as {
          status?: { status?: string; hosts?: number; hostsCompleted?: number };
          spec?: {
            configuration?: {
              files?: Record<string, string>;
              settings?: Record<string, string>;
            };
          };
        };

        const status = liveCr.status as unknown as {
          ready: boolean;
          phase: string;
          clickhouse: {
            host: string;
            port: number;
            nativeUrl: string;
            httpUrl: string;
            clusterName: string;
            database: string;
            user: string;
          };
          storage: {
            mode: string;
            diskType: string;
            policyName: string;
            bucket: string;
            selfDescribingBucket: boolean;
            backupSchedule: string;
          };
          installation: {
            name: string;
            namespace: string;
            endpoint: string;
            hostsCount?: number;
            hostsCompletedCount?: number;
          };
        };

        // EVERY field of ClickHouseClusterStatusSchema, on the LIVE CR — not
        // just readiness and three of them. `keeper` is the only optional
        // branch and this topology has no keeper, so it is legitimately absent.
        expect(status.ready).toBe(true);
        expect(status.phase).toBe('Ready');
        expect(status.clickhouse.host).toBe(
          `clickhouse-${kroInstanceName}.${chiNs}.svc.cluster.local`
        );
        expect(status.clickhouse.port).toBe(9000);
        expect(status.clickhouse.nativeUrl).toBe(
          `clickhouse://clickhouse-${kroInstanceName}.${chiNs}.svc.cluster.local:9000`
        );
        expect(status.clickhouse.httpUrl).toBe(
          `http://clickhouse-${kroInstanceName}.${chiNs}.svc.cluster.local:8123`
        );
        expect(status.clickhouse.clusterName).toBe('cluster');
        expect(status.clickhouse.database).toBe('default');
        expect(status.clickhouse.user).toBe(chiUser);
        expect(status.storage.mode).toBe('s3');
        expect(status.storage.diskType).toBe('s3_plain_rewritable');
        expect(status.storage.policyName).toBe('s3_main');
        expect(status.storage.bucket).toBe(minio.bucket);
        expect(status.storage.selfDescribingBucket).toBe(true);
        expect(status.storage.backupSchedule).toBe('0 4 * * *');
        expect(status.installation.name).toBe(kroInstanceName);
        expect(status.installation.namespace).toBe(chiNs);
        expect(status.installation.endpoint).toContain(kroInstanceName);
        expect(status.installation.hostsCount).toBe(1);
        // LIVE FINDING (operator release-0.27.1): the CHI's `hostsCompleted`
        // is not populated once the reconcile has finished, so this DECLARED
        // OPTIONAL field is legitimately absent on a settled cluster. Asserted
        // as agreeing with its source rather than pinned to a number, which
        // would be asserting the operator's mid-reconcile behaviour.
        expect(status.installation.hostsCompletedCount).toBe(
          chi.status?.hostsCompleted as number
        );
        expect(status.installation.hostsCount).toBe(chi.status?.hosts as number);
        // `keeper` is the only other optional branch, and this topology has no
        // keeper — so it is legitimately absent rather than unhydrated.
        expect((liveCr.status as { keeper?: unknown }).keeper).toBeUndefined();

        // THE VERSION FLOOR, ENFORCED BY THE GENERATED SCHEMA. The build-time
        // gate cannot see a per-instance `spec.version`, so the
        // `s3_plain_rewritable` floor travels into the RGD as a `pattern=`
        // marker. This applies a CR through the API server DIRECTLY —
        // bypassing TypeKro's own ArkType validation — so the rejection can
        // only come from the generated CRD's schema, which is the claim. It
        // runs inside this test because a second composition would need a
        // second RGD of the same name, which KRO refuses as a breaking CRD
        // update (and rightly so).
        let versionRejection = '';
        try {
          await kroApi.createNamespacedCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            namespace: chiNs,
            plural: rgdPlural,
            body: {
              apiVersion: 'kro.run/v1alpha1',
              kind: rgdKind,
              metadata: { name: 'ch-s3-too-old', namespace: chiNs },
              spec: {
                name: 'ch-s3-too-old',
                namespace: chiNs,
                // 24.4 introduced the disk but not the metadata_type form this
                // factory emits; 24.5 is the floor.
                version: '24.4',
                storage: { size: '1Gi', storageClassName: storageClass },
                users: { [chiUser]: { passwordSha256Hex: chiUserPasswordSha256 } },
              },
            },
          });
        } catch (error: unknown) {
          versionRejection = error instanceof Error ? error.message : String(error);
        }
        expect(versionRejection).not.toBe('');
        expect(versionRejection).toMatch(/version/);

        // A version that SATISFIES the floor is accepted by the same schema,
        // so the rejection above is the pattern and not an unrelated error.
        // (Created and immediately removed: this test's subject is admission,
        // not a second reconcile.)
        await kroApi.createNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace: chiNs,
          plural: rgdPlural,
          body: {
            apiVersion: 'kro.run/v1alpha1',
            kind: rgdKind,
            metadata: { name: 'ch-s3-new-enough', namespace: chiNs },
            spec: {
              name: 'ch-s3-new-enough',
              namespace: chiNs,
              version: '24.5',
              storage: { size: '1Gi', storageClassName: storageClass },
              users: { [chiUser]: { passwordSha256Hex: chiUserPasswordSha256 } },
            },
          },
        });
        await deleteTestResourceAndWait(
          {
            apiVersion: 'kro.run/v1alpha1',
            kind: rgdKind,
            metadata: { namespace: chiNs, name: 'ch-s3-new-enough' },
          },
          kubeConfig,
          180_000
        );

        // 3. THE KRO-GENERATED CHILDREN, READ BACK FROM THE CLUSTER. Local RGD
        // YAML proves serialization; only the in-cluster resource proves KRO's
        // expression evaluation produced the configuration the server reads.
        expect(chi.status?.status).toBe('Completed');
        const storageXml = chi.spec?.configuration?.files?.['config.d/storage.xml'] ?? '';
        expect(storageXml).toContain('<type>s3_plain_rewritable</type>');
        expect(storageXml).toContain(
          `${minio.endpoint.replace(/\/+$/, '')}/${minio.bucket}/chi-kro/`
        );
        // No key material in the rendered configuration: the Secret is read
        // through `from_env`, and no `__KUBERNETES_REF__` marker survived.
        expect(storageXml).toContain('from_env="CLICKHOUSE_S3_ACCESS_KEY_ID"');
        expect(storageXml).not.toContain('__KUBERNETES_REF');
        expect(chi.spec?.configuration?.settings?.['merge_tree/storage_policy']).toBe('s3_main');

        // The contract ConfigMap the status is projected from is a real graph
        // child with the resolved values in it.
        const contract = await createCoreV1ApiClient(kubeConfig).readNamespacedConfigMap({
          namespace: chiNs,
          name: `${kroInstanceName}-contract`,
        });
        expect(contract.data?.storageDiskType).toBe('s3_plain_rewritable');
        expect(contract.data?.storageSelfDescribingBucket).toBe('true');
        expect(contract.data?.nativePort).toBe('9000');

        // The backup CronJob KRO generated carries the coordinated-vs-single
        // host decision for this 1x1 topology.
        const kroCron = await createBunCompatibleBatchV1Api(kubeConfig).readNamespacedCronJob({
          namespace: chiNs,
          name: `${kroInstanceName}-s3-backup`,
        });
        expect(kroCron.spec?.schedule).toBe('0 4 * * *');
        const kroScript =
          (kroCron.spec?.jobTemplate.spec?.template.spec?.containers ?? [])[0]?.command?.[2] ?? '';
        expect(kroScript).toContain('BACKUP DATABASE $CLICKHOUSE_DATABASE TO S3(');
        expect(kroScript).not.toContain('ON CLUSTER');

        // 4. POD GROUND TRUTH. Status is the composition's claim; this is the
        // cluster's.
        const coreApi = createCoreV1ApiClient(kubeConfig);
        const pods = await coreApi.listNamespacedPod({
          namespace: chiNs,
          labelSelector: `clickhouse.altinity.com/chi=${kroInstanceName}`,
        });
        expect(pods.items.length).toBe(1);
        for (const pod of pods.items) {
          expect(pod.status?.phase).toBe('Running');
          const containers = pod.status?.containerStatuses ?? [];
          expect(containers.length).toBeGreaterThan(0);
          expect(containers.every((container) => container.ready)).toBe(true);
          // The guide's KRO-mode budget: simultaneous deploy causes transient
          // restarts while dependencies come up.
          const restarts = containers.reduce(
            (total, container) => total + container.restartCount,
            0
          );
          expect(restarts).toBeLessThanOrEqual(10);
        }

        // 5. The S3 policy is the server default in KRO mode too, so a plain
        // CREATE TABLE lands on object storage — the same claim the direct
        // suite proves, through the RGD path.
        await queryHost(
          `clickhouse-${kroInstanceName}.${chiNs}.svc.cluster.local`,
          'CREATE TABLE IF NOT EXISTS kroprobe (ts DateTime, msg String) ENGINE = MergeTree ORDER BY ts',
          'krocreate'
        );
        const kroPolicy = await queryHost(
          `clickhouse-${kroInstanceName}.${chiNs}.svc.cluster.local`,
          "SELECT storage_policy FROM system.tables WHERE database = 'default' AND name = 'kroprobe'",
          'kropolicy'
        );
        expect(kroPolicy).toBe('s3_main');
      } finally {
        if (deploymentAttempted) {
          // 6. `deleteInstance()` + KRO finalizer, through the shared helper —
          // never a manual deletion of children, the RGD, or a finalizer patch.
          await deleteTestFactoryInstanceAndRecoverNamespaces(
            kroFactory as never,
            kroInstanceName,
            [],
            kubeConfig,
            180_000
          );
        }
      }

      // 7. FINALIZER CLEANUP VERIFIED. KRO processes graph deletion behind its
      // finalizer, so each of these lags `deleteInstance` returning by a beat;
      // poll to a bounded deadline rather than asserting instant absence.
      const teardownApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const pollGone = async (read: () => Promise<unknown>): Promise<boolean> => {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          try {
            await read();
            await Bun.sleep(5_000);
          } catch {
            return true;
          }
        }
        return false;
      };

      // The instance CR itself — proof KRO released its finalizer.
      expect(await pollGone(() => readKroInstance())).toBe(true);
      // The RGD (this is the only instance, so it goes with it).
      expect(
        await pollGone(() =>
          teardownApi.getClusterCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            plural: 'resourcegraphdefinitions',
            name: rgdName,
          })
        )
      ).toBe(true);
      // The graph children KRO owned.
      expect(
        await pollGone(() =>
          teardownApi.getNamespacedCustomObject({
            group: 'clickhouse.altinity.com',
            version: 'v1',
            namespace: chiNs,
            plural: 'clickhouseinstallations',
            name: kroInstanceName,
          })
        )
      ).toBe(true);
      expect(
        await pollGone(() =>
          createCoreV1ApiClient(kubeConfig).readNamespacedConfigMap({
            namespace: chiNs,
            name: `${kroInstanceName}-contract`,
          })
        )
      ).toBe(true);
    }, 1_800_000);
  });
});
