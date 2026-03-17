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

import { copyResourceMetadata } from '../core/metadata/index.js';

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
 * Preserve resource metadata from a source object onto a target object.
 * This is needed after object spread (`{...source, ...overrides}`) because
 * metadata stored in the WeakMap is keyed by object identity.
 *
 * @param source The original object that may have metadata in the WeakMap
 * @param target The new object (result of spread) that needs the metadata copied
 */
export function preserveNonEnumerableProperties<T extends Record<string, unknown>>(
  source: T,
  target: T
): void {
  // All metadata (resourceId, readinessEvaluator, includeWhen, readyWhen,
  // forEach, templateOverrides) is stored in the WeakMap. copyResourceMetadata
  // transfers it from source to target and also migrates any legacy
  // non-enumerable properties found on the source object.
  copyResourceMetadata(source, target);
}

/**
 * Escapes special regular expression characters in a string so it can be
 * safely interpolated into a `new RegExp()` pattern.
 *
 * Without this, user-controlled strings like resource names containing
 * characters such as `.`, `+`, `*`, `(`, `)` etc. would be interpreted
 * as regex operators, potentially causing incorrect matches or ReDoS.
 *
 * @param str - The raw string to escape
 * @returns The escaped string safe for `new RegExp()` interpolation
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
