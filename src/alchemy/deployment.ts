/**
 * Alchemy Dynamic Resource Registration
 * 
 * This module provides the main entry point for alchemy integration
 * with TypeKro resources. It re-exports functionality from focused modules.
 */

// Re-export types
export type {
    TypeKroDeployer,
    SerializableKubeConfigOptions,
    TypeKroResourceProps,
    TypeKroResource
} from './types.js';

// Re-export main functions
export { ensureResourceTypeRegistered, clearRegisteredTypes } from './resource-registration.js';
export { inferAlchemyTypeFromTypeKroResource } from './type-inference.js';
export { DirectTypeKroDeployer, KroTypeKroDeployer } from './deployers.js';
export { createAlchemyResourceId } from './utilities.js';