/**
 * Optional chaining pattern analysis and CEL generation
 * for the Enhanced Type Optionality Handler.
 *
 * These standalone functions handle analyzing optional chaining patterns
 * in expressions with Enhanced types and generating corresponding CEL expressions.
 */

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError, ensureError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { CelConversionResult } from '../analysis/shared-types.js';
import {
  calculateOptionalityConfidence,
  extractKubernetesRefsFromExpression,
  isPotentiallyUndefinedAtRuntime,
} from './optionality-analysis.js';
import { generateSourceMapping, inferExpressionType } from './optionality-cel-generation.js';
import type {
  EnhancedTypeFieldInfo,
  OptionalChainingPattern,
  OptionalityContext,
} from './optionality-types.js';

/**
 * Analyze optional chaining patterns in expressions with Enhanced types
 */
export function analyzeOptionalChainingPatterns(
  expression: unknown,
  context: OptionalityContext
): {
  patterns: OptionalChainingPattern[];
  enhancedTypeFields: EnhancedTypeFieldInfo[];
  requiresSpecialHandling: boolean;
} {
  const patterns: OptionalChainingPattern[] = [];
  const enhancedTypeFields: EnhancedTypeFieldInfo[] = [];

  // Extract KubernetesRef objects that might be involved in optional chaining
  const kubernetesRefs = extractKubernetesRefsFromExpression(expression);

  for (const ref of kubernetesRefs) {
    // Check if this KubernetesRef represents an Enhanced type field
    const enhancedFieldInfo = analyzeEnhancedTypeField(ref, context);

    if (enhancedFieldInfo.isEnhancedType) {
      enhancedTypeFields.push(enhancedFieldInfo);

      // Create optional chaining pattern for this Enhanced type field
      const pattern: OptionalChainingPattern = {
        kubernetesRef: ref,
        fieldPath: ref.fieldPath || '',
        isEnhancedType: true,
        appearsNonOptional: enhancedFieldInfo.appearsNonOptional,
        actuallyOptional: enhancedFieldInfo.actuallyOptional,
        chainingDepth: calculateChainingDepth(ref.fieldPath || ''),
        suggestedCelPattern: generateOptionalChainingCelPattern(ref, context),
      };

      patterns.push(pattern);
    }
  }

  const requiresSpecialHandling = enhancedTypeFields.some(
    (field) => field.appearsNonOptional && field.actuallyOptional
  );

  return { patterns, enhancedTypeFields, requiresSpecialHandling };
}

/**
 * Analyze Enhanced type field information
 */
export function analyzeEnhancedTypeField(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): EnhancedTypeFieldInfo {
  const fieldPath = kubernetesRef.fieldPath || '';
  const isStatusField = fieldPath.startsWith('status.');

  // Enhanced types in status fields appear non-optional but are actually optional
  const appearsNonOptional = !fieldPath.includes('?') && !fieldPath.includes('|');
  const actuallyOptional = isStatusField || isPotentiallyUndefinedAtRuntime(kubernetesRef, context);

  return {
    kubernetesRef,
    fieldPath,
    isEnhancedType: true,
    appearsNonOptional,
    actuallyOptional,
    isStatusField,
    requiresOptionalChaining: appearsNonOptional && actuallyOptional,
    confidence: calculateOptionalityConfidence(kubernetesRef, context),
  };
}

/**
 * Generate CEL expression for optional chaining with Enhanced types
 */
export function generateOptionalChainingCelExpression(
  expression: unknown,
  optionalChainingAnalysis: {
    patterns: OptionalChainingPattern[];
    enhancedTypeFields: EnhancedTypeFieldInfo[];
    requiresSpecialHandling: boolean;
  },
  context: OptionalityContext,
  analyzeAndGenerate: (expr: unknown, ctx: OptionalityContext) => CelConversionResult
): CelConversionResult {
  try {
    if (!optionalChainingAnalysis.requiresSpecialHandling) {
      // No special handling needed - use regular conversion
      return analyzeAndGenerate(expression, context);
    }

    // Generate CEL expression with proper optional chaining support
    let celExpression: string;

    if (context.useKroConditionals) {
      // Use Kro's conditional operators for optional chaining
      celExpression = generateKroOptionalChainingExpression(
        optionalChainingAnalysis.patterns,
        context
      );
    } else {
      // Use has() checks for optional chaining
      celExpression = generateHasCheckOptionalChainingExpression(
        optionalChainingAnalysis.patterns,
        context
      );
    }

    const dependencies = optionalChainingAnalysis.patterns.map((p) => p.kubernetesRef);

    return {
      valid: true,
      celExpression: {
        [CEL_EXPRESSION_BRAND]: true,
        expression: celExpression,
        type: inferExpressionType(expression, context),
      } as CelExpression,
      dependencies,
      sourceMap: generateSourceMapping(
        expression,
        { [CEL_EXPRESSION_BRAND]: true, expression: celExpression } as CelExpression,
        context
      ),
      errors: [],
      warnings: [],
      requiresConversion: true,
    };
  } catch (error: unknown) {
    const conversionError = new ConversionError(
      `Failed to generate optional chaining CEL: ${ensureError(error).message}`,
      String(expression),
      'optional-chaining'
    );

    return {
      valid: false,
      celExpression: null,
      dependencies: optionalChainingAnalysis.patterns.map((p) => p.kubernetesRef),
      sourceMap: [],
      errors: [conversionError],
      warnings: [],
      requiresConversion: true,
    };
  }
}

