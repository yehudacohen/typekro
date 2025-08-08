/**
 * Direct Deployment Engine - Backward Compatibility Bridge
 *
 * This file provides backward compatibility by re-exporting from the new deployment module.
 * TODO: Remove this file once all imports have been updated to use the new module structure.
 */

// Re-export everything from the new deployment module
export * from './deployment/index.js';
