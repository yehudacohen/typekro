/**
 * Basic E2E Kro Test
 *
 * Simple test to validate basic Kro functionality works
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { Cel, simpleDeployment, simpleService, toResourceGraph } from '../../src/index.js';
import { getIntegrationTestKubeConfig, isClusterAvailable } from './shared-kubeconfig';

// Test configuration
const BASE_NAMESPACE = 'typekro-e2e-basic';
const _TEST_NAMESPACE = 'typekro-e2e-basic'; // Fallback for compatibility
const _TEST_TIMEOUT = 300000; // 5 minutes

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `${BASE_NAMESPACE}-${sanitized}-${timestamp}`;
};
const _CLUSTER_NAME = 'typekro-e2e-test';

// Check if cluster is available
const clusterAvailable = isClusterAvailable();

const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Basic E2E Kro Test', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;
  let appsApi: k8s.AppsV1Api;
  let customApi: k8s.CustomObjectsApi;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    // Use shared kubeconfig helper for consistent TLS configuration
    try {
      kc = getIntegrationTestKubeConfig();

      k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      appsApi = kc.makeApiClient(k8s.AppsV1Api);
      customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    } catch (error) {
      console.error('❌ Failed to initialize Kubernetes client:', error);
      throw new Error(
        `Kubernetes client initialization failed: ${error}. ` +
          'Make sure the test cluster is running and accessible. ' +
          'Run: bun run scripts/e2e-setup.ts to set up the test environment.'
      );
    }

    // Note: Kro controller health check removed to avoid TLS issues during test setup
    // The controller health will be verified during actual test execution

    // Note: Individual test namespaces will be created per test for better isolation
  });

  // Helper function to create and cleanup test namespace
  const _withTestNamespace = async <T>(
    testName: string,
    testFn: (namespace: string) => Promise<T>
  ): Promise<T> => {
    const namespace = generateTestNamespace(testName);

    try {
      // Create namespace
      await k8sApi.createNamespace({ metadata: { name: namespace } });
      console.log(`📦 Created test namespace: ${namespace}`);

      // Run test
      const result = await testFn(namespace);

      return result;
    } finally {
      // Cleanup namespace
      try {
        await k8sApi.deleteNamespace(namespace);
        console.log(`🗑️ Cleaned up test namespace: ${namespace}`);
      } catch (error) {
        console.warn(`⚠️ Failed to cleanup namespace ${namespace}:`, error);
      }
    }
  };

  it('should create a basic RGD and deploy an instance', async () => {
    // Increase timeout for this test as it needs to wait for Kro resources
    const testTimeout = 180000; // 3 minutes
    const startTime = Date.now();
    const testNamespace = generateTestNamespace('basic-rgd-deploy');

    // Create test namespace
    try {
      await k8sApi.createNamespace({ metadata: { name: testNamespace } });
      console.log(`📦 Created test namespace: ${testNamespace}`);
    } catch (_error) {
      console.log(`⚠️ Namespace ${testNamespace} might already exist`);
    }
    // Define a very simple schema
    const AppSpecSchema = type({
      name: 'string',
      image: 'string',
    });

    const AppStatusSchema = type({
      ready: 'boolean',
    });

    // Create a simple resource graph
    const resourceGraph = toResourceGraph(
      {
        name: 'basic-app',
        apiVersion: 'v1alpha1',
        kind: 'BasicApp',
        spec: AppSpecSchema,
        status: AppStatusSchema,
      },
      (schema) => ({
        deployment: simpleDeployment({
          name: schema.spec.name,
          image: schema.spec.image,
          replicas: 1,
          id: 'appDeployment',
        }),

        service: simpleService({
          name: Cel.expr(schema.spec.name, ' + "-svc"'),
          selector: { app: schema.spec.name },
          ports: [{ port: 80, targetPort: 80 }],
          id: 'appService',
        }),
      }),
      (_schema, resources) => ({
        ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
      })
    );

    // Create factory with TLS-skip kubeConfig
    const factory = await resourceGraph.factory('kro', {
      namespace: testNamespace,
      kubeConfig: kc,
    });

    // Generate RGD YAML for inspection
    const rgdYaml = resourceGraph.toYaml();
    expect(rgdYaml).toContain('kind: ResourceGraphDefinition');
    expect(rgdYaml).toContain('name: basic-app');

    // Write RGD YAML for debugging
    const yamlPath = join(process.cwd(), 'temp', 'e2e-basic-rgd.yaml');
    if (!existsSync(join(process.cwd(), 'temp'))) {
      mkdirSync(join(process.cwd(), 'temp'), { recursive: true });
    }
    writeFileSync(yamlPath, rgdYaml);

    console.log('RGD YAML:');
    console.log(rgdYaml);

    // Use factory to deploy (this handles RGD deployment and instance creation automatically)
    console.log('🚀 Deploying using factory...');
    const instance = await factory.deploy({
      name: 'test-app',
      image: 'nginx:alpine',
    });

    // Validate the instance
    expect(instance).toBeDefined();
    expect(instance.spec.name).toBe('test-app');
    expect(instance.spec.image).toBe('nginx:alpine');

    console.log('✅ Factory deployment completed');

    // Wait for the underlying Kubernetes resources to be created by Kro
    console.log('⏳ Waiting for Kro to create underlying resources...');

    // Check timeout periodically
    const checkTimeout = () => {
      if (Date.now() - startTime > testTimeout) {
        throw new Error(`Test timed out after ${testTimeout}ms`);
      }
    };

    await waitForDeployment('test-app', testNamespace);
    checkTimeout();
    await waitForService('test-app-svc', testNamespace);
    checkTimeout();

    // Validate that the underlying Kubernetes resources were created
    const deployment = await appsApi.readNamespacedDeployment('test-app', testNamespace);
    expect(deployment.body.spec?.template.spec?.containers?.[0]?.image).toBe('nginx:alpine');

    const service = await k8sApi.readNamespacedService('test-app-svc', testNamespace);
    expect(service.body.spec?.selector?.app).toBe('test-app');

    console.log('✅ Basic E2E test completed successfully');

    // Cleanup using factory
    try {
      await factory.deleteInstance('test-app');
      console.log('✅ Factory cleanup completed');
    } catch (error) {
      console.warn('⚠️ Factory cleanup failed:', error);
    }

    // Cleanup test namespace
    try {
      await k8sApi.deleteNamespace(testNamespace);
      console.log(`🗑️ Cleaned up test namespace: ${testNamespace}`);
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup namespace ${testNamespace}:`, error);
    }
  });

  // Helper functions
  async function _waitForRGDReady(
    name: string,
    _namespace: string,
    timeoutMs = 60000
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const rgd = await customApi.getClusterCustomObject(
          'kro.run',
          'v1alpha1',
          'resourcegraphdefinitions',
          name
        );
        const status = (rgd.body as any).status;
        // Check if RGD is in Active state and all conditions are True
        if (
          status?.state === 'Active' &&
          status?.conditions?.every((c: any) => c.status === 'True')
        ) {
          console.log(`✅ RGD ${name} is ready`);
          return;
        }

        // Log the current status for debugging
        console.log(`RGD ${name} status:`, status?.state || 'Unknown');
        if (status?.conditions) {
          for (const condition of status.conditions) {
            if (condition.status === 'False') {
              console.log(`❌ ${condition.type}: ${condition.message}`);
            }
          }
        }
      } catch (_error) {
        console.log(`RGD ${name} not found yet, continuing to wait...`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(`Timeout waiting for RGD ${name} to be ready`);
  }

  async function waitForDeployment(
    name: string,
    namespace: string,
    timeoutMs = 120000
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const deployment = await appsApi.readNamespacedDeployment(name, namespace);
        const status = deployment.body.status;
        if (status?.readyReplicas && status.readyReplicas > 0) {
          console.log(`✅ Deployment ${name} is ready`);
          return;
        }
      } catch (_error) {
        // Deployment not found yet, continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for deployment ${name} to be ready`);
  }

  async function waitForService(name: string, namespace: string, timeoutMs = 60000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        await k8sApi.readNamespacedService(name, namespace);
        console.log(`✅ Service ${name} is ready`);
        return;
      } catch (_error) {
        // Service not found yet, continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timeout waiting for service ${name} to be ready`);
  }
});
