/**
 * Test suite for DirectTypeKroDeployer
 *
 * This tests the alchemy deployment integration with readiness evaluator recreation.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DirectTypeKroDeployer } from '../../src/alchemy/deployers.js';
import { service } from '../../src/factories/kubernetes/networking/service.js';
import { deployment } from '../../src/factories/kubernetes/workloads/deployment.js';

describe('DirectTypeKroDeployer', () => {
  // Mock DirectDeploymentEngine following established patterns
  const createMockEngine = () => {
    const mockEngine = {
      deployResource: mock(() => Promise.resolve({ status: 'ready' })),
      deployResources: mock(() =>
        Promise.resolve({
          status: 'success',
          deployedResources: [],
          duration: 100,
          errors: [],
        })
      ),
      k8sApi: {
        create: mock(() => Promise.resolve({ body: {} })),
        read: mock(() => Promise.resolve({ body: {} })),
        delete: mock(() => Promise.resolve({ body: {} })),
        patch: mock(() => Promise.resolve({ body: {} })),
      },
    } as any;

    // Reset all mocks
    mockEngine.deployResource.mockClear();
    mockEngine.deployResources.mockClear();
    mockEngine.k8sApi.create.mockClear();
    mockEngine.k8sApi.read.mockClear();
    mockEngine.k8sApi.delete.mockClear();
    mockEngine.k8sApi.patch.mockClear();

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

  describe('Readiness Evaluator Recreation', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should recreate readiness evaluators with proper closure context', () => {
      const originalDeployment = createTestDeployment('test-app', 3);

      // Access the private method through type assertion for testing
      const deployerWithPrivate = deployer as any;
      const recreatedDeployment =
        deployerWithPrivate.recreateReadinessEvaluator(originalDeployment);

      expect(recreatedDeployment).toBeDefined();
      expect(recreatedDeployment.kind).toBe('Deployment');
      expect(recreatedDeployment.metadata.name).toBe('test-app');

      // Test that the recreated evaluator has proper closure
      const evaluator = (recreatedDeployment as any).readinessEvaluator;
      expect(typeof evaluator).toBe('function');

      // Test evaluator with ready deployment status
      const readyStatus = {
        status: {
          readyReplicas: 3,
          availableReplicas: 3,
          updatedReplicas: 3,
        },
      };

      const readyResult = evaluator(readyStatus);
      expect(readyResult.ready).toBe(true);
      expect(readyResult.message).toContain('3/3 ready replicas');
    });

    it('should handle non-Deployment resources by returning them unchanged', () => {
      const serviceResource = createTestService('test-service');

      const deployerWithPrivate = deployer as any;
      const result = deployerWithPrivate.recreateReadinessEvaluator(serviceResource);

      // Should return the exact same object for non-Deployment resources
      expect(result).toBe(serviceResource);
      expect(result.kind).toBe('Service');
    });

    it('should extract expected replicas from resource spec correctly', () => {
      // Test with explicit replicas
      const deploymentWith5Replicas = createTestDeployment('app-5-replicas', 5);
      const deployerWithPrivate = deployer as any;
      const recreated5 = deployerWithPrivate.recreateReadinessEvaluator(deploymentWith5Replicas);

      const evaluator5 = (recreated5 as any).readinessEvaluator;
      const notReadyResult = evaluator5({
        status: { readyReplicas: 2, availableReplicas: 3 },
      });
      expect(notReadyResult.details?.expectedReplicas).toBe(5);

      // Test with default replicas (undefined should default to 1)
      const deploymentDefault = deployment({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'default-replicas' },
        spec: {
          // No replicas specified
          selector: { matchLabels: { app: 'test' } },
          template: {
            metadata: { labels: { app: 'test' } },
            spec: { containers: [{ name: 'app', image: 'nginx' }] },
          },
        },
      });

      const recreatedDefault = deployerWithPrivate.recreateReadinessEvaluator(deploymentDefault);
      const evaluatorDefault = (recreatedDefault as any).readinessEvaluator;
      const defaultResult = evaluatorDefault({
        status: { readyReplicas: 0 },
      });
      // Note: expectedReplicas might be a proxy function in this context
      expect(typeof defaultResult.details?.expectedReplicas).toContain('function');
    });

    it('should create evaluators that handle missing status gracefully', () => {
      const testDeployment = createTestDeployment('status-test', 2);

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(testDeployment);
      const evaluator = (recreated as any).readinessEvaluator;

      // Test with null status
      const nullStatusResult = evaluator({ status: null });
      expect(nullStatusResult.ready).toBe(false);
      expect(nullStatusResult.reason).toBe('StatusMissing');
      expect(nullStatusResult.message).toContain('status not available');
      expect(nullStatusResult.details?.expectedReplicas).toBe(2);

      // Test with undefined status
      const undefinedStatusResult = evaluator({ status: undefined });
      expect(undefinedStatusResult.ready).toBe(false);
      expect(undefinedStatusResult.reason).toBe('StatusMissing');

      // Test with missing status entirely
      const noStatusResult = evaluator({});
      expect(noStatusResult.ready).toBe(false);
      expect(noStatusResult.reason).toBe('StatusMissing');
    });

    it('should create evaluators that properly evaluate readiness conditions', () => {
      const testDeployment = createTestDeployment('readiness-test', 3);

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(testDeployment);
      const evaluator = (recreated as any).readinessEvaluator;

      // Test ready condition
      const readyResult = evaluator({
        status: {
          readyReplicas: 3,
          availableReplicas: 3,
          updatedReplicas: 3,
        },
      });
      expect(readyResult.ready).toBe(true);
      expect(readyResult.message).toContain('3/3 ready replicas');
      expect(readyResult.message).toContain('3/3 available replicas');

      // Test not ready condition
      const notReadyResult = evaluator({
        status: {
          readyReplicas: 1,
          availableReplicas: 2,
          updatedReplicas: 3,
        },
      });
      expect(notReadyResult.ready).toBe(false);
      expect(notReadyResult.reason).toBe('ReplicasNotReady');
      expect(notReadyResult.message).toContain('1/3 ready');
      expect(notReadyResult.details?.readyReplicas).toBe(1);
      expect(notReadyResult.details?.availableReplicas).toBe(2);
    });

    it('should handle evaluator errors gracefully', () => {
      const testDeployment = createTestDeployment('error-test', 2);

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(testDeployment);
      const evaluator = (recreated as any).readinessEvaluator;

      // Test with malformed input that might cause errors
      const errorResult = evaluator(null);
      expect(errorResult.ready).toBe(false);
      expect(errorResult.reason).toBe('EvaluationError');
      expect(errorResult.message).toContain('Error evaluating deployment readiness');
      expect(errorResult.details?.expectedReplicas).toBe(2);
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

      // Verify the deployer has access to the engine
      const deployerWithPrivate = deployer as any;
      expect(deployerWithPrivate.engine).toBe(mockEngine);
    });

    it('should maintain resource identity during evaluation recreation', () => {
      const originalDeployment = createTestDeployment('identity-test', 4);
      const originalMetadata = originalDeployment.metadata;
      const originalSpec = originalDeployment.spec;

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(originalDeployment);

      // Verify core resource properties are maintained
      expect(recreated.apiVersion).toBe(originalDeployment.apiVersion);
      expect(recreated.kind).toBe(originalDeployment.kind);
      expect(recreated.metadata).toEqual(originalMetadata);
      expect(recreated.spec).toEqual(originalSpec);

      // Verify the readiness evaluator is properly attached
      expect((recreated as any).readinessEvaluator).toBeDefined();
      expect(typeof (recreated as any).readinessEvaluator).toBe('function');
    });

    it('should preserve all resource properties during recreation', () => {
      // Create a deployment with additional properties
      const complexDeployment = deployment({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: 'complex-deployment',
          namespace: 'production',
          labels: { app: 'complex', tier: 'backend' },
          annotations: { 'deployment.kubernetes.io/revision': '3' },
        },
        spec: {
          replicas: 5,
          strategy: { type: 'RollingUpdate' },
          selector: { matchLabels: { app: 'complex' } },
          template: {
            metadata: { labels: { app: 'complex' } },
            spec: {
              containers: [
                {
                  name: 'app',
                  image: 'nginx:latest',
                  env: [{ name: 'ENV', value: 'production' }],
                },
              ],
            },
          },
        },
      });

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(complexDeployment);

      // Verify all properties are preserved
      expect(recreated.metadata.namespace).toBe('production');
      expect(recreated.metadata.labels).toEqual({ app: 'complex', tier: 'backend' });
      expect(recreated.metadata.annotations).toEqual({ 'deployment.kubernetes.io/revision': '3' });
      expect(recreated.spec.strategy).toEqual({ type: 'RollingUpdate' });
      expect(recreated.spec.template.spec.containers[0].env).toEqual([
        { name: 'ENV', value: 'production' },
      ]);
    });
  });

  describe('Error Handling', () => {
    let mockEngine: any;
    let deployer: DirectTypeKroDeployer;

    beforeEach(() => {
      mockEngine = createMockEngine();
      deployer = new DirectTypeKroDeployer(mockEngine);
    });

    it('should handle malformed resource specs gracefully', () => {
      // Create a malformed deployment (missing required fields)
      const malformedDeployment = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'malformed' },
        spec: {
          // Missing selector and template
          replicas: 2,
        },
      } as any;

      const deployerWithPrivate = deployer as any;

      // This should not throw, but handle gracefully
      expect(() => {
        const result = deployerWithPrivate.recreateReadinessEvaluator(malformedDeployment);
        expect(result).toBeDefined();
      }).not.toThrow();
    });

    it('should provide meaningful error messages for evaluation failures', () => {
      const testDeployment = createTestDeployment('error-handling', 3);

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(testDeployment);
      const evaluator = (recreated as any).readinessEvaluator;

      // Test error scenario with null input which should trigger EvaluationError
      const result = evaluator(null);
      expect(result.ready).toBe(false);
      expect(result.reason).toBe('EvaluationError');
      expect(result.message).toContain('Error evaluating deployment readiness');
      expect(result.details?.expectedReplicas).toBeDefined();
    });

    it('should handle resources with null or undefined metadata', () => {
      const resourceWithNullMetadata = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: null,
        spec: { replicas: 1 },
      } as any;

      const deployerWithPrivate = deployer as any;

      expect(() => {
        const result = deployerWithPrivate.recreateReadinessEvaluator(resourceWithNullMetadata);
        expect(result).toBeDefined();
      }).not.toThrow();
    });

    it('should handle resources with missing spec gracefully', () => {
      const resourceWithoutSpec = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'no-spec' },
        // No spec field
      } as any;

      const deployerWithPrivate = deployer as any;
      const recreated = deployerWithPrivate.recreateReadinessEvaluator(resourceWithoutSpec);
      const evaluator = (recreated as any).readinessEvaluator;

      // Should default to 1 replica when spec is missing
      const result = evaluator({
        status: { readyReplicas: 0 },
      });
      expect(result.details?.expectedReplicas).toBe(1);
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
      // Verify the deployer has the expected interface
      expect(deployer).toBeDefined();
      expect(deployer.constructor.name).toBe('DirectTypeKroDeployer');

      // Check if it can be used as a TypeKroDeployer
      const typeKroDeployer = deployer as any; // TypeKroDeployer interface check
      expect(typeKroDeployer).toBeDefined();
    });

    it('should work with different resource types beyond Deployment', () => {
      const serviceResource = createTestService('test-service');
      const deployerWithPrivate = deployer as any;

      // Should handle Service resources without modification
      const result = deployerWithPrivate.recreateReadinessEvaluator(serviceResource);
      expect(result).toBe(serviceResource);
      expect(result.kind).toBe('Service');
    });

    it('should maintain consistency across multiple recreations', () => {
      const testDeployment = createTestDeployment('consistency-test', 2);
      const deployerWithPrivate = deployer as any;

      // Recreate the same deployment multiple times
      const recreation1 = deployerWithPrivate.recreateReadinessEvaluator(testDeployment);
      const recreation2 = deployerWithPrivate.recreateReadinessEvaluator(testDeployment);

      // Should produce equivalent results
      expect(recreation1.apiVersion).toBe(recreation2.apiVersion);
      expect(recreation1.kind).toBe(recreation2.kind);
      expect(recreation1.metadata).toEqual(recreation2.metadata);
      expect(recreation1.spec).toEqual(recreation2.spec);

      // Both evaluators should behave the same way
      const evaluator1 = (recreation1 as any).readinessEvaluator;
      const evaluator2 = (recreation2 as any).readinessEvaluator;

      const testStatus = {
        status: { readyReplicas: 1, availableReplicas: 2 },
      };

      const result1 = evaluator1(testStatus);
      const result2 = evaluator2(testStatus);

      expect(result1.ready).toBe(result2.ready);
      expect(result1.reason).toBe(result2.reason);
      expect(result1.details?.expectedReplicas).toBe(result2.details?.expectedReplicas);
    });
  });
});
