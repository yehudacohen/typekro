/**
 * Utilities Module
 *
 * This module provides general utility functions and type guards
 * that are used throughout the TypeKro codebase.
 *
 * Domain-specific symbols are re-exported from their canonical homes
 * for backward compatibility.
 */

export {
  generateDeterministicResourceId,
  generateResourceId,
  getResourceId,
} from '../core/resources/id';

// Re-exports from canonical locations (backward compatibility)
export {
  generateCelReference,
  getInnerCelPath,
  processResourceReferences,
} from '../core/serialization/cel-references';

export { arktypeToKroSchema } from '../core/serialization/schema';
// Object utilities (canonical location: utils/helpers.ts)
export {
  preserveNonEnumerableProperties,
  removeUndefinedValues,
  toPlainObject,
} from './helpers';
// String utilities (canonical location: utils/string.ts)
export { pascalCase, toCamelCase } from './string';

// Type guard functions
export {
  containsKubernetesRefs,
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
  isResourceReference,
} from './type-guards';
