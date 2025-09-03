/**
 * Lazy Analysis Support for JavaScript to CEL Expression Conversion
 * 
 * This module provides lazy evaluation capabilities for expressions containing
 * KubernetesRef objects, optimizing performance by deferring analysis until
 * the results are actually needed.
 */

import type { KubernetesRef, CelExpression } from '../types/common.js';
import type { AnalysisContext, CelConversionResult } from './analyzer.js';
import { JavaScriptToCelAnalyzer } from './analyzer.js';
import { containsKubernetesRefs, extractResourceReferences } from '../../utils/type-guards.js';
import { ConversionError } from '../errors.js';
import { KUBERNETES_REF_BRAND } from '../constants/brands.js';

/**
 * Lazy wrapper for expressions that may contain KubernetesRef objects
 * Defers analysis until the CEL expression is actually needed
 */
export class LazyAnalyzedExpression {
  private _analyzed = false;
  private _result: CelConversionResult | null = null;
  private _error: Error | null = null;
  private readonly _analyzer: JavaScriptToCelAnalyzer;

  constructor(
    private readonly _expression: any,
    private readonly _context: AnalysisContext,
    analyzer?: JavaScriptToCelAnalyzer
  ) {
    this._analyzer = analyzer || new JavaScriptToCelAnalyzer();
  }

  /**
   * Get the original expression without triggering analysis
   */
  get originalExpression(): any {
    return this._expression;
  }

  /**
   * Get the analysis context
   */
  get context(): AnalysisContext {
    return this._context;
  }

  /**
   * Check if the expression has been analyzed yet
   */
  get isAnalyzed(): boolean {
    return this._analyzed;
  }

  /**
   * Check if the expression requires conversion (contains KubernetesRef objects)
   * This is a fast check that doesn't trigger full analysis
   */
  get requiresConversion(): boolean {
    return containsKubernetesRefs(this._expression);
  }

  /**
   * Check if the expression is static (no KubernetesRef objects)
   * This is a fast check that doesn't trigger analysis
   */
  get isStatic(): boolean {
    return !this.requiresConversion;
  }

  /**
   * Get the analysis result, triggering analysis if not already done
   */
  get result(): CelConversionResult {
    if (!this._analyzed) {
      this._performAnalysis();
    }

    if (this._error) {
      throw this._error;
    }

    return this._result!;
  }

  /**
   * Get the CEL expression, triggering analysis if needed
   */
  get celExpression(): CelExpression | null {
    return this.result.celExpression;
  }

  /**
   * Get the dependencies, triggering analysis if needed
   */
  get dependencies(): KubernetesRef<any>[] {
    return this.result.dependencies;
  }

  /**
   * Get conversion errors, triggering analysis if needed
   */
  get errors(): ConversionError[] {
    return this.result.errors;
  }

  /**
   * Check if the analysis was successful, triggering analysis if needed
   */
  get isValid(): boolean {
    return this.result.valid;
  }

  /**
   * Force analysis to occur immediately
   */
  analyze(): CelConversionResult {
    if (!this._analyzed) {
      this._performAnalysis();
    }

    if (this._error) {
      throw this._error;
    }

    return this._result!;
  }

