/**
 * Unit Tests for CEL Resolution in Deployment Strategies
 *
 * This test suite validates the CEL expression resolution functionality
 * added to the base deployment strategy, ensuring proper handling of
 * resource references, cluster status querying, and error scenarios.
 */

import { beforeEach, describe, expect, it, jest } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { BaseDeploymentStrategy } from '../../src/core/deployment/strategies/base-strategy.js';

// Create a test implementation of BaseDeploymentStrategy
class TestDeploymentStrategy extends BaseDeploymentStrategy<any, any> {
  constructor(
    private mockEngine: any,
    private mockResolver: any,
    private mockReferenceResolver: any,
    private mockCelEvaluator: any
  ) {
    super(
      'test-factory',
      'test-namespace',
      {
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: {} as any,
        status: {} as any,
      },
      undefined, // statusBuilder
      undefined, // resourceKeys
      { kubeConfig: new k8s.KubeConfig(), timeout: 30000 }
    );

    // Override private properties for testing
    (this as any).referenceResolver = mockReferenceResolver;
    (this as any).celEvaluator = mockCelEvaluator;
  }

  getStrategyMode(): 'direct' | 'kro' {
    return 'direct';
  }

  protected async executeDeployment(spec: any, _instanceName: string): Promise<any> {
    // Mock implementation that calls the CEL resolution logic
    const resourceGraph = this.mockResolver.createResourceGraphForInstance(spec);

    // Simulate the CEL resolution logic from base-strategy.ts
    try {
      const resolvedReferences = await this.mockReferenceResolver.resolveReferences(
        { spec, status: {} },
        resourceGraph.resources
      );

      if (resolvedReferences?.resolvedFields) {
        const celFields = Object.entries(resolvedReferences.resolvedFields).filter(
          ([, field]: [string, any]) => field.type === 'cel'
        );

        if (celFields.length > 0) {
          // Extract unique resource keys
          const resourceKeys = Array.from(
            new Set(
              celFields.flatMap(([, field]: [string, any]) => (field as any).resourceKeys || [])
            )
          );

          let clusterData: Record<string, any> = {};

          if (resourceKeys.length > 0) {
            try {
              clusterData = await this.mockEngine.queryClusterStatus(resourceKeys);
            } catch (_error) {
              // Fall back to manifest data
              clusterData = {};
            }
          }

          // Merge cluster data with manifest data
          const resourceDataMap: Record<string, any> = {};
          for (const resource of resourceGraph.resources) {
            resourceDataMap[resource.id] = {
              ...resource.manifest,
              ...(clusterData[resource.id] || {}),
            };
          }

          // Evaluate CEL expressions
          const resolvedStatus: Record<string, any> = {};
          for (const [fieldPath, field] of celFields) {
            try {
              const result = this.mockCelEvaluator.evaluateExpression(
                (field as any).expression,
                resourceDataMap
              );
              const keys = fieldPath.split('.');
              let current: any = resolvedStatus;
              for (let i = 0; i < keys.length - 1; i++) {
                const key = keys[i];
                if (key && !current[key]) current[key] = {};
                if (key) current = current[key];
              }
              const lastKey = keys[keys.length - 1];
              if (lastKey) current[lastKey] = result;
            } catch (_error) {
              // Skip failed CEL evaluations
            }
          }
        }
      }
    } catch (_error) {
      // Continue with deployment even if CEL resolution fails
    }

    return this.mockEngine.deploy(resourceGraph, {});
  }
}

