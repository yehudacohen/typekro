/**
 * CEL expression generation with null-safety and has() checks
 * for the Enhanced Type Optionality Handler.
 *
 * These standalone functions handle converting expressions to CEL format
 * with appropriate null-safety guards for potentially undefined fields.
 */

import { isKubernetesRef } from '../../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ensureError } from '../../errors.js';
import type { TypeKroLogger } from '../../logging/types.js';
import type { CelExpression } from '../../types/common.js';
import type { SourceMapEntry } from '../analysis/source-map.js';
import type { OptionalityAnalysisResult, OptionalityContext } from './optionality-types.js';

/**
 * Convert expression to basic CEL without null-safety
 */
export function convertToBasicCel(
  expression: unknown,
  _context: OptionalityContext
): CelExpression {
  // This is a placeholder - would need to integrate with the main analyzer
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: String(expression),
    type: 'unknown',
  } as CelExpression;
}

/**
 * Generate null-safe CEL expression
 */
export function generateNullSafeExpression(
  expression: unknown,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext,
  logger: TypeKroLogger
): CelExpression {
  // Use the enhanced has() check generation
  return generateCelWithHasChecksImpl(expression, optionalityResults, context, logger);
}

/**
 * Generate CEL expressions with has() checks for potentially undefined fields.
 *
 * This function creates comprehensive CEL expressions that include has() checks
 * for all potentially undefined fields in the expression.
 */
export function generateCelWithHasChecksImpl(
  expression: unknown,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext,
  logger: TypeKroLogger
): CelExpression {
  try {
    const fieldsRequiringChecks = optionalityResults.filter((result) => result.requiresNullSafety);

    if (fieldsRequiringChecks.length === 0) {
      return convertToBasicCel(expression, context);
    }

    // Generate has() checks for each field
    const hasChecks = generateHasChecksForFields(fieldsRequiringChecks, context);

    // Generate the main expression
    const mainExpression = convertExpressionWithKubernetesRefs(
      expression,
      optionalityResults,
      context
    );

    // Combine has() checks with the main expression
    const combinedExpression = combineHasChecksWithExpression(hasChecks, mainExpression, context);

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: combinedExpression,
      type: inferExpressionType(expression, context),
    } as CelExpression;
  } catch (error: unknown) {
    logger.error('Failed to generate CEL with has() checks', ensureError(error));
    return convertToBasicCel(expression, context);
  }
}

/**
 * Generate has() checks for fields that require null-safety
 */
export function generateHasChecksForFields(
  fieldsRequiringChecks: OptionalityAnalysisResult[],
  context: OptionalityContext
): string[] {
  const hasChecks: string[] = [];
  const processedPaths = new Set<string>();

  for (const field of fieldsRequiringChecks) {
    const resourcePath = field.isSchemaReference
      ? `schema.${field.fieldPath}`
      : `resources.${field.resourceId}.${field.fieldPath}`;

    // Avoid duplicate checks for the same path
    if (processedPaths.has(resourcePath)) {
      continue;
    }
    processedPaths.add(resourcePath);

    // Generate nested has() checks for complex field paths
    const nestedChecks = generateNestedHasChecks(field, context);
    hasChecks.push(...nestedChecks);
  }

  return hasChecks;
}

/**
 * Generate nested has() checks for complex field paths
 */
export function generateNestedHasChecks(
  field: OptionalityAnalysisResult,
  _context: OptionalityContext
): string[] {
  const checks: string[] = [];
  const fieldPath = field.fieldPath;

  if (!fieldPath || !fieldPath.includes('.')) {
    // Simple field path
    const resourcePath = field.isSchemaReference
      ? `schema.${fieldPath}`
      : `resources.${field.resourceId}.${fieldPath}`;
    checks.push(`has(${resourcePath})`);
    return checks;
  }

  // Complex field path - check each level
  const pathParts = fieldPath.split('.');
  const basePrefix = field.isSchemaReference ? 'schema' : `resources.${field.resourceId}`;

  for (let i = 0; i < pathParts.length; i++) {
    const partialPath = pathParts.slice(0, i + 1).join('.');
    const fullPath = `${basePrefix}.${partialPath}`;

    // Skip checks for array indices
    if (!partialPath.includes('[') && !partialPath.includes(']')) {
      checks.push(`has(${fullPath})`);
    }
  }

  return checks;
}

/**
 * Convert expression with KubernetesRef objects to CEL
 */
export function convertExpressionWithKubernetesRefs(
  expression: unknown,
  optionalityResults: OptionalityAnalysisResult[],
  context: OptionalityContext
): string {
  // This is a simplified conversion - in a real implementation,
  // this would integrate with the main expression analyzer

  if (isKubernetesRef(expression)) {
    const result = optionalityResults.find((r) => r.kubernetesRef === expression);
    if (result) {
      return result.isSchemaReference
        ? `schema.${result.fieldPath}`
        : `resources.${result.resourceId}.${result.fieldPath}`;
    }
  }

  // Handle different expression types
  if (typeof expression === 'string') {
    return `"${expression}"`;
  }

  if (typeof expression === 'number') {
    return String(expression);
  }

  if (typeof expression === 'boolean') {
    return String(expression);
  }

  if (Array.isArray(expression)) {
    const elements = expression.map((item) =>
      convertExpressionWithKubernetesRefs(item, optionalityResults, context)
    );
    return `[${elements.join(', ')}]`;
  }

  if (expression && typeof expression === 'object') {
    // Handle object expressions
    const properties = Object.entries(expression).map(([key, value]) => {
      const convertedValue = convertExpressionWithKubernetesRefs(
        value,
        optionalityResults,
        context
      );
      return `"${key}": ${convertedValue}`;
    });
    return `{${properties.join(', ')}}`;
  }

  return String(expression);
}

/**
 * Combine has() checks with the main expression
 */
export function combineHasChecksWithExpression(
  hasChecks: string[],
  mainExpression: string,
  _context: OptionalityContext
): string {
  if (hasChecks.length === 0) {
    return mainExpression;
  }

  // Remove duplicate checks
  const uniqueChecks = Array.from(new Set(hasChecks));

  // Combine all checks with AND operator
  const allChecks = uniqueChecks.join(' && ');

  // Combine checks with the main expression
  return `${allChecks} && ${mainExpression}`;
}

/**
 * Infer the type of the expression result
 */
export function inferExpressionType(expression: unknown, _context: OptionalityContext): string {
  if (typeof expression === 'string') {
    return 'string';
  }

  if (typeof expression === 'number') {
    return 'number';
  }

  if (typeof expression === 'boolean') {
    return 'boolean';
  }

  if (Array.isArray(expression)) {
    return 'array';
  }

  if (expression && typeof expression === 'object') {
    return 'object';
  }

  return 'unknown';
}

/**
 * Generate source mapping for debugging
 */
export function generateSourceMapping(
  originalExpression: unknown,
  celExpression: CelExpression,
  context: OptionalityContext
): SourceMapEntry[] {
  if (!context.sourceMap) {
    return [];
  }

  return [
    {
      originalExpression: String(originalExpression),
      celExpression: celExpression.expression,
      sourceLocation: {
        line: 0,
        column: 0,
        length: String(originalExpression).length,
      },
      context: 'status',
      id: `optionality-${Date.now()}`,
      timestamp: Date.now(),
    },
  ];
}
