/**
 * References module exports
 *
 * NOTE: Alchemy-aware reference resolution functions live in
 * `src/alchemy/resolver.js` (their canonical home) and are re-exported
 * from the main entry point (`src/index.ts`).
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
export { createExternalRefWithoutRegistration, externalRef } from './external-refs.js';
// Reference resolution (DeploymentMode is both a const object and a type via TS namespacing)
export { DeploymentMode, ReferenceResolver } from './resolver.js';
// Schema proxy
export { createResourcesProxy, createSchemaProxy, isSchemaReference } from './schema-proxy.js';
