/**
 * Test suite for DirectTypeKroDeployer
 *
 * This tests the alchemy deployment integration with readiness evaluator lookup from registry.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DirectTypeKroDeployer } from '../../src/alchemy/deployers.js';
import { ReadinessEvaluatorRegistry } from '../../src/core/readiness/registry.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('DirectTypeKroDeployer', () => {
  // Mock DirectDeploymentEngine following established patterns
  const createMockEngine = () => {
    const mockEngine = {
      deploy: mock(() =>
        Promise.resolve({
          status: 'success',
          deployedResources: [],
          duration: 100,
          errors: [],
        })
      ),
      deleteResource: mock(() => Promise.resolve()),
      k8sApi: {
        create: mock(() => Promise.resolve({ body: {} })),
        read: mock(() => Promise.resolve({ body: {} })),
        delete: mock(() => Promise.resolve({ body: {} })),
        patch: mock(() => Promise.resolve({ body: {} })),
      },
    } as any;

    return mockEngine;
  };

  // Helper to create test resources
  const createTestDeployment = (name: string, replicas: number = 2) =>
    deployment({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: 'default' },
      spec: {
        replicas,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: { containers: [{ name: 'app', image: 'nginx:alpine' }] },
        },
      },
    });

  const createTestService = (name: string) =>
    service({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: 'default' },
      spec: {
        selector: { app: name },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    });

  describe('Readiness Evaluator Registry Lookup', () => {
    let mockEngine: any;

    beforeEach(() => {
      mockEngine = createMockEngine();
      // Create deployer to ensure it's properly initialized
      new DirectTypeKroDeployer(mockEngine);
    });

    it('should use readiness evaluator from factory-created resources', () => {
      const testDeployment = createTestDeployment('test-app', 3);

      // Factory-created resources should already have readiness evaluators attached
      expect(typeof (testDeployment as any).readinessEvaluator).toBe('function');

      // The evaluator should work correctly
      const evaluator = (testDeployment as any).readinessEvaluator;
      const readyResult = evaluator({
        status: {
          readyReplicas: 3,
          availableReplicas: 3,
          updatedReplicas: 3,
          replicas: 3,
        },
      });

      expect(readyResult.ready).toBe(true);
    });

    it('should have evaluators registered in the global registry by kind', () => {
      // Create a deployment to trigger registration
      createTestDeployment('registry-test', 2);

      // Check that the registry has an evaluator for Deployment kind
      const registry = ReadinessEvaluatorRegistry.getInstance();
      expect(registry.hasEvaluatorForKind('Deployment')).toBe(true);

      const evaluator = registry.getEvaluatorForKind('Deployment');
      expect(evaluator).not.toBeNull();
      expect(typeof evaluator).toBe('function');
    });

    it('should have Service evaluators registered in the registry', () => {
      // Create a service to trigger registration
      createTestService('registry-service-test');

      const registry = ReadinessEvaluatorRegistry.getInstance();
      expect(registry.hasEvaluatorForKind('Service')).toBe(true);

      const evaluator = registry.getEvaluatorForKind('Service');
      expect(evaluator).not.toBeNull();
    });

    it('should evaluate Deployment readiness correctly via registry evaluator', () => {
      createTestDeployment('eval-test', 3);

      const registry = ReadinessEvaluatorRegistry.getInstance();
      const evaluator = registry.getEvaluatorForKind('Deployment');

      // Test ready condition
      const readyResult = evaluator!({
        status: {
          readyReplicas: 3,
          availableReplicas: 3,
          updatedReplicas: 3,
          replicas: 3,
        },
      });
      expect(readyResult.ready).toBe(true);

      // Test not ready condition
      const notReadyResult = evaluator!({
        status: {
          readyReplicas: 1,
          availableReplicas: 2,
          updatedReplicas: 3,
          replicas: 3,
        },
      });
      expect(notReadyResult.ready).toBe(false);
    });

    it('should handle missing status gracefully', () => {
      createTestDeployment('missing-status-test', 2);

      const registry = ReadinessEvaluatorRegistry.getInstance();
      const evaluator = registry.getEvaluatorForKind('Deployment');

      // Test with null status
      const nullStatusResult = evaluator!({ status: null });
      expect(nullStatusResult.ready).toBe(false);

      // Test with undefined status
      const undefinedStatusResult = evaluator!({ status: undefined });
      expect(undefinedStatusResult.ready).toBe(false);

      // Test with missing status entirely
      const noStatusResult = evaluator!({});
      expect(noStatusResult.ready).toBe(false);
    });
  });

  describe('Deployment Integration', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should integrate with DirectDeploymentEngine properly', () => {
      expect(deployer).toBeDefined();
      expect(deployer).toBeInstanceOf(DirectTypeKroDeployer);
    });

    it('should preserve resource identity during deployment', async () => {
      const originalDeployment = createTestDeployment('identity-test', 4);
      const originalMetadata = originalDeployment.metadata;
      const originalSpec = originalDeployment.spec;

      // Deploy the resource
      const result = await deployer.deploy(originalDeployment, {
        mode: 'direct',
        namespace: 'default',
        waitForReady: false,
      });

      // Verify core resource properties are maintained
      expect(result.apiVersion).toBe(originalDeployment.apiVersion);
      expect(result.kind).toBe(originalDeployment.kind);
      expect(result.metadata).toEqual(originalMetadata);
      expect(result.spec).toEqual(originalSpec);

      // Verify the readiness evaluator is properly attached
      expect((result as any).readinessEvaluator).toBeDefined();
      expect(typeof (result as any).readinessEvaluator).toBe('function');
    });

    it('should call engine.deploy with correct resource graph', async () => {
      const testDeployment = createTestDeployment('engine-test', 2);

      await deployer.deploy(testDeployment, {
        mode: 'direct',
        namespace: 'test-ns',
        waitForReady: false,
      });

      // Verify engine.deploy was called
      expect(mockEngine.deploy).toHaveBeenCalled();

      // Get the call arguments
      const callArgs = mockEngine.deploy.mock.calls[0];
      const resourceGraph = callArgs[0];
      const options = callArgs[1];

      // Verify resource graph structure
      expect(resourceGraph.resources).toHaveLength(1);
      expect(resourceGraph.resources[0].manifest.kind).toBe('Deployment');
      expect(resourceGraph.resources[0].manifest.metadata.name).toBe('engine-test');

      // Verify options
      expect(options.namespace).toBe('test-ns');
    });
  });

  describe('Error Handling', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should throw ResourceDeploymentError on deployment failure', async () => {
      // Configure mock to return failure
      mockEngine.deploy.mockImplementation(() =>
        Promise.resolve({
          status: 'failed',
          errors: [{ error: new Error('Deployment failed') }],
          deployedResources: [],
          duration: 100,
        })
      );

      const testDeployment = createTestDeployment('error-test', 2);

      await expect(
        deployer.deploy(testDeployment, { mode: 'direct', namespace: 'default', waitForReady: false })
      ).rejects.toThrow('Deployment failed');
    });

    it('should handle multiple errors in deployment failure', async () => {
      mockEngine.deploy.mockImplementation(() =>
        Promise.resolve({
          status: 'failed',
          errors: [
            { error: new Error('First error') },
            { error: new Error('Second error') },
            { error: new Error('Third error') },
          ],
          deployedResources: [],
          duration: 100,
        })
      );

      const testDeployment = createTestDeployment('multi-error-test', 2);

      try {
        await deployer.deploy(testDeployment, { mode: 'direct', namespace: 'default', waitForReady: false });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('First error');
        expect(error.message).toContain('2 other errors');
      }
    });
  });

  describe('Delete Operations', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should call engine.deleteResource with correct parameters', async () => {
      const testDeployment = createTestDeployment('delete-test', 2);

      await deployer.delete(testDeployment, { mode: 'direct', namespace: 'test-ns' });

      expect(mockEngine.deleteResource).toHaveBeenCalled();

      const callArgs = mockEngine.deleteResource.mock.calls[0];
      const deployedResource = callArgs[0];

      expect(deployedResource.kind).toBe('Deployment');
      expect(deployedResource.name).toBe('delete-test');
      expect(deployedResource.namespace).toBe('test-ns');
    });

    it('should use resource namespace if options namespace not provided', async () => {
      const testDeployment = createTestDeployment('ns-test', 2);

      await deployer.delete(testDeployment, { mode: 'direct' });

      const callArgs = mockEngine.deleteResource.mock.calls[0];
      const deployedResource = callArgs[0];

      // Should fall back to resource metadata namespace
      expect(deployedResource.namespace).toBe('default');
    });
  });

  describe('TypeKroDeployer Interface Compliance', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should implement the TypeKroDeployer interface', () => {
      expect(deployer).toBeDefined();
      expect(deployer.constructor.name).toBe('DirectTypeKroDeployer');
      expect(typeof deployer.deploy).toBe('function');
      expect(typeof deployer.delete).toBe('function');
    });

    it('should work with different resource types', async () => {
      const serviceResource = createTestService('test-service');

      // Should handle Service resources
      const result = await deployer.deploy(serviceResource, {
        mode: 'direct',
        namespace: 'default',
        waitForReady: false,
      });

      expect(result.kind).toBe('Service');
      expect((result as any).readinessEvaluator).toBeDefined();
    });
  });
});
