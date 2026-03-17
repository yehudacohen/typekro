/**
 * Deployment error classes
 *
 * Runtime error types for deployment operations, extracted from types/deployment.ts
 * to separate runtime classes from pure type definitions.
 */

import { TypeKroError } from '../errors.js';
import type { DeployedResource } from '../types/deployment.js';

// =============================================================================
// DEPLOYMENT ERROR CLASSES
// =============================================================================

export class ResourceDeploymentError extends TypeKroError {
  public readonly suggestions: string[];

  constructor(resourceName: string, resourceKind: string, cause: Error) {
    const suggestions = [
      `Check that the ${resourceKind} manifest is valid with 'kubectl apply --dry-run=client'`,
      `Verify the target namespace exists and you have permission to create ${resourceKind} resources`,
      `Review the cause: ${cause.message}`,
    ];
    super(
      `Failed to deploy ${resourceKind}/${resourceName}: ${cause.message}`,
      'RESOURCE_DEPLOYMENT_ERROR',
      {
        resourceName,
        resourceKind,
        cause: cause.message,
        suggestions,
      }
    );
    this.name = 'ResourceDeploymentError';
    this.cause = cause;
    this.suggestions = suggestions;
  }
}

/**
 * Error thrown when a resource already exists and conflictStrategy is 'fail'
 */
export class ResourceConflictError extends TypeKroError {
  public readonly resourceName: string;
  public readonly resourceKind: string;
  public readonly namespace: string | undefined;
  public readonly suggestions: string[];

  constructor(resourceName: string, resourceKind: string, namespace?: string | undefined) {
    const nsInfo = namespace ? ` in namespace '${namespace}'` : '';
    const suggestions = [
      `Set deploymentStrategy: 'replace' to update existing resources instead of failing`,
      `Set deploymentStrategy: 'skipIfExists' to silently skip existing resources`,
      `Delete the existing ${resourceKind}/${resourceName}${nsInfo} before redeploying`,
    ];
    super(`Resource ${resourceKind}/${resourceName} already exists${nsInfo}`, 'RESOURCE_CONFLICT', {
      resourceName,
      resourceKind,
      namespace,
      suggestions,
    });
    this.name = 'ResourceConflictError';
    this.resourceName = resourceName;
    this.resourceKind = resourceKind;
    this.namespace = namespace;
    this.suggestions = suggestions;
  }
}

export class ResourceReadinessTimeoutError extends TypeKroError {
  public readonly suggestions: string[];

  constructor(resource: DeployedResource, timeout: number) {
    const suggestions = [
      `Increase the timeout (currently ${timeout}ms) via DeploymentOptions.timeout`,
      `Check ${resource.kind}/${resource.name} status with 'kubectl describe ${resource.kind.toLowerCase()} ${resource.name}'`,
      `Review events with 'kubectl get events --field-selector involvedObject.name=${resource.name}'`,
      `Ensure dependent resources (ConfigMaps, Secrets, PVCs) are available`,
    ];
    super(
      `Timeout after ${timeout}ms waiting for ${resource.kind}/${resource.name} to be ready`,
      'RESOURCE_READINESS_TIMEOUT',
      {
        resourceKind: resource.kind,
        resourceName: resource.name,
        timeoutMs: timeout,
        suggestions,
      }
    );
    this.name = 'ResourceReadinessTimeoutError';
    this.suggestions = suggestions;
  }
}

export class UnsupportedMediaTypeError extends TypeKroError {
  constructor(resourceName: string, resourceKind: string, acceptedTypes: string[], cause: Error) {
    super(
      `Failed to deploy ${resourceKind}/${resourceName}: Server rejected request with HTTP 415 Unsupported Media Type. Accepted types: ${acceptedTypes.join(', ')}`,
      'UNSUPPORTED_MEDIA_TYPE',
      { resourceName, resourceKind, acceptedTypes, cause: cause.message }
    );
    this.name = 'UnsupportedMediaTypeError';
    this.cause = cause;
  }
}
