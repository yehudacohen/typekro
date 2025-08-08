/**
 * Helper utilities for working with schema proxies in tests
 * These helpers provide proper type safety while working around TypeScript inference issues
 */

import type { SchemaProxy, } from '../../src/index.js';

/**
 * Helper to properly type schema field access
 * This works around TypeScript inference issues while preserving type safety
 */
export function getSchemaField<T>(field: any): T {
  return field as T;
}

/**
 * Helper to create a typed schema accessor
 * This provides a clean API for accessing schema fields with proper types
 */
export function createTypedSchema<TSpec, TStatus>(
  schema: SchemaProxy<any, any>
): {
  spec: TSpec;
  status: TStatus;
} {
  return {
    spec: schema.spec as TSpec,
    status: schema.status as TStatus,
  };
}