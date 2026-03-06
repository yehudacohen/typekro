/**
 * typekro - Define Kro resource graphs with full TypeScript safety.
 *
 * ## Getting Started
 *
 * The two primary APIs are:
 *
 * - **{@link toResourceGraph}** (declarative) - Define a typed resource graph
 *   with a schema, resource builder, and status builder:
 *
 *   ```ts
 *   import { toResourceGraph, Cel } from 'typekro';
 *   import { type } from 'arktype';
 *
 *   const graph = toResourceGraph(
 *     { name: 'my-app', apiVersion: 'example.com/v1', kind: 'MyApp',
 *       spec: type({ replicas: 'number' }),
 *       status: type({ ready: 'boolean' }) },
 *     (schema) => ({
 *       deployment: createDeployment({ replicas: schema.spec.replicas }),
 *     }),
 *     (_schema, resources) => ({
 *       ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
 *     }),
 *   );
 *   ```
 *
 * - **{@link kubernetesComposition}** (imperative) - Define compositions
 *   using native TypeScript with proxy-based schema and resource references:
 *
 *   ```ts
 *   import { kubernetesComposition, createResource } from 'typekro';
 *   ```
 *
 * ## Module Layout
 *
 * The main `'typekro'` entry exports the most commonly used APIs:
 *
 *   1. ESSENTIAL - Core APIs every user needs (toResourceGraph, Cel, etc.)
 *   2. COMPOSITION - Imperative composition and runtime bootstrap
 *   3. DEPLOYMENT - Engines, readiness, and deployers
 *
 * Lower-level and specialized APIs are available via subpath imports:
 *
 *   ```ts
 *   // Ecosystem-specific factories
 *   import { helmRelease } from 'typekro/helm';
 *   import { simple } from 'typekro/simple';
 *
 *   // Alchemy framework integration
 *   import { DirectTypeKroDeployer } from 'typekro/alchemy';
 *
 *   // Internal/advanced APIs (logging, K8s client, errors, CEL evaluator, etc.)
 *   import { getComponentLogger, TypeKroError } from 'typekro/advanced';
 *   ```
 *
 * @packageDocumentation
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

export {
  type TypeKroRuntimeConfig,
  typeKroRuntimeBootstrap,
} from './compositions/typekro-runtime/index.js';
export { getCurrentCompositionContext } from './core/composition/context.js';
export {
  clearCompositionDebugLogs,
  disableCompositionDebugging,
  enableCompositionDebugging,
  getCompositionDebugLogs,
} from './core/composition/imperative.js';
export type { WebServiceComponent } from './core/composition/index.js';
export { createWebService } from './core/composition/index.js';

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
// 4–6: ADVANCED, ALCHEMY, INTERNALS — available via subpath imports
// =============================================================================
//
// Lower-level APIs have been moved to dedicated subpath exports to reduce the
// main entry point surface and improve IDE autocomplete:
//
//   import { ... } from 'typekro/alchemy';   // Alchemy framework integration
//   import { ... } from 'typekro/advanced';   // CEL evaluator, logging, K8s client,
//                                             // errors, dependency graph, utilities
