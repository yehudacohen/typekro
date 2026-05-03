/**
 * typekro - Define Kro resource graphs with full TypeScript safety.
 *
 * ## Getting Started
 *
 * TypeKro provides two composition APIs. Both produce the same output and support
 * the same deployment modes (`direct` and `kro`).
 *
 * ### Recommended: {@link kubernetesComposition}
 *
 * Single function creates resources and returns status. Status expressions are
 * natural JavaScript, auto-converted to CEL:
 *
 * ```ts
 * import { kubernetesComposition, simple } from 'typekro';
 * import { type } from 'arktype';
 *
 * const app = kubernetesComposition(
 *   { name: 'my-app', apiVersion: 'example.com/v1', kind: 'MyApp',
 *     spec: type({ replicas: 'number', image: 'string' }),
 *     status: type({ ready: 'boolean' }) },
 *   (spec) => {
 *     const deploy = simple.Deployment({
 *       id: 'deploy', name: 'my-app', image: spec.image, replicas: spec.replicas,
 *     });
 *     return { ready: deploy.status.readyReplicas >= spec.replicas };
 *   },
 * );
 * ```
 *
 * ### Advanced: {@link toResourceGraph}
 *
 * Separate resource builder and status builder with explicit CEL expressions:
 *
 * ```ts
 * import { toResourceGraph, Cel, createDeployment } from 'typekro';
 * import { type } from 'arktype';
 *
 * const graph = toResourceGraph(
 *   { name: 'my-app', apiVersion: 'example.com/v1', kind: 'MyApp',
 *     spec: type({ replicas: 'number' }),
 *     status: type({ ready: 'boolean' }) },
 *   (schema) => ({
 *     deployment: createDeployment({ replicas: schema.spec.replicas }),
 *   }),
 *   (_schema, resources) => ({
 *     ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0'),
 *   }),
 * );
 * ```
 *
 * ## Which API should I use?
 *
 * | | `kubernetesComposition` | `toResourceGraph` |
 * |---|---|---|
 * | **Recommended for** | Most applications (default) | Explicit CEL control |
 * | **Status expressions** | Natural JavaScript (auto-converted to CEL) | Explicit `Cel.expr()` / `Cel.template()` |
 * | **Resource factories** | `simple.Deployment()`, `simple.Service()` | `createDeployment()`, `createService()` |
 * | **Cross-resource refs** | `deploy.status.readyReplicas` (magic proxy) | `resources.deploy.status.readyReplicas` |
 * | **Conditional resources** | `if`/`else` in composition function | `includeWhen` on individual resources |
 * | **Schema validation** | Built-in via arktype | Built-in via arktype |
 *
 * **Rule of thumb:** Start with `kubernetesComposition`. Switch to `toResourceGraph`
 * only if you need explicit CEL control or prefer separated concerns.
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

// Aspect helpers for typed resource customization
export {
  AspectApplicationError,
  AspectDefinitionError,
  allResources,
  append,
  aspect,
  hotReload,
  merge,
  metadata,
  override,
  replace,
  resources,
  slot,
  workloads,
} from './core/aspects/index.js';
export type { HotReloadAspectOptions, HotReloadContainer, HotReloadVolume } from './core/aspects/index.js';
export type {
  AppendOperation,
  ApplyAspectsOptions,
  AspectBuilder,
  AspectCardinality,
  AspectDefinition,
  AspectDiagnosticsPolicy,
  AspectFactoryTarget,
  AspectFactoryTargetBrand,
  AspectFactoryTargetFunction,
  AspectFieldPath,
  AspectMode,
  AspectOperation,
  AspectOperationKind,
  AspectOverridePatch,
  AspectOverrideSchemaForTarget,
  AspectPatchValue,
  AspectSafetyContext,
  AspectSelector,
  AspectSurface,
  AspectSurfaceForCommonKinds,
  AspectSurfaceForTarget,
  AspectSurfaceKind,
  AspectSurfaceKindForTarget,
  AspectTarget,
  AspectTargetGroup,
  AspectValidationPolicy,
  CommonAspectSchema,
  CommonAspectSchemaForTargets,
  CommonAspectSchemaKeys,
  CommonAspectSchemaValue,
  CommonAspectSurfaceForTargets,
  CommonAspectSurfaceKindForTargets,
  CompatibleAspectTargets,
  FactoryAspectTargetDescriptor,
  ImagePullPolicy,
  MergeOperation,
  MetadataAspectSurface,
  OverrideAspectSurface,
  ReplaceOperation,
  ResourceAspectFactoryTarget,
  ResourceAspectMetadata,
  ResourceSpecOverrideSchema,
  ToYamlOptions,
  WorkloadAspectFactoryTarget,
} from './core/aspects/types.js';
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
export { singleton } from './core/singleton/singleton.js';
export type {
  ResolutionContext,
  SingletonHandle,
  SingletonOwnedHandle,
  SingletonReferenceHandle,
} from './core/types/deployment.js';
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
  type RbacMode,
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
export { CompositionDebugger } from './core/composition-debugger.js';
export type { WebServiceComponent } from './factories/simple/compositions/web-service.js';
export { createWebService } from './factories/simple/compositions/web-service.js';

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