  /**
   * Try to get the result without throwing errors
   */
  tryGetResult(): { success: boolean; result?: CelConversionResult; error?: Error } {
    try {
      const result = this.result;
      return { success: true, result };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  /**
   * Create a new lazy expression with a different context
   */
  withContext(newContext: AnalysisContext): LazyAnalyzedExpression {
    return new LazyAnalyzedExpression(this._expression, newContext, this._analyzer);
  }

  /**
   * Create a new lazy expression with a different analyzer
   */
  withAnalyzer(analyzer: JavaScriptToCelAnalyzer): LazyAnalyzedExpression {
    return new LazyAnalyzedExpression(this._expression, this._context, analyzer);
  }

  /**
   * Perform the actual analysis
   */
  private _performAnalysis(): void {
    try {
      this._result = this._analyzer.analyzeExpressionWithRefs(this._expression, this._context);
      this._analyzed = true;
    } catch (error) {
      this._error = error instanceof Error ? error : new Error(String(error));
      this._analyzed = true;
    }
  }

  /**
   * Reset the analysis state (for testing or re-analysis)
   */
  reset(): void {
    this._analyzed = false;
    this._result = null;
    this._error = null;
  }

  /**
   * Get a string representation for debugging
   */
  toString(): string {
    const exprStr = typeof this._expression === 'string' 
      ? this._expression 
      : JSON.stringify(this._expression);
    
    if (this._analyzed) {
      if (this._error) {
        return `LazyAnalyzedExpression(${exprStr}) [ERROR: ${this._error.message}]`;
      }
      return `LazyAnalyzedExpression(${exprStr}) [ANALYZED: ${this._result?.valid ? 'VALID' : 'INVALID'}]`;
    }
    
    return `LazyAnalyzedExpression(${exprStr}) [NOT ANALYZED]`;
  }
}

/**
 * Collection of lazy analyzed expressions for batch processing
 */
export class LazyExpressionCollection {
  private readonly _expressions = new Map<string, LazyAnalyzedExpression>();
  private readonly _analyzer: JavaScriptToCelAnalyzer;

  constructor(analyzer?: JavaScriptToCelAnalyzer) {
    this._analyzer = analyzer || new JavaScriptToCelAnalyzer();
  }

  /**
   * Add an expression to the collection
   */
  add(key: string, expression: any, context: AnalysisContext): LazyAnalyzedExpression {
    const lazy = new LazyAnalyzedExpression(expression, context, this._analyzer);
    this._expressions.set(key, lazy);
    return lazy;
  }

  /**
   * Get a lazy expression by key
   */
  get(key: string): LazyAnalyzedExpression | undefined {
    return this._expressions.get(key);
  }

  /**
   * Check if an expression exists
   */
  has(key: string): boolean {
    return this._expressions.has(key);
  }

  /**
   * Remove an expression
   */
  remove(key: string): boolean {
    return this._expressions.delete(key);
  }

  /**
   * Get all expression keys
   */
  keys(): string[] {
    return Array.from(this._expressions.keys());
  }

  /**
   * Get all lazy expressions
   */
  values(): LazyAnalyzedExpression[] {
    return Array.from(this._expressions.values());
  }

  /**
   * Get all entries
   */
  entries(): [string, LazyAnalyzedExpression][] {
    return Array.from(this._expressions.entries());
  }

  /**
   * Get the number of expressions
   */
  get size(): number {
    return this._expressions.size;
  }

  /**
   * Check how many expressions require conversion
   */
  get requiresConversionCount(): number {
    return this.values().filter(expr => expr.requiresConversion).length;
  }

  /**
   * Check how many expressions are static
   */
  get staticCount(): number {
    return this.values().filter(expr => expr.isStatic).length;
  }

  /**
   * Check how many expressions have been analyzed
   */
  get analyzedCount(): number {
    return this.values().filter(expr => expr.isAnalyzed).length;
  }

  /**
   * Analyze all expressions that require conversion
   */
  analyzeAll(): Map<string, CelConversionResult> {
    const results = new Map<string, CelConversionResult>();
    
    for (const [key, expr] of this._expressions) {
      if (expr.requiresConversion) {
        try {
          results.set(key, expr.analyze());
        } catch (error) {
          // Create error result
          results.set(key, {
            valid: false,
            celExpression: null,
            dependencies: [],
            sourceMap: [],
            errors: [new ConversionError(
              error instanceof Error ? error.message : String(error),
              String(expr.originalExpression),
              'unknown'
            )],
            warnings: [],
            requiresConversion: true
          });
        }
      }
    }
    
    return results;
  }

  /**
   * Analyze expressions in parallel (for independent expressions)
   */
  async analyzeAllParallel(): Promise<Map<string, CelConversionResult>> {
    const promises = Array.from(this._expressions.entries())
      .filter(([, expr]) => expr.requiresConversion)
      .map(async ([key, expr]) => {
        try {
          const result = expr.analyze();
          return [key, result] as [string, CelConversionResult];
        } catch (error) {
          const errorResult: CelConversionResult = {
            valid: false,
            celExpression: null,
            dependencies: [],
            sourceMap: [],
            errors: [new ConversionError(
              error instanceof Error ? error.message : String(error),
              String(expr.originalExpression),
              'unknown'
            )],
            warnings: [],
            requiresConversion: true
          };
          return [key, errorResult] as [string, CelConversionResult];
        }
      });

    const results = await Promise.all(promises);
    return new Map(results);
  }

  /**
   * Get statistics about the collection
   */
  getStats(): LazyCollectionStats {
    const total = this.size;
    const requiresConversion = this.requiresConversionCount;
    const static_ = this.staticCount;
    const analyzed = this.analyzedCount;
    
    return {
      total,
      requiresConversion,
      static: static_,
      analyzed,
      pending: requiresConversion - analyzed,
      conversionRatio: total > 0 ? requiresConversion / total : 0,
      analysisProgress: requiresConversion > 0 ? analyzed / requiresConversion : 1
    };
  }

  /**
   * Clear all expressions
   */
  clear(): void {
    this._expressions.clear();
  }

  /**
   * Reset analysis state for all expressions
   */
  resetAll(): void {
    for (const expr of this._expressions.values()) {
      expr.reset();
    }
  }
}

/**
 * Statistics about a lazy expression collection
 */
export interface LazyCollectionStats {
  /** Total number of expressions */
  total: number;
  
  /** Number of expressions that require conversion */
  requiresConversion: number;
  
  /** Number of static expressions (no conversion needed) */
  static: number;
  
  /** Number of expressions that have been analyzed */
  analyzed: number;
  
  /** Number of expressions pending analysis */
  pending: number;
  
  /** Ratio of expressions requiring conversion (0-1) */
  conversionRatio: number;
  
  /** Analysis progress for expressions requiring conversion (0-1) */
  analysisProgress: number;
}

/**
 * Factory function to create lazy analyzed expressions
 */
export function createLazyExpression(
  expression: any,
  context: AnalysisContext,
  analyzer?: JavaScriptToCelAnalyzer
): LazyAnalyzedExpression {
  return new LazyAnalyzedExpression(expression, context, analyzer);
}

/**
 * Factory function to create lazy expression collections
 */
export function createLazyCollection(analyzer?: JavaScriptToCelAnalyzer): LazyExpressionCollection {
  return new LazyExpressionCollection(analyzer);
}

/**
 * On-demand expression analyzer that performs KubernetesRef detection and analysis
 * only when results are actually needed
 */
export class OnDemandExpressionAnalyzer {
  private readonly _analyzer: JavaScriptToCelAnalyzer;
  private readonly _cache = new Map<string, LazyAnalyzedExpression>();
  private _cacheHits = 0;
  private _cacheMisses = 0;

  constructor(analyzer?: JavaScriptToCelAnalyzer) {
    this._analyzer = analyzer || new JavaScriptToCelAnalyzer();
  }

  /**
   * Create a lazy expression that will be analyzed on-demand
   */
  createLazyExpression(
    expression: any,
    context: AnalysisContext,
    cacheKey?: string
  ): LazyAnalyzedExpression {
    // Generate cache key if not provided
    const key = cacheKey || this._generateCacheKey(expression, context);
    
    // Check cache first
    const cached = this._cache.get(key);
    if (cached) {
      this._cacheHits++;
      return cached;
    }

    // Create new lazy expression
    this._cacheMisses++;
    const lazy = new LazyAnalyzedExpression(expression, context, this._analyzer);
    
    // Cache it for future use
    this._cache.set(key, lazy);
    
    return lazy;
  }

  /**
   * Analyze an expression immediately if it contains KubernetesRef objects,
   * otherwise return it as-is
   */
  analyzeIfNeeded(
    expression: any,
    context: AnalysisContext
  ): { needsConversion: boolean; result: any; lazy?: LazyAnalyzedExpression } {
    // Fast check for KubernetesRef objects
    if (!containsKubernetesRefs(expression)) {
      return {
        needsConversion: false,
        result: expression
      };
    }

    // Create lazy expression for on-demand analysis
    const lazy = this.createLazyExpression(expression, context);
    
    return {
      needsConversion: true,
      result: lazy,
      lazy
    };
  }

  /**
   * Batch analyze multiple expressions, only processing those that need conversion
   */
  batchAnalyze(
    expressions: Array<{ key: string; expression: any; context: AnalysisContext }>
  ): Map<string, { needsConversion: boolean; result: any; lazy?: LazyAnalyzedExpression }> {
    const results = new Map();
    
    for (const { key, expression, context } of expressions) {
      const result = this.analyzeIfNeeded(expression, context);
      results.set(key, result);
    }
    
    return results;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { hits: number; misses: number; size: number; hitRatio: number } {
    const total = this._cacheHits + this._cacheMisses;
    return {
      hits: this._cacheHits,
      misses: this._cacheMisses,
      size: this._cache.size,
      hitRatio: total > 0 ? this._cacheHits / total : 0
    };
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this._cache.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
  }

  /**
   * Generate a cache key for an expression and context
   */
  private _generateCacheKey(expression: any, context: AnalysisContext): string {
    const exprStr = typeof expression === 'string' 
      ? expression 
      : JSON.stringify(expression);
    
    const contextStr = JSON.stringify({
      type: context.type,
      factoryType: context.factoryType,
      availableRefs: Object.keys(context.availableReferences || {}),
      strictTypeChecking: context.strictTypeChecking,
      validateResourceReferences: context.validateResourceReferences
    });
    
    return `${exprStr}:${contextStr}`;
  }
}

/**
 * Expression tree analyzer for complex nested expressions with KubernetesRef objects
 */
export class ExpressionTreeAnalyzer {
  private readonly _onDemandAnalyzer: OnDemandExpressionAnalyzer;

  constructor(analyzer?: JavaScriptToCelAnalyzer) {
    this._onDemandAnalyzer = new OnDemandExpressionAnalyzer(analyzer);
  }

  /**
   * Analyze a complex expression tree, creating lazy expressions for branches
   * that contain KubernetesRef objects
   */
  analyzeTree(
    expressionTree: any,
    context: AnalysisContext,
    path: string[] = []
  ): ExpressionTreeResult {
    const result: ExpressionTreeResult = {
      path,
      needsConversion: false,
      staticValue: null,
      lazyExpression: null,
      children: new Map()
    };

    // Handle primitive values
    if (this._isPrimitive(expressionTree)) {
      if (containsKubernetesRefs(expressionTree)) {
        result.needsConversion = true;
        result.lazyExpression = this._onDemandAnalyzer.createLazyExpression(
          expressionTree,
          context,
          path.join('.')
        );
      } else {
        result.staticValue = expressionTree;
      }
      return result;
    }

    // Handle arrays
    if (Array.isArray(expressionTree)) {
      let hasKubernetesRefs = false;
      
      for (let i = 0; i < expressionTree.length; i++) {
        const childPath = [...path, i.toString()];
        const childResult = this.analyzeTree(expressionTree[i], context, childPath);
        result.children.set(i.toString(), childResult);
        
        if (childResult.needsConversion) {
          hasKubernetesRefs = true;
        }
      }
      
      if (hasKubernetesRefs) {
        result.needsConversion = true;
        result.lazyExpression = this._onDemandAnalyzer.createLazyExpression(
          expressionTree,
          context,
          path.join('.')
        );
      } else {
        result.staticValue = expressionTree;
      }
      
      return result;
    }

    // Handle objects
    if (expressionTree && typeof expressionTree === 'object') {
      // First check if the object itself contains KubernetesRef objects
      const objectHasRefs = containsKubernetesRefs(expressionTree);
      let hasKubernetesRefs = objectHasRefs;
      
      for (const [key, value] of Object.entries(expressionTree)) {
        const childPath = [...path, key];
        const childResult = this.analyzeTree(value, context, childPath);
        result.children.set(key, childResult);
        
        if (childResult.needsConversion) {
          hasKubernetesRefs = true;
        }
      }
      
      if (hasKubernetesRefs) {
        result.needsConversion = true;
        result.lazyExpression = this._onDemandAnalyzer.createLazyExpression(
          expressionTree,
          context,
          path.join('.')
        );
      } else {
        result.staticValue = expressionTree;
      }
      
      return result;
    }

    // Fallback for unknown types
    result.staticValue = expressionTree;
    return result;
  }

  /**
   * Get all lazy expressions from a tree result
   */
  getAllLazyExpressions(treeResult: ExpressionTreeResult): LazyAnalyzedExpression[] {
    const expressions: LazyAnalyzedExpression[] = [];
    
    if (treeResult.lazyExpression) {
      expressions.push(treeResult.lazyExpression);
    }
    
    for (const child of treeResult.children.values()) {
      expressions.push(...this.getAllLazyExpressions(child));
    }
    
    return expressions;
  }

  /**
   * Get statistics about the expression tree
   */
  getTreeStats(treeResult: ExpressionTreeResult): ExpressionTreeStats {
    let totalNodes = 1;
    let lazyNodes = treeResult.lazyExpression ? 1 : 0;
    let staticNodes = treeResult.staticValue !== null ? 1 : 0;
    let maxDepth = 0;
    
    for (const child of treeResult.children.values()) {
      const childStats = this.getTreeStats(child);
      totalNodes += childStats.totalNodes;
      lazyNodes += childStats.lazyNodes;
      staticNodes += childStats.staticNodes;
      maxDepth = Math.max(maxDepth, childStats.maxDepth + 1);
    }
    
    return {
      totalNodes,
      lazyNodes,
      staticNodes,
      maxDepth,
      lazyRatio: totalNodes > 0 ? lazyNodes / totalNodes : 0
    };
  }

  /**
   * Check if a value is a primitive type
   */
  private _isPrimitive(value: any): boolean {
    return value === null || 
           value === undefined || 
           typeof value === 'string' || 
           typeof value === 'number' || 
           typeof value === 'boolean' ||
           typeof value === 'function';
  }
}

/**
 * Result of analyzing an expression tree
 */
export interface ExpressionTreeResult {
  /** Path to this node in the tree */
  path: string[];
  
  /** Whether this node or its children need conversion */
  needsConversion: boolean;
  
  /** Static value if no conversion is needed */
  staticValue: any;
  
  /** Lazy expression if conversion is needed */
  lazyExpression: LazyAnalyzedExpression | null;
  
  /** Child nodes */
  children: Map<string, ExpressionTreeResult>;
}

/**
 * Statistics about an expression tree
 */
export interface ExpressionTreeStats {
  /** Total number of nodes in the tree */
  totalNodes: number;
  
  /** Number of nodes that need lazy analysis */
  lazyNodes: number;
  
  /** Number of static nodes */
  staticNodes: number;
  
  /** Maximum depth of the tree */
  maxDepth: number;
  
  /** Ratio of lazy nodes to total nodes */
  lazyRatio: number;
}

/**
 * Global on-demand analyzer instance
 */
export const globalOnDemandAnalyzer = new OnDemandExpressionAnalyzer();

/**
 * Lazy loading manager for complex expression trees with magic proxy integration
 */
export class LazyExpressionTreeLoader {
  private readonly _treeAnalyzer: ExpressionTreeAnalyzer;
  private readonly _loadedTrees = new Map<string, ExpressionTreeResult>();
  private readonly _loadingPromises = new Map<string, Promise<ExpressionTreeResult>>();
  private _loadCount = 0;

  constructor(analyzer?: JavaScriptToCelAnalyzer) {
    this._treeAnalyzer = new ExpressionTreeAnalyzer(analyzer);
  }

  /**
   * Load an expression tree lazily, returning immediately with a promise
   */
  async loadTree(
    expressionTree: any,
    context: AnalysisContext,
    treeId?: string
  ): Promise<ExpressionTreeResult> {
    const id = treeId || this._generateTreeId(expressionTree);
    
    // Check if already loaded
    const cached = this._loadedTrees.get(id);
    if (cached) {
      return cached;
    }
    
    // Check if currently loading
    const loading = this._loadingPromises.get(id);
    if (loading) {
      return loading;
    }
    
    // Start loading
    const loadPromise = this._performTreeLoad(expressionTree, context, id);
    this._loadingPromises.set(id, loadPromise);
    
    try {
      const result = await loadPromise;
      this._loadedTrees.set(id, result);
      return result;
    } finally {
      this._loadingPromises.delete(id);
    }
  }

  /**
   * Load multiple trees in parallel
   */
  async loadTrees(
    trees: Array<{ tree: any; context: AnalysisContext; id?: string }>
  ): Promise<Map<string, ExpressionTreeResult>> {
    const loadPromises = trees.map(async ({ tree, context, id }) => {
      const treeId = id || this._generateTreeId(tree);
      const result = await this.loadTree(tree, context, treeId);
      return [treeId, result] as [string, ExpressionTreeResult];
    });
    
    const results = await Promise.all(loadPromises);
    return new Map(results);
  }

  /**
   * Get a tree if it's already loaded, otherwise return null
   */
  getLoadedTree(treeId: string): ExpressionTreeResult | null {
    return this._loadedTrees.get(treeId) || null;
  }

  /**
   * Check if a tree is currently being loaded
   */
  isLoading(treeId: string): boolean {
    return this._loadingPromises.has(treeId);
  }

  /**
   * Check if a tree is loaded
   */
  isLoaded(treeId: string): boolean {
    return this._loadedTrees.has(treeId);
  }

  /**
   * Preload trees that are likely to be needed soon
   */
  async preloadTrees(
    trees: Array<{ tree: any; context: AnalysisContext; id?: string; priority?: number }>
  ): Promise<void> {
    // Sort by priority (higher priority first)
    const sortedTrees = trees.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
    // Load high priority trees first
    const highPriorityTrees = sortedTrees.filter(t => (t.priority || 0) > 5);
    if (highPriorityTrees.length > 0) {
      await this.loadTrees(highPriorityTrees);
    }
    
    // Load remaining trees in background
    const remainingTrees = sortedTrees.filter(t => (t.priority || 0) <= 5);
    if (remainingTrees.length > 0) {
      // Don't await - load in background
      this.loadTrees(remainingTrees).catch(error => {
        console.warn('Background tree preloading failed:', error);
      });
    }
  }

  /**
   * Get loading statistics
   */
  getStats(): LazyTreeLoaderStats {
    return {
      loadedTrees: this._loadedTrees.size,
      loadingTrees: this._loadingPromises.size,
      totalLoads: this._loadCount,
      memoryUsage: this._estimateMemoryUsage()
    };
  }

  /**
   * Clear loaded trees to free memory
   */
  clearCache(): void {
    this._loadedTrees.clear();
    this._loadCount = 0;
  }

  /**
   * Perform the actual tree loading
   */
  private async _performTreeLoad(
    expressionTree: any,
    context: AnalysisContext,
    treeId: string
  ): Promise<ExpressionTreeResult> {
    this._loadCount++;
    
    // Use setTimeout to yield control and allow other operations
    await new Promise(resolve => setTimeout(resolve, 0));
    
    // Analyze the tree
    const result = this._treeAnalyzer.analyzeTree(expressionTree, context, [treeId]);
    
    return result;
  }

  /**
   * Generate a unique ID for a tree
   */
  private _generateTreeId(tree: any): string {
    const treeStr = JSON.stringify(tree);
    // Simple hash function for tree ID
    let hash = 0;
    for (let i = 0; i < treeStr.length; i++) {
      const char = treeStr.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `tree_${Math.abs(hash)}`;
  }

  /**
   * Estimate memory usage of loaded trees
   */
  private _estimateMemoryUsage(): number {
    let totalSize = 0;
    for (const tree of this._loadedTrees.values()) {
      totalSize += this._estimateTreeSize(tree);
    }
    return totalSize;
  }

  /**
   * Estimate the size of a tree result
   */
  private _estimateTreeSize(tree: ExpressionTreeResult): number {
    let size = 100; // Base size
    
    if (tree.staticValue) {
      size += JSON.stringify(tree.staticValue).length;
    }
    
    if (tree.lazyExpression) {
      size += 200; // Estimated size of lazy expression
    }
    
    for (const child of tree.children.values()) {
      size += this._estimateTreeSize(child);
    }
    
    return size;
  }
}

/**
 * Magic proxy integration for lazy expression loading
 */
export class MagicProxyLazyIntegration {
  private readonly _treeLoader: LazyExpressionTreeLoader;
  private readonly _proxyCache = new Map<string, any>();

  constructor(analyzer?: JavaScriptToCelAnalyzer) {
    this._treeLoader = new LazyExpressionTreeLoader(analyzer);
  }

  /**
   * Create a lazy proxy for a complex object that may contain KubernetesRef objects
   */
  createLazyProxy<T extends object>(
    target: T,
    context: AnalysisContext,
    options: LazyProxyOptions = {}
  ): T {
    const proxyId = options.id || this._generateProxyId(target);
    
    // Check cache first
    const cached = this._proxyCache.get(proxyId);
    if (cached) {
      return cached;
    }

    const proxy = new Proxy(target, {
      get: (obj, prop) => {
        const value = (obj as any)[prop];
        
        // If the value contains KubernetesRef objects, wrap it in lazy analysis
        if (containsKubernetesRefs(value)) {
          return this._createLazyValue(value, context, `${proxyId}.${String(prop)}`);
        }
        
        // For complex objects, create nested lazy proxies
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return this.createLazyProxy(value, context, {
            ...options,
            id: `${proxyId}.${String(prop)}`
          });
        }
        
        return value;
      },
      
      set: (obj, prop, value) => {
        // Invalidate cache when properties are set
        this._invalidateCache(proxyId);
        (obj as any)[prop] = value;
        return true;
      }
    });

    // Cache the proxy
    this._proxyCache.set(proxyId, proxy);
    
    return proxy;
  }

  /**
   * Load expression trees for all KubernetesRef-containing values in an object
   */
  async preloadObjectTrees(
    obj: any,
    context: AnalysisContext,
    maxDepth: number = 5
  ): Promise<void> {
    const trees: Array<{ tree: any; context: AnalysisContext; id?: string; priority?: number }> = [];
    
    this._collectTreesFromObject(obj, context, trees, [], maxDepth);
    
    if (trees.length > 0) {
      await this._treeLoader.preloadTrees(trees);
    }
  }

  /**
   * Get statistics about the magic proxy integration
   */
  getStats(): MagicProxyIntegrationStats {
    return {
      cachedProxies: this._proxyCache.size,
      treeLoaderStats: this._treeLoader.getStats()
    };
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this._proxyCache.clear();
    this._treeLoader.clearCache();
  }

  /**
   * Create a lazy value wrapper
   */
  private _createLazyValue(value: any, context: AnalysisContext, valueId: string): any {
    // For simple values, create a lazy expression
    if (this._isSimpleValue(value)) {
      const lazy = globalOnDemandAnalyzer.createLazyExpression(value, context, valueId);
      
      // Return a proxy that triggers analysis when accessed
      return new Proxy({}, {
        get: (_, prop) => {
          if (prop === 'valueOf' || prop === 'toString') {
            return () => lazy.result.celExpression?.expression || String(value);
          }
          
          if (prop === Symbol.toPrimitive) {
            return () => lazy.result.celExpression?.expression || value;
          }
          
          // Trigger analysis and return the result
          const result = lazy.result;
          if (result.valid && result.celExpression) {
            return result.celExpression.expression;
          }
          
          return value;
        }
      });
    }
    
    // For complex values, load the tree lazily
    this._treeLoader.loadTree(value, context, valueId).catch(error => {
      console.warn(`Failed to load tree for ${valueId}:`, error);
    });
    
    return value;
  }

  /**
   * Check if a value is simple (not an object or array)
   */
  private _isSimpleValue(value: any): boolean {
    return value === null || 
           value === undefined || 
           typeof value === 'string' || 
           typeof value === 'number' || 
           typeof value === 'boolean' ||
           typeof value === 'function';
  }

  /**
   * Generate a unique ID for a proxy
   */
  private _generateProxyId(target: any): string {
    const targetStr = JSON.stringify(target);
    let hash = 0;
    for (let i = 0; i < targetStr.length; i++) {
      const char = targetStr.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `proxy_${Math.abs(hash)}`;
  }

  /**
   * Invalidate cache entries related to a proxy
   */
  private _invalidateCache(proxyId: string): void {
    // Remove the proxy from cache
    this._proxyCache.delete(proxyId);
    
    // Remove related entries (those that start with the proxy ID)
    for (const key of this._proxyCache.keys()) {
      if (key.startsWith(`${proxyId}.`)) {
        this._proxyCache.delete(key);
      }
    }
  }

  /**
   * Collect trees from an object recursively
   */
  private _collectTreesFromObject(
    obj: any,
    context: AnalysisContext,
    trees: Array<{ tree: any; context: AnalysisContext; id?: string; priority?: number }>,
    path: string[],
    maxDepth: number
  ): void {
    if (maxDepth <= 0 || !obj || typeof obj !== 'object') {
      return;
    }

    if (containsKubernetesRefs(obj)) {
      trees.push({
        tree: obj,
        context,
        id: path.join('.'),
        priority: maxDepth // Higher depth = higher priority
      });
    }

    // Recurse into object properties
    for (const [key, value] of Object.entries(obj)) {
      this._collectTreesFromObject(
        value,
        context,
        trees,
        [...path, key],
        maxDepth - 1
      );
    }
  }
}

/**
 * Options for creating lazy proxies
 */
export interface LazyProxyOptions {
  /** Unique identifier for the proxy */
  id?: string;
  
  /** Maximum depth to traverse for preloading */
  maxDepth?: number;
  
  /** Whether to preload trees immediately */
  preload?: boolean;
}

/**
 * Statistics about lazy tree loading
 */
export interface LazyTreeLoaderStats {
  /** Number of loaded trees */
  loadedTrees: number;
  
  /** Number of trees currently loading */
  loadingTrees: number;
  
  /** Total number of load operations */
  totalLoads: number;
  
  /** Estimated memory usage in bytes */
  memoryUsage: number;
}

/**
 * Statistics about magic proxy integration
 */
export interface MagicProxyIntegrationStats {
  /** Number of cached proxies */
  cachedProxies: number;
  
  /** Tree loader statistics */
  treeLoaderStats: LazyTreeLoaderStats;
}

/**
 * Global lazy tree loader instance
 */
export const globalLazyTreeLoader = new LazyExpressionTreeLoader();

/**
 * Memory-optimized expression manager for large sets of KubernetesRef-containing expressions
 */
export class MemoryOptimizedExpressionManager {
  private readonly _expressions = new Map<string, WeakRef<LazyAnalyzedExpression>>();
  private readonly _expressionSizes = new Map<string, number>();
  private readonly _accessTimes = new Map<string, number>();
  private readonly _analyzer: JavaScriptToCelAnalyzer;
  private _totalMemoryUsage = 0;
  private _maxMemoryUsage: number;
  private _cleanupThreshold: number;
  private _lastCleanup = Date.now();

  constructor(
    analyzer?: JavaScriptToCelAnalyzer,
    options: MemoryOptimizationOptions = {}
  ) {
    this._analyzer = analyzer || new JavaScriptToCelAnalyzer();
    this._maxMemoryUsage = options.maxMemoryUsage || 50 * 1024 * 1024; // 50MB default
    this._cleanupThreshold = options.cleanupThreshold || 0.8; // Cleanup at 80% capacity
  }

  /**
   * Create or retrieve a lazy expression with memory management
   */
  getOrCreateExpression(
    key: string,
    expression: any,
    context: AnalysisContext
  ): LazyAnalyzedExpression {
    // Check if expression exists and is still alive
    const existingRef = this._expressions.get(key);
    if (existingRef) {
      const existing = existingRef.deref();
      if (existing) {
        this._accessTimes.set(key, Date.now());
        return existing;
      } else {
        // Expression was garbage collected, clean up references
        this._cleanupExpression(key);
      }
    }

    // Check if we need to cleanup before creating new expression
    if (this._shouldCleanup()) {
      this._performCleanup();
    }

    // Create new lazy expression
    const lazy = new LazyAnalyzedExpression(expression, context, this._analyzer);
    const estimatedSize = this._estimateExpressionSize(expression);
    
    // Store with weak reference
    this._expressions.set(key, new WeakRef(lazy));
    this._expressionSizes.set(key, estimatedSize);
    this._accessTimes.set(key, Date.now());
    this._totalMemoryUsage += estimatedSize;

    return lazy;
  }

  /**
   * Batch create expressions with memory optimization
   */
  batchCreateExpressions(
    expressions: Array<{ key: string; expression: any; context: AnalysisContext }>
  ): Map<string, LazyAnalyzedExpression> {
    const results = new Map<string, LazyAnalyzedExpression>();
    
    // Sort by estimated size (smallest first) to optimize memory allocation
    const sortedExpressions = expressions
      .map(expr => ({
        ...expr,
        estimatedSize: this._estimateExpressionSize(expr.expression)
      }))
      .sort((a, b) => a.estimatedSize - b.estimatedSize);

    for (const { key, expression, context } of sortedExpressions) {
      const lazy = this.getOrCreateExpression(key, expression, context);
      results.set(key, lazy);
    }

    return results;
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): MemoryStats {
    // Clean up dead references first
    this._cleanupDeadReferences();

    return {
      totalExpressions: this._expressions.size,
      totalMemoryUsage: this._totalMemoryUsage,
      maxMemoryUsage: this._maxMemoryUsage,
      memoryUtilization: this._totalMemoryUsage / this._maxMemoryUsage,
      averageExpressionSize: this._expressions.size > 0 
        ? this._totalMemoryUsage / this._expressions.size 
        : 0,
      lastCleanup: this._lastCleanup,
      needsCleanup: this._shouldCleanup()
    };
  }

  /**
   * Force cleanup of unused expressions
   */
  forceCleanup(): MemoryCleanupResult {
    return this._performCleanup();
  }

  /**
   * Set memory limits
   */
  setMemoryLimits(maxMemoryUsage: number, cleanupThreshold: number): void {
    this._maxMemoryUsage = maxMemoryUsage;
    this._cleanupThreshold = cleanupThreshold;
    
    // Trigger cleanup if we're now over the limit
    if (this._shouldCleanup()) {
      this._performCleanup();
    }
  }

  /**
   * Clear all expressions
   */
  clear(): void {
    this._expressions.clear();
    this._expressionSizes.clear();
    this._accessTimes.clear();
    this._totalMemoryUsage = 0;
    this._lastCleanup = Date.now();
  }

  /**
   * Get expressions that are likely to be garbage collected soon
   */
  getExpiringExpressions(): string[] {
    const now = Date.now();
    const expiring: string[] = [];
    
    for (const [key, ref] of this._expressions) {
      const expr = ref.deref();
      if (!expr) {
        expiring.push(key);
      } else {
        const lastAccess = this._accessTimes.get(key) || 0;
        const age = now - lastAccess;
        
        // Consider expressions older than 5 minutes as expiring
        if (age > 5 * 60 * 1000) {
          expiring.push(key);
        }
      }
    }
    
    return expiring;
  }

  /**
   * Estimate the memory size of an expression
   */
  private _estimateExpressionSize(expression: any): number {
    if (typeof expression === 'string') {
      return expression.length * 2; // UTF-16 encoding
    }
    
    if (typeof expression === 'function') {
      return expression.toString().length * 2 + 1000; // Function overhead
    }
    
    if (Array.isArray(expression)) {
      return expression.reduce((size, item) => size + this._estimateExpressionSize(item), 100);
    }
    
    if (expression && typeof expression === 'object') {
      let size = 100; // Object overhead
      for (const [key, value] of Object.entries(expression)) {
        size += key.length * 2; // Key size
        size += this._estimateExpressionSize(value); // Value size
      }
      return size;
    }
    
    return 50; // Default size for primitives
  }

  /**
   * Check if cleanup is needed
   */
  private _shouldCleanup(): boolean {
    return this._totalMemoryUsage > (this._maxMemoryUsage * this._cleanupThreshold);
  }

  /**
   * Perform memory cleanup
   */
  private _performCleanup(): MemoryCleanupResult {
    const startTime = Date.now();
    const initialMemory = this._totalMemoryUsage;
    const initialCount = this._expressions.size;
    
    // First, clean up dead references
    const deadRefs = this._cleanupDeadReferences();
    
    // If still over threshold, remove least recently used expressions
    if (this._shouldCleanup()) {
      const lruCleanup = this._cleanupLRU();
      deadRefs.cleaned += lruCleanup.cleaned;
      deadRefs.freedMemory += lruCleanup.freedMemory;
    }
    
    this._lastCleanup = Date.now();
    
    return {
      duration: Date.now() - startTime,
      initialMemoryUsage: initialMemory,
      finalMemoryUsage: this._totalMemoryUsage,
      freedMemory: initialMemory - this._totalMemoryUsage,
      initialExpressionCount: initialCount,
      finalExpressionCount: this._expressions.size,
      cleanedExpressions: initialCount - this._expressions.size
    };
  }

  /**
   * Clean up dead weak references
   */
  private _cleanupDeadReferences(): { cleaned: number; freedMemory: number } {
    let cleaned = 0;
    let freedMemory = 0;
    
    for (const [key, ref] of this._expressions) {
      if (!ref.deref()) {
        const size = this._expressionSizes.get(key) || 0;
        this._cleanupExpression(key);
        cleaned++;
        freedMemory += size;
      }
    }
    
    return { cleaned, freedMemory };
  }

  /**
   * Clean up least recently used expressions
   */
  private _cleanupLRU(): { cleaned: number; freedMemory: number } {
    const _now = Date.now();
    const entries = Array.from(this._accessTimes.entries())
      .sort((a, b) => a[1] - b[1]); // Sort by access time (oldest first)
    
    let cleaned = 0;
    let freedMemory = 0;
    const targetMemory = this._maxMemoryUsage * (this._cleanupThreshold - 0.1); // Clean to 10% below threshold
    
    for (const [key] of entries) {
      if (this._totalMemoryUsage <= targetMemory) {
        break;
      }
      
      const size = this._expressionSizes.get(key) || 0;
      this._cleanupExpression(key);
      cleaned++;
      freedMemory += size;
    }
    
    return { cleaned, freedMemory };
  }

  /**
   * Clean up a single expression
   */
  private _cleanupExpression(key: string): void {
    const size = this._expressionSizes.get(key) || 0;
    this._expressions.delete(key);
    this._expressionSizes.delete(key);
    this._accessTimes.delete(key);
    this._totalMemoryUsage -= size;
  }
}

/**
 * Advanced parallel expression analyzer for independent expressions with KubernetesRef objects
 */
export class ParallelExpressionAnalyzer {
  private readonly _analyzer: JavaScriptToCelAnalyzer;
  private readonly _maxConcurrency: number;
  private readonly _detector: OptimizedKubernetesRefDetector;
  private _activeAnalyses = 0;
  private _totalAnalyses = 0;
  private _completedAnalyses = 0;
  private _failedAnalyses = 0;

  constructor(
    analyzer?: JavaScriptToCelAnalyzer, 
    maxConcurrency: number = 4,
    detector?: OptimizedKubernetesRefDetector
  ) {
    this._analyzer = analyzer || new JavaScriptToCelAnalyzer();
    this._maxConcurrency = maxConcurrency;
    this._detector = detector || new OptimizedKubernetesRefDetector();
  }

  /**
   * Analyze multiple expressions in parallel with advanced scheduling
   */
  async analyzeParallel(
    expressions: Array<{ key: string; expression: any; context: AnalysisContext }>
  ): Promise<Map<string, CelConversionResult>> {
    const results = new Map<string, CelConversionResult>();
    
    // Pre-filter expressions that need conversion
    const filteredExpressions = expressions.filter(({ expression }) => 
      this._detector.containsKubernetesRefs(expression)
    );
    
    // Add static expressions directly to results
    for (const { key, expression } of expressions) {
      if (!this._detector.containsKubernetesRefs(expression)) {
        results.set(key, {
          valid: true,
          celExpression: null,
          dependencies: [],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: false
        });
      }
    }
    
    if (filteredExpressions.length === 0) {
      return results;
    }

    this._totalAnalyses = filteredExpressions.length;
    this._completedAnalyses = 0;
    this._failedAnalyses = 0;

    // Create work queue with dependency analysis
    const workQueue = await this._createWorkQueue(filteredExpressions);
    
    // Process work queue in parallel
    const parallelResults = await this._processWorkQueue(workQueue);
    
    // Merge results
    for (const [key, result] of parallelResults) {
      results.set(key, result);
    }
    
    return results;
  }

  /**
   * Analyze expressions with priority-based scheduling and dependency resolution
   */
  async analyzePrioritized(
    expressions: Array<{ 
      key: string; 
      expression: any; 
      context: AnalysisContext; 
      priority: number;
      dependencies?: string[];
    }>
  ): Promise<Map<string, CelConversionResult>> {
    // Build dependency graph
    const dependencyGraph = this._buildDependencyGraph(expressions);
    
    // Topological sort to respect dependencies
    const sortedExpressions = this._topologicalSort(expressions, dependencyGraph);
    
    // Group by priority within dependency levels
    const priorityGroups = this._groupByPriority(sortedExpressions);
    
    const results = new Map<string, CelConversionResult>();
    
    // Process each priority group
    for (const group of priorityGroups) {
      const groupResults = await this.analyzeParallel(group);
      for (const [key, result] of groupResults) {
        results.set(key, result);
      }
    }
    
    return results;
  }

  /**
   * Analyze expressions with adaptive concurrency based on system load
   */
  async analyzeAdaptive(
    expressions: Array<{ key: string; expression: any; context: AnalysisContext }>,
    options: AdaptiveAnalysisOptions = {}
  ): Promise<Map<string, CelConversionResult>> {
    const {
      initialConcurrency = this._maxConcurrency,
      maxConcurrency = this._maxConcurrency * 2,
      minConcurrency = 1,
      performanceThreshold = 100 // ms
    } = options;

    let currentConcurrency = initialConcurrency;
    const results = new Map<string, CelConversionResult>();
    const remaining = [...expressions];
    
    while (remaining.length > 0) {
      // Take batch based on current concurrency
      const batch = remaining.splice(0, currentConcurrency);
      
      // Measure performance
      const startTime = performance.now();
      const batchResults = await this._processBatch(batch);
      const endTime = performance.now();
      
      const avgTime = (endTime - startTime) / batch.length;
      
      // Adapt concurrency based on performance
      if (avgTime > performanceThreshold && currentConcurrency > minConcurrency) {
        currentConcurrency = Math.max(minConcurrency, currentConcurrency - 1);
      } else if (avgTime < performanceThreshold / 2 && currentConcurrency < maxConcurrency) {
        currentConcurrency = Math.min(maxConcurrency, currentConcurrency + 1);
      }
      
      // Merge results
      for (const [key, result] of batchResults) {
        results.set(key, result);
      }
    }
    
    return results;
  }

  /**
   * Stream analysis results as they complete
   */
  async *analyzeStream(
    expressions: Array<{ key: string; expression: any; context: AnalysisContext }>
  ): AsyncGenerator<{ key: string; result: CelConversionResult; progress: number }> {
    const total = expressions.length;
    let completed = 0;
    
    // Filter expressions that need conversion
    const needConversion = expressions.filter(({ expression }) => 
      this._detector.containsKubernetesRefs(expression)
    );
    
    // Yield static results immediately
    for (const { key, expression } of expressions) {
      if (!this._detector.containsKubernetesRefs(expression)) {
        completed++;
        yield {
          key,
          result: {
            valid: true,
            celExpression: null,
            dependencies: [],
            sourceMap: [],
            errors: [],
            warnings: [],
            requiresConversion: false
          },
          progress: completed / total
        };
      }
    }
    
    // Process expressions that need conversion
    const batches = this._createBatches(needConversion, this._maxConcurrency);
    
    for (const batch of batches) {
      const promises = batch.map(async ({ key, expression, context }) => {
        this._activeAnalyses++;
        try {
          const result = this._analyzer.analyzeExpressionWithRefs(expression, context);
          this._completedAnalyses++;
          return { key, result };
        } catch (error) {
          this._failedAnalyses++;
          const errorResult: CelConversionResult = {
            valid: false,
            celExpression: null,
            dependencies: [],
            sourceMap: [],
            errors: [new ConversionError(
              error instanceof Error ? error.message : String(error),
              String(expression),
              'unknown'
            )],
            warnings: [],
            requiresConversion: true
          };
          return { key, result: errorResult };
        } finally {
          this._activeAnalyses--;
        }
      });
      
      // Yield results as they complete
      for (const promise of promises) {
        const { key, result } = await promise;
        completed++;
        yield {
          key,
          result,
          progress: completed / total
        };
      }
    }
  }

  /**
   * Get comprehensive analysis statistics
   */
  getStats(): AdvancedParallelAnalysisStats {
    return {
      maxConcurrency: this._maxConcurrency,
      activeAnalyses: this._activeAnalyses,
      utilizationRatio: this._activeAnalyses / this._maxConcurrency,
      totalAnalyses: this._totalAnalyses,
      completedAnalyses: this._completedAnalyses,
      failedAnalyses: this._failedAnalyses,
      successRate: this._totalAnalyses > 0 ? this._completedAnalyses / this._totalAnalyses : 0,
      detectorStats: this._detector.getCacheStats()
    };
  }

  /**
   * Create work queue with complexity analysis
   */
  private async _createWorkQueue(
    expressions: Array<{ key: string; expression: any; context: AnalysisContext }>
  ): Promise<WorkItem[]> {
    const workItems: WorkItem[] = [];
    
    for (const { key, expression, context } of expressions) {
      const complexity = this._calculateComplexity(expression);
      const refCount = this._detector.extractKubernetesRefs(expression).length;
      
      workItems.push({
        key,
        expression,
        context,
        complexity,
        refCount,
        estimatedTime: complexity * 10 + refCount * 5 // Simple estimation
      });
    }
    
    // Sort by estimated time (shortest first for better parallelization)
    return workItems.sort((a, b) => a.estimatedTime - b.estimatedTime);
  }

  /**
   * Process work queue in parallel
   */
  private async _processWorkQueue(workQueue: WorkItem[]): Promise<Map<string, CelConversionResult>> {
    const results = new Map<string, CelConversionResult>();
    const batches = this._createBatches(workQueue, this._maxConcurrency);
    
    for (const batch of batches) {
      const batchResults = await this._processBatch(batch);
      for (const [key, result] of batchResults) {
        results.set(key, result);
      }
    }
    
    return results;
  }

  /**
   * Process a batch of work items
   */
  private async _processBatch(
    batch: Array<{ key: string; expression: any; context: AnalysisContext }>
  ): Promise<Map<string, CelConversionResult>> {
    const promises = batch.map(async ({ key, expression, context }) => {
      this._activeAnalyses++;
      try {
        const result = this._analyzer.analyzeExpressionWithRefs(expression, context);
        this._completedAnalyses++;
        return [key, result] as [string, CelConversionResult];
      } catch (error) {
        this._failedAnalyses++;
        const errorResult: CelConversionResult = {
          valid: false,
          celExpression: null,
          dependencies: [],
          sourceMap: [],
          errors: [new ConversionError(
            error instanceof Error ? error.message : String(error),
            String(expression),
            'unknown'
          )],
          warnings: [],
          requiresConversion: true
        };
        return [key, errorResult] as [string, CelConversionResult];
      } finally {
        this._activeAnalyses--;
      }
    });
    
    const results = await Promise.all(promises);
    return new Map(results);
  }

  /**
   * Build dependency graph for expressions
   */
  private _buildDependencyGraph(
    expressions: Array<{ key: string; dependencies?: string[] }>
  ): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    
    for (const { key, dependencies = [] } of expressions) {
      graph.set(key, dependencies);
    }
    
    return graph;
  }

  /**
   * Topological sort for dependency resolution
   */
  private _topologicalSort<T extends { key: string; dependencies?: string[] }>(
    expressions: T[],
    dependencyGraph: Map<string, string[]>
  ): T[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: T[] = [];
    const expressionMap = new Map(expressions.map(expr => [expr.key, expr]));
    
    const visit = (key: string): void => {
      if (visited.has(key)) return;
      if (visiting.has(key)) {
        throw new Error(`Circular dependency detected involving ${key}`);
      }
      
      visiting.add(key);
      const dependencies = dependencyGraph.get(key) || [];
      
      for (const dep of dependencies) {
        visit(dep);
      }
      
      visiting.delete(key);
      visited.add(key);
      
      const expression = expressionMap.get(key);
      if (expression) {
        result.push(expression);
      }
    };
    
    for (const { key } of expressions) {
      visit(key);
    }
    
    return result;
  }

  /**
   * Group expressions by priority
   */
  private _groupByPriority<T extends { priority: number }>(expressions: T[]): T[][] {
    const groups = new Map<number, T[]>();
    
    for (const expr of expressions) {
      const priority = expr.priority;
      if (!groups.has(priority)) {
        groups.set(priority, []);
      }
      groups.get(priority)?.push(expr);
    }
    
    // Sort by priority (highest first)
    const sortedPriorities = Array.from(groups.keys()).sort((a, b) => b - a);
    return sortedPriorities.map(priority => groups.get(priority)!);
  }

  /**
   * Calculate expression complexity
   */
  private _calculateComplexity(expression: any): number {
    if (typeof expression === 'string') {
      let complexity = Math.min(expression.length / 20, 10);
      if (expression.includes('?.')) complexity += 2;
      if (expression.includes('??')) complexity += 2;
      if (expression.includes('${')) complexity += 3;
      return complexity;
    }
    
    if (Array.isArray(expression)) {
      return expression.reduce((sum, item) => sum + this._calculateComplexity(item), 1);
    }
    
    if (expression && typeof expression === 'object') {
      let complexity = 1;
      for (const value of Object.values(expression)) {
        complexity += this._calculateComplexity(value);
      }
      return Math.min(complexity, 50); // Cap complexity
    }
    
    return 1;
  }

  /**
   * Create batches for parallel processing
   */
  private _createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}

/**
 * Work item for parallel processing
 */
interface WorkItem {
  key: string;
  expression: any;
  context: AnalysisContext;
  complexity: number;
  refCount: number;
  estimatedTime: number;
}

/**
 * Options for adaptive analysis
 */
export interface AdaptiveAnalysisOptions {
  /** Initial concurrency level */
  initialConcurrency?: number;
  
  /** Maximum concurrency level */
  maxConcurrency?: number;
  
  /** Minimum concurrency level */
  minConcurrency?: number;
  
  /** Interval for adaptation in milliseconds */
  adaptationInterval?: number;
  
  /** Performance threshold in milliseconds */
  performanceThreshold?: number;
}

/**
 * Advanced parallel analysis statistics
 */
export interface AdvancedParallelAnalysisStats extends ParallelAnalysisStats {
  /** Total number of analyses started */
  totalAnalyses: number;
  
  /** Number of completed analyses */
  completedAnalyses: number;
  
  /** Number of failed analyses */
  failedAnalyses: number;
  
  /** Success rate (0-1) */
  successRate: number;
  
  /** Detector cache statistics */
  detectorStats: { hits: number; misses: number; hitRatio: number; size: number };
}

/**
 * Memory optimization options
 */
export interface MemoryOptimizationOptions {
  /** Maximum memory usage in bytes */
  maxMemoryUsage?: number;
  
  /** Cleanup threshold (0-1) */
  cleanupThreshold?: number;
}

/**
 * Memory usage statistics
 */
export interface MemoryStats {
  /** Total number of expressions */
  totalExpressions: number;
  
  /** Total memory usage in bytes */
  totalMemoryUsage: number;
  
  /** Maximum allowed memory usage */
  maxMemoryUsage: number;
  
  /** Memory utilization ratio (0-1) */
  memoryUtilization: number;
  
  /** Average expression size in bytes */
  averageExpressionSize: number;
  
  /** Timestamp of last cleanup */
  lastCleanup: number;
  
  /** Whether cleanup is needed */
  needsCleanup: boolean;
}

/**
 * Memory cleanup result
 */
export interface MemoryCleanupResult {
  /** Cleanup duration in milliseconds */
  duration: number;
  
  /** Initial memory usage */
  initialMemoryUsage: number;
  
  /** Final memory usage */
  finalMemoryUsage: number;
  
  /** Amount of memory freed */
  freedMemory: number;
  
  /** Initial expression count */
  initialExpressionCount: number;
  
  /** Final expression count */
  finalExpressionCount: number;
  
  /** Number of expressions cleaned */
  cleanedExpressions: number;
}

/**
 * Parallel analysis statistics
 */
export interface ParallelAnalysisStats {
  /** Maximum concurrency level */
  maxConcurrency: number;
  
  /** Currently active analyses */
  activeAnalyses: number;
  
  /** Utilization ratio (0-1) */
  utilizationRatio: number;
}

/**
 * Global memory-optimized expression manager
 */
export const globalMemoryOptimizedManager = new MemoryOptimizedExpressionManager();

/**
 * Performance profiler for expression analysis with KubernetesRef detection
 */
export class ExpressionAnalysisProfiler {
  private readonly _profiles = new Map<string, PerformanceProfile>();
  private readonly _analyzer: JavaScriptToCelAnalyzer;
  private _enabled = true;

  constructor(analyzer?: JavaScriptToCelAnalyzer) {
    this._analyzer = analyzer || new JavaScriptToCelAnalyzer();
  }

  /**
   * Enable or disable profiling
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /**
   * Profile expression analysis performance
   */
  profileExpression(
    expression: any,
    context: AnalysisContext,
    profileId?: string
  ): { result: CelConversionResult; profile: PerformanceProfile } {
    const id = profileId || this._generateProfileId(expression);
    
    if (!this._enabled) {
      const result = this._analyzer.analyzeExpressionWithRefs(expression, context);
      return {
        result,
        profile: {
          id,
          expression: String(expression),
          startTime: Date.now(),
          endTime: Date.now(),
          duration: 0,
          kubernetesRefDetectionTime: 0,
          astParsingTime: 0,
          celGenerationTime: 0,
          memoryUsage: 0,
          kubernetesRefCount: 0,
          expressionComplexity: 0,
          cacheHit: false
        }
      };
    }

    const profile: PerformanceProfile = {
      id,
      expression: String(expression),
      startTime: performance.now(),
      endTime: 0,
      duration: 0,
      kubernetesRefDetectionTime: 0,
      astParsingTime: 0,
      celGenerationTime: 0,
      memoryUsage: 0,
      kubernetesRefCount: 0,
      expressionComplexity: this._calculateComplexity(expression),
      cacheHit: false
    };

    // Profile KubernetesRef detection
    const refDetectionStart = performance.now();
    const hasRefs = containsKubernetesRefs(expression);
    const refDetectionEnd = performance.now();
    profile.kubernetesRefDetectionTime = refDetectionEnd - refDetectionStart;

    if (hasRefs) {
      const refs = extractResourceReferences(expression);
      profile.kubernetesRefCount = refs.length;
    }

    // Profile the actual analysis
    const analysisStart = performance.now();
    const result = this._analyzer.analyzeExpressionWithRefs(expression, context);
    const analysisEnd = performance.now();

    profile.endTime = performance.now();
    profile.duration = profile.endTime - profile.startTime;
    profile.celGenerationTime = analysisEnd - analysisStart - profile.kubernetesRefDetectionTime;
    profile.memoryUsage = this._estimateMemoryUsage(expression, result);

    // Store the profile
    this._profiles.set(id, profile);

    return { result, profile };
  }

  /**
   * Profile multiple expressions in batch
   */
  profileBatch(
    expressions: Array<{ expression: any; context: AnalysisContext; id?: string }>
  ): Map<string, { result: CelConversionResult; profile: PerformanceProfile }> {
    const results = new Map();
    
    for (const { expression, context, id } of expressions) {
      const profileResult = this.profileExpression(expression, context, id);
      const profileId = id || this._generateProfileId(expression);
      results.set(profileId, profileResult);
    }
    
    return results;
  }

  /**
   * Get performance statistics
   */
  getStats(): PerformanceStats {
    const profiles = Array.from(this._profiles.values());
    
    if (profiles.length === 0) {
      return {
        totalProfiles: 0,
        averageDuration: 0,
        averageKubernetesRefDetectionTime: 0,
        averageCelGenerationTime: 0,
        averageMemoryUsage: 0,
        averageKubernetesRefCount: 0,
        averageComplexity: 0,
        slowestExpression: null,
        fastestExpression: null,
        mostComplexExpression: null,
        cacheHitRatio: 0
      };
    }

    const totalDuration = profiles.reduce((sum, p) => sum + p.duration, 0);
    const totalRefDetection = profiles.reduce((sum, p) => sum + p.kubernetesRefDetectionTime, 0);
    const totalCelGeneration = profiles.reduce((sum, p) => sum + p.celGenerationTime, 0);
    const totalMemory = profiles.reduce((sum, p) => sum + p.memoryUsage, 0);
    const totalRefCount = profiles.reduce((sum, p) => sum + p.kubernetesRefCount, 0);
    const totalComplexity = profiles.reduce((sum, p) => sum + p.expressionComplexity, 0);
    const cacheHits = profiles.filter(p => p.cacheHit).length;

    const sortedByDuration = [...profiles].sort((a, b) => b.duration - a.duration);
    const sortedByComplexity = [...profiles].sort((a, b) => b.expressionComplexity - a.expressionComplexity);

    return {
      totalProfiles: profiles.length,
      averageDuration: totalDuration / profiles.length,
      averageKubernetesRefDetectionTime: totalRefDetection / profiles.length,
      averageCelGenerationTime: totalCelGeneration / profiles.length,
      averageMemoryUsage: totalMemory / profiles.length,
      averageKubernetesRefCount: totalRefCount / profiles.length,
      averageComplexity: totalComplexity / profiles.length,
      slowestExpression: sortedByDuration[0] || null,
      fastestExpression: sortedByDuration[sortedByDuration.length - 1] || null,
      mostComplexExpression: sortedByComplexity[0] || null,
      cacheHitRatio: profiles.length > 0 ? cacheHits / profiles.length : 0
    };
  }

  /**
   * Get profiles that exceed performance thresholds
   */
  getSlowProfiles(durationThreshold: number = 10): PerformanceProfile[] {
    return Array.from(this._profiles.values())
      .filter(profile => profile.duration > durationThreshold)
      .sort((a, b) => b.duration - a.duration);
  }

  /**
   * Get profiles with high KubernetesRef detection overhead
   */
  getHighOverheadProfiles(overheadThreshold: number = 0.5): PerformanceProfile[] {
    return Array.from(this._profiles.values())
      .filter(profile => {
        const overhead = profile.duration > 0 
          ? profile.kubernetesRefDetectionTime / profile.duration 
          : 0;
        return overhead > overheadThreshold;
      })
      .sort((a, b) => {
        const aOverhead = a.duration > 0 ? a.kubernetesRefDetectionTime / a.duration : 0;
        const bOverhead = b.duration > 0 ? b.kubernetesRefDetectionTime / b.duration : 0;
        return bOverhead - aOverhead;
      });
  }

  /**
   * Clear all profiles
   */
  clearProfiles(): void {
    this._profiles.clear();
  }

  /**
   * Export profiles for analysis
   */
  exportProfiles(): PerformanceProfile[] {
    return Array.from(this._profiles.values());
  }

  /**
   * Generate a profile ID
   */
  private _generateProfileId(expression: any): string {
    const exprStr = String(expression);
    const timestamp = Date.now();
    return `profile_${timestamp}_${exprStr.slice(0, 20).replace(/\W/g, '_')}`;
  }

  /**
   * Calculate expression complexity score
   */
  private _calculateComplexity(expression: any): number {
    if (typeof expression === 'string') {
      // String complexity based on length and special characters
      let complexity = Math.min(expression.length / 10, 10); // Max 10 for length
      
      // Add complexity for special patterns
      if (expression.includes('?.')) complexity += 2; // Optional chaining
      if (expression.includes('??')) complexity += 2; // Nullish coalescing
      if (expression.includes('${')) complexity += 3; // Template literals
      if (expression.match(/\w+\.\w+/)) complexity += 1; // Property access
      
      return complexity;
    }
    
    if (Array.isArray(expression)) {
      return expression.reduce((sum, item) => sum + this._calculateComplexity(item), 1);
    }
    
    if (expression && typeof expression === 'object') {
      let complexity = 1;
      for (const value of Object.values(expression)) {
        complexity += this._calculateComplexity(value);
      }
      return complexity;
    }
    
    return 1; // Base complexity for primitives
  }

  /**
   * Estimate memory usage
   */
  private _estimateMemoryUsage(expression: any, result: CelConversionResult): number {
    let size = 0;
    
    // Expression size
    if (typeof expression === 'string') {
      size += expression.length * 2; // UTF-16
    } else {
      size += JSON.stringify(expression).length * 2;
    }
    
    // Result size
    if (result.celExpression) {
      size += result.celExpression.expression.length * 2;
    }
    
    // Dependencies size
    size += result.dependencies.length * 100; // Estimated size per dependency
    
    // Source map size
    size += result.sourceMap.length * 200; // Estimated size per source map entry
    
    return size;
  }
}

/**
 * Performance profile for an expression analysis
 */
export interface PerformanceProfile {
  /** Unique profile ID */
  id: string;
  
  /** Original expression */
  expression: string;
  
  /** Start time (performance.now()) */
  startTime: number;
  
  /** End time (performance.now()) */
  endTime: number;
  
  /** Total duration in milliseconds */
  duration: number;
  
  /** Time spent on KubernetesRef detection */
  kubernetesRefDetectionTime: number;
  
  /** Time spent on AST parsing */
  astParsingTime: number;
  
  /** Time spent on CEL generation */
  celGenerationTime: number;
  
  /** Estimated memory usage in bytes */
  memoryUsage: number;
  
  /** Number of KubernetesRef objects found */
  kubernetesRefCount: number;
  
  /** Expression complexity score */
  expressionComplexity: number;
  
  /** Whether this was a cache hit */
  cacheHit: boolean;
}

/**
 * Performance statistics
 */
export interface PerformanceStats {
  /** Total number of profiles */
  totalProfiles: number;
  
  /** Average analysis duration */
  averageDuration: number;
  
  /** Average KubernetesRef detection time */
  averageKubernetesRefDetectionTime: number;
  
  /** Average CEL generation time */
  averageCelGenerationTime: number;
  
  /** Average memory usage */
  averageMemoryUsage: number;
  
  /** Average KubernetesRef count */
  averageKubernetesRefCount: number;
  
  /** Average complexity score */
  averageComplexity: number;
  
  /** Slowest expression profile */
  slowestExpression: PerformanceProfile | null;
  
  /** Fastest expression profile */
  fastestExpression: PerformanceProfile | null;
  
  /** Most complex expression profile */
  mostComplexExpression: PerformanceProfile | null;
  
  /** Cache hit ratio (0-1) */
  cacheHitRatio: number;
}

/**
 * Optimized KubernetesRef detector with caching and fast paths
 */
export class OptimizedKubernetesRefDetector {
  private readonly _cache = new Map<string, boolean>();
  private readonly _refCache = new Map<string, KubernetesRef<any>[]>();
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _maxCacheSize = 1000;

  /**
   * Fast detection of KubernetesRef objects with caching
   */
  containsKubernetesRefs(value: unknown, useCache: boolean = true): boolean {
    if (!useCache) {
      return this._containsKubernetesRefsUncached(value);
    }

    const cacheKey = this._generateCacheKey(value);
    
    // Check cache first
    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) {
      this._cacheHits++;
      return cached;
    }

    // Compute result
    this._cacheMisses++;
    const result = this._containsKubernetesRefsUncached(value);
    
    // Cache result if cache isn't full
    if (this._cache.size < this._maxCacheSize) {
      this._cache.set(cacheKey, result);
    }
    
    return result;
  }

  /**
   * Extract KubernetesRef objects with optimized traversal
   */
  extractKubernetesRefs(value: unknown, useCache: boolean = true): KubernetesRef<any>[] {
    if (!useCache) {
      return this._extractKubernetesRefsUncached(value);
    }

    const cacheKey = this._generateCacheKey(value);
    
    // Check cache first
    const cached = this._refCache.get(cacheKey);
    if (cached !== undefined) {
      this._cacheHits++;
      return [...cached]; // Return copy to prevent mutation
    }

    // Compute result
    this._cacheMisses++;
    const result = this._extractKubernetesRefsUncached(value);
    
    // Cache result if cache isn't full
    if (this._refCache.size < this._maxCacheSize) {
      this._refCache.set(cacheKey, [...result]); // Store copy
    }
    
    return result;
  }

  /**
   * Optimized traversal that stops early when possible
   */
  traverseOptimized(
    value: unknown,
    callback: (value: unknown, path: string[]) => boolean | undefined,
    path: string[] = [],
    maxDepth: number = 10
  ): boolean {
    if (maxDepth <= 0) {
      return false;
    }

    // Call callback - if it returns true, stop traversal
    const shouldStop = callback(value, path);
    if (shouldStop === true) {
      return true;
    }

    // Fast path for primitives
    if (this._isPrimitive(value)) {
      return false;
    }

    // Handle arrays with early termination
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const stopped = this.traverseOptimized(
          value[i],
          callback,
          [...path, i.toString()],
          maxDepth - 1
        );
        if (stopped) {
          return true;
        }
      }
      return false;
    }

    // Handle objects with early termination
    if (value && typeof value === 'object') {
      for (const [key, val] of Object.entries(value)) {
        const stopped = this.traverseOptimized(
          val,
          callback,
          [...path, key],
          maxDepth - 1
        );
        if (stopped) {
          return true;
        }
      }
      return false;
    }

    return false;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { hits: number; misses: number; hitRatio: number; size: number } {
    const total = this._cacheHits + this._cacheMisses;
    return {
      hits: this._cacheHits,
      misses: this._cacheMisses,
      hitRatio: total > 0 ? this._cacheHits / total : 0,
      size: this._cache.size + this._refCache.size
    };
  }

  /**
   * Clear caches
   */
  clearCache(): void {
    this._cache.clear();
    this._refCache.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
  }

  /**
   * Set maximum cache size
   */
  setMaxCacheSize(size: number): void {
    this._maxCacheSize = size;
    
    // Trim caches if they're too large
    if (this._cache.size > size) {
      const entries = Array.from(this._cache.entries());
      this._cache.clear();
      // Keep the most recent entries
      for (const [key, value] of entries.slice(-size)) {
        this._cache.set(key, value);
      }
    }
    
    if (this._refCache.size > size) {
      const entries = Array.from(this._refCache.entries());
      this._refCache.clear();
      // Keep the most recent entries
      for (const [key, value] of entries.slice(-size)) {
        this._refCache.set(key, value);
      }
    }
  }

  /**
   * Uncached KubernetesRef detection with optimizations
   */
  private _containsKubernetesRefsUncached(value: unknown): boolean {
    // Fast path for primitives
    if (this._isPrimitive(value)) {
      return false;
    }

    // Check if this is a KubernetesRef
    if (this.isKubernetesRef(value)) {
      return true;
    }

    // Use optimized traversal with early termination
    return this.traverseOptimized(value, (val) => {
      if (this.isKubernetesRef(val)) {
        return true; // Stop traversal, we found one
      }
      return false; // Continue traversal
    });
  }

  /**
   * Uncached KubernetesRef extraction with optimizations
   */
  private _extractKubernetesRefsUncached(value: unknown): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    this.traverseOptimized(value, (val) => {
      if (this.isKubernetesRef(val)) {
        refs.push(val as KubernetesRef<any>);
      }
      return false; // Continue traversal to find all refs
    });
    
    return refs;
  }

