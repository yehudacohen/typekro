/**
 * JavaScript to CEL Expression Analyzer
 *
 * This module provides the core functionality for detecting KubernetesRef objects
 * in JavaScript expressions and converting them to appropriate CEL expressions.
 *
 * The analyzer works with TypeKro's magic proxy system where schema.spec.name and
 * resources.database.status.podIP return KubernetesRef objects at runtime.
 */

import * as estraverse from 'estraverse';
import type {
  ArrayExpression as ESTreeArrayExpression,
  ArrowFunctionExpression as ESTreeArrowFunction,
  BinaryExpression as ESTreeBinaryExpression,
  SimpleCallExpression as ESTreeCallExpression,
  ChainExpression as ESTreeChainExpression,
  ConditionalExpression as ESTreeConditionalExpression,
  Expression as ESTreeExpression,
  Identifier as ESTreeIdentifier,
  Literal as ESTreeLiteral,
  LogicalExpression as ESTreeLogicalExpression,
  MemberExpression as ESTreeMemberExpression,
  Node as ESTreeNode,
  ReturnStatement as ESTreeReturnStatement,
  SimpleLiteral as ESTreeSimpleLiteral,
  SpreadElement as ESTreeSpreadElement,
  TemplateLiteral as ESTreeTemplateLiteral,
  UnaryExpression as ESTreeUnaryExpression,
} from 'estree';
import { escapeRegExp } from '../../../utils/helpers.js';
import {
  containsKubernetesRefs,
  extractResourceReferences,
  isKubernetesRef,
} from '../../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
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
import {
  convertArrayAccess as convertArrayAccessFn,
  extractArrowPredicate as extractArrowPredicateFn,
  extractMemberPath as extractMemberPathFn,
  getArg as getArgFn,
  getPropertyName as getPropertyNameFn,
  getSourceText as getSourceTextFn,
  isComplexExpression as isComplexExpressionFn,
} from './ast-helpers.js';
// ── Extracted converter modules ─────────────────────────────────────
import {
  convertArrayExpression as convertArrayExpressionFn,
  convertIdentifier as convertIdentifierFn,
  convertLiteral as convertLiteralFn,
  convertTemplateLiteral as convertTemplateLiteralFn,
  convertUnaryExpression as convertUnaryExpressionFn,
} from './ast-node-converters.js';
import { type CacheOptions, type CacheStats, ExpressionCache } from './cache.js';
import { convertCallExpression as convertCallExpressionFn } from './call-expression-converters.js';
import {
  addParenthesesIfNeeded as addParenthesesIfNeededFn,
  convertToBooleanTest as convertToBooleanTestFn,
  getMainOperator as getMainOperatorFn,
  getOperatorPrecedence as getOperatorPrecedenceFn,
  inferTypeFromFieldPath as inferTypeFromFieldPathFn,
  isBooleanExpression as isBooleanExpressionFn,
  isLeftAssociative as isLeftAssociativeFn,
  mapOperatorToCel as mapOperatorToCelFn,
} from './operator-utils.js';
import { ParserError, parseExpression, parseScript } from './parser.js';
// Shared types — extracted from this file to break circular deps with cache.ts / factory-pattern-handler.ts
import type { AnalysisContext, CelConversionResult, ValidationWarning } from './shared-types.js';
import { type SourceMapEntry, SourceMapUtils } from './source-map.js';

// Re-export shared types for backward compatibility
export type { AnalysisContext, CelConversionResult, ValidationWarning } from './shared-types.js';

/**
 * Comprehensive expression validation report
 */
export interface ExpressionValidationReport {
  /** Original expression */
  expression: string;

  /** Conversion result */
  conversionResult: CelConversionResult;

  /** Type validation result */
  typeValidation?: TypeValidationResult;

  /** Resource validation results */
  resourceValidation?: ResourceValidationResult[];

  /** Validation summary */
  summary: ValidationSummary;
}

/**
 * Validation summary
 */
export interface ValidationSummary {
  /** Overall validation status */
  valid: boolean;

  /** Total number of errors */
  totalErrors: number;

  /** Total number of warnings */
  totalWarnings: number;

  /** Whether the expression requires conversion */
  requiresConversion: boolean;

  /** Whether there are type-related issues */
  hasTypeIssues: boolean;

  /** Whether there are resource reference issues */
  hasResourceIssues: boolean;

  /** Whether there are compile-time type issues */
  hasCompileTimeIssues: boolean;

