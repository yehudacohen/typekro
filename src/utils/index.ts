/**
 * Utilities Module
 *
 * This module provides general utility functions and type guards
 * that are used throughout the TypeKro codebase.
 */

// Export helper functions
export {
  arktypeToKroSchema,
  generateCelReference,
  generateDeterministicResourceId,
  generateResourceId,
  getInnerCelPath,
  pascalCase,
  processResourceReferences,
} from './helpers';

// Export type guard functions
export {
  containsKubernetesRefs,
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
  isResourceReference,
} from './type-guards';
