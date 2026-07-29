import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { isNotFoundError } from '../../../src/core/deployment/k8s-helpers.js';
import {
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
} from '../../../src/core/kubernetes/index.js';
import {
  makeOpenSearchCluster,
  openSearchOperatorBootstrap,
} from '../../../src/factories/opensearch/index.js';
import {
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestSecretAndWait,
  isClusterAvailable,
  requireTestStorageClass,
  type TestNamespaceLease,
  waitForResourceAbsent,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true'
    ? describe
    : describe.skip;

setDefaultTimeout(1_500_000);

async function createCredentials(
  kubeConfig: ReturnType<typeof getKubeConfig>,
  namespace: string,
  clusterName: string
): Promise<{
  readonly admin: string;
  readonly dashboards: string;
}> {
  const admin = `${clusterName}-test-admin`;
  const dashboards = `${clusterName}-test-dashboards`;
  const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
  await Promise.all([
    coreApi.createNamespacedSecret({
      namespace,
      body: {
        metadata: {
          name: admin,
          labels: { 'typekro.dev/integration-test': 'owned' },
        },
        stringData: {
          username: 'admin',
          password: 'TypeKro-OpenSearch-Test-Only-123!',
        },
      },
    }),
    coreApi.createNamespacedSecret({
      namespace,
      body: {
        metadata: {
          name: dashboards,
          labels: { 'typekro.dev/integration-test': 'owned' },
        },
        stringData: {
          username: 'kibanaserver',
          password: 'TypeKro-Dashboards-Test-Only-123!',
        },
      },
    }),
  ]);
  return { admin, dashboards };
}

async function deleteCredentials(
  kubeConfig: ReturnType<typeof getKubeConfig>,
  namespace: string,
  names: { readonly admin: string; readonly dashboards: string }
): Promise<void> {
  const results = await Promise.allSettled([
    deleteTestSecretAndWait(namespace, names.admin, kubeConfig),
    deleteTestSecretAndWait(namespace, names.dashboards, kubeConfig),
  ]);
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, `Credential cleanup failed in ${namespace}`);
  }
}

async function deleteDataPvcs(
  kubeConfig: ReturnType<typeof getKubeConfig>,
  namespace: string,
  clusterName: string
): Promise<void> {
  const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
  const listed = await coreApi.listNamespacedPersistentVolumeClaim({
    namespace,
  });
  const claims = listed.items.filter(
    (claim) =>
      claim.metadata?.labels?.['opensearch.org/opensearch-cluster'] ===
      clusterName
  );
  for (const claim of claims) {
    const name = claim.metadata?.name;
    const uid = claim.metadata?.uid;
    if (!name || !uid) {
      throw new Error(
        `Refusing OpenSearch PVC cleanup in ${namespace}: identity is incomplete`
      );
    }
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        namespace,
        name,
        body: { preconditions: { uid } },
      });
    } catch (error) {
      if (isNotFoundError(error)) continue;
      throw error;
    }
    await waitForResourceAbsent(
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { namespace, name },
      },
      kubeConfig,
      60_000
    );
  }
}

