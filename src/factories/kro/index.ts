/**
 * Kro factory functions
 * 
 * This module provides factory functions for creating Kro-specific resources
 * with built-in readiness evaluation and proper type safety.
 */

export { resourceGraphDefinition } from './resource-graph-definition.js';
export { kroCustomResource } from './kro-custom-resource.js';
export { kroCustomResourceDefinition } from './kro-crd.js';

// Re-export Kro-specific types for convenience
export type { WithKroStatusFields, KroStatusFields } from '../../core/types/index.js';