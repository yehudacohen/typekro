/**
 * Resource Utilities
 */

export type { FactoryRegistration } from './factory-registry.js';

export {
  clearFactoryRegistry,
  getFactoryRegistration,
  getKindInfo,
  getRegisteredFactoryCount,
  getRegisteredFactoryNames,
  getSemanticCandidateKinds,
  isKnownFactory,
  registerFactories,
  registerFactory,
} from './factory-registry.js';
export {
  generateDeterministicResourceId,
  generateResourceId,
  getResourceId,
} from './id.js';
