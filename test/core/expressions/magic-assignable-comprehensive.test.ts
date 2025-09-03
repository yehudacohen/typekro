/**
 * Comprehensive tests for MagicAssignable type integration with KubernetesRef detection
 * 
 * Tests that JavaScript expressions work seamlessly with MagicAssignable and MagicAssignableShape
 * types through KubernetesRef detection and conversion.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MagicAssignableAnalyzer } from '../../../src/core/expressions/magic-assignable-analyzer.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import { containsKubernetesRefs } from '../../../src/utils/type-guards.js';
import type { KubernetesRef, MagicAssignable } from '../../../src/core/types/common.js';
import type { MagicAssignableShape } from '../../../src/core/types/serialization.js';
import { SourceMapBuilder } from '../../../src/core/expressions/source-map.js';

describe('MagicAssignable Type Integration - Comprehensive Tests', () => {
  let analyzer: MagicAssignableAnalyzer;
  let mockContext: any;

  beforeEach(() => {
    analyzer = new MagicAssignableAnalyzer();
    
    mockContext = {
      type: 'status',
      availableReferences: {
        deployment: {} as any,
        service: {} as any,
        database: {} as any
      },
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: []
    };
  });

  describe('MagicAssignable<T> Type Analysis', () => {
    it('should analyze simple MagicAssignable values with KubernetesRef objects', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      // Test different MagicAssignable values
      const testValues: MagicAssignable<any>[] = [
        'static string',
        42,
        true,
        mockRef,
        null,
        undefined
      ];

      for (const value of testValues) {
        const result = analyzer.analyzeMagicAssignable(value, mockContext);
        
        expect(result).toBeDefined();
        expect(result.originalValue).toBe(value);
        
        if (value === mockRef) {
          expect(result.requiresConversion).toBe(true);
          expect(result.dependencies.length).toBeGreaterThan(0);
          expect(result.dependencies[0]).toBe(mockRef);
        } else {
          expect(result.requiresConversion).toBe(false);
          expect(result.dependencies).toHaveLength(0);
          expect(result.processedValue).toBe(value);
        }
      }
    });

    it('should handle complex MagicAssignable expressions', () => {
      const mockRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      };

      // Complex expressions that might be MagicAssignable
      const complexValues = [
        mockRef,
        [mockRef, 'static', mockRef],
        { ref: mockRef, static: 'value' },
        { nested: { deep: mockRef } }
      ];

      for (const value of complexValues) {
        const result = analyzer.analyzeMagicAssignable(value as any, mockContext);
        
        expect(result).toBeDefined();
        expect(result.originalValue).toBe(value as any);
        
        if (containsKubernetesRefs(value)) {
          expect(result.requiresConversion).toBe(true);
          expect(result.dependencies.length).toBeGreaterThan(0);
        } else {
          expect(result.requiresConversion).toBe(false);
          expect(result.dependencies).toHaveLength(0);
        }
      }
    });

    it('should preserve type information during analysis', () => {
      const stringRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name'
      };

      const numberRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas'
      };

      const booleanRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'service',
        fieldPath: 'status.ready'
      };

      const refs = [stringRef, numberRef, booleanRef];

      for (const ref of refs) {
        const result = analyzer.analyzeMagicAssignable(ref as any, mockContext);
        
        expect(result).toBeDefined();
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies).toHaveLength(1);
        expect(result.dependencies[0]?._type).toBe(ref._type);
      }
    });
  });

  describe('MagicAssignableShape<T> Type Analysis', () => {
    it('should analyze simple object shapes with KubernetesRef objects', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      const simpleShape: MagicAssignableShape<{
        name: string;
        ready: boolean;
        replicas: number;
      }> = {
        name: mockRef,
        ready: true,
        replicas: 3
      };

      const result = analyzer.analyzeMagicAssignableShape(simpleShape, mockContext);
      
      expect(result).toBeDefined();
      expect(result.originalShape).toBe(simpleShape);
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toBe(mockRef);
      
      // Processed shape should have converted the KubernetesRef
      expect(result.processedShape.name).not.toBe(mockRef);
      expect(result.processedShape.ready).toBe(true);
      expect(result.processedShape.replicas).toBe(3);
    });

    it('should handle nested object shapes with multiple KubernetesRef objects', () => {
      const nameRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      const replicasRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        
      };

      const readyRef: KubernetesRef<boolean> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'service',
        fieldPath: 'status.ready',
        
      };

      const nestedShape: MagicAssignableShape<{
        app: {
          name: string;
          replicas: number;
        };
        service: {
          ready: boolean;
          type: string;
        };
        metadata: {
          labels: Record<string, string>;
        };
      }> = {
        app: {
          name: nameRef,
          replicas: replicasRef
        },
        service: {
          ready: readyRef,
          type: 'ClusterIP'
        },
        metadata: {
          labels: {
            app: nameRef,
            version: 'v1.0.0'
          }
        }
      };

      const result = analyzer.analyzeMagicAssignableShape(nestedShape, mockContext);
      
      expect(result).toBeDefined();
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies.length).toBeGreaterThan(0);
      
      // Should find all KubernetesRef objects (nameRef appears twice)
      const uniqueRefs = new Set(result.dependencies);
      expect(uniqueRefs.size).toBe(3); // nameRef, replicasRef, readyRef
      
      // Processed shape should maintain structure
      expect(result.processedShape.app).toBeDefined();
      expect(result.processedShape.service).toBeDefined();
      expect(result.processedShape.metadata).toBeDefined();
      expect(result.processedShape.service.type).toBe('ClusterIP');
      expect(result.processedShape.metadata.labels.version).toBe('v1.0.0');
    });

    it('should handle array properties in shapes', () => {
      const itemRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      const arrayShape: MagicAssignableShape<{
        items: string[];
        mixed: (string | number)[];
        nested: Array<{ name: string; value: number }>;
      }> = {
        items: [itemRef, 'static', itemRef],
        mixed: ['static', 42, itemRef],
        nested: [
          { name: itemRef, value: 1 },
          { name: 'static', value: 2 }
        ]
      };

      const result = analyzer.analyzeMagicAssignableShape(arrayShape, mockContext);
      
      expect(result).toBeDefined();
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies.length).toBeGreaterThan(0);
      
      // Should find all instances of itemRef
      const refCount = result.dependencies.filter(dep => dep === itemRef).length;
      expect(refCount).toBeGreaterThan(1);
      
      // Processed shape should maintain array structure
      expect(Array.isArray(result.processedShape.items)).toBe(true);
      expect(Array.isArray(result.processedShape.mixed)).toBe(true);
      expect(Array.isArray(result.processedShape.nested)).toBe(true);
      expect(result.processedShape.mixed[1]).toBe(42);
      expect(result.processedShape.nested[1]?.name).toBe('static');
      expect(result.processedShape.nested[1]?.value).toBe(2);
    });
  });

  describe('Performance Optimization for Static Values', () => {
    it('should quickly identify and skip static values', () => {
      const staticShape: MagicAssignableShape<{
        name: string;
        replicas: number;
        ready: boolean;
        config: Record<string, any>;
        items: string[];
      }> = {
        name: 'static-app',
        replicas: 3,
        ready: true,
        config: {
          env: 'production',
          debug: false,
          timeout: 30
        },
        items: ['item1', 'item2', 'item3']
      };

      const startTime = performance.now();
      const result = analyzer.analyzeMagicAssignableShape(staticShape, mockContext);
      const endTime = performance.now();
      
      expect(result).toBeDefined();
      expect(result.requiresConversion).toBe(false);
      expect(result.dependencies).toHaveLength(0);
      expect(result.processedShape).toBe(staticShape as any);
      
      // Should be very fast for static values
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(10); // Less than 10ms
    });

    it('should handle large static structures efficiently', () => {
      // Create a large static structure
      const largeStaticShape: MagicAssignableShape<Record<string, any>> = {};
      
      for (let i = 0; i < 100; i++) {
        largeStaticShape[`item${i}`] = {
          name: `item-${i}`,
          value: i,
          enabled: i % 2 === 0,
          config: {
            timeout: i * 10,
            retries: 3,
            metadata: {
              created: new Date().toISOString(),
              tags: [`tag-${i}`, `category-${i % 5}`]
            }
          }
        };
      }

      const startTime = performance.now();
      const result = analyzer.analyzeMagicAssignableShape(largeStaticShape, mockContext);
      const endTime = performance.now();
      
      expect(result).toBeDefined();
      expect(result.requiresConversion).toBe(false);
      expect(result.dependencies).toHaveLength(0);
      expect(result.processedShape).toBe(largeStaticShape);
      
      // Should handle large static structures efficiently
      const duration = endTime - startTime;
      expect(duration).toBeLessThan(100); // Less than 100ms
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle null and undefined values gracefully', () => {
      const edgeCaseValues: MagicAssignable<any>[] = [
        null,
        undefined,
        '',
        0,
        false,
        [],
        {}
      ];

      for (const value of edgeCaseValues) {
        const result = analyzer.analyzeMagicAssignable(value, mockContext);
        
        expect(result).toBeDefined();
        expect(result.originalValue).toBe(value);
        expect(result.requiresConversion).toBe(false);
        expect(result.dependencies).toHaveLength(0);
        expect(result.processedValue).toBe(value);
        expect(result.errors).toHaveLength(0);
      }
    });

    it('should handle malformed KubernetesRef objects', () => {
      const malformedRefs = [
        // Missing brand
        {
          resourceId: 'deployment',
          fieldPath: 'status.readyReplicas'
        },
        // Missing resourceId
        {
          [KUBERNETES_REF_BRAND]: true,
          fieldPath: 'status.readyReplicas'
        },
        // Missing fieldPath
        {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: 'deployment'
        },
        // Invalid brand
        {
          [KUBERNETES_REF_BRAND]: false,
          resourceId: 'deployment',
          fieldPath: 'status.readyReplicas'
        }
      ];

      for (const malformedRef of malformedRefs) {
        const result = analyzer.analyzeMagicAssignable(malformedRef, mockContext);
        
        expect(result).toBeDefined();
        expect(result.originalValue).toBe(malformedRef);
        
        // Should treat as static value if not a valid KubernetesRef
        expect(result.requiresConversion).toBe(false);
        expect(result.dependencies).toHaveLength(0);
      }
    });

    it('should handle circular references in shapes', () => {
      const circularShape: any = {
        name: 'circular',
        value: 42
      };
      
      // Create circular reference
      circularShape.self = circularShape;

      const result = analyzer.analyzeMagicAssignableShape(circularShape, mockContext);
      
      expect(result).toBeDefined();
      expect(result.originalShape).toBe(circularShape);
      
      // Should handle gracefully without infinite recursion
      expect(result.requiresConversion).toBe(false);
      expect(result.dependencies).toHaveLength(0);
    });

    it('should provide meaningful error messages for analysis failures', () => {
      // Create a problematic context that might cause errors
      const problematicContext = {
        ...mockContext,
        availableReferences: null // This might cause issues
      };

      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      const result = analyzer.analyzeMagicAssignable(mockRef, problematicContext);
      
      expect(result).toBeDefined();
      
      // Should handle errors gracefully
      if (result.errors.length > 0) {
        const error = result.errors[0];
        expect(error?.message).toBeDefined();
        expect(error?.message.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Integration with Different Factory Types', () => {
    it('should handle factory type differences in analysis', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      const shape: MagicAssignableShape<{ name: string; ready: boolean }> = {
        name: mockRef,
        ready: true
      };

      // Test with Kro factory
      const kroContext = { ...mockContext, factoryType: 'kro' as const };
      const kroResult = analyzer.analyzeMagicAssignableShape(shape, kroContext);
      
      expect(kroResult).toBeDefined();
      expect(kroResult.requiresConversion).toBe(true);
      
      // Test with direct factory
      const directContext = { ...mockContext, factoryType: 'direct' as const };
      const directResult = analyzer.analyzeMagicAssignableShape(shape, directContext);
      
      expect(directResult).toBeDefined();
      expect(directResult.requiresConversion).toBe(true);
      
      // Both should detect the KubernetesRef but may process differently
      expect(kroResult.dependencies).toHaveLength(1);
      expect(directResult.dependencies).toHaveLength(1);
    });

    it('should provide factory-specific processing', () => {
      const mockRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        
      };

      const complexShape: MagicAssignableShape<{
        simple: number;
        complex: string;
      }> = {
        simple: mockRef,
        complex: `Ready: ${mockRef} replicas`
      };

      // Test with different factory types
      const factoryTypes: ('kro' | 'direct')[] = ['kro', 'direct'];
      
      for (const factoryType of factoryTypes) {
        const context = { ...mockContext, factoryType };
        const result = analyzer.analyzeMagicAssignableShape(complexShape, context);
        
        expect(result).toBeDefined();
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
        
        // Should process according to factory type
        expect(result.processedShape).toBeDefined();
        expect(result.processedShape.simple).not.toBe(mockRef);
      }
    });
  });

  describe('Type Safety and Validation', () => {
    it('should maintain type safety throughout analysis', () => {
      interface TypedShape {
        name: string;
        replicas: number;
        ready: boolean;
        config: {
          env: string;
          debug: boolean;
        };
      }

      const nameRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'metadata.name',
        
      };

      const replicasRef: KubernetesRef<number> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        
      };

      const typedShape: MagicAssignableShape<TypedShape> = {
        name: nameRef,
        replicas: replicasRef,
        ready: true,
        config: {
          env: 'production',
          debug: false
        }
      };

      const result = analyzer.analyzeMagicAssignableShape(typedShape, mockContext);
      
      expect(result).toBeDefined();
      expect(result.requiresConversion).toBe(true);
      expect(result.dependencies).toHaveLength(2);
      
      // Type information should be preserved
      const nameRefDep = result.dependencies.find(dep => dep.fieldPath === 'metadata.name');
      const replicasRefDep = result.dependencies.find(dep => dep.fieldPath === 'status.readyReplicas');
      
      expect(nameRefDep?.fieldPath).toBe('metadata.name');
      expect(replicasRefDep?.fieldPath).toBe('status.readyReplicas');
      
      // Processed shape should maintain structure
      expect(result.processedShape.config.env).toBe('production');
      expect(result.processedShape.config.debug).toBe(false);
      expect(result.processedShape.ready).toBe(true);
    });
  });
});