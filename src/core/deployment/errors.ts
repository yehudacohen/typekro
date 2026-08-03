/**
 * Deployment error classes
 *
 * Runtime error types for deployment operations, extracted from types/deployment.ts
 * to separate runtime classes from pure type definitions.
 */

import { TypeKroError } from '../errors.js';
import type {
  DeletionResourceIdentity,
  DeployedResource,
  ResourceDeletionResult,
} from '../types/deployment.js';

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

/** A server-side apply field-ownership conflict that must not degrade to legacy 409 handling. */
export class ServerSideApplyConflictError extends TypeKroError {
  constructor(
    resourceName: string,
    resourceKind: string,
    fieldManager: string,
    fieldConflictPolicy: 'fail' | 'force-owned-fields',
    cause: Error
  ) {
    super(
      `Server-side apply conflict for ${resourceKind}/${resourceName} using field manager ${fieldManager}: ${cause.message}`,
      'SERVER_SIDE_APPLY_CONFLICT',
      {
        resourceName,
        resourceKind,
        fieldManager,
        fieldConflictPolicy,
        cause: cause.message,
        suggestions:
          fieldConflictPolicy === 'fail'
            ? [
                'Inspect metadata.managedFields to identify the conflicting manager',
                "Use fieldConflictPolicy: 'force-owned-fields' only when TypeKro should take ownership",
              ]
            : [
                'Inspect the API-server conflict details; forced apply could not safely acquire the field',
              ],
      }
    );
    this.name = 'ServerSideApplyConflictError';
    this.cause = cause;
  }
}

/** Replacement cannot proceed until Kubernetes confirms that the old object is absent. */
export class ResourceReplacementTimeoutError extends TypeKroError {
  constructor(
    resourceName: string,
    resourceKind: string,
    timeout: number,
    public readonly resource?: DeletionResourceIdentity
  ) {
    const namespacePrefix = resource?.namespace ? `${resource.namespace}/` : '';
    const uid = resource?.uid ? ` UID ${resource.uid}` : '';
    const deletionTimestamp = resource?.deletionTimestamp
      ? ` deletion requested at ${resource.deletionTimestamp}`
      : '';
    const finalizers = resource?.finalizers?.length
      ? ` blocking finalizers: ${resource.finalizers.join(', ')}`
      : '';
    const owners = resource?.owners?.length
      ? ` owners: ${resource.owners
          .map(
            (owner) =>
              `${owner.apiVersion}/${owner.kind} ${owner.name}${owner.uid ? ` (${owner.uid})` : ''}`
          )
          .join(', ')}`
      : '';
    super(
      `Timeout after ${timeout}ms waiting to replace ${resourceKind}/${namespacePrefix}${resourceName}; ` +
        `the previous object still exists.${uid}${deletionTimestamp}${finalizers}${owners}`,
      'RESOURCE_REPLACEMENT_TIMEOUT',
      {
        resourceName,
        resourceKind,
        timeoutMs: timeout,
        ...(resource ? { resource } : {}),
        suggestions: [
          `Inspect ${resourceKind}/${namespacePrefix}${resourceName} for deletionTimestamp and blocking finalizers`,
          'Increase DeploymentOptions.timeout if deletion is making legitimate progress',
        ],
      }
    );
    this.name = 'ResourceReplacementTimeoutError';
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

/**
 * Raised by execution-host adapters when TypeKro cannot yet prove deletion complete.
 *
 * Standalone factories return {@link ResourceDeletionResult} directly. Hosts whose delete
 * callbacks cannot return an operation result, such as Alchemy, receive this error so they can
 * persist/retry the operation without losing TypeKro's Kubernetes-specific blocker evidence.
 */
export class ResourceDeletionIncompleteError extends TypeKroError {
  constructor(public readonly result: ResourceDeletionResult) {
    const blockerSummary = result.blockers
      .map((blocker) => `${blocker.code}: ${blocker.message}`)
      .join('; ');
    super(
      `Deletion of ${result.mode} instance ${result.factoryName}/${result.instanceName} is ${result.status}${blockerSummary ? ` (${blockerSummary})` : ''}`,
      'RESOURCE_DELETION_INCOMPLETE',
      { result }
    );
    this.name = 'ResourceDeletionIncompleteError';
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
