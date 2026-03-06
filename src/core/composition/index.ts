/**
 * Composition Module
 *
 * This module provides simplified factory functions for creating common
 * Kubernetes resource patterns. These functions wrap the lower-level
 * factory functions with sensible defaults and simplified configuration.
 */

// Export TypeKro runtime bootstrap types (moved to src/compositions/)
export type {
  TypeKroRuntimeConfig,
  TypeKroRuntimeSpec,
  TypeKroRuntimeStatus,
} from '../../compositions/typekro-runtime/index.js';
// Export TypeKro runtime bootstrap composition
export { typeKroRuntimeBootstrap } from '../../compositions/typekro-runtime/index.js';
export type { CompositionFactory } from '../types/serialization.js';
// Export composition context infrastructure
export type { CompositionContext, CompositionContextOptions } from './context.js';
export {
  createCompositionContext,
  getCurrentCompositionContext,
  registerDeploymentClosure,
  runInStatusBuilderContext,
  runWithCompositionContext,
} from './context.js';
// Export imperative composition pattern
export { kubernetesComposition } from './imperative.js';
