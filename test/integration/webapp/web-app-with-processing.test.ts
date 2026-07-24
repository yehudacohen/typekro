/**
 * WebAppWithProcessing Integration Tests
 *
 * Tests the full-stack webapp composition against a real Kubernetes cluster
 * in both direct mode and KRO mode. Verifies:
 * - All 8 resources deploy successfully (CNPG, Pooler, Valkey, Inngest, App, Service, Namespace, HelmRepo)
 * - Dependency ordering: Namespace → DB/Cache → Inngest → App
 * - Status hydration: boolean readiness fields resolve from live cluster data
 * - Connection URLs: correctly wired from resource names
 * - KRO YAML: CEL expressions generated for status fields
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

// Integration tests need generous timeouts for K8s operations.
// KRO instance deletion waits for the controller to process finalizers
// and clean up child resources (~30s per resource × 9 resources ≈ 270s).
// afterAll hooks need headroom beyond this for namespace cleanup.
setDefaultTimeout(600000);

import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import type { ResourceFactory } from '../../../src/core/types/deployment.js';
import type { Enhanced } from '../../../src/core/types/index.js';
import type {
  WebAppWithProcessingConfig,
  WebAppWithProcessingStatus,
} from '../../../src/factories/webapp/types.js';
import {
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  runWithExpectedTestNamespace,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

async function cleanupNamespace(
  lease: TestNamespaceLease,
  kubeConfig: k8s.KubeConfig
): Promise<void> {
  const { deleteTestNamespaceAndWait } = await import('../shared-kubeconfig.js');
  await deleteTestNamespaceAndWait(lease, kubeConfig);
}

// ── Shared test spec ─────────────────────────────────────────────────────

const testSpec = (appNamespace: string): WebAppWithProcessingConfig => ({
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
    ...(process.env.TYPEKRO_TEST_STORAGE_CLASS
      ? { storageClass: process.env.TYPEKRO_TEST_STORAGE_CLASS }
      : {}),
    database: 'testdb',
    owner: 'app',
  },
  cache: {
    shards: 3,
    replicas: 0,
    volumePermissions: true,
    storageSize: '1Gi',
    ...(process.env.TYPEKRO_TEST_STORAGE_CLASS
      ? { storageClass: process.env.TYPEKRO_TEST_STORAGE_CLASS }
      : {}),
  },
  processing: {
    eventKey: 'deadbeef0123456789abcdef01234567',
    signingKey: 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    replicas: 1,
    resources: {
      requests: { cpu: '50m', memory: '128Mi' },
      limits: { cpu: '250m', memory: '256Mi' },
    },
    sdkUrl: ['http://testapp:80/api/inngest'],
  },
});

/**
 * Assert the full status shape on a deployed webapp instance.
 * Shared between direct and KRO mode tests.
 */
function assertWebAppStatus(
  instance: Enhanced<WebAppWithProcessingConfig, WebAppWithProcessingStatus>,
  appNamespace: string
): void {
  // Spec fields
  expect(instance.spec.name).toBe('testapp');
  expect(instance.spec.namespace).toBe(appNamespace);
  expect(instance.spec.app.image).toBe('nginx:alpine');
  expect(instance.spec.database.storageSize).toBe('1Gi');

  // Status — connection URLs
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
}

/**
 * Verify that all pods in the app namespace are Running and Ready.
 * Queries the cluster through the shared Kubernetes client — this is independent of TypeKro's
 * status hydration and serves as ground truth for the deployment's health.
 */
async function assertAllPodsHealthy(
  appNamespace: string,
  kubeConfig: k8s.KubeConfig
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const pods = (await coreApi.listNamespacedPod({ namespace: appNamespace })).items;

  expect(pods.length).toBeGreaterThan(0);

  for (const pod of pods) {
    const name = pod.metadata?.name ?? 'unknown';
    const phase = pod.status?.phase;

    // Pod must be Running
    if (phase !== 'Running') {
      throw new Error(`Pod ${name} is ${phase}, expected Running`);
    }

    // All containers must be ready
    const containerStatuses = pod.status?.containerStatuses ?? [];
    for (const cs of containerStatuses) {
      if (!cs.ready) {
        throw new Error(`Container ${cs.name} in pod ${name} is not ready`);
      }
    }

    // No excessive restarts — some are expected in KRO mode where all resources
    // deploy simultaneously (Inngest restarts while waiting for Valkey/CNPG).
    // The key health signal is that the pod IS Running and Ready now (checked above).
    const totalRestarts = containerStatuses.reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0);
    expect(totalRestarts).toBeLessThanOrEqual(10);
  }
}

