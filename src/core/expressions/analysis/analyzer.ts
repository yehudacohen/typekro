/**
 * JavaScript to CEL Expression Analyzer — Orchestrator
 *
 * This module provides the core functionality for detecting KubernetesRef objects
 * in JavaScript expressions and converting them to appropriate CEL expressions.
 *
 * The analyzer works with TypeKro's magic proxy system where schema.spec.name and
 * resources.database.status.podIP return KubernetesRef objects at runtime.
 *
 * Implementation is decomposed into:
 * - cel-emitter.ts — AST-to-CEL conversion engine
 * - scope-resolver.ts — dependency extraction & resource reference resolution
 * - expression-classifier.ts — expression type dispatch & special case handling
 */

import type { Node as ESTreeNode } from 'estree';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { ConversionError, ensureError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import { handleExpressionWithFactoryPattern } from '../factory/factory-pattern-handler.js';
import {
  CompileTimeTypeChecker,
  type CompileTimeValidationContext,
  type CompileTimeValidationResult,
} from '../validation/compile-time-validation.js';
import {
  ResourceReferenceValidator,
  type ResourceValidationResult,
  type ValidationContext,
} from '../validation/resource-validation.js';
import {
  CelTypeInferenceEngine,
  type CelTypeInferenceResult,
  type TypeInferenceContext,
} from '../validation/type-inference.js';
import {
  ExpressionTypeValidator,
  type TypeInfo,
  TypeRegistry,
  TypeSafetyUtils,
  TypeValidationError,
  type TypeValidationResult,
} from '../validation/type-safety.js';
import { type CacheOptions, type CacheStats, ExpressionCache } from './cache.js';
import {
  convertASTNode as convertASTNodeFn,
  convertASTNodeWithSourceTracking as convertASTNodeWithSourceTrackingFn,
} from './cel-emitter.js';
import {
  analyzeExpressionWithRefs as analyzeExpressionWithRefsFn,
  analyzeKubernetesRefObject,
  analyzeObjectExpression,
  analyzePrimitiveExpression,
  createStaticValueResult as createStaticValueResultFn,
  handleSpecialCases as handleSpecialCasesFn,
  isStaticValue as isStaticValueFn,
} from './expression-classifier.js';
import { ParserError, parseExpression } from './parser.js';
import { convertKubernetesRefToCel as convertKubernetesRefToCelFn } from './scope-resolver.js';
// Shared types — extracted from this file to break circular deps with cache.ts / factory-pattern-handler.ts
import type {
  AnalysisContext,
  CelConversionResult,
  ExpressionValidationReport,
  ValidationSummary,
  ValidationWarning,
} from './shared-types.js';
import { type SourceMapEntry, SourceMapUtils } from './source-map.js';

// Re-export shared types for backward compatibility
export type {
  AnalysisContext,
  CelConversionResult,
  ExpressionValidationReport,
  ValidationSummary,
  ValidationWarning,
} from './shared-types.js';

/**
 * Main analyzer class for JavaScript to CEL expression conversion
 */
export class JavaScriptToCelAnalyzer {
  private cache: ExpressionCache;
  private typeValidator = new ExpressionTypeValidator();
  private enableMetrics: boolean;

  constructor(cacheOptions?: CacheOptions) {
    this.cache = new ExpressionCache(cacheOptions);
    this.enableMetrics = cacheOptions?.enableMetrics ?? true;
  }
  private typeInferenceEngine = new CelTypeInferenceEngine();
  private resourceValidator = new ResourceReferenceValidator();
  private compileTimeChecker = new CompileTimeTypeChecker();

  // ── Bound converter for recursive AST conversion ───────────────────
  // The cel-emitter functions need a callback to recurse into sub-nodes.
  // We bind convertASTNode here once so it can reference `this.convertASTNode`.
  private readonly boundConvertASTNode = (node: ESTreeNode, context: AnalysisContext) =>
    this.convertASTNode(node, context);

  // ── Public entry points ────────────────────────────────────────────

  /**
   * Analyze any expression type and convert to CEL if needed
   */
  analyzeExpression(expression: unknown, context: AnalysisContext): CelConversionResult {
    // Handle different expression types
    if (typeof expression === 'string') {
      return this.analyzeStringExpression(expression, context);
    }

    // Handle KubernetesRef objects directly
    if (isKubernetesRef(expression)) {
      return analyzeKubernetesRefObject(expression, context);
    }

    // Handle other objects
    if (typeof expression === 'object' && expression !== null) {
      return analyzeObjectExpression(expression, context);
    }

    // Handle primitives
    return analyzePrimitiveExpression(expression, context);
  }

  /**
   * Analyze a JavaScript string expression and convert to CEL if it contains KubernetesRef objects
   */
  analyzeStringExpression(expression: string, context: AnalysisContext): CelConversionResult {
    // Check cache first
    const cached = this.cache.get(expression, context);
    if (cached) return cached;

    try {
      // Parse JavaScript expression to AST with location tracking
      const exprNode = parseExpression(expression);

      // Create source location from AST (handle case where loc might be undefined)
      const astLoc = exprNode.loc;
      const sourceLocation = astLoc
        ? SourceMapUtils.createSourceLocation(astLoc, expression)
        : { line: 1, column: 1, length: expression.length };

      // Initialize dependencies array if not provided
      if (!context.dependencies) {
        context.dependencies = [];
      }

      // Convert to CEL with source tracking
      const celExpression = this.convertASTNodeWithSourceTracking(
        exprNode,
        context,
        expression,
        sourceLocation
      );

      // Add source mapping entry
      const sourceMapEntries: SourceMapEntry[] = [];
      if (context.sourceMap) {
        const _mappingId = context.sourceMap.addMapping(
          expression,
          celExpression.expression,
          sourceLocation,
          context.type,
          {
            expressionType: SourceMapUtils.determineExpressionType(exprNode.type),
            kubernetesRefs: SourceMapUtils.extractKubernetesRefPaths(celExpression.expression),
            dependencies:
              context.dependencies?.map((dep) => `${dep.resourceId}.${dep.fieldPath}`) || [],
            conversionNotes: [`Converted from ${exprNode.type} AST node`],
          }
        );
        sourceMapEntries.push(...context.sourceMap.getEntries());
      }

      // Perform type validation and inference if enabled
      let typeValidation: TypeValidationResult | undefined;
      let inferredType: TypeInfo | undefined;
      let resourceValidation: ResourceValidationResult[] | undefined;

      if (context.strictTypeChecking !== false && context.typeRegistry) {
        const availableTypes = context.typeRegistry.getAvailableTypes();
        typeValidation = this.typeValidator.validateExpression(
          expression,
          availableTypes,
          context.expectedType
        );
        inferredType = typeValidation.resultType;

        // Also perform CEL type inference
        const celTypeInference = this.inferCelExpressionType(celExpression, context);
        if (celTypeInference.success && !inferredType) {
          inferredType = celTypeInference.resultType;
        }
      }

      // Validate resource references if enabled
      if (context.validateResourceReferences !== false && context.dependencies) {
        resourceValidation = this.validateResourceReferences(
          context.dependencies,
          context.availableReferences,
          context.schemaProxy,
          context.validationContext
        );
      }

      // Perform compile-time type checking if enabled
      let compileTimeValidation: CompileTimeValidationResult | undefined;
      if (context.compileTimeTypeChecking !== false && context.compileTimeContext) {
        compileTimeValidation = this.performCompileTimeValidation(
          expression,
          context.compileTimeContext
        );
      }

      // Only treat compile-time and type validation errors as critical
      const hasCompileTimeErrors = compileTimeValidation && !compileTimeValidation.valid;
      const hasTypeValidationErrors = typeValidation && !typeValidation.valid;

      // Collect only critical validation errors that should affect validity
      const criticalErrors: ConversionError[] = [];
      if (compileTimeValidation?.errors) {
        for (const err of compileTimeValidation.errors) {
          criticalErrors.push(new ConversionError(err.message, '', 'unknown'));
        }
      }
      if (typeValidation?.errors) {
        for (const err of typeValidation.errors) {
          criticalErrors.push(new ConversionError(err.message, '', 'unknown'));
        }
      }

      // Aggregate warnings from all validation results
      const aggregatedWarnings: ValidationWarning[] = [];

      // Add resource validation warnings and errors (treat errors as warnings)
      if (resourceValidation) {
        for (const rv of resourceValidation) {
          // Add warnings
          for (const warning of rv.warnings) {
            const warningObj: ValidationWarning = {
              message: warning.message,
              type: warning.warningType,
            };
            if (rv.suggestions.length > 0) {
              warningObj.suggestion = rv.suggestions.join('; ');
            }
            aggregatedWarnings.push(warningObj);
          }
          // Add errors as warnings (resource validation errors shouldn't fail the entire expression)
          if (rv.errors) {
            for (const error of rv.errors) {
              const warningObj: ValidationWarning = {
                message: ensureError(error).message,
                type: 'resource_validation',
              };
              if (rv.suggestions.length > 0) {
                warningObj.suggestion = rv.suggestions.join('; ');
              }
              aggregatedWarnings.push(warningObj);
            }
          }
        }
      }

      // Add type validation warnings (if any)
      if (typeValidation?.warnings) {
        for (const warning of typeValidation.warnings) {
          aggregatedWarnings.push({
            message: warning.message,
            type: 'type_validation',
          });
        }
      }

      // Add compile-time validation warnings (if any)
      if (compileTimeValidation?.warnings) {
        for (const warning of compileTimeValidation.warnings) {
          aggregatedWarnings.push({
            message: warning.message,
            type: 'compile_time',
          });
        }
      }

      const result: CelConversionResult = {
        valid: celExpression !== null && !hasCompileTimeErrors && !hasTypeValidationErrors,
        celExpression,
        dependencies: context.dependencies || [],
        sourceMap: sourceMapEntries,
        errors: criticalErrors,
        requiresConversion: (context.dependencies || []).length > 0,
        typeValidation,
        inferredType,
        resourceValidation,
        compileTimeValidation,
        warnings: aggregatedWarnings,
      };

      // Cache the result
      this.cache.set(expression, context, result);
      return result;
    } catch (error: unknown) {
      // If parsing fails, try to handle it as a special case
      const specialCaseResult = handleSpecialCasesFn(
        expression,
        context,
        this.validateResourceReferences.bind(this)
      );
      if (specialCaseResult) {
        // Only cache successful special case results
        if (specialCaseResult.valid) {
          this.cache.set(expression, context, specialCaseResult);
        }
        return specialCaseResult;
      }

      // Create detailed error with source location from ParserError if available
      let sourceLocation = { line: 1, column: 1, length: expression.length };
      let errorMessage = ensureError(error).message;

      // Extract enhanced error information from ParserError
      if (error instanceof ParserError) {
        sourceLocation = {
          line: error.line,
          column: error.column,
          length: expression.length,
        };
        errorMessage = error.message;
      }

      const conversionError = ConversionError.forParsingFailure(
        expression,
        errorMessage,
        sourceLocation,
        ensureError(error)
      );

      const errorResult: CelConversionResult = {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [conversionError],
        requiresConversion: false,
        warnings: [],
      };

      // Don't cache error results to allow retry
      return errorResult;
    }
  }

  // ── AST conversion (delegates to cel-emitter) ──────────────────────

  /**
   * Convert an AST node to CEL expression
   */
  convertASTNode(node: ESTreeNode, context: AnalysisContext): CelExpression {
    return convertASTNodeFn(node, context, this.boundConvertASTNode);
  }

  /**
   * Convert an AST node to CEL expression with source location tracking
   */
  convertASTNodeWithSourceTracking(
    node: ESTreeNode,
    context: AnalysisContext,
    originalExpression: string,
    sourceLocation: { line: number; column: number; length: number }
  ): CelExpression {
    return convertASTNodeWithSourceTrackingFn(
      node,
      context,
      originalExpression,
      sourceLocation,
      this.boundConvertASTNode
    );
  }

  // ── Expression classification (delegates to expression-classifier) ─

  /**
   * Analyze expressions that may contain KubernetesRef objects from magic proxy system
   */
  analyzeExpressionWithRefs(expression: unknown, context: AnalysisContext): CelConversionResult {
    return analyzeExpressionWithRefsFn(expression, context, this.analyzeExpression.bind(this));
  }

  // ── KubernetesRef conversion (delegates to scope-resolver) ─────────

  /**
   * Convert a KubernetesRef directly to a CEL expression
   */
  convertKubernetesRefToCel(ref: KubernetesRef<unknown>, context: AnalysisContext): CelExpression {
    return convertKubernetesRefToCelFn(ref, context, this.typeValidator);
  }

  // ── Static value detection (delegates to expression-classifier) ────

  /**
   * Check if a value is a static literal that doesn't need conversion
   */
  isStaticValue(value: unknown): boolean {
    return isStaticValueFn(value);
  }

  /**
   * Create a result for static values that don't require conversion
   */
  createStaticValueResult(value: unknown): CelConversionResult {
    return createStaticValueResultFn(value);
  }

  // ── Validation delegation ──────────────────────────────────────────

  /**
   * Setup type registry from analysis context
   */
  setupTypeRegistry(context: AnalysisContext): TypeRegistry {
    const registry = new TypeRegistry();

    // Register resource types
    for (const [resourceId, resource] of Object.entries(context.availableReferences)) {
      const resourceType = TypeSafetyUtils.fromEnhancedType(resource);
      registry.registerResourceType(resourceId, resourceType);
    }

    // Register basic types
    registry.registerType('string', { typeName: 'string', optional: false, nullable: false });
    registry.registerType('number', { typeName: 'number', optional: false, nullable: false });
    registry.registerType('boolean', { typeName: 'boolean', optional: false, nullable: false });
    registry.registerType('null', { typeName: 'null', optional: false, nullable: true });
    registry.registerType('undefined', { typeName: 'undefined', optional: true, nullable: false });

    return registry;
  }

  /**
   * Validate expression compatibility with target context
   */
  validateExpressionCompatibility(
    expression: string,
    context: AnalysisContext
  ): TypeValidationResult {
    const registry = context.typeRegistry || this.setupTypeRegistry(context);
    const availableTypes = registry.getAvailableTypes();

    return this.typeValidator.validateExpression(expression, availableTypes, context.expectedType);
  }

  /**
   * Infer the type of a CEL expression
   */
  inferCelExpressionType(
    celExpression: CelExpression,
    context: AnalysisContext
  ): CelTypeInferenceResult {
    const inferenceContext: TypeInferenceContext = {
      availableResources: context.availableReferences,
      ...(context.schemaProxy && { schemaProxy: context.schemaProxy }),
      factoryType: context.factoryType,
    };

    return this.typeInferenceEngine.inferType(celExpression, inferenceContext);
  }

  /**
   * Infer types for multiple CEL expressions
   */
  inferCelExpressionTypes(
    celExpressions: CelExpression[],
    context: AnalysisContext
  ): CelTypeInferenceResult[] {
    const inferenceContext: TypeInferenceContext = {
      availableResources: context.availableReferences,
      ...(context.schemaProxy && { schemaProxy: context.schemaProxy }),
      factoryType: context.factoryType,
    };

    return this.typeInferenceEngine.inferTypes(celExpressions, inferenceContext);
  }

  /**
   * Validate type compatibility between JavaScript and CEL expressions
   */
  validateJavaScriptToCelTypeCompatibility(
    jsExpression: string,
    celExpression: CelExpression,
    context: AnalysisContext
  ): TypeValidationResult {
    // Get JavaScript expression type
    const jsValidation = this.validateExpressionCompatibility(jsExpression, context);
    if (!jsValidation.resultType) {
      return jsValidation;
    }

    // Get CEL expression type
    const celInference = this.inferCelExpressionType(celExpression, context);
    if (!celInference.success) {
      return {
        valid: false,
        errors: celInference.errors.map(
          (e) =>
            new TypeValidationError(
              e.message,
              e.celExpression,
              { typeName: 'unknown', optional: false, nullable: false },
              { typeName: 'unknown', optional: false, nullable: false }
            )
        ),
        warnings: [],
        suggestions: [],
      };
    }

    // Validate compatibility
    return this.typeInferenceEngine.validateTypeCompatibility(
      jsValidation.resultType,
      celInference.resultType
    );
  }

  /**
   * Validate resource references in KubernetesRef objects
   */
  validateResourceReferences(
    refs: KubernetesRef<unknown>[],
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
    validationContext?: ValidationContext
  ): ResourceValidationResult[] {
    return this.resourceValidator.validateKubernetesRefs(
      refs,
      availableResources,
      schemaProxy,
      validationContext
    );
  }

  /**
   * Validate a single resource reference
   */
  validateResourceReference(
    ref: KubernetesRef<unknown>,
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
    validationContext?: ValidationContext
  ): ResourceValidationResult {
    return this.resourceValidator.validateKubernetesRef(
      ref,
      availableResources,
      schemaProxy,
      validationContext
    );
  }

  /**
   * Validate a reference chain for type safety and circular dependencies
   */
  validateReferenceChain(
    refs: KubernetesRef<unknown>[],
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>
  ): ResourceValidationResult {
    return this.resourceValidator.validateReferenceChain(refs, availableResources, schemaProxy);
  }

  /**
   * Get comprehensive validation report for an expression
   */
  getValidationReport(expression: string, context: AnalysisContext): ExpressionValidationReport {
    const conversionResult = this.analyzeExpression(expression, context);

    return {
      expression,
      conversionResult,
      ...(conversionResult.typeValidation && { typeValidation: conversionResult.typeValidation }),
      ...(conversionResult.resourceValidation && {
        resourceValidation: conversionResult.resourceValidation,
      }),
      summary: this.createValidationSummary(conversionResult),
    };
  }

  /**
   * Perform compile-time type checking
   */
  performCompileTimeValidation(
    expression: string,
    context: CompileTimeValidationContext
  ): CompileTimeValidationResult {
    return this.compileTimeChecker.validateExpressionCompatibility(expression, context);
  }

  /**
   * Validate compile-time compatibility for multiple expressions
   */
  performCompileTimeValidationBatch(
    expressions: string[],
    context: CompileTimeValidationContext
  ): CompileTimeValidationResult[] {
    return this.compileTimeChecker.validateExpressionsCompatibility(expressions, context);
  }

  /**
   * Validate KubernetesRef compile-time compatibility
   */
  validateKubernetesRefCompileTimeCompatibility(
    ref: KubernetesRef<unknown>,
    context: AnalysisContext
  ): CompileTimeValidationResult {
    if (!context.compileTimeContext) {
      throw new ConversionError(
        'Compile-time context required for KubernetesRef validation',
        `${ref.resourceId}.${ref.fieldPath}`,
        'member-access'
      );
    }

    const usageContext = {
      availableResources: context.availableReferences,
      ...(context.schemaProxy && { schemaProxy: context.schemaProxy }),
      usageType: 'property-access' as const,
      ...(context.expectedType && {
        expectedResultType: {
          typeName: context.expectedType.typeName,
          isUnion: false,
          isGeneric: false,
          optional: context.expectedType.optional,
          nullable: context.expectedType.nullable,
          undefinable: context.expectedType.optional,
        },
      }),
    };

    return this.compileTimeChecker.validateKubernetesRefCompatibility(
      ref,
      usageContext,
      context.compileTimeContext
    );
  }

  /**
   * Get comprehensive compile-time validation report
   */
  getCompileTimeValidationReport(
    expression: string,
    context: AnalysisContext
  ): CompileTimeValidationResult | null {
    if (!context.compileTimeContext) {
      return null;
    }

    return this.performCompileTimeValidation(expression, context.compileTimeContext);
  }

  // ── Factory pattern integration ────────────────────────────────────

  /**
   * Analyze expression using factory pattern aware handling
   */
  analyzeExpressionWithFactoryPattern(
    expression: unknown,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // Use the factory pattern handler for initial processing
      const factoryResult = handleExpressionWithFactoryPattern(expression, context);

      // If the factory handler processed it successfully, return the result
      if (factoryResult.valid && factoryResult.celExpression) {
        return factoryResult;
      }

      // If the factory handler determined no conversion is needed, return as-is
      if (!factoryResult.requiresConversion) {
        return factoryResult;
      }

      // If the factory handler couldn't process it, fall back to the main analyzer
      if (typeof expression === 'string') {
        return this.analyzeExpression(expression, context);
      }

      // For non-string expressions that need conversion, return the factory result
      return factoryResult;
    } catch (error: unknown) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [
          new ConversionError(
            `Factory pattern expression analysis failed: ${ensureError(error).message}`,
            String(expression),
            'javascript'
          ),
        ],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Create a validation summary from conversion results
   */
  private createValidationSummary(result: CelConversionResult): ValidationSummary {
    const totalErrors =
      result.errors.length +
      (result.typeValidation?.errors.length || 0) +
      (result.resourceValidation?.reduce((sum, rv) => sum + rv.errors.length, 0) || 0) +
      (result.compileTimeValidation?.errors.length || 0);

    const totalWarnings =
      (result.typeValidation?.warnings.length || 0) +
      (result.resourceValidation?.reduce((sum, rv) => sum + rv.warnings.length, 0) || 0) +
      (result.compileTimeValidation?.warnings.length || 0);

    return {
      valid: result.celExpression !== null && totalErrors === 0,
      totalErrors,
      totalWarnings,
      requiresConversion: result.requiresConversion,
      hasTypeIssues: (result.typeValidation?.errors.length || 0) > 0,
      hasResourceIssues: result.resourceValidation?.some((rv) => !rv.valid) || false,
      hasCompileTimeIssues:
        (result.compileTimeValidation && !result.compileTimeValidation.valid) || false,
      confidence: this.calculateOverallConfidence(result),
    };
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(result: CelConversionResult): number {
    let confidence = 1.0;

    // Reduce confidence for errors
    if (result.errors.length > 0) {
      confidence *= 0.1;
    }

    // Reduce confidence for type validation issues
    if (result.typeValidation && !result.typeValidation.valid) {
      confidence *= 0.5;
    }

    // Reduce confidence for resource validation issues
    if (result.resourceValidation) {
      const invalidResources = result.resourceValidation.filter((rv) => !rv.valid).length;
      if (invalidResources > 0) {
        confidence *= Math.max(0.1, 1 - invalidResources * 0.3);
      }
    }

    // Reduce confidence for compile-time validation issues
    if (result.compileTimeValidation && !result.compileTimeValidation.valid) {
      confidence *= 0.3;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  // ── Cache management ───────────────────────────────────────────────

  /**
   * Get cache statistics for performance monitoring
   */
  getCacheStats(): CacheStats {
    return this.cache.getStats();
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Force cleanup of expired cache entries
   */
  cleanupCache(): number {
    return this.cache.cleanup();
  }

  /**
   * Destroy analyzer and cleanup resources
   */
  destroy(): void {
    this.cache.destroy();
  }
}
