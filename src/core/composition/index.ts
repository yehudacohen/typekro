/**
 * Composition Module
 *
 * This module provides simplified factory functions for creating common
 * Kubernetes resource patterns. These functions wrap the lower-level
 * factory functions with sensible defaults and simplified configuration.
 */

// Export composition-specific types — re-exported from factories/ for backward compatibility
export type {
  WebServiceComponent,
  WebServiceConfig,
} from '../../factories/simple/compositions/web-service.js';
// Web service composition — re-exported from factories/ for backward compatibility
// The canonical home is now src/factories/simple/compositions/web-service.ts
export { createWebService } from '../../factories/simple/compositions/web-service.js';
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
// Export TypeKro runtime bootstrap types
export type {
  TypeKroRuntimeConfig,
  TypeKroRuntimeSpec,
  TypeKroRuntimeStatus,
} from './typekro-runtime/index.js';
// Export TypeKro runtime bootstrap composition
export { typeKroRuntimeBootstrap } from './typekro-runtime/index.js';
