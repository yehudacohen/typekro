/**
 * Tests for MagicAssignable Type Integration
 * 
 * These tests validate that the MagicAssignableAnalyzer correctly detects
 * KubernetesRef objects in MagicAssignable and MagicAssignableShape types
 * and converts them to appropriate CEL expressions.
 */

import { describe, it, expect } from 'bun:test';
import { 
  MagicAssignableAnalyzer,
  analyzeMagicAssignable,
  analyzeMagicAssignableShape,
  type MagicAssignableAnalysisOptions
} from '../../../src/core/expressions/magic-assignable-analyzer.js';
import type { AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import type { MagicAssignable, KubernetesRef, CelExpression } from '../../../src/core/types/common.js';
import type { MagicAssignableShape } from '../../../src/core/types/serialization.js';
import { KUBERNETES_REF_BRAND, CEL_EXPRESSION_BRAND } from '../../../src/core/constants/brands.js';

// Test utilities
function createMockKubernetesRef<T>(resourceId: string, fieldPath: string): KubernetesRef<T> {
  return {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath,
    _type: undefined
  } as KubernetesRef<T>;
}

function createMockCelExpression<T>(expression: string): CelExpression<T> {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined
  } as CelExpression<T>;
}

function createMockAnalysisContext(): AnalysisContext {
  return {
    type: 'status',
    availableReferences: {
      deployment: {} as any,
      service: {} as any,
      database: {} as any
    },
    factoryType: 'kro',
    dependencies: []
  };
}