  /**
   * Generate cache key for a value
   */
  private _generateCacheKey(value: unknown): string {
    if (typeof value === 'string') {
      return `str:${value.length}:${value.slice(0, 50)}`;
    }
    
    if (typeof value === 'number' || typeof value === 'boolean') {
      return `prim:${String(value)}`;
    }
    
    if (value === null || value === undefined) {
      return `null:${String(value)}`;
    }
    
    if (typeof value === 'function') {
      return `func:${value.name || 'anonymous'}:${value.toString().slice(0, 50)}`;
    }
    
    // For objects and arrays, use a hash of the JSON representation
    try {
      const json = JSON.stringify(value);
      return `obj:${json.length}:${this._simpleHash(json)}`;
    } catch {
      return `obj:unstringifiable:${Date.now()}`;
    }
  }

  /**
   * Simple hash function for cache keys
   */
  private _simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Fast primitive check
   */
  private _isPrimitive(value: unknown): boolean {
    return value === null || 
           value === undefined || 
           typeof value === 'string' || 
           typeof value === 'number' || 
           typeof value === 'boolean' ||
           typeof value === 'function';
  }

  /**
   * Fast KubernetesRef check
   */
  public isKubernetesRef(value: unknown): boolean {
    return (
      (typeof value === 'object' || typeof value === 'function') &&
      value !== null &&
      KUBERNETES_REF_BRAND in value
    );
  }
}

