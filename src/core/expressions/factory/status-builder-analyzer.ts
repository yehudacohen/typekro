/**
 * Status Builder Analyzer — Orchestrator
 *
 * Analyzes status builder functions used in toResourceGraph, detecting
 * KubernetesRef objects from the magic proxy system and converting
 * JavaScript expressions to appropriate CEL expressions.
 *
 * Implementation is decomposed into:
 * - status-ast-utils.ts — AST parsing, source extraction, pattern detection
 * - status-cel-generation.ts — CEL generation with status-specific transformations
 * - status-field-analysis.ts — per-field analysis (AST-based and runtime)
 */

import { containsKubernetesRefs } from '../../../utils/type-guards.js';
import { DEFAULT_MAX_ANALYSIS_DEPTH } from '../../config/defaults.js';
import { ConversionError, ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import { JavaScriptToCelAnalyzer } from '../analysis/analyzer.js';
import type { SourceMapEntry } from '../analysis/source-map.js';
import { MagicProxyAnalyzer } from '../magic-proxy/magic-proxy-analyzer.js';
import {
  EnhancedTypeOptionalityHandler,
  type OptionalityContext,
} from '../magic-proxy/optionality-handler.js';
import {
  analyzeReturnStatement as analyzeReturnStatementFn,
  parseStatusBuilderFunction as parseStatusBuilderFunctionFn,
} from './status-ast-utils.js';
import type {
  StatusBuilderAnalysisOptions,
  StatusBuilderAnalysisResult,
  StatusBuilderFunction,
  StatusFieldAnalysisResult,
} from './status-builder-types.js';
import {
  convertStaticValueToCel,
  generateFallbackStatusCel,
  generateStatusContextCelWithAdvancedFeatures,
} from './status-cel-generation.js';
import {
  analyzeReturnObjectField as analyzeReturnObjectFieldFn,
  analyzeStatusField as analyzeStatusFieldFn,
  categorizeDependencies,
} from './status-field-analysis.js';

// Re-export all types for backward compatibility
export type {
  FieldAvailabilityEstimate,
  PropertyAnalysis,
  ReturnStatementAnalysis,
  StatusBuilderAnalysisOptions,
  StatusBuilderAnalysisResult,
  StatusBuilderFunction,
  StatusFieldAnalysisResult,
  StatusFieldCategory,
  StatusFieldHandlingInfo,
  StatusHandlingStrategy,
} from './status-builder-types.js';

/**
 * Default analysis options
 */
const DEFAULT_ANALYSIS_OPTIONS: Required<StatusBuilderAnalysisOptions> = {
  deepAnalysis: true,
  includeSourceMapping: true,
  validateReferences: true,
  performOptionalityAnalysis: true,
  factoryType: 'kro',
  maxDepth: DEFAULT_MAX_ANALYSIS_DEPTH,
  hydrationStates: new Map(),
  conservativeNullSafety: true,
};

/**
 * Status Builder Analyzer
 *
 * Analyzes status builder functions to extract KubernetesRef dependencies
 * and convert JavaScript expressions to CEL for status field population.
 */
export class StatusBuilderAnalyzer {
  private expressionAnalyzer: JavaScriptToCelAnalyzer;
  private magicProxyAnalyzer: MagicProxyAnalyzer;
  private optionalityHandler: EnhancedTypeOptionalityHandler;
  private options: Required<StatusBuilderAnalysisOptions>;
  private logger = getComponentLogger('status-builder-analyzer');

  constructor(
    expressionAnalyzer?: JavaScriptToCelAnalyzer,
    options?: StatusBuilderAnalysisOptions
  ) {
    this.expressionAnalyzer = expressionAnalyzer || new JavaScriptToCelAnalyzer();
    this.magicProxyAnalyzer = new MagicProxyAnalyzer();
    this.optionalityHandler = new EnhancedTypeOptionalityHandler();
    this.options = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  }

  // ── Main orchestration ─────────────────────────────────────────────

  /**
   * Analyze status builder function for toResourceGraph integration
   */
  analyzeStatusBuilder<TSpec extends Record<string, any>, TStatus>(
    statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<TSpec, any>
  ): StatusBuilderAnalysisResult {
    try {
      this.logger.debug('Analyzing status builder function', {
        resourceCount: Object.keys(resources).length,
        hasSchemaProxy: !!schemaProxy,
        factoryType: this.options.factoryType,
      });

      const originalSource = statusBuilder.toString();

      // Parse the status builder function (delegates to status-ast-utils)
      const ast = parseStatusBuilderFunctionFn(originalSource);

      // Analyze the return statement (delegates to status-ast-utils)
      const returnStatement = analyzeReturnStatementFn(ast, originalSource);

      if (!returnStatement || !returnStatement.returnsObject) {
        throw new ConversionError(
          'Status builder must return an object literal',
          originalSource,
          'function-call'
        );
      }

      // Analyze each property in the returned object
      const fieldAnalysis = new Map<string, StatusFieldAnalysisResult>();
      const statusMappings: Record<string, unknown> = {};
      const allDependencies: KubernetesRef<unknown>[] = [];
      const allSourceMap: SourceMapEntry[] = [];
      const allErrors: ConversionError[] = [];

      let overallValid = true;

      for (const property of returnStatement.properties) {
        try {
          // Delegates to status-field-analysis
          const fieldResult = analyzeStatusFieldFn(
            property,
            resources,
            originalSource,
            this.expressionAnalyzer,
            this.optionalityHandler,
            this.options,
            schemaProxy
          );

          fieldAnalysis.set(property.name, fieldResult);

          if (fieldResult.valid) {
            if (fieldResult.celExpression) {
              statusMappings[property.name] = fieldResult.celExpression;
            } else if (fieldResult.staticValue !== undefined) {
              statusMappings[property.name] = fieldResult.staticValue;
            } else if (property.valueNode.type === 'Literal') {
              statusMappings[property.name] = property.valueNode.value;
            } else if (
              property.valueNode.type === 'Identifier' &&
              property.valueNode.name === 'undefined'
            ) {
              statusMappings[property.name] = undefined;
            } else if (
              property.valueNode.type === 'UnaryExpression' &&
              property.valueNode.operator === '!' &&
              property.valueNode.argument?.type === 'Literal' &&
              typeof property.valueNode.argument.value === 'number'
            ) {
              const booleanValue = property.valueNode.argument.value === 0;
              statusMappings[property.name] = booleanValue;
            }
          }

          allDependencies.push(...fieldResult.dependencies);
          allSourceMap.push(...fieldResult.sourceMap);
          allErrors.push(...fieldResult.errors);

          if (!fieldResult.valid) {
            overallValid = false;
          }
        } catch (error: unknown) {
          const fieldError = new ConversionError(
            `Failed to analyze status field '${property.name}': ${ensureError(error).message}`,
            property.valueSource,
            'unknown'
          );

          allErrors.push(fieldError);
          overallValid = false;

          this.logger.debug('Status field analysis using fallback', {
            fieldName: property.name,
            reason: 'Field contains patterns that cannot be converted to CEL',
            fallbackBehavior: 'Static evaluation will be used',
            error: ensureError(error).message,
          });
        }
      }

      // Categorize dependencies (delegates to status-field-analysis)
      const { resourceReferences, schemaReferences } = categorizeDependencies(allDependencies);

      this.logger.debug('Status builder analysis complete', {
        fieldCount: returnStatement.properties.length,
        validFields: Object.keys(statusMappings).length,
        totalDependencies: allDependencies.length,
        resourceReferences: resourceReferences.length,
        schemaReferences: schemaReferences.length,
        overallValid,
      });

      // Aggregate warnings from all field analyses
      const allWarnings: string[] = [];
      for (const fieldResult of fieldAnalysis.values()) {
        allWarnings.push(...fieldResult.warnings);
      }

      return {
        fieldAnalysis,
        statusMappings,
        allDependencies,
        resourceReferences,
        schemaReferences,
        sourceMap: allSourceMap,
        errors: allErrors,
        valid: overallValid,
        warnings: allWarnings,
        originalSource,
        ast,
        returnStatement,
      };
    } catch (error: unknown) {
      const analysisError = new ConversionError(
        `Failed to analyze status builder: ${ensureError(error).message}`,
        statusBuilder.toString(),
        'function-call'
      );

      this.logger.info(
        'Status builder analysis using fallback - this is normal for certain patterns',
        {
          reason: 'Status builder contains patterns that cannot be converted to CEL expressions',
          fallbackBehavior: 'Static evaluation will be used instead',
          error: ensureError(error).message,
        }
      );

      return {
        fieldAnalysis: new Map(),
        statusMappings: {},
        allDependencies: [],
        resourceReferences: [],
        schemaReferences: [],
        sourceMap: [],
        errors: [analysisError],
        valid: false,
        warnings: [],
        originalSource: statusBuilder.toString(),
      };
    }
  }

  // ── Runtime object analysis ────────────────────────────────────────

  /**
   * Analyze return object expressions with magic proxy support
   */
  analyzeReturnObjectWithMagicProxy(
    returnObject: unknown,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>
  ): {
    statusMappings: Record<string, CelExpression>;
    dependencies: KubernetesRef<unknown>[];
    errors: ConversionError[];
  } {
    const statusMappings: Record<string, CelExpression> = {};
    const dependencies: KubernetesRef<unknown>[] = [];
    const errors: ConversionError[] = [];

    if (!returnObject || typeof returnObject !== 'object') {
      errors.push(
        new ConversionError('Return object must be a valid object', String(returnObject), 'unknown')
      );
      return { statusMappings, dependencies, errors };
    }

    for (const [fieldName, fieldValue] of Object.entries(returnObject)) {
      try {
        const fieldResult = analyzeReturnObjectFieldFn(
          fieldName,
          fieldValue,
          resources,
          this.optionalityHandler,
          this.options,
          schemaProxy
        );

        if (fieldResult.celExpression) {
          statusMappings[fieldName] = fieldResult.celExpression;
        }

        dependencies.push(...fieldResult.dependencies);
        errors.push(...fieldResult.errors);
      } catch (error: unknown) {
        errors.push(
          new ConversionError(
            `Failed to analyze field '${fieldName}': ${ensureError(error).message}`,
            String(fieldValue),
            'unknown'
          )
        );
      }
    }

    return { statusMappings, dependencies, errors };
  }

  // ── Nested structure analysis ──────────────────────────────────────

  /**
   * Perform deep analysis of nested return object structures
   */
  analyzeNestedReturnObjectStructure(
    returnObject: unknown,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>,
    depth: number = 0
  ): {
    flattenedMappings: Record<string, CelExpression>;
    nestedDependencies: Map<string, KubernetesRef<unknown>[]>;
    structureErrors: ConversionError[];
  } {
    const flattenedMappings: Record<string, CelExpression> = {};
    const nestedDependencies = new Map<string, KubernetesRef<unknown>[]>();
    const structureErrors: ConversionError[] = [];

    if (depth > this.options.maxDepth) {
      structureErrors.push(
        new ConversionError(
          `Maximum analysis depth (${this.options.maxDepth}) exceeded`,
          String(returnObject),
          'unknown'
        )
      );
      return { flattenedMappings, nestedDependencies, structureErrors };
    }

    try {
      this.analyzeObjectStructureRecursively(
        returnObject,
        '',
        flattenedMappings,
        nestedDependencies,
        structureErrors,
        resources,
        schemaProxy,
        depth
      );
    } catch (error: unknown) {
      structureErrors.push(
        new ConversionError(
          `Failed to analyze nested structure: ${ensureError(error).message}`,
          String(returnObject),
          'unknown'
        )
      );
    }

    return { flattenedMappings, nestedDependencies, structureErrors };
  }

  /**
   * Recursively analyze object structure for KubernetesRef objects
   */
  private analyzeObjectStructureRecursively(
    obj: unknown,
    pathPrefix: string,
    flattenedMappings: Record<string, CelExpression>,
    nestedDependencies: Map<string, KubernetesRef<unknown>[]>,
    errors: ConversionError[],
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>,
    depth: number = 0
  ): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;

      try {
        if (containsKubernetesRefs(value)) {
          const fieldResult = analyzeReturnObjectFieldFn(
            fullPath,
            value,
            resources,
            this.optionalityHandler,
            this.options,
            schemaProxy
          );

          if (fieldResult.celExpression) {
            flattenedMappings[fullPath] = fieldResult.celExpression;
          }

          if (fieldResult.dependencies.length > 0) {
            nestedDependencies.set(fullPath, fieldResult.dependencies);
          }

          errors.push(...fieldResult.errors);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          this.analyzeObjectStructureRecursively(
            value,
            fullPath,
            flattenedMappings,
            nestedDependencies,
            errors,
            resources,
            schemaProxy,
            depth + 1
          );
        } else {
          flattenedMappings[fullPath] = convertStaticValueToCel(value);
        }
      } catch (error: unknown) {
        errors.push(
          new ConversionError(
            `Failed to analyze nested field '${fullPath}': ${ensureError(error).message}`,
            String(value),
            'unknown'
          )
        );
      }
    }
  }

  // ── CEL generation (delegates to status-cel-generation) ────────────

  /**
   * Generate status context-specific CEL from KubernetesRef objects
   */
  generateStatusContextCel(
    kubernetesRef: KubernetesRef<unknown>,
    context: OptionalityContext
  ): CelExpression {
    try {
      return generateStatusContextCelWithAdvancedFeatures(kubernetesRef, context);
    } catch (error: unknown) {
      this.logger.debug('Status context CEL generation using fallback', {
        resourceId: kubernetesRef.resourceId,
        fieldPath: kubernetesRef.fieldPath,
        reason: 'Reference pattern cannot be converted to CEL',
        fallbackBehavior: 'Static reference will be used',
        error: ensureError(error).message,
      });

      return generateFallbackStatusCel(kubernetesRef);
    }
  }
}

