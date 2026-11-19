/**
 * Flux CD Factory Functions
 *
 * This module provides factory functions for Flux CD resources including
 * GitRepository, Kustomization, and other Flux CD components.
 */

export type { GitRepositoryConfig } from './git-repository.js';
// Source resources
export { gitRepository } from './git-repository.js';
// Install manifests of a pinned Flux release
export * from './install/index.js';
// Kustomization resources
export * from './kustomize/index.js';
