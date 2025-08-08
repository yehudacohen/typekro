/**
 * @yehudacohen/typekro - Define Kro resource graphs with full TypeScript safety.
 */


// =============================================================================
// CORE FUNCTIONALITY
// =============================================================================
// Export all core functionality (excluding createResource to avoid conflicts with factories)
export {
  Cel,
  type CelExpression,
  
  // Error types
  CircularDependencyError,
  
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
  isCelExpression,
  
  // Utility functions
  isKubernetesRef,
  isSchemaReference,
  type KroCompatibleType,
  type KubernetesRef,
  type KubernetesResource,
  
  // Logging functionality
  createContextLogger,
  createLogger,
  getComponentLogger,
  getDeploymentLogger,
  getResourceLogger,
  logger,
  type LoggerConfig,
  type LoggerContext,
  type MagicProxy,
  type TypeKroLogger,
  
  // Reference resolution and CEL
  ReferenceResolver,
  type RefOrValue,
  type ResourceBuilder,
  type ResourceGraphDefinition,
  type SchemaProxy,
  type StatusBuilder,
  type MagicAssignableShape,
  
  // Serialization and YAML generation
  serializeResourceGraphToYaml,
  simpleConfigMap,
  
  // Composition functions
  simpleDeployment,
  simpleHpa,
  simpleIngress,
  simpleJob,
  simpleNetworkPolicy,
  simplePvc,
  simpleSecret,
  simpleService,
  type TypedKroResourceGraphDefinition,
  type TypedResourceGraphFactory,
  TypeKroError,
  toResourceGraph,
  validateResourceGraph,
} from './core.js';

// =============================================================================
// ALCHEMY INTEGRATION
// =============================================================================
// Alchemy resource conversion and wrapper utilities
export {
  // Resource conversion utilities
  // Alchemy conversion utilities removed - using dynamic registration approach
  
  // Utility functions (non-conflicting)
  // generateDeterministicResourceId is exported from utils
  
  // Alchemy dynamic registration exports
  ensureResourceTypeRegistered,
  DirectTypeKroDeployer,
  KroTypeKroDeployer,
  createAlchemyResourceId,
} from './alchemy/deployment.js';

// Alchemy state inspection utilities removed - use alchemy's built-in state store instead
// Access via: alchemyScope.state.all(), alchemyScope.state.get(id), etc.

export {
  // createTypedKubernetesResource, - REMOVED (causes registration conflicts)
  // KroRGD, - REMOVED (causes registration conflicts)
  // createTypedKroCRDInstance, - REMOVED (causes registration conflicts)
  // wrapDirectResources, - REMOVED (non-compliant with spec)
  // wrapKroDeployment, - REMOVED (non-compliant with spec)
  // wrapDeployment, - REMOVED (non-compliant with spec)
  // DirectResourceProvider, - REMOVED (non-compliant with spec)
  // KroResourceProvider, - REMOVED (non-compliant with spec)
  // KroInstanceProvider, - REMOVED (non-compliant with spec)
  // createDirectResourceProvider, - REMOVED (non-compliant with spec)
  // createKroResourceProvider, - REMOVED (non-compliant with spec)
  // createKroInstanceProvider, - REMOVED (non-compliant with spec)
} from './alchemy/index.js';

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================
// Factory functions organized by ecosystem and resource type
export * from './factories/index.js';
