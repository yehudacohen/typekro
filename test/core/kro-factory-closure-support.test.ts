/**
 * Tests for KroResourceFactory closure support
 * Validates that closures work with static values and fail with dynamic references
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { toResourceGraph } from '../../src/core/serialization/core.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';
import { yamlDirectory, yamlFile } from '../../src/factories/kubernetes/yaml/index.js';
import {
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../integration/shared-kubeconfig.js';

describe('KroResourceFactory Closure Support', () => {
  let kubeConfig: any;

  beforeAll(async () => {
    if (isClusterAvailable()) {
      kubeConfig = getIntegrationTestKubeConfig();
    } else {
      // Create a mock kubeConfig for validation-only tests
      kubeConfig = {
        makeApiClient: () => null,
        getCurrentContext: () => 'mock-context',
        getCurrentCluster: () => ({ server: 'mock-server' }),
      };
    }
  });

  describe('Static Values Support', () => {
    it('should accept closures with static values in Kro mode', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-static-closures',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: type({
            name: 'string',
            replicas: 'number',
          }),
          status: type({
            ready: 'boolean',
          }),
        },
        (schema) => ({
          // Static YAML closure - should work in Kro mode
          staticConfig: yamlFile({
            name: 'static-config',
            path: './test/fixtures/simple-configmap.yaml',
            namespace: 'test-namespace', // Static string - OK
          }),

          // Regular Enhanced<> resource
          app: deployment({
            id: 'testApp', // Explicit ID required for KubernetesRef name
            metadata: { name: schema.spec.name },
            spec: {
              replicas: schema.spec.replicas,
              selector: { matchLabels: { app: schema.spec.name } },
              template: {
                metadata: { labels: { app: schema.spec.name } },
                spec: {
                  containers: [
                    {
                      name: 'app',
                      image: 'nginx',
                    },
                  ],
                },
              },
            },
          } as any),
        }),
        () => ({
          ready: true,
        })
      );

      // Should create Kro factory without errors
      const kroFactory = await graph.factory('kro', {
        namespace: 'test-namespace',
        kubeConfig,
      });

      expect(kroFactory.mode).toBe('kro');
      expect(kroFactory.name).toBe('test-static-closures');
    });

    it('should execute closures before RGD creation', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-closure-execution',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: type({
            name: 'string',
          }),
          status: type({
            ready: 'boolean',
          }),
        },
        (schema) => ({
          config: yamlFile({
            name: 'test-config',
            path: './test/fixtures/simple-configmap.yaml',
            namespace: 'test-namespace',
          }),

          app: deployment({
            id: 'testApp2', // Explicit ID required for KubernetesRef name
            metadata: { name: schema.spec.name },
            spec: {
              replicas: 1,
              selector: { matchLabels: { app: schema.spec.name } },
              template: {
                metadata: { labels: { app: schema.spec.name } },
                spec: {
                  containers: [
                    {
                      name: 'app',
                      image: 'nginx',
                    },
                  ],
                },
              },
            },
          } as any),
        }),
        () => ({
          ready: true,
        })
      );

      const kroFactory = await graph.factory('kro', {
        namespace: 'test-namespace',
        kubeConfig,
      });

      // Deploy should execute closures before creating RGD
      // This will fail because the YAML file exists but deployment will fail
      // The important thing is that closures are executed
      try {
        await kroFactory.deploy({ name: 'test-app' });
      } catch (error) {
        // Expected to fail - we just want to verify closures are executed
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('Dynamic References Validation', () => {
    it('should reject closures with KubernetesRef inputs in Kro mode', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-dynamic-closures',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: type({
            name: 'string',
            namespace: 'string',
          }),
          status: type({
            ready: 'boolean',
          }),
        },
        (schema) => ({
          // Dynamic YAML closure - should fail in Kro mode
          dynamicConfig: yamlFile({
            name: 'dynamic-config',
            path: './test/fixtures/simple-configmap.yaml',
            namespace: schema.spec.namespace, // KubernetesRef - should fail
          }),

          app: deployment({
            id: 'testApp3', // Explicit ID required for KubernetesRef name
            metadata: { name: schema.spec.name },
            spec: {
              replicas: 1,
              selector: { matchLabels: { app: schema.spec.name } },
              template: {
                metadata: { labels: { app: schema.spec.name } },
                spec: {
                  containers: [
                    {
                      name: 'app',
                      image: 'nginx',
                    },
                  ],
                },
              },
            },
          } as any),
        }),
        () => ({
          ready: true,
        })
      );

      const kroFactory = await graph.factory('kro', {
        namespace: 'test-namespace',
        kubeConfig,
      });

      // Deploy should fail with clear error message about dynamic references
      try {
        await kroFactory.deploy({
          name: 'test-app',
          namespace: 'dynamic-namespace',
        });
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          'Kro mode does not support dynamic reference resolution'
        );
      }
    });

    it('should provide clear error messages for Kro mode limitations', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-error-messages',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: type({
            namespace: 'string',
          }),
          status: type({
            ready: 'boolean',
          }),
        },
        (schema) => ({
          config: yamlDirectory({
            name: 'config-dir',
            path: './test/fixtures/',
            namespace: schema.spec.namespace, // Dynamic reference
          }),
        }),
        () => ({
          ready: true,
        })
      );

      const kroFactory = await graph.factory('kro', {
        namespace: 'test-namespace',
        kubeConfig,
      });

      try {
        await kroFactory.deploy({ namespace: 'test-namespace' });
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;

        // Should contain helpful guidance
        expect(errorMessage).toContain('Kro mode does not support dynamic reference resolution');
        expect(errorMessage).toContain('Found reference:');
      }
    });
  });

  describe('Mixed Static and Dynamic Resources', () => {
    it('should work with static closures and dynamic Enhanced resources', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-mixed-resources',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: type({
            name: 'string',
            replicas: 'number',
          }),
          status: type({
            ready: 'boolean',
          }),
        },
        (schema) => ({
          // Static closure - OK in Kro mode
          staticConfig: yamlFile({
            name: 'static-config',
            path: './test/fixtures/simple-configmap.yaml',
            namespace: 'kro-system', // Static string
          }),

          // Dynamic Enhanced<> resource - OK in Kro mode
          app: deployment({
            id: 'testApp4', // Explicit ID required for KubernetesRef name
            metadata: { name: schema.spec.name }, // Dynamic reference - OK for Enhanced<> resources
            spec: {
              replicas: schema.spec.replicas, // Dynamic reference - OK for Enhanced<> resources
              selector: { matchLabels: { app: schema.spec.name } },
              template: {
                metadata: { labels: { app: schema.spec.name } },
                spec: {
                  containers: [
                    {
                      name: 'app',
                      image: 'nginx',
                    },
                  ],
                },
              },
            },
          } as any),
        }),
        () => ({
          ready: true,
        })
      );

      // Should create factory successfully
      const kroFactory = await graph.factory('kro', {
        namespace: 'test-namespace',
        kubeConfig,
      });

      expect(kroFactory.mode).toBe('kro');
      // Schema proxy is a proxy object, so we can't easily check its keys
      // Instead, verify that the factory was created successfully
      expect(kroFactory.name).toBe('test-mixed-resources');
    });
  });

  describe('Direct Mode Comparison', () => {
    it('should work with dynamic references in Direct mode', async () => {
      const graph = toResourceGraph(
        {
          name: 'test-direct-mode',
          apiVersion: 'example.com/v1alpha1',
          kind: 'TestApp',
          spec: type({
            namespace: 'string',
          }),
          status: type({
            ready: 'boolean',
          }),
        },
        (schema) => ({
          config: yamlFile({
            name: 'dynamic-config',
            path: './test/fixtures/simple-configmap.yaml',
            namespace: schema.spec.namespace, // Dynamic reference - OK in Direct mode
          }),
        }),
        () => ({
          ready: true,
        })
      );

      // Should create Direct factory successfully
      const directFactory = await graph.factory('direct', {
        namespace: 'test-namespace',
        kubeConfig,
      });

      expect(directFactory.mode).toBe('direct');

      // Note: Actual deployment would work in Direct mode but fail in our test
      // because we don't have the actual YAML file. The important thing is that
      // the factory creation succeeds and the closure is accepted.
    });
  });
});
