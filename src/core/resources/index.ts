/**
 * Resource Utilities
 */

export type {
  DesiredResourceCanonicalizer,
  FactoryRegistration,
  LiveResourceCanonicalizer,
  ResourceComparisonSide,
} from './factory-registry.js';

export {
  clearFactoryRegistry,
  getFactoryRegistration,
  getFactoryRegistrationsForGVK,
  getKindInfo,
  getRegisteredFactoryCount,
  getRegisteredFactoryNames,
  getSemanticCandidateKinds,
  isKnownFactory,
  registerFactories,
  registerFactory,
} from './factory-registry.js';
export {
  canonicalizeResourceForComparison,
  compareKubernetesResources,
  diffCanonicalValues,
  formatCanonicalDrift,
  type CanonicalDriftDifference,
  type CanonicalDriftKind,
  type CanonicalDriftValueEvidence,
  type CanonicalResourceComparison,
  type CanonicalValueDiffOptions,
  type ComparisonCanonicalizerEvidence,
  type KubernetesResourceComparisonOptions,
} from './live-comparison.js';
export {
  generateDeterministicResourceId,
  generateResourceId,
  getResourceId,
} from './id.js';
