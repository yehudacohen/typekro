/**
 * Alchemy Integration Module
 *
 * This module provides integration with the Alchemy framework for deploying
 * and managing TypeKro resources and Kro ResourceGraphDefinitions.
 * 
 * Uses dynamic resource registration to avoid "Resource already exists" errors.
 */

// Export utility functions that align with the spec
export * from './wrapper.js';
export * from './resolver.js';

// Export main deployment functionality
export * from './deployment.js';

// Export focused modules
export * from './types.js';
export * from './resource-registration.js';
export * from './type-inference.js';
export * from './deployers.js';
export * from './utilities.js';