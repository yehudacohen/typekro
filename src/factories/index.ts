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
// FUTURE ECOSYSTEMS (Placeholder structure created)
// =============================================================================
// Directory structure created for future ecosystems:
// - src/factories/cilium/       (Next release: Cilium CNI and networking ecosystem)
// - src/factories/crossplane/   (Future: Crossplane resource factories)
// - src/factories/argocd/       (Future: ArgoCD resource factories)
// - src/factories/kustomize/    (Future: Kustomize resource factories)
