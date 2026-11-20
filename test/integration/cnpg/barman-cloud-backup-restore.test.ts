/**
 * Live Barman Cloud plugin backup and restore.
 *
 * Installs a CloudNativePG operator the plugin supports (chart 0.29.2, operator 1.30.2, pinned
 * with `BARMAN_CLOUD_TESTED_CNPG_CHART_VERSION`) and the Barman Cloud plugin (chart 0.9.0)
 * with cert-manager. It backs a cluster up to an S3-compatible bucket through an `ObjectStore` that
 * uses `inheritFromIAMRole: true`, restores the backup into a new cluster and reads the rows back.
 * Then it deploys the `cnpgS3BackedCluster` composition with `waitForReady: true` and checks that
 * it converges: the cluster healthy, its nightly ScheduledBackup registered before it has run, and
 * WAL archiving to the bucket. The bucket is VersityGW on a local directory; the MinIO images the
 * shared fixture pins are no longer pullable from Docker Hub or Quay.
 *
 * Workload identity is simulated: a small instance-metadata endpoint in the test namespace hands
 * out the gateway's keys as an IAM role's credentials, and the sidecar's
 * `AWS_EC2_METADATA_SERVICE_ENDPOINT` points boto at it. The ObjectStore carries no keys, so the
 * path is the one IRSA or EKS Pod Identity takes on AWS.
 *
 * It installs cluster-scoped operators (CloudNativePG, its webhooks, the plugin), so it runs
 * only when asked: `TYPEKRO_BARMAN_CLOUD_LIVE=true` and `TYPEKRO_TEST_STORAGE_CLASS`, on a
 * disposable cluster such as kind. `bun run test:integration:cnpg-barman-cloud` runs it. CI does
 * not run it: the CI workflow has no Kubernetes cluster.
 *
 * Known kind issue, test clusters only: on kind v0.32.0 (Kubernetes 1.36, kindnet network
 * policies), pods in `flux-system` could not reach cluster DNS or other pod IPs while Flux's
 * `allow-egress`, `allow-scraping` and `allow-webhooks` NetworkPolicies were in place, although
 * `allow-egress` allows all egress. source-controller then failed to pull the KRO chart
 * (`lookup registry.k8s.io: i/o timeout`) and the runtime install timed out. The recorded run
 * deleted those three policies by hand on the throwaway kind cluster after the first attempt
 * timed out, then reran the suite on the same cluster until it passed:
 *
 *   kubectl -n flux-system delete networkpolicy allow-egress allow-scraping allow-webhooks
 *
 * TypeKro's Flux install keeps its policies; never remove them on a shared or real cluster.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(1_800_000);

import type * as k8s from '@kubernetes/client-node';
import { evaluate } from 'cel-js';
import yaml from 'js-yaml';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  BARMAN_CLOUD_TESTED_CNPG_CHART_VERSION,
  BARMAN_CLOUD_TESTED_CNPG_OPERATOR_VERSION,
  backup,
  barmanCloudBackupMethod,
  barmanCloudPlugin,
  barmanCloudPluginBootstrap,
  barmanCloudRecovery,
  cluster,
  cnpgBootstrap,
  cnpgS3BackedCluster,
  objectStore,
} from '../../../src/factories/cnpg/index.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  ensureCertManagerInstalled,
  ensureFluxInstalled,
  isClusterAvailable,
  isNotFoundError,
  requireTestStorageClass,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const enabled = process.env.TYPEKRO_BARMAN_CLOUD_LIVE === 'true' && (await isClusterAvailable());
const describeOrSkip = enabled ? describe : describe.skip;

/** PostgreSQL image of both clusters and of the psql probes, pulled once. */
const POSTGRES_IMAGE = 'ghcr.io/cloudnative-pg/postgresql:17.5';
/** S3-compatible gateway serving a local directory. */
const S3_GATEWAY_IMAGE = 'versity/versitygw:v1.0.17';
/** The gateway's root keys, which the instance-metadata endpoint hands out as a role's. */
const S3_ACCESS_KEY = 'typekro-test-access-key';
const S3_SECRET_KEY = 'typekro-test-secret-key';
/** Image of the instance-metadata endpoint. */
const PYTHON_IMAGE = 'python:3.12.8-alpine3.21';
const OPERATOR_NAMESPACE = 'cnpg-system';
const BUCKET = 'typekro-barman-cloud';
const ROWS = ['alpha', 'bravo', 'charlie'];

