/**
 * Unit tests for deployment strategy error handling
 *
 * These tests validate error handling behavior using proper mocks,
 * without hitting real Kubernetes clusters.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { DirectDeploymentStrategy, KroDeploymentStrategy,  } from '../../src/core/deployment/deployment-strategies.js';

describe('Deployment Strategy Error Handling (Unit Tests)', () => {
  let mockDeploymentEngine: any;
  let mockResourceResolver: any;

  beforeEach(() => {
    // Create proper mocks that don't hit real clusters
    mockDeploymentEngine = {
      deploy: async (resourceGraph: any, options: any) => {
        // Simulate different failure scenarios based on resource names
        const failingResources = resourceGraph.resources.filter((r: any) =>
          r.manifest.metadata?.name?.includes('failing')
        );

        if (failingResources.length > 0) {
          throw new Error(
            `Mock deployment failure for ${failingResources[0].manifest.metadata.name}`
          );
        }

        return {
          deploymentId: `mock-deployment-${Date.now()}`,
          resources: resourceGraph.resources.map((resource: any) => ({
            id: resource.id,
            kind: resource.manifest.kind,
            name: resource.manifest.metadata?.name,
            namespace: options.namespace,
            manifest: resource.manifest,
            status: 'deployed',
            deployedAt: new Date(),
          })),
          dependencyGraph: resourceGraph.dependencyGraph,
          duration: 100,
          status: 'success',
          errors: [],
        };
      },
      deployResource: async (resource: any, options: any) => {
        if (resource.metadata?.name?.includes('failing')) {
          throw new Error(`Mock deployment failure for ${resource.metadata.name}`);
        }

        return {
          ...resource,
          metadata: {
            ...resource.metadata,
            namespace: options.namespace,
          },
        };
      },
    };

    mockResourceResolver = {
      createResourceGraphForInstance: (spec: any, instanceName: string) => ({
        resources: [
          {
            id: 'test-resource',
            manifest: {
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: {
                name: spec.name || instanceName,
                namespace: 'test-namespace',
              },
              data: { test: 'data' },
            },
          },
        ],
        dependencyGraph: {
          nodes: ['test-resource'],
          edges: [],
        },
      }),
    };
  });

  describe('DirectDeploymentStrategy', () => {
    it('should handle deployment failures gracefully', async () => {
      const strategy = new DirectDeploymentStrategy(
        'test-factory',
        'test-namespace',
        {
          apiVersion: 'v1alpha1',
          kind: 'TestApp',
          spec: type({ name: 'string' }),
          status: type({ status: 'string' }),
        },
        undefined, // statusBuilder
        undefined, // resourceKeys
        {}, // factoryOptions
        mockDeploymentEngine,
        mockResourceResolver
      );

      // Test successful deployment
      const successResult = await strategy.deploy({ name: 'success-app' });
      expect(successResult).toBeDefined();
      expect(successResult.metadata?.name).toBe('success-app');

      // Test failed deployment
      await expect(strategy.deploy({ name: 'failing-app' })).rejects.toThrow(
        'Mock deployment failure'
      );
    });
  });

  describe('KroDeploymentStrategy', () => {
    it('should handle RGD deployment failures', async () => {
      // Mock the deployment engine to handle both RGD and custom resource deployment
      const mockKroEngine = {
        ...mockDeploymentEngine,
        deployResource: async (resource: any, options: any) => {
          // Simulate successful deployment for both RGD and custom resources
          return {
            ...resource,
            metadata: {
              ...resource.metadata,
              namespace: options.namespace,
            },
            status: 'deployed',
            deployedAt: new Date(),
          };
        },
        // Add the getKubernetesApi method that KroDeploymentStrategy needs
        getKubernetesApi: () => ({
          read: async (resource: any) => ({
            body: {
              ...resource,
              status: {
                state: 'ACTIVE',
                conditions: [
                  { type: 'InstanceSynced', status: 'True', reason: 'AllResourcesReady' },
                ],
                // Add custom status fields to make the readiness check pass
                customField: 'ready',
                url: 'http://test-app.example.com',
              },
            },
          }),
        }),
        // Keep the k8sApi property for backward compatibility
        k8sApi: {
          read: async (resource: any) => ({
            body: {
              ...resource,
              status: {
                state: 'ACTIVE',
                conditions: [
                  { type: 'InstanceSynced', status: 'True', reason: 'AllResourcesReady' },
                ],
                // Add custom status fields to make the readiness check pass
                customField: 'ready',
                url: 'http://test-app.example.com',
              },
            },
          }),
        },
      };

      const strategy = new KroDeploymentStrategy(
        'test-kro-factory',
        'test-namespace',
        {
          apiVersion: 'v1alpha1',
          kind: 'TestKroApp',
          spec: type({ name: 'string' }),
          status: type({ status: 'string' }),
        },
        {}, // factoryOptions
        mockKroEngine,
        {}, // resources
        {} // statusMappings
      );

      // Test that the strategy properly handles the two-step deployment
      const result = await strategy.deploy({ name: 'test-app' });
      expect(result).toBeDefined();
    });

    it('should handle RGD deployment failures gracefully', async () => {
      // Mock the deployment engine to fail on RGD deployment
      const failingKroEngine = {
        ...mockDeploymentEngine,
        deployResource: async (resource: any, _options: any) => {
          if (resource.kind === 'ResourceGraphDefinition') {
            throw new Error('Mock RGD deployment failure');
          }
          return {
            ...resource,
            status: 'deployed',
            deployedAt: new Date(),
          };
        },
        // Add the getKubernetesApi method that KroDeploymentStrategy needs
        getKubernetesApi: () => ({
          read: async (resource: any) => ({
            body: {
              ...resource,
              status: {
                state: 'ACTIVE',
                conditions: [
                  { type: 'InstanceSynced', status: 'True', reason: 'AllResourcesReady' },
                ],
              },
            },
          }),
        }),
      };

      const strategy = new KroDeploymentStrategy(
        'failing-kro-factory',
        'test-namespace',
        {
          apiVersion: 'v1alpha1',
          kind: 'FailingKroApp',
          spec: type({ name: 'string' }),
          status: type({ status: 'string' }),
        },
        {}, // factoryOptions
        failingKroEngine,
        {}, // resources
        {} // statusMappings
      );

      // Test that RGD deployment failures are handled properly
      await expect(strategy.deploy({ name: 'test-app' })).rejects.toThrow(
        'Mock RGD deployment failure'
      );
    });
  });

  describe('Error Context', () => {
    it('should provide detailed error context for debugging', async () => {
      const strategy = new DirectDeploymentStrategy(
        'error-context-factory',
        'test-namespace',
        {
          apiVersion: 'v1alpha1',
          kind: 'ErrorTestApp',
          spec: type({ name: 'string' }),
          status: type({ status: 'string' }),
        },
        undefined, // statusBuilder
        undefined, // resourceKeys
        {}, // factoryOptions
        mockDeploymentEngine,
        mockResourceResolver
      );

      try {
        await strategy.deploy({ name: 'failing-resource' });
        expect.unreachable('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('failing-resource');
      }
    });
  });
});