/**
 * Optimized expression traverser for complex nested structures
 */
export class OptimizedExpressionTraverser {
  private readonly _detector: OptimizedKubernetesRefDetector;
  private readonly _visitedObjects = new WeakSet();

  constructor(detector?: OptimizedKubernetesRefDetector) {
    this._detector = detector || new OptimizedKubernetesRefDetector();
  }

  /**
   * Traverse expression tree with cycle detection and optimization
   */
  traverse(
    expression: any,
    visitor: (value: any, path: string[], context: TraversalContext) => TraversalAction,
    options: TraversalOptions = {}
  ): TraversalResult {
    const {
      maxDepth = 20,
      detectCycles = true,
      earlyTermination = true
    } = options;

    const result: TraversalResult = {
      visited: 0,
      skipped: 0,
      kubernetesRefs: [],
      maxDepthReached: false,
      cyclesDetected: 0,
      duplicatesSkipped: 0
    };

    // WeakSet doesn't have a clear method, create a new instance
    (this as any)._visitedObjects = new WeakSet();

    const traverse = (
      value: any,
      path: string[],
      depth: number
    ): boolean => {
      // Check depth limit
      if (depth > maxDepth) {
        result.maxDepthReached = true;
        return false;
      }

      // Cycle detection
      if (detectCycles && value && typeof value === 'object') {
        if (this._visitedObjects.has(value)) {
          result.cyclesDetected++;
          result.skipped++;
          return false;
        }
        this._visitedObjects.add(value);
      }

      result.visited++;

      // Check if this is a KubernetesRef
      if (this._detector.isKubernetesRef(value)) {
        result.kubernetesRefs.push(value);
      }

      // Call visitor
      const context: TraversalContext = {
        depth,
        isKubernetesRef: this._detector.isKubernetesRef(value),
        hasKubernetesRefs: this._detector.containsKubernetesRefs(value, false),
        path: [...path]
      };

      const action = visitor(value, path, context);

      // Handle visitor actions
      switch (action) {
        case TraversalAction.STOP:
          return true; // Stop entire traversal

        case TraversalAction.SKIP:
          result.skipped++;
          return false; // Skip this subtree
        default:
          break; // Continue normal traversal
      }

      // Traverse children
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const stopped = traverse(value[i], [...path, i.toString()], depth + 1);
          if (stopped && earlyTermination) {
            return true;
          }
        }
      } else if (value && typeof value === 'object') {
        for (const [key, val] of Object.entries(value)) {
          const stopped = traverse(val, [...path, key], depth + 1);
          if (stopped && earlyTermination) {
            return true;
          }
        }
      }

