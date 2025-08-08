/**
 * Shared Deployment Utilities
 * 
 * This module provides common utilities used across all deployment modes
 * to eliminate code duplication and ensure consistent behavior.
 */

import type { Enhanced } from '../types/kubernetes.js';
import type { DeploymentOptions, FactoryOptions } from '../types/deployment.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';

/**
 * Common spec validation logic used by all factories
 */
export function validateSpec<TSpec extends KroCompatibleType>(
    spec: TSpec,
    schemaDefinition: SchemaDefinition<TSpec, any>
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
        ...(factoryOptions.retryPolicy && { retryPolicy: factoryOptions.retryPolicy }),
        ...(factoryOptions.progressCallback && { progressCallback: factoryOptions.progressCallback }),
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
): Enhanced<any, any>['metadata'] {
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
    };
}

/**
 * Common error handling for deployment failures
 */
export function handleDeploymentError(error: unknown, context: string): never {
    if (error instanceof Error) {
        throw new Error(`${context}: ${error.message}`);
    }
    throw new Error(`${context}: ${String(error)}`);
}

/**
 * Common alchemy scope validation
 */
export function validateAlchemyScope(alchemyScope: any, context: string): void {
    if (!alchemyScope) {
        throw new Error(`${context}: Alchemy scope is required for alchemy deployment`);
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