/** A minimal IMDSv2: a token, one role, and that role's credentials (the gateway's keys). */
const IMDS_SCRIPT = `
import datetime, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

ROLE = 'typekro-barman-cloud-test'
BASE = '/latest/meta-data/iam/security-credentials/'

class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body, kind='text/plain'):
        data = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        self.reply(200, 'typekro-test-token') if self.path == '/latest/api/token' else self.reply(404, '')

    def do_GET(self):
        if self.path == BASE:
            return self.reply(200, ROLE)
        if self.path == BASE + ROLE:
            now = datetime.datetime.now(datetime.timezone.utc)
            fmt = '%Y-%m-%dT%H:%M:%SZ'
            return self.reply(200, json.dumps({
                'Code': 'Success',
                'Type': 'AWS-HMAC',
                'AccessKeyId': os.environ['AWS_ACCESS_KEY_ID'],
                'SecretAccessKey': os.environ['AWS_SECRET_ACCESS_KEY'],
                'Token': '',
                'LastUpdated': now.strftime(fmt),
                'Expiration': (now + datetime.timedelta(hours=6)).strftime(fmt),
            }), 'application/json')
        self.reply(404, '')

HTTPServer(('', 8080), Handler).serve_forever()
`;

/** A plain JSON copy of a rendered resource: what the API server receives. */
function manifest(resource: { apiVersion: string; kind: string; metadata: object; spec: unknown }) {
  return JSON.parse(
    JSON.stringify({
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: resource.metadata,
      spec: resource.spec,
    })
  ) as Record<string, any>;
}

const PLURALS: Record<string, [string, string, string]> = {
  ObjectStore: ['barmancloud.cnpg.io', 'v1', 'objectstores'],
  Cluster: ['postgresql.cnpg.io', 'v1', 'clusters'],
  Backup: ['postgresql.cnpg.io', 'v1', 'backups'],
  ScheduledBackup: ['postgresql.cnpg.io', 'v1', 'scheduledbackups'],
};

