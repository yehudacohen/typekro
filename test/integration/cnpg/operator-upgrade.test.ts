/**
 * Live CloudNativePG operator upgrade from the old default to the new one.
 *
 * Installs chart 0.23.0 (operator 1.25.0, the previous `cnpgBootstrap` default), creates a
 * cluster without an `imageName` and writes rows, then redeploys `cnpgBootstrap` without a
 * `version`, which upgrades the operator to the new default (chart 0.29.2, operator 1.30.2). It
 * checks that the existing cluster comes back healthy on the image it had, with its rows, and that
 * a new cluster without an `imageName` gets PostgreSQL 18.
 *
 * It installs and upgrades a cluster-scoped operator, so it runs only when asked:
 * `TYPEKRO_CNPG_UPGRADE_LIVE=true` and `TYPEKRO_TEST_STORAGE_CLASS`, on a disposable cluster such
 * as kind. `bun run test:integration:cnpg-operator-upgrade` runs it. CI does not run it: the CI
 * workflow has no Kubernetes cluster.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(1_800_000);

import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  cluster,
  cnpgBootstrap,
  DEFAULT_CNPG_CHART_VERSION,
  DEFAULT_CNPG_OPERATOR_VERSION,
} from '../../../src/factories/cnpg/index.js';
import {
  createAppsV1ApiClient,
  createCustomObjectsApiClient,
  createTestNamespace,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  ensureFluxInstalled,
  isClusterAvailable,
  isNotFoundError,
  requireTestStorageClass,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const enabled = process.env.TYPEKRO_CNPG_UPGRADE_LIVE === 'true' && (await isClusterAvailable());
const describeOrSkip = enabled ? describe : describe.skip;

const OPERATOR_NAMESPACE = 'cnpg-system';
const OPERATOR_RELEASE = 'cnpg-operator';
const PREVIOUS_CHART_VERSION = '0.23.0';
const PREVIOUS_OPERATOR_VERSION = '1.25.0';
/** psql client for the probes. */
const PSQL_IMAGE = 'ghcr.io/cloudnative-pg/postgresql:17.5';
const ROWS = ['alpha', 'bravo', 'charlie'];

