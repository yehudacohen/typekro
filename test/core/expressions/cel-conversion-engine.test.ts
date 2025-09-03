/**
 * CEL Conversion Engine Tests
 * 
 * Tests the automatic conversion of JavaScript expressions containing
 * KubernetesRef objects to appropriate CEL expressions.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { 
  CelConversionEngine,
  convertToCel,
  kubernetesRefToCel,
  needsCelConversion
} from '../../../src/core/expressions/cel-conversion-engine.js';
import { KUBERNETES_REF_BRAND, BrandChecks } from '../../../src/core/constants/brands.js';
import type { KubernetesRef, CelExpression } from '../../../src/core/types/index.js';
import type { FactoryExpressionContext } from '../../../src/core/expressions/types.js';

describe('CEL Conversion Engine', () => {
  let engine: CelConversionEngine;

  beforeEach(() => {
    engine = new CelConversionEngine();
  });

  // Helper function to create mock KubernetesRef objects
  function createMockRef(resourceId: string, fieldPath: string): KubernetesRef<any> {
    return {
      [KUBERNETES_REF_BRAND]: true,
      resourceId,
      fieldPath
    } as KubernetesRef<any>;
  }

  // Helper function to create factory context
  function createContext(factoryType: 'direct' | 'kro' = 'kro'): FactoryExpressionContext {
    return {
      factoryType,
      factoryName: 'TestFactory',
      analysisEnabled: true
    };
  }

  describe('Basic Conversion', () => {
    test('should convert KubernetesRef to CEL expression for Kro factory', () => {
      const ref = createMockRef('my-deployment', 'status.readyReplicas');
      const context = createContext('kro');

      const result = engine.convertValue(ref, context);

      expect(result.wasConverted).toBe(true);
      expect(result.strategy).toBe('direct');
      expect(BrandChecks.isCelExpression(result.converted)).toBe(true);
      expect((result.converted as unknown as CelExpression<any>).expression).toBe('my-deployment.status.readyReplicas');
    });

    test('should preserve KubernetesRef for direct factory', () => {
      const ref = createMockRef('my-deployment', 'status.readyReplicas');
      const context = createContext('direct');

      const result = engine.convertValue(ref, context);

      expect(result.wasConverted).toBe(true);
      expect(result.strategy).toBe('direct');
      expect(result.converted).toBe(ref); // Should be preserved as-is
    });

    test('should handle schema references correctly', () => {
      const schemaRef = createMockRef('__schema__', 'spec.name');
      const context = createContext('kro');

      const result = engine.convertValue(schemaRef, context);

      expect(result.wasConverted).toBe(true);
      expect((result.converted as unknown as CelExpression<any>).expression).toBe('schema.spec.name');
    });

    test('should handle static values without conversion', () => {
      const staticValue = 'static-string';
      const context = createContext('kro');

      const result = engine.convertValue(staticValue, context);

      expect(result.wasConverted).toBe(false);
      expect(result.strategy).toBe('static');
      expect(result.converted).toBe(staticValue);
    });
  });

  describe('Object and Array Conversion', () => {
    test('should convert objects with KubernetesRef properties', () => {
      const ref = createMockRef('my-service', 'spec.ports[0].port');
      const obj = {
        name: 'static-name',
        port: ref,
        replicas: 3
      };
      const context = createContext('kro');

      const result = engine.convertValue(obj, context);

      expect(result.wasConverted).toBe(true);
      expect(result.strategy).toBe('cel-expression');
      expect(result.converted).toHaveProperty('name', 'static-name');
      expect(result.converted).toHaveProperty('replicas', 3);
      expect(BrandChecks.isCelExpression((result.converted as any).port)).toBe(true);
      expect(((result.converted as any).port as CelExpression<any>).expression).toBe('my-service.spec.ports[0].port');
    });

    test('should convert arrays with KubernetesRef elements', () => {
      const ref1 = createMockRef('resource1', 'spec.name');
      const ref2 = createMockRef('resource2', 'status.ready');
      const arr = [ref1, 'static-value', ref2];
      const context = createContext('kro');

      const result = engine.convertValue(arr, context);

      expect(result.wasConverted).toBe(true);
      expect(result.strategy).toBe('cel-expression');
      expect(Array.isArray(result.converted)).toBe(true);
      
      const convertedArray = result.converted as any[];
      expect(BrandChecks.isCelExpression(convertedArray[0])).toBe(true);
      expect(convertedArray[1]).toBe('static-value');
      expect(BrandChecks.isCelExpression(convertedArray[2])).toBe(true);
    });

    test('should handle nested objects with KubernetesRef objects', () => {
      const ref = createMockRef('my-deployment', 'metadata.name');
      const nestedObj = {
        metadata: {
          name: ref,
          labels: {
            app: 'static-app'
          }
        },
        spec: {
          replicas: 3
        }
      };
      const context = createContext('kro');

      const result = engine.convertValue(nestedObj, context);

      expect(result.wasConverted).toBe(true);
      expect(result.strategy).toBe('cel-expression');
      
      const converted = result.converted as any;
      expect(BrandChecks.isCelExpression(converted.metadata.name)).toBe(true);
      expect(converted.metadata.labels.app).toBe('static-app');
      expect(converted.spec.replicas).toBe(3);
    });
  });

  describe('Performance and Metrics', () => {
    test('should provide accurate conversion metrics', () => {
      const ref1 = createMockRef('resource1', 'spec.name');
      const ref2 = createMockRef('resource2', 'status.ready');
      const obj = {
        name: ref1,
        status: ref2,
        static: 'value'
      };
      const context = createContext('kro');

      const result = engine.convertValue(obj, context);

      expect(result.metrics.referencesConverted).toBe(2);
      expect(result.metrics.expressionsGenerated).toBe(2);
      expect(result.metrics.conversionTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('should handle large objects efficiently', () => {
      const largeObj: Record<string, any> = {};
      
      // Create a large object with some KubernetesRef objects
      for (let i = 0; i < 100; i++) {
        if (i % 10 === 0) {
          largeObj[`ref${i}`] = createMockRef(`resource${i}`, `spec.field${i}`);
        } else {
          largeObj[`field${i}`] = `value${i}`;
        }
      }

      const context = createContext('kro');
      const startTime = performance.now();
      const result = engine.convertValue(largeObj, context);
      const endTime = performance.now();

      expect(result.wasConverted).toBe(true);
      expect(result.metrics.referencesConverted).toBe(10);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });
  });

  describe('Configuration Options', () => {
    test('should include debug information when enabled', () => {
      const ref = createMockRef('my-resource', 'spec.name');
      const context = createContext('kro');

      const result = engine.convertValue(ref, context, { includeDebugInfo: true });

      expect(result.debugInfo).toBeDefined();
      expect(result.debugInfo!.detectedReferences).toHaveLength(1);
      expect(result.debugInfo!.conversionSteps.length).toBeGreaterThan(0);
    });

    test('should respect maximum depth limits', () => {
      const ref = createMockRef('deep-resource', 'spec.name');
      const deepObj = {
        l1: { l2: { l3: { l4: { l5: { deepRef: ref } } } } }
      };
      const context = createContext('kro');

      const result = engine.convertValue(deepObj, context, { maxDepth: 3 });

      // Should not convert the deep reference due to depth limit
      expect(result.wasConverted).toBe(false);
      expect(result.strategy).toBe('static');
    });

    test('should handle optimization settings', () => {
      const ref = createMockRef('my-resource', 'spec.name');
      const context = createContext('kro');

      const result = engine.convertValue(ref, context, { 
        enableOptimization: true,
        preserveStatic: true 
      });

      expect(result.wasConverted).toBe(true);
      // Optimization behavior would be tested with more complex scenarios
    });
  });

  describe('Utility Functions', () => {
    test('should work with convertToCel utility', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      const context = createContext('kro');

      const result = convertToCel(ref, context);

      expect(result.wasConverted).toBe(true);
      expect(BrandChecks.isCelExpression(result.converted)).toBe(true);
    });

    test('should work with kubernetesRefToCel utility', () => {
      const ref = createMockRef('test-resource', 'status.ready');
      const context = createContext('kro');

      const celExpr = kubernetesRefToCel(ref, context);

      expect(BrandChecks.isCelExpression(celExpr)).toBe(true);
      expect(celExpr.expression).toBe('test-resource.status.ready');
    });

    test('should work with needsCelConversion utility', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      const staticValue = 'static-string';

      expect(needsCelConversion(ref)).toBe(true);
      expect(needsCelConversion(staticValue)).toBe(false);
      expect(needsCelConversion({ nested: ref })).toBe(true);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle null and undefined values', () => {
      const context = createContext('kro');

      expect(engine.convertValue(null, context).wasConverted).toBe(false);
      expect(engine.convertValue(undefined, context).wasConverted).toBe(false);
    });

    test('should handle empty objects and arrays', () => {
      const context = createContext('kro');

      const emptyObj = engine.convertValue({}, context);
      const emptyArr = engine.convertValue([], context);

      expect(emptyObj.wasConverted).toBe(false);
      expect(emptyArr.wasConverted).toBe(false);
    });

    test('should handle mixed factory types correctly', () => {
      const ref = createMockRef('my-resource', 'spec.name');
      
      const kroResult = engine.convertValue(ref, createContext('kro'));
      const directResult = engine.convertValue(ref, createContext('direct'));

      expect(BrandChecks.isCelExpression(kroResult.converted)).toBe(true);
      expect(directResult.converted).toBe(ref); // Preserved as-is
    });

    test('should generate warnings for unsupported features', () => {
      // This would test template literal conversion when fully implemented
      const templateLikeValue = 'template with ${ref}';
      const context = createContext('kro');

      const result = engine.convertValue(templateLikeValue, context);

      // Currently returns as-is since template parsing isn't implemented
      expect(result.wasConverted).toBe(false);
    });

    test('should handle circular references gracefully', () => {
      const obj: any = { name: 'test' };
      obj.self = obj; // Create circular reference
      const context = createContext('kro');

      const result = engine.convertValue(obj, context, { maxDepth: 5 });

      expect(result.wasConverted).toBe(false);
      // Should not crash or hang
    });
  });

  describe('Integration Scenarios', () => {
    test('should handle complex factory configuration', () => {
      const nameRef = createMockRef('__schema__', 'spec.name');
      const imageRef = createMockRef('__schema__', 'spec.image');
      const replicasRef = createMockRef('__schema__', 'spec.replicas');
      
      const factoryConfig = {
        metadata: {
          name: nameRef,
          labels: { app: nameRef }
        },
        spec: {
          replicas: replicasRef,
          template: {
            spec: {
              containers: [{
                name: nameRef,
                image: imageRef,
                env: [
                  { name: 'APP_NAME', value: nameRef },
                  { name: 'STATIC_VAR', value: 'static-value' }
                ]
              }]
            }
          }
        }
      };

      const context = createContext('kro');
      const result = engine.convertValue(factoryConfig, context);

      expect(result.wasConverted).toBe(true);
      expect(result.metrics.referencesConverted).toBe(6); // nameRef appears 4 times + imageRef + replicasRef
      expect(result.metrics.expressionsGenerated).toBe(6);
    });

    test('should preserve performance with deeply nested structures', () => {
      const ref = createMockRef('deep-resource', 'spec.name');
      const deepStructure = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  ref,
                  static: 'value'
                }
              }
            }
          }
        }
      };

      const context = createContext('kro');
      const startTime = performance.now();
      const result = engine.convertValue(deepStructure, context);
      const endTime = performance.now();

      expect(result.wasConverted).toBe(true);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast even with deep nesting
    });
  });
});