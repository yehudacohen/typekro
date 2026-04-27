/**
 * End-to-End Kubernetes Cluster Test with Kro Controller
 *
 * Tests the full TypeKro workflow using the TypeKro API (no kubectl, no shell commands):
 * 1. Define a resource graph with toResourceGraph() — multiple resources with cross-resource refs
 * 2. Deploy via factory.deploy() — handles RGD creation, CRD registration, and instance creation
 * 3. Verify Kro created the underlying Kubernetes resources
 * 4. Clean up: delete instance, delete RGD, delete namespace
 *
 * Requires: Kro 0.9.1+ installed in the cluster (via Flux/Helm or manual install)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { Cel, simple, toResourceGraph } from '../../src/index';
import {
  cleanupTestNamespaces,
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  deleteNamespaceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from './shared-kubeconfig';

// Generate unique test run ID to avoid CRD ownership conflicts
const testRunId = Date.now().toString().slice(-6);

// Test configuration
const BASE_NAMESPACE = 'typekro-e2e-cluster';
const TEST_TIMEOUT = 180000; // 3 minutes

// Generate unique namespace for test isolation
const generateTestNamespace = (testName: string): string => {
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `${BASE_NAMESPACE}-${sanitized}-${testRunId}`;
};

// Unique RGD/Kind names to avoid conflicts with other test runs
const RGD_NAME = `webapp-stack-${testRunId}`;
const KIND_NAME = `WebappStack${testRunId}`;

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

describeOrSkip('End-to-End Kubernetes Cluster Test with Kro Controller', () => {
  let kc: k8s.KubeConfig;
  let k8sApi: k8s.CoreV1Api;
  let appsApi: k8s.AppsV1Api;
  let customApi: k8s.CustomObjectsApi;

  beforeAll(async () => {
    if (!clusterAvailable) return;

    kc = getIntegrationTestKubeConfig();
    k8sApi = createCoreV1ApiClient(kc);
    appsApi = createAppsV1ApiClient(kc);
    customApi = createCustomObjectsApiClient(kc);

    console.log(`Test run ID: ${testRunId}`);
    console.log(`RGD name: ${RGD_NAME}, Kind: ${KIND_NAME}`);
  });

  afterAll(async () => {
    if (!kc) return;

    // Clean up the RGD (cluster-scoped)
    try {
      await customApi.deleteClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name: RGD_NAME,
      });
      console.log(`Deleted RGD: ${RGD_NAME}`);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; body?: { reason?: string } };
      if (err.statusCode !== 404 && err.body?.reason !== 'NotFound') {
        console.warn(`Failed to delete RGD ${RGD_NAME}:`, error);
      }
    }

    // Clean up any leftover test namespaces
    await cleanupTestNamespaces(new RegExp(`^${BASE_NAMESPACE}-`), kc);
  });

  it(
    'should deploy a complete resource graph with cross-resource references via TypeKro API',
    async () => {
      const NAMESPACE = generateTestNamespace('full-deploy');

      // Create test namespace
      try {
        await k8sApi.createNamespace({ body: { metadata: { name: NAMESPACE } } });
        console.log(`Created test namespace: ${NAMESPACE}`);
      } catch (_error) {
        console.log(`Namespace ${NAMESPACE} might already exist`);
      }

      // Step 1: Define a resource graph with multiple resources and CEL-based cross-resource refs
      // Uses: ConfigMap, Deployment, Service with schema-driven names and env vars
      console.log('Step 1: Defining resource graph with cross-resource references...');

      const WebAppSpecSchema = type({
        appName: 'string',
        environment: '"development" | "staging" | "production"',
      });

      const WebAppStatusSchema = type({
        ready: 'boolean',
      });

      const resourceGraph = toResourceGraph(
        {
          name: RGD_NAME,
          apiVersion: 'v1alpha1',
          kind: KIND_NAME,
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          // ConfigMap with app configuration — name derived from schema via CEL
          appConfig: simple.ConfigMap({
            name: Cel.expr(schema.spec.appName, ' + "-config"'),
            namespace: NAMESPACE,
            data: {
              LOG_LEVEL: 'info',
              DATABASE_URL: 'postgresql://localhost:5432/webapp',
              FEATURE_FLAGS: 'auth,metrics,logging',
              ENVIRONMENT: schema.spec.environment,
            },
            id: 'webappConfig',
          }),

          // Web app deployment — name from schema, 1 replica for fast readiness
          webapp: simple.Deployment({
            name: schema.spec.appName,
            namespace: NAMESPACE,
            image: 'nginx:alpine',
            replicas: 1,
            env: {
              LOG_LEVEL: 'info',
              APP_NAME: schema.spec.appName,
            },
            ports: [{ containerPort: 80, name: 'http' }],
            id: 'webapp',
          }),

          // Service exposing the web app — name derived from schema via CEL
          webappService: simple.Service({
            name: Cel.expr(schema.spec.appName, ' + "-svc"'),
            namespace: NAMESPACE,
            selector: { app: schema.spec.appName },
            ports: [{ port: 80, targetPort: 80, name: 'http' }],
            id: 'webappService',
          }),
        }),
        (_schema, resources) => ({
          ready: Cel.expr<boolean>(resources.webapp.status.readyReplicas, ' > 0'),
        })
      );

      // Step 2: Verify the generated YAML contains expected structure
      console.log('Step 2: Validating generated RGD YAML...');
      const rgdYaml = resourceGraph.toYaml();

      expect(rgdYaml).toContain('kind: ResourceGraphDefinition');
      expect(rgdYaml).toContain(`name: ${RGD_NAME}`);
      expect(rgdYaml).toContain('appName');
      expect(rgdYaml).toContain('environment');

      console.log('RGD YAML (first 30 lines):');
      console.log(rgdYaml.split('\n').slice(0, 30).join('\n'));

      // Step 3: Deploy using the TypeKro factory API
      // This handles: RGD creation -> CRD registration -> instance creation -> readiness wait
      console.log('Step 3: Deploying via factory.deploy()...');

      const factory = await resourceGraph.factory('kro', {
        namespace: NAMESPACE,
        kubeConfig: kc,
        waitForReady: true,
        timeout: TEST_TIMEOUT,
      });

      const instance = await factory.deploy({
        appName: 'myapp',
        environment: 'development',
      });

      // Validate the returned Enhanced instance
      expect(instance).toBeDefined();
      expect(instance.spec.appName).toBe('myapp');
      expect(instance.spec.environment).toBe('development');
      console.log('Factory deployment completed successfully');

      // Step 4: Verify that Kro created the underlying Kubernetes resources
      console.log('Step 4: Verifying Kro created the underlying resources...');

      // Wait for resources with retries (Kro may take a moment to reconcile)
      const waitForResource = async <T>(
        name: string,
        fetchFn: () => Promise<T>,
        timeoutMs = 60000
      ): Promise<T> => {
        const startTime = Date.now();
        let lastError: unknown;
        while (Date.now() - startTime < timeoutMs) {
          try {
            return await fetchFn();
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        throw new Error(
          `Timeout waiting for resource ${name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        );
      };

      // Verify ConfigMap — name resolved from CEL: "myapp" + "-config" = "myapp-config"
      const configMap = await waitForResource('myapp-config', () =>
        k8sApi.readNamespacedConfigMap({ name: 'myapp-config', namespace: NAMESPACE })
      );
      expect(configMap.data?.LOG_LEVEL).toBe('info');
      expect(configMap.data?.FEATURE_FLAGS).toBe('auth,metrics,logging');
      expect(configMap.data?.ENVIRONMENT).toBe('development');
      console.log('ConfigMap verified: myapp-config');

      // Verify Deployment — name resolved from schema: "myapp"
      const webDeployment = await waitForResource('myapp', () =>
        appsApi.readNamespacedDeployment({ name: 'myapp', namespace: NAMESPACE })
      );
      expect(webDeployment.spec?.replicas).toBe(1);
      expect(webDeployment.spec?.template.spec?.containers?.[0]?.image).toBe('nginx:alpine');
      console.log('Deployment verified: myapp');

      // Check that env vars contain schema-driven values resolved by Kro
      const webContainer = webDeployment.spec?.template.spec?.containers?.[0];
      const envVars = webContainer?.env || [];
      const appNameEnv = envVars.find((env) => env.name === 'APP_NAME');
      if (appNameEnv) {
        expect(appNameEnv.value).toBe('myapp');
        console.log(`APP_NAME resolved to: ${appNameEnv.value}`);
      }

      // Verify Service — name resolved from CEL: "myapp" + "-svc" = "myapp-svc"
      const webService = await waitForResource('myapp-svc', () =>
        k8sApi.readNamespacedService({ name: 'myapp-svc', namespace: NAMESPACE })
      );
      expect(webService.spec?.ports?.[0]?.port).toBe(80);
      expect(webService.spec?.selector?.app).toBe('myapp');
      console.log('Service verified: myapp-svc');

      console.log('All 3 resources verified — Kro created them from the ResourceGraphDefinition');

      // Step 5: Cleanup — delete instance via factory, then namespace
      console.log('Step 5: Cleaning up...');
      try {
        await factory.deleteInstance('myapp');
        console.log('Instance deleted via factory');
      } catch (error) {
        console.warn('Instance cleanup failed:', error);
      }

      await deleteNamespaceAndWait(NAMESPACE, kc);
      console.log('E2E cluster test completed successfully');
    },
    TEST_TIMEOUT
  );
});