  /** Overall confidence score (0-1) */
  confidence: number;
}

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
      return this.analyzeKubernetesRefObject(expression, context);
    }

    // Handle other objects
    if (typeof expression === 'object' && expression !== null) {
      return this.analyzeObjectExpression(expression, context);
    }

    // Handle primitives
    return this.analyzePrimitiveExpression(expression, context);
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
      // Using unified acorn parser with native ES2022 support (optional chaining, nullish coalescing)
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

      // Convert to CEL with source tracking (this will extract dependencies through AST analysis)
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
      // Resource validation errors should be warnings, not critical errors
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
      // Resource validation errors are treated as warnings, not critical errors

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
                message: error instanceof Error ? error.message : String(error),
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
            // No suggestion property for TypeValidationWarning
          });
        }
      }

      // Add compile-time validation warnings (if any)
      if (compileTimeValidation?.warnings) {
        for (const warning of compileTimeValidation.warnings) {
          aggregatedWarnings.push({
            message: warning.message,
            type: 'compile_time',
            // No suggestion property for CompileTimeWarning
          });
        }
      }

      const result: CelConversionResult = {
        valid: celExpression !== null && !hasCompileTimeErrors && !hasTypeValidationErrors,
        celExpression,
        dependencies: context.dependencies || [],
        sourceMap: sourceMapEntries,
        errors: criticalErrors,
        requiresConversion: (context.dependencies || []).length > 0, // Only requires conversion if there are KubernetesRef dependencies
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
      const specialCaseResult = this.handleSpecialCases(expression, context);
      if (specialCaseResult) {
        // Only cache successful special case results
        if (specialCaseResult.valid) {
          this.cache.set(expression, context, specialCaseResult);
        }
        return specialCaseResult;
      }

      // Create detailed error with source location from ParserError if available
      let sourceLocation = { line: 1, column: 1, length: expression.length };
      let errorMessage = error instanceof Error ? error.message : String(error);

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
        error instanceof Error ? error : undefined
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

  /**
   * Analyze a KubernetesRef object directly
   */
  private analyzeKubernetesRefObject(
    ref: KubernetesRef<unknown>,
    context: AnalysisContext
  ): CelConversionResult {
    // Use the proper CEL path format
    const resourceId = ref.resourceId === '__schema__' ? 'schema' : ref.resourceId;
    const celPath = `${resourceId}.${ref.fieldPath}`;

    // Add to dependencies
    if (!context.dependencies) {
      context.dependencies = [];
    }
    context.dependencies.push(ref);

    return {
      valid: true,
      celExpression: {
        [CEL_EXPRESSION_BRAND]: true,
        expression: celPath,
        _type: ref._type,
      } as CelExpression,
      dependencies: [ref],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: true,
    };
  }

  /**
   * Analyze object expression by examining its structure
   */
  private analyzeObjectExpression(obj: unknown, context: AnalysisContext): CelConversionResult {
    const kubernetesRefs: KubernetesRef<unknown>[] = [];

    // Recursively examine object properties for KubernetesRef objects
    this.extractKubernetesRefsFromObject(obj, kubernetesRefs, '');

    // Add to dependencies
    if (!context.dependencies) {
      context.dependencies = [];
    }
    context.dependencies.push(...kubernetesRefs);

    return {
      valid: true,
      celExpression: null, // Objects don't convert to single CEL expressions
      dependencies: kubernetesRefs,
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: kubernetesRefs.length > 0,
    };
  }

  /**
   * Analyze primitive expression (no KubernetesRef objects)
   */
  private analyzePrimitiveExpression(
    _value: unknown,
    _context: AnalysisContext
  ): CelConversionResult {
    return {
      valid: true,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: false,
    };
  }

  /** Delegate to canonical implementation in type-guards.ts */
  private extractKubernetesRefsFromObject(
    obj: unknown,
    refs: KubernetesRef<unknown>[],
    _path: string
  ): void {
    refs.push(...extractResourceReferences(obj));
  }

  /**
   * NEW: Analyze expressions that may contain KubernetesRef objects from magic proxy system
   * This is the key method that detects when JavaScript expressions contain KubernetesRef objects
   */
  analyzeExpressionWithRefs(
    expression: unknown, // Could be a JavaScript expression or contain KubernetesRef objects
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // First check if this is a static value (no KubernetesRef objects)
      if (this.isStaticValue(expression)) {
        // Static values don't need conversion - preserve them as-is for performance
        return this.createStaticValueResult(expression);
      }

      // Check if the expression contains KubernetesRef objects
      if (!containsKubernetesRefs(expression)) {
        // No KubernetesRef objects found - return as-is (no conversion needed)
        return this.createStaticValueResult(expression);
      }

      // Expression contains KubernetesRef objects - needs conversion
      if (typeof expression === 'string') {
        // String expression - parse and convert
        return this.analyzeExpression(expression, context);
      }

      if (typeof expression === 'function') {
        // Function expression - analyze function body
        return this.analyzeFunction(expression as (...args: unknown[]) => unknown, context);
      }

      // Direct KubernetesRef object
      if (isKubernetesRef(expression)) {
        return this.convertKubernetesRefToResult(expression, context);
      }

      // Template literal or complex expression
      if (this.isTemplateLiteral(expression)) {
        return this.analyzeTemplateLiteral(expression, context);
      }

      // Complex object/array containing KubernetesRef objects
      return this.analyzeComplexValue(expression, context);
    } catch (error: unknown) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [
          new ConversionError(
            `Failed to analyze expression with refs: ${error instanceof Error ? error.message : String(error)}`,
            String(expression),
            'javascript'
          ),
        ],
        requiresConversion: false,
        warnings: [],
      };
    }
  }

  /**
   * Convert an AST node to CEL expression
   */
  convertASTNode(node: ESTreeNode, context: AnalysisContext): CelExpression {
    switch (node.type) {
      case 'BinaryExpression':
        return this.convertBinaryExpression(node, context);
      case 'MemberExpression':
        return this.convertMemberExpression(node, context);
      case 'ConditionalExpression':
        return this.convertConditionalExpression(node, context);
      case 'LogicalExpression':
        return this.convertLogicalExpression(node, context);
      case 'ChainExpression':
        return this.convertOptionalChaining(node, context);
      case 'TemplateLiteral':
        return this.convertTemplateLiteral(node, context);
      case 'Literal':
        return this.convertLiteral(node, context);
      case 'CallExpression':
        return this.convertCallExpression(node, context);
      case 'ArrayExpression':
        return this.convertArrayExpression(node, context);
      case 'Identifier':
        return this.convertIdentifier(node, context);
      case 'UnaryExpression':
        return this.convertUnaryExpression(node, context);
      default:
        throw new ConversionError(
          `Unsupported expression type: ${node.type}`,
          String(node.type),
          'unknown'
        );
    }
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
    try {
      const celExpression = this.convertASTNode(node, context);

      // Add source mapping if builder is available
      if (context.sourceMap) {
        context.sourceMap.addMapping(
          originalExpression,
          celExpression.expression,
          sourceLocation,
          context.type,
          {
            expressionType: SourceMapUtils.determineExpressionType(node.type),
            kubernetesRefs: SourceMapUtils.extractKubernetesRefPaths(celExpression.expression),
            dependencies:
              context.dependencies?.map((dep) => `${dep.resourceId}.${dep.fieldPath}`) || [],
            conversionNotes: [
              `Converted ${node.type} at line ${sourceLocation.line}, column ${sourceLocation.column}`,
            ],
          }
        );
      }

      return celExpression;
    } catch (_error: unknown) {
      // Create detailed conversion error with source location
      const conversionError = ConversionError.forUnsupportedSyntax(
        originalExpression,
        node.type,
        sourceLocation,
        [`The ${node.type} syntax is not supported in this context`]
      );

      throw conversionError;
    }
  }

  /**
   * Analyze a function for JavaScript expressions containing KubernetesRef objects
   */
  analyzeFunction(
    fn: (...args: unknown[]) => unknown,
    _context: AnalysisContext
  ): CelConversionResult {
    try {
      // Parse function to AST using unified acorn parser
      const ast = parseScript(fn.toString());

      // Find return statement
      const returnStatement = this.findReturnStatement(ast);
      if (!returnStatement) {
        throw new ConversionError(
          'Function must have a return statement for analysis',
          fn.toString(),
          'function-call'
        );
      }

      // Function body analysis is not yet supported
      throw new ConversionError(
        'Converting function bodies to CEL expressions is not yet supported. Use Cel.expr() or Cel.template() directly instead of passing functions.',
        fn.toString(),
        'function-call',
        undefined,
        undefined,
        [
          'Use Cel.expr() to write CEL expressions directly',
          'Use Cel.template() for string interpolation',
          'Break complex functions into simple expressions that can be converted',
        ]
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof ParserError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [new ConversionError(errorMessage, fn.toString(), 'function-call')],
        warnings: [],
        requiresConversion: false,
      };
    }
  }

  /**
   * Convert a single KubernetesRef to a conversion result
   */
  private convertKubernetesRefToResult(
    ref: KubernetesRef<unknown>,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // Use the dedicated KubernetesRef to CEL conversion method
      const celExpression = this.convertKubernetesRefToCel(ref, context);
      const originalExpression = `${ref.resourceId}.${ref.fieldPath}`;

      // Create source location for the KubernetesRef
      const sourceLocation = {
        line: 1,
        column: 1,
        length: originalExpression.length,
      };

      // Add source mapping
      const sourceMapEntries: SourceMapEntry[] = [];
      if (context.sourceMap) {
        context.sourceMap.addMapping(
          originalExpression,
          celExpression.expression,
          sourceLocation,
          context.type,
          {
            expressionType: 'member-access',
            kubernetesRefs: [originalExpression],
            dependencies: [`${ref.resourceId}.${ref.fieldPath}`],
            conversionNotes: ['Direct KubernetesRef to CEL conversion'],
          }
        );
        sourceMapEntries.push(...context.sourceMap.getEntries());
      }

      return {
        valid: true,
        celExpression,
        dependencies: [ref],
        sourceMap: sourceMapEntries,
        errors: [],
        warnings: [],
        requiresConversion: true,
      };
    } catch (_error: unknown) {
      const originalExpression = `${ref.resourceId}.${ref.fieldPath}`;
      const sourceLocation = { line: 1, column: 1, length: originalExpression.length };

      const conversionError = ConversionError.forKubernetesRefResolution(
        originalExpression,
        originalExpression,
        Object.keys(context.availableReferences || {}),
        sourceLocation
      );

      return {
        valid: false,
        celExpression: null,
        dependencies: [ref],
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Analyze complex values (objects/arrays) that may contain KubernetesRef objects
   */
  private analyzeComplexValue(value: unknown, context: AnalysisContext): CelConversionResult {
    const dependencies: KubernetesRef<unknown>[] = [];
    const errors: ConversionError[] = [];

    try {
      // Recursively find all KubernetesRef objects
      this.extractKubernetesRefs(value, dependencies);

      if (dependencies.length === 0) {
        return {
          valid: false,
          celExpression: null,
          dependencies: [],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: false,
        };
      }

      // Complex values with multiple KubernetesRef objects cannot be automatically converted
      const originalExpression = JSON.stringify(value, null, 2);
      const refPaths = dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`);

      throw new ConversionError(
        `Converting complex values with ${dependencies.length} KubernetesRef references to CEL is not yet supported. References: ${refPaths.join(', ')}`,
        originalExpression,
        'javascript',
        { line: 1, column: 1, length: originalExpression.length },
        { analysisContext: context.type, availableReferences: refPaths },
        [
          'Use Cel.expr() to write the CEL expression directly',
          'Use Cel.template() if you need string interpolation with multiple references',
          'Break the complex value into simpler individual expressions',
        ]
      );
    } catch (error: unknown) {
      const originalExpression = JSON.stringify(value);
      const sourceLocation = { line: 1, column: 1, length: originalExpression.length };

      const conversionError = ConversionError.forParsingFailure(
        originalExpression,
        error instanceof Error ? error.message : String(error),
        sourceLocation,
        error instanceof Error ? error : undefined
      );

      errors.push(conversionError);

      return {
        valid: false,
        celExpression: null,
        dependencies,
        sourceMap: [],
        errors,
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Generate CEL expression from KubernetesRef based on context
   * This handles the core KubernetesRef to CEL field path conversion (resourceId.fieldPath)
   */
  private generateCelFromKubernetesRef(
    ref: KubernetesRef<unknown>,
    context: AnalysisContext
  ): string {
    // Validate the KubernetesRef
    if (!ref.resourceId || !ref.fieldPath) {
      throw new ConversionError(
        `Invalid KubernetesRef: missing resourceId or fieldPath`,
        `${ref.resourceId || ''}.${ref.fieldPath || ''}`,
        'member-access'
      );
    }

    // Generate appropriate CEL expression based on factory type and resource type
    if (context.factoryType === 'kro') {
      // For Kro factory, generate CEL expressions for runtime evaluation by Kro controller
      if (ref.resourceId === '__schema__') {
        // Schema references: schema.spec.name, schema.status.ready
        return `schema.${ref.fieldPath}`;
      } else {
        // Resource references: resources.database.status.podIP
        return `resources.${ref.resourceId}.${ref.fieldPath}`;
      }
    } else {
      // For direct factory, generate CEL expressions that will be resolved at deployment time
      // The direct factory will resolve these before deployment
      if (ref.resourceId === '__schema__') {
        // Schema references are resolved from the schema proxy
        return `schema.${ref.fieldPath}`;
      } else {
        // Resource references are resolved from the available resources
        return `resources.${ref.resourceId}.${ref.fieldPath}`;
      }
    }
  }

  /**
   * Convert a KubernetesRef directly to a CEL expression
   * This is the main method for KubernetesRef to CEL field path conversion
   */
  convertKubernetesRefToCel(ref: KubernetesRef<unknown>, context: AnalysisContext): CelExpression {
    try {
      // Validate KubernetesRef types if type checking is enabled
      if (context.strictTypeChecking !== false && context.typeRegistry) {
        const validation = this.typeValidator.validateKubernetesRef(
          ref,
          context.availableReferences,
          context.schemaProxy
        );

        if (!validation.valid) {
          throw new ConversionError(
            `KubernetesRef type validation failed: ${validation.errors.map((e) => e.message).join(', ')}`,
            `${ref.resourceId}.${ref.fieldPath}`,
            'member-access'
          );
        }
      }

      const expression = this.generateCelFromKubernetesRef(ref, context);

      // Track this KubernetesRef as a dependency
      if (context.dependencies) {
        context.dependencies.push(ref);
      }

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: ref._type,
      } as CelExpression;
    } catch (error: unknown) {
      throw new ConversionError(
        `Failed to convert KubernetesRef to CEL: ${error instanceof Error ? error.message : String(error)}`,
        `${ref.resourceId}.${ref.fieldPath}`,
        'member-access'
      );
    }
  }

  /**
   * Find return statement in AST
   */
  private findReturnStatement(ast: ESTreeNode): ESTreeReturnStatement | null {
    let returnStatement: ESTreeReturnStatement | null = null;

    estraverse.traverse(ast, {
      enter: (node) => {
        if (node.type === 'ReturnStatement') {
          returnStatement = node as ESTreeReturnStatement;
          return estraverse.VisitorOption.Break;
        }
        return undefined; // Continue traversal
      },
    });

    return returnStatement;
  }

  /**
   * Check if a value is a template literal expression
   * This checks for JavaScript template literal syntax in runtime values
   */
  private isTemplateLiteral(value: unknown): boolean {
    // Check if it's a string that looks like a template literal
    if (typeof value === 'string') {
      // Look for template literal patterns like `text ${expression} more text`
      return value.includes('${') && value.includes('}');
    }

    // Check if it's an object that represents a template literal structure
    if (value && typeof value === 'object' && 'type' in value && value.type === 'TemplateLiteral') {
      return true;
    }

    return false;
  }

  /**
   * Analyze template literal expressions containing KubernetesRef objects
   * This handles runtime template literal values that contain KubernetesRef interpolations
   */
  private analyzeTemplateLiteral(
    expression: unknown,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      const dependencies = extractResourceReferences(expression);
      const originalExpression = String(expression);

      let celExpression: CelExpression;

      if (typeof expression === 'string') {
        // Handle string-based template literals
        // For now, preserve the template literal structure
        celExpression = {
          [CEL_EXPRESSION_BRAND]: true,
          expression: expression, // Keep the ${} syntax for CEL
          _type: 'string',
        };
      } else {
        // Handle structured template literal objects
        // This would be used when we have parsed template literal AST nodes
        celExpression = {
          [CEL_EXPRESSION_BRAND]: true,
          expression: '/* Complex template literal */',
          _type: 'string',
        };
      }

      // Create source location for the template literal
      const sourceLocation = {
        line: 1,
        column: 1,
        length: originalExpression.length,
      };

      // Add source mapping
      const sourceMapEntries: SourceMapEntry[] = [];
      if (context.sourceMap) {
        context.sourceMap.addMapping(
          originalExpression,
          celExpression.expression,
          sourceLocation,
          context.type,
          {
            expressionType: 'template-literal',
            kubernetesRefs: dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`),
            dependencies: dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`),
            conversionNotes: ['Template literal with KubernetesRef interpolations'],
          }
        );
        sourceMapEntries.push(...context.sourceMap.getEntries());
      }

      return {
        valid: true,
        celExpression,
        dependencies,
        sourceMap: sourceMapEntries,
        errors: [],
        warnings: [],
        requiresConversion: true,
      };
    } catch (error: unknown) {
      const originalExpression = String(expression);
      const sourceLocation = { line: 1, column: 1, length: originalExpression.length };

      const conversionError = ConversionError.forTemplateLiteral(
        originalExpression,
        [originalExpression],
        0,
        sourceLocation,
        error instanceof Error ? error : undefined
      );

      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Extract all KubernetesRef objects from a complex value
   */
  private extractKubernetesRefs(value: unknown, refs: KubernetesRef<unknown>[]): void {
    const extractedRefs = extractResourceReferences(value);
    refs.push(...extractedRefs);
  }

  /**
   * Handle special cases for expressions that can't be parsed normally
   */
  private handleSpecialCases(
    expression: string,
    context: AnalysisContext
  ): CelConversionResult | null {
    // Handle expressions with both optional chaining and nullish coalescing
    if (expression.includes('?.') && expression.includes('??')) {
      return this.handleMixedOptionalAndNullishExpression(expression, context);
    }

    // Handle optional chaining expressions
    if (expression.includes('?.')) {
      return this.handleOptionalChainingExpression(expression, context);
    }

    // Handle nullish coalescing expressions
    if (expression.includes('??')) {
      return this.handleNullishCoalescingExpression(expression, context);
    }

    // Handle simple resource references that might not parse as valid JavaScript
    if (expression.match(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/)) {
      // This looks like a simple property access path
      try {
        // Initialize dependencies array if not provided
        if (!context.dependencies) {
          context.dependencies = [];
        }

        // Extract dependencies from the expression
        this.extractDependenciesFromExpression(expression, context);

        const celExpression: CelExpression = {
          [CEL_EXPRESSION_BRAND]: true,
          expression: expression,
          _type: undefined,
        };

        const sourceLocation = { line: 1, column: 1, length: expression.length };
        const sourceMapEntries: SourceMapEntry[] = [];

        if (context.sourceMap) {
          context.sourceMap.addMapping(expression, expression, sourceLocation, context.type, {
            expressionType: 'member-access',
            kubernetesRefs: this.extractResourceReferencesFromExpression(expression),
            dependencies:
              context.dependencies?.map((dep) => `${dep.resourceId}.${dep.fieldPath}`) || [],
            conversionNotes: ['Simple property access path'],
          });
          sourceMapEntries.push(...context.sourceMap.getEntries());
        }

        // Perform resource validation if enabled
        let resourceValidation: ResourceValidationResult[] | undefined;
        if (
          context.validateResourceReferences !== false &&
          context.dependencies &&
          context.dependencies.length > 0
        ) {
          resourceValidation = this.validateResourceReferences(
            context.dependencies,
            context.availableReferences,
            context.schemaProxy,
            context.validationContext
          );
        }

        // Extract errors from resource validation
        const errors: ConversionError[] = [];
        if (resourceValidation) {
          for (const validation of resourceValidation) {
            for (const error of validation.errors) {
              errors.push(new ConversionError(error.message, expression, 'member-access'));
            }
          }
        }

        return {
          valid: errors.length === 0,
          celExpression,
          dependencies: context.dependencies || [],
          sourceMap: sourceMapEntries,
          errors,
          warnings: [],
          requiresConversion: true,
          resourceValidation,
        };
      } catch (error: unknown) {
        // Fall through to return null
        const logger = getComponentLogger('expression-analyzer');
        logger.debug('Expression analysis failed, falling through to return null', { err: error });
      }
    }

    return null;
  }

  /**
   * Handle optional chaining expressions
   * Note: With acorn's native ES2022 support, optional chaining is parsed directly.
   * This method is kept for backward compatibility and special case handling.
   */
  private handleOptionalChainingExpression(
    expression: string,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // Validate that the expression is syntactically valid JavaScript
      // Acorn natively supports optional chaining (ES2020+)
      try {
        parseExpression(expression);
      } catch (syntaxError: unknown) {
        const errorMessage =
          syntaxError instanceof ParserError
            ? syntaxError.message
            : syntaxError instanceof Error
              ? syntaxError.message
              : String(syntaxError);
        throw new ConversionError(
          `Invalid JavaScript syntax in optional chaining expression: ${errorMessage}`,
          expression,
          'optional-chaining'
        );
      }

      // Convert optional chaining to CEL-compatible syntax
      // deployment?.status?.readyReplicas -> deployment?.status?.readyReplicas
      const celExpression: CelExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: expression, // Keep the ?. syntax as CEL supports it
        _type: undefined,
      };

      const sourceLocation = { line: 1, column: 1, length: expression.length };
      const sourceMapEntries: SourceMapEntry[] = [];

      // Extract dependencies from the optional chaining expression
      const dependencies = this.extractDependenciesFromExpressionString(expression, context);

      if (context.sourceMap) {
        context.sourceMap.addMapping(expression, expression, sourceLocation, context.type, {
          expressionType: 'optional-chaining',
          kubernetesRefs: this.extractResourceReferencesFromExpression(expression),
          dependencies: dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`),
          conversionNotes: ['Optional chaining expression'],
        });
        sourceMapEntries.push(...context.sourceMap.getEntries());
      }

      return {
        valid: true,
        celExpression,
        dependencies,
        sourceMap: sourceMapEntries,
        errors: [],
        warnings: [],
        requiresConversion: true,
      };
    } catch (error: unknown) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [
          new ConversionError(
            `Failed to handle optional chaining: ${error instanceof Error ? error.message : String(error)}`,
            expression,
            'optional-chaining'
          ),
        ],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Handle expressions with both optional chaining and nullish coalescing
   */
  private handleMixedOptionalAndNullishExpression(
    expression: string,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // For mixed expressions, we'll convert them to a CEL expression that handles both
      // Optional chaining and nullish coalescing together
      // Example: deployment.status?.readyReplicas ?? deployment.spec?.replicas ?? 1
      // Becomes: deployment.status?.readyReplicas != null ? deployment.status?.readyReplicas : (deployment.spec?.replicas != null ? deployment.spec?.replicas : 1)

      // Split by nullish coalescing operator
      const parts = expression.split('??').map((part) => part.trim());

      if (parts.length < 2) {
        throw new ConversionError('Invalid mixed expression', expression, 'nullish-coalescing');
      }

      // Build nested conditional expression from right to left
      let celExpression = parts[parts.length - 1] || ''; // Start with the last part (fallback)

      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        celExpression = `${part} != null ? ${part} : ${celExpression}`;
      }

      const result: CelExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: celExpression,
        _type: undefined,
      };

      // Extract dependencies from the mixed expression
      const dependencies = this.extractDependenciesFromExpressionString(expression, context);

      const sourceLocation = { line: 1, column: 1, length: expression.length };
      const sourceMapEntries: SourceMapEntry[] = [];

      if (context.sourceMap) {
        context.sourceMap.addMapping(expression, result.expression, sourceLocation, context.type, {
          expressionType: 'optional-chaining',
          kubernetesRefs: this.extractResourceReferencesFromExpression(expression),
          dependencies: dependencies.map((dep) => `${dep.resourceId}.${dep.fieldPath}`),
          conversionNotes: [
            'Mixed optional chaining and nullish coalescing converted to nested conditionals',
          ],
        });
        sourceMapEntries.push(...context.sourceMap.getEntries());
      }

      return {
        valid: true,
        celExpression: result,
        dependencies,
        sourceMap: sourceMapEntries,
        errors: [],
        warnings: [],
        requiresConversion: true,
      };
    } catch (error: unknown) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [
          new ConversionError(
            `Failed to handle mixed optional chaining and nullish coalescing: ${error instanceof Error ? error.message : String(error)}`,
            expression,
            'optional-chaining'
          ),
        ],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Handle nullish coalescing expressions
   * Note: With acorn's native ES2022 support, nullish coalescing is parsed directly.
   * This method converts ?? to CEL-compatible conditional syntax.
   */
  private handleNullishCoalescingExpression(
    expression: string,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // Convert nullish coalescing to CEL-compatible syntax
      // deployment.status.readyReplicas ?? 0 -> deployment.status.readyReplicas != null ? deployment.status.readyReplicas : 0
      const parts = expression.split('??').map((part) => part.trim());
      if (parts.length !== 2) {
        throw new ConversionError(
          'Invalid nullish coalescing expression',
          expression,
          'nullish-coalescing'
        );
      }

      const [left, right] = parts;
      const celExpression: CelExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${left} != null ? ${left} : ${right}`,
        _type: undefined,
      };

      const sourceLocation = { line: 1, column: 1, length: expression.length };
      const sourceMapEntries: SourceMapEntry[] = [];

      if (context.sourceMap) {
        context.sourceMap.addMapping(
          expression,
          celExpression.expression,
          sourceLocation,
          context.type,
          {
            expressionType: 'nullish-coalescing',
            kubernetesRefs: this.extractResourceReferencesFromExpression(expression),
            dependencies: this.extractResourceReferencesFromExpression(expression),
            conversionNotes: ['Nullish coalescing converted to conditional'],
          }
        );
        sourceMapEntries.push(...context.sourceMap.getEntries());
      }

      // Extract dependencies from the nullish coalescing expression
      const dependencies = this.extractDependenciesFromExpressionString(expression, context);

      return {
        valid: true,
        celExpression,
        dependencies,
        sourceMap: sourceMapEntries,
        errors: [],
        warnings: [],
        requiresConversion: true,
      };
    } catch (error: unknown) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [
          new ConversionError(
            `Failed to handle nullish coalescing: ${error instanceof Error ? error.message : String(error)}`,
            expression,
            'nullish-coalescing'
          ),
        ],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

  /**
   * Extract resource references from expression string
   */
  private extractResourceReferencesFromExpression(expression: string): string[] {
    const refs: string[] = [];

    // Look for patterns like deployment.status.readyReplicas or service?.status?.loadBalancer
    const resourcePattern =
      /([a-zA-Z_][a-zA-Z0-9_]*)\??\.([a-zA-Z_][a-zA-Z0-9_]*(?:\??\.?[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
    let match: RegExpExecArray | null = resourcePattern.exec(expression);

    while (match !== null) {
      refs.push(match[0].replace(/\?/g, '')); // Remove optional chaining operators for reference tracking
      match = resourcePattern.exec(expression);
    }

    return refs;
  }

  /**
   * Check if an expression is a resource reference
   */
  private isResourceReference(expression: string): boolean {
    // Check for explicit resource/schema prefixes
    if (expression.includes('resources.') || expression.includes('schema.')) {
      return true;
    }

    // Check if it starts with a known resource name (for direct references like deployment.status.field)
    const parts = expression.split('.');
    if (parts.length >= 2) {
      const resourceName = parts[0];
      // This is a heuristic - if it looks like a resource reference pattern
      return !!(
        resourceName &&
        /^[a-zA-Z][a-zA-Z0-9-]*$/.test(resourceName) &&
        (parts[1] === 'status' || parts[1] === 'spec' || parts[1] === 'metadata')
      );
    }

    return false;
  }

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
   * Extract dependencies from JavaScript expression string and return them
   */
  private extractDependenciesFromExpressionString(
    expression: string,
    context: AnalysisContext
  ): KubernetesRef<unknown>[] {
    const dependencies: KubernetesRef<unknown>[] = [];

    // Look for direct resource references (deployment.status.field)
    if (context.availableReferences) {
      for (const [resourceKey, _resource] of Object.entries(context.availableReferences)) {
        const resourcePattern = new RegExp(
          `\\b${escapeRegExp(resourceKey)}\\.([a-zA-Z0-9_.?\\[\\]]+)`,
          'g'
        );
        const matches = expression.match(resourcePattern);
        if (matches) {
          for (const match of matches) {
            const fieldPath = match
              .substring(resourceKey.length + 1)
              .replace(/\?\./g, '.') // Remove optional chaining
              .replace(/\?\[/g, '['); // Remove optional array access

            const ref: KubernetesRef<unknown> = {
              [KUBERNETES_REF_BRAND]: true,
              resourceId: resourceKey,
              fieldPath,
              _type: 'unknown',
            };

            // Only add if not already present
            if (
              !dependencies.some(
                (dep) => dep.resourceId === resourceKey && dep.fieldPath === fieldPath
              )
            ) {
              dependencies.push(ref);
            }
          }
        }
      }
    }

    // Look for schema references (schema.spec.field)
    const schemaPattern = /\bschema\.[a-zA-Z0-9_.?[\]?]+/g;
    const schemaMatches = expression.match(schemaPattern);
    if (schemaMatches) {
      for (const match of schemaMatches) {
        const fieldPath = match
          .replace('schema.', '')
          .replace(/\?\./g, '.') // Remove optional chaining
          .replace(/\?\[/g, '['); // Remove optional array access

        const ref: KubernetesRef<unknown> = {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: '__schema__',
          fieldPath,
          _type: inferTypeFromFieldPathFn(fieldPath),
        };

        // Only add if not already present
        if (
          !dependencies.some(
            (dep) => dep.resourceId === '__schema__' && dep.fieldPath === fieldPath
          )
        ) {
          dependencies.push(ref);
        }
      }
    }

    return dependencies;
  }

  /**
   * Extract dependencies from JavaScript expression
   */
  private extractDependenciesFromExpression(expression: string, context: AnalysisContext): void {
    if (!context.dependencies) {
      context.dependencies = [];
    }

    // Look for resource references (resources.name.field)
    const resourceMatches = expression.match(/resources\.(\w+)\.([a-zA-Z0-9_.]+)/g);
    if (resourceMatches) {
      for (const match of resourceMatches) {
        const parts = match.split('.');
        if (parts.length >= 3) {
          const resourceId = parts[1]!;
          const fieldPath = parts.slice(2).join('.');

          const ref: KubernetesRef<unknown> = {
            [KUBERNETES_REF_BRAND]: true,
            resourceId,
            fieldPath,
            _type: 'unknown',
          };

          // Only add if not already present
          if (
            !context.dependencies.some(
              (dep) => dep.resourceId === resourceId && dep.fieldPath === fieldPath
            )
          ) {
            context.dependencies.push(ref);
          }
        }
      }
    }

    // Look for schema references (schema.spec.field)
    const schemaMatches = expression.match(/schema\.([a-zA-Z0-9_.]+)/g);
    if (schemaMatches) {
      for (const match of schemaMatches) {
        const fieldPath = match.replace('schema.', '');

        const ref: KubernetesRef<unknown> = {
          [KUBERNETES_REF_BRAND]: true,
          resourceId: '__schema__',
          fieldPath,
          _type: 'unknown',
        };

        // Only add if not already present
        if (
          !context.dependencies.some(
            (dep) => dep.resourceId === '__schema__' && dep.fieldPath === fieldPath
          )
        ) {
          context.dependencies.push(ref);
        }
      }
    }

    // Look for direct resource references with various patterns
    // This handles patterns like:
    // - "deployment.status.readyReplicas"
    // - "deployment.status['readyReplicas']"
    // - "deployment.status?.readyReplicas"
    // - "deployment.status.conditions[0].type"
    const directResourcePatterns = [
      // Standard dot notation: deployment.status.readyReplicas
      /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\.([a-zA-Z0-9_.[\]]+)/g,
      // Computed property access: deployment.status["readyReplicas"]
      /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\["([^"]+)"\]/g,
      // Computed property access with single quotes: deployment.status['readyReplicas']
      /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\['([^']+)'\]/g,
      // Optional chaining: deployment.status?.readyReplicas
      /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\?\?\.([a-zA-Z0-9_.[\]?]+)/g,
      // Mixed patterns: deployment.status.conditions[0].type
      /\b([a-zA-Z_][a-zA-Z0-9_]*)\.(status|spec|metadata)\.([a-zA-Z0-9_.[\]?]+)/g,
    ];

    for (const pattern of directResourcePatterns) {
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0; // Reset regex state

      match = pattern.exec(expression);
      while (match !== null) {
        const fullMatch = match[0];
        const resourceId = match[1]!;
        const baseField = match[2]!; // status, spec, or metadata
        const remainingPath = match[3];

        let fieldPath = baseField;

        // Handle different patterns
        if (remainingPath) {
          // For computed property access patterns, the remainingPath is the property name
          if (pattern.source.includes('\\["') || pattern.source.includes("\\'")) {
            fieldPath = `${baseField}.${remainingPath}`;
          } else {
            fieldPath = `${baseField}.${remainingPath}`;
          }
        } else {
          // For computed property access, we need to extract the property name differently
          const computedMatch =
            fullMatch.match(/\.(status|spec|metadata)\["([^"]+)"\]/) ||
            fullMatch.match(/\.(status|spec|metadata)\['([^']+)'\]/);
          if (computedMatch) {
            fieldPath = `${computedMatch[1]}.${computedMatch[2]}`;
          }
        }

        // Clean up field path
        fieldPath = fieldPath?.replace(/\?\?/g, '').replace(/\?/g, '') || '';
        fieldPath = fieldPath.replace(/\["([^"]+)"\]/g, '.$1');
        fieldPath = fieldPath.replace(/\['([^']+)'\]/g, '.$1');
        fieldPath = fieldPath.replace(/\[(\d+)\]/g, '[$1]'); // Keep array indices

        // Check if this resource exists in available references or add it anyway
        const shouldAdd =
          !context.availableReferences ||
          (resourceId ? context.availableReferences[resourceId] : null) ||
          true; // Add all for now, let validation handle it later

        if (shouldAdd) {
          const ref: KubernetesRef<unknown> = {
            [KUBERNETES_REF_BRAND]: true,
            resourceId,
            fieldPath,
            _type: 'unknown',
          };

          // Only add if not already present
          if (
            !context.dependencies.some(
              (dep) => dep.resourceId === resourceId && dep.fieldPath === fieldPath
            )
          ) {
            context.dependencies.push(ref);
          }
        }

        // Get next match
        match = pattern.exec(expression);
      }
    }

    // Look for template literal interpolations
    // This handles patterns like: `http://${service.status.loadBalancer.ingress[0].ip}`
    const templateLiteralMatches = expression.match(/\$\{([^}]+)\}/g);
    if (templateLiteralMatches) {
      for (const match of templateLiteralMatches) {
        const innerExpression = match.slice(2, -1); // Remove ${ and }
        // Recursively extract dependencies from the inner expression
        this.extractDependenciesFromExpression(innerExpression, context);
      }
    }
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

  /**
   * Convert binary expressions (>, <, ==, !=, &&, ||) with KubernetesRef operand handling
   */
  private convertBinaryExpression(
    node: ESTreeBinaryExpression,
    context: AnalysisContext
  ): CelExpression {
    // Convert operands with proper precedence handling
    const left = this.handleComplexExpression(node.left, context, node.operator);
    const right = this.handleComplexExpression(node.right, context, node.operator);

    // Map JavaScript operators to CEL operators
    const operator = this.mapOperatorToCel(node.operator);

    // Generate CEL expression with proper precedence
    const leftExpr = this.addParenthesesIfNeeded(left.expression, node.operator, true);
    const rightExpr = this.addParenthesesIfNeeded(right.expression, node.operator, false);

    const expression = `${leftExpr} ${operator} ${rightExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert member expressions (object.property, object['property']) and array access (array[0], array[index])
   */
  private convertMemberExpression(
    node: ESTreeMemberExpression,
    context: AnalysisContext
  ): CelExpression {
    // Handle optional member expressions (obj?.prop)
    if (node.optional) {
      return this.convertOptionalMemberExpression(node, context);
    }

    // Handle computed member access (array[index] or object['key'])
    if (node.computed) {
      return convertArrayAccessFn(node, context, this.convertASTNode.bind(this));
    }

    // Check if the object is a complex expression (like a method call result)
    if (
      node.object.type === 'CallExpression' ||
      (node.object.type === 'MemberExpression' && this.isComplexExpression(node.object))
    ) {
      // Convert the object expression first
      const objectExpr = this.convertASTNode(node.object, context);
      const propertyName =
        node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
          ? node.property.name
          : String((node.property as ESTreeSimpleLiteral).value);

      // Create a member access on the result of the complex expression
      const expression = `${objectExpr.expression}.${propertyName}`;

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }

    // Try to extract the full member path for simple cases
    let path: string;
    try {
      path = this.extractMemberPath(node);
    } catch (_error: unknown) {
      // If path extraction fails, fall back to converting the object and property separately
      const objectExpr = this.convertASTNode(node.object, context);
      const propertyName =
        node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
          ? node.property.name
          : String((node.property as ESTreeSimpleLiteral).value);

      const expression = `${objectExpr.expression}.${propertyName}`;

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }

    // Check if this is a resource reference
    if (context.availableReferences) {
      for (const [resourceKey, resource] of Object.entries(context.availableReferences)) {
        if (
          path.startsWith(`resources.${resourceKey}.`) ||
          path.startsWith(`${resourceKey}.`) ||
          path === resourceKey
        ) {
          let fieldPath: string;
          if (path === resourceKey) {
            // Direct resource reference
            fieldPath = '';
          } else if (path.startsWith('resources.')) {
            fieldPath = path.substring(`resources.${resourceKey}.`.length);
          } else {
            fieldPath = path.substring(`${resourceKey}.`.length);
          }
          return this.getResourceFieldReference(resource, resourceKey, fieldPath, context);
        }
      }
    }

    // Handle schema references
    if (path.startsWith('schema.')) {
      return this.getSchemaFieldReference(path, context);
    }

    // Handle unknown resources - this should be an error in strict mode
    const parts = path.split('.');
    if (parts.length >= 2) {
      let resourceName: string;
      let fieldPath: string;

      // Check if this is a resources.* prefixed expression
      if (parts[0] === 'resources' && parts.length >= 3) {
        resourceName = parts[1] || ''; // The actual resource name after "resources."
        fieldPath = parts.slice(2).join('.'); // The field path after the resource name
      } else {
        resourceName = parts[0] || '';
        fieldPath = parts.slice(1).join('.');
      }

      // For strict validation contexts, check if resource should be available
      // For now, we'll be lenient and allow unknown resources with warnings

      // Create a placeholder KubernetesRef for the unknown resource
      const unknownRef: KubernetesRef<unknown> = {
        [KUBERNETES_REF_BRAND]: true as const,
        resourceId: resourceName,
        fieldPath: fieldPath,
        _type: inferTypeFromFieldPathFn(fieldPath),
      };

      // Add to dependencies
      if (context.dependencies) {
        context.dependencies.push(unknownRef);
      }

      // Generate CEL expression for unknown resource
      const expression = `resources.${resourceName}.${fieldPath}`;

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }

    throw new ConversionError(
      `Unable to resolve member expression: ${path}`,
      path,
      'member-access'
    );
  }

  /**
   * Convert conditional expressions (condition ? true : false)
   * Handles ternary operators with proper CEL syntax and KubernetesRef support
   */
  private convertConditionalExpression(
    node: ESTreeConditionalExpression,
    context: AnalysisContext
  ): CelExpression {
    const test = this.handleComplexExpression(node.test, context, '?');
    const consequent = this.handleComplexExpression(node.consequent, context, '?');
    const alternate = this.handleComplexExpression(node.alternate, context, '?');

    // Ensure the test condition is properly formatted for CEL
    let testExpression = test.expression;

    // If the test is a resource reference or optional chaining, ensure it's properly evaluated as boolean
    if (this.isResourceReference(testExpression) || testExpression.includes('?')) {
      // For resource references, we need to check if they exist and are truthy
      testExpression = this.convertToBooleanTest(testExpression);
    }

    // Add parentheses to operands if needed for precedence
    const testExpr = this.addParenthesesIfNeeded(testExpression, '?', true);
    const consequentExpr = this.addParenthesesIfNeeded(consequent.expression, '?', false);
    const alternateExpr = this.addParenthesesIfNeeded(alternate.expression, '?', false);

    const expression = `${testExpr} ? ${consequentExpr} : ${alternateExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert an expression to a proper boolean test for CEL conditionals
   */
  private convertToBooleanTest(expression: string): string {
    return convertToBooleanTestFn(expression);
  }

  /**
   * Check if an expression is already a boolean expression
   */
  private isBooleanExpression(expression: string): boolean {
    return isBooleanExpressionFn(expression);
  }

  /**
   * Add parentheses to expression if needed for proper precedence
   */
  private addParenthesesIfNeeded(
    expression: string,
    parentOperator?: string,
    isLeftOperand?: boolean
  ): string {
    return addParenthesesIfNeededFn(expression, parentOperator, isLeftOperand);
  }

  private getMainOperator(expression: string): string | null {
    return getMainOperatorFn(expression);
  }

  private getOperatorPrecedence(operator: string): number {
    return getOperatorPrecedenceFn(operator);
  }

  private isLeftAssociative(operator: string): boolean {
    return isLeftAssociativeFn(operator);
  }

  /**
   * Handle complex nested expressions with proper precedence
   */
  private handleComplexExpression(
    node: ESTreeNode,
    context: AnalysisContext,
    parentOperator?: string
  ): CelExpression {
    const result = this.convertASTNode(node, context);
    const expressionWithParens = addParenthesesIfNeededFn(result.expression, parentOperator);
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: expressionWithParens,
      _type: result._type,
    } as CelExpression;
  }

  /**
   * Convert logical expressions (&&, ||, ??)
   * Handles logical OR fallback conversion (value || default) and nullish coalescing (value ?? default)
   */
  private convertLogicalExpression(
    node: ESTreeLogicalExpression,
    context: AnalysisContext
  ): CelExpression {
    const left = this.convertASTNode(node.left, context);
    const right = this.convertASTNode(node.right, context);

    if (node.operator === '||') {
      return this.convertLogicalOrFallback(left, right, context);
    }

    if (node.operator === '&&') {
      return this.convertLogicalAnd(left, right, context);
    }

    if (node.operator === '??') {
      return this.convertNullishCoalescing(left, right, context);
    }

    // For other logical operators, use direct mapping
    const operator = this.mapOperatorToCel(node.operator);
    const expression = `${left.expression} ${operator} ${right.expression}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert logical OR fallback (value || default) to appropriate CEL conditionals
   */
  private convertLogicalOrFallback(
    left: CelExpression,
    right: CelExpression,
    _context: AnalysisContext
  ): CelExpression {
    // Add parentheses to operands if they contain lower precedence operators
    const leftExpr = this.addParenthesesIfNeeded(left.expression, '||', true);
    const rightExpr = this.addParenthesesIfNeeded(right.expression, '||', false);

    // For resource references and optional chaining, we can use a simpler null check
    if (this.isResourceReference(left.expression) || left.expression.includes('?')) {
      // For resource references, primarily check for null/undefined
      const expression = `${leftExpr} != null ? ${leftExpr} : ${rightExpr}`;

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }

    // For general expressions, check for all falsy values
    // This handles JavaScript's truthy/falsy semantics in CEL
    const expression = `${leftExpr} != null && ${leftExpr} != "" && ${leftExpr} != false && ${leftExpr} != 0 ? ${leftExpr} : ${rightExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert logical AND (value && other) to CEL conditional
   */
  private convertLogicalAnd(
    left: CelExpression,
    right: CelExpression,
    _context: AnalysisContext
  ): CelExpression {
    // Add parentheses to operands if they contain lower precedence operators
    const leftExpr = this.addParenthesesIfNeeded(left.expression, '&&', true);
    const rightExpr = this.addParenthesesIfNeeded(right.expression, '&&', false);

    // For resource references, primarily check for null/undefined
    if (this.isResourceReference(left.expression) || left.expression.includes('?')) {
      const expression = `${leftExpr} != null ? ${rightExpr} : ${leftExpr}`;

      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }

    // For general expressions, check for all truthy values
    const expression = `${leftExpr} != null && ${leftExpr} != "" && ${leftExpr} != false && ${leftExpr} != 0 ? ${rightExpr} : ${leftExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert nullish coalescing (value ?? default) to CEL null-checking expressions
   * Only checks for null and undefined, not other falsy values like || does
   */
  private convertNullishCoalescing(
    left: CelExpression,
    right: CelExpression,
    _context: AnalysisContext
  ): CelExpression {
    // Add parentheses to operands if they contain lower precedence operators
    const leftExpr = this.addParenthesesIfNeeded(left.expression, '??', true);
    const rightExpr = this.addParenthesesIfNeeded(right.expression, '??', false);

    // Nullish coalescing only checks for null and undefined, not other falsy values
    // This is more precise than || which checks for all falsy values
    const expression = `${leftExpr} != null ? ${leftExpr} : ${rightExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert optional chaining expressions (obj?.prop?.field) to Kro conditional CEL
   * Uses Kro's ? operator for null-safe property access
   */
  private convertOptionalChaining(
    node: ESTreeChainExpression,
    context: AnalysisContext
  ): CelExpression {
    // ChainExpression wraps the actual optional expression
    const expression = node.expression;

    if (expression.type === 'MemberExpression' && expression.optional) {
      return this.convertOptionalMemberExpression(expression, context);
    }

    if (expression.type === 'CallExpression' && expression.optional) {
      return this.convertOptionalCallExpression(expression, context);
    }

    // If it's not actually optional, convert the inner expression normally
    return this.convertASTNode(expression, context);
  }

  /**
   * Convert optional member expressions (obj?.prop, obj?.prop?.field)
   */
  private convertOptionalMemberExpression(
    node: ESTreeMemberExpression,
    context: AnalysisContext
  ): CelExpression {
    // Build the optional chain by recursively processing the object
    const objectExpr = this.convertASTNode(node.object, context);

    let propertyAccess: string;
    if (node.computed) {
      // Handle obj?.[key] syntax
      const property = this.convertASTNode(node.property, context);
      propertyAccess = `[${property.expression}]`;
    } else {
      // Handle obj?.prop syntax
      const propName =
        node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
          ? node.property.name
          : String((node.property as ESTreeSimpleLiteral).value);
      propertyAccess = `.${propName}`;
    }

    // Use Kro's ? operator for null-safe access
    // The ? operator in Kro CEL provides null-safe property access
    const expression = `${objectExpr.expression}?${propertyAccess}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert optional call expressions (obj?.method?.())
   */
  private convertOptionalCallExpression(
    node: ESTreeCallExpression,
    context: AnalysisContext
  ): CelExpression {
    // Convert the callee with optional chaining
    const callee = this.convertASTNode(node.callee as ESTreeNode, context);

    // Convert arguments
    const args = node.arguments
      .map((arg) => this.convertASTNode(arg as ESTreeNode, context).expression)
      .join(', ');

    // Use Kro's ? operator for null-safe method calls
    const expression = `${callee.expression}?(${args})`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Convert template literals with KubernetesRef interpolation
   * Handles expressions like `http://${database.status.podIP}:5432/db`
   */
  private convertTemplateLiteral(
    node: ESTreeTemplateLiteral,
    context: AnalysisContext
  ): CelExpression {
    return convertTemplateLiteralFn(node, context, this.convertASTNode.bind(this));
  }

  /**
   * Convert literal values (strings, numbers, booleans - no KubernetesRef objects)
   * This preserves literal values exactly as they are, without any KubernetesRef processing
   */
  private convertLiteral(node: ESTreeLiteral, context: AnalysisContext): CelExpression {
    return convertLiteralFn(node, context);
  }

  /**
   * Convert call expressions (method calls and global functions)
   */
  private convertCallExpression(
    node: ESTreeCallExpression,
    context: AnalysisContext
  ): CelExpression {
    return convertCallExpressionFn(node, context, this.convertASTNode.bind(this));
  }

  /**
   * Convert global functions like Number(), String(), Boolean()
   */
  // convertGlobalFunction — removed, now handled by call-expression-converters.ts

  // convertMathFunction — removed, now handled by call-expression-converters.ts

  /**
   * Convert unary expressions like !x, +x, -x, !!x
   */
  private convertUnaryExpression(
    node: ESTreeUnaryExpression,
    context: AnalysisContext
  ): CelExpression {
    return convertUnaryExpressionFn(node, context, this.convertASTNode.bind(this));
  }

  /**
   * Convert array expressions
   */
  private convertArrayExpression(
    node: ESTreeArrayExpression,
    context: AnalysisContext
  ): CelExpression {
    return convertArrayExpressionFn(node, context, this.convertASTNode.bind(this));
  }

  /**
   * Convert identifier expressions
   */
  private convertIdentifier(node: ESTreeIdentifier, context: AnalysisContext): CelExpression {
    return convertIdentifierFn(node, context);
  }

  /**
   * Map JavaScript operators to CEL operators
   */
  private mapOperatorToCel(operator: string): string {
    return mapOperatorToCelFn(operator);
  }

  /**
   * Extract member path from AST node
   */
  private extractMemberPath(node: ESTreeNode): string {
    return extractMemberPathFn(node);
  }

  /**
   * Check if a node represents a complex expression that can't be handled as a simple path
   */
  private isComplexExpression(node: ESTreeNode): boolean {
    return isComplexExpressionFn(node);
  }

  /**
   * Get source text from AST node (placeholder implementation)
   */
  private getSourceText(node: ESTreeNode): string {
    return getSourceTextFn(node);
  }

  /**
   * Generate CEL expression for resource field reference
   */
  private getResourceFieldReference(
    _resource: Enhanced<unknown, unknown>,
    resourceKey: string,
    fieldPath: string,
    context: AnalysisContext
  ): CelExpression {
    const expression = `${resourceKey}.${fieldPath}`;
    const ref: KubernetesRef<unknown> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: resourceKey,
      fieldPath,
      _type: inferTypeFromFieldPathFn(fieldPath),
    };
    if (!context.dependencies) {
      context.dependencies = [];
    }
    context.dependencies.push(ref);
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Generate CEL expression for schema field reference
   */
  private getSchemaFieldReference(path: string, context: AnalysisContext): CelExpression {
    const fieldPath = path.substring('schema.'.length);
    const ref: KubernetesRef<unknown> = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: '__schema__',
      fieldPath,
      _type: inferTypeFromFieldPathFn(fieldPath),
    };

    if (!context.dependencies) {
      context.dependencies = [];
    }
    context.dependencies.push(ref);

    // Generate CEL expression for schema field reference
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: path,
      _type: undefined,
    } as CelExpression;
  }

  /**
   * Safely extract an arrow function predicate's parameter name from an ESTree argument.
   * Returns the param name and the arrow function node, or throws if not an arrow function.
   */
  private extractArrowPredicate(arg: ESTreeExpression | ESTreeSpreadElement): {
    param: string;
    arrow: ESTreeArrowFunction;
  } {
    return extractArrowPredicateFn(arg);
  }

  /**
   * Get the name of a MemberExpression's property, safely handling the Expression | PrivateIdentifier union.
   */
  private getPropertyName(prop: ESTreeExpression | { type: string; name: string }): string {
    return getPropertyNameFn(prop);
  }

  /**
   * Safely get an arg at a specific index, asserting it exists after length check.
   */
  private getArg(
    args: readonly (ESTreeExpression | ESTreeSpreadElement)[],
    index: number
  ): ESTreeExpression | ESTreeSpreadElement {
    return getArgFn(args, index);
  }

  // ── Extracted converter methods ─────────────────────────────────────
  // The following method categories have been extracted to separate modules:
  // - String methods → string-method-converters.ts
  // - Array methods → array-method-converters.ts
  // - Call expressions (global fns, Math) → call-expression-converters.ts
  // - Operator utils → operator-utils.ts
  // - AST helpers → ast-helpers.ts
  // - AST node converters → ast-node-converters.ts

  /**
   * Check if a value is a static literal that doesn't need conversion
   * Static values (no KubernetesRef objects) should be preserved as-is for performance
   */
  isStaticValue(value: unknown): boolean {
    // Primitive values are always static
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return true;
    }

    // Check if it's a KubernetesRef (not static)
    if (isKubernetesRef(value)) return false;

    // Check if it contains KubernetesRef objects (not static)
    if (containsKubernetesRefs(value)) return false;

    // Arrays and objects need recursive checking
    if (Array.isArray(value)) {
      return value.every((item) => this.isStaticValue(item));
    }

    if (value && typeof value === 'object') {
      return Object.values(value).every((val) => this.isStaticValue(val));
    }

    // Default to static for other types
    return true;
  }

  /**
   * Create a result for static values that don't require conversion
   */
  createStaticValueResult(_value: unknown): CelConversionResult {
    return {
      valid: true,
      celExpression: null, // No CEL expression needed for static values
      dependencies: [],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: false, // Key: static values don't need conversion
    };
  }

  /**
   * Analyze expression using factory pattern aware handling
   *
   * This method integrates with the factory pattern handler to provide
   * appropriate expression processing based on the deployment strategy.
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
            `Factory pattern expression analysis failed: ${error instanceof Error ? error.message : String(error)}`,
            String(expression),
            'javascript'
          ),
        ],
        warnings: [],
        requiresConversion: true,
      };
    }
  }

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