describeOrSkip('CNPG Barman Cloud plugin: backup to S3 and restore (live)', () => {
  let kubeConfig: k8s.KubeConfig;
  let storageClass: string;
  let lease: TestNamespaceLease | undefined;
  const runId = crypto.randomUUID().slice(0, 8);
  const namespace = `typekro-barman-${runId}`;
  const source = 'orders';
  const restored = 'orders-restored';
  const storeName = 'orders-backups';
  const composed = 'composed';
  let s3Endpoint = '';

  const apply = async (body: Record<string, any>) => {
    const [group, version, plural] = PLURALS[body.kind] ?? [];
    if (!group || !version || !plural) throw new Error(`no plural for ${body.kind}`);
    await createCustomObjectsApiClient(kubeConfig).createNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      body,
    });
  };

  const read = async (kind: string, name: string): Promise<any> => {
    const [group, version, plural] = PLURALS[kind] ?? [];
    if (!group || !version || !plural) throw new Error(`no plural for ${kind}`);
    const live: any = await createCustomObjectsApiClient(kubeConfig).getNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      name,
    });
    return live?.body ?? live;
  };

  /** Poll `kind/name` until `done` returns a truthy verdict, failing on `failed`. */
  const waitFor = async (
    kind: string,
    name: string,
    done: (live: any) => boolean,
    timeoutMs: number,
    failed: (live: any) => string | undefined = () => undefined
  ) => {
    const startedAt = Date.now();
    let last: any;
    while (Date.now() - startedAt < timeoutMs) {
      last = await read(kind, name).catch(() => undefined);
      if (last) {
        const failure = failed(last);
        if (failure) throw new Error(`${kind}/${name} failed: ${failure}`);
        if (done(last)) return last;
      }
      await Bun.sleep(5_000);
    }
    throw new Error(
      `Timed out waiting for ${kind}/${name}; last status: ${JSON.stringify(last?.status)}`
    );
  };

  const condition = (live: any, type: string) =>
    (live?.status?.conditions ?? []).some(
      (entry: { type?: string; status?: string }) => entry.type === type && entry.status === 'True'
    );

  /**
   * Run psql against `<cluster>-rw` with the app user of `secret`, and return its output. It
   * retries for up to five minutes: the service can lag the cluster's Ready condition.
   */
  const psql = (name: string, clusterName: string, secret: string, sql: string) =>
    runTestPodAndReadLogs(
      {
        namespace,
        name,
        image: POSTGRES_IMAGE,
        command: [
          'sh',
          '-c',
          `for attempt in $(seq 60); do out=$(psql -v ON_ERROR_STOP=1 -tA -c "${sql}" 2>&1) && ` +
            '{ echo "$out"; exit 0; }; sleep 5; done; echo "$out"; exit 1',
        ],
        env: [
          { name: 'PGHOST', value: `${clusterName}-rw` },
          { name: 'PGSSLMODE', value: 'require' },
          ...(['username', 'password', 'dbname'] as const).map((key) => ({
            name: { username: 'PGUSER', password: 'PGPASSWORD', dbname: 'PGDATABASE' }[key],
            valueFrom: { secretKeyRef: { name: secret, key: key } },
          })),
        ],
        timeoutMs: 420_000,
      },
      kubeConfig
    );

  /** Ready, with every instance ready and the cluster reporting a healthy state. */
  const healthy = (live: any) =>
    condition(live, 'Ready') &&
    live.status?.phase === 'Cluster in healthy state' &&
    (live.status?.readyInstances ?? 0) >= (live.spec?.instances ?? 1);

  /** The live Flux HelmRelease `name` in the operator namespace. */
  const releaseOf = async (name: string): Promise<any> => {
    const live: any = await createCustomObjectsApiClient(kubeConfig).getNamespacedCustomObject({
      group: 'helm.toolkit.fluxcd.io',
      version: 'v2',
      namespace: OPERATOR_NAMESPACE,
      plural: 'helmreleases',
      name,
    });
    return live?.body ?? live;
  };

  /** VersityGW serving `/data` over S3, with the bucket as a directory, and its endpoint. */
  const deployS3Gateway = async (): Promise<string> => {
    const core = createCoreV1ApiClient(kubeConfig);
    await core.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: 's3-keys' },
        stringData: { AWS_ACCESS_KEY_ID: S3_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: S3_SECRET_KEY },
      },
    });
    await createAppsV1ApiClient(kubeConfig).createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name: 's3', labels: { app: 's3' } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 's3' } },
          template: {
            metadata: { labels: { app: 's3' } },
            spec: {
              containers: [
                {
                  name: 's3',
                  image: S3_GATEWAY_IMAGE,
                  command: [
                    'sh',
                    '-c',
                    `mkdir -p /data/${BUCKET} && exec /app/versitygw --access "$AWS_ACCESS_KEY_ID" ` +
                      '--secret "$AWS_SECRET_ACCESS_KEY" --port :9000 posix /data',
                  ],
                  envFrom: [{ secretRef: { name: 's3-keys' } }],
                  ports: [{ containerPort: 9000 }],
                  readinessProbe: { tcpSocket: { port: 9000 }, periodSeconds: 2 },
                  volumeMounts: [{ name: 'data', mountPath: '/data' }],
                },
              ],
              volumes: [{ name: 'data', emptyDir: {} }],
            },
          },
        },
      },
    });
    await core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: 's3' },
        spec: { selector: { app: 's3' }, ports: [{ port: 9000, targetPort: 9000 }] },
      },
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 600_000) {
      const live = await createAppsV1ApiClient(kubeConfig).readNamespacedDeployment({
        namespace,
        name: 's3',
      });
      if ((live.status?.availableReplicas ?? 0) >= 1) {
        return `http://s3.${namespace}.svc.cluster.local:9000`;
      }
      await Bun.sleep(2_000);
    }
    throw new Error('Timed out waiting for the S3 gateway');
  };

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    storageClass = await requireTestStorageClass({ kubeConfig });
    await ensureFluxInstalled({ kubeConfig });
    await ensureCertManagerInstalled({ kubeConfig });
    lease = await createTestNamespace(namespace, kubeConfig);
  });

  afterAll(async () => {
    // The operator and the plugin are left installed: the suite runs on a disposable cluster.
    if (!lease) return;
    // Remove the clusters first, then the monitoring ConfigMap the operator writes into every
    // namespace with a cluster, so the namespace holds only what the suite created.
    for (const [kind, name] of [
      ['ScheduledBackup', `${composed}-scheduled`],
      ['Cluster', composed],
      ['ObjectStore', `${composed}-backups`],
      ['Cluster', restored],
      ['Cluster', source],
      ['Backup', `${source}-manual`],
      ['ObjectStore', storeName],
    ] as const) {
      const [group, version] = PLURALS[kind] ?? [];
      await deleteTestResourceAndWait(
        { apiVersion: `${group}/${version}`, kind, metadata: { name, namespace } },
        kubeConfig,
        300_000
      ).catch((error) => {
        if (!isNotFoundError(error)) throw error;
      });
    }
    await deleteTestResourceAndWait(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'cnpg-default-monitoring', namespace },
      },
      kubeConfig,
      60_000
    ).catch((error) => {
      if (!isNotFoundError(error)) throw error;
    });
    await deleteTestNamespaceAndWait(lease, kubeConfig);
  });

  it('installs a CloudNativePG operator the plugin supports, and the plugin', async () => {
    await cnpgBootstrap
      .factory('direct', { namespace: OPERATOR_NAMESPACE, waitForReady: true, timeout: 900_000 })
      .deploy({
        name: 'cnpg-operator',
        namespace: OPERATOR_NAMESPACE,
        version: BARMAN_CLOUD_TESTED_CNPG_CHART_VERSION,
      });
    const operator = await releaseOf('cnpg-operator');
    expect(operator.spec?.chart?.spec?.version).toBe('0.29.2');
    expect(condition(operator, 'Ready')).toBe(true);

    await barmanCloudPluginBootstrap
      .factory('direct', { namespace: OPERATOR_NAMESPACE, waitForReady: true, timeout: 900_000 })
      .deploy({
        name: 'barman-cloud',
        namespace: OPERATOR_NAMESPACE,
        version: BARMAN_CLOUD_PLUGIN_CHART_VERSION,
        operatorVersion: BARMAN_CLOUD_TESTED_CNPG_OPERATOR_VERSION,
      });
    const plugin = await releaseOf('barman-cloud');
    expect(plugin.spec?.chart?.spec?.version).toBe(BARMAN_CLOUD_PLUGIN_CHART_VERSION);
    expect(condition(plugin, 'Ready')).toBe(true);
    // The operator runs the version the plugin was told it runs.
    const deployment = await createAppsV1ApiClient(kubeConfig).readNamespacedDeployment({
      name: 'cnpg-operator-cloudnative-pg',
      namespace: OPERATOR_NAMESPACE,
    });
    expect(deployment.spec?.template.spec?.containers[0]?.image).toEndWith(
      `:${BARMAN_CLOUD_TESTED_CNPG_OPERATOR_VERSION}`
    );

    // The operator discovers the plugin by the chart's service, under the name it must keep.
    const service = await createCoreV1ApiClient(kubeConfig).readNamespacedService({
      name: 'barman-cloud',
      namespace: OPERATOR_NAMESPACE,
    });
    expect(service.metadata?.labels?.['cnpg.io/pluginName']).toBe('barman-cloud.cloudnative-pg.io');
  });

  it('backs a cluster up through the plugin and restores it into a new cluster', async () => {
    const endpoint = await deployS3Gateway();
    s3Endpoint = endpoint;

    // The instance-metadata endpoint, serving the gateway's keys as a role's credentials.
    const core = createCoreV1ApiClient(kubeConfig);
    await core.createNamespacedConfigMap({
      namespace,
      body: { metadata: { name: 'imds' }, data: { 'imds.py': IMDS_SCRIPT } },
    });
    await createAppsV1ApiClient(kubeConfig).createNamespacedDeployment({
      namespace,
      body: {
        metadata: { name: 'imds', labels: { app: 'imds' } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'imds' } },
          template: {
            metadata: { labels: { app: 'imds' } },
            spec: {
              containers: [
                {
                  name: 'imds',
                  image: PYTHON_IMAGE,
                  command: ['python3', '-u', '/app/imds.py'],
                  envFrom: [{ secretRef: { name: 's3-keys' } }],
                  ports: [{ containerPort: 8080 }],
                  readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2 },
                  volumeMounts: [{ name: 'script', mountPath: '/app' }],
                },
              ],
              volumes: [{ name: 'script', configMap: { name: 'imds' } }],
            },
          },
        },
      },
    });
    await core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: 'imds' },
        spec: { selector: { app: 'imds' }, ports: [{ port: 8080, targetPort: 8080 }] },
      },
    });

    const store = objectStore({
      name: storeName,
      namespace,
      spec: {
        configuration: {
          destinationPath: `s3://${BUCKET}/cnpg/${runId}`,
          endpointURL: endpoint,
          s3AddressingStyle: 'path',
          s3Credentials: { inheritFromIAMRole: true },
          wal: { compression: 'gzip' },
          data: { compression: 'gzip' },
        },
        retentionPolicy: '7d',
        instanceSidecarConfiguration: {
          env: [
            {
              name: 'AWS_EC2_METADATA_SERVICE_ENDPOINT',
              value: `http://imds.${namespace}.svc.cluster.local:8080/`,
            },
            { name: 'AWS_METADATA_SERVICE_TIMEOUT', value: '5' },
            { name: 'AWS_METADATA_SERVICE_NUM_ATTEMPTS', value: '5' },
            { name: 'AWS_DEFAULT_REGION', value: 'us-east-1' },
          ],
        },
      },
    });
    const storeManifest = manifest(store);
    expect(storeManifest.spec.configuration.s3Credentials).toEqual({ inheritFromIAMRole: true });
    await apply(storeManifest);

    const instanceSpec = {
      instances: 1,
      imageName: POSTGRES_IMAGE,
      storage: { size: '1Gi', storageClass },
      resources: { requests: { cpu: '100m', memory: '256Mi' } },
    };
    const db = cluster({
      name: source,
      namespace,
      spec: { ...instanceSpec, plugins: [barmanCloudPlugin({ objectStoreName: storeName })] },
    });
    await apply(manifest(db));
    await waitFor(
      'Cluster',
      source,
      (live) => healthy(live) && condition(live, 'ContinuousArchiving'),
      900_000
    );

    await psql(
      'write-rows',
      source,
      `${source}-app`,
      `CREATE TABLE restore_probe (id int PRIMARY KEY, note text); ` +
        `INSERT INTO restore_probe VALUES ${ROWS.map((note, index) => `(${index + 1}, '${note}')`).join(', ')};`
    );

    const manual = backup({
      name: `${source}-manual`,
      namespace,
      spec: { cluster: { name: source }, ...barmanCloudBackupMethod() },
    });
    await apply(manifest(manual));
    const done = await waitFor(
      'Backup',
      `${source}-manual`,
      (live) => live.status?.phase === 'completed',
      900_000,
      (live) => (live.status?.phase === 'failed' ? (live.status?.error ?? 'failed') : undefined)
    );
    expect(done.status?.method).toBe('plugin');

    const copy = cluster({
      name: restored,
      namespace,
      spec: {
        ...instanceSpec,
        ...barmanCloudRecovery({ objectStoreName: storeName, serverName: source }),
      },
    });
    await apply(manifest(copy));
    await waitFor('Cluster', restored, healthy, 900_000);

    // The operator resets the app role's password to the restored cluster's own app secret.
    const rows = await psql(
      'read-rows',
      restored,
      `${restored}-app`,
      "SELECT string_agg(note, ',' ORDER BY id) FROM restore_probe"
    );
    expect(rows.trim()).toBe(ROWS.join(','));

    // The plugin recorded the backup on the ObjectStore.
    const live = await read('ObjectStore', storeName);
    expect(Object.keys(live.status?.serverRecoveryWindow ?? {})).toContain(source);
  });

  it('deploys cnpgS3BackedCluster with waitForReady and converges', async () => {
    expect(s3Endpoint).not.toBe('');
    const factory = cnpgS3BackedCluster.factory('direct', {
      namespace,
      waitForReady: true,
      timeout: 900_000,
    });
    // Nightly at 02:00: the deploy must not wait for the first scheduled backup.
    await factory.deploy({
      name: composed,
      namespace,
      instances: 1,
      storageSize: '1Gi',
      bucket: BUCKET,
      prefix: `composed/${runId}`,
      schedule: '0 0 2 * * *',
    });

    const schedule = await read('ScheduledBackup', `${composed}-scheduled`);
    expect(schedule.status?.lastCheckTime).toBeString();
    expect(schedule.status?.lastScheduleTime).toBeUndefined();
    expect(healthy(await read('Cluster', composed))).toBe(true);

    // The composition targets AWS S3 through the pod's IAM role. On kind there is neither, so
    // point this test's ObjectStore at the gateway and the instance-metadata endpoint, as IRSA or
    // EKS Pod Identity would supply the role on AWS, and wait for WAL archiving to succeed.
    await createKubernetesObjectApiClient(kubeConfig).patch(
      {
        apiVersion: 'barmancloud.cnpg.io/v1',
        kind: 'ObjectStore',
        metadata: { name: `${composed}-backups`, namespace },
        spec: {
          configuration: { endpointURL: s3Endpoint, s3AddressingStyle: 'path' },
          instanceSidecarConfiguration: {
            env: [
              {
                name: 'AWS_EC2_METADATA_SERVICE_ENDPOINT',
                value: `http://imds.${namespace}.svc.cluster.local:8080/`,
              },
              { name: 'AWS_METADATA_SERVICE_TIMEOUT', value: '5' },
              { name: 'AWS_METADATA_SERVICE_NUM_ATTEMPTS', value: '5' },
              { name: 'AWS_DEFAULT_REGION', value: 'us-east-1' },
            ],
          },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      'application/merge-patch+json'
    );
    // The plugin injects the sidecar, with its env, when an instance pod is created: restart the
    // cluster's pods so they pick up the patched ObjectStore.
    await createKubernetesObjectApiClient(kubeConfig).patch(
      {
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Cluster',
        metadata: {
          name: composed,
          namespace,
          annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      'application/merge-patch+json'
    );
    await waitFor(
      'Cluster',
      composed,
      (live) => healthy(live) && condition(live, 'ContinuousArchiving'),
      900_000
    );

    // The composition's status expressions, as KRO evaluates them, hold on the live objects.
    const graph = (yaml.loadAll(cnpgS3BackedCluster.toYaml()) as any[]).find(
      (document) => document?.kind === 'ResourceGraphDefinition'
    );
    const statusFields = graph.spec.schema.status as Record<string, string>;
    const context = {
      cluster: await read('Cluster', composed),
      scheduledBackup: await read('ScheduledBackup', `${composed}-scheduled`),
    };
    const statusNow = Object.fromEntries(
      ['ready', 'clusterReady', 'walArchiving', 'scheduledBackupReady'].map((field) => [
        field,
        evaluate((statusFields[field] ?? '').slice(2, -1), context),
      ])
    );
    expect(statusNow).toEqual({
      ready: true,
      clusterReady: true,
      walArchiving: true,
      scheduledBackupReady: true,
    });
  });

  it('has the API server refuse bad buckets on a KRO instance of cnpgS3BackedCluster', async () => {
    const custom = createCustomObjectsApiClient(kubeConfig);
    const kroInstalled = await custom
      .listClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
      })
      .then(() => true)
      .catch(() => false);
    if (!kroInstalled) {
      console.warn('KRO is not installed; skipping the live admission check.');
      return;
    }
    const rgd = (yaml.loadAll(cnpgS3BackedCluster.toYaml()) as any[]).find(
      (document) => document?.kind === 'ResourceGraphDefinition'
    );
    const objects = createKubernetesObjectApiClient(kubeConfig);
    await objects.create(rgd);
    try {
      // KRO creates the instance CRD once it accepts the graph.
      const startedAt = Date.now();
      let crdReady = false;
      while (!crdReady && Date.now() - startedAt < 300_000) {
        crdReady = await objects
          .read({
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            metadata: { name: 'cnpgs3backedclusters.kro.run' },
          })
          .then(() => true)
          .catch(() => false);
        if (!crdReady) await Bun.sleep(3_000);
      }
      expect(crdReady).toBe(true);

      const instance = {
        name: 'admission-probe',
        namespace,
        instances: 1,
        storageSize: '1Gi',
        bucket: 'example-backups',
        prefix: 'cnpg/probe',
        schedule: '0 0 2 * * *',
      };
      // Server-side dry runs with strict field validation: checked, never stored.
      const create = (spec: Record<string, unknown>) =>
        custom.createNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace,
          plural: 'cnpgs3backedclusters',
          body: {
            apiVersion: 'kro.run/v1alpha1',
            kind: 'CnpgS3BackedCluster',
            metadata: { name: 'admission-probe' },
            spec,
          },
          dryRun: 'All',
          fieldValidation: 'Strict',
        });
      await create(instance);
      for (const bucket of ['example..backup', '192.168.5.4', 'xn--example', 'example.mrap']) {
        await expect(create({ ...instance, bucket })).rejects.toThrow();
      }
      await expect(create({ ...instance, inheritFromIAMRole: false })).rejects.toThrow();
    } finally {
      await objects.delete(rgd).catch(() => undefined);
    }
  });
});
