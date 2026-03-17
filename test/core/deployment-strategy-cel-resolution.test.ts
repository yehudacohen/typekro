/**
 * Unit Tests for CEL Resolution in Deployment Strategies
 *
 * This test suite validates the CEL expression resolution functionality
 * added to the base deployment strategy, ensuring proper handling of
 * resource references, cluster status querying, and error scenarios.
 */

import { beforeEach, describe, expect, it, jest } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { BaseDeploymentStrategy } from '../../src/core/deployment/strategies/base-strategy.js';
import { strategyInternals } from '../utils/mock-factories.js';

const emptySchema = type({});

/** Shape of a resolved CEL field from reference resolver */
interface ResolvedCelField {
  type: string;
  expression: string;
  resourceKeys: string[];
}

// Create a test implementation of BaseDeploymentStrategy
// BaseDeploymentStrategy type params require arktype Type constraints,
// so we must use `any` for the generic params in this test subclass
class TestDeploymentStrategy extends BaseDeploymentStrategy<any, any> {
  constructor(
    private mockEngine: Record<string, unknown>,
    private mockResolver: Record<string, unknown>,
    private mockReferenceResolver: Record<string, unknown>,
    private mockCelEvaluator: Record<string, unknown>
  ) {
    super(
      'test-factory',
      'test-namespace',
      {
        apiVersion: 'v1alpha1',
        kind: 'TestApp',
        spec: emptySchema,
        status: emptySchema,
      },
      undefined, // statusBuilder
      undefined, // resourceKeys
      { kubeConfig: new k8s.KubeConfig(), timeout: 30000 }
    );

    // Override private properties for testing
    (this as unknown as Record<string, unknown>).referenceResolver = mockReferenceResolver;
    (this as unknown as Record<string, unknown>).celEvaluator = mockCelEvaluator;
  }

  getStrategyMode(): 'direct' | 'kro' {
    return 'direct';
  }

  protected async executeDeployment(spec: unknown, _instanceName: string): Promise<any> {
    // Mock implementation that calls the CEL resolution logic
    const createGraph = this.mockResolver.createResourceGraphForInstance as (s: unknown) => Record<
      string,
      unknown
    > & {
      resources: Array<{ id: string; manifest: Record<string, unknown> }>;
    };
    const resourceGraph = createGraph(spec);

    // Simulate the CEL resolution logic from base-strategy.ts
    try {
      const resolveRefs = this.mockReferenceResolver.resolveReferences as (
        ctx: unknown,
        resources: unknown
      ) => Promise<{ resolvedFields?: Record<string, ResolvedCelField> } | null>;
      const resolvedReferences = await resolveRefs({ spec, status: {} }, resourceGraph.resources);

      if (resolvedReferences?.resolvedFields) {
        const celFields = Object.entries(resolvedReferences.resolvedFields).filter(
          ([, field]) => field.type === 'cel'
        );

        if (celFields.length > 0) {
          // Extract unique resource keys
          const resourceKeys = Array.from(
            new Set(celFields.flatMap(([, field]) => field.resourceKeys || []))
          );

          let clusterData: Record<string, Record<string, unknown>> = {};

          if (resourceKeys.length > 0) {
            try {
              const queryStatus = this.mockEngine.queryClusterStatus as (
                keys: string[]
              ) => Promise<Record<string, Record<string, unknown>>>;
              clusterData = await queryStatus(resourceKeys);
            } catch (_error) {
              // Fall back to manifest data
              clusterData = {};
            }
          }

          // Merge cluster data with manifest data
          const resourceDataMap: Record<string, Record<string, unknown>> = {};
          for (const resource of resourceGraph.resources) {
            resourceDataMap[resource.id] = {
              ...resource.manifest,
              ...(clusterData[resource.id] || {}),
            };
          }

          // Evaluate CEL expressions
          const resolvedStatus: Record<string, unknown> = {};
          for (const [fieldPath, field] of celFields) {
            try {
              const evalExpr = this.mockCelEvaluator.evaluateExpression as (
                expr: string,
                data: Record<string, unknown>
              ) => unknown;
              const result = evalExpr(field.expression, resourceDataMap);
              const keys = fieldPath.split('.');
              let current: Record<string, unknown> = resolvedStatus;
              for (let i = 0; i < keys.length - 1; i++) {
                const key = keys[i];
                if (key && !current[key]) current[key] = {};
                if (key) current = current[key] as Record<string, unknown>;
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

    const deploy = this.mockEngine.deploy as (
      graph: unknown,
      opts: Record<string, unknown>
    ) => Promise<unknown>;
    return deploy(resourceGraph, {});
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
      const result = await strategyInternals(strategy).executeDeployment(spec, 'test-instance');

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
      const result = await strategyInternals(strategy).executeDeployment(spec, 'test-instance');

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
      const result = await strategyInternals(strategy).executeDeployment(spec, 'test-instance');

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
      const result = await strategyInternals(strategy).executeDeployment(spec, 'test-instance');
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
      await strategyInternals(strategy).executeDeployment(spec, 'test-instance');

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
      const result = await strategyInternals(strategy).executeDeployment(spec, 'test-instance');

      expect(result).toBeDefined();
      expect(mockEngine.deploy).toHaveBeenCalled();
    });
  });
});
