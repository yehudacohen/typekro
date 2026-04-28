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
  KUBERNETES_REF_MARKER_FIELD_PATH_SOURCE,
  KUBERNETES_REF_MARKER_PATTERN,
  KUBERNETES_REF_MARKER_RESOURCE_ID_SOURCE,
  KUBERNETES_REF_MARKER_SOURCE,
  KUBERNETES_REF_SCHEMA_MARKER_SOURCE,
  MIXED_TEMPLATE_BRAND,
  NESTED_COMPOSITION_BRAND,
  SINGLETON_HANDLE_BRAND,
} from '../../shared/brands.js';
