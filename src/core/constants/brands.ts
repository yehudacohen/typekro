/**
 * Brand symbols for TypeKro internal types
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
