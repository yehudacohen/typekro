export { createAspectManifest, type AspectManifestResult } from './aspects.js';
export {
  ArtifactPlanDecodeError,
  decodeArtifactPlan,
  decodeDirectArtifactResource,
  decodeDirectArtifactPlan,
  decodeKroArtifactResource,
  decodeKroArtifactPlan,
  encodeArtifactPlan,
} from './artifact-codec.js';
export { ARTIFACT_PLAN_VERSION } from './artifacts.js';
export type * from './artifacts.js';
export { canonicalDigest, CanonicalizationError, canonicalStringify } from './canonical.js';
export {
  adapterCapabilityDiagnostics,
  ArtifactCapabilityError,
  assertAdapterCapabilitiesSupported,
  targetCapabilityDiagnostics,
  type ArtifactCapabilityContext,
} from './capabilities.js';
export {
  copyCompositionCapture,
  getCompositionCapture,
  setCompositionCapture,
  type CapturedCompositionRuntime,
} from './capture.js';
export {
  ArtifactCompilationError,
  compileDirectArtifactPlan,
  compileKroArtifactPlan,
} from './compiler.js';
export {
  directArtifactPlanToResourceGraph,
  DirectArtifactRuntimeAdapterError,
  materializeDirectArtifactManifest,
  type DirectArtifactRuntimeAdapterOptions,
} from './direct-runtime-adapter.js';
export {
  createDirectArtifactExecutionMaterialization,
  createDirectArtifactExecutionRecord,
  decodeDirectArtifactExecutionRecord,
  DirectArtifactExecutionRecordError,
  encodeDirectArtifactExecutionRecord,
  type DirectArtifactExecutionMaterialization,
} from './execution-record.js';
export {
  collectPlanValueSensitiveBindings,
  mapPlanValueSensitiveBindings,
  materializePlanValue,
  materializePlanValueForKro,
  planValueContainsSensitiveValue,
  planValueSensitiveBindingNames,
  PlanMaterializationError,
  resolveStaticYamlSensitiveBindings,
  type PlanMaterializationBindings,
  type StaticYamlMaterializationOptions,
} from './materialization.js';
export {
  createKroArtifactBundle,
  decodeKroArtifactBundle,
  encodeKroArtifactBundle,
  KroArtifactBundleError,
  materializeKroArtifactBundleOperation,
  mergeKroArtifactBundleOperations,
  orderKroArtifactBundleOperations,
} from './kro-bundle.js';
export {
  kroArtifactPlanToInstanceResource,
  kroArtifactPlanToGraphResources,
  kroArtifactPlanToSupportingResources,
  KroArtifactRuntimeAdapterError,
  type KroSupportingArtifactMaterializationOptions,
  type MaterializedKroSupportingArtifact,
} from './kro-runtime-adapter.js';
export {
  inspectCapturedComposition,
  planCapturedComposition,
  planCapturedTemplate,
  planMaterializedComposition,
  SemanticPlanningError,
} from './planner.js';
export {
  decodeDesiredStatePlan,
  DesiredStatePlanDecodeError,
  encodeDesiredStatePlan,
} from './plan-codec.js';
export { encodeSchemaIR, schemaToIR } from './schema.js';
export { SEMANTIC_PLAN_VERSION } from './types.js';
export type * from './types.js';
export {
  artifactOutput,
  decodePlanValue,
  emitExpressionCel,
  encodePlanValue,
  evaluateExpressionIR,
  expressionIR,
  externalInput,
  lowerPlanValue,
  planExpression,
  sensitiveValue,
} from './values.js';