describe('MagicAssignableAnalyzer', () => {
  const createAnalyzer = () => new MagicAssignableAnalyzer();
  const createContext = () => createMockAnalysisContext();

  describe('analyzeMagicAssignable', () => {
    it('should handle static string values without conversion', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const value: MagicAssignable<string> = 'static-value';
      
      const result = analyzer.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedValue).toBe('static-value');
      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle static number values without conversion', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const value: MagicAssignable<number> = 42;
      
      const result = analyzer.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedValue).toBe(42);
      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle static boolean values without conversion', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const value: MagicAssignable<boolean> = true;
      
      const result = analyzer.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedValue).toBe(true);
      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle null and undefined values without conversion', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const nullValue: MagicAssignable<string | null> = null;
      const undefinedValue: MagicAssignable<string | undefined> = undefined;
      
      const nullResult = analyzer.analyzeMagicAssignable(nullValue, context);
      const undefinedResult = analyzer.analyzeMagicAssignable(undefinedValue, context);
      
      expect(nullResult.valid).toBe(true);
      expect(nullResult.requiresConversion).toBe(false);
      expect(nullResult.processedValue).toBe(null);
      
      expect(undefinedResult.valid).toBe(true);
      expect(undefinedResult.requiresConversion).toBe(false);
      expect(undefinedResult.processedValue).toBeUndefined();
    });

    it('should detect and convert KubernetesRef objects', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const kubernetesRef = createMockKubernetesRef<string>('deployment', 'status.readyReplicas');
      const value: MagicAssignable<string> = kubernetesRef;
      
      const result = analyzer.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toBe(kubernetesRef);
      expect(result.errors).toHaveLength(0);
      
      // The processed value should be a CEL expression
      const processedValue = result.processedValue as CelExpression<string>;
      expect(processedValue[CEL_EXPRESSION_BRAND]).toBe(true);
      expect(processedValue.expression).toContain('deployment');
      expect(processedValue.expression).toContain('status.readyReplicas');
    });

    it('should handle CelExpression values without additional conversion', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const celExpression = createMockCelExpression<boolean>('deployment.status.readyReplicas > 0');
      const value: MagicAssignable<boolean> = celExpression;
      
      const result = analyzer.analyzeMagicAssignable(value, context);
      
      // CEL expressions should be treated as static values since they're already converted
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedValue).toBe(celExpression);
      expect(result.dependencies).toHaveLength(0);
    });

    it('should handle performance optimization for static values', () => {
      const context = createContext();
      const options: MagicAssignableAnalysisOptions = {
        optimizeStaticValues: true
      };
      const analyzerWithOptions = new MagicAssignableAnalyzer(undefined, options);
      
      const value: MagicAssignable<string> = 'static-value';
      const result = analyzerWithOptions.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedValue).toBe('static-value');
    });

    it('should handle errors gracefully', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      // Create a value that contains a KubernetesRef but will cause an error during conversion
      const problematicRef = createMockKubernetesRef<string>('nonexistent', 'invalid.field');
      const value: MagicAssignable<string> = problematicRef;
      
      const result = analyzer.analyzeMagicAssignable(value, context);
      
      // The analysis should succeed but the conversion might have issues
      // For now, let's just check that it handles the KubernetesRef
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toBe(problematicRef);
    });
  });

  describe('analyzeMagicAssignableShape', () => {
    it('should handle shapes with all static values', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const shape: MagicAssignableShape<{
        name: string;
        replicas: number;
        ready: boolean;
      }> = {
        name: 'test-app',
        replicas: 3,
        ready: true
      };
      
      const result = analyzer.analyzeMagicAssignableShape(shape, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedShape).toEqual({
        name: 'test-app',
        replicas: 3,
        ready: true
      });
      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(Object.keys(result.fieldResults)).toHaveLength(3);
    });

    it('should detect and convert KubernetesRef objects in shape fields', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const deploymentRef = createMockKubernetesRef<number>('deployment', 'status.readyReplicas');
      const serviceRef = createMockKubernetesRef<string>('service', 'status.loadBalancer.ingress[0].ip');
      
      const shape: MagicAssignableShape<{
        replicas: number;
        url: string;
        staticField: string;
      }> = {
        replicas: deploymentRef,
        url: serviceRef,
        staticField: 'static-value'
      };
      
      const result = analyzer.analyzeMagicAssignableShape(shape, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies).toContain(deploymentRef);
      expect(result.dependencies).toContain(serviceRef);
      expect(result.errors).toHaveLength(0);
      
      // Check field results
      expect(result.fieldResults.replicas?.requiresConversion).toBe(true);
      expect(result.fieldResults.url?.requiresConversion).toBe(true);
      expect(result.fieldResults.staticField?.requiresConversion).toBe(false);
      
      // Static field should remain unchanged
      expect(result.processedShape.staticField).toBe('static-value');
      
      // KubernetesRef fields should be converted to CEL expressions
      expect((result.processedShape.replicas as any)[CEL_EXPRESSION_BRAND]).toBe(true);
      expect((result.processedShape.url as any)[CEL_EXPRESSION_BRAND]).toBe(true);
    });

    it('should handle nested object shapes', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const deploymentRef = createMockKubernetesRef<boolean>('deployment', 'status.conditions[0].status');
      
      const shape: MagicAssignableShape<{
        metadata: {
          name: string;
          ready: boolean;
        };
        status: {
          phase: string;
        };
      }> = {
        metadata: {
          name: 'test-app',
          ready: deploymentRef
        },
        status: {
          phase: 'Running'
        }
      };
      
      const result = analyzer.analyzeMagicAssignableShape(shape, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toBe(deploymentRef);
      
      // Check that nested structure is preserved
      expect(result.processedShape.metadata.name).toBe('test-app');
      expect(result.processedShape.status.phase).toBe('Running');
      
      // KubernetesRef should be converted
      expect((result.processedShape.metadata.ready as any)[CEL_EXPRESSION_BRAND]).toBe(true);
    });

    it('should handle field-level errors gracefully', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const goodRef = createMockKubernetesRef<string>('deployment', 'metadata.name');
      const problematicRef = createMockKubernetesRef<string>('nonexistent', 'invalid.field');
      
      const shape: MagicAssignableShape<{
        goodField: string;
        badField: string;
      }> = {
        goodField: goodRef,
        badField: problematicRef
      };
      
      const result = analyzer.analyzeMagicAssignableShape(shape, context);
      
      // Both fields should be processed, even if one has issues
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(2);
      
      // Good field should be processed correctly
      expect(result.fieldResults.goodField?.valid).toBe(true);
      expect(result.fieldResults.goodField?.requiresConversion).toBe(true);
      
      // Bad field should also be processed (the analyzer doesn't validate resource existence)
      expect(result.fieldResults.badField?.valid).toBe(true);
      expect(result.fieldResults.badField?.requiresConversion).toBe(true);
    });

    it('should handle empty shapes', () => {
      const analyzer = createAnalyzer();
      const context = createContext();
      const shape: MagicAssignableShape<{}> = {};
      
      const result = analyzer.analyzeMagicAssignableShape(shape, context);
      
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
      expect(result.processedShape).toEqual({});
      expect(result.dependencies).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(Object.keys(result.fieldResults)).toHaveLength(0);
    });
  });

  describe('convenience functions', () => {
    it('should provide analyzeMagicAssignable convenience function', () => {
      const context = createContext();
      const value: MagicAssignable<string> = 'test-value';
      
      const result = analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      expect(result.processedValue).toBe('test-value');
    });

    it('should provide analyzeMagicAssignableShape convenience function', () => {
      const context = createContext();
      const shape: MagicAssignableShape<{ name: string }> = {
        name: 'test-name'
      };
      
      const result = analyzeMagicAssignableShape(shape, context);
      
      expect(result.valid).toBe(true);
      expect(result.processedShape.name).toBe('test-name');
    });

    it('should accept options in convenience functions', () => {
      const context = createContext();
      const options: MagicAssignableAnalysisOptions = {
        optimizeStaticValues: false
      };
      
      const value: MagicAssignable<string> = 'test-value';
      const result = analyzeMagicAssignable(value, context, options);
      
      expect(result.valid).toBe(true);
      expect(result.processedValue).toBe('test-value');
    });
  });

  describe('analysis options', () => {
    it('should respect optimizeStaticValues option', () => {
      const context = createContext();
      const options: MagicAssignableAnalysisOptions = {
        optimizeStaticValues: false
      };
      const analyzerWithOptions = new MagicAssignableAnalyzer(undefined, options);
      
      const value: MagicAssignable<string> = 'static-value';
      const result = analyzerWithOptions.analyzeMagicAssignable(value, context);
      
      // Even with optimization disabled, static values should still work
      expect(result.valid).toBe(true);
      expect(result.requiresConversion).toBe(false);
    });

    it('should respect validateTypes option', () => {
      const context = createContext();
      const options: MagicAssignableAnalysisOptions = {
        validateTypes: false
      };
      const analyzerWithOptions = new MagicAssignableAnalyzer(undefined, options);
      
      const value: MagicAssignable<string> = 'test-value';
      const result = analyzerWithOptions.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
    });

    it('should respect includeSourceMapping option', () => {
      const context = createContext();
      const options: MagicAssignableAnalysisOptions = {
        includeSourceMapping: false
      };
      const analyzerWithOptions = new MagicAssignableAnalyzer(undefined, options);
      
      const kubernetesRef = createMockKubernetesRef<string>('deployment', 'status.readyReplicas');
      const value: MagicAssignable<string> = kubernetesRef;
      
      const result = analyzerWithOptions.analyzeMagicAssignable(value, context);
      
      expect(result.valid).toBe(true);
      // Source mapping should be minimal when disabled
      expect(result.sourceMap).toHaveLength(0);
    });
  });
});