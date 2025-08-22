/**
 * References module exports
 */

// Alchemy-aware reference resolution
export {
  buildResourceGraphWithDeferredResolution,
  containsAlchemyPromises,
  createAlchemyReferenceResolver,
  extractAlchemyPromises,
  hasMixedDependencies,
  isAlchemyPromise,
  resolveAllReferencesInAlchemyContext,
  resolveReferencesWithAlchemy,
} from '../../alchemy/resolver.js';
// Compile-time CEL optimization
export { optimizeCelExpression, optimizeStatusMappings } from '../evaluation/cel-optimizer.js';
export type { ResolutionContext } from '../types/deployment.js';
// Types
export type { CelEvaluationContext } from '../types/references.js';
export { CelEvaluationError } from '../types/references.js';
// CEL utilities
export * from './cel.js';
// CEL evaluation
export { CelEvaluator } from './cel-evaluator.js';
// External references
export { externalRef } from './external-refs.js';
export type { DeploymentMode as DeploymentModeType } from './resolver.js';
// Reference resolution
export { DeploymentMode, ReferenceResolver } from './resolver.js';
// Schema proxy
export { createResourcesProxy, createSchemaProxy, isSchemaReference } from './schema-proxy.js';
