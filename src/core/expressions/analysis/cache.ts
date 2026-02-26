/**
 * Advanced caching system for JavaScript to CEL expression conversion
 * Provides multi-level caching with performance monitoring and memory management
 */

import type { CelConversionResult, AnalysisContext } from './analyzer.js';

/**
 * Cache entry with metadata for performance monitoring and TTL
 */
interface CacheEntry {
  result: CelConversionResult;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  size: number; // Estimated memory size in bytes
}

/**
 * AST cache entry for parsed expressions
 */
interface ASTCacheEntry {
  ast: any;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  size: number;
}

/**
 * Cache statistics for performance monitoring
 */
export interface CacheStats {
  // Hit/Miss ratios
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRatio: number;

  // Memory usage
  totalMemoryUsage: number;
  maxMemoryUsage: number;
  entryCount: number;

  // Performance metrics
  averageRetrievalTime: number;
  totalRetrievalTime: number;

  // AST cache stats
  astCacheHits: number;
  astCacheMisses: number;
  astEntryCount: number;
  astMemoryUsage: number;

  // Cleanup stats
  totalEvictions: number;
  lastCleanupTime: number;
}

/**
 * Cache configuration options
 */
export interface CacheOptions {
  maxEntries?: number;
  maxMemoryMB?: number;
  ttlMs?: number;
  cleanupIntervalMs?: number;
  enableASTCache?: boolean;
  enableMetrics?: boolean;
}

/**
 * Advanced multi-level cache for expression conversion results
 */
