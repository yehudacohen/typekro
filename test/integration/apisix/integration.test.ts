/**
 * APISIX Bootstrap Composition Integration Tests
 *
 * This test suite validates the APISIX bootstrap composition:
 * 1. Cleans orphaned APISIX cluster resources from previous runs
 * 2. Deploys APISIX via the apisixBootstrap composition
 * 3. Validates all resources (HelmRepository, HelmReleases, IngressClass) are created
 * 4. Validates APISIX pods are running
 * 5. Cleans up after itself
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import {
  createBunCompatibleApiextensionsV1Api,
  createBunCompatibleNetworkingV1Api,
} from '../../../src/core/kubernetes/bun-api-client.js';
import {
  createAppsV1ApiClient,
  createCustomObjectsApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();

if (!clusterAvailable) {
  console.log('Skipping APISIX Integration: No cluster available');
}

const describeOrSkip = clusterAvailable ? describe : describe.skip;

/**
 * Clean orphaned APISIX cluster resources left from previous test runs.
 *
 * This removes:
 * - IngressClass 'apisix' (cluster-scoped)
 * - APISIX CRDs (apisixclusterconfigs, apisixconsumers, etc.)
 * - Orphaned HelmRepositories in flux-system matching 'apisix'
 * - Orphaned HelmReleases in flux-system matching 'apisix'
 */
async function cleanOrphanedApisixResources(kc: k8s.KubeConfig): Promise<void> {
  console.log('Cleaning orphaned APISIX cluster resources...');

  const apiExtApi = createBunCompatibleApiextensionsV1Api(kc);
  const networkingApi = createBunCompatibleNetworkingV1Api(kc);
  const customObjectsApi = createCustomObjectsApiClient(kc);

  // 1. Delete orphaned IngressClass 'apisix'
  try {
    await networkingApi.deleteIngressClass({ name: 'apisix' });
    console.log('Deleted orphaned IngressClass: apisix');
  } catch (error: unknown) {
    const err = error as { statusCode?: number; body?: { reason?: string }; message?: string };
    if (err.statusCode === 404 || err.body?.reason === 'NotFound') {
      console.log('IngressClass apisix not found (already clean)');
    } else {
      console.warn('Failed to delete IngressClass apisix:', err.message);
    }
  }

  // 2. Delete orphaned APISIX CRDs
  const apisixCRDs = [
    'apisixclusterconfigs.apisix.apache.org',
    'apisixconsumers.apisix.apache.org',
    'apisixglobalrules.apisix.apache.org',
    'apisixpluginconfigs.apisix.apache.org',
    'apisixroutes.apisix.apache.org',
    'apisixtlses.apisix.apache.org',
    'apisixupstreams.apisix.apache.org',
  ];

  for (const crdName of apisixCRDs) {
    try {
      await apiExtApi.deleteCustomResourceDefinition({ name: crdName });
      console.log(`Deleted orphaned CRD: ${crdName}`);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; body?: { reason?: string }; message?: string };
      if (err.statusCode === 404 || err.body?.reason === 'NotFound') {
        // Already gone
      } else {
        console.warn(`Failed to delete CRD ${crdName}:`, err.message);
      }
    }
  }

  // 3. Delete orphaned APISIX HelmRepositories in flux-system
  try {
    const repos = await customObjectsApi.listNamespacedCustomObject({
      group: 'source.toolkit.fluxcd.io',
      version: 'v1',
      namespace: 'flux-system',
      plural: 'helmrepositories',
    });
    const items = ((repos as Record<string, unknown>).items as Record<string, unknown>[]) || [];
    for (const item of items) {
      const name = (item.metadata as Record<string, unknown>)?.name as string | undefined;
      if (name?.includes('apisix')) {
        try {
          await customObjectsApi.deleteNamespacedCustomObject({
            group: 'source.toolkit.fluxcd.io',
            version: 'v1',
            namespace: 'flux-system',
            plural: 'helmrepositories',
            name,
          });
          console.log(`Deleted orphaned HelmRepository: ${name}`);
        } catch (deleteError: unknown) {
          const err = deleteError as { statusCode?: number; message?: string };
          if (err.statusCode !== 404) {
            console.warn(`Failed to delete HelmRepository ${name}:`, err.message);
          }
        }
      }
    }
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    if (err.statusCode !== 404) {
      console.warn('Failed to list HelmRepositories:', err.message);
    }
  }

  // 4. Delete orphaned APISIX HelmReleases in flux-system
  try {
    const releases = await customObjectsApi.listNamespacedCustomObject({
      group: 'helm.toolkit.fluxcd.io',
      version: 'v2',
      namespace: 'flux-system',
      plural: 'helmreleases',
    });
    const items = ((releases as Record<string, unknown>).items as Record<string, unknown>[]) || [];
    for (const item of items) {
      const name = (item.metadata as Record<string, unknown>)?.name as string | undefined;
      if (name?.includes('apisix')) {
        try {
          await customObjectsApi.deleteNamespacedCustomObject({
            group: 'helm.toolkit.fluxcd.io',
            version: 'v2',
            namespace: 'flux-system',
            plural: 'helmreleases',
            name,
          });
          console.log(`Deleted orphaned HelmRelease: ${name}`);
        } catch (deleteError: unknown) {
          const err = deleteError as { statusCode?: number; message?: string };
          if (err.statusCode !== 404) {
            console.warn(`Failed to delete HelmRelease ${name}:`, err.message);
          }
        }
      }
    }
  } catch (error: unknown) {
    const err = error as { statusCode?: number; message?: string };
    if (err.statusCode !== 404) {
      console.warn('Failed to list HelmReleases:', err.message);
    }
  }

  console.log('Orphaned APISIX resource cleanup complete');
}

