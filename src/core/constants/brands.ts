/**
 * Brand symbols for TypeKro internal types
 *
 * Re-exported from `src/shared/brands.ts` for backward compatibility.
 * New code within `src/utils/` should import directly from `../../shared/brands.js`
 * to maintain the clean dependency direction: `shared/ <-- utils/ <-- core/`.
 */
export {
  CALLABLE_COMPOSITION_BRAND,
  CEL_EXPRESSION_BRAND,
  KUBERNETES_REF_BRAND,
  MIXED_TEMPLATE_BRAND,
  NESTED_COMPOSITION_BRAND,
} from '../../shared/brands.js';
