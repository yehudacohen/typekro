import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);

import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleAppsV1Api,
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../../../src/core/kubernetes/index.js';
import {
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  isClusterAvailable,
  isNotFoundError,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

async function deleteHelmOwnedClusterResource(
  kubeConfig: any,
  apiVersion: string,
  kind: string,
  name: string,
  releaseNamespace: string
): Promise<void> {
  const objectApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

  try {
    const resource: any = await objectApi.read({ apiVersion, kind, metadata: { name } });
    const annotations = resource.metadata?.annotations ?? {};
    const subjects = Array.isArray(resource.subjects) ? resource.subjects : [];
    const hasSubjectInReleaseNamespace = subjects.some(
      (subject: { namespace?: string }) => subject.namespace === releaseNamespace
    );
    if (
      annotations['meta.helm.sh/release-namespace'] !== releaseNamespace &&
      !hasSubjectInReleaseNamespace
    ) {
      return;
    }

    await deleteTestResourceAndWait({ apiVersion, kind, metadata: { name } }, kubeConfig, 60_000);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

async function restartSharedCnpgOperatorIfPresent(kubeConfig: any): Promise<void> {
  const namespace = 'cnpg-system';
  const deploymentName = 'cnpg-operator-cloudnative-pg';
  const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
  const appsApi = createBunCompatibleAppsV1Api(kubeConfig);

  try {
    await appsApi.readNamespacedDeployment({ name: deploymentName, namespace });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  try {
    const pods = await coreApi.listNamespacedPod({
      namespace,
      labelSelector:
        'app.kubernetes.io/name=cloudnative-pg,app.kubernetes.io/instance=cnpg-operator',
    });

    const deletionResults = await Promise.allSettled(
      pods.items
        .map((pod) => pod.metadata?.name)
        .filter((name): name is string => Boolean(name))
        .map((name) =>
          deleteTestResourceAndWait(
            { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace } },
            kubeConfig,
            60_000
          )
        )
    );
    const deletionErrors = deletionResults.flatMap((result) =>
      result.status === 'rejected' && !isNotFoundError(result.reason) ? [result.reason] : []
    );
    if (deletionErrors.length > 0) {
      throw new AggregateError(deletionErrors, 'Failed to restart shared CNPG operator pods');
    }

    const start = Date.now();
    while (Date.now() - start < 180000) {
      const deployment = await appsApi.readNamespacedDeployment({
        name: deploymentName,
        namespace,
      });
      const status = deployment.status;
      if ((status?.readyReplicas ?? 0) > 0 && status?.readyReplicas === status?.replicas) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for ${namespace}/${deploymentName} to become ready`);
  } catch (error) {
    throw new Error('Failed to restart shared CNPG operator after webhook cleanup', {
      cause: error,
    });
  }
}

describeOrSkip('CNPG Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  let factory: any;
  let operatorDeployed = false;
  let reuseExistingOperator = false;
  const runId = crypto.randomUUID().slice(0, 8);
  const testNamespace = `typekro-test-cnpg-${runId}`;
  const operatorNs = `cnpg-test-op-${runId}`;
  const clusterNs = `cnpg-test-db-${runId}`;
  const storageClass = process.env.TYPEKRO_TEST_STORAGE_CLASS;
  const namespaceLeases: TestNamespaceLease[] = [];

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      namespaceLeases.push(
        ...(await Promise.all(
          [testNamespace, operatorNs, clusterNs].map((namespace) =>
            createTestNamespace(namespace, kubeConfig)
          )
        ))
      );

      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      try {
        const existing: any = await customApi.getNamespacedCustomObject({
          group: 'helm.toolkit.fluxcd.io',
          version: 'v2',
          namespace: 'cnpg-system',
          plural: 'helmreleases',
          name: 'cnpg-operator',
        });
        const live = existing?.body ?? existing;
        reuseExistingOperator = live.status?.conditions?.some(
          (condition: { type?: string; status?: string }) =>
            condition.type === 'Ready' && condition.status === 'True'
        );
      } catch {
        // No ready canonical install; this suite owns a temporary operator.
      }

      // Deploy the operator ONCE and share across all tests.
      // This avoids the test isolation issue where deleteInstance removes
      // the shared HelmRepository in flux-system before the next test.
      const { cnpgBootstrap } = await import(
        '../../../src/factories/cnpg/compositions/cnpg-bootstrap.js'
      );

      factory = cnpgBootstrap.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        timeout: 600000,
        kubeConfig,
      });
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    // Clean up the operator deployment
    if (factory && operatorDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        'cnpg-operator',
        [],
        kubeConfig,
        60_000,
        { scopes: ['cluster'], includeUnscopedResources: true }
      ).catch((error) => cleanupErrors.push(error));
    }

    if (operatorDeployed) {
      const clusterResourceResults = await Promise.allSettled([
        deleteHelmOwnedClusterResource(
          kubeConfig,
          'rbac.authorization.k8s.io/v1',
          'ClusterRoleBinding',
          'cnpg-operator-cnpg-test-op-cloudnative-pg-typekro-binding',
          operatorNs
        ),
        deleteHelmOwnedClusterResource(
          kubeConfig,
          'admissionregistration.k8s.io/v1',
          'MutatingWebhookConfiguration',
          'cnpg-mutating-webhook-configuration',
          operatorNs
        ),
        deleteHelmOwnedClusterResource(
          kubeConfig,
          'admissionregistration.k8s.io/v1',
          'ValidatingWebhookConfiguration',
          'cnpg-validating-webhook-configuration',
          operatorNs
        ),
        deleteHelmOwnedClusterResource(
          kubeConfig,
          'rbac.authorization.k8s.io/v1',
          'ClusterRoleBinding',
          'cnpg-operator-cloudnative-pg',
          operatorNs
        ),
      ]);
      cleanupErrors.push(
        ...clusterResourceResults.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
      );

      // CNPG webhooks have fixed cluster-scoped names. Removing the dedicated
      // test operator's Helm-owned webhooks lets Flux recreate shared webhooks,
      // but CNPG only injects caBundle on startup or periodic PKI maintenance.
      // Restart the shared operator to avoid later tests racing that maintenance.
      await restartSharedCnpgOperatorIfPresent(kubeConfig).catch((error) =>
        cleanupErrors.push(error)
      );
    }

    const namespaceResults = await Promise.allSettled(
      namespaceLeases.map((lease) => deleteTestNamespaceAndWait(lease, kubeConfig))
    );
    cleanupErrors.push(
      ...namespaceResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'CNPG integration cleanup failed');
    }
  });

  it('should deploy operator and hydrate all status fields', async () => {
    if (reuseExistingOperator) {
      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const existing: any = await customApi.getNamespacedCustomObject({
        group: 'helm.toolkit.fluxcd.io',
        version: 'v2',
        namespace: 'cnpg-system',
        plural: 'helmreleases',
        name: 'cnpg-operator',
      });
      const live = existing?.body ?? existing;
      expect(live.metadata?.name).toBe('cnpg-operator');
      expect(live.metadata?.namespace).toBe('cnpg-system');
      expect(
        live.status?.conditions?.some(
          (condition: { type?: string; status?: string }) =>
            condition.type === 'Ready' && condition.status === 'True'
        )
      ).toBe(true);
      return;
    }

    const instance = await factory.deploy({
      name: 'cnpg-operator',
      namespace: operatorNs,
      version: '0.23.0',
      installCRDs: true,
      shared: false,
    });
    operatorDeployed = true;

    // Spec fields
    expect(instance.spec.name).toBe('cnpg-operator');
    expect(instance.spec.namespace).toBe(operatorNs);
    expect(instance.spec.version).toBe('0.23.0');
    expect(instance.spec.installCRDs).toBe(true);

    // All status fields — hydrated after waitForReady
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.version).toBe('0.23.0');
  }, 900000);

  it('should make CNPG CRDs available after operator deploy', async () => {
    // The operator was deployed in the previous test — CRDs should be available
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const result: any = await customApi.listNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace: clusterNs,
      plural: 'clusters',
    });

    const items = result?.body?.items ?? result?.items ?? [];
    expect(Array.isArray(items)).toBe(true);
  }, 60000);

  it('should create a PostgreSQL cluster via typed factory', async () => {
    const { cluster } = await import('../../../src/factories/cnpg/resources/cluster.js');

    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const db = cluster({
      name: 'e2e-pg',
      namespace: clusterNs,
      spec: {
        instances: 1,
        storage: {
          size: '1Gi',
          ...(storageClass && { storageClass }),
        },
        bootstrap: {
          initdb: { database: 'e2etest', owner: 'app' },
        },
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      },
      id: 'e2eDatabase',
    });

    // Typed assertions before apply
    expect(db.kind).toBe('Cluster');
    expect(db.spec.instances).toBe(1);
    expect(db.spec.bootstrap?.initdb?.database).toBe('e2etest');

    // Apply to cluster
    await customApi.createNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace: clusterNs,
      plural: 'clusters',
      body: {
        apiVersion: db.apiVersion,
        kind: db.kind,
        metadata: { name: db.metadata.name, namespace: clusterNs },
        spec: db.spec,
      },
    });

    // Poll readiness using the typed evaluator
    const maxWait = 120000;
    const start = Date.now();
    let lastStatus: any = null;

    while (Date.now() - start < maxWait) {
      const live: any = await customApi.getNamespacedCustomObject({
        group: 'postgresql.cnpg.io',
        version: 'v1',
        namespace: clusterNs,
        plural: 'clusters',
        name: 'e2e-pg',
      });

      const liveResource = live?.body ?? live;
      lastStatus = db.readinessEvaluator?.(liveResource);

      if (lastStatus?.ready) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    expect(lastStatus?.ready).toBe(true);
    expect(lastStatus?.reason).toBe('Healthy');

    // Cleanup the exact fixture resource (operator stays for other tests).
    await deleteTestResourceAndWait(
      {
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Cluster',
        metadata: { name: 'e2e-pg', namespace: clusterNs },
      },
      kubeConfig,
      120_000
    );
  }, 900000);

  it('should generate ResourceGraphDefinition YAML with CEL status expressions', async () => {
    const { cnpgBootstrap } = await import(
      '../../../src/factories/cnpg/compositions/cnpg-bootstrap.js'
    );

    const yaml: string = cnpgBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: cnpg-bootstrap');
    expect(yaml).toContain('status:');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('Ready');
    expect(yaml).toContain('Installing');
    expect(yaml).toContain('kind: ClusterRoleBinding');
    expect(yaml).toContain('cnpgSupplementalClusterRoleBinding');
    expect(yaml).toContain('driftDetection:');
    expect(yaml).toContain('mode: enabled');
  });
});