describeOrSkip('CNPG operator upgrade to the new default (live)', () => {
  let kubeConfig: k8s.KubeConfig;
  let storageClass: string;
  let lease: TestNamespaceLease | undefined;
  const runId = crypto.randomUUID().slice(0, 8);
  const namespace = `typekro-cnpg-upgrade-${runId}`;
  const existing = 'existing';
  const created = 'created-after';
  let imageBefore = '';

  const custom = () => createCustomObjectsApiClient(kubeConfig);

  const readCluster = async (name: string): Promise<any> => {
    const live: any = await custom().getNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace,
      plural: 'clusters',
      name,
    });
    return live?.body ?? live;
  };

  const healthy = (live: any) =>
    (live?.status?.conditions ?? []).some(
      (entry: { type?: string; status?: string }) =>
        entry.type === 'Ready' && entry.status === 'True'
    ) &&
    live.status?.phase === 'Cluster in healthy state' &&
    (live.status?.readyInstances ?? 0) >= (live.spec?.instances ?? 1);

  const waitForCluster = async (name: string, done: (live: any) => boolean) => {
    const startedAt = Date.now();
    let last: any;
    while (Date.now() - startedAt < 900_000) {
      last = await readCluster(name).catch(() => undefined);
      if (last && done(last)) return last;
      await Bun.sleep(5_000);
    }
    throw new Error(
      `Timed out waiting for Cluster ${name}; status ${JSON.stringify(last?.status)}`
    );
  };

  const operatorImage = async () => {
    const deployment = await createAppsV1ApiClient(kubeConfig).readNamespacedDeployment({
      name: `${OPERATOR_RELEASE}-cloudnative-pg`,
      namespace: OPERATOR_NAMESPACE,
    });
    return deployment.spec?.template.spec?.containers[0]?.image ?? '';
  };

  const waitForOperator = async (version: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 900_000) {
      const deployment = await createAppsV1ApiClient(kubeConfig)
        .readNamespacedDeployment({
          name: `${OPERATOR_RELEASE}-cloudnative-pg`,
          namespace: OPERATOR_NAMESPACE,
        })
        .catch(() => undefined);
      const status = deployment?.status;
      if (
        deployment?.spec?.template.spec?.containers[0]?.image?.endsWith(`:${version}`) &&
        (status?.updatedReplicas ?? 0) >= 1 &&
        status?.readyReplicas === status?.replicas &&
        (status?.unavailableReplicas ?? 0) === 0
      ) {
        return;
      }
      await Bun.sleep(5_000);
    }
    throw new Error(`Timed out waiting for the operator to run ${version}`);
  };

  /** psql against `<cluster>-rw` as the app user, retrying while the service catches up. */
  const psql = (name: string, clusterName: string, sql: string) =>
    runTestPodAndReadLogs(
      {
        namespace,
        name,
        image: PSQL_IMAGE,
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
            valueFrom: { secretKeyRef: { name: `${clusterName}-app`, key } },
          })),
        ],
        timeoutMs: 420_000,
      },
      kubeConfig
    );

  const createCluster = async (name: string) => {
    const db = cluster({
      name,
      namespace,
      spec: {
        instances: 1,
        storage: { size: '1Gi', storageClass },
        resources: { requests: { cpu: '100m', memory: '256Mi' } },
      },
    });
    await custom().createNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace,
      plural: 'clusters',
      body: JSON.parse(
        JSON.stringify({
          apiVersion: db.apiVersion,
          kind: db.kind,
          metadata: db.metadata,
          spec: db.spec,
        })
      ),
    });
  };

  const deployOperator = (version?: string) =>
    cnpgBootstrap
      .factory('direct', { namespace: OPERATOR_NAMESPACE, waitForReady: true, timeout: 900_000 })
      .deploy({
        name: OPERATOR_RELEASE,
        namespace: OPERATOR_NAMESPACE,
        ...(version !== undefined && { version }),
      });

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    storageClass = await requireTestStorageClass({ kubeConfig });
    await ensureFluxInstalled({ kubeConfig });
    lease = await createTestNamespace(namespace, kubeConfig);
  });

  afterAll(async () => {
    // The operator is left installed: the suite runs on a disposable cluster.
    if (!lease) return;
    for (const name of [created, existing]) {
      await deleteTestResourceAndWait(
        { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name, namespace } },
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

  it('runs a cluster on the previous default operator', async () => {
    await deployOperator(PREVIOUS_CHART_VERSION);
    await waitForOperator(PREVIOUS_OPERATOR_VERSION);

    await createCluster(existing);
    const live = await waitForCluster(existing, healthy);
    imageBefore = live.status?.image ?? '';
    expect(imageBefore).toContain('postgresql:');

    await psql(
      'write-rows',
      existing,
      `CREATE TABLE upgrade_probe (id int PRIMARY KEY, note text); ` +
        `INSERT INTO upgrade_probe VALUES ${ROWS.map((note, index) => `(${index + 1}, '${note}')`).join(', ')};`
    );
  });

  it('upgrades to the new default when redeployed without a version', async () => {
    expect(DEFAULT_CNPG_CHART_VERSION).toBe('0.29.2');
    await deployOperator();
    await waitForOperator(DEFAULT_CNPG_OPERATOR_VERSION);
    expect(await operatorImage()).toEndWith(`:${DEFAULT_CNPG_OPERATOR_VERSION}`);

    // The instance manager rolls; the cluster comes back healthy on the image it had.
    await Bun.sleep(30_000);
    const live = await waitForCluster(existing, healthy);
    expect(live.status?.image).toBe(imageBefore);
    const rows = await psql(
      'read-rows',
      existing,
      "SELECT string_agg(note, ',' ORDER BY id) FROM upgrade_probe"
    );
    expect(rows.trim()).toBe(ROWS.join(','));
  });

  it('gives a new cluster without an imageName PostgreSQL 18', async () => {
    await createCluster(created);
    const live = await waitForCluster(created, healthy);
    expect(live.status?.image).toContain('postgresql:18.');
  });
});
