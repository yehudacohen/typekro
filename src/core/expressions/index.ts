/**
 * JavaScript to CEL Expression Analysis and Type Safety Integration
 * 
 * This module provides comprehensive type safety integration for JavaScript
 * to CEL expression conversion, including compile-time validation, runtime
 * type inference, and resource reference validation.
 */

// Unified Parser Utility
export {
  parseExpression,
  parseExpressionSafe,
  parseScript,
  parseScriptSafe,
  canParse,
  ParserError,
  DEFAULT_PARSER_OPTIONS,
} from './analysis/parser.js';
export type { ParseOptions, ParseResult } from './analysis/parser.js';

// Core analyzer
export { JavaScriptToCelAnalyzer } from './analysis/analyzer.js';
export type { 
  AnalysisContext, 
  ExpressionValidationReport,
  ValidationSummary 
} from './analysis/analyzer.js';

// Type safety integration
export { 
  ExpressionTypeValidator, 
  TypeRegistry, 
  TypeSafetyUtils,
  TypeValidationError,
  TypeValidationWarning 
} from './validation/type-safety.js';
export type { 
  TypeInfo, 
  TypeValidationResult 
} from './validation/type-safety.js';

// Type inference
export { 
  CelTypeInferenceEngine,
  TypeInferenceError,
  TypeInferenceWarning 
} from './validation/type-inference.js';
export type { 
  CelTypeInferenceResult,
  TypeInferenceContext,
  TypeInferenceMetadata 
} from './validation/type-inference.js';

// Resource validation
export { 
  ResourceReferenceValidator,
  ResourceValidationError,
  ResourceValidationWarning 
} from './validation/resource-validation.js';
export type { 
  ResourceValidationResult,
  ResourceValidationMetadata,
  ValidationContext 
} from './validation/resource-validation.js';

// Compile-time validation
export { 
  CompileTimeTypeChecker,
  CompileTimeError,
  CompileTimeWarning 
} from './validation/compile-time-validation.js';
export type { 
  CompileTimeValidationResult,
  CompileTimeTypeInfo,
  CompileTimeValidationContext,
  TypeCompatibilityIssue 
} from './validation/compile-time-validation.js';

// Factory pattern integration
export { 
  DirectFactoryExpressionHandler,
  KroFactoryExpressionHandler,
  FactoryPatternHandlerFactory,
  handleExpressionWithFactoryPattern 
} from './factory/factory-pattern-handler.js';
export type { 
  FactoryPatternType,
  FactoryExpressionHandler 
} from './factory/factory-pattern-handler.js';

// Source mapping and error handling
export { SourceMapBuilder, SourceMapUtils } from './analysis/source-map.js';
export type { SourceMapEntry } from './analysis/source-map.js';

export { CelRuntimeErrorMapper, CelRuntimeErrorUtils } from './analysis/runtime-error-mapper.js';
export type { 
  CelRuntimeError, 
  MappedRuntimeError 
} from './analysis/runtime-error-mapper.js';

// MagicAssignable type integration
export { 
  MagicAssignableAnalyzer,
  analyzeMagicAssignable,
  analyzeMagicAssignableShape 
} from './magic-proxy/magic-assignable-analyzer.js';
export type { 
  ProcessedMagicAssignable,
  ProcessedMagicAssignableShape,
  MagicAssignableAnalysisOptions 
} from './magic-proxy/magic-assignable-analyzer.js';

// Performance optimization and caching
export { ExpressionCache, globalExpressionCache } from './analysis/cache.js';
export type { 
  CacheStats, 
  CacheOptions 
} from './analysis/cache.js';

// Enhanced Type Optionality Support
export { 
  EnhancedTypeOptionalityHandler,
  analyzeOptionalityRequirements,
  generateNullSafeCelExpression,
  handleOptionalChainingWithEnhancedTypes,
  generateCelWithHasChecks,
  detectNullSafetyRequirements,
  integrateWithFieldHydrationTiming,
  handleUndefinedToDefinedTransitions
} from './magic-proxy/optionality-handler.js';
export type { 
  OptionalityAnalysisResult,
  FieldHydrationState,
  OptionalityContext,
  OptionalityHandlingOptions,
  OptionalChainingPattern,
  EnhancedTypeFieldInfo,
  HydrationStateAnalysis,
  HydrationTransitionPlan,
  HydrationPhase,
  HydrationTransitionHandler,
  HydrationState,
  UndefinedToDefinedTransitionResult
} from './magic-proxy/optionality-handler.js';

// Status Builder Analysis
export { 
  StatusBuilderAnalyzer,
  analyzeStatusBuilder,
  analyzeStatusBuilderForToResourceGraph,
  analyzeReturnObjectWithMagicProxy,
  generateStatusContextCel
} from './factory/status-builder-analyzer.js';
export type { 
  StatusBuilderFunction,
  StatusFieldAnalysisResult,
  StatusBuilderAnalysisResult,
  ReturnStatementAnalysis,
  PropertyAnalysis,
  StatusBuilderAnalysisOptions,
  StatusFieldHandlingInfo,
  StatusHandlingStrategy,
  StatusFieldCategory,
  FieldAvailabilityEstimate
} from './factory/status-builder-analyzer.js';

