/**
 * Magic Proxy System Integration for JavaScript to CEL Expression Conversion
 *
 * This module provides deep integration with TypeKro's magic proxy system,
 * including SchemaProxy and ResourcesProxy, to detect and analyze KubernetesRef
 * objects within JavaScript expressions and convert them to appropriate CEL expressions.
 *
 * The magic proxy system creates KubernetesRef objects at runtime when accessing
 * properties on schema and resources proxies. This analyzer uses AST parsing to
 * detect these access patterns in JavaScript expressions and converts them to CEL.
 */

import { isKubernetesRef } from '../../../utils/type-guards.js';
import { DEFAULT_MAX_ANALYSIS_DEPTH } from '../../config/defaults.js';
import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError, ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { SourceMapEntry } from '../analysis/source-map.js';
import { SourceMapBuilder } from '../analysis/source-map.js';
import { analyzeASTForMagicProxyPatterns, parseExpression } from './magic-proxy-ast.js';
import type { MagicProxyAnalysisContext, MagicProxyAnalysisResult } from './magic-proxy-types.js';

// Re-export types for backward compatibility
export type { MagicProxyAnalysisContext, MagicProxyAnalysisResult } from './magic-proxy-types.js';

/**
 * Magic Proxy Analyzer for detecting and converting KubernetesRef objects
 * from TypeKro's magic proxy system
 */
export class MagicProxyAnalyzer {
  private sourceMapBuilder: SourceMapBuilder;
  private logger = getComponentLogger('magic-proxy-analyzer');

  constructor() {
    this.sourceMapBuilder = new SourceMapBuilder();
  }

  /**
   * Analyze expressions for magic proxy access patterns
   *
   * This method can handle different types of expressions:
   * - String expressions: parsed with AST
   * - KubernetesRef objects: analyzed directly
   * - Other objects: analyzed for nested KubernetesRef objects
   */
  analyzeExpressionWithRefs(
    expression: unknown,
    context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    try {
      // Handle KubernetesRef objects directly
      if (
        expression &&
        typeof expression === 'object' &&
        (expression as Record<string, unknown>).__brand === 'KubernetesRef'
      ) {
        return this.analyzeKubernetesRefDirectly(expression as KubernetesRef<unknown>, context);
      }

      // Handle string expressions with AST parsing
      if (typeof expression === 'string') {
        return this.analyzeStringExpression(expression, context);
      }

      // Handle other objects
      if (typeof expression === 'object' && expression !== null) {
        return this.analyzeObjectExpression(expression, context);
      }

      // Handle primitives
      return this.analyzePrimitiveExpression(expression, context);
    } catch (error: unknown) {
      return this.createErrorResult(expression, error, context);
    }
  }

  /**
   * Analyze a KubernetesRef object directly
   */
  private analyzeKubernetesRefDirectly(
    ref: KubernetesRef<unknown>,
    context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    const { schemaRefs, resourceRefs, schemaReferences, resourceReferences } =
      this.analyzeKubernetesRefs([ref]);

    const celExpressions = this.convertKubernetesRefsToCel([ref], context);
    const proxyTypes: ('schema' | 'resource')[] = [];
    if (schemaRefs.length > 0) proxyTypes.push('schema');
    if (resourceRefs.length > 0) proxyTypes.push('resource');

    return {
      valid: true,
      celExpression: celExpressions.length > 0 ? celExpressions[0] || null : null,
      dependencies: [ref],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: true,
      proxyTypes,
      schemaReferences,
      resourceReferences,
      analysisDepth: 1,
    };
  }

  /**
   * Analyze string expressions using AST parsing
   */
  private analyzeStringExpression(
    expressionSource: string,
    context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    this.logger.debug('Analyzing string expression for magic proxy patterns', {
      expression: expressionSource.substring(0, 100),
      contextType: context.type,
    });

    // Parse the JavaScript expression to AST
    const ast = parseExpression(expressionSource);

    // Analyze the AST for magic proxy access patterns
    const analysisResult = analyzeASTForMagicProxyPatterns(ast, expressionSource, context);

    // Convert the analysis result to magic proxy result format
    const conversionResult = this.convertToMagicProxyResult(analysisResult, context);

    return conversionResult;
  }

  /**
   * Analyze object expressions
   */
  private analyzeObjectExpression(
    obj: unknown,
    context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    const refs = this.detectKubernetesRefs(obj);
    const { schemaRefs, resourceRefs, schemaReferences, resourceReferences } =
      this.analyzeKubernetesRefs(refs);

    const celExpressions = this.convertKubernetesRefsToCel(refs, context);
    const proxyTypes: ('schema' | 'resource')[] = [];
    if (schemaRefs.length > 0) proxyTypes.push('schema');
    if (resourceRefs.length > 0) proxyTypes.push('resource');

    return {
      valid: true,
      celExpression: celExpressions.length > 0 ? celExpressions[0] || null : null,
      dependencies: refs,
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: refs.length > 0,
      proxyTypes,
      schemaReferences,
      resourceReferences,
      analysisDepth: 1,
    };
  }

