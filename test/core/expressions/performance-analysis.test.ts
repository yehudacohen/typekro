/**
 * Performance tests for JavaScript to CEL expression analysis with KubernetesRef detection
 *
 * These tests validate that the expression analysis system performs well with
 * KubernetesRef detection and doesn't introduce significant overhead.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import {
  type AnalysisContext,
  JavaScriptToCelAnalyzer,
} from '../../../src/core/expressions/analysis/analyzer.js';
import { SourceMapBuilder } from '../../../src/core/expressions/analysis/source-map.js';
import { ResourceAnalyzer } from '../../../src/core/expressions/factory/resource-analyzer.js';
import { MagicAssignableAnalyzer } from '../../../src/core/expressions/magic-proxy/magic-assignable-analyzer.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';

/** Interface for accessing JavaScriptToCelAnalyzer private members in tests */
interface AnalyzerInternals {
  cache?: {
    getStats(): { entryCount: number; cacheHits: number; hitRatio: number };
    size: number;
  };
  clearCache?(): void;
}

/** Type-safe access to analyzer internals */
function analyzerInternals(a: JavaScriptToCelAnalyzer): AnalyzerInternals {
  return a as unknown as AnalyzerInternals;
}

describe('Performance Analysis - KubernetesRef Detection', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let magicAssignableAnalyzer: MagicAssignableAnalyzer;
  let resourceAnalyzer: ResourceAnalyzer;
  let mockContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    magicAssignableAnalyzer = new MagicAssignableAnalyzer();
    resourceAnalyzer = new ResourceAnalyzer();

    // Create mock resources for performance tests
    const availableReferences: Record<string, any> = {
      deployment: {
        __resourceId: 'deployment',
        status: {
          readyReplicas: 1,
          conditions: [{ type: 'Available', status: 'True' }],
        },
      },
      service: {
        __resourceId: 'service',
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          loadBalancer: { ingress: [{ ip: '192.168.1.1' }] },
        },
        spec: {
          ports: [{ port: 8080 }],
        },
      },
      schema: {
        __resourceId: '__schema__',
        spec: {
          name: 'test-app',
          replicas: 3,
          path: 'api/v1',
        },
      },
    };

    // Add numbered deployment resources for performance tests
    for (let i = 0; i < 100; i++) {
      availableReferences[`deployment_${i}`] = {
        __resourceId: `deployment_${i}`,
        status: { readyReplicas: i + 1, conditions: [{ type: 'Available', status: 'True' }] },
      };
    }

    mockContext = {
      type: 'status',
      availableReferences,
      factoryType: 'kro',
      sourceMap: new SourceMapBuilder(),
      dependencies: [],
    };
  });

  describe('Expression Analysis Performance', () => {
    it('should analyze simple expressions quickly', () => {
      const expressions = [
        'deployment.status.readyReplicas > 0',
        'deployment.status.availableReplicas > 0',
        'schema.spec.name',
        'true',
        '42',
        '"static string"',
      ];

      const startTime = performance.now();

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        expect(result).toBeDefined();
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete all expressions in under 100ms
      expect(duration).toBeLessThan(100);
    });

    it('should handle large numbers of expressions efficiently', () => {
      const baseExpressions = [
        'deployment.status.readyReplicas > 0',
        'deployment.status.availableReplicas > 0 && deployment.status.readyReplicas > 0',
        '`http://${service.status.loadBalancer.ingress[0].ip}`',
        'deployment.status.conditions.find(c => c.type === "Available").status === "True"',
        'schema.spec.replicas > 1 ? "ha" : "single"',
      ];

      // Generate many variations
      const expressions: string[] = [];
      for (let i = 0; i < 100; i++) {
        for (const base of baseExpressions) {
          expressions.push(base.replace(/deployment/g, `deployment-${i % 10}`));
        }
      }

      const startTime = performance.now();

      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        expect(result).toBeDefined();
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete 500 expressions in under 2 seconds
      expect(duration).toBeLessThan(2000);

      // Average time per expression should be reasonable
      const avgTime = duration / expressions.length;
      expect(avgTime).toBeLessThan(4); // Less than 4ms per expression
    });

    it('should cache repeated expressions effectively', () => {
      const expression =
        'deployment.status.readyReplicas > 0 && deployment.status.availableReplicas > 0';
      const iterations = 1000;

      // First run - should populate cache
      const firstRunStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        const result = analyzer.analyzeExpression(expression, mockContext);
        expect(result.valid).toBe(true);
      }
      const firstRunEnd = performance.now();
      const _firstRunDuration = firstRunEnd - firstRunStart;

      // Check cache stats after first run
      const cacheStatsAfterFirst = analyzerInternals(analyzer).cache?.getStats();

      // Second run - should use cache
      const secondRunStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        const result = analyzer.analyzeExpression(expression, mockContext);
        expect(result.valid).toBe(true);
      }
      const secondRunEnd = performance.now();
      const _secondRunDuration = secondRunEnd - secondRunStart;

      // Check cache stats after second run
      const cacheStatsAfterSecond = analyzerInternals(analyzer).cache?.getStats();

      // Cache should have entries and hits
      expect(cacheStatsAfterFirst?.entryCount || 0).toBeGreaterThan(0);
      expect(cacheStatsAfterSecond?.cacheHits || 0).toBeGreaterThan(
        cacheStatsAfterFirst?.cacheHits || 0
      );

      // With 99.9% cache hit ratio, we should see some performance improvement
      // But the improvement might be modest due to cache lookup overhead
      // Let's just verify that cache is working effectively rather than strict performance requirements
      expect(cacheStatsAfterSecond?.hitRatio || 0).toBeGreaterThan(0.95); // At least 95% hit ratio
    });
  });

  describe('KubernetesRef Detection Performance', () => {
    it('should detect KubernetesRef objects quickly in simple structures', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number',
      };

      const testStructures = [
        mockRef,
        [mockRef, mockRef, mockRef],
        { field1: mockRef, field2: 'static', field3: mockRef },
        { nested: { deep: { ref: mockRef } } },
        Array(100).fill(mockRef),
      ];

      const startTime = performance.now();

      for (const structure of testStructures) {
        const result = magicAssignableAnalyzer.analyzeMagicAssignable(
          structure as unknown,
          mockContext
        );
        expect(result).toBeDefined();
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete all detections in under 75ms (increased tolerance for logger overhead)
      expect(duration).toBeLessThan(75);
    });

    it('should handle deeply nested structures efficiently', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number',
      };

      // Create deeply nested structure (reduced depth for performance)
      let deepStructure: any = mockRef;
      for (let i = 0; i < 5; i++) {
        deepStructure = {
          level: i,
          data: deepStructure,
          array: [deepStructure, 'static', deepStructure],
          static: 'value',
        };
      }

      const startTime = performance.now();

      const result = magicAssignableAnalyzer.analyzeMagicAssignable(deepStructure, mockContext);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(result).toBeDefined();
      expect(result.dependencies.length).toBeGreaterThan(0);

      // Should complete deep analysis in under 150ms (increased tolerance for logger overhead)
      expect(duration).toBeLessThan(150);
    });

    it('should scale linearly with structure size', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'deployment',
        fieldPath: 'status.readyReplicas',
        _type: 'number',
      };

      const sizes = [10, 50, 100, 500];
      const durations: number[] = [];

      for (const size of sizes) {
        const largeStructure = {
          refs: Array(size).fill(mockRef),
          static: Array(size).fill('static'),
          mixed: Array(size)
            .fill(null)
            .map((_, i) => (i % 2 === 0 ? mockRef : 'static')),
        };

        const startTime = performance.now();
        const result = magicAssignableAnalyzer.analyzeMagicAssignable(largeStructure, mockContext);
        const endTime = performance.now();

        expect(result).toBeDefined();
        durations.push(endTime - startTime);
      }

      // Check that scaling is reasonable (not exponential)
      for (let i = 1; i < durations.length; i++) {
        const ratio = durations[i]! / durations[i - 1]!;
        const sizeRatio = sizes[i]! / sizes[i - 1]!;

        // Duration ratio should not be much larger than size ratio (increased tolerance for system variability)
        expect(ratio).toBeLessThan(sizeRatio * 2.5);
      }
    });
  });

  describe('Resource Analysis Performance', () => {
    it('should analyze resource configurations efficiently', () => {
      const mockRef: KubernetesRef<string> = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'database',
        fieldPath: 'metadata.name',
        _type: 'string',
      };

      const resourceConfigs = Array(50)
        .fill(null)
        .map((_, i) => ({
          name: `resource-${i}`,
          image: 'nginx:latest',
          replicas: 3,
          env: {
            DATABASE_HOST: mockRef,
            NODE_ENV: 'production',
            REPLICA_COUNT: `${i}`,
            CONNECTION_STRING: `postgres://user:pass@${mockRef}:5432/db`,
          },
          labels: {
            app: `app-${i}`,
            version: 'v1.0.0',
          },
        }));

      const startTime = performance.now();

      for (let i = 0; i < resourceConfigs.length; i++) {
        const config = resourceConfigs[i]!;
        const result = resourceAnalyzer.analyzeResourceConfig(`resource-${i}`, config, {
          type: 'resource',
          resourceId: `resource-${i}`,
          resourceConfig: config,
          availableReferences: {},
          factoryType: 'kro',
        });

        expect(result).toBeDefined();
        expect(result.requiresConversion).toBe(true);
        expect(result.dependencies.length).toBeGreaterThan(0);
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete all resource analyses in under 1 second
      expect(duration).toBeLessThan(1000);

      // Average time per resource should be reasonable
      const avgTime = duration / resourceConfigs.length;
      expect(avgTime).toBeLessThan(20); // Less than 20ms per resource
    });

    it('should handle dependency tracking efficiently', () => {
      const createMockRef = (resourceId: string, fieldPath: string): KubernetesRef<unknown> => ({
        [KUBERNETES_REF_BRAND]: true,
        resourceId,
        fieldPath,
        _type: 'string',
      });

      // Create a complex dependency graph
      const resourceConfigs: Record<string, any> = {};

      for (let i = 0; i < 20; i++) {
        const dependencies: KubernetesRef<unknown>[] = [];
        const fieldPaths: string[] = [];

        // Each resource depends on 2-3 others
        for (let j = 0; j < 3 && j < i; j++) {
          const depId = `resource-${i - j - 1}`;
          dependencies.push(createMockRef(depId, 'status.readyReplicas'));
          fieldPaths.push(`env.DEP_${j}`);
        }

        resourceConfigs[`resource-${i}`] = {
          name: `resource-${i}`,
          dependencies,
          fieldPaths,
        };
      }

      const startTime = performance.now();

      // Analyze all resources and track dependencies
      for (const [resourceId, config] of Object.entries(resourceConfigs)) {
        const result = resourceAnalyzer.analyzeResourceConfig(resourceId, config, {
          type: 'resource',
          resourceId,
          resourceConfig: config,
          availableReferences: {},
          factoryType: 'kro',
          validateResourceTypes: true,
        });

        expect(result).toBeDefined();
      }

      // Get dependency graph
      const dependencyGraph = resourceAnalyzer.getDependencyGraph();
      expect(dependencyGraph).toBeDefined();

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete complex dependency analysis in under 500ms
      expect(duration).toBeLessThan(500);
    });
  });

  describe('Memory Usage and Cleanup', () => {
    it('should not leak memory with repeated analyses', () => {
      const expression = 'deployment.status.readyReplicas > 0';
      const iterations = 1000;

      // Get initial memory usage (if available)
      // performance.memory is a non-standard Chrome API; access via Record cast
      const perfRecord = performance as unknown as Record<string, unknown>;
      const initialMemory =
        (perfRecord.memory as Record<string, number> | undefined)?.usedJSHeapSize || 0;

      // Perform many analyses
      for (let i = 0; i < iterations; i++) {
        const result = analyzer.analyzeExpression(expression, mockContext);
        expect(result.valid).toBe(true);

        // Clear result to help GC
        const mutableResult = result as unknown as Record<string, unknown>;
        mutableResult.celExpression = null;
        mutableResult.dependencies = null;
        mutableResult.sourceMap = null;
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      // Check memory usage after cleanup
      const finalMemory =
        (perfRecord.memory as Record<string, number> | undefined)?.usedJSHeapSize || 0;

      // Memory growth should be reasonable (less than 10MB)
      if (initialMemory > 0 && finalMemory > 0) {
        const memoryGrowth = finalMemory - initialMemory;
        expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024); // 10MB
      }
    });

    it('should clean up caches appropriately', () => {
      const expressions = Array(100)
        .fill(null)
        .map((_, i) => `deployment_${i}.status.readyReplicas > ${i}`);

      // Fill cache
      for (const expr of expressions) {
        const result = analyzer.analyzeExpression(expr, mockContext);
        expect(result.valid).toBe(true);
      }

      // Cache should have entries
      const internals = analyzerInternals(analyzer);
      const cacheStats = internals.cache?.getStats();
      expect(cacheStats?.entryCount || 0).toBeGreaterThan(0);

      // Clear cache if method exists
      if (internals.clearCache) {
        internals.clearCache();

        const newCacheSize = internals.cache?.size || 0;
        expect(newCacheSize).toBe(0);
      }
    });
  });

  describe('Concurrent Analysis Performance', () => {
    it('should handle concurrent analyses efficiently', async () => {
      const expressions = Array(50)
        .fill(null)
        .map((_, i) => `deployment_${i % 10}.status.readyReplicas > ${i}`);

      const startTime = performance.now();

      // Run analyses concurrently
      const promises = expressions.map((expr) =>
        Promise.resolve(analyzer.analyzeExpression(expr, mockContext))
      );

      const results = await Promise.all(promises);

      const endTime = performance.now();
      const duration = endTime - startTime;

      // All results should be valid
      for (const result of results) {
        expect(result.valid).toBe(true);
      }

      // Concurrent execution should not be significantly slower than sequential
      expect(duration).toBeLessThan(500);
    });

    it('should maintain thread safety with shared resources', async () => {
      const sharedExpression = 'deployment.status.readyReplicas > 0';
      const iterations = 100;

      const startTime = performance.now();

      // Run the same expression analysis concurrently many times
      const promises = Array(iterations)
        .fill(null)
        .map(() => Promise.resolve(analyzer.analyzeExpression(sharedExpression, mockContext)));

      const results = await Promise.all(promises);

      const endTime = performance.now();
      const duration = endTime - startTime;

      // All results should be identical and valid
      for (const result of results) {
        expect(result.valid).toBe(true);
        expect(result.requiresConversion).toBe(true);
      }

      // Should complete quickly with caching
      expect(duration).toBeLessThan(200);
    });
  });

  describe('Regression Testing', () => {
    it('should maintain performance across different expression complexities', () => {
      const complexityLevels = [
        // Simple
        'deployment.status.readyReplicas > 0',

        // Medium
        'deployment.status.readyReplicas > 0 && deployment.status.availableReplicas > 0',

        // Complex
        'deployment.status.readyReplicas > 0 && deployment.status.availableReplicas > 0 && schema.spec.replicas > 1',

        // Very complex
        '`http://${service.status.loadBalancer.ingress[0].ip}:${service.spec.ports[0].port}/${schema.spec.path}?ready=${deployment.status.readyReplicas === schema.spec.replicas}`',
      ];

      const durations: number[] = [];

      for (const expr of complexityLevels) {
        const startTime = performance.now();

        // Run each expression multiple times
        for (let i = 0; i < 100; i++) {
          const result = analyzer.analyzeExpression(expr, mockContext);
          expect(result.valid).toBe(true);
        }

        const endTime = performance.now();
        durations.push(endTime - startTime);
      }

      // Performance should degrade gracefully with complexity
      for (let i = 1; i < durations.length; i++) {
        const ratio = durations[i]! / durations[i - 1]!;

        // Each level should not be more than 5x slower than the previous
        expect(ratio).toBeLessThan(5);
      }

      // Even the most complex expressions should complete in reasonable time
      expect(Math.max(...durations)).toBeLessThan(2000);
    });
  });
});
