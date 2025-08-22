/**
 * Composition Module
 *
 * This module provides simplified factory functions for creating common
 * Kubernetes resource patterns. These functions wrap the lower-level
 * factory functions with sensible defaults and simplified configuration.
 */

// Export all composition functions
export {
  createWebService,
  simpleConfigMap,
  simpleCronJob,
  simpleDeployment,
  simpleHpa,
  simpleIngress,
  simpleJob,
  simpleNetworkPolicy,
  simplePvc,
  simpleSecret,
  simpleService,
  simpleStatefulSet,
} from './composition.js';
// Export TypeKro runtime bootstrap types
export type {
  TypeKroRuntimeConfig,
  TypeKroRuntimeSpec,
  TypeKroRuntimeStatus,
} from './typekro-runtime/index.js';
// Export TypeKro runtime bootstrap composition
export { typeKroRuntimeBootstrap } from './typekro-runtime/index.js';
// Export composition-specific types
export type {
  SimpleConfigMapConfig,
  SimpleCronJobConfig,
  SimpleDeploymentConfig,
  SimpleHpaConfig,
  SimpleIngressConfig,
  SimpleJobConfig,
  SimpleNetworkPolicyConfig,
  SimplePvcConfig,
  SimpleSecretConfig,
  SimpleServiceConfig,
  SimpleStatefulSetConfig,
  WebServiceComponent,
  WebServiceConfig,
} from './types.js';
