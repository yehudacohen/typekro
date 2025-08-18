/**
 * TypeKro Core - Consolidated exports
 *
 * This file provides a single entry point for all TypeKro core functionality.
 * It consolidates exports from all modules to simplify imports and provide
 * a clean API surface.
 */

// =============================================================================
// Alchemy Integration
// =============================================================================
// Alchemy Integration - Dynamic Registration
// =============================================================================
export {
  ensureResourceTypeRegistered,
  DirectTypeKroDeployer,
  KroTypeKroDeployer,
  createAlchemyResourceId,
} from './alchemy/deployment.js';
// Alchemy conversion utilities removed - using dynamic registration approach
export type { WebServiceComponent } from './core/composition/index.js';
// =============================================================================
// Composition Functions (Simple Resource Builders)
// =============================================================================
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
} from './core/composition/index.js';
export type { DependencyNode } from './core/dependencies/index.js';
// =============================================================================
// Dependencies Module
// =============================================================================
export {
  DependencyGraph,
  DependencyResolver,
} from './core/dependencies/index.js';
export type {
  DeploymentOptions,
  ResourceGraph,
} from './core/deployment/index.js';
// =============================================================================
// Deployment Module
// =============================================================================
export {
  DirectDeploymentEngine,
  ResourceDeploymentError,
  ResourceReadinessChecker,
  ResourceReadinessTimeoutError,
} from './core/deployment/index.js';
// =============================================================================
// Error Classes and Utilities
// =============================================================================
export {
  CircularDependencyError,
  CRDInstanceError,
  formatArktypeError,
  formatCircularDependencyError,
  formatReferenceError,
  KroSchemaValidationError,
  ResourceGraphFactoryError,
  TypeKroError,
  TypeKroReferenceError,
  ValidationError,
} from './core/errors.js';
// =============================================================================
// Logging Module (Professional Structured Logging)
// =============================================================================
export {
  createContextLogger,
  createLogger,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  logger,
} from './core/logging/index.js';
export type {
  LoggerConfig,
  LoggerContext,
  TypeKroLogger,
} from './core/logging/index.js';
// =============================================================================
// References Module (CEL, Schema Proxy, External Refs)
// =============================================================================
export * from './core/references/index.js';
export type {
  ResourceBuilder,
  ResourceDependency,
  SchemaDefinition,
  SerializationContext,
  SerializationOptions,
  ValidationResult,
} from './core/serialization/index.js';
// =============================================================================
// Serialization Module (YAML Generation, Validation)
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
// =============================================================================
// Core Types and Interfaces
// =============================================================================
export type * from './core/types/index.js';
export { customResource } from './factories/kubernetes/extensions/custom-resource.js';
// Factory types are now exported from the organized factories structure
export type * from './factories/kubernetes/types.js';
// =============================================================================
// Resource Factory
// =============================================================================
export { createResource } from './factories/shared.js';
// =============================================================================
// Kubernetes Client Provider (Single Source of Truth)
// =============================================================================
export {
  KubernetesClientProvider,
  getKubernetesClientProvider,
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  getKubernetesApi,
  getKubeConfig,
} from './core/kubernetes/client-provider.js';
export type {
  KubernetesClientConfig,
  KubernetesApiConsumer,
  KubeConfigConsumer,
} from './core/kubernetes/client-provider.js';

// =============================================================================
// Core Utilities
// =============================================================================
export {
  arktypeToKroSchema,
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

// =============================================================================
// YAML Processing Module
// =============================================================================
export {
  PathResolver,
  pathResolver,
  YamlPathResolutionError,
  GitContentError,
  YamlProcessingError,
} from './core/yaml/index.js';
export type {
  GitPathInfo,
  ResolvedContent,
  DiscoveredFile,
} from './core/yaml/index.js';
