/**
 * Flux CD Factory Functions
 *
 * This module provides factory functions for Flux CD resources including
 * GitRepository, Kustomization, and other Flux CD components.
 */

// Source resources
export { gitRepository } from './git-repository.js';
export type { GitRepositoryConfig } from './git-repository.js';

// Kustomization resources
export * from './kustomize/index.js';
