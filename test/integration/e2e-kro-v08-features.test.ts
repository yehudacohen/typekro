/**
 * End-to-End Integration Tests for Kro v0.8.x Features
 *
 * Tests the full deployment pipeline for Kro v0.8.x features through the
 * TypeKro composition -> serialization -> Kro controller -> K8s resources flow.
 *
 * Features tested:
 * - forEach: Loop over spec arrays to create multiple resources
 * - includeWhen: Conditional resource creation based on spec fields
 * - readyWhen: Readiness detection based on resource status
 * - externalRef: Reference to pre-existing cluster resources
 * - Kro v0.8.5 bootstrap and controller upgrade
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { ConfigMap, Deployment } from '../../src/factories/simple/index.js';
import {
  Cel,
  externalRef,
  kubernetesComposition,
  simple,
  toResourceGraph,
} from '../../src/index.js';
import {
  cleanupTestNamespaces,
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isKroControllerHealthy,
} from './shared-kubeconfig.js';

// Test configuration
const BASE_NAMESPACE = 'typekro-v08-e2e';
const TEST_TIMEOUT = 300_000; // 5 minutes per test

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6);
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `${BASE_NAMESPACE}-${sanitized}-${timestamp}`;
};

// Generate unique RGD names AND Kind names per test run.
// RGDs are cluster-scoped and Kinds map to CRDs — if two RGDs define the same Kind,
// the second will fail with "CRD is owned by another ResourceGraphDefinition".
const testRunId = Date.now().toString().slice(-6);
const kindSuffix = `R${testRunId}`; // e.g. "R486940" → valid PascalCase identifier suffix

// Check if cluster is available
const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Kro v0.8.x Features E2E Integration Tests', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;
  let appsApi: k8s.AppsV1Api;
  let customApi: k8s.CustomObjectsApi;
  let unhandledRejectionHandler: ((reason: unknown) => void) | undefined;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    console.log('Setting up Kro v0.8.x E2E test environment...');

    kc = getIntegrationTestKubeConfig();
    k8sApi = createCoreV1ApiClient(kc);
    appsApi = createAppsV1ApiClient(kc);
    customApi = createCustomObjectsApiClient(kc);

    // Verify Kro controller is healthy
    const kroHealthy = await isKroControllerHealthy();
    if (!kroHealthy) {
      console.warn('Kro controller may not be ready - tests may fail');
    }

    console.log('Kro v0.8.x E2E test environment ready');

    // Suppress AbortError during test cleanup (known Bun issue with fetch abort)
    unhandledRejectionHandler = (reason: unknown) => {
      const error = reason as { name?: string };
      if (error?.name === 'AbortError' || error?.name === 'DOMException') {
        return;
      }
      throw reason;
    };
    process.on('unhandledRejection', unhandledRejectionHandler);
  });

  afterAll(async () => {
    // Remove the unhandledRejection handler to prevent accumulation across test suites
    if (unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
      unhandledRejectionHandler = undefined;
    }
    if (kc) {
      console.log('Cleaning up Kro v0.8.x test namespaces...');
      await cleanupTestNamespaces(new RegExp(`^${BASE_NAMESPACE}-`), kc);
    }
  });

  // Helper: create namespace, run test, cleanup
  const withTestNamespace = async <T>(
    testName: string,
    testFn: (namespace: string) => Promise<T>
  ): Promise<T> => {
    const namespace = generateTestNamespace(testName);
    try {
      await k8sApi.createNamespace({ body: { metadata: { name: namespace } } });
      console.log(`Created test namespace: ${namespace}`);
      return await testFn(namespace);
    } finally {
      await deleteNamespaceAndWait(namespace, kc);
    }
  };

  // Helper: wait for a Deployment to have ready replicas
  const waitForDeployment = async (
    name: string,
    namespace: string,
    timeoutMs = 120_000
  ): Promise<void> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const deployment = await appsApi.readNamespacedDeployment({ name, namespace });
        if ((deployment.status?.readyReplicas ?? 0) > 0) {
          console.log(`Deployment ${name} is ready`);
          return;
        }
      } catch {
        // Not found yet, keep waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timeout waiting for deployment ${name} in ${namespace}`);
  };

  // Helper: wait for a ConfigMap to exist
  const waitForConfigMap = async (
    name: string,
    namespace: string,
    timeoutMs = 60_000
  ): Promise<k8s.V1ConfigMap> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const cm = await k8sApi.readNamespacedConfigMap({ name, namespace });
        console.log(`ConfigMap ${name} exists`);
        return cm;
      } catch {
        // Not found yet, keep waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for ConfigMap ${name} in ${namespace}`);
  };

  // Helper: wait for a Service to exist
  const waitForService = async (
    name: string,
    namespace: string,
    timeoutMs = 60_000
  ): Promise<void> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        await k8sApi.readNamespacedService({ name, namespace });
        console.log(`Service ${name} exists`);
        return;
      } catch {
        // Not found yet, keep waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for Service ${name} in ${namespace}`);
  };

  // Helper: clean up an RGD (cluster-scoped)
  const cleanupRGD = async (name: string): Promise<void> => {
    try {
      await customApi.deleteClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name,
      });
      console.log(`Deleted RGD: ${name}`);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; body?: { reason?: string } };
      if (err.statusCode !== 404 && err.body?.reason !== 'NotFound') {
        console.warn(`Failed to delete RGD ${name}:`, error);
      }
    }
  };

  // =========================================================================
  // 1. Kro v0.8.5 Bootstrap Verification
  // =========================================================================

  describe('Kro v0.8.5 Controller', () => {
    it('should have the Kro controller running in kro-system', async () => {
      const healthy = await isKroControllerHealthy();
      expect(healthy).toBe(true);
    });

    it('should have the ResourceGraphDefinition CRD installed', async () => {
      try {
        // List RGDs to verify the CRD exists
        const rgds = await customApi.listClusterCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          plural: 'resourcegraphdefinitions',
        });
        expect(rgds).toBeDefined();
        expect((rgds as { items?: unknown[] }).items).toBeDefined();
        console.log(`Found ${(rgds as { items: unknown[] }).items.length} existing RGDs`);
      } catch (error) {
        throw new Error(`Kro CRD not available: ${error}`);
      }
    });
  });

  // =========================================================================
  // 2. includeWhen — Conditional Resource Creation
  // =========================================================================

  describe('includeWhen — Conditional Resources', () => {
    const includeWhenRGDName = `v08-includewhen-${testRunId}`;

    afterAll(async () => {
      await cleanupRGD(includeWhenRGDName);
    });

    it('should conditionally create resources based on spec.monitoring flag', async () => {
      await withTestNamespace('includewhen', async (namespace) => {
        // Define composition with conditional resources
        const graph = kubernetesComposition(
          {
            name: includeWhenRGDName,
            apiVersion: 'v1alpha1',
            kind: `IncludeWhenApp${kindSuffix}`,
            spec: type({
              name: 'string',
              image: 'string',
              monitoring: 'boolean',
            }),
            status: type({
              ready: 'boolean',
            }),
          },
          (spec) => {
            // Always create main deployment
            Deployment({
              name: spec.name,
              image: spec.image,
              replicas: 1,
              id: 'main',
            });

            // Conditionally create monitoring ConfigMap
            if (spec.monitoring) {
              ConfigMap({
                name: `${spec.name}-monitoring`,
                data: { enabled: 'true', endpoint: '/metrics' },
                id: 'monitoringConfig',
              });
            }

            return { ready: true };
          }
        );

        // Verify YAML contains includeWhen
        const yaml = graph.toYaml();
        expect(yaml).toContain('includeWhen');
        expect(yaml).toContain('schema.spec.monitoring');
        console.log('includeWhen YAML generated correctly');

        // Deploy with monitoring=true — both resources should be created
        const factory = await graph.factory('kro', {
          namespace,
          kubeConfig: kc,
          timeout: TEST_TIMEOUT,
          waitForReady: true,
        });

        const instance = await factory.deploy({
          name: 'test-include',
          image: 'nginx:alpine',
          monitoring: true,
        });

        expect(instance).toBeDefined();
        expect(instance.spec.name).toBe('test-include');
        expect(instance.spec.monitoring).toBe(true);

        // Wait for the main Deployment to be created by Kro
        await waitForDeployment('test-include', namespace);

        // The monitoring ConfigMap should also exist
        const monitoringCM = await waitForConfigMap('test-include-monitoring', namespace);
        expect(monitoringCM.data?.enabled).toBe('true');
        expect(monitoringCM.data?.endpoint).toBe('/metrics');

        console.log('includeWhen with monitoring=true: all resources created');

        // Clean up instance
        await factory.deleteInstance('test-include');
      });
    });
  });

  // =========================================================================
  // 3. readyWhen — Custom Readiness Detection
  // =========================================================================

  describe('readyWhen — Readiness Detection', () => {
    const readyWhenRGDName = `v08-readywhen-${testRunId}`;

    afterAll(async () => {
      await cleanupRGD(readyWhenRGDName);
    });

    it('should deploy and wait for readiness using readyWhen expression', async () => {
      await withTestNamespace('readywhen', async (namespace) => {
        // Define composition with readyWhen
        const graph = kubernetesComposition(
          {
            name: readyWhenRGDName,
            apiVersion: 'v1alpha1',
            kind: `ReadyWhenApp${kindSuffix}`,
            spec: type({
              name: 'string',
              image: 'string',
            }),
            status: type({
              ready: 'boolean',
            }),
          },
          (spec) => {
            Deployment({
              name: spec.name,
              image: spec.image,
              replicas: 1,
              id: 'app',
            }).withReadyWhen(
              (self: { status: { readyReplicas: number } }) => self.status.readyReplicas > 0
            );

            return { ready: true };
          }
        );

        // Verify YAML contains readyWhen
        const yaml = graph.toYaml();
        expect(yaml).toContain('readyWhen');
        expect(yaml).toContain('app.status.readyReplicas');
        console.log('readyWhen YAML generated correctly');

        // Deploy — factory will wait for Kro instance to become ACTIVE
        const factory = await graph.factory('kro', {
          namespace,
          kubeConfig: kc,
          timeout: TEST_TIMEOUT,
          waitForReady: true,
        });

        const instance = await factory.deploy({
          name: 'test-ready',
          image: 'nginx:alpine',
        });

        expect(instance).toBeDefined();
        expect(instance.spec.name).toBe('test-ready');

        // Verify the Deployment is actually ready (since readyWhen waited)
        const deployment = await appsApi.readNamespacedDeployment({
          name: 'test-ready',
          namespace,
        });
        expect(deployment.status?.readyReplicas).toBeGreaterThan(0);
        console.log('readyWhen: deployment is ready as expected');

        await factory.deleteInstance('test-ready');
      });
    });
  });

  // =========================================================================
  // 4. forEach — Collection Resource Creation
  // =========================================================================

  describe('forEach — Collection Resources', () => {
    const forEachRGDName = `v08-foreach-${testRunId}`;

    afterAll(async () => {
      await cleanupRGD(forEachRGDName);
    });

    it('should create multiple ConfigMaps from a spec array using forEach', async () => {
      await withTestNamespace('foreach', async (namespace) => {
        // Define composition with forEach over a string array
        const graph = kubernetesComposition(
          {
            name: forEachRGDName,
            apiVersion: 'v1alpha1',
            kind: `ForEachApp${kindSuffix}`,
            spec: type({
              name: 'string',
              environments: 'string[]',
            }),
            status: type({
              ready: 'boolean',
            }),
          },
          (spec) => {
            // Create a ConfigMap for each environment
            for (const env of spec.environments) {
              ConfigMap({
                name: `${spec.name}-${env}`,
                data: { environment: env },
                id: 'envConfig',
              });
            }

            return { ready: true };
          }
        );

        // Verify YAML contains forEach
        const yaml = graph.toYaml();
        expect(yaml).toContain('forEach');
        console.log('forEach YAML generated correctly');

        // Deploy with 3 environments
        const factory = await graph.factory('kro', {
          namespace,
          kubeConfig: kc,
          timeout: TEST_TIMEOUT,
          waitForReady: true,
        });

        const instance = await factory.deploy({
          name: 'test-foreach',
          environments: ['dev', 'staging', 'prod'],
        });

        expect(instance).toBeDefined();
        expect(instance.spec.name).toBe('test-foreach');
        expect(instance.spec.environments).toEqual(['dev', 'staging', 'prod']);

        // Wait for the ConfigMaps to be created by Kro
        // forEach iterates and creates one ConfigMap per environment
        for (const env of ['dev', 'staging', 'prod']) {
          const cm = await waitForConfigMap(`test-foreach-${env}`, namespace);
          expect(cm.data?.environment).toBe(env);
          console.log(`forEach: ConfigMap for ${env} created`);
        }

        console.log('forEach: all 3 ConfigMaps created from spec.environments array');

        await factory.deleteInstance('test-foreach');
      });
    });
  });

  // =========================================================================
  // 5. externalRef — External Resource References
  // =========================================================================

  describe('externalRef — External Resource References', () => {
    const extRefRGDName = `v08-extref-${testRunId}`;

    afterAll(async () => {
      await cleanupRGD(extRefRGDName);
    });

    it('should reference a pre-existing ConfigMap via externalRef', async () => {
      await withTestNamespace('extref', async (namespace) => {
        // Pre-create an external ConfigMap that the composition will reference
        await k8sApi.createNamespacedConfigMap({
          namespace,
          body: {
            metadata: { name: 'platform-config' },
            data: { region: 'us-east-1', tier: 'production' },
          },
        });
        console.log('Created external ConfigMap: platform-config');

        // Define composition that references the external ConfigMap
        const graph = kubernetesComposition(
          {
            name: extRefRGDName,
            apiVersion: 'v1alpha1',
            kind: `ExtRefApp${kindSuffix}`,
            spec: type({
              name: 'string',
              image: 'string',
            }),
            status: type({
              ready: 'boolean',
            }),
          },
          (spec) => {
            // Reference the pre-existing ConfigMap
            // The externalRef call registers the reference in the composition context
            externalRef({
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: { name: 'platform-config', namespace },
            });

            // Create a Deployment
            Deployment({
              name: spec.name,
              image: spec.image,
              replicas: 1,
              id: 'app',
            });

            return { ready: true };
          }
        );

        // Verify YAML contains externalRef
        const yaml = graph.toYaml();
        expect(yaml).toContain('externalRef');
        expect(yaml).toContain('platform-config');
        console.log('externalRef YAML generated correctly');

        // Deploy
        const factory = await graph.factory('kro', {
          namespace,
          kubeConfig: kc,
          timeout: TEST_TIMEOUT,
          waitForReady: true,
        });

        const instance = await factory.deploy({
          name: 'test-extref',
          image: 'nginx:alpine',
        });

        expect(instance).toBeDefined();

        // Verify the Deployment was created
        await waitForDeployment('test-extref', namespace);
        console.log('externalRef: deployment created alongside external reference');

        await factory.deleteInstance('test-extref');
      });
    });
  });

  // =========================================================================
  // 6. Combined Features — Multi-Feature Composition
  // =========================================================================

  describe('Combined Features — Multi-Feature Composition', () => {
    const combinedRGDName = `v08-combined-${testRunId}`;

    afterAll(async () => {
      await cleanupRGD(combinedRGDName);
    });

    it('should combine includeWhen + readyWhen in a single composition', async () => {
      await withTestNamespace('combined', async (namespace) => {
        const graph = kubernetesComposition(
          {
            name: combinedRGDName,
            apiVersion: 'v1alpha1',
            kind: `CombinedApp${kindSuffix}`,
            spec: type({
              name: 'string',
              image: 'string',
              enableCache: 'boolean',
            }),
            status: type({
              ready: 'boolean',
            }),
          },
          (spec) => {
            // Main deployment with readyWhen
            Deployment({
              name: spec.name,
              image: spec.image,
              replicas: 1,
              id: 'app',
            }).withReadyWhen(
              (self: { status: { readyReplicas: number } }) => self.status.readyReplicas > 0
            );

            // Conditional cache ConfigMap with includeWhen
            if (spec.enableCache) {
              ConfigMap({
                name: `${spec.name}-cache-config`,
                data: { cacheEnabled: 'true', ttl: '3600' },
                id: 'cacheConfig',
              });
            }

            return { ready: true };
          }
        );

        // Verify YAML contains both features
        const yaml = graph.toYaml();
        expect(yaml).toContain('readyWhen');
        expect(yaml).toContain('includeWhen');
        console.log('Combined YAML contains readyWhen and includeWhen');

        // Deploy with cache enabled
        const factory = await graph.factory('kro', {
          namespace,
          kubeConfig: kc,
          timeout: TEST_TIMEOUT,
          waitForReady: true,
        });

        const instance = await factory.deploy({
          name: 'test-combined',
          image: 'nginx:alpine',
          enableCache: true,
        });

        expect(instance).toBeDefined();
        expect(instance.spec.enableCache).toBe(true);

        // Verify the Deployment is ready (readyWhen)
        const deployment = await appsApi.readNamespacedDeployment({
          name: 'test-combined',
          namespace,
        });
        expect(deployment.status?.readyReplicas).toBeGreaterThan(0);

        // Verify the cache ConfigMap was created (includeWhen)
        const cacheCM = await waitForConfigMap('test-combined-cache-config', namespace);
        expect(cacheCM.data?.cacheEnabled).toBe('true');

        console.log('Combined: readyWhen + includeWhen both working');

        await factory.deleteInstance('test-combined');
      });
    });
  });

  // =========================================================================
  // 7. toResourceGraph API — Declarative Style with v0.8 Features
  // =========================================================================

  describe('toResourceGraph — Declarative Style', () => {
    const declarativeRGDName = `v08-declarative-${testRunId}`;

    afterAll(async () => {
      await cleanupRGD(declarativeRGDName);
    });

    it('should deploy a toResourceGraph-based composition with CEL status expressions', async () => {
      await withTestNamespace('declarative', async (namespace) => {
        const graph = toResourceGraph(
          {
            name: declarativeRGDName,
            apiVersion: 'v1alpha1',
            kind: `DeclarativeApp${kindSuffix}`,
            spec: type({
              name: 'string',
              image: 'string',
            }),
            status: type({
              ready: 'boolean',
              replicas: 'number',
            }),
          },
          (schema) => ({
            deployment: simple.Deployment({
              name: schema.spec.name,
              image: schema.spec.image,
              replicas: 1,
              id: 'appDeployment',
            }),
            service: simple.Service({
              name: Cel.expr(schema.spec.name, ' + "-svc"'),
              selector: { app: schema.spec.name },
              ports: [{ port: 80, targetPort: 80 }],
              id: 'appService',
            }),
          }),
          (_schema, resources) => ({
            ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
            replicas: resources.deployment.status.readyReplicas,
          })
        );

        // Deploy
        const factory = await graph.factory('kro', {
          namespace,
          kubeConfig: kc,
          timeout: TEST_TIMEOUT,
          waitForReady: true,
        });

        const instance = await factory.deploy({
          name: 'test-decl',
          image: 'nginx:alpine',
        });

        expect(instance).toBeDefined();

        // Verify Deployment and Service created
        await waitForDeployment('test-decl', namespace);
        await waitForService('test-decl-svc', namespace);

        // Verify the Deployment is healthy
        const deployment = await appsApi.readNamespacedDeployment({
          name: 'test-decl',
          namespace,
        });
        expect(deployment.status?.readyReplicas).toBeGreaterThan(0);

        console.log('Declarative toResourceGraph: deployment + service created with CEL status');

        await factory.deleteInstance('test-decl');
      });
    }, 600000); // 10 minutes - Kro reconciliation + deployment readiness under contention
  });
});
