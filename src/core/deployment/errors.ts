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
  constructor(resourceName: string, resourceKind: string, cause: Error) {
    super(
      `Failed to deploy ${resourceKind}/${resourceName}: ${cause.message}`,
      'RESOURCE_DEPLOYMENT_ERROR',
      {
        resourceName,
        resourceKind,
        cause: cause.message,
      }
    );
    this.name = 'ResourceDeploymentError';
    this.cause = cause;
  }
}

/**
 * Error thrown when a resource already exists and conflictStrategy is 'fail'
 */
export class ResourceConflictError extends TypeKroError {
  public readonly resourceName: string;
  public readonly resourceKind: string;
  public readonly namespace: string | undefined;

  constructor(resourceName: string, resourceKind: string, namespace?: string | undefined) {
    const nsInfo = namespace ? ` in namespace '${namespace}'` : '';
    super(`Resource ${resourceKind}/${resourceName} already exists${nsInfo}`, 'RESOURCE_CONFLICT', {
      resourceName,
      resourceKind,
      namespace,
    });
    this.name = 'ResourceConflictError';
    this.resourceName = resourceName;
    this.resourceKind = resourceKind;
    this.namespace = namespace;
  }
}

export class ResourceReadinessTimeoutError extends TypeKroError {
  constructor(resource: DeployedResource, timeout: number) {
    super(
      `Timeout after ${timeout}ms waiting for ${resource.kind}/${resource.name} to be ready`,
      'RESOURCE_READINESS_TIMEOUT',
      { resourceKind: resource.kind, resourceName: resource.name, timeoutMs: timeout }
    );
    this.name = 'ResourceReadinessTimeoutError';
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
