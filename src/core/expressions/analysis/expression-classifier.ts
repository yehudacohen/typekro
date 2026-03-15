/**
 * Expression Classifier — Expression type dispatch and special case handling
 *
 * Extracted from analyzer.ts. Contains methods that classify incoming expressions
 * (string, KubernetesRef, object, function, template literal) and route them to
 * the appropriate conversion path. Also contains special case handlers for
 * optional chaining and nullish coalescing fallback paths.
 */

import * as estraverse from 'estraverse';
import type { Node as ESTreeNode, ReturnStatement as ESTreeReturnStatement } from 'estree';
import {
  containsKubernetesRefs,
  extractResourceReferences,
  isKubernetesRef,
} from '../../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError, ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { ResourceValidationResult } from '../validation/resource-validation.js';
import { ParserError, parseScript } from './parser.js';
import {
  convertKubernetesRefToCel,
  extractDependenciesFromExpression,
  extractResourceReferencesFromExpression,
  handleMixedOptionalAndNullishExpression,
  handleNullishCoalescingExpression,
  handleOptionalChainingExpression,
} from './scope-resolver.js';

import type { AnalysisContext, CelConversionResult } from './shared-types.js';
import type { SourceMapEntry } from './source-map.js';

// ── Static value detection ───────────────────────────────────────────

/**
 * Check if a value is a static literal that doesn't need conversion.
 * Static values (no KubernetesRef objects) should be preserved as-is for performance.
 */
export function isStaticValue(value: unknown): boolean {
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
    return value.every((item) => isStaticValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).every((val) => isStaticValue(val));
  }

  // Default to static for other types
  return true;
}

/**
 * Create a result for static values that don't require conversion.
 */
