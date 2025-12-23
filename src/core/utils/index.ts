/**
 * Core Utilities
 *
 * Provides utility functions for CRD schema fixes, error handling, and other
 * common operations.
 */

export { fixCRDSchemaForK8s133, fixCRDSchemasForK8s133 } from './crd-schema-fix.js';
export { patchCRDSchema, patchFluxCRDSchemas, crdNeedsSchemaFix } from './crd-patcher.js';
export {
  withMinimalConnectionResetSuppression,
  withMinimalConnectionResetSuppressionSync,
} from './minimal-connection-reset-suppression.js';
export {
  installConnectionResetOutputFilter,
  removeConnectionResetOutputFilter,
} from './output-filter.js';
export {
  withConnectionResetSuppression,
  withConnectionResetSuppressionSync,
  installFinalCleanupHandler,
  removeFinalCleanupHandler,
} from './scoped-error-suppression.js';
