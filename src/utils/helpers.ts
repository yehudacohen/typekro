/**
 * General utility functions for TypeKro
 *
 * This module contains **pure utility** functions used across the codebase
 * for common operations like object cleaning and property preservation.
 *
 * Domain-specific logic lives in its canonical location:
 * - CEL serialization → `src/core/serialization/cel-references.ts`
 * - Arktype → Kro schema → `src/core/serialization/schema.ts`
 * - Readiness evaluator → `src/core/readiness/evaluator.ts`
 * - Resource IDs → `src/core/resources/id.ts`
 * - String utilities → `src/utils/string.ts`
 */

import type { WithResourceId } from '../core/types/kubernetes.js';

/**
 * Recursively removes `undefined` values from an object tree.
 *
 * - `null` is preserved (only `undefined` is stripped).
 * - Array items that are `undefined` are filtered out.
 * - Useful for cleaning Helm values objects before serialization.
 */
export function removeUndefinedValues<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedValues).filter((item) => item !== undefined) as T;
  }

  if (typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleanedValue = removeUndefinedValues(value);
      if (cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }
    return cleaned as T;
  }

  return obj;
}

/**
 * Preserve non-enumerable internal properties (readinessEvaluator, __resourceId) from a source
 * object onto a target object.  This is needed after object spread (`{...source, ...overrides}`)
 * because spread only copies enumerable own properties.
 *
 * @param source The original object that may have non-enumerable properties
 * @param target The new object (result of spread) that needs the properties restored
 */
export function preserveNonEnumerableProperties<T extends Record<string, unknown>>(
  source: T,
  target: T
): void {
  const readinessEvaluator = (source as Record<string, unknown>).readinessEvaluator;
  if (typeof readinessEvaluator === 'function') {
    Object.defineProperty(target, 'readinessEvaluator', {
      value: readinessEvaluator,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }

  const resourceId = (source as WithResourceId).__resourceId;
  if (resourceId !== undefined) {
    Object.defineProperty(target, '__resourceId', {
      value: resourceId,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

/**
 * Recursively converts an Enhanced resource proxy into a plain JavaScript object.
 *
 * This is a safe way to serialize the object for the Kubernetes client, preserving
 * all nested properties and stripping any remaining proxy logic.
 */
export function toPlainObject<T>(obj: T, visited = new Set<object>()): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (visited.has(obj)) {
    return obj; // Avoid circular loops
  }
  visited.add(obj);

  if (Array.isArray(obj)) {
    const plainArray = obj.map((item) => toPlainObject(item, visited)) as unknown as T;
    visited.delete(obj);
    return plainArray;
  }

  const plainObj: Record<string | symbol, unknown> = {};
  const keys = Reflect.ownKeys(obj);

  for (const key of keys) {
    const value = (obj as Record<string | symbol, unknown>)[key];

    // Preserve readinessEvaluator function as-is
    if (key === 'readinessEvaluator') {
      plainObj[key] = value;
    }
    // Skip other functions like 'withReadinessEvaluator'
    else if (typeof value !== 'function') {
      plainObj[key] = toPlainObject(value, visited);
    }
  }

  visited.delete(obj);
  return plainObj as T;
}
