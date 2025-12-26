/**
 * Factory Functions Index
 *
 * This module provides the main entry point for all factory functions across
 * different ecosystems. Currently supports Kubernetes with future support
 * planned for Helm, Crossplane, ArgoCD, and Kustomize.
 */

// =============================================================================
// HELM ECOSYSTEM
// =============================================================================
export * from './helm/index.js';

// =============================================================================
// KRO ECOSYSTEM
// =============================================================================
export * from './kro/index.js';
// =============================================================================
// KUBERNETES ECOSYSTEM
// =============================================================================
export * from './kubernetes/index.js';
export type { CompositionContext } from './shared.js';
// =============================================================================
// SHARED UTILITIES
// =============================================================================
export { createResource, getCurrentCompositionContext } from './shared.js';
// =============================================================================
// SIMPLE NAMESPACE
// =============================================================================
export { simple } from './simple/index.js';
export type * from './simple/types.js';

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
// PEBBLE ACME TEST SERVER ECOSYSTEM
// =============================================================================
export * as pebble from './pebble/index.js';

// =============================================================================
// FUTURE ECOSYSTEMS (Placeholder structure created)
// =============================================================================
// Directory structure created for future ecosystems:
// - src/factories/crossplane/   (Future: Crossplane resource factories)
// - src/factories/argocd/       (Future: ArgoCD resource factories)
// - src/factories/kustomize/    (Future: Kustomize resource factories)
