/**
 * Shared Deployment Utilities
 *
 * This module provides common utilities used across all deployment modes
 * to eliminate code duplication and ensure consistent behavior.
 */

import type { DeploymentOptions, FactoryOptions } from '../types/deployment.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';

/**
 * Common spec validation logic used by all factories
 */
export function validateSpec<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  spec: TSpec,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>
): void {
  const validationResult = schemaDefinition.spec(spec);
  if (validationResult instanceof Error) {
    throw new Error(`Invalid spec: ${validationResult.message}`);
  }
}

/**
 * Generate deployment options from factory options
 */
export function createDeploymentOptions(
  factoryOptions: FactoryOptions,
  namespace: string,
  mode: 'direct' | 'kro' | 'alchemy' = 'direct'
): DeploymentOptions {
  return {
    mode,
    namespace,
    ...(factoryOptions.timeout && { timeout: factoryOptions.timeout }),
    waitForReady: factoryOptions.waitForReady ?? true,
    hydrateStatus: factoryOptions.hydrateStatus ?? true,
    ...(factoryOptions.retryPolicy && { retryPolicy: factoryOptions.retryPolicy }),
    ...(factoryOptions.progressCallback && { progressCallback: factoryOptions.progressCallback }),
    ...(factoryOptions.eventMonitoring && { eventMonitoring: factoryOptions.eventMonitoring }),
    ...(factoryOptions.debugLogging && { debugLogging: factoryOptions.debugLogging }),
  };
}

/**
 * Generate instance name from spec
 */
export function generateInstanceName<TSpec>(spec: TSpec): string {
  // Try to extract name from spec - check common name fields
  if (typeof spec === 'object' && spec !== null) {
    const specObj = spec as Record<string, unknown>;

    // Check for common name fields in order of preference
    for (const nameField of ['name', 'appName', 'serviceName', 'resourceName']) {
      if (nameField in specObj && specObj[nameField]) {
        return String(specObj[nameField]);
      }
    }
  }

  // Generate a unique name
  return `instance-${Date.now()}`;
}

/**
 * Create Enhanced proxy metadata
 */
export function createEnhancedMetadata(
  instanceName: string,
  namespace: string,
  factoryName: string,
  mode: 'direct' | 'kro'
): Enhanced<unknown, unknown>['metadata'] {
  return {
    name: instanceName,
    namespace,
    labels: {
      'typekro.io/factory': factoryName,
      'typekro.io/mode': mode,
    },
    annotations: {
      'typekro.io/deployed-at': new Date().toISOString(),
    },
  } as unknown as Enhanced<unknown, unknown>['metadata'];
}

/**
 * Common error handling for deployment failures
 */
export function handleDeploymentError(error: unknown, context: string): never {
  if (error instanceof Error) {
    // Use proper error chaining with cause property
    const enhancedError = new Error(`${context}: ${error.message}`);
    enhancedError.cause = error;
    if (error.stack) {
      enhancedError.stack = error.stack;
    }
    throw enhancedError;
  }
  throw new Error(`${context}: ${String(error)}`);
}

/**
 * Common alchemy scope validation
 */
export function validateAlchemyScope(alchemyScope: unknown, context: string): void {
  if (!alchemyScope) {
    throw new Error(`${context}: Alchemy scope is required for alchemy deployment`);
  }
  // Ensure the provided scope looks like a valid Alchemy scope (has a run function)
  const hasRunFunction = typeof (alchemyScope as { run?: unknown })?.run === 'function';
  if (!hasRunFunction) {
    throw new Error(`${context}: Alchemy scope is invalid (missing run function)`);
  }
}

/**
 * Create alchemy deployment options
 */
export function createAlchemyDeploymentOptions(
  factoryOptions: FactoryOptions,
  _namespace: string
): {
  waitForReady: boolean;
  timeout: number;
} {
  return {
    waitForReady: factoryOptions.waitForReady ?? true,
    timeout: factoryOptions.timeout ?? 300000,
  };
}
