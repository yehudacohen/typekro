/**
 * typekro - Define Kro resource graphs with full TypeScript safety.
 *
 * This is the single public entry point for the typekro package.
 * All symbols that consumers need should be exported from here.
 */

// =============================================================================
// ALCHEMY INTEGRATION
// =============================================================================
export {
  createAlchemyResourceId,
  DirectTypeKroDeployer,
  ensureResourceTypeRegistered,
  KroTypeKroDeployer,
} from './alchemy/deployment.js';
export { getCurrentCompositionContext } from './core/composition/context.js';

// =============================================================================
// IMPERATIVE COMPOSITION
// =============================================================================
export {
  clearCompositionDebugLogs,
  disableCompositionDebugging,
  enableCompositionDebugging,
  getCompositionDebugLogs,
  kubernetesComposition,
} from './core/composition/imperative.js';
export {
  type TypeKroRuntimeConfig,
  typeKroRuntimeBootstrap,
} from './core/composition/typekro-runtime/index.js';
export { CompositionDebugger } from './core/composition-debugger.js';
export type { DependencyNode } from './core/dependencies/index.js';
// =============================================================================
// DEPENDENCIES
// =============================================================================
export { DependencyGraph, DependencyResolver } from './core/dependencies/index.js';
export type { DeploymentOptions, ResourceGraph } from './core/deployment/index.js';
// =============================================================================
// DEPLOYMENT
// =============================================================================
export {
  DirectDeploymentEngine,
  ResourceDeploymentError,
  ResourceReadinessChecker,
  ResourceReadinessTimeoutError,
} from './core/deployment/index.js';
// =============================================================================
// ERROR CLASSES
// =============================================================================
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
export type {
  KubeConfigConsumer,
  KubernetesApiConsumer,
  KubernetesClientConfig,
} from './core/kubernetes/client-provider.js';
// =============================================================================
// KUBERNETES CLIENT
// =============================================================================
export {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  getKubeConfig,
  getKubernetesApi,
  getKubernetesClientProvider,
  KubernetesClientProvider,
} from './core/kubernetes/client-provider.js';
export type { LoggerConfig, LoggerContext, TypeKroLogger } from './core/logging/index.js';
// =============================================================================
// LOGGING
// =============================================================================
export {
  createContextLogger,
  createLogger,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  logger,
} from './core/logging/index.js';
// =============================================================================
// RESOURCE FACTORY
// =============================================================================
export { createResource } from './core/proxy/create-resource.js';
// =============================================================================
// REFERENCES (CEL, Schema Proxy, External Refs)
// =============================================================================
export {
  Cel,
  CelEvaluator,
  cel,
  createExternalRefWithoutRegistration,
  createResourcesProxy,
  createSchemaProxy,
  DeploymentMode,
  externalRef,
  isSchemaReference,
  optimizeCelExpression,
  optimizeStatusMappings,
  ReferenceResolver,
} from './core/references/index.js';
export type { DeploymentMode as DeploymentModeType } from './core/references/resolver.js';
export type {
  ResourceBuilder,
  ResourceDependency,
  SchemaDefinition,
  SerializationContext,
  SerializationOptions,
  ValidationResult,
} from './core/serialization/index.js';
// =============================================================================
// SERIALIZATION (YAML Generation, Validation)
// =============================================================================
export {
  generateKroSchema,
  generateKroSchemaFromArktype,
  getDependencyOrder,
  serializeResourceGraphToYaml,
  toResourceGraph,
  validateResourceGraph,
  visualizeDependencies,
} from './core/serialization/index.js';
export type { ResolutionContext } from './core/types/deployment.js';
// =============================================================================
// CORE TYPES (all type-only exports from core/types)
// =============================================================================
export type * from './core/types/index.js';
export type { CelEvaluationContext } from './core/types/references.js';
export { CelEvaluationError } from './core/types/references.js';
export { UnsupportedPatternDetector } from './core/unsupported-pattern-detector.js';
export type { DiscoveredFile, GitPathInfo, ResolvedContent } from './core/yaml/index.js';
// =============================================================================
// YAML PROCESSING
// =============================================================================
export {
  GitContentError,
  PathResolver,
  pathResolver,
  YamlPathResolutionError,
  YamlProcessingError,
} from './core/yaml/index.js';
// =============================================================================
// FACTORY FUNCTIONS (all ecosystems)
// =============================================================================
export * from './factories/index.js';
// =============================================================================
// KUBERNETES TYPES (factory-specific types)
// =============================================================================
export type * from './factories/kubernetes/types.js';
// =============================================================================
// UTILITIES
// =============================================================================
export {
  arktypeToKroSchema,
  containsKubernetesRefs,
  extractResourceReferences,
  generateCelReference,
  generateDeterministicResourceId,
  generateResourceId,
  getInnerCelPath,
  isCelExpression,
  isKubernetesRef,
  isResourceReference,
  pascalCase,
  processResourceReferences,
} from './utils/index.js';
