/**
 * Resource Metadata Store
 *
 * Re-exports all public functions and types from the resource metadata module.
 *
 * @module
 */
export {
  applyResourceScopeMetadata,
  clearResourceMetadata,
  copyResourceMetadata,
  getForEach,
  getIncludeWhen,
  getMetadataField,
  getReadinessEvaluator,
  getReadyWhen,
  getResourceId,
  getResourceMetadata,
  getResourceScope,
  getTemplateOverrides,
  hasResourceMetadata,
  type ResourceMetadata,
  type ResourceMetadataKey,
  type ResourceScope,
  setForEach,
  setIncludeWhen,
  setMetadataField,
  setReadinessEvaluator,
  setReadyWhen,
  setResourceId,
  setResourceMetadata,
  setTemplateOverrides,
} from './resource-metadata.js';
