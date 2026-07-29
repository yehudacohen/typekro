/**
 * Live Hatchet proof against a real cluster.
 *
 * bun test test/integration/hatchet/hatchet-installation.test.ts
 *
 * Requires Flux, KRO, CloudNativePG, and TYPEKRO_TEST_STORAGE_CLASS. The shared
 * integration bootstrap installs those controllers. Each mode uses isolated,
 * externally owned namespaces so the database authority survives normal
 * Hatchet installation deletion until the harness removes the fixture.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { KubernetesObject } from '@kubernetes/client-node';
import { hatchetInstallation } from '../../../src/factories/hatchet/compositions/hatchet-installation.js';
import {
  DEFAULT_HATCHET_CHART_VERSION,
  DEFAULT_HATCHET_SERVER_VERSION,
} from '../../../src/factories/hatchet/resources/helm.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isNotFoundError,
  type ResourceIdentity,
  requireTestStorageClass,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;
const runId = crypto.randomUUID().slice(0, 10);

setDefaultTimeout(1_200_000);

interface HatchetStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Installing' | 'Ready' | 'Failed';
  chartVersion: string;
  serverVersion: string;
  endpoint: string;
  grpcEndpoint: string;
  configurationSecret: string;
  workerTokenSecret: string;
  dashboardEnabled: boolean;
}

async function waitForCnpgReady(namespace: string, name: string, timeoutMs: number): Promise<void> {
  const objectApi = createKubernetesObjectApiClient(getIntegrationTestKubeConfig());
  const startedAt = Date.now();
  let last: KubernetesObject | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    last = await objectApi.read({
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { namespace, name },
    });
    const status = Reflect.get(last, 'status');
    if (
      status &&
      typeof status === 'object' &&
      Reflect.get(status, 'phase') === 'Cluster in healthy state'
    ) {
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(
    `Timed out waiting for CloudNativePG Cluster ${namespace}/${name}: ${JSON.stringify(
      Reflect.get(last ?? {}, 'status')
    )}`
  );
}

async function waitForSecretValue(
  namespace: string,
  name: string,
  key: string,
  timeoutMs: number
): Promise<string> {
  const coreApi = createCoreV1ApiClient(getIntegrationTestKubeConfig());
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const secret = await coreApi.readNamespacedSecret({ namespace, name });
      const encoded = secret.data?.[key];
      if (encoded) return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for Secret ${namespace}/${name} key ${key}`);
}

async function waitForPodCompletion(
  namespace: string,
  name: string,
  timeoutMs: number
): Promise<string> {
  const coreApi = createCoreV1ApiClient(getIntegrationTestKubeConfig());
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pod = await coreApi.readNamespacedPod({ namespace, name });
    if (pod.status?.phase === 'Succeeded') {
      return coreApi.readNamespacedPodLog({
        namespace,
        name,
        container: 'probe',
      });
    }
    if (pod.status?.phase === 'Failed') {
      const logs = await coreApi
        .readNamespacedPodLog({ namespace, name, container: 'probe' })
        .catch(() => '');
      throw new Error(`Hatchet data-plane probe ${namespace}/${name} failed: ${logs}`);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for Hatchet data-plane probe ${namespace}/${name}`);
}

async function probeHatchetApi(
  mode: 'direct' | 'kro',
  namespace: string,
  endpoint: string
): Promise<void> {
  const coreApi = createCoreV1ApiClient(getIntegrationTestKubeConfig());
  const name = `hatchet-probe-${mode}`;
  const pod = await coreApi.createNamespacedPod({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'probe',
            image: 'curlimages/curl:8.12.1',
            command: ['sh', '-ec', `curl --fail --silent --show-error ${endpoint}/api/ready`],
          },
        ],
      },
    },
  });
  const uid = pod.metadata?.uid;
  if (!uid) {
    throw new Error(`Created Hatchet probe ${namespace}/${name} has no UID`);
  }
  try {
    const logs = await waitForPodCompletion(namespace, name, 180_000);
    expect(logs.toLowerCase()).not.toContain('error');
  } finally {
    await deleteTestResourceAndWait(
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { namespace, name, uid },
      },
      getIntegrationTestKubeConfig()
    );
  }
}

async function assertHatchetPodsReady(mode: 'direct' | 'kro', namespace: string): Promise<void> {
  const pods = await createCoreV1ApiClient(getIntegrationTestKubeConfig()).listNamespacedPod({
    namespace,
  });
  const workloads = pods.items.filter(
    (pod) =>
      !pod.metadata?.deletionTimestamp &&
      pod.metadata?.ownerReferences?.some(
        (owner) => owner.kind === 'ReplicaSet' || owner.kind === 'StatefulSet'
      ) &&
      !pod.metadata?.labels?.['cnpg.io/cluster']
  );
  expect(workloads.length).toBeGreaterThanOrEqual(2);
  for (const pod of workloads) {
    expect(pod.status?.phase).toBe('Running');
    expect(pod.status?.containerStatuses?.length ?? 0).toBeGreaterThan(0);
    expect(pod.status?.containerStatuses?.every((container) => container.ready)).toBe(true);
    const restarts =
      pod.status?.containerStatuses?.reduce(
        (total, container) => total + container.restartCount,
        0
      ) ?? 0;
    expect(restarts).toBeLessThanOrEqual(mode === 'kro' ? 10 : 2);
  }
}

async function assertLiveHelmContract(namespace: string, dashboardEnabled: boolean): Promise<void> {
  const release = await createKubernetesObjectApiClient(getIntegrationTestKubeConfig()).read({
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { namespace, name: 'hatchet' },
  });
  const spec = Reflect.get(release, 'spec');
  const status = Reflect.get(release, 'status');
  expect(spec).toMatchObject({
    chart: {
      spec: {
        chart: 'hatchet-stack',
        version: DEFAULT_HATCHET_CHART_VERSION,
      },
    },
    values: {
      postgres: { enabled: false },
      rabbitmq: { enabled: false },
      sharedConfig: {
        image: { tag: DEFAULT_HATCHET_SERVER_VERSION },
        env: { SERVER_MSGQUEUE_KIND: 'postgres' },
      },
      frontend: { enabled: dashboardEnabled },
    },
    valuesFrom: [
      {
        kind: 'Secret',
        name: expect.stringContaining('hatchet-db-'),
        valuesKey: 'uri',
        targetPath: 'sharedConfig.env.DATABASE_URL',
      },
      {
        kind: 'Secret',
        name: expect.stringContaining('hatchet-admin-'),
        valuesKey: 'adminEmail',
        targetPath: 'sharedConfig.defaultAdminEmail',
      },
      {
        kind: 'Secret',
        name: expect.stringContaining('hatchet-admin-'),
        valuesKey: 'adminPassword',
        targetPath: 'sharedConfig.defaultAdminPassword',
      },
    ],
  });
  const generation = release.metadata?.generation;
  const observedGeneration =
    status && typeof status === 'object' ? Reflect.get(status, 'observedGeneration') : undefined;
  expect(typeof generation).toBe('number');
  expect(typeof observedGeneration).toBe('number');
  expect(Number(observedGeneration)).toBeGreaterThanOrEqual(Number(generation));
}

async function prepareDatabase(
  namespace: string,
  name: string,
  storageClass: string
): Promise<ResourceIdentity> {
  const objectApi = createKubernetesObjectApiClient(getIntegrationTestKubeConfig());
  const cluster = await objectApi.create({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: { namespace, name },
    spec: {
      instances: 1,
      storage: { size: '1Gi', storageClass },
      bootstrap: { initdb: { database: 'hatchet', owner: 'app' } },
      postgresql: { parameters: { timezone: 'UTC' } },
    },
  });
  await waitForCnpgReady(namespace, name, 300_000);
  await waitForSecretValue(namespace, `${name}-app`, 'uri', 60_000);
  const metadata = Reflect.get(cluster, 'metadata');
  const uid = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'uid') : undefined;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new Error(`Created CloudNativePG Cluster ${namespace}/${name} has no UID`);
  }
  return {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: { namespace, name, uid },
  };
}

async function prepareAdminSecret(namespace: string, name: string): Promise<ResourceIdentity> {
  const coreApi = createCoreV1ApiClient(getIntegrationTestKubeConfig());
  const secret = await coreApi.createNamespacedSecret({
    namespace,
    body: {
      metadata: { name },
      type: 'Opaque',
      stringData: {
        adminEmail: `typekro-${runId}@example.test`,
        adminPassword: `TypeKro-${runId}-Hatchet`,
      },
    },
  });
  const uid = secret.metadata?.uid;
  if (!uid) {
    throw new Error(`Created Secret ${namespace}/${name} has no UID`);
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { namespace, name, uid },
  };
}

async function readSecretIdentity(namespace: string, name: string): Promise<ResourceIdentity> {
  const secret = await createCoreV1ApiClient(getIntegrationTestKubeConfig()).readNamespacedSecret({
    namespace,
    name,
  });
  const uid = secret.metadata?.uid;
  if (!uid) {
    throw new Error(`Secret ${namespace}/${name} has no UID`);
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { namespace, name, uid },
  };
}

async function assertResourceIdentity(identity: ResourceIdentity): Promise<void> {
  const expectedUid = identity.metadata.uid;
  if (!expectedUid) {
    throw new Error(
      `Expected retained ${identity.kind} ${identity.metadata.namespace}/${identity.metadata.name} to have a UID`
    );
  }
  const resource = await createKubernetesObjectApiClient(getIntegrationTestKubeConfig()).read(
    identity
  );
  expect(resource.metadata?.uid).toBe(expectedUid);
}

async function proveMode(mode: 'direct' | 'kro'): Promise<void> {
  const suffix = `${mode}-${runId}`;
  const controlNamespace = `tk-hatchet-control-${suffix}`.slice(0, 63);
  const targetNamespace = `tk-hatchet-${suffix}`.slice(0, 63);
  const clusterName = `hatchet-db-${mode}`;
  const adminSecret = `hatchet-admin-${mode}`;
  const kubeConfig = getIntegrationTestKubeConfig();
  const storageClass = await requireTestStorageClass({ kubeConfig });
  const factory = hatchetInstallation.factory(mode, {
    namespace: controlNamespace,
    waitForReady: true,
    timeout: 900_000,
    kubeConfig,
  });
  let controlLease: TestNamespaceLease | undefined;
  let targetLease: TestNamespaceLease | undefined;
  let databaseFixture: ResourceIdentity | undefined;
  let adminFixture: ResourceIdentity | undefined;
  let retainedRecoveryArtifacts: ResourceIdentity[] = [];
  let testFailure: Error | undefined;

  try {
    controlLease = await createTestNamespace(controlNamespace, kubeConfig);
    targetLease = await createTestNamespace(targetNamespace, kubeConfig);
    databaseFixture = await prepareDatabase(targetNamespace, clusterName, storageClass);
    adminFixture = await prepareAdminSecret(targetNamespace, adminSecret);

    const expectedEndpoint = `http://hatchet-api.${targetNamespace}.svc:8080`;
    const expectedGrpc = `hatchet-engine.${targetNamespace}.svc:7070`;
    const deployed = await factory.deploy({
      name: 'hatchet',
      namespace: targetNamespace,
      namespaceOwnership: 'external',
      repositoryNamespaceOwnership: 'external',
      database: {
        connectionSecret: { name: `${clusterName}-app`, key: 'uri' },
      },
      adminCredentialsSecret: { name: adminSecret },
      dashboard: true,
    });
    expect(deployed.status).toMatchObject({
      ready: true,
      failed: false,
      phase: 'Ready',
      chartVersion: DEFAULT_HATCHET_CHART_VERSION,
      serverVersion: DEFAULT_HATCHET_SERVER_VERSION,
      endpoint: expectedEndpoint,
      grpcEndpoint: expectedGrpc,
      configurationSecret: 'hatchet-config',
      workerTokenSecret: 'hatchet-client-config',
      dashboardEnabled: true,
    } satisfies HatchetStatus);

    const token = await waitForSecretValue(
      targetNamespace,
      'hatchet-client-config',
      'HATCHET_CLIENT_TOKEN',
      180_000
    );
    expect(token.length).toBeGreaterThan(20);
    retainedRecoveryArtifacts = await Promise.all([
      readSecretIdentity(targetNamespace, 'hatchet-config'),
      readSecretIdentity(targetNamespace, 'hatchet-client-config'),
    ]);
    await assertLiveHelmContract(targetNamespace, true);
    await assertHatchetPodsReady(mode, targetNamespace);
    await probeHatchetApi(mode, targetNamespace, expectedEndpoint);

    const updated = await factory.deploy({
      name: 'hatchet',
      namespace: targetNamespace,
      namespaceOwnership: 'external',
      repositoryNamespaceOwnership: 'external',
      database: {
        connectionSecret: { name: `${clusterName}-app`, key: 'uri' },
      },
      adminCredentialsSecret: { name: adminSecret },
      dashboard: false,
    });
    expect(updated.status).toMatchObject({
      ready: true,
      failed: false,
      phase: 'Ready',
      chartVersion: DEFAULT_HATCHET_CHART_VERSION,
      serverVersion: DEFAULT_HATCHET_SERVER_VERSION,
      endpoint: expectedEndpoint,
      grpcEndpoint: expectedGrpc,
      configurationSecret: 'hatchet-config',
      workerTokenSecret: 'hatchet-client-config',
      dashboardEnabled: false,
    } satisfies HatchetStatus);
    await assertLiveHelmContract(targetNamespace, false);
    await assertHatchetPodsReady(mode, targetNamespace);
    await probeHatchetApi(mode, targetNamespace, expectedEndpoint);
  } catch (error: unknown) {
    testFailure = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupFailures: Error[] = [];
  try {
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      factory,
      'hatchet',
      [],
      kubeConfig,
      300_000
    );
  } catch (error: unknown) {
    cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
  }
  for (const artifact of retainedRecoveryArtifacts) {
    try {
      await assertResourceIdentity(artifact);
      await deleteTestResourceAndWait(artifact, kubeConfig, 60_000);
    } catch (error: unknown) {
      cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (databaseFixture) {
    try {
      await deleteTestResourceAndWait(databaseFixture, kubeConfig, 300_000);
    } catch (error: unknown) {
      cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (adminFixture) {
    try {
      await deleteTestResourceAndWait(adminFixture, kubeConfig, 300_000);
    } catch (error: unknown) {
      cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  for (const lease of [targetLease, controlLease]) {
    if (!lease) continue;
    try {
      await deleteTestNamespaceAndWait(lease, kubeConfig);
    } catch (error: unknown) {
      cleanupFailures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (testFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(testFailure ? [testFailure] : []), ...cleanupFailures],
      `${mode} Hatchet integration failed`
    );
  }
}

describeOrSkip('Hatchet direct and KRO integration', () => {
  it('installs, updates, probes, and deletes in direct mode', async () => {
    await proveMode('direct');
  });

  it('installs, updates, probes, and deletes in KRO mode', async () => {
    await proveMode('kro');
  });
});