// ── Direct mode ──────────────────────────────────────────────────────────

describe('WebAppWithProcessing Direct Mode', () => {
  let kubeConfig: k8s.KubeConfig;
  let directFactory:
    | ResourceFactory<WebAppWithProcessingConfig, WebAppWithProcessingStatus>
    | undefined;
  let factoryNamespaceLease: TestNamespaceLease | undefined;
  let appNamespaceLease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const factoryNamespace = `typekro-webapp-${suffix}`;
  const appNamespace = `webapp-app-${suffix}`;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    factoryNamespaceLease = await createTestNamespace(factoryNamespace, kubeConfig);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    // Delete instance-scoped resources only. Shared operator resources
    // (cnpg-system, valkey-operator-system) must persist for the KRO mode
    // test — it needs the operator CRDs and webhook services.
    if (directFactory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          directFactory,
          'testapp',
          appNamespaceLease ? [appNamespaceLease] : [],
          kubeConfig,
          60_000
        );
      } catch (e) {
        cleanupErrors.push(e);
      }
    }
    for (const lease of [factoryNamespaceLease, appNamespaceLease]) {
      if (!lease) continue;
      try {
        await cleanupNamespace(lease, kubeConfig);
      } catch (e) {
        cleanupErrors.push(e);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'WebApp direct-mode cleanup failed');
    }
  });

  it('should deploy the full stack and hydrate status fields', async () => {
    const { webAppWithProcessing } = await import(
      '../../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    directFactory = webAppWithProcessing.factory('direct', {
      namespace: factoryNamespace,
      waitForReady: true,
      timeout: 1200000,
      kubeConfig,
    });

    const instance = await runWithExpectedTestNamespace(
      appNamespace,
      kubeConfig,
      (lease) => {
        appNamespaceLease = lease;
      },
      () => directFactory!.deploy(testSpec(appNamespace))
    );

    assertWebAppStatus(instance, appNamespace);

    // Ground-truth verification: all pods are actually Running and Ready
    await assertAllPodsHealthy(appNamespace, kubeConfig);
  }, 1500000);

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

    // Status field references should produce CEL expressions, not undefined
    expect(yaml).not.toContain('undefined');
  });
});

// ── KRO mode ─────────────────────────────────────────────────────────────

describe('WebAppWithProcessing KRO Mode', () => {
  let kubeConfig: k8s.KubeConfig;
  let kroFactory:
    | ResourceFactory<WebAppWithProcessingConfig, WebAppWithProcessingStatus>
    | undefined;
  let factoryNamespaceLease: TestNamespaceLease | undefined;
  let appNamespaceLease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const kroNamespace = `typekro-kro-${suffix}`;
  const appNamespace = `webapp-kro-${suffix}`;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });

    factoryNamespaceLease = await createTestNamespace(kroNamespace, kubeConfig);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    // Delete the KRO instance first so the controller follows the graph and
    // removes child resources before namespace teardown.
    if (kroFactory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          kroFactory,
          'testapp',
          appNamespaceLease ? [appNamespaceLease] : [],
          kubeConfig,
          60_000
        );
      } catch (e) {
        cleanupErrors.push(e);
      }
    }
    for (const lease of [appNamespaceLease, factoryNamespaceLease]) {
      if (!lease) continue;
      try {
        await cleanupNamespace(lease, kubeConfig);
      } catch (e) {
        cleanupErrors.push(e);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'WebApp KRO-mode cleanup failed');
    }
  });

  it('should deploy via KRO controller and reconcile to ready', async () => {
    const { webAppWithProcessing } = await import(
      '../../../src/factories/webapp/compositions/web-app-with-processing.js'
    );

    // KRO mode: creates a ResourceGraphDefinition, then deploys an instance
    // as a custom resource. The KRO controller handles dependency ordering
    // via CEL expressions and reconciles all child resources.
    kroFactory = webAppWithProcessing.factory('kro', {
      namespace: kroNamespace,
      waitForReady: true,
      timeout: 1200000,
      kubeConfig,
    });

    const instance = await runWithExpectedTestNamespace(
      appNamespace,
      kubeConfig,
      (lease) => {
        appNamespaceLease = lease;
      },
      () => kroFactory!.deploy(testSpec(appNamespace))
    );

    assertWebAppStatus(instance, appNamespace);

    // Ground-truth verification: all pods are actually Running and Ready
    await assertAllPodsHealthy(appNamespace, kubeConfig);
  }, 1500000);
});
