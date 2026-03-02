/**
 * Factory Functions Index
 *
 * This module provides the main entry point for all factory functions across
 * different ecosystems. Currently supports Kubernetes with future support
 * planned for Helm, Crossplane, ArgoCD, and Kustomize.
 */

// =============================================================================
// APISIX ECOSYSTEM
// =============================================================================
export * as apisix from './apisix/index.js';
// =============================================================================
// CERT-MANAGER ECOSYSTEM
// =============================================================================
export * as certManager from './cert-manager/index.js';
// =============================================================================
// CILIUM ECOSYSTEM
// =============================================================================
export * from './cilium/index.js';
// =============================================================================
// EXTERNAL-DNS ECOSYSTEM
// =============================================================================
export * as externalDns from './external-dns/index.js';
// =============================================================================
// FLUX CD ECOSYSTEM
// =============================================================================
export * from './flux/index.js';
export type {
  HelmReleaseConfig,
  HelmReleaseSpec,
  HelmReleaseStatus,
  HelmRepositoryConfig,
  HelmRepositorySpec,
  HelmRepositoryStatus,
} from './helm/index.js';
// =============================================================================
// HELM ECOSYSTEM
// =============================================================================
export {
  createComprehensiveHelmReadinessEvaluator,
  createHelmRevisionReadinessEvaluator,
  createHelmTestReadinessEvaluator,
  createHelmTimeoutReadinessEvaluator,
  helmRelease,
  helmReleaseReadinessEvaluator,
  helmRepository,
} from './helm/index.js';
// =============================================================================
// KRO ECOSYSTEM
// =============================================================================
export * from './kro/index.js';
// =============================================================================
// KUBERNETES ECOSYSTEM
// =============================================================================
export * from './kubernetes/index.js';
// =============================================================================
// PEBBLE ACME TEST SERVER ECOSYSTEM
// =============================================================================
export * as pebble from './pebble/index.js';
// NOTE: createResource, getCurrentCompositionContext, and CompositionContext
// are intentionally NOT re-exported here. They are exported from the canonical
// locations in src/index.ts to avoid duplicate export paths in IDE autocomplete.
// Factories import them internally via ./shared.js.
// =============================================================================
// SIMPLE NAMESPACE
// =============================================================================
export { simple } from './simple/index.js';
export type * from './simple/types.js';

// =============================================================================
// FUTURE ECOSYSTEMS (Placeholder structure created)
// =============================================================================
// Directory structure created for future ecosystems:
// - src/factories/crossplane/   (Future: Crossplane resource factories)
// - src/factories/argocd/       (Future: ArgoCD resource factories)
// - src/factories/kustomize/    (Future: Kustomize resource factories)