      return false;
    };

    traverse(expression, [], 0);
    return result;
  }

  /**
   * Find all KubernetesRef objects efficiently
   */
  findAllKubernetesRefs(expression: any, maxDepth: number = 20): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    this.traverse(
      expression,
      (value, _path, context) => {
        if (context.isKubernetesRef) {
          refs.push(value);
        }
        return TraversalAction.CONTINUE;
      },
      { maxDepth, detectCycles: true, earlyTermination: false }
    );
    
    return refs;
  }

  /**
   * Check if expression contains KubernetesRefs efficiently
   */
  hasKubernetesRefs(expression: any, maxDepth: number = 20): boolean {
    let found = false;
    
    this.traverse(
      expression,
      (_value, _path, context) => {
        if (context.isKubernetesRef) {
          found = true;
          return TraversalAction.STOP; // Early termination
        }
        return TraversalAction.CONTINUE;
      },
      { maxDepth, detectCycles: true, earlyTermination: true }
    );
    
    return found;
  }
}

/**
 * Traversal action returned by visitor functions
 */
export enum TraversalAction {
  /** Continue normal traversal */
  CONTINUE = 'continue',
  
  /** Skip this subtree */
  SKIP = 'skip',
  
  /** Stop entire traversal */
  STOP = 'stop'
}

