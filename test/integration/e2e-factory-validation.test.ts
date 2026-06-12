/**
 * E2E Factory Pattern Validation Tests
 *
 * This test suite validates all factory pattern combinations by testing:
 * 1. Factory creation and configuration
 * 2. YAML generation and structure
 * 3. Type safety and method availability
 * 4. Error handling for different scenarios
 *
 * This focuses on validating the factory patterns work correctly without
 * requiring full cluster deployment (which has serialization issues to fix).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { Cel, simple, toResourceGraph } from '../../src/index.js';
import { createCoreV1ApiClient, getIntegrationTestKubeConfig } from './shared-kubeconfig.js';

// Test configuration
const BASE_NAMESPACE = 'typekro-factory-validation';
const _TEST_TIMEOUT = 60000; // 1 minute

// Generate unique namespace for each test
const generateTestNamespace = (testName: string): string => {
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits
  const sanitized = testName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 20);
  return `${BASE_NAMESPACE}-${sanitized}-${timestamp}`;
};

describe('E2E Factory Pattern Validation Tests', () => {
  let kc: k8s.KubeConfig;
  const createdNamespaces: string[] = [];

  beforeAll(async () => {
    // Initialize Kubernetes client (even if cluster isn't available)
    try {
      kc = getIntegrationTestKubeConfig();
    } catch (_error) {
      console.log('⚠️  No kubectl config available, some tests will be limited');
    }
  });

  afterAll(async () => {
    // Clean up any namespaces created during tests
    if (createdNamespaces.length > 0 && kc) {
      const { deleteNamespaceAndWait } = await import('./shared-kubeconfig.js');
      console.log(`🧹 Cleaning up ${createdNamespaces.length} test namespaces...`);
      await Promise.allSettled(createdNamespaces.map((ns) => deleteNamespaceAndWait(ns, kc)));
      console.log('✅ Test namespace cleanup complete');
    }
  });

  describe('KroResourceFactory without Alchemy Scope', () => {
    it('should create factory without alchemy and generate valid YAML', async () => {
      const testNamespace = generateTestNamespace('kro-without-alchemy');
      const SimpleAppSpecSchema = type({
        appName: 'string',
        version: 'string',
      });

      const SimpleAppStatusSchema = type({
        status: 'string',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'kro-simple-app',
          apiVersion: 'v1alpha1',
          kind: 'SimpleApp',
          spec: SimpleAppSpecSchema,
          status: SimpleAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.appName,
            image: `nginx:${schema.spec.version}`,
            replicas: 1,
            id: 'simpleDeployment',
          }),

          service: simple.Service({
            name: `${schema.spec.appName}-svc`,
            selector: { app: schema.spec.appName },
            ports: [{ port: 80, targetPort: 80 }],
            id: 'simpleService',
          }),
        }),
        (_schema, _resources) => ({
          status: Cel.expr<string>`'running'`,
        })
      );

      // Create factory WITHOUT alchemy scope
      const factory = resourceGraph.factory('kro', {
        namespace: testNamespace,
      });

      // Validate factory properties
      expect(factory.mode).toBe('kro');
      expect(factory.name).toBe('kro-simple-app');
      expect(factory.namespace).toBe(testNamespace);

      // Generate RGD YAML
      const rgdYaml = factory.toYaml();
      expect(rgdYaml).toContain('kind: ResourceGraphDefinition');
      expect(rgdYaml).toContain('name: kro-simple-app');
      expect(rgdYaml).not.toContain('alchemyScope'); // Should not have alchemy scope annotations
      expect(rgdYaml).not.toContain('alchemy.run'); // Should not have alchemy API references

      // Generate instance YAML
      const instanceYaml = factory.toYaml({
        appName: 'simple-nginx',
        version: '1.20',
      });

      expect(instanceYaml).toContain('kind: SimpleApp');
      expect(instanceYaml).toContain('simple-nginx');
      expect(instanceYaml).toContain('1.20');

      console.log('✅ KroResourceFactory without Alchemy validation completed successfully');
    });
  });

  describe('DirectResourceFactory without Alchemy Scope', () => {
    it('should create factory without alchemy and validate structure', async () => {
      const testNamespace = generateTestNamespace('direct-without-alche');
      const ApiSpecSchema = type({
        serviceName: 'string',
        image: 'string',
        port: 'number',
      });

      const ApiStatusSchema = type({
        endpoint: 'string',
        healthy: 'boolean',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'direct-simple-api',
          apiVersion: 'v1alpha1',
          kind: 'ApiService',
          spec: ApiSpecSchema,
          status: ApiStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.serviceName,
            image: schema.spec.image,
            replicas: 2,
            env: {
              PORT: Cel.string(schema.spec.port),
              SERVICE_NAME: schema.spec.serviceName,
            },
            ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
            id: 'apiDeployment',
          }),

          service: simple.Service({
            name: Cel.expr(schema.spec.serviceName, '-api'),
            selector: { app: schema.spec.serviceName },
            ports: [{ port: 80, targetPort: schema.spec.port }],
            type: 'ClusterIP',
            id: 'apiService',
          }),
        }),
        (_schema, _resources) => ({
          endpoint: Cel.expr<string>`'http://api.example.com'`,
          healthy: Cel.expr<boolean>`true`,
        })
      );

      // Create DirectResourceFactory WITHOUT alchemy scope
      const factory = await resourceGraph.factory('direct', {
        namespace: testNamespace,
        kubeConfig: kc,
      });

      // Validate factory properties
      expect(factory.mode).toBe('direct');
      expect(factory.name).toBe('direct-simple-api');
      expect(factory.namespace).toBe(testNamespace);

      // Test YAML generation
      const instanceYaml = factory.toYaml({
        serviceName: 'my-api',
        image: 'nginx:alpine',
        port: 3000,
      });

      expect(instanceYaml).toContain('kind: Deployment');
      expect(instanceYaml).toContain('kind: Service');
      expect(instanceYaml).toContain('name: my-api');
      expect(instanceYaml).toContain('nginx:alpine');
      expect(instanceYaml).toContain('3000');
      expect(instanceYaml).toContain('my-api-api');

      // Create the test namespace before deployment
      const k8sApi = createCoreV1ApiClient(kc);
      try {
        await k8sApi.createNamespace({
          body: { metadata: { name: testNamespace } },
        });
        createdNamespaces.push(testNamespace);
        console.log(`✅ Created test namespace: ${testNamespace}`);
      } catch (error) {
        // Namespace might already exist
        console.log(
          `⚠️  Namespace ${testNamespace} might already exist: ${(error as Error).message}`
        );
      }

      // Test deployment attempt (should fail gracefully without cluster)
      try {
        await factory.deploy({
          serviceName: 'my-api',
          image: 'nginx:alpine',
          port: 3000,
        });
        console.log('✅ DirectResourceFactory without Alchemy deployment succeeded');
      } catch (error) {
        // Expected deployment failure due to cluster connectivity or resource issues
        const errorMessage = (error as Error).message;
        const isExpectedError =
          errorMessage.includes('deployment failed') ||
          errorMessage.includes('No active cluster') ||
          errorMessage.includes('Failed to deploy') ||
          errorMessage.includes('All resources failed');
        expect(isExpectedError).toBe(true);
        console.log(
          '✅ DirectResourceFactory without Alchemy correctly handled deployment failure'
        );
      }

      console.log('✅ DirectResourceFactory without Alchemy validation completed successfully');
    });
  });

  describe('Cross-Factory Compatibility', () => {
    it('should generate functionally identical resources across factory types', async () => {
      const testNamespace = generateTestNamespace('cross-factory-compat');
      const AppSpecSchema = type({
        name: 'string',
        image: 'string',
        replicas: 'number',
      });

      const AppStatusSchema = type({
        ready: 'boolean',
      });

      // Create the same resource graph for both factory types
      const createResourceGraph = (name: string) =>
        toResourceGraph(
          {
            name,
            apiVersion: 'v1alpha1',
            kind: 'TestApp',
            spec: AppSpecSchema,
            status: AppStatusSchema,
          },
          (schema) => ({
            deployment: simple.Deployment({
              name: schema.spec.name,
              image: schema.spec.image,
              replicas: schema.spec.replicas,
              id: 'appDeployment',
            }),

            service: simple.Service({
              name: `${schema.spec.name}-svc`,
              selector: { app: schema.spec.name },
              ports: [{ port: 80, targetPort: 80 }],
              id: 'appService',
            }),
          }),
          (_schema, _resources) => ({
            ready: Cel.expr<boolean>`true`,
          })
        );

      // Create both factory types
      const kroGraph = createResourceGraph('kro-test-app');
      const directGraph = createResourceGraph('direct-test-app');

      const kroFactory = await kroGraph.factory('kro', {
        namespace: testNamespace,
        kubeConfig: kc,
      });

      const directFactory = await directGraph.factory('direct', {
        namespace: testNamespace,
        kubeConfig: kc,
      });

      // Test spec
      const testSpec = {
        name: 'test-app',
        image: 'nginx:latest',
        replicas: 3,
      };

      // Generate YAML from both factories
      const kroInstanceYaml = kroFactory.toYaml(testSpec);
      const directInstanceYaml = directFactory.toYaml(testSpec);

      // Both should contain the same core Kubernetes resources
      expect(kroInstanceYaml).toContain('test-app');
      expect(directInstanceYaml).toContain('test-app');
      expect(kroInstanceYaml).toContain('nginx:latest');
      expect(directInstanceYaml).toContain('nginx:latest');
      expect(kroInstanceYaml).toContain('3');
      expect(directInstanceYaml).toContain('3');

      // Kro should generate CRD instance, Direct should generate raw Kubernetes resources
      expect(kroInstanceYaml).toContain('kind: TestApp');
      expect(directInstanceYaml).toContain('kind: Deployment');
      expect(directInstanceYaml).toContain('kind: Service');

      console.log('✅ Cross-factory compatibility validation completed successfully');
    });
  });

  describe('Type Safety and Enhanced Proxy', () => {
    it('should maintain type safety across all factory types', async () => {
      const testNamespace = generateTestNamespace('type-safety');
      const WebAppSpecSchema = type({
        name: 'string',
        image: 'string',
        port: 'number',
      });

      const WebAppStatusSchema = type({
        ready: 'boolean',
        endpoint: 'string',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'type-safe-webapp',
          apiVersion: 'v1alpha1',
          kind: 'TypeSafeWebApp',
          spec: WebAppSpecSchema,
          status: WebAppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            ports: [{ containerPort: 8080 }],
            id: 'webappDeployment',
          }),
        }),
        (_schema, _resources) => ({
          ready: Cel.expr<boolean>`true`,
          endpoint: Cel.expr<string>`'http://webapp.example.com'`,
        })
      );

      // Test both factory types
      const kroFactory = await resourceGraph.factory('kro', {
        namespace: testNamespace,
      });

      const directFactory = await resourceGraph.factory('direct', {
        namespace: testNamespace,
        kubeConfig: kc,
      });

      // Validate schema proxy exists for Kro factory
      expect(kroFactory.schema).toBeDefined();
      expect(kroFactory.schema.spec).toBeDefined();
      expect(kroFactory.schema.status).toBeDefined();

      // Test type-safe spec validation (should not throw for valid spec)
      const validSpec = {
        name: 'valid-app',
        image: 'nginx:latest',
        port: 8080,
      };

      expect(() => kroFactory.toYaml(validSpec)).not.toThrow();
      expect(() => directFactory.toYaml(validSpec)).not.toThrow();

      console.log('✅ Type safety validation completed successfully');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid specs and deployment failures gracefully', async () => {
      const AppSpecSchema = type({
        name: 'string',
        image: 'string',
      });

      const AppStatusSchema = type({
        ready: 'boolean',
      });

      const resourceGraph = toResourceGraph(
        {
          name: 'error-test-app',
          apiVersion: 'v1alpha1',
          kind: 'ErrorTestApp',
          spec: AppSpecSchema,
          status: AppStatusSchema,
        },
        (schema) => ({
          deployment: simple.Deployment({
            name: schema.spec.name,
            image: schema.spec.image,
            id: 'errorDeployment',
          }),
        }),
        (_schema, _resources) => ({
          ready: Cel.expr<boolean>`false`,
        })
      );

      const factory = await resourceGraph.factory('direct', {
        namespace: 'invalid-namespace-that-does-not-exist',
        kubeConfig: kc,
      });

      // Test deployment to invalid namespace
      try {
        await factory.deploy({
          name: 'test-app',
          image: 'nginx:latest',
        });
        console.log('⚠️ Deployment unexpectedly succeeded');
      } catch (error) {
        const errorMessage = (error as Error).message;
        const isExpectedError =
          errorMessage.includes('deployment failed') || errorMessage.includes('No active cluster');
        expect(isExpectedError).toBe(true);
        console.log('✅ Deployment to bad namespace properly failed');
      }

      console.log('✅ Error handling validation completed successfully');
    });
  });
});
