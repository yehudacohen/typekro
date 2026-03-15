/**
 * Shared Deployment Utilities
 *
 * This module provides common utilities used across all deployment modes
 * to eliminate code duplication and ensure consistent behavior.
 */

import { ResourceGraphFactoryError, TypeKroError, ValidationError } from '../errors.js';
import type { DeploymentOptions, FactoryOptions } from '../types/deployment.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';

/**
 * Common spec validation logic used by all factories.
 *
 * @param spec - The spec to validate
 * @param schemaDefinition - The schema definition to validate against
 * @param context - Optional context for more informative error messages
 * @param context.kind - The Kubernetes kind (e.g. 'WebApp')
 * @param context.name - The resource name (e.g. 'my-webapp')
 */
export function validateSpec<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  spec: TSpec,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  context?: { kind?: string; name?: string }
): void {
  const validationResult = schemaDefinition.spec(spec);
  if (validationResult instanceof Error) {
    throw new ValidationError(
      `Invalid spec: ${validationResult.message}`,
      context?.kind ?? 'Unknown',
      context?.name ?? 'unknown',
      'spec',
      context ? ['Check the spec against the schema definition'] : undefined
    );
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
    ...(factoryOptions.autoFix && { autoFix: factoryOptions.autoFix }),
  };
}

/**
 * Generate instance name from spec by checking common name fields.
 *
 * @param spec - The spec object to extract a name from
 * @param fallbackPrefix - Optional prefix for the fallback name (default: 'instance')
 * @returns The extracted or generated instance name
 */
export function generateInstanceName<TSpec>(spec: TSpec, fallbackPrefix = 'instance'): string {
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
  return `${fallbackPrefix}-${Date.now()}`;
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
    throw new ResourceGraphFactoryError(
      `${context}: ${error.message}`,
      context,
      'deployment',
      error
    );
  }
  throw new ResourceGraphFactoryError(`${context}: ${String(error)}`, context, 'deployment');
}

/**
 * Common alchemy scope validation
 */
export function validateAlchemyScope(alchemyScope: unknown, context: string): void {
  if (!alchemyScope) {
    throw new TypeKroError(
      `${context}: Alchemy scope is required for alchemy deployment`,
      'MISSING_ALCHEMY_SCOPE',
      { context }
    );
  }
  // Ensure the provided scope looks like a valid Alchemy scope (has a run function)
  const hasRunFunction = typeof (alchemyScope as { run?: unknown })?.run === 'function';
  if (!hasRunFunction) {
    throw new TypeKroError(
      `${context}: Alchemy scope is invalid (missing run function)`,
      'INVALID_ALCHEMY_SCOPE',
      { context }
    );
  }
}

/**
 * Convert a camelCase or PascalCase name to a valid Kubernetes resource name (kebab-case).
 *
 * Validates the result against Kubernetes naming rules:
 * - Lowercase alphanumeric characters or '-'
 * - Must start and end with an alphanumeric character
 * - Maximum 253 characters
 *
 * @param name - The name to convert (e.g. 'myWebApp' → 'my-web-app')
 * @returns A valid Kubernetes resource name in kebab-case
 * @throws ValidationError if the input is empty or the result is not a valid Kubernetes name
 */
export function convertToKubernetesName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new ValidationError(
      `Invalid resource name: ${JSON.stringify(name)}. Name must be a non-empty string.`,
      'KubernetesResource',
      String(name),
      'name',
      ['Provide a non-empty string for the resource name']
    );
  }

  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ValidationError(
      'Invalid resource name: Name cannot be empty or whitespace-only.',
      'KubernetesResource',
      name,
      'name',
      ['Provide a non-whitespace resource name']
    );
  }

  // Convert to kebab-case and validate result
  const kubernetesName = trimmedName
    .replace(/([a-z])([A-Z])/g, '$1-$2') // Insert dash before capital letters
    .toLowerCase();

  // Validate Kubernetes naming conventions
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
    throw new ValidationError(
      `Invalid resource name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
      'KubernetesResource',
      name,
      'name',
      [
        'Use lowercase alphanumeric characters and hyphens only',
        'Must start and end with an alphanumeric character',
      ]
    );
  }

  if (kubernetesName.length > 253) {
    throw new ValidationError(
      `Invalid resource name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`,
      'KubernetesResource',
      name,
      'name',
      ['Shorten the resource name to stay under 253 characters']
    );
  }

  return kubernetesName;
}

/**
 * Pluralize a Kubernetes Kind name following standard English pluralization rules.
 *
 * This is used to construct CRD resource names (e.g. `webapps.kro.run` from kind `WebApp`).
 * The function lowercases the kind before pluralizing.
 *
 * @param kind - The Kubernetes Kind to pluralize (e.g. 'Deployment' → 'deployments')
 * @returns The pluralized, lowercased kind name
 */
export function pluralizeKind(kind: string): string {
  const lowerKind = kind.toLowerCase();

  // Handle common English pluralization rules that Kubernetes follows
  if (
    lowerKind.endsWith('s') ||
    lowerKind.endsWith('sh') ||
    lowerKind.endsWith('ch') ||
    lowerKind.endsWith('x') ||
    lowerKind.endsWith('z')
  ) {
    return `${lowerKind}es`;
  } else if (lowerKind.endsWith('o')) {
    return `${lowerKind}es`;
  } else if (
    lowerKind.endsWith('y') &&
    lowerKind.length > 1 &&
    !'aeiou'.includes(lowerKind[lowerKind.length - 2] || '')
  ) {
    return `${lowerKind.slice(0, -1)}ies`;
  } else if (lowerKind.endsWith('f')) {
    return `${lowerKind.slice(0, -1)}ves`;
  } else if (lowerKind.endsWith('fe')) {
    return `${lowerKind.slice(0, -2)}ves`;
  } else {
    return `${lowerKind}s`;
  }
}