  /**
   * Analyze primitive expressions
   */
  private analyzePrimitiveExpression(
    _value: unknown,
    _context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    return {
      valid: true,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: false,
      proxyTypes: [],
      schemaReferences: [],
      resourceReferences: [],
      analysisDepth: 0,
    };
  }

  /**
   * Detect KubernetesRef objects in complex data structures
   *
   * This method uses a breadth-first search approach to find all
   * KubernetesRef objects while respecting maxDepth to prevent infinite recursion.
   * The maxDepth limits how deep we traverse non-KubernetesRef objects, but we
   * continue searching for KubernetesRef objects even beyond the depth limit.
   * This allows us to find deeply nested KubernetesRef objects while still
   * preventing infinite recursion on complex object graphs.
   */
  detectKubernetesRefs(
    value: unknown,
    maxDepth: number = DEFAULT_MAX_ANALYSIS_DEPTH,
    currentDepth: number = 0
  ): KubernetesRef<unknown>[] {
    const refs: KubernetesRef<unknown>[] = [];
    const visited = new WeakSet();

    // Use a queue for breadth-first traversal
    const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: currentDepth }];

    while (queue.length > 0) {
      const currentEntry = queue.shift();
      if (!currentEntry) break;
      const { value: currentValue, depth } = currentEntry;

      // Skip if we've already visited this object (prevents infinite loops)
      if (currentValue && typeof currentValue === 'object' && visited.has(currentValue)) {
        continue;
      }

      // Check if the current value is a KubernetesRef
      if (this.isKubernetesRef(currentValue)) {
        refs.push(currentValue);
        continue; // Don't traverse into KubernetesRef objects
      }

      // Mark as visited if it's an object
      if (currentValue && typeof currentValue === 'object') {
        visited.add(currentValue);
      }

      // For objects beyond maxDepth, we still check if they might contain
      // KubernetesRef objects, but we limit the expansion to prevent
      // infinite recursion on complex object graphs
      const shouldExpandFully = depth < maxDepth;
      const shouldCheckForRefs = depth < maxDepth + 50; // Allow significant extra depth for KubernetesRef detection

      if (!shouldCheckForRefs) {
        continue;
      }

      // Add children to the queue for further processing
      if (Array.isArray(currentValue)) {
        for (const item of currentValue) {
          if (shouldExpandFully || this.mightContainKubernetesRef(item)) {
            queue.push({ value: item, depth: depth + 1 });
          }
        }
      } else if (currentValue && typeof currentValue === 'object') {
        // Skip functions and special objects
        if (
          typeof currentValue === 'function' ||
          currentValue instanceof Date ||
          currentValue instanceof RegExp
        ) {
          continue;
        }

        // Add object properties to the queue
        const currentRecord = currentValue as Record<string, unknown>;
        for (const key in currentRecord) {
          if (Object.hasOwn(currentRecord, key)) {
            try {
              const propertyValue = currentRecord[key];
              if (shouldExpandFully || this.mightContainKubernetesRef(propertyValue)) {
                queue.push({ value: propertyValue, depth: depth + 1 });
              }
            } catch (error: unknown) {
              // Ignore errors when accessing properties during analysis
              this.logger.debug('Ignored error when accessing property during analysis', {
                err: error,
              });
            }
          }
        }
      }
    }

    return refs;
  }

  /**
   * Analyze KubernetesRef objects and categorize them by type
   */
  analyzeKubernetesRefs(refs: KubernetesRef<unknown>[]): {
    schemaRefs: KubernetesRef<unknown>[];
    resourceRefs: KubernetesRef<unknown>[];
    schemaReferences: string[];
    resourceReferences: string[];
  } {
    const schemaRefs: KubernetesRef<unknown>[] = [];
    const resourceRefs: KubernetesRef<unknown>[] = [];
    const schemaReferences: string[] = [];
    const resourceReferences: string[] = [];

    for (const ref of refs) {
      if (ref.resourceId === '__schema__') {
        schemaRefs.push(ref);
        schemaReferences.push(ref.fieldPath);
      } else {
        resourceRefs.push(ref);
        resourceReferences.push(`${ref.resourceId}.${ref.fieldPath}`);
      }
    }

    return {
      schemaRefs,
      resourceRefs,
      schemaReferences: Array.from(new Set(schemaReferences)),
      resourceReferences: Array.from(new Set(resourceReferences)),
    };
  }

  /**
   * Convert KubernetesRef objects to CEL expressions with magic proxy context
   */
  convertKubernetesRefsToCel(
    refs: KubernetesRef<unknown>[],
    context: MagicProxyAnalysisContext
  ): CelExpression[] {
    const celExpressions: CelExpression[] = [];

    for (const ref of refs) {
      try {
        const celExpression = this.convertSingleKubernetesRefToCel(ref, context);
        celExpressions.push(celExpression);
      } catch (error: unknown) {
        // Log error but continue with other refs
        this.logger.warn(`Failed to convert KubernetesRef to CEL`, {
          resourceId: ref.resourceId,
          fieldPath: ref.fieldPath,
          error: String(error),
        });
      }
    }

    return celExpressions;
  }

  /**
   * Validate KubernetesRef objects against available proxies
   */
  validateKubernetesRefs(
    refs: KubernetesRef<unknown>[],
    context: MagicProxyAnalysisContext
  ): {
    valid: KubernetesRef<unknown>[];
    invalid: Array<{ ref: KubernetesRef<unknown>; reason: string }>;
  } {
    const valid: KubernetesRef<unknown>[] = [];
    const invalid: Array<{ ref: KubernetesRef<unknown>; reason: string }> = [];

    for (const ref of refs) {
      const validationResult = this.validateSingleKubernetesRef(ref, context);

      if (validationResult.isValid) {
        valid.push(ref);
      } else {
        invalid.push({ ref, reason: validationResult.reason });
      }
    }

    return { valid, invalid };
  }

  /**
   * Get source mapping information for magic proxy analysis
   */
  getSourceMapping(): SourceMapEntry[] {
    return this.sourceMapBuilder.getEntries();
  }

  /**
   * Clear source mapping information
   */
  clearSourceMapping(): void {
    this.sourceMapBuilder.clear();
  }

  /**
   * Convert analysis result to MagicProxyAnalysisResult
   */
  private convertToMagicProxyResult(
    analysisResult: {
      refs: KubernetesRef<unknown>[];
      analysisDepth: number;
      hasProxyObjects: boolean;
    },
    context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    const { refs, analysisDepth } = analysisResult;

    // Analyze and categorize KubernetesRef objects
    const { schemaRefs, resourceRefs, schemaReferences, resourceReferences } =
      this.analyzeKubernetesRefs(refs);

    // Validate KubernetesRef objects
    const { valid: validRefs, invalid: invalidRefs } = this.validateKubernetesRefs(refs, context);

    // Convert valid KubernetesRef objects to CEL expressions
    const celExpressions = this.convertKubernetesRefsToCel(validRefs, context);

    // Determine proxy types
    const proxyTypes: ('schema' | 'resource')[] = [];
    if (schemaRefs.length > 0) proxyTypes.push('schema');
    if (resourceRefs.length > 0) proxyTypes.push('resource');

    // Create conversion errors for invalid refs
    const errors: ConversionError[] = invalidRefs.map(
      ({ ref, reason }) =>
        new ConversionError(
          `Invalid KubernetesRef: ${reason}`,
          `${ref.resourceId}.${ref.fieldPath}`,
          'member-access'
        )
    );

    // Determine if conversion is required
    const requiresConversion = refs.length > 0;

    // Create primary CEL expression (use first valid one or null)
    const primaryCelExpression = celExpressions.length > 0 ? celExpressions[0] : null;

    return {
      valid: errors.length === 0,
      celExpression: primaryCelExpression as CelExpression | null,
      dependencies: validRefs,
      sourceMap: this.getSourceMapping(),
      errors,
      warnings: [],
      requiresConversion,
      proxyTypes,
      schemaReferences,
      resourceReferences,
      analysisDepth,
    };
  }

  /**
   * Create error result for failed analysis
   */
  private createErrorResult(
    expression: unknown,
    error: unknown,
    _context: MagicProxyAnalysisContext
  ): MagicProxyAnalysisResult {
    const conversionError = new ConversionError(
      `Magic proxy analysis failed: ${ensureError(error).message}`,
      String(expression),
      'javascript'
    );

    return {
      valid: false,
      celExpression: null,
      dependencies: [],
      sourceMap: [],
      errors: [conversionError],
      warnings: [],
      requiresConversion: false,
      proxyTypes: [],
      schemaReferences: [],
      resourceReferences: [],
      analysisDepth: 0,
    };
  }

  /**
   * Check if a value is a KubernetesRef object.
   * Delegates to the canonical implementation in `src/utils/type-guards.ts`.
   */
  private isKubernetesRef(value: unknown): value is KubernetesRef<unknown> {
    return isKubernetesRef(value);
  }

  /**
   * Quick check if a value might contain KubernetesRef objects
   * This is used for optimization when we're beyond maxDepth but still
   * want to find deeply nested KubernetesRef objects.
   */
  private mightContainKubernetesRef(value: unknown): boolean {
    // If it's already a KubernetesRef, we'll find it
    if (this.isKubernetesRef(value)) {
      return true;
    }

    // If it's not an object, it can't contain KubernetesRef objects
    if (!value || typeof value !== 'object') {
      return false;
    }

    // Skip functions and special objects that are unlikely to contain KubernetesRef objects
    if (
      typeof value === 'function' ||
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Error
    ) {
      return false;
    }

    // For plain objects and arrays, assume they might contain KubernetesRef objects
    // This is a conservative approach that errs on the side of finding all refs
    return true;
  }

  /**
   * Convert a single KubernetesRef to CEL expression
   */
  private convertSingleKubernetesRefToCel(
    ref: KubernetesRef<unknown>,
    context: MagicProxyAnalysisContext
  ): CelExpression {
    // Generate CEL expression based on factory type
    let celExpression: string;

    if (ref.resourceId === '__schema__') {
      // Schema references
      celExpression = `schema.${ref.fieldPath}`;
    } else {
      // Resource references
      celExpression = `resources.${ref.resourceId}.${ref.fieldPath}`;
    }

    // Add source mapping
    if (context.sourceMap) {
      const sourceLocation = { line: 1, column: 1, length: celExpression.length };
      context.sourceMap.addMapping(
        `${ref.resourceId}.${ref.fieldPath}`,
        celExpression,
        sourceLocation,
        context.type,
        {
          expressionType: 'member-access',
          kubernetesRefs: [celExpression],
          dependencies: [`${ref.resourceId}.${ref.fieldPath}`],
          conversionNotes: ['Magic proxy KubernetesRef conversion'],
        }
      );
    }

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: celExpression,
      _type: ref._type,
    } as CelExpression;
  }

  /**
   * Validate a single KubernetesRef object
   */
  private validateSingleKubernetesRef(
    ref: KubernetesRef<unknown>,
    context: MagicProxyAnalysisContext
  ): { isValid: boolean; reason: string } {
    // Check basic structure
    if (!ref.resourceId || !ref.fieldPath) {
      return { isValid: false, reason: 'Missing resourceId or fieldPath' };
    }

    // Validate schema references - always valid if properly structured
    if (ref.resourceId === '__schema__') {
      return { isValid: true, reason: '' };
    }

    // Validate resource references
    if (!context.availableReferences || !context.availableReferences[ref.resourceId]) {
      return {
        isValid: false,
        reason: `Resource '${ref.resourceId}' not found in available references`,
      };
    }

    return { isValid: true, reason: '' };
  }
}

