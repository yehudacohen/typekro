/**
 * typekro - Define Kro resource graphs with full TypeScript safety.
 *
 * This is the single public entry point for the typekro package.
 * Exports are organized into tiers from most-used to advanced:
 *
 *   1. ESSENTIAL — Core APIs every user needs
 *   2. COMPOSITION — Imperative composition and runtime bootstrap
 *   3. DEPLOYMENT — Engines, readiness, and deployers
 *   4. REFERENCES & SERIALIZATION — CEL, schema proxies, YAML generation
 *   5. ALCHEMY INTEGRATION — Alchemy-specific deployers and resolvers
 *   6. ADVANCED — Logging, K8s client, dependencies, errors, utilities
 *
 * For ecosystem-specific factories, use subpath imports:
 *   import { helmRelease } from 'typekro/helm';
 *   import { simple } from 'typekro/simple';
 */

// =============================================================================
// 1. ESSENTIAL — Core APIs every user needs
// =============================================================================

// Imperative composition (define compositions with native TypeScript)
export { kubernetesComposition } from './core/composition/imperative.js';
// Resource factory (used inside resource builders)
export { createResource } from './core/proxy/create-resource.js';
// CEL expression helpers (used in status builders)
export { Cel, cel, externalRef } from './core/references/index.js';
export type {
  ResourceBuilder,
  ResourceDependency,
  SchemaDefinition,
  SerializationContext,
  SerializationOptions,
  ValidationResult,
} from './core/serialization/index.js';
// The primary API: define a typed resource graph
export {
  generateKroSchema,
  generateKroSchemaFromArktype,
  serializeResourceGraphToYaml,
  toResourceGraph,
  validateResourceGraph,
} from './core/serialization/index.js';
// Schema conversion
export { arktypeToKroSchema } from './core/serialization/schema.js';
export type { ResolutionContext } from './core/types/deployment.js';
// Core types (all type-only exports from core/types)
export type * from './core/types/index.js';
export type { CelEvaluationContext } from './core/types/references.js';
export { CelEvaluationError } from './core/types/references.js';
// Factory functions (all ecosystems)
export * from './factories/index.js';
// Factory-specific types
export type * from './factories/kubernetes/types.js';

// =============================================================================
// 2. COMPOSITION — Imperative composition and runtime bootstrap
// =============================================================================

export { getCurrentCompositionContext } from './core/composition/context.js';
export {
  clearCompositionDebugLogs,
  disableCompositionDebugging,
  enableCompositionDebugging,
  getCompositionDebugLogs,
} from './core/composition/imperative.js';
export type { WebServiceComponent } from './core/composition/index.js';
export { createWebService } from './core/composition/index.js';

export {
  type TypeKroRuntimeConfig,
  typeKroRuntimeBootstrap,
} from './core/composition/typekro-runtime/index.js';

export { CompositionDebugger } from './core/composition-debugger.js';

// =============================================================================
// 3. DEPLOYMENT — Engines, readiness, and deployers
// =============================================================================

export type { DeploymentOptions, DeploymentResourceGraph } from './core/deployment/index.js';
export {
  DirectDeploymentEngine,
  ResourceDeploymentError,
  ResourceReadinessChecker,
  ResourceReadinessTimeoutError,
} from './core/deployment/index.js';

// =============================================================================
// 4. REFERENCES & SERIALIZATION — CEL, schema proxies, YAML generation
// =============================================================================

export {
  CelEvaluator,
  createResourcesProxy,
  createSchemaProxy,
  DeploymentMode,
  isSchemaReference,
  optimizeCelExpression,
  optimizeStatusMappings,
  ReferenceResolver,
} from './core/references/index.js';
// DeploymentMode is already exported as a value from './core/references/index.js' above.
// TypeScript's value/type namespace separation allows consumers to use it as both:
//   const mode: DeploymentMode = DeploymentMode.KRO;

export {
  getInnerCelPath,
  processResourceReferences,
} from './core/serialization/cel-references.js';

export {
  getDependencyOrder,
  visualizeDependencies,
} from './core/serialization/index.js';

export { UnsupportedPatternDetector } from './core/unsupported-pattern-detector.js';

// =============================================================================
// 5. ALCHEMY INTEGRATION — Alchemy-specific deployers and resolvers
// =============================================================================

export {
  createAlchemyResourceId,
  DirectTypeKroDeployer,
  ensureResourceTypeRegistered,
  KroTypeKroDeployer,
} from './alchemy/deployment.js';

export {
  buildResourceGraphWithDeferredResolution,
  containsAlchemyPromises,
  createAlchemyReferenceResolver,
  extractAlchemyPromises,
  hasMixedDependencies,
  isAlchemyPromise,
  resolveAllReferencesInAlchemyContext,
  resolveReferencesWithAlchemy,
} from './alchemy/resolver.js';

// =============================================================================
// 6. ADVANCED — Logging, K8s client, dependencies, errors, utilities
// =============================================================================

// Dependency graph
export type { DependencyNode } from './core/dependencies/index.js';
export { DependencyGraph, DependencyResolver } from './core/dependencies/index.js';
// Error classes
export {
  CircularDependencyError,
  CompositionExecutionError,
  ContextRegistrationError,
  ConversionError,
  CRDInstanceError,
  DeploymentTimeoutError,
  formatArktypeError,
  formatCircularDependencyError,
  formatReferenceError,
  KroSchemaValidationError,
  KubernetesApiOperationError,
  KubernetesClientError,
  ResourceGraphFactoryError,
  StatusHydrationError,
  TypeKroError,
  TypeKroReferenceError,
  ValidationError,
} from './core/errors.js';
// Kubernetes client provider
export type {
  KubeConfigConsumer,
  KubernetesApiConsumer,
  KubernetesClientConfig,
} from './core/kubernetes/client-provider.js';
export {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  getKubeConfig,
  getKubernetesApi,
  getKubernetesClientProvider,
  KubernetesClientProvider,
} from './core/kubernetes/client-provider.js';
// Logging
export type { LoggerConfig, LoggerContext, TypeKroLogger } from './core/logging/index.js';
export {
  createContextLogger,
  createLogger,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  logger,
} from './core/logging/index.js';
// Resource ID generation
export {
  generateDeterministicResourceId,
  generateResourceId,
} from './core/resources/id.js';
// YAML processing
export type { DiscoveredFile, GitPathInfo, ResolvedContent } from './core/yaml/index.js';
export {
  GitContentError,
  PathResolver,
  pathResolver,
  YamlPathResolutionError,
  YamlProcessingError,
} from './core/yaml/index.js';

// Type guard and utility functions
export {
  containsKubernetesRefs,
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
  isResourceReference,
} from './utils/index.js';