describeOrSkip('OpenSearch direct and KRO lifecycle', () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const operatorControlNamespace = 'typekro-system';
  const operatorNamespace = 'opensearch-operator-system';
  const directNamespace = `typekro-os-direct-${suffix}`;
  const kroControlNamespace = `typekro-os-kro-control-${suffix}`;
  const kroNamespace = `typekro-os-kro-${suffix}`;
  const leases: TestNamespaceLease[] = [];
  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let storageClass: string;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    storageClass = await requireTestStorageClass({ kubeConfig });
    leases.push(
      ...(await Promise.all(
        [
          directNamespace,
          kroControlNamespace,
          kroNamespace,
        ].map((name) => createTestNamespace(name, kubeConfig))
      ))
    );
    const operatorFactory = openSearchOperatorBootstrap.factory('direct', {
      namespace: operatorControlNamespace,
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });
    const operator = await operatorFactory.deploy({
      name: 'opensearch-operator',
      namespace: operatorNamespace,
      shared: true,
    });
    expect(operator.status).toMatchObject({
      ready: true,
      failed: false,
      phase: 'Ready',
      version: '3.0.2',
    });
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    // The operator, its CRDs, and HelmRepository are cluster platform
    // infrastructure. Shared lifecycle intentionally retains and reuses them
    // across suites; only the per-run data-plane instances are ephemeral.
    const namespaceResults = await Promise.allSettled(
      leases.map((lease) => deleteTestNamespaceAndWait(lease, kubeConfig))
    );
    errors.push(
      ...namespaceResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'OpenSearch integration cleanup failed');
    }
  });

  test('deploys, updates, reports complete status, and deletes in direct mode', async () => {
    const credentials = await createCredentials(
      kubeConfig,
      directNamespace,
      'direct-search'
    );
    const factory = makeOpenSearchCluster().factory('direct', {
      namespace: directNamespace,
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });
    let testFailed = false;
    let testError: unknown;
    try {
      const deployed = await factory.deploy({
        name: 'direct-search',
        namespace: directNamespace,
        version: '3.2.0',
        lifecycle: 'external-delete',
        storage: { size: '1Gi', storageClassName: storageClass },
        tls: { source: 'generated' },
        adminCredentialsSecret: { name: credentials.admin },
        dashboardCredentialsSecret: { name: credentials.dashboards },
        resources: {
          requests: { cpu: '100m', memory: '768Mi' },
          limits: { cpu: '1000m', memory: '1Gi' },
        },
      });
      expect(deployed.status).toMatchObject({
        ready: true,
        failed: false,
        phase: 'Ready',
        version: '3.2.0',
        availableNodes: 3,
      });
      expect(['green', 'yellow']).toContain(deployed.status.health);
      expect(deployed.status.endpoint).toBe(
        `https://direct-search.${directNamespace}.svc.cluster.local:9200`
      );
      expect(deployed.status.credentialsSecret).toBe(
        credentials.admin
      );

      const updated = await factory.deploy({
        name: 'direct-search',
        namespace: directNamespace,
        version: '3.2.0',
        lifecycle: 'external-delete',
        storage: { size: '1Gi', storageClassName: storageClass },
        tls: { source: 'generated' },
        adminCredentialsSecret: { name: credentials.admin },
        dashboardCredentialsSecret: { name: credentials.dashboards },
        monitoring: true,
        resources: {
          requests: { cpu: '100m', memory: '768Mi' },
          limits: { cpu: '1000m', memory: '1Gi' },
        },
      });
      expect(updated.status.ready).toBe(true);
    } catch (error) {
      testFailed = true;
      testError = error;
    }
    const cleanupErrors: unknown[] = [];
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      factory,
      'direct-search',
      [],
      kubeConfig,
      240_000
    ).catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length === 0) {
      await deleteCredentials(
        kubeConfig,
        directNamespace,
        credentials
      ).catch((error) => cleanupErrors.push(error));
      await deleteDataPvcs(
        kubeConfig,
        directNamespace,
        'direct-search'
      ).catch((error) => cleanupErrors.push(error));
    }
    const errors = [
      ...(testFailed ? [testError] : []),
      ...cleanupErrors,
    ];
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Direct OpenSearch test failed');
    }
  });

  test('deploys an RGD, projects live status, and deletes through KRO finalization', async () => {
    const credentials = await createCredentials(
      kubeConfig,
      kroNamespace,
      'kro-search'
    );
    const factory = makeOpenSearchCluster().factory('kro', {
      namespace: kroControlNamespace,
      waitForReady: true,
      timeout: 900_000,
      kubeConfig,
    });
    let testFailed = false;
    let testError: unknown;
    try {
      const deployed = await factory.deploy({
        name: 'kro-search',
        namespace: kroNamespace,
        version: '3.2.0',
        lifecycle: 'external-delete',
        storage: { size: '1Gi', storageClassName: storageClass },
        tls: { source: 'generated' },
        adminCredentialsSecret: { name: credentials.admin },
        dashboardCredentialsSecret: { name: credentials.dashboards },
        resources: {
          requests: { cpu: '100m', memory: '768Mi' },
          limits: { cpu: '1000m', memory: '1Gi' },
        },
      });
      expect(deployed.status).toMatchObject({
        ready: true,
        failed: false,
        phase: 'Ready',
        version: '3.2.0',
        availableNodes: 3,
      });
      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const clusterRaw = await customApi.getNamespacedCustomObject({
        group: 'opensearch.org',
        version: 'v1',
        namespace: kroNamespace,
        plural: 'opensearchclusters',
        name: 'kro-search',
      });
      const cluster = (
        clusterRaw as { readonly body?: Record<string, unknown> }
      ).body ?? clusterRaw;
      expect(Reflect.get(cluster, 'status')).toMatchObject({
        initialized: true,
        availableNodes: 3,
      });

      const instanceRaw = await customApi.getNamespacedCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        namespace: kroControlNamespace,
        plural: 'opensearchclusterinstallations',
        name: 'kro-search',
      });
      const instance = (
        instanceRaw as { readonly body?: Record<string, unknown> }
      ).body ?? instanceRaw;
      expect(Reflect.get(instance, 'status')).toMatchObject({
        ready: true,
        phase: 'Ready',
        availableNodes: 3,
        health: expect.stringMatching(/green|yellow/),
      });
    } catch (error) {
      testFailed = true;
      testError = error;
    }
    const cleanupErrors: unknown[] = [];
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      factory,
      'kro-search',
      [],
      kubeConfig,
      240_000
    ).catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length === 0) {
      await deleteCredentials(
        kubeConfig,
        kroNamespace,
        credentials
      ).catch((error) => cleanupErrors.push(error));
      await deleteDataPvcs(kubeConfig, kroNamespace, 'kro-search').catch(
        (error) => cleanupErrors.push(error)
      );
    }
    const errors = [
      ...(testFailed ? [testError] : []),
      ...cleanupErrors,
    ];
    if (errors.length > 0) {
      throw new AggregateError(errors, 'KRO OpenSearch test failed');
    }
  });
});
