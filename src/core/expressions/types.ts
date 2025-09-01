/**
 * Expression Analysis Types
 * 
 * This module contains type definitions for the expression analysis system,
 * including contexts, results, and configuration interfaces.
 */

import type { KubernetesRef, } from '../types/index.js';

/**
 * Context for expression analysis
 */
export interface AnalysisContext {
  /** Factory type being used */
  factoryType: 'direct' | 'kro';
  /** Resource context if analyzing resource configurations */
  resourceContext?: {
    resourceId: string;
    fieldPath: string;
  };
  /** Schema context if analyzing schema-based expressions */
  schemaContext?: {
    schemaType: string;
    fieldPath: string;
  };
  /** Additional metadata for analysis */
  metadata?: Record<string, any>;
}

/**
 * Context specific to factory expression analysis
 */
export interface FactoryExpressionContext {
  /** Factory type */
  factoryType: 'direct' | 'kro';
  /** Name of the factory function */
  factoryName: string;
  /** Whether analysis is enabled */
  analysisEnabled: boolean;
  /** Available resources for context analysis */
  availableResources?: Record<string, any>;
  /** Schema proxy for schema field analysis */
  schemaProxy?: any;
  /** Resource ID for context */
  resourceId?: string;
}

/**
 * Result of expression analysis
 */
export interface ExpressionAnalysisResult {
  /** Whether the expression contains KubernetesRef objects */
  hasKubernetesRefs: boolean;
  /** Fields that are static values */
  staticFields: string[];
  /** Fields that contain KubernetesRef objects */
  kubernetesRefFields: string[];
  /** Fields that contain CEL expressions */
  celExpressionFields: string[];
  /** Detailed analysis results */
  analysisDetails?: any;
}

/**
 * Result of factory analysis
 */
export interface FactoryAnalysisResult {
  /** Factory name */
  factoryName: string;
  /** Analysis results */
  analysis: ExpressionAnalysisResult;
  /** Recommended optimizations */
  optimizations: string[];
  /** Performance metrics */
  metrics: {
    analysisTimeMs: number;
    fieldsAnalyzed: number;
  };
}

/**
 * Configuration for expression conversion
 */
export interface ConversionConfig {
  /** Target format for conversion */
  targetFormat: 'cel' | 'javascript';
  /** Whether to preserve static values */
  preserveStatic?: boolean;
  /** Maximum depth for recursive conversion */
  maxDepth?: number;
  /** Whether to enable optimization */
  enableOptimization?: boolean;
}

/**
 * Result of expression conversion
 */
export interface ConversionResult<T = any> {
  /** Converted expression */
  converted: T;
  /** Whether conversion was successful */
  success: boolean;
  /** Error message if conversion failed */
  error?: string;
  /** Warnings generated during conversion */
  warnings: string[];
  /** Metadata about the conversion */
  metadata: {
    originalType: string;
    convertedType: string;
    conversionTimeMs: number;
  };
}

/**
 * Context for CEL expression generation
 */
export interface CelGenerationContext {
  /** Resource references available in the context */
  resourceRefs: Record<string, KubernetesRef<any>>;
  /** Schema references available in the context */
  schemaRefs: Record<string, KubernetesRef<any>>;
  /** Factory type for context-aware generation */
  factoryType: 'direct' | 'kro';
}

/**
 * Options for expression analysis
 */
export interface AnalysisOptions {
  /** Whether to enable deep analysis */
  deep?: boolean;
  /** Maximum depth for recursive analysis */
  maxDepth?: number;
  /** Whether to include performance metrics */
  includeMetrics?: boolean;
  /** Whether to generate optimization suggestions */
  generateOptimizations?: boolean;
}

/**
 * Migration suggestion for converting between expression types
 */
export interface MigrationSuggestion {
  /** Original expression */
  original: string;
  /** Suggested replacement */
  suggested: string;
  /** Confidence level (0-1) */
  confidence: number;
  /** Whether the migration is safe */
  isSafe: boolean;
  /** Explanation of the migration */
  explanation: string;
  /** JavaScript equivalent if converting from CEL */
  suggestedJavaScript?: string;
}

/**
 * Analysis of migration opportunities
 */
export interface MigrationAnalysis {
  /** List of migration suggestions */
  suggestions: MigrationSuggestion[];
  /** Overall migration feasibility */
  migrationFeasibility: {
    totalExpressions: number;
    migratableExpressions: number;
    highConfidenceMigrations: number;
    safeMigrations: number;
  };
  /** Summary of the analysis */
  summary: string;
}

/**
 * Context for lazy expression analysis
 */
export interface LazyAnalysisContext {
  /** Whether analysis should be performed immediately */
  immediate?: boolean;
  /** Cache key for storing analysis results */
  cacheKey?: string;
  /** TTL for cached results in milliseconds */
  cacheTtl?: number;
}

/**
 * Lazy analyzed expression wrapper
 */
export interface LazyAnalyzedExpression<T = any> {
  /** Get the analyzed result */
  getAnalysis(): Promise<ExpressionAnalysisResult>;
  /** Get the original expression */
  getOriginal(): T;
  /** Whether analysis has been performed */
  isAnalyzed(): boolean;
  /** Force immediate analysis */
  analyze(): Promise<ExpressionAnalysisResult>;
}

/**
 * Performance metrics for expression analysis
 */
export interface AnalysisMetrics {
  /** Total analysis time in milliseconds */
  totalTimeMs: number;
  /** Number of expressions analyzed */
  expressionsAnalyzed: number;
  /** Number of KubernetesRef objects found */
  kubernetesRefsFound: number;
  /** Number of CEL expressions found */
  celExpressionsFound: number;
  /** Cache hit rate */
  cacheHitRate?: number;
  /** Memory usage in bytes */
  memoryUsageBytes?: number;
}

/**
 * Configuration for expression caching
 */
export interface CacheConfig {
  /** Maximum cache size */
  maxSize?: number;
  /** TTL for cache entries in milliseconds */
  ttl?: number;
  /** Whether to enable cache metrics */
  enableMetrics?: boolean;
}

/**
 * Cache entry for expression analysis
 */
export interface CacheEntry<T = any> {
  /** Cached value */
  value: T;
  /** Timestamp when cached */
  timestamp: number;
  /** TTL for this entry */
  ttl: number;
  /** Number of times accessed */
  accessCount: number;
}

/**
 * Context for resource analysis
 */
export interface ResourceAnalysisContext extends AnalysisContext {
  /** Resource type being analyzed */
  resourceType: string;
  /** Resource configuration */
  resourceConfig: Record<string, any>;
}

/**
 * Context for status builder analysis
 */
export interface StatusBuilderContext extends AnalysisContext {
  /** Status schema type */
  statusSchemaType: string;
  /** Available resources for status building */
  availableResources: Record<string, any>;
}

/**
 * Validation result for expressions
 */
export interface ValidationResult {
  /** Whether the expression is valid */
  isValid: boolean;
  /** Error messages if invalid */
  errors: string[];
  /** Warning messages */
  warnings: string[];
  /** Suggested fixes */
  suggestions: string[];
}

/**
 * Context switching configuration
 */
export interface ContextSwitchConfig {
  /** Source context */
  from: AnalysisContext;
  /** Target context */
  to: AnalysisContext;
  /** Whether to preserve analysis results */
  preserveAnalysis?: boolean;
}

/**
 * Result of context switching
 */
export interface ContextSwitchResult {
  /** Whether switching was successful */
  success: boolean;
  /** New context after switching */
  newContext: AnalysisContext;
  /** Any warnings generated during switching */
  warnings: string[];
}