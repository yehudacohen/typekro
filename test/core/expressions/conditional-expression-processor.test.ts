/**
 * Tests for Conditional Expression Processor
 * 
 * Tests the processing of conditional expressions like includeWhen and readyWhen
 * that contain KubernetesRef objects, ensuring proper CEL conversion.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/index.js';
import { 
  ConditionalExpressionProcessor,
  type ConditionalExpressionConfig 
} from '../../../src/core/expressions/conditional-expression-processor.js';
import type { FactoryExpressionContext } from '../../../src/core/expressions/types.js';

describe('ConditionalExpressionProcessor', () => {
  let processor: ConditionalExpressionProcessor;
  let mockContext: FactoryExpressionContext;
  let config: ConditionalExpressionConfig;

  beforeEach(() => {
    processor = new ConditionalExpressionProcessor();
    
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
      strictValidation: false,
      includeDebugInfo: true,
      maxDepth: 10
    };
  });

  describe('processIncludeWhenExpression', () => {
    it('should process includeWhen expression with KubernetesRef objects', () => {
      // Create a mock KubernetesRef for schema.spec.enabled
      const schemaRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath: 'spec.enabled'
      } as KubernetesRef<boolean>;

      const result = processor.processIncludeWhenExpression(schemaRef, mockContext, config);

      expect(result.wasProcessed).toBe(true);
      expect(result.conditionalType).toBe('includeWhen');
      expect(result.contextResult.context).toBe('conditional');
      expect(result.metrics.referencesProcessed).toBe(1);
      expect(result.validationErrors).toHaveLength(0);
      
      // For Kro factory, should convert to CEL expression
      expect(result.expression).toHaveProperty('expression');
      expect((result.expression as any).expression).toBe('schema.spec.enabled');
    });

    it('should handle includeWhen expression without KubernetesRef objects', () => {
      const staticCondition = true;

      const result = processor.processIncludeWhenExpression(staticCondition, mockContext, config);

      expect(result.wasProcessed).toBe(false);
      expect(result.conditionalType).toBe('includeWhen');
      expect(result.metrics.referencesProcessed).toBe(0);
      expect(result.expression).toBe(staticCondition);
    });

    it('should preserve KubernetesRef for direct factory', () => {
      const directContext = { ...mockContext, factoryType: 'direct' as const };
      
      const schemaRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath: 'spec.enabled'
      } as KubernetesRef<boolean>;

      const result = processor.processIncludeWhenExpression(schemaRef, directContext, config);

      expect(result.wasProcessed).toBe(true);
      expect(result.expression).toBe(schemaRef); // Should preserve the reference
    });

    it('should validate includeWhen expressions', () => {
      const invalidExpression = 'not a boolean expression';
      const strictConfig = { ...config, strictValidation: true };

      const result = processor.processIncludeWhenExpression(invalidExpression, mockContext, strictConfig);

      // The validation should detect that this doesn't look like a boolean expression
      expect(result.validationErrors.length).toBeGreaterThan(0);
      expect(result.validationErrors[0]).toContain('boolean');
    });

    it('should handle complex includeWhen expressions with multiple KubernetesRef objects', () => {
      const complexExpression = {
        condition: {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: '__schema__',
          fieldPath: 'spec.enabled'
        } as KubernetesRef<boolean>,
        fallback: {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: '__schema__',
          fieldPath: 'spec.defaultEnabled'
        } as KubernetesRef<boolean>
      };

      const result = processor.processIncludeWhenExpression(complexExpression, mockContext, config);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics.referencesProcessed).toBe(2);
      expect(result.metrics.expressionsGenerated).toBe(2);
    });
  });

  describe('processReadyWhenExpression', () => {
    it('should process readyWhen expression with resource status KubernetesRef', () => {
      const statusRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      } as KubernetesRef<number>;

      const result = processor.processReadyWhenExpression(statusRef, mockContext, config);

      expect(result.wasProcessed).toBe(true);
      expect(result.conditionalType).toBe('readyWhen');
      expect(result.contextResult.context).toBe('readiness');
      expect(result.metrics.referencesProcessed).toBe(1);
      
      // For Kro factory, should convert to CEL expression
      expect(result.expression).toHaveProperty('expression');
      expect((result.expression as any).expression).toBe('deployment.status.readyReplicas');
    });

    it('should validate readyWhen expressions for status field references', () => {
      // readyWhen without status references should generate warning
      const nonStatusRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'spec.replicas'
      } as KubernetesRef<string>;

      const result = processor.processReadyWhenExpression(nonStatusRef, mockContext, config);

      expect(result.validationErrors.length).toBeGreaterThan(0);
      expect(result.validationErrors.some(err => err.includes('status'))).toBe(true);
    });

    it('should handle readyWhen expressions with boolean logic', () => {
      const booleanExpression = 'deployment.status.readyReplicas > 0 && service.status.ready';

      const result = processor.processReadyWhenExpression(booleanExpression, mockContext, config);

      expect(result.wasProcessed).toBe(false); // No KubernetesRef objects detected in string
      expect(result.conditionalType).toBe('readyWhen');
    });
  });

  describe('processCustomConditionalExpression', () => {
    it('should process custom conditional expressions', () => {
      const customCondition: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'configmap',
        fieldPath: 'data.environment'
      } as KubernetesRef<string>;

      const result = processor.processCustomConditionalExpression(customCondition, mockContext, config);

      expect(result.wasProcessed).toBe(true);
      expect(result.conditionalType).toBe('custom');
      expect(result.metrics.referencesProcessed).toBe(1);
      
      // For Kro factory, should convert to CEL expression
      expect(result.expression).toHaveProperty('expression');
      expect((result.expression as any).expression).toBe('configmap.data.environment');
    });

    it('should validate ternary conditional expressions', () => {
      const invalidTernary = 'condition ? value'; // Missing : part

      const result = processor.processCustomConditionalExpression(invalidTernary, mockContext, config);

      expect(result.validationErrors.length).toBeGreaterThan(0);
      expect(result.validationErrors[0]).toContain('?');
    });
  });

  describe('context detection', () => {
    it('should detect conditional context for includeWhen expressions', () => {
      const condition = true;

      const result = processor.processIncludeWhenExpression(condition, mockContext, config);

      expect(result.contextResult.context).toBe('conditional');
      expect(result.contextResult.confidence).toBeGreaterThan(0.8);
      expect(result.contextResult.celStrategy).toBe('conditional-check');
    });

    it('should detect readiness context for readyWhen expressions', () => {
      const condition = true;

      const result = processor.processReadyWhenExpression(condition, mockContext, config);

      expect(result.contextResult.context).toBe('readiness');
      expect(result.contextResult.confidence).toBeGreaterThan(0.8);
      expect(result.contextResult.celStrategy).toBe('readiness-check');
    });
  });

  describe('performance metrics', () => {
    it('should track processing metrics', () => {
      const schemaRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath: 'spec.enabled'
      } as KubernetesRef<boolean>;

      const result = processor.processIncludeWhenExpression(schemaRef, mockContext, config);

      expect(result.metrics.processingTimeMs).toBeGreaterThan(0);
      expect(result.metrics.referencesProcessed).toBe(1);
      expect(result.metrics.expressionsGenerated).toBe(1);
    });

    it('should provide debug information when enabled', () => {
      const schemaRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath: 'spec.enabled'
      } as KubernetesRef<boolean>;

      const result = processor.processIncludeWhenExpression(schemaRef, mockContext, config);

      expect(result.debugInfo).toBeDefined();
      expect(result.debugInfo!.detectedReferences).toHaveLength(1);
      expect(result.debugInfo!.processingSteps.length).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should handle invalid KubernetesRef objects gracefully', () => {
      const invalidRef = {
        // Missing KUBERNETES_REF_BRAND
        resourceId: 'invalid',
        fieldPath: 'invalid'
      };

      const result = processor.processIncludeWhenExpression(invalidRef, mockContext, config);

      expect(result.wasProcessed).toBe(false);
      expect(result.validationErrors).toHaveLength(0); // Should not crash
    });

    it('should handle null and undefined expressions', () => {
      const nullResult = processor.processIncludeWhenExpression(null, mockContext, config);
      const undefinedResult = processor.processIncludeWhenExpression(undefined, mockContext, config);

      expect(nullResult.wasProcessed).toBe(false);
      expect(undefinedResult.wasProcessed).toBe(false);
    });
  });
});