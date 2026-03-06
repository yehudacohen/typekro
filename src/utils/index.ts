/**
 * Utilities Module
 *
 * Pure utility functions, string helpers, and type guards.
 * Domain-specific logic lives in its canonical core/ module.
 */

// Object utilities (canonical location: utils/helpers.ts)
export { preserveNonEnumerableProperties, removeUndefinedValues } from './helpers';
// String utilities (canonical location: utils/string.ts)
export { calculateSimilarity, levenshteinDistance, pascalCase, toCamelCase } from './string';

// Type guard functions
export {
  containsKubernetesRefs,
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from './type-guards';
