/**
 * Type Guards for Dependency Resolution
 *
 * This module provides type guard functions specifically for dependency resolution
 * without importing from core types to avoid circular dependencies.
 */

import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';

/**
 * Type guard to check if a value is a compile-time KubernetesRef.
 * Note: At runtime, these are the objects created by the proxy.
 */
export function isKubernetesRef(obj: unknown): obj is KubernetesRef<unknown> {
  // A KubernetesRef is an object that has our specific brand property set to true
  // and has the required resourceId and fieldPath properties.
  // We check for the function type as well, since our ref factory is a proxy around a function.
  // Note: We access the property directly since it's defined as non-enumerable
  // FIX: Use Reflect.get to reliably trigger the proxy's 'get' trap instead of relying on the 'in' operator, which needs a 'has' trap.
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) {
    return false;
  }
  return (
    Reflect.get(obj, KUBERNETES_REF_BRAND) === true &&
    'resourceId' in obj &&
    'fieldPath' in obj &&
    typeof (obj as any).resourceId === 'string' &&
    typeof (obj as any).fieldPath === 'string'
  );
}

/**
 * Type guard to check if a value is a CelExpression
 */
export function isCelExpression(value: unknown): value is CelExpression {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string | symbol, unknown>;

  return (
    CEL_EXPRESSION_BRAND in obj &&
    obj[CEL_EXPRESSION_BRAND] === true &&
    'expression' in obj &&
    typeof obj.expression === 'string'
  );
}
