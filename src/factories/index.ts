/**
 * Factory Functions Index
 * 
 * This module provides the main entry point for all factory functions across
 * different ecosystems. Currently supports Kubernetes with future support
 * planned for Helm, Crossplane, ArgoCD, and Kustomize.
 */


// =============================================================================
// KUBERNETES ECOSYSTEM
// =============================================================================
export * from './kubernetes/index.js';

// =============================================================================
// KRO ECOSYSTEM
// =============================================================================
export * from './kro/index.js';
// =============================================================================
// SHARED UTILITIES
// =============================================================================
export { createResource, processPodSpec } from './shared.js';

// =============================================================================
// FUTURE ECOSYSTEMS (Placeholder structure created)
// =============================================================================
// Directory structure created for future ecosystems:
// - src/factories/helm/         (Future: Helm chart factories)
// - src/factories/crossplane/   (Future: Crossplane resource factories)  
// - src/factories/argocd/       (Future: ArgoCD resource factories)
// - src/factories/kustomize/    (Future: Kustomize resource factories)
