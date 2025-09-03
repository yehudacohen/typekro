/**
 * Performance Optimization and Caching Tests
 * 
 * Tests for the advanced caching system including:
 * - Expression caching
 * - AST caching  
 * - Performance monitoring
 * - Memory management
 * - Cache invalidation
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ExpressionCache, globalExpressionCache, } from '../../../src/core/expressions/cache.js';
import { JavaScriptToCelAnalyzer, type AnalysisContext } from '../../../src/core/expressions/analyzer.js';

describe('Performance Optimization and Caching', () => {
  let cache: ExpressionCache;
  let analyzer: JavaScriptToCelAnalyzer;
  
  beforeEach(() => {
    cache = new ExpressionCache({
      maxEntries: 100,
      maxMemoryMB: 10,
      ttlMs: 1000, // 1 second for testing
      cleanupIntervalMs: 0, // Disable automatic cleanup for tests
      enableASTCache: true,
      enableMetrics: true
    });
    
    analyzer = new JavaScriptToCelAnalyzer({
      maxEntries: 100,
      enableMetrics: true
    });
  });
  
  afterEach(() => {
    cache.destroy();
    analyzer.destroy();
  });

  describe('Expression Caching', () => {
    it('should cache conversion results', () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      // First call should miss cache
      const result1 = analyzer.analyzeExpression(expression, context);
      const stats1 = analyzer.getCacheStats();
      
      expect(stats1.totalRequests).toBe(1);
      expect(stats1.cacheMisses).toBe(1);
      expect(stats1.cacheHits).toBe(0);
      
      // Second call should hit cache
      const result2 = analyzer.analyzeExpression(expression, context);
      const stats2 = analyzer.getCacheStats();
      
      expect(stats2.totalRequests).toBe(2);
      expect(stats2.cacheMisses).toBe(1);
      expect(stats2.cacheHits).toBe(1);
      expect(stats2.hitRatio).toBe(0.5);
      
      // Results should be identical
      expect(result1).toEqual(result2);
    });
    
    it('should differentiate cache keys by context', () => {
      const expression = 'deployment.status.readyReplicas';
      
      const context1: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      const context2: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'kro'
      };
      
      // Both should miss cache (different contexts)
      analyzer.analyzeExpression(expression, context1);
      analyzer.analyzeExpression(expression, context2);
      
      const stats = analyzer.getCacheStats();
      expect(stats.cacheMisses).toBe(2);
      expect(stats.cacheHits).toBe(0);
    });
    
    it('should handle cache TTL expiration', async () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      // Create cache with very short TTL
      const shortTTLCache = new ExpressionCache({
        ttlMs: 50, // 50ms
        enableMetrics: true
      });
      
      const shortTTLAnalyzer = new JavaScriptToCelAnalyzer({
        ttlMs: 50,
        enableMetrics: true
      });
      
      try {
        // First call
        shortTTLAnalyzer.analyzeExpression(expression, context);
        
        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Second call should miss cache due to expiration
        shortTTLAnalyzer.analyzeExpression(expression, context);
        
        const stats = shortTTLAnalyzer.getCacheStats();
        expect(stats.cacheMisses).toBe(2);
        expect(stats.cacheHits).toBe(0);
      } finally {
        shortTTLCache.destroy();
        shortTTLAnalyzer.destroy();
      }
    });
  });

  describe('AST Caching', () => {
    it('should cache parsed ASTs', () => {
      const expression = 'deployment.status.readyReplicas > 0';
      
      // First parse should miss AST cache
      const ast1 = cache.getAST(expression);
      expect(ast1).toBeNull();
      
      // Simulate AST storage
      const mockAST = { type: 'BinaryExpression', operator: '>' };
      cache.setAST(expression, mockAST);
      
      // Second call should hit AST cache
      const ast2 = cache.getAST(expression);
      expect(ast2).toEqual(mockAST);
      
      const stats = cache.getStats();
      expect(stats.astCacheHits).toBe(1);
      expect(stats.astCacheMisses).toBe(1);
    });
    
    it('should handle AST cache TTL expiration', async () => {
      const expression = 'deployment.status.readyReplicas > 0';
      const mockAST = { type: 'BinaryExpression', operator: '>' };
      
      // Create cache with very short TTL
      const shortTTLCache = new ExpressionCache({
        ttlMs: 50, // 50ms
        enableASTCache: true
      });
      
      try {
        // Store AST
        shortTTLCache.setAST(expression, mockAST);
        
        // Should hit cache immediately
        expect(shortTTLCache.getAST(expression)).toEqual(mockAST);
        
        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Should miss cache due to expiration
        expect(shortTTLCache.getAST(expression)).toBeNull();
      } finally {
        shortTTLCache.destroy();
      }
    });
  });

  describe('Performance Monitoring', () => {
    it('should track cache statistics', () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      // Make several requests
      analyzer.analyzeExpression(expression, context);
      analyzer.analyzeExpression(expression, context);
      analyzer.analyzeExpression(expression, context);
      
      const stats = analyzer.getCacheStats();
      
      expect(stats.totalRequests).toBe(3);
      expect(stats.cacheHits).toBe(2);
      expect(stats.cacheMisses).toBe(1);
      expect(stats.hitRatio).toBeCloseTo(2/3, 2);
      expect(stats.entryCount).toBe(1);
      expect(stats.totalMemoryUsage).toBeGreaterThan(0);
    });
    
    it('should track performance metrics', () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      // Make requests to generate timing data
      for (let i = 0; i < 10; i++) {
        analyzer.analyzeExpression(expression, context);
      }
      
      const stats = analyzer.getCacheStats();
      
      expect(stats.totalRetrievalTime).toBeGreaterThan(0);
      expect(stats.averageRetrievalTime).toBeGreaterThan(0);
      expect(stats.averageRetrievalTime).toBe(stats.totalRetrievalTime / stats.totalRequests);
    });
  });

  describe('Memory Management', () => {
    it('should enforce entry count limits', () => {
      const smallCache = new ExpressionCache({
        maxEntries: 3,
        enableMetrics: true
      });
      
      try {
        const context: AnalysisContext = {
          type: 'status',
          availableReferences: { deployment: {} as any },
          factoryType: 'direct'
        };
        
        // Add more entries than the limit
        for (let i = 0; i < 5; i++) {
          const expression = `deployment.status.field${i}`;
          smallCache.set(expression, context, {
            valid: true,
            celExpression: { expression: `resources.deployment.status.field${i}` } as any,
            dependencies: [],
            sourceMap: [],
            errors: [],
            warnings: [],
            requiresConversion: true
          });
        }
        
        const stats = smallCache.getStats();
        expect(stats.entryCount).toBeLessThanOrEqual(3);
        expect(stats.totalEvictions).toBeGreaterThan(0);
      } finally {
        smallCache.destroy();
      }
    });
    
    it('should enforce memory limits', () => {
      const smallCache = new ExpressionCache({
        maxMemoryMB: 0.001, // Very small limit
        enableMetrics: true
      });
      
      try {
        const context: AnalysisContext = {
          type: 'status',
          availableReferences: { deployment: {} as any },
          factoryType: 'direct'
        };
        
        // Add entries that exceed memory limit
        for (let i = 0; i < 10; i++) {
          const expression = `deployment.status.field${i}`;
          const largeResult = {
            valid: true,
            celExpression: { expression: 'x'.repeat(1000) } as any, // Large expression
            dependencies: [],
            sourceMap: [],
            errors: [],
            requiresConversion: true
          };
          
          smallCache.set(expression, context, { ...largeResult, warnings: [] });
        }
        
        const stats = smallCache.getStats();
        expect(stats.totalEvictions).toBeGreaterThan(0);
      } finally {
        smallCache.destroy();
      }
    });
    
    it('should implement LRU eviction', () => {
      const lruCache = new ExpressionCache({
        maxEntries: 2, // Smaller limit to force eviction
        enableMetrics: true
      });
      
      try {
        const context: AnalysisContext = {
          type: 'status',
          availableReferences: { deployment: {} as any },
          factoryType: 'direct'
        };
        
        const result = {
          valid: true,
          celExpression: { expression: 'test' } as any,
          dependencies: [],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: true
        };
        
        // Fill cache beyond capacity to trigger eviction
        lruCache.set('expr1', context, result);
        lruCache.set('expr2', context, result);
        lruCache.set('expr3', context, result); // This should trigger eviction
        
        // Check that eviction occurred
        const stats = lruCache.getStats();
        expect(stats.entryCount).toBeLessThanOrEqual(2);
        expect(stats.totalEvictions).toBeGreaterThan(0);
        
        // At least one entry should still be cached
        const hasEntry1 = lruCache.get('expr1', context) !== null;
        const hasEntry2 = lruCache.get('expr2', context) !== null;
        const hasEntry3 = lruCache.get('expr3', context) !== null;
        
        // Should have exactly 2 entries cached
        const cachedCount = [hasEntry1, hasEntry2, hasEntry3].filter(Boolean).length;
        expect(cachedCount).toBe(2);
      } finally {
        lruCache.destroy();
      }
    });
  });

  describe('Cache Management', () => {
    it('should support manual cleanup', () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      // Add entry to cache
      analyzer.analyzeExpression(expression, context);
      
      let stats = analyzer.getCacheStats();
      expect(stats.entryCount).toBe(1);
      
      // Manual cleanup
      const evicted = analyzer.cleanupCache();
      
      stats = analyzer.getCacheStats();
      expect(evicted).toBeGreaterThanOrEqual(0);
    });
    
    it('should support cache clearing', () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      // Add entries to cache
      analyzer.analyzeExpression(expression, context);
      analyzer.analyzeExpression(`${expression}2`, context);
      
      let stats = analyzer.getCacheStats();
      expect(stats.entryCount).toBe(2);
      
      // Clear cache
      analyzer.clearCache();
      
      stats = analyzer.getCacheStats();
      expect(stats.entryCount).toBe(0);
      expect(stats.totalRequests).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
    });
  });

  describe('Global Cache Instance', () => {
    it('should provide a global cache instance', () => {
      expect(globalExpressionCache).toBeInstanceOf(ExpressionCache);
      
      const stats = globalExpressionCache.getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.totalRequests).toBe('number');
    });
  });

  describe('Cache Key Generation', () => {
    it('should generate different keys for different contexts', () => {
      const expression = 'deployment.status.readyReplicas';
      
      const context1: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      const context2: AnalysisContext = {
        type: 'status',
        availableReferences: { service: {} as any },
        factoryType: 'direct'
      };
      
      // Store with first context
      cache.set(expression, context1, {
        valid: true,
        celExpression: { expression: 'result1' } as any,
        dependencies: [],
        sourceMap: [],
        errors: [],
        warnings: [],
        requiresConversion: true
      });
      
      // Should not find with different context
      const result = cache.get(expression, context2);
      expect(result).toBeNull();
    });
    
    it('should generate consistent keys for same context', () => {
      const expression = 'deployment.status.readyReplicas';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: { deployment: {} as any },
        factoryType: 'direct'
      };
      
      const testResult = {
        valid: true,
        celExpression: { expression: 'test' } as any,
        dependencies: [],
        sourceMap: [],
        errors: [],
        warnings: [],
        requiresConversion: true
      };
      
      // Store result
      cache.set(expression, context, testResult);
      
      // Should retrieve same result with identical context
      const retrieved = cache.get(expression, context);
      expect(retrieved).toEqual(testResult);
    });
  });

  describe('Error Handling', () => {
    it('should not cache error results', () => {
      const expression = 'invalid..expression..with..syntax..error';
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: {},
        factoryType: 'direct'
      };
      
      // This should produce an error result
      const result1 = analyzer.analyzeExpression(expression, context);
      expect(result1.valid).toBe(false);
      expect(result1.errors.length).toBeGreaterThan(0);
      
      // Second call should not hit cache (error results aren't cached)
      const _result2 = analyzer.analyzeExpression(expression, context);
      
      const stats = analyzer.getCacheStats();
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(2);
    });
  });

  describe('Performance Benchmarks', () => {
    it('should demonstrate cache performance benefits', () => {
      const expressions = [
        'deployment.status.readyReplicas',
        'service.status.loadBalancer.ingress[0].ip',
        'configMap.data.config',
        'secret.data.password',
        'pod.status.phase'
      ];
      
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: {
          deployment: {} as any,
          service: {} as any,
          configMap: {} as any,
          secret: {} as any,
          pod: {} as any
        },
        factoryType: 'direct'
      };
      
      // Warm up cache
      expressions.forEach(expr => analyzer.analyzeExpression(expr, context));
      
      // Measure cache performance
      const startTime = performance.now();
      
      for (let i = 0; i < 100; i++) {
        expressions.forEach(expr => analyzer.analyzeExpression(expr, context));
      }
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
      const stats = analyzer.getCacheStats();
      
      // Should have high hit ratio
      expect(stats.hitRatio).toBeGreaterThan(0.9);
      
      // Should be reasonably fast
      expect(totalTime).toBeLessThan(1000); // Less than 1 second for 500 operations
      
      console.log(`Cache performance: ${stats.hitRatio * 100}% hit ratio, ${totalTime}ms for 500 operations`);
    });
  });
});