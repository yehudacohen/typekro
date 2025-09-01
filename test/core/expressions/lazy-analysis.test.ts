/**
 * Tests for Lazy Analysis Support
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  LazyAnalyzedExpression,
  LazyExpressionCollection,
  OnDemandExpressionAnalyzer,
  ExpressionTreeAnalyzer,
  MemoryOptimizedExpressionManager,
  ParallelExpressionAnalyzer,
  createLazyExpression,
  createLazyCollection,
  shouldUseLazyAnalysis
} from '../../../src/core/expressions/lazy-analysis.js';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';
import { KUBERNETES_REF_BRAND } from '../../../src/core/constants/brands.js';
import type { KubernetesRef } from '../../../src/core/types/common.js';
import { containsKubernetesRefs } from '../../../src/utils/type-guards.js';

describe('Lazy Analysis Support', () => {
  let analyzer: JavaScriptToCelAnalyzer;
  let context: AnalysisContext;

  beforeEach(() => {
    analyzer = new JavaScriptToCelAnalyzer();
    context = {
      type: 'status',
      availableReferences: {},
      factoryType: 'kro'
    };
  });

  describe('LazyAnalyzedExpression', () => {
    it('should defer analysis until result is accessed', () => {
      const expression = 'test expression';
      const lazy = new LazyAnalyzedExpression(expression, context, analyzer);

      expect(lazy.isAnalyzed).toBe(false);
      expect(lazy.originalExpression).toBe(expression);
      
      // Accessing result should trigger analysis
      const result = lazy.result;
      expect(lazy.isAnalyzed).toBe(true);
      expect(result).toBeDefined();
    });

    it('should detect static expressions without KubernetesRef objects', () => {
      const staticExpression = 'static value';
      const lazy = new LazyAnalyzedExpression(staticExpression, context, analyzer);

      expect(lazy.isStatic).toBe(true);
      expect(lazy.requiresConversion).toBe(false);
    });

    it('should detect expressions with KubernetesRef objects', () => {
      const kubernetesRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test-resource',
        fieldPath: 'status.ready',
        _type: 'string'
      } as KubernetesRef<string>;

      const lazy = new LazyAnalyzedExpression(kubernetesRef, context, analyzer);

      expect(lazy.isStatic).toBe(false);
      expect(lazy.requiresConversion).toBe(true);
    });

    it('should allow context switching', () => {
      const expression = 'test';
      const lazy = new LazyAnalyzedExpression(expression, context, analyzer);
      
      const newContext: AnalysisContext = {
        ...context,
        type: 'resource'
      };
      
      const newLazy = lazy.withContext(newContext);
      expect(newLazy.context.type).toBe('resource');
      expect(newLazy.originalExpression).toBe(expression);
    });

    it('should handle analysis errors gracefully', () => {
      // Create an expression that will cause parsing to fail
      const invalidExpression = 'invalid javascript syntax !!!';
      const lazy = new LazyAnalyzedExpression(invalidExpression, context, analyzer);

      const tryResult = lazy.tryGetResult();
      // The analyzer should handle this gracefully and return a result
      // Even if parsing fails, it should not throw an error in tryGetResult
      expect(tryResult.success).toBe(true);
      expect(tryResult.result).toBeDefined();
    });
  });

  describe('LazyExpressionCollection', () => {
    it('should manage multiple lazy expressions', () => {
      const collection = createLazyCollection(analyzer);
      
      collection.add('expr1', 'expression 1', context);
      collection.add('expr2', 'expression 2', context);
      
      expect(collection.size).toBe(2);
      expect(collection.has('expr1')).toBe(true);
      expect(collection.has('expr2')).toBe(true);
    });

    it('should track static vs conversion-required expressions', () => {
      const collection = createLazyCollection(analyzer);
      
      collection.add('static', 'static value', context);
      
      const kubernetesRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test',
        fieldPath: 'status.ready',
        _type: 'string'
      } as KubernetesRef<string>;
      collection.add('dynamic', kubernetesRef, context);
      
      expect(collection.staticCount).toBe(1);
      expect(collection.requiresConversionCount).toBe(1);
    });

    it('should provide collection statistics', () => {
      const collection = createLazyCollection(analyzer);
      
      collection.add('expr1', 'test1', context);
      collection.add('expr2', 'test2', context);
      
      const stats = collection.getStats();
      expect(stats.total).toBe(2);
      expect(stats.static).toBe(2);
      expect(stats.requiresConversion).toBe(0);
      expect(stats.analyzed).toBe(0);
    });
  });

  describe('OnDemandExpressionAnalyzer', () => {
    it('should create lazy expressions on demand', () => {
      const onDemand = new OnDemandExpressionAnalyzer(analyzer);
      
      const lazy = onDemand.createLazyExpression('test expression', context);
      expect(lazy).toBeInstanceOf(LazyAnalyzedExpression);
      expect(lazy.isAnalyzed).toBe(false);
    });

    it('should cache lazy expressions', () => {
      const onDemand = new OnDemandExpressionAnalyzer(analyzer);
      
      const lazy1 = onDemand.createLazyExpression('test', context, 'cache-key');
      const lazy2 = onDemand.createLazyExpression('test', context, 'cache-key');
      
      expect(lazy1).toBe(lazy2); // Should be the same instance from cache
      
      const stats = onDemand.getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('should analyze expressions only if they need conversion', () => {
      const onDemand = new OnDemandExpressionAnalyzer(analyzer);
      
      const staticResult = onDemand.analyzeIfNeeded('static value', context);
      expect(staticResult.needsConversion).toBe(false);
      expect(staticResult.result).toBe('static value');
      
      const kubernetesRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test',
        fieldPath: 'status.ready',
        _type: 'string'
      } as KubernetesRef<string>;
      
      const dynamicResult = onDemand.analyzeIfNeeded(kubernetesRef, context);
      expect(dynamicResult.needsConversion).toBe(true);
      expect(dynamicResult.lazy).toBeInstanceOf(LazyAnalyzedExpression);
    });
  });

  describe('ExpressionTreeAnalyzer', () => {
    it('should analyze simple expression trees', () => {
      const treeAnalyzer = new ExpressionTreeAnalyzer(analyzer);
      
      const simpleTree = {
        static: 'value',
        number: 42
      };
      
      const result = treeAnalyzer.analyzeTree(simpleTree, context);
      expect(result.needsConversion).toBe(false);
      expect(result.staticValue).toEqual(simpleTree);
    });

    it('should detect KubernetesRef objects in complex trees', () => {
      const treeAnalyzer = new ExpressionTreeAnalyzer(analyzer);
      
      const kubernetesRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'test',
        fieldPath: 'status.ready',
        _type: 'string'
      } as KubernetesRef<string>;
      
      // First verify that containsKubernetesRefs works on the ref itself
      expect(containsKubernetesRefs(kubernetesRef)).toBe(true);
      
      const complexTree = {
        static: 'value',
        dynamic: kubernetesRef,
        nested: {
          more: kubernetesRef
        }
      };
      
      // Verify that containsKubernetesRefs works on the complex tree
      expect(containsKubernetesRefs(complexTree)).toBe(true);
      
      const result = treeAnalyzer.analyzeTree(complexTree, context);
      expect(result.needsConversion).toBe(true);
      expect(result.lazyExpression).toBeDefined();
    });

    it('should provide tree statistics', () => {
      const treeAnalyzer = new ExpressionTreeAnalyzer(analyzer);
      
      const tree = {
        level1: {
          level2: {
            value: 'deep'
          }
        }
      };
      
      const result = treeAnalyzer.analyzeTree(tree, context);
      const stats = treeAnalyzer.getTreeStats(result);
      
      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.maxDepth).toBeGreaterThan(0);
    });
  });

  describe('MemoryOptimizedExpressionManager', () => {
    it('should manage expressions with memory limits', () => {
      const memoryManager = new MemoryOptimizedExpressionManager(analyzer, {
        maxMemoryUsage: 1024, // 1KB limit
        cleanupThreshold: 0.8
      });
      
      const expr = memoryManager.getOrCreateExpression('test', 'test expression', context);
      expect(expr).toBeInstanceOf(LazyAnalyzedExpression);
      
      const stats = memoryManager.getMemoryStats();
      expect(stats.totalExpressions).toBe(1);
      expect(stats.totalMemoryUsage).toBeGreaterThan(0);
    });

    it('should perform cleanup when memory threshold is reached', () => {
      const memoryManager = new MemoryOptimizedExpressionManager(analyzer, {
        maxMemoryUsage: 100, // Very small limit
        cleanupThreshold: 0.5
      });
      
      // Add multiple expressions to trigger cleanup
      for (let i = 0; i < 10; i++) {
        memoryManager.getOrCreateExpression(`expr${i}`, `expression ${i}`, context);
      }
      
      const cleanupResult = memoryManager.forceCleanup();
      expect(cleanupResult.duration).toBeGreaterThanOrEqual(0);
      expect(cleanupResult.freedMemory).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ParallelExpressionAnalyzer', () => {
    it('should analyze expressions in parallel', async () => {
      const parallelAnalyzer = new ParallelExpressionAnalyzer(analyzer, 2);
      
      const expressions = [
        { key: 'expr1', expression: 'test1', context },
        { key: 'expr2', expression: 'test2', context },
        { key: 'expr3', expression: 'test3', context }
      ];
      
      const results = await parallelAnalyzer.analyzeParallel(expressions);
      
      expect(results.size).toBe(3);
      expect(results.has('expr1')).toBe(true);
      expect(results.has('expr2')).toBe(true);
      expect(results.has('expr3')).toBe(true);
    });

    it('should handle prioritized analysis', async () => {
      const parallelAnalyzer = new ParallelExpressionAnalyzer(analyzer, 2);
      
      const expressions = [
        { key: 'low', expression: 'test1', context, priority: 1 },
        { key: 'high', expression: 'test2', context, priority: 10 },
        { key: 'medium', expression: 'test3', context, priority: 5 }
      ];
      
      const results = await parallelAnalyzer.analyzePrioritized(expressions);
      
      expect(results.size).toBe(3);
      // High priority should be processed first, but all should complete
      expect(results.has('high')).toBe(true);
      expect(results.has('medium')).toBe(true);
      expect(results.has('low')).toBe(true);
    });
  });

  describe('Utility Functions', () => {
    it('should determine when to use lazy analysis', () => {
      expect(shouldUseLazyAnalysis('short')).toBe(false);
      expect(shouldUseLazyAnalysis('a very long string that exceeds the threshold for lazy analysis')).toBe(true);
      expect(shouldUseLazyAnalysis({})).toBe(true);
      expect(shouldUseLazyAnalysis([])).toBe(true);
      expect(shouldUseLazyAnalysis(() => { /* empty function */ })).toBe(true);
    });

    it('should create lazy expressions with factory function', () => {
      const lazy = createLazyExpression('test', context, analyzer);
      expect(lazy).toBeInstanceOf(LazyAnalyzedExpression);
    });

    it('should create lazy collections with factory function', () => {
      const collection = createLazyCollection(analyzer);
      expect(collection).toBeInstanceOf(LazyExpressionCollection);
    });
  });
});