/**
 * Context provided to traversal visitors
 */
export interface TraversalContext {
  /** Current depth in the tree */
  depth: number;
  
  /** Whether the current value is a KubernetesRef */
  isKubernetesRef: boolean;
  
  /** Whether the current value contains KubernetesRefs */
  hasKubernetesRefs: boolean;
  
  /** Path to the current value */
  path: string[];
}

/**
 * Options for expression traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse */
  maxDepth?: number;
  
  /** Whether to detect and skip cycles */
  detectCycles?: boolean;
  
  /** Whether to skip duplicate objects */
  skipDuplicates?: boolean;
  
  /** Whether to enable early termination */
  earlyTermination?: boolean;
}

/**
 * Result of expression traversal
 */
export interface TraversalResult {
  /** Number of nodes visited */
  visited: number;
  
  /** Number of nodes skipped */
  skipped: number;
  
  /** KubernetesRef objects found */
  kubernetesRefs: KubernetesRef<any>[];
  
  /** Whether maximum depth was reached */
  maxDepthReached: boolean;
  
  /** Number of cycles detected */
  cyclesDetected: number;
  
  /** Number of duplicates skipped */
  duplicatesSkipped: number;
}

/**
 * Global optimized KubernetesRef detector
 */
export const globalOptimizedDetector = new OptimizedKubernetesRefDetector();