// ── Standalone convenience functions ─────────────────────────────────

/**
 * Analyze status builder function for toResourceGraph integration with KubernetesRef detection
 */
export function analyzeStatusBuilderForToResourceGraph<TSpec extends Record<string, any>, TStatus>(
  statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<TSpec, any>,
  factoryType: 'direct' | 'kro' = 'kro'
): {
  statusMappings: Record<string, unknown>;
  dependencies: KubernetesRef<unknown>[];
  hydrationOrder: string[];
  errors: ConversionError[];
  warnings: string[];
  valid: boolean;
  requiresConversion: boolean;
} {
  const options: StatusBuilderAnalysisOptions = {
    deepAnalysis: true,
    includeSourceMapping: true,
    validateReferences: true,
    performOptionalityAnalysis: true,
    factoryType,
    conservativeNullSafety: true,
  };

  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  const result = analyzer.analyzeStatusBuilder(statusBuilder, resources, schemaProxy);

  // Calculate hydration order based on dependencies
  const hydrationOrder = calculateStatusFieldHydrationOrder(result.fieldAnalysis);

  // Determine if any conversion is required
  const requiresConversion = Array.from(result.fieldAnalysis.values()).some(
    (field) => field.requiresConversion
  );

  return {
    statusMappings: result.statusMappings,
    dependencies: result.allDependencies,
    hydrationOrder,
    errors: result.errors,
    warnings: result.warnings,
    valid: result.valid,
    requiresConversion,
  };
}

