import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleCustomObjectsApi,
} from '../../../src/core/kubernetes/index.js';
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

describe('CNPG Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  let factory: any;
  const testNamespace = 'typekro-test-cnpg-bootstrap';
  const operatorNs = 'cnpg-test-op';
  const clusterNs = 'cnpg-test-db';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await ensureNamespaceExists(testNamespace, kubeConfig);

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
  }, 30000);

  afterAll(async () => {
    // Clean up the operator deployment
    if (factory) {
      await factory.deleteInstance('cnpg-operator').catch(() => {});
    }

    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
    await Promise.allSettled(
      [testNamespace, operatorNs, clusterNs].map((ns) =>
        deleteNamespaceAndWait(ns, kubeConfig)
      )
    );
  });

  it('should deploy operator and hydrate all status fields', async () => {
    const instance = await factory.deploy({
      name: 'cnpg-operator',
      namespace: operatorNs,
      version: '0.23.0',
      installCRDs: true,
    });

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
    await ensureNamespaceExists(clusterNs, kubeConfig);

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
    const { cluster } = await import(
      '../../../src/factories/cnpg/resources/cluster.js'
    );

    await ensureNamespaceExists(clusterNs, kubeConfig);
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const db = cluster({
      name: 'e2e-pg',
      namespace: clusterNs,
      spec: {
        instances: 1,
        storage: { size: '1Gi' },
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

    // Cleanup the cluster resource (operator stays for other tests)
    await customApi.deleteNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace: clusterNs,
      plural: 'clusters',
      name: 'e2e-pg',
    }).catch(() => {});
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
  });
});