export function createStaticValueResult(_value: unknown): CelConversionResult {
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

// ── Expression dispatch (analyzeExpressionWithRefs) ──────────────────

/**
 * Analyze expressions that may contain KubernetesRef objects from magic proxy system.
 * This is the key method that detects when JavaScript expressions contain KubernetesRef objects.
 *
 * @param analyzeExpressionFn — callback for delegating string expressions to the main analyzer
 */
export function analyzeExpressionWithRefs(
  expression: unknown,
  context: AnalysisContext,
  analyzeExpressionFn: (expression: unknown, context: AnalysisContext) => CelConversionResult
): CelConversionResult {
  try {
    // First check if this is a static value (no KubernetesRef objects)
    if (isStaticValue(expression)) {
      // Static values don't need conversion - preserve them as-is for performance
      return createStaticValueResult(expression);
    }

    // Check if the expression contains KubernetesRef objects
    if (!containsKubernetesRefs(expression)) {
      // No KubernetesRef objects found - return as-is (no conversion needed)
      return createStaticValueResult(expression);
    }

    // Expression contains KubernetesRef objects - needs conversion
    if (typeof expression === 'string') {
      // String expression - parse and convert
      return analyzeExpressionFn(expression, context);
    }

    if (typeof expression === 'function') {
      // Function expression - analyze function body
      return analyzeFunction(expression as (...args: unknown[]) => unknown);
    }

    // Direct KubernetesRef object
    if (isKubernetesRef(expression)) {
      return convertKubernetesRefToResult(expression, context);
    }

    // Template literal or complex expression
    if (isTemplateLiteral(expression)) {
      return analyzeTemplateLiteral(expression, context);
    }

    // Complex object/array containing KubernetesRef objects
    return analyzeComplexValue(expression, context);
  } catch (error: unknown) {
    return {
      valid: false,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [
        new ConversionError(
          `Failed to analyze expression with refs: ${ensureError(error).message}`,
          String(expression),
          'javascript'
        ),
      ],
      requiresConversion: false,
      warnings: [],
    };
  }
}

// ── KubernetesRef analysis ───────────────────────────────────────────

/**
 * Analyze a KubernetesRef object directly.
 */
export function analyzeKubernetesRefObject(
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
 * Analyze object expression by examining its structure.
 */
export function analyzeObjectExpression(
  obj: unknown,
  context: AnalysisContext
): CelConversionResult {
  const kubernetesRefs: KubernetesRef<unknown>[] = [];

  // Recursively examine object properties for KubernetesRef objects
  kubernetesRefs.push(...extractResourceReferences(obj));

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
 * Analyze primitive expression (no KubernetesRef objects).
 */
export function analyzePrimitiveExpression(
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

// ── Function analysis ────────────────────────────────────────────────

/**
 * Analyze a function for JavaScript expressions containing KubernetesRef objects.
 */
export function analyzeFunction(fn: (...args: unknown[]) => unknown): CelConversionResult {
  try {
    // Parse function to AST using unified acorn parser
    const ast = parseScript(fn.toString());

    // Find return statement
    const returnStatement = findReturnStatement(ast);
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
 * Find return statement in AST.
 */
export function findReturnStatement(ast: ESTreeNode): ESTreeReturnStatement | null {
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

// ── Template literal analysis ────────────────────────────────────────

/**
 * Check if a value is a template literal expression.
 */
export function isTemplateLiteral(value: unknown): boolean {
  // Check if it's a string that looks like a template literal
  if (typeof value === 'string') {
    return value.includes('${') && value.includes('}');
  }

  // Check if it's an object that represents a template literal structure
  if (value && typeof value === 'object' && 'type' in value && value.type === 'TemplateLiteral') {
    return true;
  }

  return false;
}

/**
 * Analyze template literal expressions containing KubernetesRef objects.
 */
export function analyzeTemplateLiteral(
  expression: unknown,
  context: AnalysisContext
): CelConversionResult {
  try {
    const dependencies = extractResourceReferences(expression);
    const originalExpression = String(expression);

    let celExpression: CelExpression;

    if (typeof expression === 'string') {
      // Handle string-based template literals
      celExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: expression, // Keep the ${} syntax for CEL
        _type: 'string',
      };
    } else {
      // Handle structured template literal objects
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
      ensureError(error)
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

// ── Complex value analysis ───────────────────────────────────────────

/**
 * Analyze complex values (objects/arrays) that may contain KubernetesRef objects.
 */
export function analyzeComplexValue(value: unknown, context: AnalysisContext): CelConversionResult {
  const dependencies: KubernetesRef<unknown>[] = [];
  const errors: ConversionError[] = [];

  try {
    // Recursively find all KubernetesRef objects
    dependencies.push(...extractResourceReferences(value));

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
      ensureError(error).message,
      sourceLocation,
      ensureError(error)
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

// ── KubernetesRef to result conversion ───────────────────────────────

/**
 * Convert a single KubernetesRef to a conversion result.
 */
export function convertKubernetesRefToResult(
  ref: KubernetesRef<unknown>,
  context: AnalysisContext,
  typeValidator?: {
    validateKubernetesRef: (
      ref: KubernetesRef<unknown>,
      availableReferences: Record<string, Enhanced<unknown, unknown>>,
      schemaProxy?: import('../../types/serialization.js').SchemaProxy<
        Record<string, unknown>,
        Record<string, unknown>
      >
    ) => { valid: boolean; errors: { message: string }[] };
  }
): CelConversionResult {
  try {
    // Use the dedicated KubernetesRef to CEL conversion method
    const celExpression = convertKubernetesRefToCel(ref, context, typeValidator);
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

// ── Special case handlers ────────────────────────────────────────────

/**
 * Handle special cases for expressions that can't be parsed normally.
 */
export function handleSpecialCases(
  expression: string,
  context: AnalysisContext,
  validateResourceReferencesFn?: (
    refs: KubernetesRef<unknown>[],
    availableResources: Record<string, Enhanced<unknown, unknown>>,
    schemaProxy?: import('../../types/serialization.js').SchemaProxy<
      Record<string, unknown>,
      Record<string, unknown>
    >,
    validationContext?: import('../validation/resource-validation.js').ValidationContext
  ) => ResourceValidationResult[]
): CelConversionResult | null {
  // Handle expressions with both optional chaining and nullish coalescing
  if (expression.includes('?.') && expression.includes('??')) {
    return handleMixedOptionalAndNullishExpression(expression, context);
  }

  // Handle optional chaining expressions
  if (expression.includes('?.')) {
    return handleOptionalChainingExpression(expression, context);
  }

  // Handle nullish coalescing expressions
  if (expression.includes('??')) {
    return handleNullishCoalescingExpression(expression, context);
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
      extractDependenciesFromExpression(expression, context);

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
          kubernetesRefs: extractResourceReferencesFromExpression(expression),
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
        context.dependencies.length > 0 &&
        validateResourceReferencesFn
      ) {
        resourceValidation = validateResourceReferencesFn(
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

// handleOptionalChainingExpression, handleMixedOptionalAndNullishExpression,
// and handleNullishCoalescingExpression live in scope-resolver.ts and are
// re-exported above for use by handleSpecialCases.
