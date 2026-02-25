/**
 * Type Guards for Dependency Resolution
 *
 * Standalone implementations of type guards to avoid circular dependencies.
 * These are functionally identical to the canonical versions in `src/utils/type-guards.ts`
 * but import only from low-level core modules (constants/brands, types/common).
 *
 * IMPORTANT: When updating type guard logic, update both this file and
 * `src/utils/type-guards.ts` to keep them in sync.
 */

import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';

/**
 * Type guard to check if a value is a compile-time KubernetesRef.
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
 * Type guard to check if a value is a CelExpression.
 *
 * Verifies both the brand symbol and that the `expression` property is a string,
 * ensuring only properly constructed CEL expressions pass the check.
 */
export function isCelExpression(value: unknown): value is CelExpression {
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
