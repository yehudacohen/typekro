/**
 * Composition Module
 *
 * This module provides simplified factory functions for creating common
 * Kubernetes resource patterns. These functions wrap the lower-level
 * factory functions with sensible defaults and simplified configuration.
 */

export type { CompositionFactory } from '../types/serialization.js';
// Export composition functions
export { createWebService } from './composition.js';
// Export imperative composition pattern
export { kubernetesComposition } from './imperative.js';
// Export TypeKro runtime bootstrap types
export type {
  TypeKroRuntimeConfig,
  TypeKroRuntimeSpec,
  TypeKroRuntimeStatus,
} from './typekro-runtime/index.js';
// Export TypeKro runtime bootstrap composition
export { typeKroRuntimeBootstrap } from './typekro-runtime/index.js';
// Export composition-specific types
export type { WebServiceComponent, WebServiceConfig } from './types.js';