/**
 * Utility functions for magic proxy integration
 */
// biome-ignore lint/complexity/noStaticOnlyClass: This module intentionally exposes a static utility namespace.
export class MagicProxyUtils {
  /**
   * Check if a value contains any KubernetesRef objects
   */
  static containsKubernetesRefs(value: unknown): boolean {
    const analyzer = new MagicProxyAnalyzer();
    const refs = analyzer.detectKubernetesRefs(value);
    return refs.length > 0;
  }

  /**
   * Extract all KubernetesRef objects from a value
   */
  static extractKubernetesRefs(value: unknown): KubernetesRef<unknown>[] {
    const analyzer = new MagicProxyAnalyzer();
    return analyzer.detectKubernetesRefs(value);
  }

  /**
   * Check if a value is a KubernetesRef object.
   * Delegates to the canonical implementation in `src/utils/type-guards.ts`.
   */
  static isKubernetesRef(value: unknown): value is KubernetesRef<unknown> {
    return isKubernetesRef(value);
  }

  /**
   * Check if a value is a schema reference
   */
  static isSchemaReference(value: unknown): boolean {
    return MagicProxyUtils.isKubernetesRef(value) && value.resourceId === '__schema__';
  }

  /**
   * Check if a value is a resource reference
   */
  static isResourceReference(value: unknown): boolean {
    return MagicProxyUtils.isKubernetesRef(value) && value.resourceId !== '__schema__';
  }

  /**
   * Get the CEL expression for a KubernetesRef
   */
  static getCelExpression(ref: KubernetesRef<unknown>): string {
    if (ref.resourceId === '__schema__') {
      return `schema.${ref.fieldPath}`;
    } else {
      return `resources.${ref.resourceId}.${ref.fieldPath}`;
    }
  }
}

/**
 * Global magic proxy analyzer instance
 */
export const globalMagicProxyAnalyzer = new MagicProxyAnalyzer();