describeOrSkip('APISIX Bootstrap Composition Integration Tests', () => {
  let kubeConfig: k8s.KubeConfig;
  let customObjectsApi: k8s.CustomObjectsApi;
  let appsApi: k8s.AppsV1Api;
  let networkingApi: k8s.NetworkingV1Api;

  // The APISIX bootstrap deploys to its own namespace (apisix-system by default)
  const apisixNamespace = 'apisix-system';

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('SETUP: Preparing APISIX integration tests...');

    kubeConfig = getIntegrationTestKubeConfig();
    customObjectsApi = createCustomObjectsApiClient(kubeConfig);
    appsApi = createAppsV1ApiClient(kubeConfig);
    networkingApi = createBunCompatibleNetworkingV1Api(kubeConfig);

    // Clean orphaned resources from previous runs before deploying
    await cleanOrphanedApisixResources(kubeConfig);

    // Also clean up the APISIX namespace if it exists from a previous run
    await deleteNamespaceAndWait(apisixNamespace, kubeConfig, 60000);

    console.log('SETUP: APISIX integration test environment ready');
  });

  afterAll(async () => {
    if (!clusterAvailable) return;

    console.log('Cleaning up APISIX integration test resources...');

    // Clean up HelmReleases in flux-system that match our test
    try {
      const releases = await customObjectsApi.listNamespacedCustomObject({
        group: 'helm.toolkit.fluxcd.io',
        version: 'v2',
        namespace: 'flux-system',
        plural: 'helmreleases',
      });
      const items =
        ((releases as Record<string, unknown>).items as Record<string, unknown>[]) || [];
      for (const item of items) {
        const name = (item.metadata as Record<string, unknown>)?.name as string | undefined;
        if (name?.includes('apisix')) {
          try {
            await customObjectsApi.deleteNamespacedCustomObject({
              group: 'helm.toolkit.fluxcd.io',
              version: 'v2',
              namespace: 'flux-system',
              plural: 'helmreleases',
              name,
            });
            console.log(`Deleted HelmRelease: ${name}`);
          } catch (e: unknown) {
            const err = e as { statusCode?: number; message?: string };
            if (err.statusCode !== 404)
              console.warn(`Failed to delete HelmRelease ${name}:`, err.message);
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      console.warn('Failed to list HelmReleases for cleanup:', err.message);
    }

    // Clean up HelmRepositories
    try {
      const repos = await customObjectsApi.listNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'helmrepositories',
      });
      const items = ((repos as Record<string, unknown>).items as Record<string, unknown>[]) || [];
      for (const item of items) {
        const name = (item.metadata as Record<string, unknown>)?.name as string | undefined;
        if (name?.includes('apisix')) {
          try {
            await customObjectsApi.deleteNamespacedCustomObject({
              group: 'source.toolkit.fluxcd.io',
              version: 'v1',
              namespace: 'flux-system',
              plural: 'helmrepositories',
              name,
            });
            console.log(`Deleted HelmRepository: ${name}`);
          } catch (e: unknown) {
            const err = e as { statusCode?: number; message?: string };
            if (err.statusCode !== 404)
              console.warn(`Failed to delete HelmRepository ${name}:`, err.message);
          }
        }
      }
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      console.warn('Failed to list HelmRepositories for cleanup:', err.message);
    }

    // Clean up IngressClass
    try {
      await networkingApi.deleteIngressClass({ name: 'apisix' });
      console.log('Deleted IngressClass: apisix');
    } catch (e: unknown) {
      const err = e as { statusCode?: number; message?: string };
      if (err.statusCode !== 404) console.warn('Failed to delete IngressClass:', err.message);
    }

    // Clean up the APISIX namespace
    await deleteNamespaceAndWait(apisixNamespace, kubeConfig, 120000);

    console.log('APISIX integration test cleanup complete');
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
    const directFactory = apisixBootstrap.factory('direct', {
      namespace: 'flux-system', // HelmReleases go to flux-system
      waitForReady: true,
      hydrateStatus: false,
      timeout: 600000, // 10 minutes - Helm chart pull + pod startup
      kubeConfig: kubeConfig,
    });

    // Deploy APISIX using chart v2.13.0 (default)
    // Uses NodePort because the chart's gateway service template unconditionally
    // sets externalTrafficPolicy which is invalid for ClusterIP on Kubernetes 1.33+
    const instance = await directFactory.deploy({
      name: 'apisix',
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
    });

    // Validate deployment result
    expect(instance).toBeDefined();
    expect(instance.metadata.name).toBe('apisix');
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

    // Step 2: Verify single HelmRelease was created (v2.13.0 bundles ingress controller as subchart)
    console.log('Verifying HelmRelease...');
    const releases = await customObjectsApi.listNamespacedCustomObject({
      group: 'helm.toolkit.fluxcd.io',
      version: 'v2',
      namespace: 'flux-system',
      plural: 'helmreleases',
    });
    const releaseItems = (releases as Record<string, unknown>).items as Record<string, unknown>[];
    const apisixRelease = releaseItems.find(
      (r) => (r.metadata as Record<string, unknown>)?.name === 'apisix'
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

    // Step 3: Verify IngressClass was created
    console.log('Verifying IngressClass...');
    const ingressClass = await networkingApi.readIngressClass({ name: 'apisix' });
    expect(ingressClass).toBeDefined();
    expect(ingressClass.spec?.controller).toBe('apisix.apache.org/apisix-ingress-controller');
    console.log('IngressClass apisix created with correct controller');

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
    await directFactory.deleteInstance('apisix');
    console.log('APISIX deployment cleaned up');
  }, 900000); // 15 minute timeout

  it('should generate proper YAML for kro deployment', async () => {
    const { apisixBootstrap } = await import(
      '../../../src/factories/apisix/compositions/apisix-bootstrap.js'
    );

    // Test YAML generation
    const yaml = apisixBootstrap.toYaml();

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
      ingressControllerReady: true,
      dashboardReady: false,
      etcdReady: false,
      ingressClass: {
        name: 'apisix',
        controller: 'apisix.apache.org/apisix-ingress',
      },
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
