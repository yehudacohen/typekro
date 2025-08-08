/**
 * References module exports
 */

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
// Reference resolution
export { ReferenceResolver } from './resolver.js';
// Alchemy-aware reference resolution
export { createAlchemyReferenceResolver, isAlchemyPromise, hasMixedDependencies, resolveReferencesWithAlchemy, buildResourceGraphWithDeferredResolution, resolveAllReferencesInAlchemyContext, containsAlchemyPromises, extractAlchemyPromises } from '../../alchemy/resolver.js';
// Schema proxy
export { createSchemaProxy, createResourcesProxy, isSchemaReference } from './schema-proxy.js';
