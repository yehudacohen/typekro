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
 * - resourceId: camelCase with optional hyphens/digits (e.g., 'database', 'inngestBootstrap1')
 *   Hyphens are allowed for backward compatibility with older ID formats, though
 *   current convention enforces camelCase (toCamelCase in executeNestedCompositionWithSpec).
 * - fieldPath: dot-separated path with optional $ for iteration (e.g., 'status.ready', 'spec.workers.$item.name')
 * - Excludes __schema__ refs via negative lookahead
 *
 * This pattern is the single source of truth — all marker detection/resolution
 * code must use this constant to stay in sync. Callers must create their own
 * RegExp via `new RegExp(KUBERNETES_REF_MARKER_PATTERN.source, 'g')` to avoid
 * stateful lastIndex issues with the global flag.
 */
export const KUBERNETES_REF_MARKER_PATTERN = /(?:__KUBERNETES_REF_)(?!_schema__)([a-zA-Z0-9-]+)_([a-zA-Z0-9.$]+)__/;