export class ExpressionCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly astCache = new Map<string, ASTCacheEntry>();
  private readonly options: Required<CacheOptions>;
  private cleanupTimer?: NodeJS.Timeout | undefined;

  private stats: CacheStats = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitRatio: 0,
    totalMemoryUsage: 0,
    maxMemoryUsage: 0,
    entryCount: 0,
    averageRetrievalTime: 0,
    totalRetrievalTime: 0,
    astCacheHits: 0,
    astCacheMisses: 0,
    astEntryCount: 0,
    astMemoryUsage: 0,
    totalEvictions: 0,
    lastCleanupTime: Date.now()
  };

  constructor(options: CacheOptions = {}) {
    this.options = {
      maxEntries: options.maxEntries ?? 1000,
      maxMemoryMB: options.maxMemoryMB ?? 50,
      ttlMs: options.ttlMs ?? 5 * 60 * 1000, // 5 minutes
      cleanupIntervalMs: options.cleanupIntervalMs ?? 0, // Disable by default to prevent hanging
      enableASTCache: options.enableASTCache ?? true,
      enableMetrics: options.enableMetrics ?? true
    };

    if (this.options.cleanupIntervalMs > 0) {
      this.startCleanupTimer();
    }
  }

  /**
   * Get cached conversion result
   */
  get(expression: string, context: AnalysisContext): CelConversionResult | null {
    const startTime = this.options.enableMetrics ? performance.now() : 0;

    try {
      this.stats.totalRequests++;

      const key = this.createCacheKey(expression, context);
      const entry = this.cache.get(key);

      if (!entry) {
        this.stats.cacheMisses++;
        return null;
      }

      // Check TTL
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        this.updateMemoryUsage();
        this.stats.cacheMisses++;
        return null;
      }

      // Update access metadata
      entry.accessCount++;
      entry.lastAccessed = Date.now();

      this.stats.cacheHits++;
      this.updateHitRatio();

      return entry.result;
    } finally {
      if (this.options.enableMetrics) {
        const duration = performance.now() - startTime;
        this.stats.totalRetrievalTime += duration;
        this.stats.averageRetrievalTime = this.stats.totalRetrievalTime / this.stats.totalRequests;
      }
    }
  }

  /**
   * Store conversion result in cache
   */
  set(expression: string, context: AnalysisContext, result: CelConversionResult): void {
    const key = this.createCacheKey(expression, context);
    const size = this.estimateSize(result);

    const entry: CacheEntry = {
      result,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccessed: Date.now(),
      size
    };

    // Check if we need to evict entries before adding
    this.ensureCapacity(size);

    this.cache.set(key, entry);
    this.updateMemoryUsage();
    this.stats.entryCount = this.cache.size;
  }

  /**
   * Get cached AST
   */
  getAST(expression: string): any | null {
    if (!this.options.enableASTCache) {
      return null;
    }

    const entry = this.astCache.get(expression);

    if (!entry) {
      this.stats.astCacheMisses++;
      return null;
    }

    // Check TTL
    if (this.isExpired(entry)) {
      this.astCache.delete(expression);
      this.updateASTMemoryUsage();
      this.stats.astCacheMisses++;
      return null;
    }

    // Update access metadata
    entry.accessCount++;
    entry.lastAccessed = Date.now();

    this.stats.astCacheHits++;
    return entry.ast;
  }

  /**
   * Store AST in cache
   */
  setAST(expression: string, ast: any): void {
    if (!this.options.enableASTCache) {
      return;
    }

    const size = this.estimateASTSize(ast);

    const entry: ASTCacheEntry = {
      ast,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccessed: Date.now(),
      size
    };

    this.astCache.set(expression, entry);
    this.updateASTMemoryUsage();
    this.stats.astEntryCount = this.astCache.size;
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.cache.clear();
    this.astCache.clear();
    this.resetStats();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Force cleanup of expired entries
   */
  cleanup(): number {
    const _startTime = Date.now();
    let evicted = 0;

    // Cleanup main cache
    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        evicted++;
      }
    }

    // Cleanup AST cache
    for (const [key, entry] of this.astCache.entries()) {
      if (this.isExpired(entry)) {
        this.astCache.delete(key);
        evicted++;
      }
    }

    this.updateMemoryUsage();
    this.updateASTMemoryUsage();
    this.stats.totalEvictions += evicted;
    this.stats.lastCleanupTime = Date.now();
    this.stats.entryCount = this.cache.size;
    this.stats.astEntryCount = this.astCache.size;

    return evicted;
  }

  /**
   * Destroy cache and cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
  }

  /**
   * Create cache key from expression and context
   */
  private createCacheKey(expression: string, context: AnalysisContext): string {
    const contextHash = this.hashContext(context);
    return `${expression}:${contextHash}`;
  }

  /**
   * Create hash of analysis context for cache key
   */
  private hashContext(context: AnalysisContext): string {
    // Create a deterministic hash of the context
    const contextData = {
      type: context.type,
      availableReferences: Object.keys(context.availableReferences || {}).sort(),
      factoryType: context.factoryType || 'direct'
    };

    return this.simpleHash(JSON.stringify(contextData));
  }

  /**
   * Simple hash function for strings
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Check if cache entry is expired
   */
  private isExpired(entry: CacheEntry | ASTCacheEntry): boolean {
    return Date.now() - entry.timestamp > this.options.ttlMs;
  }

  /**
   * Estimate memory size of conversion result
   */
  private estimateSize(result: CelConversionResult): number {
    // Rough estimation of memory usage
    let size = 0;

    if (result.celExpression) {
      size += result.celExpression.expression.length * 2; // UTF-16
    }

    size += result.dependencies.reduce((acc, dep) => acc + (dep.resourceId?.length || 0) * 2 + (dep.fieldPath?.length || 0) * 2 + 50, 0);
    size += result.sourceMap.length * 100; // Rough estimate for source map entries
    size += result.errors.length * 200; // Rough estimate for error objects

    return size;
  }

  /**
   * Estimate memory size of AST
   */
  private estimateASTSize(ast: any): number {
    // Very rough estimation - could be improved with recursive traversal
    return JSON.stringify(ast).length * 2;
  }

  /**
   * Ensure cache has capacity for new entry
   */
  private ensureCapacity(newEntrySize: number): void {
    const maxMemoryBytes = this.options.maxMemoryMB * 1024 * 1024;

    // Check memory limit
    while (this.stats.totalMemoryUsage + newEntrySize > maxMemoryBytes && this.cache.size > 0) {
      this.evictLRU();
    }

    // Check entry count limit
    while (this.cache.size >= this.options.maxEntries) {
      this.evictLRU();
    }
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.totalEvictions++;
      this.updateMemoryUsage();
    }
  }

  /**
   * Update memory usage statistics
   */
  private updateMemoryUsage(): void {
    let totalSize = 0;
    for (const entry of this.cache.values()) {
      totalSize += entry.size;
    }
    this.stats.totalMemoryUsage = totalSize;
    this.stats.maxMemoryUsage = Math.max(this.stats.maxMemoryUsage, totalSize);
  }

  /**
   * Update AST memory usage statistics
   */
  private updateASTMemoryUsage(): void {
    let totalSize = 0;
    for (const entry of this.astCache.values()) {
      totalSize += entry.size;
    }
    this.stats.astMemoryUsage = totalSize;
  }

  /**
   * Update hit ratio statistics
   */
  private updateHitRatio(): void {
    this.stats.hitRatio = this.stats.totalRequests > 0
      ? this.stats.cacheHits / this.stats.totalRequests
      : 0;
  }

  /**
   * Reset statistics
   */
  private resetStats(): void {
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hitRatio: 0,
      totalMemoryUsage: 0,
      maxMemoryUsage: 0,
      entryCount: 0,
      averageRetrievalTime: 0,
      totalRetrievalTime: 0,
      astCacheHits: 0,
      astCacheMisses: 0,
      astEntryCount: 0,
      astMemoryUsage: 0,
      totalEvictions: 0,
      lastCleanupTime: Date.now()
    };
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.options.cleanupIntervalMs);
  }
}

/**
 * Global cache instance for expression conversion
 */
export const globalExpressionCache = new ExpressionCache();