/**
 * Expression complexity analyzer with warnings for magic proxy usage
 */
export class ExpressionComplexityAnalyzer {
  private readonly _detector: OptimizedKubernetesRefDetector;
  private readonly _traverser: OptimizedExpressionTraverser;
  private readonly _thresholds: ComplexityThresholds;

  constructor(
    detector?: OptimizedKubernetesRefDetector,
    traverser?: OptimizedExpressionTraverser,
    thresholds?: Partial<ComplexityThresholds>
  ) {
    this._detector = detector || new OptimizedKubernetesRefDetector();
    this._traverser = traverser || new OptimizedExpressionTraverser();
    this._thresholds = {
      low: 5,
      medium: 15,
      high: 30,
      extreme: 50,
      ...thresholds
    };
  }

  /**
   * Analyze expression complexity and generate warnings
   */
  analyzeComplexity(expression: any): ComplexityAnalysisResult {
    const startTime = performance.now();
    
    // Calculate various complexity metrics
    const syntacticComplexity = this._calculateSyntacticComplexity(expression);
    const structuralComplexity = this._calculateStructuralComplexity(expression);
    const magicProxyComplexity = this._calculateMagicProxyComplexity(expression);
    const cyclomaticComplexity = this._calculateCyclomaticComplexity(expression);
    
    // Overall complexity score
    const overallComplexity = Math.max(
      syntacticComplexity,
      structuralComplexity,
      magicProxyComplexity,
      cyclomaticComplexity
    );
    
    // Determine complexity level
    const level = this._determineComplexityLevel(overallComplexity);
    
    // Generate warnings
    const warnings = this._generateWarnings(expression, {
      syntacticComplexity,
      structuralComplexity,
      magicProxyComplexity,
      cyclomaticComplexity,
      overallComplexity,
      level
    });
    
    // Generate recommendations
    const recommendations = this._generateRecommendations(expression, {
      syntacticComplexity,
      structuralComplexity,
      magicProxyComplexity,
      cyclomaticComplexity,
      overallComplexity,
      level
    });
    
    const endTime = performance.now();
    
    return {
      expression: String(expression),
      syntacticComplexity,
      structuralComplexity,
      magicProxyComplexity,
      cyclomaticComplexity,
      overallComplexity,
      level,
      warnings,
      recommendations,
      analysisTime: endTime - startTime,
      kubernetesRefCount: this._detector.extractKubernetesRefs(expression).length,
      estimatedConversionTime: this._estimateConversionTime(overallComplexity),
      memoryImpact: this._estimateMemoryImpact(expression)
    };
  }

  /**
   * Batch analyze multiple expressions
   */
  batchAnalyzeComplexity(
    expressions: Array<{ key: string; expression: any }>
  ): Map<string, ComplexityAnalysisResult> {
    const results = new Map<string, ComplexityAnalysisResult>();
    
    for (const { key, expression } of expressions) {
      results.set(key, this.analyzeComplexity(expression));
    }
    
    return results;
  }

  /**
   * Get complexity statistics for a set of expressions
   */
  getComplexityStats(
    expressions: Array<{ key: string; expression: any }>
  ): ComplexityStats {
    const results = this.batchAnalyzeComplexity(expressions);
    const analyses = Array.from(results.values());
    
    if (analyses.length === 0) {
      return {
        totalExpressions: 0,
        averageComplexity: 0,
        maxComplexity: 0,
        minComplexity: 0,
        complexityDistribution: { low: 0, medium: 0, high: 0, extreme: 0 },
        totalWarnings: 0,
        averageWarnings: 0,
        mostComplexExpression: null,
        totalKubernetesRefs: 0,
        averageKubernetesRefs: 0
      };
    }

    const complexities = analyses.map(a => a.overallComplexity);
    const totalComplexity = complexities.reduce((sum, c) => sum + c, 0);
    const totalWarnings = analyses.reduce((sum, a) => sum + a.warnings.length, 0);
    const totalKubernetesRefs = analyses.reduce((sum, a) => sum + a.kubernetesRefCount, 0);
    
    const distribution = { low: 0, medium: 0, high: 0, extreme: 0 };
    for (const analysis of analyses) {
      distribution[analysis.level]++;
    }
    
    const mostComplex = analyses.reduce((max, current) => 
      current.overallComplexity > max.overallComplexity ? current : max
    );

    return {
      totalExpressions: analyses.length,
      averageComplexity: totalComplexity / analyses.length,
      maxComplexity: Math.max(...complexities),
      minComplexity: Math.min(...complexities),
      complexityDistribution: distribution,
      totalWarnings,
      averageWarnings: totalWarnings / analyses.length,
      mostComplexExpression: mostComplex,
      totalKubernetesRefs,
      averageKubernetesRefs: totalKubernetesRefs / analyses.length
    };
  }