// Resource Builder Integration
export { 
  ResourceAnalyzer,
  DependencyTracker,
  ResourceTypeValidator,
  analyzeResourceConfig,
  analyzeFactoryResourceConfig
} from './factory/resource-analyzer.js';
export type { 
  ResourceAnalysisContext,
  ResourceAnalysisResult,
  ResourceTypeValidationResult,
  DependencyInfo,
  DependencyGraph,
  DependencyTrackingOptions,
  CircularDependencyAnalysis,
  CircularChainAnalysis,
  CircularDependencyRecommendation,
  ResourceTypeValidationContext,
  ResourceTypeInfo,
  SchemaValidator,
  SchemaFieldValidationResult,
  FieldPathValidationResult,
  TypeCompatibilityValidationResult
} from './factory/resource-analyzer.js';

// Context-Aware Conversion
export { 
  ExpressionContextDetector,
  contextDetector
} from './context/context-detector.js';
export type { 
  ExpressionContext,
  ContextDetectionResult,
  CelGenerationStrategy,
  ContextMetadata,
  ContextDetectionConfig
} from './context/context-detector.js';

// Lazy Analysis Support
export {
  LazyAnalyzedExpression,
  LazyExpressionCollection,
  OnDemandExpressionAnalyzer,
  ExpressionTreeAnalyzer,
  LazyExpressionTreeLoader,
  MagicProxyLazyIntegration,
  MemoryOptimizedExpressionManager,
  ParallelExpressionAnalyzer,
  ExpressionAnalysisProfiler,
  OptimizedKubernetesRefDetector,
  OptimizedExpressionTraverser,
  ExpressionComplexityAnalyzer,
  TraversalAction,
  createLazyExpression,
  createLazyCollection,
  shouldUseLazyAnalysis,
  globalOnDemandAnalyzer,
  globalTreeAnalyzer,
  globalLazyTreeLoader,
  globalMagicProxyIntegration,
  globalMemoryOptimizedManager,
  globalParallelAnalyzer,
  globalExpressionProfiler,
  globalOptimizedDetector,
  globalOptimizedTraverser,
  globalComplexityAnalyzer
} from './analysis/lazy-analysis.js';
export type {
  LazyCollectionStats,
  ExpressionTreeResult,
  ExpressionTreeStats,
  LazyProxyOptions,
  LazyTreeLoaderStats,
  MagicProxyIntegrationStats,
  MemoryOptimizationOptions,
  MemoryStats,
  MemoryCleanupResult,
  ParallelAnalysisStats,
  AdvancedParallelAnalysisStats,
  AdaptiveAnalysisOptions,
  PerformanceProfile,
  PerformanceStats,
  TraversalContext,
  TraversalOptions,
  TraversalResult,
  ComplexityThresholds,
  ComplexityLevel,
  MemoryImpact,
  ComplexityMetrics,
  ComplexityWarning,
  ComplexityAnalysisResult,
  ComplexityStats
} from './analysis/lazy-analysis.js';

export { 
  ContextAwareCelGenerator,
  CelGenerationUtils,
  contextAwareCelGenerator
} from './context/context-aware-generator.js';
export type { 
  CelGenerationConfig,
  CelGenerationResult,
  CelGenerationDebugInfo
} from './context/context-aware-generator.js';

export { 
  ContextExpressionValidator,
  ContextValidationUtils,
  contextValidator
} from './context/context-validator.js';
export type { 
  ValidationSeverity,
  ContextValidationRule,
  ContextValidationConfig,
  ContextValidationReport,
  ValidationIssue
} from './context/context-validator.js';

export { 
  ExpressionContextSwitcher,
  ContextSwitchingUtils,
  createContextSwitcher
} from './context/context-switcher.js';
export type { 
  ContextSwitchingConfig,
  ContextSwitchingRule,
  ContextSwitchPoint,
  ContextSwitchingResult,
  ContextSwitchingMetrics
} from './context/context-switcher.js';

// Migration helpers
export { 
  CelToJavaScriptMigrationHelper,
  analyzeCelMigrationOpportunities,
  generateCelMigrationGuide
} from './factory/migration-helpers.js';
export type {
  MigrationSuggestion,
  MigrationCategory,
  MigrationAnalysisResult
} from './factory/migration-helpers.js';

// Factory integration
export {
  FactoryExpressionAnalyzer,
  factoryExpressionAnalyzer,
  withExpressionAnalysis,
  analyzeFactoryConfig,
  processFactoryValue
} from './factory/factory-integration.js';
export type {
  FactoryAnalysisConfig,
  FactoryConfigAnalysisResult,
  FactoryExpressionContext,
  ExpressionAnalysisResult,
  FactoryAnalysisResult
} from './factory/factory-integration.js';

// Magic proxy detection
export {
  MagicProxyDetector,
  magicProxyDetector,
  detectMagicProxyRefs,
  containsMagicProxyRefs,
  extractMagicProxyRefs,
  analyzeMagicProxyRefSource
} from './magic-proxy/magic-proxy-detector.js';
export type {
  MagicProxyRefInfo,
  MagicProxyDetectionResult,
  MagicProxyDetectionConfig
} from './magic-proxy/magic-proxy-detector.js';

// CEL conversion engine
export {
  CelConversionEngine,
  celConversionEngine,
  convertToCel,
  kubernetesRefToCel,
  needsCelConversion
} from './factory/cel-conversion-engine.js';
export type {
  CelConversionConfig,
  CelConversionResult
} from './factory/cel-conversion-engine.js';

// Composition integration
export {
  CompositionExpressionAnalyzer,
  CompositionIntegrationHooks,
  CompositionContextTracker,
  MagicProxyScopeManager,
  compositionIntegration,
  compositionUsesKubernetesRefs,
  getCompositionAnalysis
} from './composition/composition-integration.js';
export type {
  CompositionAnalysisResult,
  CompositionPattern,
  PatternAnalysisConfig,
  NestedCompositionScope
} from './composition/composition-integration.js';