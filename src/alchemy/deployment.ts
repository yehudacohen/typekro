/**
 * Alchemy Dynamic Resource Registration
 *
 * This module provides the main entry point for alchemy integration
 * with TypeKro resources. It re-exports functionality from focused modules.
 */

export { DirectTypeKroDeployer, KroTypeKroDeployer } from './deployers.js';

// Re-export main functions
export { clearRegisteredTypes, ensureResourceTypeRegistered } from './resource-registration.js';
export { inferAlchemyTypeFromTypeKroResource } from './type-inference.js';
// Re-export types
export type {
  SerializableKubeConfigOptions,
  TypeKroDeployer,
  TypeKroResource,
  TypeKroResourceProps,
} from './types.js';
export { createAlchemyResourceId } from './utilities.js';
