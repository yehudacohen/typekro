/**
 * Core Factory - Legacy factory functions (to be moved to organized structure)
 *
 * This file contains the old factory functions that should be moved to the new
 * organized structure in src/factories/. It's kept temporarily for backward compatibility.
 *
 * @deprecated Use the organized factory functions from src/factories/ instead
 */

// Re-export all factory functions from the organized structure
export * from '../factories/index.js';
// Re-export the shared utilities from the new location
export { createResource } from '../factories/shared.js';
// Re-export types from the centralized location
export type * from './types/kubernetes.js';
