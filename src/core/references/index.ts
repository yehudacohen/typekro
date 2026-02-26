/**
 * References module exports
 *
 * NOTE: Alchemy-aware reference resolution functions have been moved to
 * `src/alchemy/resolver.js` (their canonical home).  Import them from
 * `src/core.ts` or `src/alchemy/resolver.js` directly.
 */

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
export { createExternalRefWithoutRegistration, externalRef } from './external-refs.js';
export type { DeploymentMode as DeploymentModeType } from './resolver.js';
// Reference resolution
export { DeploymentMode, ReferenceResolver } from './resolver.js';
// Schema proxy
export { createResourcesProxy, createSchemaProxy, isSchemaReference } from './schema-proxy.js';