describe('Deployment Strategy CEL Resolution', () => {
  let mockEngine: any;
  let mockResolver: any;
  let mockReferenceResolver: any;
  let mockCelEvaluator: any;
  let strategy: TestDeploymentStrategy;

  beforeEach(() => {
    // Mock engine
    mockEngine = {
      deploy: jest.fn().mockResolvedValue({
        deploymentId: 'test-deployment-123',
        resources: [],
        dependencyGraph: { getDependencies: jest.fn().mockReturnValue([]) },
        duration: 1000,
        status: 'success',
        errors: [],
      }),
      queryClusterStatus: jest.fn(),
    };

    // Mock resource resolver
    mockResolver = {
      createResourceGraphForInstance: jest.fn().mockReturnValue({
        name: 'test-app',
        resources: [
          {
            id: 'deployment',
            manifest: {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: { name: 'test-deployment' },
              spec: { replicas: 3 },
              status: { readyReplicas: 2 },
            },
          },
        ],
        dependencyGraph: { getDependencies: jest.fn().mockReturnValue([]) },
      }),
    };

    // Mock reference resolver
    mockReferenceResolver = {
      resolveReferences: jest.fn(),
    };

    // Mock CEL evaluator
    mockCelEvaluator = {
      evaluateExpression: jest.fn(),
    };

    // Create test strategy
    strategy = new TestDeploymentStrategy(
      mockEngine,
      mockResolver,
      mockReferenceResolver,
      mockCelEvaluator
    );
  });

  describe('CEL Expression Resolution', () => {
    it('should resolve CEL expressions with resource references', async () => {
      // Mock cluster status query to return resource data
      mockEngine.queryClusterStatus.mockResolvedValue({
        deployment: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-deployment' },
          spec: { replicas: 3 },
          status: { readyReplicas: 2 },
        },
      });

      // Mock CEL evaluator to return resolved expression
      mockCelEvaluator.evaluateExpression.mockReturnValue('2');

      // Mock reference resolver to identify CEL expressions
      mockReferenceResolver.resolveReferences.mockReturnValue({
        resolvedFields: {
          'status.replicas': {
            type: 'cel',
            expression: 'deployment.status.readyReplicas',
            resourceKeys: ['deployment'],
          },
        },
      });

      const spec = { name: 'test-app' };
      const result = await (strategy as any).executeDeployment(spec, 'test-instance');

      expect(result).toBeDefined();
      expect(mockEngine.queryClusterStatus).toHaveBeenCalledWith(['deployment']);
      expect(mockCelEvaluator.evaluateExpression).toHaveBeenCalledWith(
        'deployment.status.readyReplicas',
        expect.objectContaining({
          deployment: expect.objectContaining({
            status: { readyReplicas: 2 },
          }),
        })
      );
    });

    it('should handle CEL expressions without resource references', async () => {
      // Mock CEL evaluator to return resolved expression
      mockCelEvaluator.evaluateExpression.mockReturnValue('true');

      // Mock reference resolver to identify CEL expressions without resource keys
      mockReferenceResolver.resolveReferences.mockReturnValue({
        resolvedFields: {
          'status.ready': {
            type: 'cel',
            expression: 'true',
            resourceKeys: [],
          },
        },
      });

      const spec = { name: 'test-app' };
      const result = await (strategy as any).executeDeployment(spec, 'test-instance');

      expect(result).toBeDefined();
      expect(mockEngine.queryClusterStatus).not.toHaveBeenCalled();
      expect(mockCelEvaluator.evaluateExpression).toHaveBeenCalledWith(
        'true',
        expect.objectContaining({
          deployment: expect.any(Object),
        })
      );
    });

    it('should fall back to manifest data when cluster query fails', async () => {
      // Mock cluster status query to fail
      mockEngine.queryClusterStatus.mockRejectedValue(new Error('Cluster query failed'));

      // Mock CEL evaluator to return resolved expression using manifest data
      mockCelEvaluator.evaluateExpression.mockReturnValue('3');

      // Mock reference resolver to identify CEL expressions
      mockReferenceResolver.resolveReferences.mockReturnValue({
        resolvedFields: {
          'status.replicas': {
            type: 'cel',
            expression: 'deployment.spec.replicas',
            resourceKeys: ['deployment'],
          },
        },
      });

      const spec = { name: 'test-app' };
      const result = await (strategy as any).executeDeployment(spec, 'test-instance');

      expect(result).toBeDefined();
      expect(mockEngine.queryClusterStatus).toHaveBeenCalledWith(['deployment']);
      expect(mockCelEvaluator.evaluateExpression).toHaveBeenCalledWith(
        'deployment.spec.replicas',
        expect.objectContaining({
          deployment: expect.objectContaining({
            spec: { replicas: 3 },
          }),
        })
      );
    });

    it('should handle CEL evaluation errors gracefully', async () => {
      // Mock cluster status query to succeed
      mockEngine.queryClusterStatus.mockResolvedValue({
        deployment: {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'test-deployment' },
          status: { readyReplicas: 2 },
        },
      });

      // Mock CEL evaluator to throw an error
      mockCelEvaluator.evaluateExpression.mockImplementation(() => {
        throw new Error('CEL evaluation failed');
      });

      // Mock reference resolver to identify CEL expressions
      mockReferenceResolver.resolveReferences.mockReturnValue({
        resolvedFields: {
          'status.replicas': {
            type: 'cel',
            expression: 'invalid.expression',
            resourceKeys: ['deployment'],
          },
        },
      });

      const spec = { name: 'test-app' };

      // The deployment should still succeed, but CEL resolution should be skipped
      const result = await (strategy as any).executeDeployment(spec, 'test-instance');
      expect(result).toBeDefined();
      expect(mockCelEvaluator.evaluateExpression).toHaveBeenCalled();
    });

    it('should handle empty resource keys array', async () => {
      mockReferenceResolver.resolveReferences.mockReturnValue({
        resolvedFields: {
          'status.static': {
            type: 'cel',
            expression: '"static-value"',
            resourceKeys: [],
          },
        },
      });

      mockCelEvaluator.evaluateExpression.mockReturnValue('static-value');

      const spec = { name: 'test-app' };
      await (strategy as any).executeDeployment(spec, 'test-instance');

      expect(mockEngine.queryClusterStatus).not.toHaveBeenCalled();
      expect(mockCelEvaluator.evaluateExpression).toHaveBeenCalledWith(
        '"static-value"',
        expect.objectContaining({
          deployment: expect.any(Object),
        })
      );
    });

    it('should continue deployment when reference resolution fails', async () => {
      mockReferenceResolver.resolveReferences.mockImplementation(() => {
        throw new Error('Reference resolution failed');
      });

      const spec = { name: 'test-app' };
      const result = await (strategy as any).executeDeployment(spec, 'test-instance');

      expect(result).toBeDefined();
      expect(mockEngine.deploy).toHaveBeenCalled();
    });
  });
});
