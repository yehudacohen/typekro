/**
 * Centralized environment variable configuration
 *
 * Provides helpers for environment checks that are used across multiple modules.
 * Logging and Kubernetes API env vars are intentionally NOT centralized here —
 * they are already well-organized in their own modules.
 */

/** @returns true if running in a test environment (NODE_ENV=test or VITEST=true) */
export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/** @returns true if TYPEKRO_DEBUG is enabled */
export function isDebugMode(): boolean {
  return process.env.TYPEKRO_DEBUG === 'true';
}
