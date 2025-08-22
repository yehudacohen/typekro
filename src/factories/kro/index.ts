/**
 * Kro factory functions
 *
 * This module provides factory functions for creating Kro-specific resources
 * with built-in readiness evaluation and proper type safety.
 */

// Re-export Kro-specific types for convenience
export type { KroStatusFields, WithKroStatusFields } from '../../core/types/index.js';
export { kroCustomResourceDefinition } from './kro-crd.js';
export { kroCustomResource } from './kro-custom-resource.js';
export { resourceGraphDefinition } from './resource-graph-definition.js';
