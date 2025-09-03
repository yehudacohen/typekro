/**
 * Type guard functions for TypeKro
 *
 * This module contains type guard functions that are used throughout
 * the codebase to safely check and narrow types at runtime.
 */

import {
  CEL_EXPRESSION_BRAND,
  KUBERNETES_REF_BRAND,
  MIXED_TEMPLATE_BRAND,
} from '../core/constants/brands.js';
import type { CelExpression, KubernetesRef, ResourceReference } from '../core/types.js';

/**
 * Type guard to check if a value is a compile-time KubernetesRef.
 * Note: At runtime, these are the objects created by the proxy.
 */
export function isKubernetesRef(obj: unknown): obj is KubernetesRef<unknown> {
  // A KubernetesRef is an object that has our specific brand property set to true
  // and has the required resourceId and fieldPath properties.
  // We check for the function type as well, since our ref factory is a proxy around a function.
  // Note: We access the property directly since it's defined as non-enumerable
  return (
    (typeof obj === 'object' || typeof obj === 'function') &&
    obj !== null &&
    KUBERNETES_REF_BRAND in obj &&
    (obj as any)[KUBERNETES_REF_BRAND] === true &&
    'resourceId' in obj &&
    'fieldPath' in obj &&
    typeof (obj as any).resourceId === 'string' &&
    typeof (obj as any).fieldPath === 'string'
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
 * Type guard to check if a value is a CEL expression
 */
export function isCelExpression<T = unknown>(value: unknown): value is CelExpression<T> {
  return Boolean(
    value && typeof value === 'object' && value !== null && CEL_EXPRESSION_BRAND in value
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
    return value.some(item => containsKubernetesRefs(item));
  }
  
  if (value && typeof value === 'object') {
    return Object.values(value).some(val => containsKubernetesRefs(val));
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
