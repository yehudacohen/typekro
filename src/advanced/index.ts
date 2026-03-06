/**
 * typekro/advanced — Internal & advanced APIs
 *
 * This subpath export exposes lower-level APIs that most users will never need.
 * They are available for library authors, advanced debugging, and internal tooling.
 *
 * ## Categories
 *
 * ### References & Serialization (Tier 4)
 * CEL evaluation, schema proxies, reference resolution, and optimization utilities.
 *
 * ### Logging (Tier 6)
 * Structured logging for debugging and observability.
 *
 * ### Kubernetes Client (Tier 6)
 * Direct Kubernetes API access via client-node integration.
 *
 * ### Errors (Tier 6)
 * All custom error classes and error formatting utilities.
 *
 * ### Dependency Graph (Tier 6)
 * Dependency resolution and topological ordering.
 *
 * ### YAML Processing (Tier 6)
 * Path resolution and YAML file processing internals.
 *
 * ### Utilities (Tier 6)
 * Type guards, resource ID generation, and other internal helpers.
 *
 * @example
 * ```ts
 * import { CelEvaluator, getComponentLogger } from 'typekro/advanced';
 * import { KubernetesClientProvider } from 'typekro/advanced';
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// REFERENCES & SERIALIZATION (Tier 4)
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
} from '../core/references/index.js';

export {
  getDependencyOrder,
  visualizeDependencies,
} from '../core/serialization/index.js';

// =============================================================================
// DEPENDENCY GRAPH
// =============================================================================

export type { DependencyNode } from '../core/dependencies/index.js';
export { DependencyGraph, DependencyResolver } from '../core/dependencies/index.js';

// =============================================================================
// ERRORS
// =============================================================================

export {
  type ArktypeValidationError,
  type ArktypeValidationProblem,
  CircularDependencyError,
  CompositionExecutionError,
  ContextRegistrationError,
  ConversionError,
  CRDInstanceError,
  DeploymentTimeoutError,
  ensureError,
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
} from '../core/errors.js';

// =============================================================================
// KUBERNETES CLIENT
// =============================================================================

export type {
  KubeConfigConsumer,
  KubernetesApiConsumer,
  KubernetesClientConfig,
} from '../core/kubernetes/client-provider.js';
export {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  getKubeConfig,
  getKubernetesApi,
  getKubernetesClientProvider,
  KubernetesClientProvider,
} from '../core/kubernetes/client-provider.js';

// =============================================================================
// LOGGING
// =============================================================================

export type { LoggerConfig, LoggerContext, TypeKroLogger } from '../core/logging/index.js';
export {
  createContextLogger,
  createLogger,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  logger,
} from '../core/logging/index.js';

// =============================================================================
// RESOURCE ID GENERATION
// =============================================================================

export {
  generateDeterministicResourceId,
  generateResourceId,
} from '../core/resources/id.js';

// =============================================================================
// YAML PROCESSING
// =============================================================================

export type { DiscoveredFile, GitPathInfo, ResolvedContent } from '../core/yaml/index.js';
export {
  GitContentError,
  PathResolver,
  pathResolver,
  YamlPathResolutionError,
  YamlProcessingError,
} from '../core/yaml/index.js';

// =============================================================================
// TYPE GUARDS & UTILITIES
// =============================================================================

export {
  containsKubernetesRefs,
  extractResourceReferences,
  isCelExpression,
  isKubernetesRef,
  isResourceReference,
} from '../utils/index.js';
