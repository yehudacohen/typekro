/**
 * Typed resource aspects for applying validated metadata and spec overrides to
 * TypeKro resources at render/factory time.
 *
 * Target groups: `allResources` accepts `metadata(...)` for every rendered
 * resource. `resources` accepts `override(...)` for every rendered resource with
 * a structured `spec`. Factory functions such as `simple.Deployment` are used as
 * kind/capability tokens, not strict provenance tokens: a Deployment target can
 * match Deployment-producing factories that advertise compatible aspect
 * metadata. Use `slot(...)` and `.where(...)` for exact semantic targeting.
 * Runtime validation remains best-effort for optional fields absent from the
 * initial manifest.
 *
 * Selectors use AND semantics across `slot`, `id`, `name`, `namespace`, `kind`,
 * and `labels`. By default an aspect requires one-or-more matches; `.optional()`
 * allows zero matches and `.expectOne()` requires exactly one match.
 *
 * Operation legality is schema-derived: `replace(...)` is valid for advertised
 * scalar, object, and array fields; `merge(...)` is valid for advertised object
 * fields; `append(...)` is valid for advertised array fields. Kro mode rejects
 * `merge(...)` and `append(...)` when either the current composite field or the
 * operation payload contains Kubernetes refs or CEL expressions.
 */
export { AspectApplicationError, applyAspects } from './apply.js';
export { hotReload, withHotReload, withLocalWorkspace } from './dev-aspects.js';
export { withAnnotations, withLabels, withMetadata } from './metadata-aspects.js';
export {
  allResources,
  append,
  aspect,
  merge,
  metadata,
  override,
  replace,
  resources,
  slot,
  workloads,
} from './primitives.js';
export { AspectDefinitionError } from './types.js';
export type * from './types.js';
export {
  withEnvFrom,
  withEnvVars,
  withImagePullPolicy,
  withReplicas,
  withResourceDefaults,
  withServiceAccount,
} from './workload-aspects.js';
