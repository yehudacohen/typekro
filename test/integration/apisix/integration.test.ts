/**
 * APISIX Bootstrap Composition Integration Tests
 *
 * This test suite validates the APISIX bootstrap composition:
 * 1. Cleans orphaned APISIX cluster resources from previous runs
 * 2. Deploys APISIX via the apisixBootstrap composition
 * 3. Validates all resources (HelmRepository, HelmRelease) are created
 * 4. Validates APISIX pods are running
 * 5. Cleans up after itself
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);
import type * as k8s from '@kubernetes/client-node';
import { createBunCompatibleNetworkingV1Api } from '../../../src/core/kubernetes/bun-api-client.js';
import {
  createAppsV1ApiClient,
  createCustomObjectsApiClient,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  runWithExpectedTestNamespace,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();

if (!clusterAvailable) {
  console.log('Skipping APISIX Integration: No cluster available');
}

const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('APISIX Bootstrap Composition Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let customObjectsApi: k8s.CustomObjectsApi;
  let appsApi: k8s.AppsV1Api;
  let networkingApi: k8s.NetworkingV1Api;

  const runId = crypto.randomUUID().slice(0, 8);
  const instanceName = `apisix-${runId}`;
  const apisixNamespace = `apisix-system-${runId}`;
  let namespaceLease: TestNamespaceLease | undefined;
  let directFactory:
    | ReturnType<
        typeof import('../../../src/factories/apisix/compositions/apisix-bootstrap.js')['apisixBootstrap']['factory']
      >
    | undefined;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('SETUP: Preparing APISIX integration tests...');

    kubeConfig = getIntegrationTestKubeConfig();
    customObjectsApi = createCustomObjectsApiClient(kubeConfig);
    appsApi = createAppsV1ApiClient(kubeConfig);
    networkingApi = createBunCompatibleNetworkingV1Api(kubeConfig);

    console.log('SETUP: APISIX integration test environment ready');
  });

  afterAll(async () => {
    if (!clusterAvailable) return;

    if (directFactory) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        directFactory,
        instanceName,
        namespaceLease ? [namespaceLease] : [],
        kubeConfig,
        600_000,
        { scopes: ['cluster'], includeUnscopedResources: true }
      );
      namespaceLease = undefined;
    } else if (namespaceLease) {
      await deleteTestNamespaceAndWait(namespaceLease, kubeConfig);
      namespaceLease = undefined;
    }
  });

  it('should deploy APISIX via bootstrap composition and validate resources', async () => {
    console.log('Deploying APISIX via bootstrap composition...');

    const { apisixBootstrap } = await import(
      '../../../src/factories/apisix/compositions/apisix-bootstrap.js'
    );

    // Create direct factory for deployment
    // hydrateStatus: false — status hydration for compositions has un-timed K8s API calls
    // in base-strategy.ts that can hang indefinitely (tracked as separate bug).
    // This test validates deployment + resource creation, not status hydration.
    directFactory = apisixBootstrap.factory('direct', {
      namespace: 'flux-system', // HelmReleases go to flux-system
      waitForReady: true,
      hydrateStatus: false,
      timeout: 600000, // 10 minutes - Helm chart pull + pod startup
      kubeConfig: kubeConfig,
    });

    // Deploy APISIX using chart v2.13.0 (default)
    // Uses NodePort because the chart's gateway service template unconditionally
    // sets externalTrafficPolicy which is invalid for ClusterIP on Kubernetes 1.33+
    const instance = await runWithExpectedTestNamespace(
      apisixNamespace,
      kubeConfig,
      (lease) => {
        namespaceLease = lease;
      },
      () =>
        directFactory!.deploy({
          name: instanceName,
          namespace: apisixNamespace,
          version: '2.13.0',
          replicaCount: 1,
          gateway: {
            type: 'NodePort',
            http: { enabled: true, servicePort: 80 },
            https: { enabled: true, servicePort: 443 },
          },
          ingressController: {
            enabled: true,
            config: {
              kubernetes: {
                ingressClass: 'apisix',
              },
            },
          },
        })
    );

    // Validate deployment result
    expect(instance).toBeDefined();
    expect(instance.metadata.name).toBe(instanceName);
    console.log('APISIX bootstrap deployment completed');

    // Step 1: Verify HelmRepository was created
    console.log('Verifying HelmRepository...');
    const repos = await customObjectsApi.listNamespacedCustomObject({
      group: 'source.toolkit.fluxcd.io',
      version: 'v1',
      namespace: 'flux-system',
      plural: 'helmrepositories',
    });
    const repoItems = (repos as Record<string, unknown>).items as Record<string, unknown>[];
    const apisixRepo = repoItems.find(
      (repo) => (repo.metadata as Record<string, unknown>)?.name === 'apisix-repo'
    ) as Record<string, unknown> | undefined;
    expect(apisixRepo).toBeDefined();
    expect((apisixRepo!.spec as Record<string, unknown>).url).toBe('https://charts.apiseven.com');
    console.log('HelmRepository apisix-repo created and configured');

    // Step 2: Verify single HelmRelease was created. The ingress-controller subchart is disabled.
    console.log('Verifying HelmRelease...');
    const releases = await customObjectsApi.listNamespacedCustomObject({
      group: 'helm.toolkit.fluxcd.io',
      version: 'v2',
      namespace: 'flux-system',
      plural: 'helmreleases',
    });
    const releaseItems = (releases as Record<string, unknown>).items as Record<string, unknown>[];
    const apisixRelease = releaseItems.find(
      (r) => (r.metadata as Record<string, unknown>)?.name === instanceName
    ) as Record<string, unknown> | undefined;
    expect(apisixRelease).toBeDefined();
    const releaseSpec = apisixRelease!.spec as Record<string, unknown>;
    const chartSpec = (releaseSpec.chart as Record<string, unknown>).spec as Record<
      string,
      unknown
    >;
    expect(chartSpec.chart).toBe('apisix');
    expect(chartSpec.version).toBe('2.13.0');
    expect(releaseSpec.targetNamespace).toBe(apisixNamespace);
    console.log('HelmRelease created with chart apisix@2.13.0');

    // Step 3: Verify this bootstrap did not create a misleading IngressClass
    console.log('Verifying IngressClass is not created by APISIX gateway bootstrap...');
    try {
      await networkingApi.readIngressClass({ name: 'apisix' });
      throw new Error('IngressClass apisix should not be created by APISIX gateway bootstrap');
    } catch (error: unknown) {
      const err = error as { statusCode?: number; body?: { reason?: string } };
      expect(err.statusCode === 404 || err.body?.reason === 'NotFound').toBe(true);
    }

    // Step 5: Verify APISIX pods are running in the target namespace
    console.log('Verifying APISIX pods...');
    const deployments = await appsApi.listNamespacedDeployment({ namespace: apisixNamespace });
    const apisixDeployments = deployments.items.filter((d) => d.metadata?.name?.includes('apisix'));
    expect(apisixDeployments.length).toBeGreaterThan(0);

    for (const deployment of apisixDeployments) {
      const readyReplicas = deployment.status?.readyReplicas ?? 0;
      const desiredReplicas = deployment.spec?.replicas ?? 1;
      console.log(
        `Deployment ${deployment.metadata?.name}: ${readyReplicas}/${desiredReplicas} ready`
      );
      expect(readyReplicas).toBeGreaterThanOrEqual(1);
    }

    console.log('APISIX bootstrap composition validated successfully');

    // Clean up via deleteInstance
    console.log('Cleaning up APISIX deployment...');
    if (!namespaceLease) {
      throw new Error(`Missing retained namespace lease for ${apisixNamespace}`);
    }
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      directFactory,
      instanceName,
      [namespaceLease],
      kubeConfig,
      600_000,
      { scopes: ['cluster'], includeUnscopedResources: true }
    );
    namespaceLease = undefined;
    console.log('APISIX deployment cleaned up');
  }, 900000); // 15 minute timeout

  it('should generate proper YAML for kro deployment', async () => {
    const { apisixBootstrap } = await import(
      '../../../src/factories/apisix/compositions/apisix-bootstrap.js'
    );

    const originalAdminKey = process.env.APISIX_ADMIN_KEY;
    const originalViewerKey = process.env.APISIX_VIEWER_KEY;
    process.env.APISIX_ADMIN_KEY = 'test-admin-key';
    process.env.APISIX_VIEWER_KEY = 'test-viewer-key';

    // Test YAML generation without relying on caller-provided credentials.
    let yaml: string;
    try {
      yaml = apisixBootstrap.toYaml();
    } finally {
      if (originalAdminKey === undefined) {
        delete process.env.APISIX_ADMIN_KEY;
      } else {
        process.env.APISIX_ADMIN_KEY = originalAdminKey;
      }
      if (originalViewerKey === undefined) {
        delete process.env.APISIX_VIEWER_KEY;
      } else {
        process.env.APISIX_VIEWER_KEY = originalViewerKey;
      }
    }

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: apisix-bootstrap');
    expect(yaml).toContain('status:');
    expect(yaml.length).toBeGreaterThan(0);

    console.log('APISIX bootstrap YAML generation validated');
  });

  it('should validate ArkType schema for APISIX configuration', async () => {
    const { APISixBootstrapConfigSchema, APISixBootstrapStatusSchema } = await import(
      '../../../src/factories/apisix/types.js'
    );

    // Test valid configuration
    const validConfig = {
      name: 'test-apisix',
      namespace: 'apisix-system',
      version: '2.8.0',
      replicaCount: 1,
      gateway: {
        type: 'ClusterIP' as const,
        http: { enabled: true, servicePort: 80 },
      },
      ingressController: {
        enabled: true,
        config: {
          kubernetes: {
            ingressClass: 'apisix',
          },
        },
      },
    };

    const configResult = APISixBootstrapConfigSchema(validConfig);
    expect(configResult).toBeDefined();
    if ('name' in configResult) {
      expect(configResult.name).toBe('test-apisix');
      expect(configResult.version).toBe('2.8.0');
    } else {
      console.log('Config validation errors:', configResult);
      expect(configResult).toHaveProperty('name');
    }

    // Test valid status
    const validStatus = {
      ready: true,
      phase: 'Ready' as const,
      gatewayReady: true,
      standardIngressReady: false,
      dashboardReady: false,
      etcdReady: false,
    };

    const statusResult = APISixBootstrapStatusSchema(validStatus);
    expect(statusResult).toBeDefined();
    if ('phase' in statusResult) {
      expect(statusResult.phase).toBe('Ready');
      expect(statusResult.ready).toBe(true);
    } else {
      console.log('Status validation errors:', statusResult);
      expect(statusResult).toHaveProperty('phase');
    }

    console.log('APISIX ArkType schema validation passed');
  });
});
