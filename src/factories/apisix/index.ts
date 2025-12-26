/**
 * APISix Ingress Controller Factory
 * 
 * Provides TypeKro compositions for deploying APISix ingress controller
 * following the same patterns as cert-manager and external-dns factories.
 */

export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export { mapAPISixConfigToHelmValues as mapAPISixBootstrapConfigToHelmValues, validateAPISixHelmValues } from './utils/index.js';