/**
 * Generate Kro CEL expression with ? prefix operator for optional chaining
 *
 * Kro uses the ? operator as a prefix before field names for optional access
 */
export function generateKroOptionalChainingExpression(
  patterns: OptionalChainingPattern[],
  _context: OptionalityContext
): string {
  if (patterns.length === 0) {
    return 'null';
  }

  // For Kro, use ? prefix operator for optional field access
  const expressions = patterns.map((pattern) => {
    const resourcePath =
      pattern.kubernetesRef.resourceId === '__schema__'
        ? `schema.${pattern.fieldPath}`
        : `resources.${pattern.kubernetesRef.resourceId}.${pattern.fieldPath}`;

    // Convert field.path.to.value to field.?path.?to.?value (Kro ? prefix syntax)
    const optionalPath = convertToKroOptionalSyntax(resourcePath);
    return optionalPath;
  });

  // Combine multiple patterns if needed
  if (expressions.length === 1) {
    return expressions[0] || 'null';
  }

  // For multiple patterns, use logical AND
  return expressions.join(' && ');
}

/**
 * Convert a field path to Kro's ? prefix optional syntax
 * Example: resources.service.status.loadBalancer.ingress[0].ip
 * Becomes: resources.service.status.?loadBalancer.?ingress[0].?ip
 *
 * The ? operator should be placed before fields that might not exist
 */
export function convertToKroOptionalSyntax(resourcePath: string): string {
  // Split the path into parts, handling array access
  const parts = resourcePath.split('.');
  const result: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Ensure part is defined
    if (!part) continue;

    // Don't add ? to root parts (resources, schema) or the resource ID
    if (i < 3) {
      result.push(part);
    } else {
      // Add ? prefix for optional access to nested fields that might not exist
      if (part.includes('[')) {
        // Handle array access: field[0] becomes ?field[0]
        result.push(`?${part}`);
      } else {
        result.push(`?${part}`);
      }
    }
  }

  return result.join('.');
}

/**
 * Generate has() check expression for optional chaining
 */
export function generateHasCheckOptionalChainingExpression(
  patterns: OptionalChainingPattern[],
  _context: OptionalityContext
): string {
  if (patterns.length === 0) {
    return 'null';
  }

  const expressions: string[] = [];

  for (const pattern of patterns) {
    const resourcePath =
      pattern.kubernetesRef.resourceId === '__schema__'
        ? `schema.${pattern.fieldPath}`
        : `resources.${pattern.kubernetesRef.resourceId}.${pattern.fieldPath}`;

    // Generate nested has() checks for the field path
    const hasChecks = generateNestedHasChecksForPath(resourcePath);
    const finalExpression = `${hasChecks.join(' && ')} && ${resourcePath}`;

    expressions.push(finalExpression);
  }

  return expressions.join(' && ');
}

/**
 * Generate nested has() checks for a field path
 */
export function generateNestedHasChecksForPath(resourcePath: string): string[] {
  const checks: string[] = [];
  const parts = resourcePath.split('.');

  for (let i = 0; i < parts.length; i++) {
    const partialPath = parts.slice(0, i + 1).join('.');
    checks.push(`has(${partialPath})`);
  }

  return checks;
}

/**
 * Calculate chaining depth for a field path
 */
export function calculateChainingDepth(fieldPath: string): number {
  return fieldPath.split('.').length;
}

/**
 * Generate optional chaining CEL pattern for a KubernetesRef
 */
export function generateOptionalChainingCelPattern(
  kubernetesRef: KubernetesRef<unknown>,
  context: OptionalityContext
): string {
  const resourcePath =
    kubernetesRef.resourceId === '__schema__'
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;

  if (context.useKroConditionals) {
    // Use Kro's ? prefix operator for optional access
    return convertToKroOptionalSyntax(resourcePath);
  }

  // Fallback to has() checks for better null safety
  const hasChecks = generateNestedHasChecksForPath(resourcePath);
  return `${hasChecks.join(' && ')} ? ${resourcePath} : null`;
}
