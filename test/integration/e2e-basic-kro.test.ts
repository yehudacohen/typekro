/**
 * Basic E2E Kro Test
 *
 * Simple test to validate basic Kro functionality works
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { Cel, simple, toResourceGraph } from '../../src/index.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type TestNamespaceLease,
} from './shared-kubeconfig';

// Test configuration
const BASE_NAMESPACE = 'typekro-e2e-basic';

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `${BASE_NAMESPACE}-${sanitized}-${timestamp}`;
};

// Check if cluster is available
const clusterAvailable = await isClusterAvailable();

const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('Basic E2E Kro Test', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;
  let appsApi: k8s.AppsV1Api;
  let factory: any;
  let namespaceLease: TestNamespaceLease | undefined;
  let deploymentAttempted = false;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    // Use shared kubeconfig helper for consistent TLS configuration
    try {
      kc = getIntegrationTestKubeConfig();

      k8sApi = createCoreV1ApiClient(kc);
      appsApi = createAppsV1ApiClient(kc);
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

  afterAll(async () => {
    if (!kc) return;
    const cleanupErrors: unknown[] = [];
    if (factory && deploymentAttempted) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'test-app', [], kc, 60_000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (namespaceLease) {
      try {
        await deleteTestNamespaceAndWait(namespaceLease, kc);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Basic KRO integration cleanup failed');
    }
  });

  it('should create a basic RGD and deploy an instance', async () => {
    // Increase timeout for this test as it needs to wait for Kro resources
    const testTimeout = 180000; // 3 minutes
    const startTime = Date.now();
    const testNamespace = generateTestNamespace('basic-rgd-deploy');

    namespaceLease = await createTestNamespace(testNamespace, kc);
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
      })
    );

    // Create factory with TLS-skip kubeConfig
    factory = await resourceGraph.factory('kro', {
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
    deploymentAttempted = true;
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
    const deployment = await appsApi.readNamespacedDeployment({
      name: 'test-app',
      namespace: testNamespace,
    });
    expect(deployment.spec?.template.spec?.containers?.[0]?.image).toBe('nginx:alpine');

    const service = await k8sApi.readNamespacedService({
      name: 'test-app-svc',
      namespace: testNamespace,
    });
    expect(service.spec?.selector?.app).toBe('test-app');

    console.log('✅ Basic E2E test completed successfully');
  });

  // Helper functions
  async function waitForDeployment(
    name: string,
    namespace: string,
    timeoutMs = 120000
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const deployment = await appsApi.readNamespacedDeployment({ name, namespace });
        const status = deployment.status;
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
        await k8sApi.readNamespacedService({ name, namespace });
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
