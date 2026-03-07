/**
 * Alchemy Integration Module
 *
 * This module provides integration with the Alchemy framework for deploying
 * and managing TypeKro resources and Kro ResourceGraphDefinitions.
 *
 * Uses dynamic resource registration to avoid "Resource already exists" errors.
 */

// Deployer implementations
export { DirectTypeKroDeployer, KroTypeKroDeployer } from './deployers.js';
export type { AlchemyPromise, AlchemyResolutionContext, AlchemyResource } from './resolver.js';

// Reference resolution
export {
  buildResourceGraphWithDeferredResolution,
  containsAlchemyPromises,
  createAlchemyReferenceResolver,
  createAlchemyResourceConfig,
  createAlchemyResourceConfigs,
  extractAlchemyPromises,
  hasMixedDependencies,
  isAlchemyPromise,
  isAlchemyResource,
  resolveAlchemyPromise,
  resolveAllReferences,
  resolveAllReferencesInAlchemyContext,
  resolveReferencesWithAlchemy,
  resolveTypeKroReferencesOnly,
} from './resolver.js';
// Convenience barrel re-exports (deployment.ts re-exports a curated subset)
export {
  clearRegisteredTypes,
  ensureResourceTypeRegistered,
} from './resource-registration.js';

// Type inference
export { inferAlchemyTypeFromTypeKroResource } from './type-inference.js';

// Types
export type {
  AlchemyResourceState,
  SerializableKubeConfigOptions,
  TypeKroDeployer,
  TypeKroResource,
  TypeKroResourceProps,
} from './types.js';

// Utility functions
export { createAlchemyResourceId } from './utilities.js';

// Wrapper utilities
export { generateDeterministicResourceId, isAlchemyWrapped } from './wrapper.js';