  /**
   * Calculate syntactic complexity (based on syntax patterns)
   */
  private _calculateSyntacticComplexity(expression: any): number {
    if (typeof expression !== 'string') {
      return 1;
    }

    let complexity = Math.min(expression.length / 50, 10); // Base complexity from length
    
    // Add complexity for various syntax patterns
    const patterns = [
      { pattern: /\?\./g, weight: 2, name: 'optional chaining' },
      { pattern: /\?\?/g, weight: 2, name: 'nullish coalescing' },
      { pattern: /\$\{[^}]+\}/g, weight: 3, name: 'template literals' },
      { pattern: /\w+\.\w+/g, weight: 1, name: 'property access' },
      { pattern: /\[[^\]]+\]/g, weight: 1.5, name: 'array access' },
      { pattern: /\?\s*:/g, weight: 2, name: 'ternary operator' },
      { pattern: /&&|\|\|/g, weight: 1.5, name: 'logical operators' },
      { pattern: /===|!==|==|!=/g, weight: 1, name: 'comparison operators' },
      { pattern: /\w+\([^)]*\)/g, weight: 2.5, name: 'function calls' },
      { pattern: /\bfind\b|\bfilter\b|\bmap\b|\breduce\b/g, weight: 3, name: 'array methods' }
    ];

    for (const { pattern, weight } of patterns) {
      const matches = expression.match(pattern);
      if (matches) {
        complexity += matches.length * weight;
      }
    }

    return Math.min(complexity, 50); // Cap at 50
  }

  /**
   * Calculate structural complexity (based on nesting and object structure)
   */
  private _calculateStructuralComplexity(expression: any): number {
    let complexity = 1;
    let maxDepth = 0;
    let nodeCount = 0;

    const traversalResult = this._traverser.traverse(
      expression,
      (value, _path, context) => {
        nodeCount++;
        maxDepth = Math.max(maxDepth, context.depth);
        
        // Add complexity for different node types
        if (Array.isArray(value)) {
          complexity += value.length * 0.5;
        } else if (value && typeof value === 'object') {
          complexity += Object.keys(value).length * 0.3;
        }
        
        return TraversalAction.CONTINUE;
      },
      { maxDepth: 20 }
    );

    // Factor in depth and node count
    complexity += maxDepth * 2;
    complexity += nodeCount * 0.1;
    
    // Penalize cycles
    complexity += traversalResult.cyclesDetected * 5;

    return Math.min(complexity, 50);
  }

  /**
   * Calculate magic proxy complexity (based on KubernetesRef usage)
   */
  private _calculateMagicProxyComplexity(expression: any): number {
    const refs = this._detector.extractKubernetesRefs(expression);
    let complexity = refs.length * 2; // Base complexity per ref
    
    // Analyze ref patterns
    const resourceIds = new Set(refs.map(ref => ref.resourceId));
    const fieldPaths = refs.map(ref => ref.fieldPath);
    
    // Add complexity for multiple resources
    complexity += resourceIds.size * 1.5;
    
    // Add complexity for deep field paths
    for (const fieldPath of fieldPaths) {
      const depth = fieldPath.split('.').length;
      complexity += Math.max(0, depth - 2) * 0.5; // Penalize deep paths
    }
    
    // Add complexity for optional chaining in field paths
    const optionalPaths = fieldPaths.filter(path => path.includes('?'));
    complexity += optionalPaths.length * 1.5;
    
    return Math.min(complexity, 50);
  }

  /**
   * Calculate cyclomatic complexity (based on control flow)
   */
  private _calculateCyclomaticComplexity(expression: any): number {
    if (typeof expression !== 'string') {
      return 1;
    }

    let complexity = 1; // Base complexity
    
    // Count decision points
    const decisionPatterns = [
      /\?\s*:/g, // Ternary operators
      /&&/g,     // Logical AND
      /\|\|/g,   // Logical OR
      /\bif\b/g, // If statements (in case of function expressions)
      /\belse\b/g, // Else statements
      /\bswitch\b/g, // Switch statements
      /\bcase\b/g,   // Case statements
      /\bwhile\b/g,  // While loops
      /\bfor\b/g,    // For loops
      /\btry\b/g,    // Try blocks
      /\bcatch\b/g   // Catch blocks
    ];

    for (const pattern of decisionPatterns) {
      const matches = expression.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return Math.min(complexity, 20);
  }

  /**
   * Determine complexity level
   */
  private _determineComplexityLevel(complexity: number): ComplexityLevel {
    if (complexity <= this._thresholds.low) return 'low';
    if (complexity <= this._thresholds.medium) return 'medium';
    if (complexity <= this._thresholds.high) return 'high';
    return 'extreme';
  }

  /**
   * Generate warnings based on complexity analysis
   */
  private _generateWarnings(_expression: any, metrics: ComplexityMetrics): ComplexityWarning[] {
    const warnings: ComplexityWarning[] = [];

    // Overall complexity warnings
    if (metrics.overallComplexity > this._thresholds.high) {
      warnings.push({
        type: 'high-complexity',
        severity: metrics.overallComplexity > this._thresholds.extreme ? 'error' : 'warning',
        message: `Expression has very high complexity (${metrics.overallComplexity.toFixed(1)}). Consider breaking it down into smaller parts.`,
        metric: 'overallComplexity',
        value: metrics.overallComplexity,
        threshold: this._thresholds.high
      });
    }

    // Magic proxy specific warnings
    if (metrics.magicProxyComplexity > 10) {
      warnings.push({
        type: 'magic-proxy-complexity',
        severity: 'warning',
        message: `High magic proxy usage complexity (${metrics.magicProxyComplexity.toFixed(1)}). Consider reducing KubernetesRef dependencies.`,
        metric: 'magicProxyComplexity',
        value: metrics.magicProxyComplexity,
        threshold: 10
      });
    }

    // Syntactic complexity warnings
    if (metrics.syntacticComplexity > 20) {
      warnings.push({
        type: 'syntactic-complexity',
        severity: 'info',
        message: `Complex syntax patterns detected (${metrics.syntacticComplexity.toFixed(1)}). Consider simplifying the expression.`,
        metric: 'syntacticComplexity',
        value: metrics.syntacticComplexity,
        threshold: 20
      });
    }

    // Structural complexity warnings
    if (metrics.structuralComplexity > 15) {
      warnings.push({
        type: 'structural-complexity',
        severity: 'info',
        message: `Deep or complex object structure (${metrics.structuralComplexity.toFixed(1)}). Consider flattening the structure.`,
        metric: 'structuralComplexity',
        value: metrics.structuralComplexity,
        threshold: 15
      });
    }

    return warnings;
  }

  /**
   * Generate recommendations for reducing complexity
   */
  private _generateRecommendations(_expression: any, metrics: ComplexityMetrics): string[] {
    const recommendations: string[] = [];

    if (metrics.overallComplexity > this._thresholds.high) {
      recommendations.push('Break down the expression into smaller, more manageable parts');
      recommendations.push('Consider extracting complex logic into separate functions');
    }

    if (metrics.magicProxyComplexity > 10) {
      recommendations.push('Reduce the number of KubernetesRef dependencies');
      recommendations.push('Consider caching frequently accessed resource fields');
      recommendations.push('Use direct references instead of deep field path access where possible');
    }

    if (metrics.syntacticComplexity > 20) {
      recommendations.push('Simplify complex syntax patterns like nested ternary operators');
      recommendations.push('Replace complex template literals with string concatenation');
      recommendations.push('Use intermediate variables for complex property access chains');
    }

    if (metrics.cyclomaticComplexity > 10) {
      recommendations.push('Reduce the number of conditional branches');
      recommendations.push('Consider using lookup tables instead of complex conditional logic');
      recommendations.push('Extract decision logic into separate functions');
    }

    return recommendations;
  }

  /**
   * Estimate conversion time based on complexity
   */
  private _estimateConversionTime(complexity: number): number {
    // Base time + complexity factor
    return 1 + (complexity * 0.5);
  }

  /**
   * Estimate memory impact
   */
  private _estimateMemoryImpact(expression: any): MemoryImpact {
    const size = JSON.stringify(expression).length;
    const refs = this._detector.extractKubernetesRefs(expression);
    
    const estimatedSize = size * 2 + refs.length * 100; // Rough estimation
    
    if (estimatedSize < 1000) return 'low';
    if (estimatedSize < 5000) return 'medium';
    if (estimatedSize < 20000) return 'high';
    return 'extreme';
  }
}

/**
 * Complexity thresholds for different levels
 */
export interface ComplexityThresholds {
  low: number;
  medium: number;
  high: number;
  extreme: number;
}

/**
 * Complexity level
 */
export type ComplexityLevel = 'low' | 'medium' | 'high' | 'extreme';

/**
 * Memory impact level
 */
export type MemoryImpact = 'low' | 'medium' | 'high' | 'extreme';

/**
 * Complexity metrics
 */
export interface ComplexityMetrics {
  syntacticComplexity: number;
  structuralComplexity: number;
  magicProxyComplexity: number;
  cyclomaticComplexity: number;
  overallComplexity: number;
  level: ComplexityLevel;
}

/**
 * Complexity warning
 */
export interface ComplexityWarning {
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  metric: string;
  value: number;
  threshold: number;
}

/**
 * Result of complexity analysis
 */
export interface ComplexityAnalysisResult extends ComplexityMetrics {
  expression: string;
  warnings: ComplexityWarning[];
  recommendations: string[];
  analysisTime: number;
  kubernetesRefCount: number;
  estimatedConversionTime: number;
  memoryImpact: MemoryImpact;
}

/**
 * Complexity statistics for a set of expressions
 */
export interface ComplexityStats {
  totalExpressions: number;
  averageComplexity: number;
  maxComplexity: number;
  minComplexity: number;
  complexityDistribution: Record<ComplexityLevel, number>;
  totalWarnings: number;
  averageWarnings: number;
  mostComplexExpression: ComplexityAnalysisResult | null;
  totalKubernetesRefs: number;
  averageKubernetesRefs: number;
}

/**
 * Global expression complexity analyzer
 */
export const globalComplexityAnalyzer = new ExpressionComplexityAnalyzer();

/**
 * Global optimized expression traverser
 */
export const globalOptimizedTraverser = new OptimizedExpressionTraverser();

/**
 * Global expression analysis profiler
 */
export const globalExpressionProfiler = new ExpressionAnalysisProfiler();

/**
 * Global parallel expression analyzer
 */
export const globalParallelAnalyzer = new ParallelExpressionAnalyzer();

/**
 * Global magic proxy integration instance
 */
export const globalMagicProxyIntegration = new MagicProxyLazyIntegration();

/**
 * Global expression tree analyzer instance
 */
export const globalTreeAnalyzer = new ExpressionTreeAnalyzer();

/**
 * Utility to check if a value should be wrapped in a lazy expression
 */
export function shouldUseLazyAnalysis(expression: any): boolean {
  // Use lazy analysis for complex expressions or those that might contain KubernetesRef objects
  if (typeof expression === 'function') {
    return true; // Functions always need analysis
  }
  
  if (typeof expression === 'string' && expression.length > 50) {
    return true; // Long strings might be complex expressions
  }
  
  if (Array.isArray(expression) || (expression && typeof expression === 'object')) {
    return true; // Complex structures might contain KubernetesRef objects
  }
  
  return containsKubernetesRefs(expression);
}