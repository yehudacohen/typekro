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

// Export dynamic registration implementation
export * from './deployment.js';