/**
 * Calculate hydration order for status fields based on their dependencies
 */
function calculateStatusFieldHydrationOrder(
  fieldAnalysis: Map<string, StatusFieldAnalysisResult>
): string[] {
  const fieldDependencies = new Map<string, Set<string>>();
  const allFields = Array.from(fieldAnalysis.keys());

  // Build field-to-field dependencies
  for (const [fieldName, analysis] of fieldAnalysis) {
    const fieldDeps = new Set<string>();

    for (const dep of analysis.dependencies) {
      if (dep.resourceId !== '__schema__') {
        for (const [otherField, otherAnalysis] of fieldAnalysis) {
          if (otherField !== fieldName) {
            const hasMatchingResource = otherAnalysis.dependencies.some(
              (otherDep) => otherDep.resourceId === dep.resourceId
            );
            if (hasMatchingResource) {
              fieldDeps.add(otherField);
            }
          }
        }
      }
    }

    fieldDependencies.set(fieldName, fieldDeps);
  }

  // Perform topological sort
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];

  const visit = (field: string): void => {
    if (visiting.has(field)) {
      return; // Circular dependency - add to result anyway
    }

    if (visited.has(field)) {
      return;
    }

    visiting.add(field);

    const deps = fieldDependencies.get(field) || new Set();
    for (const dep of deps) {
      visit(dep);
    }

    visiting.delete(field);
    visited.add(field);
    result.push(field);
  };

  for (const field of allFields) {
    visit(field);
  }

  return result;
}

/**
 * Convenience function to analyze status builder functions
 */
export function analyzeStatusBuilder<TSpec extends Record<string, any>, TStatus>(
  statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<TSpec, any>,
  options?: StatusBuilderAnalysisOptions
): StatusBuilderAnalysisResult {
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  return analyzer.analyzeStatusBuilder(statusBuilder, resources, schemaProxy);
}

/**
 * Convenience function to analyze return objects with magic proxy support
 */
export function analyzeReturnObjectWithMagicProxy(
  returnObject: unknown,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<any, any>,
  options?: StatusBuilderAnalysisOptions
): {
  statusMappings: Record<string, CelExpression>;
  dependencies: KubernetesRef<unknown>[];
  errors: ConversionError[];
} {
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  return analyzer.analyzeReturnObjectWithMagicProxy(returnObject, resources, schemaProxy);
}

/**
 * Convenience function to generate status context-specific CEL
 */
export function generateStatusContextCel(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext,
  options?: StatusBuilderAnalysisOptions
): CelExpression {
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  return analyzer.generateStatusContextCel(kubernetesRef, context);
}
