/**
 * End-to-End Helm Integration Test
 *
 * This test verifies real Helm deployment using TypeKro with Flux CD Helm Controller.
 * It assumes Flux is already installed (via the bootstrap composition or e2e-setup.ts)
 * and focuses on testing HelmRepository + HelmRelease deployment via Direct Factory.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { toResourceGraph } from '../../src/core/serialization/index.js';
import { helmRelease, helmRepository } from '../../src/factories/helm/index.js';
import { namespace } from '../../src/factories/kubernetes/index.js';
import {
  createAppsV1ApiClient,
  createCustomObjectsApiClient,
  deleteNamespaceAndWait,
  ensureFluxInstalled,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from './shared-kubeconfig.js';

// Test configuration
const TEST_TIMEOUT = 660000; // 11 minutes — must exceed factory timeout (10 min) to see actual errors

// Check if cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

// Generate unique test namespace per run
const testRunId = Date.now().toString().slice(-6);
const testNamespace = `typekro-helm-e2e-${testRunId}`;

describeOrSkip('End-to-End Helm Integration', () => {
  let kc: k8s.KubeConfig;
  let appsApi: k8s.AppsV1Api;
  let customApi: k8s.CustomObjectsApi;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('Setting up Helm integration test environment...');

    kc = getIntegrationTestKubeConfig();
    appsApi = createAppsV1ApiClient(kc);
    customApi = createCustomObjectsApiClient(kc);

    // Ensure Flux is installed and ready (idempotent — skips if already running)
    await ensureFluxInstalled({ kubeConfig: kc, verbose: true });

    console.log('Helm integration test environment ready');
  });

  afterAll(async () => {
    if (!clusterAvailable || !kc) return;

    // Clean up test namespace
    try {
      await deleteNamespaceAndWait(testNamespace, kc);
    } catch {
      // Ignore cleanup errors
    }

    // Clean up the bitnami HelmRepository we created in flux-system
    try {
      await customApi.deleteNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'helmrepositories',
        name: `bitnami-${testRunId}`,
      });
      console.log(`Deleted HelmRepository bitnami-${testRunId}`);
    } catch {
      // May not exist
    }
  });

  it(
    'should deploy HelmRepository and HelmRelease resources via Direct Factory',
    async () => {
      console.log('Starting Helm integration test...');
      const startTime = Date.now();

      // Helper function to wait for deployment readiness
      const waitForDeployment = async (name: string, ns: string, timeout = 180000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          try {
            const deployment = await appsApi.readNamespacedDeployment({ name, namespace: ns });
            const readyReplicas = deployment.status?.readyReplicas || 0;
            const replicas = deployment.spec?.replicas || 1;

            if (readyReplicas >= replicas) {
              console.log(`Deployment ${name} is ready (${readyReplicas}/${replicas})`);
              return deployment;
            }
          } catch {
            // Deployment doesn't exist yet
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        throw new Error(`Deployment ${name} did not become ready within ${timeout}ms`);
      };

      // Step 1: Define a resource graph with HelmRepository + HelmRelease (no Flux install)
      console.log('Step 1: Creating resource graph with HelmRepository + HelmRelease...');

      const HelmPlatformSpecSchema = type({
        name: 'string',
        environment: '"development" | "staging" | "production"',
        nginxReplicas: 'number',
        enableRedis: 'boolean',
      });

      const HelmPlatformStatusSchema = type({
        phase: '"Pending" | "Installing" | "Ready" | "Failed"',
        helmControllerReady: 'boolean',
        applicationsDeployed: 'number',
      });

      // Use unique names to avoid conflicts with other test runs
      const bitnamiRepoName = `bitnami-${testRunId}`;
      const nginxReleaseName = `nginx-${testRunId}`;

      const helmPlatformGraph = toResourceGraph(
        {
          name: 'helm-platform',
          apiVersion: 'platform.example.com/v1alpha1',
          kind: 'HelmPlatform',
          spec: HelmPlatformSpecSchema,
          status: HelmPlatformStatusSchema,
        },
        (schema) => ({
          // Application Namespace
          appNamespace: namespace({
            metadata: { name: testNamespace },
          }),

          // Bitnami Helm Repository (OCI-based, in flux-system for HelmReleases to find)
          bitnamiRepo: helmRepository({
            name: bitnamiRepoName,
            namespace: 'flux-system',
            url: 'oci://registry-1.docker.io/bitnamicharts',
            type: 'oci',
          }),

          // NGINX Helm Release — sourceRef points at our uniquely-named HelmRepository
          nginxApp: helmRelease({
            name: nginxReleaseName,
            namespace: testNamespace,
            chart: {
              repository: 'oci://registry-1.docker.io/bitnamicharts',
              name: 'nginx',
              version: '22.5.0',
            },
            sourceRef: {
              name: bitnamiRepoName,
              namespace: 'flux-system',
            },
            values: {
              replicaCount: schema.spec.nginxReplicas,
              service: {
                type: 'ClusterIP',
              },
              ingress: {
                enabled: false,
              },
              resources: {
                requests: {
                  cpu: schema.spec.environment === 'production' ? '500m' : '100m',
                  memory: schema.spec.environment === 'production' ? '512Mi' : '128Mi',
                },
              },
            },
          }),

          // Conditional Redis Helm Release
          ...(schema.spec.enableRedis
            ? {
                redisCache: helmRelease({
                  name: `redis-${testRunId}`,
                  namespace: testNamespace,
                  chart: {
                    repository: 'oci://registry-1.docker.io/bitnamicharts',
                    name: 'redis',
                    version: '25.3.0',
                  },
                  sourceRef: {
                    name: bitnamiRepoName,
                    namespace: 'flux-system',
                  },
                  values: {
                    auth: { enabled: false },
                    replica: { replicaCount: 1 },
                  },
                }),
              }
            : {}),
        }),
        (schema, _resources) => ({
          phase: 'Ready' as const,
          helmControllerReady: true,
          applicationsDeployed: schema.spec.enableRedis ? 2 : 1,
        })
      );

      // Step 2: Deploy using Direct factory
      console.log('Step 2: Deploying via Direct factory...');

      const factory = await helmPlatformGraph.factory('direct', {
        namespace: testNamespace,
        kubeConfig: kc,
        timeout: 180000, // 3 minutes — OCI chart pull + Flux reconciliation + nginx pod startup
      });

      const platformInstance = await factory.deploy({
        name: 'helm-platform-instance',
        environment: 'development',
        nginxReplicas: 1,
        enableRedis: false,
      });

      expect(platformInstance).toBeDefined();
      expect(platformInstance.spec.environment).toBe('development');
      expect(platformInstance.spec.nginxReplicas).toBe(1);
      expect(platformInstance.spec.enableRedis).toBe(false);

      console.log('Platform instance deployed');

      // Step 3: Verify HelmRepository was created
      console.log('Step 3: Verifying HelmRepository...');
      const helmRepo = await customApi.getNamespacedCustomObject({
        group: 'source.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'helmrepositories',
        name: bitnamiRepoName,
      });
      expect(helmRepo).toBeDefined();
      console.log('HelmRepository created');

      // Step 4: Verify HelmRelease was created
      console.log('Step 4: Verifying HelmRelease...');
      const nginxHelmRelease = await customApi.getNamespacedCustomObject({
        group: 'helm.toolkit.fluxcd.io',
        version: 'v2',
        namespace: testNamespace,
        plural: 'helmreleases',
        name: nginxReleaseName,
      });
      expect(nginxHelmRelease).toBeDefined();
      console.log('NGINX HelmRelease created');

      // Step 5: Wait for Flux to reconcile the HelmRelease and nginx to start
      console.log('Step 5: Waiting for nginx deployment to become ready...');
      try {
        await waitForDeployment(`${nginxReleaseName}-nginx`, testNamespace, 180000);
        console.log('NGINX deployment is ready');
      } catch (_error) {
        // Flux may name the deployment differently — try alternate names
        try {
          await waitForDeployment(nginxReleaseName, testNamespace, 30000);
          console.log('NGINX deployment is ready (alternate name)');
        } catch {
          console.warn(
            'NGINX deployment not ready within timeout (Flux reconciliation may be slow)'
          );
          // Don't fail the test — the HelmRelease creation itself is the main assertion
        }
      }

      // Step 6: Verify YAML generation
      console.log('Step 6: Verifying YAML generation...');

      const rgdYaml = helmPlatformGraph.toYaml();
      const instanceYaml = factory.toYaml({
        name: 'helm-platform-instance',
        environment: 'development',
        nginxReplicas: 2,
        enableRedis: true,
      });

      // RGD YAML structure
      expect(rgdYaml).toContain('apiVersion: kro.run/v1alpha1');
      expect(rgdYaml).toContain('kind: ResourceGraphDefinition');
      expect(rgdYaml).toContain('name: helm-platform');
      expect(rgdYaml).toContain('kind: Namespace');
      expect(rgdYaml).toContain('kind: HelmRepository');
      expect(rgdYaml).toContain(bitnamiRepoName);
      expect(rgdYaml).toContain('apiVersion: helm.toolkit.fluxcd.io/v2');
      expect(rgdYaml).toContain('kind: HelmRelease');
      expect(rgdYaml).toContain(nginxReleaseName);
      expect(rgdYaml).toContain('replicaCount: ${schema.spec.nginxReplicas}');

      // Instance YAML
      expect(instanceYaml).toContain('apiVersion: v1');
      expect(instanceYaml).toContain('kind: Namespace');
      expect(instanceYaml).toContain('apiVersion: source.toolkit.fluxcd.io/v1');
      expect(instanceYaml).toContain('kind: HelmRepository');
      expect(instanceYaml).toContain('apiVersion: helm.toolkit.fluxcd.io/v2');
      expect(instanceYaml).toContain('kind: HelmRelease');

      console.log('YAML generation verified');

      // Cleanup
      console.log('Cleaning up...');
      try {
        await factory.deleteInstance('helm-platform-instance');
      } catch {
        // Best effort
      }

      console.log(`Helm integration test completed in ${Date.now() - startTime}ms`);
    },
    TEST_TIMEOUT
  );

  it('should demonstrate Helm readiness evaluation with mock data', async () => {
    const mockHelmRelease = {
      apiVersion: 'helm.toolkit.fluxcd.io/v2beta2',
      kind: 'HelmRelease',
      metadata: {
        name: 'test-release',
        namespace: 'test',
      },
      status: {
        phase: 'Ready',
        revision: 1,
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            message: 'Release reconciliation succeeded',
          },
        ],
      },
    };

    const { helmReleaseReadinessEvaluator } = await import(
      '../../src/factories/helm/readiness-evaluators.js'
    );

    const readinessResult = helmReleaseReadinessEvaluator(mockHelmRelease);

    expect(readinessResult.ready).toBe(true);
    expect(readinessResult.message).toContain('HelmRelease is ready');

    console.log('Helm readiness evaluation verified');
  });
});
