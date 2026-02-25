/**
 * Type guard functions for TypeKro
 *
 * This module contains type guard functions that are used throughout
 * the codebase to safely check and narrow types at runtime.
 */

import {
  BrandChecks,
  CEL_EXPRESSION_BRAND,
  KUBERNETES_REF_BRAND,
  MIXED_TEMPLATE_BRAND,
} from '../core/constants/brands.js';
import type { NestedCompositionResource } from '../core/types/deployment.js';
import type { CelExpression, KubernetesRef, ResourceReference } from '../core/types.js';

/**
 * Type guard to check if a value is a compile-time KubernetesRef.
 * Note: At runtime, these are the objects created by the proxy.
 *
 * Uses `Reflect.get` to reliably trigger the proxy's 'get' trap instead of
 * the `in` operator, which requires a 'has' trap that proxies may not implement.
 */
export function isKubernetesRef(obj: unknown): obj is KubernetesRef<unknown> {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) {
    return false;
  }
  return (
    Reflect.get(obj, KUBERNETES_REF_BRAND) === true &&
    'resourceId' in obj &&
    'fieldPath' in obj &&
    typeof (obj as Record<string, unknown>).resourceId === 'string' &&
    typeof (obj as Record<string, unknown>).fieldPath === 'string'
  );
}

/**
 * Type guard to check if a value is a runtime ResourceReference.
 * This is what the serializer looks for.
 */
export function isResourceReference(obj: unknown): obj is ResourceReference<unknown> {
  return (
    obj !== null && typeof obj === 'object' && '__type' in obj && obj.__type === 'ResourceReference'
  );
}

/**
 * Type guard to check if a value is a CEL expression.
 *
 * Verifies both the brand symbol and that the `expression` property is a string,
 * ensuring only properly constructed CEL expressions pass the check.
 */
export function isCelExpression<T = unknown>(value: unknown): value is CelExpression<T> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    CEL_EXPRESSION_BRAND in value &&
    (value as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true &&
    'expression' in value &&
    typeof (value as Record<string, unknown>).expression === 'string'
  );
}

/**
 * Type guard to check if a value is a mixed template (literal string with embedded CEL)
 */
export function isMixedTemplate(
  value: unknown
): value is { [MIXED_TEMPLATE_BRAND]: true; expression: string } {
  return Boolean(
    value && typeof value === 'object' && value !== null && MIXED_TEMPLATE_BRAND in value
  );
}

/**
 * Check if a value contains any KubernetesRef objects (from magic proxy system).
 * This is used by the JavaScript to CEL analyzer to determine if an expression
 * needs conversion.
 */
export function containsKubernetesRefs(value: unknown): boolean {
  if (isKubernetesRef(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsKubernetesRefs(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some((val) => containsKubernetesRefs(val));
  }

  return false;
}

/**
 * Recursively extracts all KubernetesRef objects from a resource definition.
 */
export function extractResourceReferences(obj: unknown): KubernetesRef<unknown>[] {
  const refs: KubernetesRef<unknown>[] = [];

  if (isKubernetesRef(obj)) {
    refs.push(obj);
    return refs;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item) => {
      refs.push(...extractResourceReferences(item));
    });
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      refs.push(...extractResourceReferences(value));
    }
  }

  return refs;
}

/**
 * Type guard for NestedCompositionResource
 */
export function isNestedCompositionResource(
  obj: unknown
): obj is NestedCompositionResource<any, any> {
  return BrandChecks.isNestedComposition(obj);
}
