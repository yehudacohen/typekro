/**
 * CEL Expression Optimizer for Compile-time Resolution
 *
 * This module performs compile-time optimization of CEL expressions and resource references.
 * It does NOT evaluate CEL expressions at runtime - that's handled by:
 * - Kro operator (for Kro mode deployment)
 * - ReferenceResolver (for Direct mode deployment)
 *
 * Purpose:
 * - Resolve known resource references to concrete values when possible
 * - Optimize CEL expressions by substituting known values
 * - Prepare expressions for serialization to ResourceGraphDefinitions
 *
 * When to use:
 * - During ResourceGraphDefinition generation
 * - For status mapping optimization before serialization
 * - When preparing CEL expressions for Kro operator consumption
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import type { CelExpression, KubernetesRef, KubernetesResource } from '../types.js';
import { getInnerCelPath } from './cel-references.js';

export interface EvaluationContext {
  resources: Record<string, KubernetesResource>;
  schema?: Record<string, unknown>;
}

export interface EvaluationResult {
  expression: string;
  wasOptimized: boolean;
  optimizations: string[];
}

/**
 * Attempts to resolve a resource reference to its actual value if known at compile time
 */
function resolveResourceReference(
  ref: KubernetesRef<unknown>,
  context: EvaluationContext
): string | null {
  const { resourceId, fieldPath } = ref;

  // Handle schema references
  if (resourceId === '__schema__') {
    // Try to resolve schema references to actual values if schema context is available
    if (context.schema) {
      const pathParts = fieldPath.split('.');
      let current: any = context.schema;

      for (const part of pathParts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          // Can't resolve further, return the CEL reference
          return `schema.${fieldPath}`;
        }
      }

      // If we resolved to a concrete value, return it as a literal
      if (typeof current === 'string') {
        return `"${current}"`;
      } else if (typeof current === 'number' || typeof current === 'boolean') {
        return String(current);
      }
    }

    // Fallback to CEL reference if we can't resolve
    return `schema.${fieldPath}`;
  }

  // Find the resource
  const resource = Object.values(context.resources).find((r) => r.id === resourceId);
  if (!resource) {
    return null;
  }

  // Try to resolve the field path to a known value
  const pathParts = fieldPath.split('.');
  let current: any = resource;

  for (const part of pathParts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      // Can't resolve further, return the CEL reference
      return `${resourceId}.${fieldPath}`;
    }
  }

  // If we resolved to a concrete value, return it
  if (typeof current === 'string') {
    return `"${current}"`;
  } else if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current);
  }

  // Otherwise, return the CEL reference
  return `${resourceId}.${fieldPath}`;
}

/**
 * Optimizes a CEL expression by resolving known values at compile time
 *
 * NOTE: This does NOT evaluate CEL expressions at runtime. It only performs
 * compile-time optimizations by substituting known resource values.
 */
export function optimizeCelExpression(
  expression: CelExpression<unknown> | string,
  context: EvaluationContext
): EvaluationResult {
  if (typeof expression === 'string') {
    return {
      expression,
      wasOptimized: false,
      optimizations: [],
    };
  }

  if (!isCelExpression(expression)) {
    return {
      expression: String(expression),
      wasOptimized: false,
      optimizations: [],
    };
  }

  // Validate referenced resources exist (informational warnings only).
  // Actual CEL optimization is not performed — resource references must remain
  // as CEL expressions for Kro to evaluate against live Kubernetes resources.
  const optimizations: string[] = [];
  const conditionalPattern =
    /([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9.]*) [><=!]+ \d+ \? "[^"]*" : "[^"]*"/g;
  for (
    let match = conditionalPattern.exec(expression.expression);
    match !== null;
    match = conditionalPattern.exec(expression.expression)
  ) {
    const resourceId = match[1]?.split('.')[0];
    const resource = Object.values(context.resources).find((r) => r.id === resourceId);
    if (!resource) {
      optimizations.push(`Warning: Referenced resource '${resourceId}' not found`);
    }
  }

  return {
    expression: expression.expression,
    wasOptimized: false,
    optimizations,
  };
}

/**
 * Optimizes all CEL expressions in a status mapping object for serialization
 *
 * This prepares status mappings for ResourceGraphDefinition serialization by:
 * - Resolving known resource references to concrete values
 * - Optimizing CEL expressions where possible
 * - Preserving KubernetesRef objects for proper CEL string generation
 */
export function optimizeStatusMappings(
  statusMappings: Record<string, unknown>,
  context: EvaluationContext
): { mappings: Record<string, unknown>; optimizations: string[] } {
  const optimizedMappings: Record<string, unknown> = {};
  const allOptimizations: string[] = [];

  function evaluateValue(value: any, path: string): any {
    if (isKubernetesRef(value)) {
      const resolved = resolveResourceReference(value, context);
      if (resolved) {
        allOptimizations.push(
          `Resolved reference at ${path}: ${getInnerCelPath(value)} -> ${resolved}`
        );
        // For status field serialization, preserve KubernetesRef objects instead of converting to strings
        // The serializeStatusMappingsToCel function expects KubernetesRef objects to generate proper CEL expressions
        if (resolved === `${value.resourceId}.${value.fieldPath}`) {
          // If the resolved value is the same as the original reference, preserve the KubernetesRef
          return value;
        } else {
          // If the resolved value is different (e.g., a concrete value), convert to CelExpression
          return {
            [CEL_EXPRESSION_BRAND]: true,
            expression: resolved.startsWith('"') ? resolved.slice(1, -1) : resolved,
          } as CelExpression<unknown>;
        }
      }
      return value;
    }

    if (isCelExpression(value)) {
      const result = optimizeCelExpression(value, context);
      if (result.wasOptimized) {
        allOptimizations.push(
          `Optimized CEL expression at ${path}: ${value.expression} -> ${result.expression}`
        );
        allOptimizations.push(...result.optimizations.map((opt) => `  ${opt}`));
      }
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: result.expression,
        ...(value.__isTemplate && { __isTemplate: true }),
      } as CelExpression<unknown>;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const optimizedObject: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        optimizedObject[key] = evaluateValue(nestedValue, `${path}.${key}`);
      }
      return optimizedObject;
    }

    return value;
  }

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    optimizedMappings[fieldName] = evaluateValue(fieldValue, fieldName);
  }

  return {
    mappings: optimizedMappings,
    optimizations: allOptimizations,
  };
}
