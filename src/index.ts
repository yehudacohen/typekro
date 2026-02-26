/**
 * typekro - Define Kro resource graphs with full TypeScript safety.
 */

// =============================================================================
// ALCHEMY INTEGRATION
// =============================================================================
// Alchemy resource conversion and wrapper utilities
export {
  createAlchemyResourceId,
  DirectTypeKroDeployer,
  // Resource conversion utilities
  // Alchemy conversion utilities removed - using dynamic registration approach

  // Utility functions (non-conflicting)
  // generateDeterministicResourceId is exported from utils

  // Alchemy dynamic registration exports
  ensureResourceTypeRegistered,
  KroTypeKroDeployer,
} from './alchemy/deployment.js';
// =============================================================================
// IMPERATIVE COMPOSITION PATTERN
// =============================================================================
// New imperative composition API
export {
  clearCompositionDebugLogs,
  disableCompositionDebugging,
  enableCompositionDebugging,
  getCompositionDebugLogs,
  kubernetesComposition,
} from './core/composition/imperative.js';
// =============================================================================
// BOOTSTRAP COMPOSITIONS
// =============================================================================
// Pre-built compositions for infrastructure bootstrap
export {
  type TypeKroRuntimeConfig,
  typeKroRuntimeBootstrap,
} from './core/composition/typekro-runtime/index.js';
export type { CompositionFactory } from './core/types/serialization.js';
// =============================================================================
// CORE FUNCTIONALITY
// =============================================================================
// Export all core functionality (excluding createResource to avoid conflicts with factories)
export {
  Cel,
  type CelExpression,
  // Error types
  CircularDependencyError,
  CompositionDebugger,
  CompositionExecutionError,
  ContextRegistrationError,
  containsKubernetesRefs,
  // Logging functionality
  createContextLogger,
  createLogger,
  // Alchemy integration - dynamic registration approach (exported below)

  // Schema proxy functions
  createSchemaProxy,
  DependencyGraph,
  // Dependency resolution
  DependencyResolver,
  // Direct deployment functionality
  DirectDeploymentEngine,
  // Type definitions and utilities
  type Enhanced,
  externalRef,
  generateKroSchema,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  isCelExpression,
  // Utility functions
  isKubernetesRef,
  isSchemaReference,
  type KroCompatibleType,
  type KubernetesRef,
  type KubernetesResource,
  type LoggerConfig,
  type LoggerContext,
  logger,
  type MagicAssignableShape,
  type MagicProxy,
  // Reference resolution and CEL
  ReferenceResolver,
  type RefOrValue,
  type ResourceBuilder,
  type ResourceGraphDefinition,
  type SchemaProxy,
  type StatusBuilder,
  // Serialization and YAML generation
  serializeResourceGraphToYaml,
  type TypedKroResourceGraphDefinition,
  type TypedResourceGraphFactory,
  TypeKroError,
  type TypeKroLogger,
  toResourceGraph,
  UnsupportedPatternDetector,
  validateResourceGraph,
} from './core.js';
// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================
// Factory functions organized by ecosystem and resource type
export * from './factories/index.js';
