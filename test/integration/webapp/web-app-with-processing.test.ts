import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists } from '../shared-kubeconfig.js';

describe('WebAppWithProcessing Integration Tests', () => {
  let kubeConfig: any;
  const testNamespace = 'typekro-test-webapp';
  const appNamespace = 'webapp-test';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await ensureNamespaceExists(testNamespace, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
    await Promise.allSettled(
      [testNamespace, appNamespace].map((ns) =>
        deleteNamespaceAndWait(ns, kubeConfig)
      )
    );
  });

  it('should deploy the full stack and hydrate status fields', async () => {
    const { webAppWithProcessing } = await import(
      '../../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    const factory = webAppWithProcessing.factory('direct', {
      namespace: testNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await factory.deploy({
      name: 'testapp',
      namespace: appNamespace,
      app: {
        image: 'nginx:alpine',
        port: 80,
        replicas: 1,
      },
      database: {
        instances: 1,
        storageSize: '1Gi',
        database: 'testdb',
        owner: 'app',
      },
      cache: {
        shards: 3,
        volumePermissions: true,
      },
      processing: {
        eventKey: 'deadbeef0123456789abcdef01234567',
        signingKey: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
      },
    });

    // Spec fields
    expect(instance.spec.name).toBe('testapp');
    expect(instance.spec.namespace).toBe(appNamespace);
    expect(instance.spec.app.image).toBe('nginx:alpine');
    expect(instance.spec.database.storageSize).toBe('1Gi');

    // Status — connection URLs should be populated
    expect(instance.status.databaseUrl).toContain('testapp-db-pooler');
    expect(instance.status.cacheUrl).toContain('testapp-cache');
    expect(instance.status.inngestUrl).toContain('testapp-inngest');
    expect(instance.status.appUrl).toContain('testapp');

    // Component readiness
    expect(instance.status.ready).toBe(true);
    expect(instance.status.components.app).toBe(true);
    expect(instance.status.components.database).toBe(true);
    expect(instance.status.components.cache).toBe(true);
    expect(instance.status.components.inngest).toBe(true);

    await factory.deleteInstance('testapp');
  }, 900000);

  it('should generate valid KRO YAML', async () => {
    const { webAppWithProcessing } = await import(
      '../../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    const yaml: string = webAppWithProcessing.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: web-app-with-processing');

    // All resource types present
    expect(yaml).toContain('kind: Cluster');
    expect(yaml).toContain('kind: Pooler');
    expect(yaml).toContain('kind: Valkey');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');

    // Env var wiring in the Deployment
    expect(yaml).toContain('DATABASE_URL');
    expect(yaml).toContain('VALKEY_URL');
    expect(yaml).toContain('INNGEST_BASE_URL');
    expect(yaml).toContain('INNGEST_EVENT_KEY');
    expect(yaml).toContain('INNGEST_SIGNING_KEY');
  });
});
