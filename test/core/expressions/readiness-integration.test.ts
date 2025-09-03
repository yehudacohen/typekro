/**
 * Tests for Readiness Integration
 * 
 * Tests the integration between readyWhen expressions containing KubernetesRef
 * objects and TypeKro's readiness evaluation system.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef, ResourceStatus } from '../../../src/core/types/index.js';
import { 
  ReadinessIntegrator,
  type ReadinessIntegrationConfig 
} from '../../../src/core/expressions/readiness-integration.js';
import type { FactoryExpressionContext } from '../../../src/core/expressions/types.js';

describe('ReadinessIntegrator', () => {
  let integrator: ReadinessIntegrator;
  let mockContext: FactoryExpressionContext;
  let config: ReadinessIntegrationConfig;

  beforeEach(() => {
    integrator = new ReadinessIntegrator();
    
    mockContext = {
      factoryType: 'kro',
      factoryName: 'simpleDeployment',
      analysisEnabled: true,
      resourceId: 'test-resource',
      availableResources: {},
      schemaProxy: undefined
    };

    config = {
      factoryType: 'kro',
      enableFallback: true,
      timeoutMs: 5000,
      enableCaching: false,
      includeDebugInfo: true
    };
  });

  describe('createReadinessEvaluator', () => {
    it('should create readiness evaluator from KubernetesRef expression', () => {
      const statusRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      } as KubernetesRef<number>;

      const result = integrator.createReadinessEvaluator(statusRef, mockContext, config);

      expect(result.wasProcessed).toBe(true);
      expect(result.evaluator).toBeDefined();
      expect(result.warnings).toHaveLength(0);
      expect(result.metrics.expressionsProcessed).toBe(1);
      expect(result.metrics.integrationTimeMs).toBeGreaterThan(0);
    });

    it('should create readiness evaluator from boolean expression', () => {
      const booleanExpression = true;

      const result = integrator.createReadinessEvaluator(booleanExpression, mockContext, config);

      expect(result.evaluator).toBeDefined();
      expect(result.metrics.expressionsProcessed).toBe(1);

      // Test the evaluator
      const mockResource = { kind: 'Deployment', status: {} };
      const status = result.evaluator!(mockResource);
      
      expect(status.ready).toBe(true);
      expect(status.reason).toBe('ExpressionTrue');
    });

    it('should handle validation errors gracefully', () => {
      const invalidExpression = 'not a boolean expression';
      const strictConfig = { ...config, strictValidation: true };

      const result = integrator.createReadinessEvaluator(invalidExpression, mockContext, strictConfig);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.evaluator).toBeDefined(); // Should still create evaluator
    });

    it('should create fallback evaluator on error', () => {
      // Mock the processor to throw an error
      const originalProcessor = (integrator as any).processor;
      (integrator as any).processor = {
        processReadyWhenExpression: () => {
          throw new Error('Processing failed');
        }
      };

      const problematicExpression = { invalid: 'expression' };
      const fallbackConfig = { ...config, enableFallback: true };

      const result = integrator.createReadinessEvaluator(problematicExpression, mockContext, fallbackConfig);

      expect(result.evaluator).toBeDefined();
      expect(result.warnings.some(w => w.includes('fallback'))).toBe(true);

      // Restore the original processor
      (integrator as any).processor = originalProcessor;
    });
  });

  describe('readiness evaluator functionality', () => {
    it('should evaluate KubernetesRef expressions against live resources', () => {
      const statusRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      } as KubernetesRef<number>;

      const result = integrator.createReadinessEvaluator(statusRef, mockContext, config);
      const evaluator = result.evaluator!;

      // Test with ready resource
      const readyResource = {
        kind: 'Deployment',
        status: { readyReplicas: 3 }
      };

      const readyStatus = evaluator(readyResource);
      expect(readyStatus.ready).toBe(true);
      expect(readyStatus.reason).toBe('FieldTruthy');
      expect(readyStatus.details?.value).toBe(3);

      // Test with not ready resource
      const notReadyResource = {
        kind: 'Deployment',
        status: { readyReplicas: 0 }
      };

      const notReadyStatus = evaluator(notReadyResource);
      expect(notReadyStatus.ready).toBe(false);
      expect(notReadyStatus.reason).toBe('FieldFalsy');
      expect(notReadyStatus.details?.value).toBe(0);
    });

    it('should handle missing fields gracefully', () => {
      const statusRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.nonExistentField'
      } as KubernetesRef<number>;

      const result = integrator.createReadinessEvaluator(statusRef, mockContext, config);
      const evaluator = result.evaluator!;

      const resource = {
        kind: 'Deployment',
        status: { readyReplicas: 3 }
      };

      const status = evaluator(resource);
      expect(status.ready).toBe(false);
      expect(status.reason).toBe('FieldNotFound');
      expect(status.message).toContain('nonExistentField');
    });

    it('should handle nested field paths', () => {
      const nestedRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.conditions[0].status'
      } as KubernetesRef<string>;

      const result = integrator.createReadinessEvaluator(nestedRef, mockContext, config);
      const evaluator = result.evaluator!;

      const resource = {
        kind: 'Deployment',
        status: {
          conditions: [
            { type: 'Available', status: 'True' }
          ]
        }
      };

      const status = evaluator(resource);
      expect(status.ready).toBe(true);
      expect(status.details?.value).toBe('True');
    });

    it('should handle function expressions', () => {
      const functionExpression = (resource: any) => {
        return resource.status?.readyReplicas > 0;
      };

      const result = integrator.createReadinessEvaluator(functionExpression, mockContext, config);
      const evaluator = result.evaluator!;

      const resource = {
        kind: 'Deployment',
        status: { readyReplicas: 2 }
      };

      const status = evaluator(resource);
      expect(status.ready).toBe(true);
      expect(status.reason).toBe('FunctionTrue');
    });

    it('should handle function expressions that return ResourceStatus', () => {
      const functionExpression = (resource: any): ResourceStatus => {
        const ready = resource.status?.readyReplicas > 0;
        return {
          ready,
          reason: ready ? 'CustomReady' : 'CustomNotReady',
          message: `Custom evaluation: ${ready}`,
          details: { replicas: resource.status?.readyReplicas }
        };
      };

      const result = integrator.createReadinessEvaluator(functionExpression, mockContext, config);
      const evaluator = result.evaluator!;

      const resource = {
        kind: 'Deployment',
        status: { readyReplicas: 2 }
      };

      const status = evaluator(resource);
      expect(status.ready).toBe(true);
      expect(status.reason).toBe('CustomReady');
      expect(status.message).toBe('Custom evaluation: true');
      expect(status.details?.replicas).toBe(2);
    });
  });

  describe('factory type differences', () => {
    it('should handle direct factory expressions', () => {
      const directContext = { ...mockContext, factoryType: 'direct' as const };
      const booleanExpression = true;

      const result = integrator.createReadinessEvaluator(booleanExpression, directContext, config);
      const evaluator = result.evaluator!;

      const resource = { kind: 'Deployment' };
      const status = evaluator(resource);

      expect(status.ready).toBe(true);
      // Boolean expressions without KubernetesRef objects are not processed, so they use ExpressionTrue
      expect(status.reason).toBe('ExpressionTrue');
    });

    it('should handle Kro factory CEL expressions', () => {
      const kroContext = { ...mockContext, factoryType: 'kro' as const };
      const celExpression = {
        expression: 'deployment.status.readyReplicas > 0',
        type: 'boolean'
      };

      const result = integrator.createReadinessEvaluator(celExpression, kroContext, config);
      const evaluator = result.evaluator!;

      const resource = { kind: 'Deployment' };
      const status = evaluator(resource);

      // CEL expressions without KubernetesRef objects are treated as truthy objects
      expect(status.ready).toBe(true);
      expect(status.reason).toBe('ExpressionTruthy');
    });
  });

  describe('error handling', () => {
    it('should handle evaluation errors gracefully', () => {
      const problematicRef: KubernetesRef<any> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.problematic.field'
      } as KubernetesRef<any>;

      const result = integrator.createReadinessEvaluator(problematicRef, mockContext, config);
      const evaluator = result.evaluator!;

      // Pass null resource to trigger error
      const status = evaluator(null);

      expect(status.ready).toBe(false);
      expect(status.reason).toBe('FieldNotFound');
    });

    it('should handle function evaluation errors', () => {
      const errorFunction = () => {
        throw new Error('Evaluation error');
      };

      const result = integrator.createReadinessEvaluator(errorFunction, mockContext, config);
      const evaluator = result.evaluator!;

      const resource = { kind: 'Deployment' };
      const status = evaluator(resource);

      expect(status.ready).toBe(false);
      expect(status.reason).toBe('EvaluationError');
      expect(status.message).toContain('Evaluation error');
    });
  });

  describe('fallback evaluator', () => {
    it('should detect failed resources', () => {
      const fallbackEvaluator = (integrator as any).createFallbackEvaluator('test');

      const failedResource = {
        kind: 'Deployment',
        status: {
          conditions: [
            { type: 'Failed', status: 'True', message: 'Deployment failed' }
          ]
        }
      };

      const status = fallbackEvaluator(failedResource);
      expect(status.ready).toBe(false);
      expect(status.reason).toBe('ResourceFailed');
      expect(status.message).toBe('Deployment failed');
    });

    it('should handle missing resources', () => {
      const fallbackEvaluator = (integrator as any).createFallbackEvaluator('test');

      const status = fallbackEvaluator(null);
      expect(status.ready).toBe(false);
      expect(status.reason).toBe('ResourceNotFound');
    });

    it('should default to ready for healthy resources', () => {
      const fallbackEvaluator = (integrator as any).createFallbackEvaluator('test');

      const healthyResource = {
        kind: 'Deployment',
        status: {
          conditions: [
            { type: 'Available', status: 'True' }
          ]
        }
      };

      const status = fallbackEvaluator(healthyResource);
      expect(status.ready).toBe(true);
      expect(status.reason).toBe('FallbackEvaluator');
    });
  });
});