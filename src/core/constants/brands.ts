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
 * Type-safe brand checking utilities
 */
export const BrandChecks = {
  /**
   * Check if an object has the KubernetesRef brand
   */
  isKubernetesRef(obj: unknown): obj is { [KUBERNETES_REF_BRAND]: true } {
    return Boolean(
      obj &&
      (typeof obj === 'object' || typeof obj === 'function') &&
      obj !== null &&
      KUBERNETES_REF_BRAND in obj
    );
  },

  /**
   * Check if an object has the CelExpression brand
   */
  isCelExpression(obj: unknown): obj is { [CEL_EXPRESSION_BRAND]: true } {
    return Boolean(
      obj &&
      typeof obj === 'object' &&
      obj !== null &&
      CEL_EXPRESSION_BRAND in obj
    );
  },

  /**
   * Check if an object has the MixedTemplate brand
   */
  isMixedTemplate(obj: unknown): obj is { [MIXED_TEMPLATE_BRAND]: true } {
    return Boolean(
      obj &&
      typeof obj === 'object' &&
      obj !== null &&
      MIXED_TEMPLATE_BRAND in obj
    );
  }
};