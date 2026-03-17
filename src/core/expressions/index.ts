/**
 * JavaScript to CEL Expression Analysis and Type Safety Integration
 *
 * This barrel exports the curated public API for the expressions module.
 * For advanced or specialized APIs, import directly from sub-modules:
 *
 *   import { MagicAssignableAnalyzer } from './magic-proxy/magic-assignable-analyzer.js';
 *   import { CompositionExpressionAnalyzer } from './composition/index.js';
 */

export type { AnalysisContext, ExpressionValidationReport } from './analysis/analyzer.js';
// =============================================================================
// CORE ANALYSIS
// =============================================================================
export { JavaScriptToCelAnalyzer } from './analysis/analyzer.js';
export type { CacheOptions, CacheStats } from './analysis/cache.js';
export { ExpressionCache, globalExpressionCache } from './analysis/cache.js';
export type { ParseOptions, ParseResult } from './analysis/parser.js';
export {
  canParse,
  DEFAULT_PARSER_OPTIONS,
  ParserError,
  parseExpression,
  parseExpressionSafe,
  parseScript,
  parseScriptSafe,
} from './analysis/parser.js';
export type { SourceMapEntry } from './analysis/source-map.js';
export { SourceMapBuilder, SourceMapUtils } from './analysis/source-map.js';
export type {
  CelGenerationConfig,
  CelGenerationResult,
} from './context/context-aware-generator.js';
export { ContextAwareCelGenerator } from './context/context-aware-generator.js';
export type {
  CelGenerationStrategy,
  ContextDetectionConfig,
  ContextDetectionResult,
  ContextMetadata,
  ExpressionContext,
} from './context/context-detector.js';
// =============================================================================
// CONTEXT-AWARE CONVERSION
// =============================================================================
export { contextDetector, ExpressionContextDetector } from './context/context-detector.js';

export type {
  ContextValidationConfig,
  ContextValidationReport,
  ValidationIssue,
  ValidationSeverity,
} from './context/context-validator.js';
export { ContextExpressionValidator } from './context/context-validator.js';
export type { CelConversionConfig, CelConversionResult } from './factory/cel-conversion-engine.js';
// =============================================================================
// CEL CONVERSION
// =============================================================================
export {
  CelConversionEngine,
  celConversionEngine,
  convertToCel,
  kubernetesRefToCel,
  needsCelConversion,
} from './factory/cel-conversion-engine.js';
export type {
  ExpressionAnalysisResult,
  FactoryAnalysisConfig,
  FactoryAnalysisResult,
  FactoryConfigAnalysisResult,
  FactoryExpressionContext,
} from './factory/factory-integration.js';
// =============================================================================
// FACTORY INTEGRATION
// =============================================================================
export {
  analyzeFactoryConfig,
  FactoryExpressionAnalyzer,
  factoryExpressionAnalyzer,
  processFactoryValue,
  withExpressionAnalysis,
} from './factory/factory-integration.js';
export type {
  FactoryExpressionHandler,
  FactoryPatternType,
} from './factory/factory-pattern-handler.js';
export {
  DirectFactoryExpressionHandler,
  FactoryPatternHandlerFactory,
  handleExpressionWithFactoryPattern,
  KroFactoryExpressionHandler,
} from './factory/factory-pattern-handler.js';
export type {
  MigrationAnalysisResult,
  MigrationCategory,
  MigrationSuggestion,
} from './factory/migration-helpers.js';
// =============================================================================
// MIGRATION HELPERS
// =============================================================================
export {
  analyzeCelMigrationOpportunities,
  CelToJavaScriptMigrationHelper,
  generateCelMigrationGuide,
} from './factory/migration-helpers.js';
export type {
  StatusBuilderAnalysisResult,
  StatusBuilderFunction,
  StatusFieldAnalysisResult,
} from './factory/status-builder-analyzer.js';
// =============================================================================
// STATUS BUILDER ANALYSIS
// =============================================================================
export {
  analyzeStatusBuilder,
  analyzeStatusBuilderForToResourceGraph,
  StatusBuilderAnalyzer,
} from './factory/status-builder-analyzer.js';
export type {
  MagicProxyDetectionConfig,
  MagicProxyDetectionResult,
  MagicProxyRefInfo,
} from './magic-proxy/magic-proxy-detector.js';
// =============================================================================
// MAGIC PROXY DETECTION
// =============================================================================
export {
  containsMagicProxyRefs,
  detectMagicProxyRefs,
  extractMagicProxyRefs,
  MagicProxyDetector,
  magicProxyDetector,
} from './magic-proxy/magic-proxy-detector.js';
export type {
  CompileTimeTypeInfo,
  CompileTimeValidationContext,
  CompileTimeValidationResult,
} from './validation/compile-time-validation.js';
// =============================================================================
// VALIDATION
// =============================================================================
export {
  CompileTimeError,
  CompileTimeTypeChecker,
  CompileTimeWarning,
} from './validation/compile-time-validation.js';
export type {
  ResourceValidationMetadata,
  ResourceValidationResult,
  ValidationContext,
} from './validation/resource-validation.js';
export {
  ResourceReferenceValidator,
  ResourceValidationError,
  ResourceValidationWarning,
} from './validation/resource-validation.js';
export type { CelTypeInferenceResult, TypeInferenceContext } from './validation/type-inference.js';
export {
  CelTypeInferenceEngine,
  TypeInferenceError,
  TypeInferenceWarning,
} from './validation/type-inference.js';
export type { TypeInfo, TypeValidationResult } from './validation/type-safety.js';
export {
  ExpressionTypeValidator,
  TypeRegistry,
  TypeSafetyUtils,
  TypeValidationError,
  TypeValidationWarning,
} from './validation/type-safety.js';
