/**
 * Magic Proxy Detector Tests
 * 
 * Tests the enhanced detection capabilities for KubernetesRef objects
 * that originate from TypeKro's magic proxy system.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { 
  MagicProxyDetector,
  detectMagicProxyRefs,
  containsMagicProxyRefs,
  extractMagicProxyRefs,
  analyzeMagicProxyRefSource
} from '../../../src/core/expressions/magic-proxy-detector.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/index.js';

describe('Magic Proxy Detector', () => {
  let detector: MagicProxyDetector;

  beforeEach(() => {
    detector = new MagicProxyDetector();
  });

  // Helper function to create mock KubernetesRef objects
  function createMockRef(resourceId: string, fieldPath: string): KubernetesRef<any> {
    return {
      [KUBERNETES_REF_BRAND]: true,
      resourceId,
      fieldPath
    } as KubernetesRef<any>;
  }

  describe('Basic Detection', () => {
    test('should detect KubernetesRef objects in simple values', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      const result = detector.detectKubernetesRefs(ref);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.references).toHaveLength(1);
      expect(result.references[0]?.ref).toBe(ref);
      expect(result.references[0]?.path).toBe('');
      expect(result.references[0]?.isNested).toBe(false);
      expect(result.references[0]?.nestingDepth).toBe(0);
    });

    test('should handle static values without KubernetesRef objects', () => {
      const value = {
        name: 'static-name',
        image: 'nginx:latest',
        replicas: 3
      };

      const result = detector.detectKubernetesRefs(value);

      expect(result.hasKubernetesRefs).toBe(false);
      expect(result.references).toHaveLength(0);
      expect(result.stats.totalReferences).toBe(0);
    });

    test('should detect KubernetesRef objects in nested objects', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      const value = {
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

      const result = detector.detectKubernetesRefs(value);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.references).toHaveLength(1);
      expect(result.references[0]?.path).toBe('metadata.name');
      expect(result.references[0]?.isNested).toBe(true);
      expect(result.references[0]?.nestingDepth).toBe(2);
    });

    test('should detect KubernetesRef objects in arrays', () => {
      const ref1 = createMockRef('resource1', 'spec.name');
      const ref2 = createMockRef('resource2', 'status.ready');
      
      const value = {
        env: [
          { name: 'APP_NAME', value: ref1 },
          { name: 'STATIC_VAR', value: 'static-value' },
          { name: 'READY_STATUS', value: ref2 }
        ]
      };

      const result = detector.detectKubernetesRefs(value);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.references).toHaveLength(2);
      expect(result.references[0]?.path).toBe('env[0].value');
      expect(result.references[1]?.path).toBe('env[2].value');
    });
  });

  describe('Source Analysis', () => {
    test('should identify schema references', () => {
      const schemaRef = createMockRef('__schema__', 'spec.name');
      const result = detector.detectKubernetesRefs(schemaRef, { analyzeReferenceSources: true });

      expect(result.references).toHaveLength(1);
      expect(result.references[0]?.source).toBe('schema');
      expect(result.stats.schemaReferences).toBe(1);
      expect(result.stats.resourceReferences).toBe(0);
    });

    test('should identify resource references', () => {
      const resourceRef = createMockRef('my-deployment', 'status.readyReplicas');
      const result = detector.detectKubernetesRefs(resourceRef, { analyzeReferenceSources: true });

      expect(result.references).toHaveLength(1);
      expect(result.references[0]?.source).toBe('resource');
      expect(result.references[0]?.resourceId).toBe('my-deployment');
      expect(result.stats.schemaReferences).toBe(0);
      expect(result.stats.resourceReferences).toBe(1);
    });

    test('should handle mixed schema and resource references', () => {
      const schemaRef = createMockRef('__schema__', 'spec.name');
      const resourceRef = createMockRef('my-service', 'status.loadBalancer');
      
      const value = {
        name: schemaRef,
        endpoint: resourceRef
      };

      const result = detector.detectKubernetesRefs(value, { analyzeReferenceSources: true });

      expect(result.references).toHaveLength(2);
      expect(result.stats.schemaReferences).toBe(1);
      expect(result.stats.resourceReferences).toBe(1);
    });
  });

  describe('Performance and Statistics', () => {
    test('should provide accurate statistics', () => {
      const ref1 = createMockRef('__schema__', 'spec.name');
      const ref2 = createMockRef('deployment', 'status.ready');
      const ref3 = createMockRef('service', 'spec.ports[0]');
      
      const value = {
        level1: {
          level2: {
            schemaRef: ref1,
            resourceRef: ref2
          }
        },
        topLevel: ref3
      };

      const result = detector.detectKubernetesRefs(value);

      expect(result.stats.totalReferences).toBe(3);
      expect(result.stats.schemaReferences).toBe(1);
      expect(result.stats.resourceReferences).toBe(2);
      expect(result.stats.nestedReferences).toBe(2); // ref1 and ref2 are nested
      expect(result.stats.maxNestingDepth).toBe(3); // level1.level2.schemaRef
    });

    test('should track performance metrics', () => {
      const value = {
        field1: 'static1',
        field2: 'static2',
        field3: 'static3'
      };

      const result = detector.detectKubernetesRefs(value, { trackMetrics: true });

      expect(result.metrics.detectionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.objectsScanned).toBeGreaterThan(0);
      expect(result.metrics.propertiesScanned).toBeGreaterThan(0);
    });

    test('should respect maximum depth limits', () => {
      const ref = createMockRef('deep-resource', 'spec.name');
      const deepValue = {
        l1: { l2: { l3: { l4: { l5: { deepRef: ref } } } } }
      };

      const result = detector.detectKubernetesRefs(deepValue, { maxDepth: 3 });

      // Should not find the reference because it's too deep
      expect(result.hasKubernetesRefs).toBe(false);
      expect(result.references).toHaveLength(0);
    });
  });

  describe('Utility Functions', () => {
    test('should provide fast containment check', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      const value = { nested: { ref } };

      expect(detector.containsKubernetesRefs(value)).toBe(true);
      expect(detector.containsKubernetesRefs({ static: 'value' })).toBe(false);
    });

    test('should extract all KubernetesRef objects', () => {
      const ref1 = createMockRef('resource1', 'spec.name');
      const ref2 = createMockRef('resource2', 'status.ready');
      
      const value = {
        first: ref1,
        nested: { second: ref2 },
        static: 'value'
      };

      const extracted = detector.extractKubernetesRefs(value);

      expect(extracted).toHaveLength(2);
      expect(extracted).toContain(ref1);
      expect(extracted).toContain(ref2);
    });

    test('should analyze reference sources correctly', () => {
      const schemaRef = createMockRef('__schema__', 'spec.hostname');
      const resourceRef = createMockRef('my-deployment', 'status.replicas');

      const schemaAnalysis = detector.analyzeReferenceSource(schemaRef);
      expect(schemaAnalysis.source).toBe('schema');
      expect(schemaAnalysis.isSchemaRef).toBe(true);
      expect(schemaAnalysis.isResourceRef).toBe(false);

      const resourceAnalysis = detector.analyzeReferenceSource(resourceRef);
      expect(resourceAnalysis.source).toBe('resource');
      expect(resourceAnalysis.isSchemaRef).toBe(false);
      expect(resourceAnalysis.isResourceRef).toBe(true);
      expect(resourceAnalysis.resourceId).toBe('my-deployment');
    });
  });

  describe('Global Utility Functions', () => {
    test('should work with detectMagicProxyRefs utility', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      const result = detectMagicProxyRefs({ ref });

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.references).toHaveLength(1);
    });

    test('should work with containsMagicProxyRefs utility', () => {
      const ref = createMockRef('test-resource', 'spec.name');
      
      expect(containsMagicProxyRefs({ ref })).toBe(true);
      expect(containsMagicProxyRefs({ static: 'value' })).toBe(false);
    });

    test('should work with extractMagicProxyRefs utility', () => {
      const ref1 = createMockRef('resource1', 'spec.name');
      const ref2 = createMockRef('resource2', 'status.ready');
      
      const extracted = extractMagicProxyRefs({ first: ref1, second: ref2 });

      expect(extracted).toHaveLength(2);
      expect(extracted).toContain(ref1);
      expect(extracted).toContain(ref2);
    });

    test('should work with analyzeMagicProxyRefSource utility', () => {
      const ref = createMockRef('my-service', 'spec.ports');
      const analysis = analyzeMagicProxyRefSource(ref);

      expect(analysis.source).toBe('resource');
      expect(analysis.resourceId).toBe('my-service');
      expect(analysis.fieldPath).toBe('spec.ports');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle null and undefined values', () => {
      expect(detector.detectKubernetesRefs(null).hasKubernetesRefs).toBe(false);
      expect(detector.detectKubernetesRefs(undefined).hasKubernetesRefs).toBe(false);
    });

    test('should handle circular references gracefully', () => {
      const obj: any = { name: 'test' };
      obj.self = obj; // Create circular reference

      const result = detector.detectKubernetesRefs(obj, { maxDepth: 5 });

      expect(result.hasKubernetesRefs).toBe(false);
      // Should not crash or hang
    });

    test('should handle complex nested structures', () => {
      const ref = createMockRef('complex-resource', 'spec.template.spec.containers[0].name');
      
      const complexValue = {
        metadata: {
          name: 'complex-app',
          labels: { app: 'complex' }
        },
        spec: {
          template: {
            metadata: { labels: { app: 'complex' } },
            spec: {
              containers: [
                {
                  name: ref,
                  image: 'nginx:latest',
                  env: [
                    { name: 'VAR1', value: 'value1' },
                    { name: 'VAR2', value: 'value2' }
                  ]
                }
              ]
            }
          }
        }
      };

      const result = detector.detectKubernetesRefs(complexValue);

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.references).toHaveLength(1);
      expect(result.references[0]?.path).toBe('spec.template.spec.containers[0].name');
    });

    test('should handle large datasets efficiently', () => {
      const largeValue: Record<string, any> = {};
      
      // Create a large object with some KubernetesRef objects
      for (let i = 0; i < 1000; i++) {
        if (i % 100 === 0) {
          largeValue[`ref${i}`] = createMockRef(`resource${i}`, `spec.field${i}`);
        } else {
          largeValue[`field${i}`] = `value${i}`;
        }
      }

      const startTime = performance.now();
      const result = detector.detectKubernetesRefs(largeValue);
      const endTime = performance.now();

      expect(result.hasKubernetesRefs).toBe(true);
      expect(result.references).toHaveLength(10); // Every 100th item
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });
  });
});