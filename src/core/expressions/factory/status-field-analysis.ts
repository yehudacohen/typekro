/**
 * Status Field Analysis — Per-field analysis for status builder functions
 *
 * Extracted from status-builder-analyzer.ts. Contains methods that analyze
 * individual status fields: runtime object field analysis, AST-based field
 * analysis, mixed object expressions, and static value evaluation.
 */

import type { Node as ESTreeNode } from 'estree';
import { containsKubernetesRefs } from '../../../utils/type-guards.js';
import { ConversionError, ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import type {
  AnalysisContext,
  CelConversionResult,
  JavaScriptToCelAnalyzer,
} from '../analysis/analyzer.js';
import { SourceMapBuilder } from '../analysis/source-map.js';
import type {
  EnhancedTypeOptionalityHandler,
  OptionalityAnalysisResult,
  OptionalityContext,
} from '../magic-proxy/optionality-handler.js';
import { detectLogicalOperatorWarnings, getNodeSource } from './status-ast-utils.js';
import type {
  PropertyAnalysis,
  StatusBuilderAnalysisOptions,
  StatusFieldAnalysisResult,
} from './status-builder-types.js';
import { convertStaticValueToCel } from './status-cel-generation.js';

const logger = getComponentLogger('status-builder-analyzer');

// ── Runtime object field analysis ────────────────────────────────────

/**
 * Analyze a single field in the return object with comprehensive magic proxy support
 */
export function analyzeReturnObjectField(
  fieldName: string,
  fieldValue: unknown,
  resources: Record<string, Enhanced<any, any>>,
  optionalityHandler: EnhancedTypeOptionalityHandler,
  options: Required<StatusBuilderAnalysisOptions>,
  schemaProxy?: SchemaProxy<any, any>
): {
  celExpression: CelExpression | null;
  dependencies: KubernetesRef<unknown>[];
  errors: ConversionError[];
  requiresConversion: boolean;
} {
  try {
    // Create comprehensive analysis context
    const context: OptionalityContext = {
      type: 'status',
      availableReferences: resources,
      ...(schemaProxy && { schemaProxy }),
      factoryType: options.factoryType,
      hydrationStates: options.hydrationStates,
      conservativeNullSafety: options.conservativeNullSafety,
      useKroConditionals: true,
      generateHasChecks: true,
      maxOptionalityDepth: options.maxDepth,
      dependencies: [],
    };

    // Step 1: Detect if the field value contains KubernetesRef objects
    const containsRefs = containsKubernetesRefs(fieldValue);

    if (!containsRefs) {
      // No KubernetesRef objects - return as static value
      return {
        celExpression: convertStaticValueToCel(fieldValue),
        dependencies: [],
        errors: [],
        requiresConversion: false,
      };
    }

    // Step 2: Analyze KubernetesRef objects for optionality requirements
    const optionalityResults = optionalityHandler.analyzeOptionalityRequirements(
      fieldValue,
      context
    );

    // Step 3: Generate CEL expression with appropriate null-safety
    const celResult = optionalityHandler.generateNullSafeCelExpression(
      fieldValue,
      optionalityResults,
      context
    );

    // Step 4: Extract dependencies from the analysis
    const dependencies = optionalityResults.map((result) => result.kubernetesRef);

    return {
      celExpression: celResult.celExpression,
      dependencies,
      errors: celResult.errors,
      requiresConversion: true,
    };
  } catch (error: unknown) {
    const fieldError = new ConversionError(
      `Failed to analyze return object field '${fieldName}': ${ensureError(error).message}`,
      String(fieldValue),
      'unknown'
    );

    return {
      celExpression: null,
      dependencies: [],
      errors: [fieldError],
      requiresConversion: false,
    };
  }
}

// ── AST-based field analysis ─────────────────────────────────────────

/**
 * Analyze a single status field from the AST
 */
export function analyzeStatusField(
  property: PropertyAnalysis,
  resources: Record<string, Enhanced<any, any>>,
  originalSource: string,
  expressionAnalyzer: JavaScriptToCelAnalyzer,
  optionalityHandler: EnhancedTypeOptionalityHandler,
  options: Required<StatusBuilderAnalysisOptions>,
  schemaProxy?: SchemaProxy<any, any>
): StatusFieldAnalysisResult {
  const fieldName = property.name;
  const originalExpression = property.valueSource;

  try {
    // Detect ||/&& operators that may produce unexpected results with KubernetesRef proxies
    const logicalOpWarnings = detectLogicalOperatorWarnings(property.valueNode, fieldName);

    if (logicalOpWarnings.length > 0) {
      for (const warning of logicalOpWarnings) {
        logger.warn(warning, {
          fieldName,
          component: 'status-builder-analyzer',
          suggestion: 'Use Cel.expr() for conditional/fallback logic in status builders',
        });
      }
    }

    // Check if this is a static literal value
    if (property.valueNode.type === 'Literal') {
      return {
        fieldName,
        originalExpression,
        celExpression: null,
        dependencies: [],
        requiresConversion: false,
        valid: true,
        errors: [],
        sourceMap: [],
        optionalityAnalysis: [],
        inferredType: typeof property.valueNode.value,
        confidence: 1.0,
        warnings: logicalOpWarnings,
      };
    }

    // Check if this is the 'undefined' identifier (special case)
    if (property.valueNode.type === 'Identifier' && property.valueNode.name === 'undefined') {
      return {
        fieldName,
        originalExpression,
        celExpression: null,
        dependencies: [],
        requiresConversion: false,
        valid: true,
        errors: [],
        sourceMap: [],
        optionalityAnalysis: [],
        inferredType: 'undefined',
        confidence: 1.0,
        warnings: logicalOpWarnings,
      };
    }

    // Check if this is a boolean literal represented as UnaryExpression (!0 for true, !1 for false)
    if (
      property.valueNode.type === 'UnaryExpression' &&
      property.valueNode.operator === '!' &&
      property.valueNode.argument?.type === 'Literal' &&
      typeof property.valueNode.argument.value === 'number'
    ) {
      const _booleanValue = property.valueNode.argument.value === 0;
      return {
        fieldName,
        originalExpression,
        celExpression: null,
        dependencies: [],
        requiresConversion: false,
        valid: true,
        errors: [],
        sourceMap: [],
        optionalityAnalysis: [],
        inferredType: 'boolean',
        confidence: 1.0,
        warnings: logicalOpWarnings,
      };
    }

    // Check if this is a static object expression
    if (property.valueNode.type === 'ObjectExpression') {
      // Try to evaluate the object as a static value
      const staticValue = evaluateStaticObjectExpression(property.valueNode);
      if (staticValue !== null) {
        return {
          fieldName,
          originalExpression,
          celExpression: null,
          dependencies: [],
          requiresConversion: false,
          valid: true,
          errors: [],
          sourceMap: [],
          optionalityAnalysis: [],
          inferredType: 'object',
          confidence: 1.0,
          staticValue,
          warnings: logicalOpWarnings,
        };
      }

      // This is a mixed object (contains both static and dynamic values)
      const mixedObjectResult = analyzeMixedObjectExpression(
        property.valueNode,
        resources,
        originalSource,
        expressionAnalyzer,
        options,
        schemaProxy
      );
      if (mixedObjectResult.valid) {
        return {
          fieldName,
          originalExpression,
          celExpression: null,
          dependencies: mixedObjectResult.dependencies,
          requiresConversion: mixedObjectResult.requiresConversion,
          valid: true,
          errors: [],
          sourceMap: [],
          optionalityAnalysis: [],
          inferredType: 'object',
          confidence: 1.0,
          staticValue: mixedObjectResult.processedObject,
          warnings: logicalOpWarnings,
        };
      }

      // Mixed object analysis failed
      return {
        fieldName,
        originalExpression,
        celExpression: null,
        dependencies: [],
        requiresConversion: false,
        valid: false,
        errors: [
          new ConversionError(
            `Failed to analyze mixed object expression for field '${fieldName}'`,
            originalExpression,
            'unknown'
          ),
        ],
        sourceMap: [],
        optionalityAnalysis: [],
        inferredType: 'object',
        confidence: 0.0,
        warnings: logicalOpWarnings,
      };
    }

    // Create analysis context
    const context: AnalysisContext = {
      type: 'status',
      availableReferences: resources,
      ...(schemaProxy && { schemaProxy }),
      factoryType: options.factoryType,
      ...(options.includeSourceMapping && { sourceMap: new SourceMapBuilder() }),
      dependencies: [],
    };

    // Analyze the expression using the main analyzer
    const analysisResult = expressionAnalyzer.analyzeExpression(originalExpression, context);

    // Perform optionality analysis if enabled
    let optionalityAnalysis: OptionalityAnalysisResult[] = [];
    if (options.performOptionalityAnalysis) {
      const optionalityContext: OptionalityContext = {
        ...context,
        hydrationStates: options.hydrationStates,
        conservativeNullSafety: options.conservativeNullSafety,
        useKroConditionals: true,
        generateHasChecks: true,
      };

      optionalityAnalysis = optionalityHandler.analyzeOptionalityRequirements(
        originalExpression,
        optionalityContext
      );
    }

    return {
      fieldName,
      originalExpression,
      celExpression: analysisResult.celExpression,
      dependencies: analysisResult.dependencies,
      requiresConversion: analysisResult.requiresConversion,
      valid: analysisResult.valid,
      errors: analysisResult.errors,
      sourceMap: analysisResult.sourceMap,
      optionalityAnalysis,
      inferredType: analysisResult.inferredType ? String(analysisResult.inferredType) : undefined,
      confidence: calculateFieldConfidence(analysisResult, optionalityAnalysis),
      warnings: logicalOpWarnings,
    };
  } catch (error: unknown) {
    const fieldError = new ConversionError(
      `Failed to analyze field '${fieldName}': ${ensureError(error).message}`,
      originalExpression,
      'unknown'
    );

    return {
      fieldName,
      originalExpression,
      celExpression: null,
      dependencies: [],
      requiresConversion: false,
      valid: false,
      errors: [fieldError],
      sourceMap: [],
      optionalityAnalysis: [],
      inferredType: undefined,
      confidence: 0,
      warnings: [],
    };
  }
}

// ── Mixed object expression analysis ─────────────────────────────────

/**
 * Analyze a mixed object expression (contains both static and dynamic values)
 */
export function analyzeMixedObjectExpression(
  objectNode: ESTreeNode,
  resources: Record<string, Enhanced<any, any>>,
  originalSource: string,
  expressionAnalyzer: JavaScriptToCelAnalyzer,
  options: Required<StatusBuilderAnalysisOptions>,
  schemaProxy?: SchemaProxy<any, any>
): {
  valid: boolean;
  processedObject: Record<string, unknown> | null;
  dependencies: KubernetesRef<unknown>[];
  requiresConversion: boolean;
} {
  if (objectNode.type !== 'ObjectExpression') {
    return { valid: false, processedObject: null, dependencies: [], requiresConversion: false };
  }

  const result: Record<string, unknown> = {};
  const allDependencies: KubernetesRef<unknown>[] = [];
  let requiresConversion = false;

  for (const prop of objectNode.properties) {
    if (prop.type === 'Property' && prop.key.type === 'Identifier') {
      const key = prop.key.name;

      // Handle different value types
      if (prop.value.type === 'Literal') {
        result[key] = prop.value.value;
      } else if (prop.value.type === 'ObjectExpression') {
        // Nested object - recursively analyze
        const nestedResult = analyzeMixedObjectExpression(
          prop.value,
          resources,
          originalSource,
          expressionAnalyzer,
          options,
          schemaProxy
        );
        if (nestedResult.valid) {
          result[key] = nestedResult.processedObject;
          allDependencies.push(...nestedResult.dependencies);
          if (nestedResult.requiresConversion) {
            requiresConversion = true;
          }
        } else {
          return {
            valid: false,
            processedObject: null,
            dependencies: [],
            requiresConversion: false,
          };
        }
      } else {
        // Dynamic expression - analyze with expression analyzer
        let valueSource: string;
        try {
          valueSource = getNodeSource(prop.value, originalSource);
        } catch (error: unknown) {
          logger.debug('Failed to get node source for status builder property', {
            err: error,
          });
          return {
            valid: false,
            processedObject: null,
            dependencies: [],
            requiresConversion: false,
          };
        }

        // Create analysis context
        const context: AnalysisContext = {
          type: 'status',
          availableReferences: resources,
          ...(schemaProxy && { schemaProxy }),
          factoryType: options.factoryType,
          dependencies: [],
        };

        try {
          const analysisResult = expressionAnalyzer.analyzeExpression(valueSource, context);

          if (analysisResult.valid && analysisResult.celExpression) {
            const celString = analysisResult.celExpression.expression;
            result[key] = celString.includes('${') ? celString : `\${${celString}}`;
            allDependencies.push(...analysisResult.dependencies);
            requiresConversion = true;
          } else {
            const staticValue = evaluateStaticValue(prop.value);
            if (staticValue !== null) {
              result[key] = staticValue;
            } else {
              return {
                valid: false,
                processedObject: null,
                dependencies: [],
                requiresConversion: false,
              };
            }
          }
        } catch (error: unknown) {
          const staticValue = evaluateStaticValue(prop.value);
          if (staticValue !== null) {
            result[key] = staticValue;
          } else {
            logger.debug(`Failed to analyze property '${key}' of type '${prop.value.type}'`, {
              error,
              key,
              type: prop.value.type,
            });
            return {
              valid: false,
              processedObject: null,
              dependencies: [],
              requiresConversion: false,
            };
          }
        }
      }
    } else {
      // Non-standard property structure
      return { valid: false, processedObject: null, dependencies: [], requiresConversion: false };
    }
  }

  return {
    valid: true,
    processedObject: result,
    dependencies: allDependencies,
    requiresConversion,
  };
}

// ── Static value evaluation ──────────────────────────────────────────

/**
 * Evaluate a static object expression to a JavaScript object
 */
export function evaluateStaticObjectExpression(
  objectNode: ESTreeNode
): Record<string, unknown> | null {
  if (objectNode.type !== 'ObjectExpression') {
    return null;
  }

  const result: Record<string, unknown> = {};

  for (const prop of objectNode.properties) {
    if (prop.type === 'Property' && prop.key.type === 'Identifier') {
      const key = prop.key.name;
      const value = evaluateStaticValue(prop.value);

      if (value === null && prop.value.type !== 'Literal') {
        return null;
      }

      result[key] = value;
    } else {
      return null;
    }
  }

  return result;
}

/**
 * Evaluate a static value from an AST node
 */
export function evaluateStaticValue(node: ESTreeNode): unknown {
  switch (node.type) {
    case 'Literal':
      return (node as ESTreeNode & { value: unknown }).value;
    case 'UnaryExpression': {
      const unary = node as ESTreeNode & {
        operator: string;
        argument?: ESTreeNode & { type: string; value?: unknown };
      };
      if (unary.operator === '!' && unary.argument?.type === 'Literal') {
        return !unary.argument.value;
      }
      if (
        unary.operator === '-' &&
        unary.argument?.type === 'Literal' &&
        typeof unary.argument.value === 'number'
      ) {
        return -unary.argument.value;
      }
      return null;
    }
    case 'ObjectExpression':
      return evaluateStaticObjectExpression(node);
    case 'ArrayExpression': {
      const arrayResult: unknown[] = [];
      for (const element of node.elements) {
        if (element === null) {
          arrayResult.push(null);
        } else {
          const elementValue = evaluateStaticValue(element);
          if (elementValue === null && element.type !== 'Literal') {
            return null;
          }
          arrayResult.push(elementValue);
        }
      }
      return arrayResult;
    }
    default:
      return null;
  }
}

// ── Confidence scoring ───────────────────────────────────────────────

/**
 * Calculate confidence level for field analysis
 */
export function calculateFieldConfidence(
  analysisResult: CelConversionResult,
  optionalityAnalysis: OptionalityAnalysisResult[]
): number {
  let confidence = 0.8; // Base confidence

  if (analysisResult.valid) {
    confidence += 0.1;
  }

  if (analysisResult.errors.length === 0) {
    confidence += 0.1;
  }

  // Factor in optionality analysis confidence
  if (optionalityAnalysis.length > 0) {
    const avgOptionalityConfidence =
      optionalityAnalysis.reduce((sum, result) => sum + result.confidence, 0) /
      optionalityAnalysis.length;

    confidence = (confidence + avgOptionalityConfidence) / 2;
  }

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Categorize dependencies into resource and schema references
 */
export function categorizeDependencies(dependencies: KubernetesRef<unknown>[]): {
  resourceReferences: KubernetesRef<unknown>[];
  schemaReferences: KubernetesRef<unknown>[];
} {
  const resourceReferences: KubernetesRef<unknown>[] = [];
  const schemaReferences: KubernetesRef<unknown>[] = [];

  for (const dep of dependencies) {
    if (dep.resourceId === '__schema__') {
      schemaReferences.push(dep);
    } else {
      resourceReferences.push(dep);
    }
  }

  return { resourceReferences, schemaReferences };
}
