/**
 * Brand symbols for TypeKro internal types
 *
 * These are the foundational brand constants used by both `src/utils/` and `src/core/`.
 * Placed in `src/shared/` to break the bidirectional dependency between those layers.
 *
 * Dependency direction: `shared/ <-- utils/ <-- core/`
 *
 * Using Symbol.for() ensures consistent brand checking across modules
 * and prevents property name collisions.
 */

/**
 * Brand symbol for KubernetesRef objects
 */
export const KUBERNETES_REF_BRAND = Symbol.for('TypeKro.KubernetesRef');

/**
 * Brand symbol for CelExpression objects
 */
export const CEL_EXPRESSION_BRAND = Symbol.for('TypeKro.CelExpression');

/**
 * Brand symbol for MixedTemplate objects
 */
export const MIXED_TEMPLATE_BRAND = Symbol.for('TypeKro.MixedTemplate');

/**
 * Brand symbol for NestedCompositionResource objects
 */
export const NESTED_COMPOSITION_BRAND = Symbol.for('TypeKro.NestedComposition');

/**
 * Brand symbol for CallableComposition objects
 */
export const CALLABLE_COMPOSITION_BRAND = Symbol.for('TypeKro.CallableComposition');

/**
 * Brand symbol for singleton handles.
 */
export const SINGLETON_HANDLE_BRAND = Symbol.for('TypeKro.SingletonHandle');

/**
 * Regex pattern for matching __KUBERNETES_REF__ marker strings in values.
 *
 * Format: __KUBERNETES_REF_{resourceId}_{fieldPath}__
 * - resourceId: marker-safe resource id with optional single `_` segments.
 *   This permits underscores in resource ids while preventing matches from
 *   consuming across the `__` marker terminator.
 * - fieldPath: dot-separated path with optional single `_` and `$` segments.
 *   Optional resource access uses Kro's `.?field` segment form.
 *   (e.g., 'status.ready', 'status.?loadBalancer', 'spec.workers.$item.name')
 * - Excludes __schema__ refs via negative lookahead
 *
 * This grammar is the single source of truth — all marker detection/resolution
 * code must use these constants to stay in sync. Callers must create their own
 * RegExp via `new RegExp(..., 'g')` to avoid stateful lastIndex issues with
 * the global flag.
 */
export const KUBERNETES_REF_MARKER_RESOURCE_ID_SOURCE = '[a-zA-Z0-9$-]+(?:_[a-zA-Z0-9$-]+)*';
export const KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE = '(?:spec|status|metadata|data)(?:(?:[.$]|\\.\\?)[a-zA-Z0-9$-]+(?:_[a-zA-Z0-9$-]+)*)*';
export const KUBERNETES_REF_MARKER_SOURCE = `__KUBERNETES_REF_(__schema__|${KUBERNETES_REF_MARKER_RESOURCE_ID_SOURCE})_(${KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE})__`;
export const KUBERNETES_REF_SCHEMA_MARKER_SOURCE = `__KUBERNETES_REF___schema___(${KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE})__`;
export const KUBERNETES_REF_MARKER_PATTERN = new RegExp(
  `(?:__KUBERNETES_REF_)(?!__schema__)(${KUBERNETES_REF_MARKER_RESOURCE_ID_SOURCE})_(${KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE})__`
);
