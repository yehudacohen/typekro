import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import { ensureNamespaceExists, isClusterAvailable } from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

describeOrSkip('ClickHouse Operator Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  let factory: any;
  let operatorDeployed = false;
  const testNamespace = 'typekro-test-clickhouse-bootstrap';
  const operatorNs = 'clickhouse-test-op';
  const chiNs = 'clickhouse-test-chi';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await ensureNamespaceExists(testNamespace, kubeConfig);

      const { clickhouseOperatorBootstrap } = await import(
        '../../../src/factories/clickhouse/compositions/clickhouse-operator-bootstrap.js'
      );

      factory = clickhouseOperatorBootstrap.factory('direct', {
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
    if (factory && operatorDeployed) {
      await factory
        .deleteInstance('clickhouse-operator', {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        })
        .catch(() => {});
    }

    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
    await Promise.allSettled(
      [testNamespace, operatorNs, chiNs].map((ns) => deleteNamespaceAndWait(ns, kubeConfig))
    );
  });

  it('should deploy operator and hydrate all status fields', async () => {
    const instance = await factory.deploy({
      name: 'clickhouse-operator',
      namespace: operatorNs,
      version: '0.27.1',
      shared: false,
    });
    operatorDeployed = true;

    // Spec fields
    expect(instance.spec.name).toBe('clickhouse-operator');
    expect(instance.spec.namespace).toBe(operatorNs);
    expect(instance.spec.version).toBe('0.27.1');

    // All status fields — hydrated after waitForReady
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.version).toBe('0.27.1');
  }, 900000);

  it('should make ClickHouse CRDs available after operator deploy', async () => {
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    await ensureNamespaceExists(chiNs, kubeConfig);

    const result: any = await customApi.listNamespacedCustomObject({
      group: 'clickhouse.altinity.com',
      version: 'v1',
      namespace: chiNs,
      plural: 'clickhouseinstallations',
    });

    const items = result?.body?.items ?? result?.items ?? [];
    expect(Array.isArray(items)).toBe(true);
  }, 60000);

  it('should create a ClickHouse installation via typed factory', async () => {
    const { clickHouseInstallation } = await import(
      '../../../src/factories/clickhouse/resources/installation.js'
    );

    await ensureNamespaceExists(chiNs, kubeConfig);
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const chi = clickHouseInstallation({
      name: 'e2e-ch',
      namespace: chiNs,
      version: '25.3',
      shards: 1,
      replicas: 1,
      storage: { size: '1Gi' },
      podResources: {
        requests: { cpu: '100m', memory: '512Mi' },
        limits: { memory: '1Gi' },
      },
      id: 'e2eClickhouse',
    });

    // Typed assertions before apply
    expect(chi.kind).toBe('ClickHouseInstallation');
    expect(chi.spec.configuration?.clusters?.[0]?.name).toBe('cluster');
    expect(chi.spec.configuration?.clusters?.[0]?.layout?.replicasCount).toBe(1);

    await customApi.createNamespacedCustomObject({
      group: 'clickhouse.altinity.com',
      version: 'v1',
      namespace: chiNs,
      plural: 'clickhouseinstallations',
      body: {
        apiVersion: chi.apiVersion,
        kind: chi.kind,
        metadata: { name: chi.metadata.name, namespace: chiNs },
        spec: chi.spec,
      },
    });

    // Poll readiness using the typed evaluator (status.status == 'Completed').
    const maxWait = 300000;
    const start = Date.now();
    let lastStatus: any = null;

    while (Date.now() - start < maxWait) {
      const live: any = await customApi.getNamespacedCustomObject({
        group: 'clickhouse.altinity.com',
        version: 'v1',
        namespace: chiNs,
        plural: 'clickhouseinstallations',
        name: 'e2e-ch',
      });

      const liveResource = live?.body ?? live;
      lastStatus = chi.readinessEvaluator?.(liveResource);

      if (lastStatus?.ready) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    expect(lastStatus?.ready).toBe(true);
    expect(lastStatus?.reason).toBe('Completed');

    // Cleanup the installation (operator stays for other tests)
    await customApi
      .deleteNamespacedCustomObject({
        group: 'clickhouse.altinity.com',
        version: 'v1',
        namespace: chiNs,
        plural: 'clickhouseinstallations',
        name: 'e2e-ch',
      })
      .catch(() => {});
  }, 900000);

  it('should deploy a cluster via the CURRENT public API (makeClickHouseCluster) and hydrate the connection contract', async () => {
    // The raw clickHouseInstallation() test above predates the
    // makeClickHouseCluster composition; this exercises the CURRENT public
    // surface end-to-end: direct factory deploy + the #93 typed connection
    // contract (host/nativeUrl/httpUrl/clusterName) hydrated from the live CHI.
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');

    await ensureNamespaceExists(chiNs, kubeConfig);

    const clusterFactory = makeClickHouseCluster().factory('direct', {
      namespace: chiNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    try {
      const instance = await clusterFactory.deploy({
        name: 'e2e-cluster',
        namespace: chiNs,
        version: '25.7',
        storage: { size: '1Gi' },
        podResources: {
          requests: { cpu: '100m', memory: '512Mi' },
          limits: { memory: '1Gi' },
        },
      });

      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Ready');

      // The typed service contract downstream compositions (e.g. clickstack)
      // consume instead of reconstructing operator naming rules.
      expect(instance.status.clickhouse.host).toBe(
        `clickhouse-e2e-cluster.${chiNs}.svc.cluster.local`
      );
      expect(instance.status.clickhouse.nativeUrl).toBe(
        `clickhouse://clickhouse-e2e-cluster.${chiNs}.svc.cluster.local:9000`
      );
      expect(instance.status.clickhouse.httpUrl).toBe(
        `http://clickhouse-e2e-cluster.${chiNs}.svc.cluster.local:8123`
      );
      expect(instance.status.clickhouse.clusterName).toBe('cluster');
      expect(instance.status.installation.name).toBe('e2e-cluster');
      expect(instance.status.installation.namespace).toBe(chiNs);
    } finally {
      // Cleanup the cluster instance (operator stays for other tests).
      await clusterFactory.deleteInstance('e2e-cluster').catch(() => {});
    }
  }, 900000);

  it('should generate ResourceGraphDefinition YAML with CEL status expressions', async () => {
    const { clickhouseOperatorBootstrap } = await import(
      '../../../src/factories/clickhouse/compositions/clickhouse-operator-bootstrap.js'
    );

    const yaml: string = clickhouseOperatorBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: clickhouse-operator-bootstrap');
    expect(yaml).toContain('status:');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('Ready');
    expect(yaml).toContain('Installing');
    expect(yaml).toContain('chart: altinity-clickhouse-operator');
    expect(yaml).toContain('driftDetection:');
    expect(yaml).toContain('mode: enabled');
  });
});
