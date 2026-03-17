/**
 * Core Utilities
 *
 * Provides utility functions for CRD schema fixes and patching.
 */

export { crdNeedsSchemaFix, patchCRDSchema, patchFluxCRDSchemas } from './crd-patcher.js';
export { fixCRDSchemaForK8s133, fixCRDSchemasForK8s133 } from './crd-schema-fix.js';
