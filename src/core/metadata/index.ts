/**
 * Resource Metadata Store
 *
 * Re-exports all public functions and types from the resource metadata module.
 *
 * @module
 */
export {
  clearResourceMetadata,
  copyResourceMetadata,
  getForEach,
  getIncludeWhen,
  getMetadataField,
  getReadinessEvaluator,
  getReadyWhen,
  getResourceId,
  getResourceMetadata,
  getTemplateOverrides,
  hasResourceMetadata,
  type ResourceMetadata,
  type ResourceMetadataKey,
  setForEach,
  setIncludeWhen,
  setMetadataField,
  setReadinessEvaluator,
  setReadyWhen,
  setResourceId,
  setResourceMetadata,
  setTemplateOverrides,
} from './resource-metadata.js';
