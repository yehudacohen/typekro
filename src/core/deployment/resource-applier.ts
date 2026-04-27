/**
 * Resource Applier
 *
 * Handles the mechanics of applying Kubernetes resources to a cluster:
 * serialization, namespace application, patch construction, conflict resolution,
 * existence checking, reference resolution, and the main apply-with-retry loop.
 *
 * Extracted from DirectDeploymentEngine to separate resource-level K8s
 * operations from orchestration concerns.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_BACKOFF_MULTIPLIER,
  DEFAULT_CONFLICT_RETRY_DELAY,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_DELAY,
  DEFAULT_READINESS_TIMEOUT,
} from '../config/defaults.js';
import { ensureError } from '../errors.js';
import type { TypeKroLogger } from '../logging/index.js';
import {
  copyResourceMetadata,
  getMetadataField,
  getReadinessEvaluator,
} from '../metadata/index.js';
import type { ReferenceResolver } from '../references/index.js';
import type { DeploymentOptions, ResolutionContext } from '../types/deployment.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KubernetesApiError,
  KubernetesResource,
} from '../types.js';
import {
  ResourceConflictError,
  ResourceDeploymentError,
  UnsupportedMediaTypeError,
} from './errors.js';
import {
  extractAcceptedMediaTypes,
  isUnsupportedMediaTypeError,
  patchResourceWithCorrectContentType,
} from './k8s-helpers.js';
import { applyTypekroTags, getEffectiveScopes } from './resource-tagging.js';

export class ResourceApplier {
  constructor(
    private k8sApi: k8s.KubernetesObjectApi,
    private referenceResolver: ReferenceResolver,
    _logger: TypeKroLogger
  ) {}

  private buildResourceIdentityMetadata(resource: KubernetesResource): {
    name: string;
    namespace?: string;
  } {
    const name = resource.metadata?.name || '';
    if (getMetadataField(resource as object, 'scope') === 'cluster') {
      return { name };
    }
    return { name, namespace: resource.metadata?.namespace || 'default' };
  }

  /**
   * Serialize a resource for sending to the Kubernetes API.
   * Calls toJSON() if available (to preserve arrays via custom implementation),
   * then deep-clones via JSON to strip proxy wrappers, and removes internal fields.
   */
  serializeResourceForK8s(
    resource: KubernetesResource | Partial<KubernetesResource>
  ): Record<string, unknown> {
    const toJSON = (resource as KubernetesResource).toJSON;
    const jsonResource = typeof toJSON === 'function' ? toJSON.call(resource) : resource;

    // Deep clone to remove any proxy wrappers that might cause serialization issues
    const cleanResource: Record<string, unknown> = JSON.parse(JSON.stringify(jsonResource));

    // Strip internal TypeKro fields that should not be sent to Kubernetes
    // The 'id' field is used internally for resource mapping but is not a valid K8s field
    delete cleanResource.id;

    return cleanResource;
  }

  /**
   * Resolve all references in a resource, with timeout and fallback behavior.
   * Falls back to the original resource if resolution fails.
   */
  async resolveResourceReferences(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>,
    context: ResolutionContext,
    options: DeploymentOptions,
    resourceLogger: TypeKroLogger
  ): Promise<KubernetesResource> {
    try {
      resourceLogger.debug('Resolving resource references', {
        originalMetadata: resource.metadata,
      });
      const resolveTimeout = options.timeout || DEFAULT_READINESS_TIMEOUT;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const resolvedResource = (await Promise.race([
          this.referenceResolver.resolveReferences(resource, context),
          new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Reference resolution timeout')),
              resolveTimeout
            );
          }),
        ])) as KubernetesResource;
        resourceLogger.debug('References resolved successfully', {
          resolvedMetadata: resolvedResource.metadata,
          hasReadinessEvaluator: !!getReadinessEvaluator(resolvedResource),
        });
        return resolvedResource;
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    } catch (error: unknown) {
      // In Alchemy deployments, resourceKeyMapping is often empty because resources are deployed
      // one at a time. This is expected behavior, so we log at debug level instead of warn.
      const hasResourceKeyMapping =
        context.resourceKeyMapping && context.resourceKeyMapping.size > 0;
      if (hasResourceKeyMapping) {
        resourceLogger.warn('Reference resolution failed, using original resource', {
          error: ensureError(error).message,
        });
      } else {
        resourceLogger.debug(
          'Reference resolution skipped (no resourceKeyMapping), using original resource',
          {
            error: ensureError(error).message,
          }
        );
      }
      return resource;
    }
  }

  /**
   * Apply a namespace to a resource if one is specified and the resource doesn't already have one.
   * Preserves non-enumerable properties (readinessEvaluator, __resourceId) on the new object.
   */
  applyNamespaceToResource(
    resource: KubernetesResource,
    namespace: string | undefined,
    resourceLogger: TypeKroLogger
  ): KubernetesResource {
    if (!namespace || !resource.metadata || typeof resource.metadata.namespace === 'string') {
      return resource;
    }

    if (getMetadataField(resource as object, 'scope') === 'cluster') {
      resourceLogger.debug('Skipping namespace application for cluster-scoped resource', {
        kind: resource.kind,
        name: resource.metadata.name,
        targetNamespace: namespace,
        kubernetesScope: 'cluster',
      });
      return resource;
    }

    resourceLogger.debug('Applying namespace from deployment options', {
      targetNamespace: namespace,
      currentNamespace: resource.metadata.namespace,
      currentNamespaceType: typeof resource.metadata.namespace,
    });

    // Create a completely new metadata object to avoid proxy issues
    const newMetadata = {
      ...resource.metadata,
      namespace,
    };

    // Preserve the readiness evaluator when creating the new resource
    const newResource = {
      ...resource,
      metadata: newMetadata,
    };

    // Copy all resource metadata (resourceId, readinessEvaluator, etc.) via WeakMap
    copyResourceMetadata(resource, newResource);

    return newResource;
  }

  /**
   * Apply typekro ownership metadata (labels + annotations) to a resource
   * manifest right before it's serialized and sent to the cluster.
   *
   * No-op when the deployment isn't tagged with factoryName + instanceName
   * — untagged deployments don't participate in cross-process discovery
   * and would pollute their resources with partial ownership metadata.
   *
   * Uses `getEffectiveScopes` from the tagging module as the single
   * source of truth for scope computation — avoids duplicating the
   * WeakMap + annotation + legacy-alias merge logic.
   */
  applyOwnershipTags(
    resource: KubernetesResource,
    options: DeploymentOptions,
    resourceId: string,
    context: ResolutionContext
  ): void {
    const { factoryName, instanceName } = options;
    if (!factoryName || !instanceName) return;

    const deploymentId = context.deploymentId;
    if (!deploymentId) return;

    const scopes = getEffectiveScopes(resource);
    const dependencies = context.dependenciesForResource?.(resourceId) ?? [];

    applyTypekroTags(resource, {
      factoryName,
      instanceName,
      deploymentId,
      factoryNamespace: options.namespace ?? context.namespace ?? 'default',
      resourceId,
      scopes,
      ...(dependencies.length > 0 && { dependencies }),
      ...(options.singletonSpecFingerprint && {
        singletonSpecFingerprint: options.singletonSpecFingerprint,
      }),
    });
  }

  /**
   * Build a patch payload from a resource, including special-cased fields for Secrets and RBAC resources.
   */
  buildPatchPayload(resource: KubernetesResource): Record<string, unknown> {
    const patchPayload: Partial<KubernetesResource> = {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: resource.metadata,
    };

    // Include spec if present (most resources)
    if (resource.spec !== undefined) {
      patchPayload.spec = resource.spec;
    }

    // Include data if present (Secrets)
    if (resource.data !== undefined) {
      patchPayload.data = resource.data;
    }

    // Include stringData if present (Secrets)
    if (resource.stringData !== undefined) {
      patchPayload.stringData = resource.stringData;
    }

    // Include rules if present (RBAC resources)
    if (resource.rules !== undefined) {
      // Ensure arrays are preserved (not converted to objects with numeric keys)
      const rules = resource.rules;
      patchPayload.rules = Array.isArray(rules) ? [...rules] : rules;
    }

    // Include subjects if present (ClusterRoleBinding, RoleBinding)
    if (resource.subjects !== undefined) {
      // Ensure arrays are preserved (not converted to objects with numeric keys)
      const subjects = resource.subjects;
      patchPayload.subjects = Array.isArray(subjects) ? [...subjects] : subjects;
    }

    // Include roleRef if present (ClusterRoleBinding, RoleBinding)
    if (resource.roleRef !== undefined) {
      patchPayload.roleRef = resource.roleRef;
    }

    return this.serializeResourceForK8s(patchPayload);
  }

  /**
   * Handle a 409 Conflict error based on the configured conflict strategy.
   * Returns the applied resource if the conflict was handled, or undefined if it wasn't.
   */
  async handleConflictStrategy(
    resolvedResource: KubernetesResource,
    conflictStrategy: NonNullable<DeploymentOptions['conflictStrategy']>,
    resourceLogger: TypeKroLogger
  ): Promise<k8s.KubernetesObject | undefined> {
    const resourceName = resolvedResource.metadata?.name || 'unknown';
    const resourceKind = resolvedResource.kind || 'Unknown';
    const resourceNamespace = resolvedResource.metadata?.namespace;

    resourceLogger.debug('Resource already exists (409)', {
      name: resourceName,
      kind: resourceKind,
      conflictStrategy,
    });

    switch (conflictStrategy) {
      case 'fail':
        throw new ResourceConflictError(resourceName, resourceKind, resourceNamespace);

      case 'warn': {
        resourceLogger.warn('Resource already exists, treating as success', {
          name: resourceName,
          kind: resourceKind,
          namespace: resourceNamespace,
        });
        try {
          const result = await this.k8sApi.read({
            apiVersion: resolvedResource.apiVersion,
            kind: resolvedResource.kind,
            metadata: this.buildResourceIdentityMetadata(resolvedResource),
          });
          return result;
        } catch (readError: unknown) {
          resourceLogger.warn('Failed to read existing resource after 409, falling back to patch', {
            error: ensureError(readError).message,
          });
          // Fall back to patch strategy
          try {
            const cleanResource = this.serializeResourceForK8s(resolvedResource);
            const result = await patchResourceWithCorrectContentType(this.k8sApi, cleanResource);
            resourceLogger.debug(
              'Resource patched successfully after 409 conflict (warn fallback)'
            );
            return result;
          } catch (patchError: unknown) {
            resourceLogger.warn('Failed to patch resource after 409 conflict', {
              error: ensureError(patchError).message,
            });
          }
        }
        return undefined;
      }

      case 'patch': {
        try {
          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          const result = await patchResourceWithCorrectContentType(this.k8sApi, cleanResource);
          resourceLogger.debug('Resource patched successfully after 409 conflict');
          return result;
        } catch (patchError: unknown) {
          resourceLogger.warn('Failed to patch resource after 409 conflict', {
            error: ensureError(patchError).message,
          });
        }
        return undefined;
      }

      case 'replace': {
        try {
          resourceLogger.debug('Deleting existing resource for replace strategy');
          await this.k8sApi.delete({
            apiVersion: resolvedResource.apiVersion,
            kind: resolvedResource.kind,
            metadata: this.buildResourceIdentityMetadata(resolvedResource),
          });

          // Wait a moment for deletion to propagate
          await new Promise((resolve) => setTimeout(resolve, DEFAULT_CONFLICT_RETRY_DELAY));

          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          const result = await this.k8sApi.create(cleanResource);
          resourceLogger.debug('Resource replaced successfully after 409 conflict');
          return result;
        } catch (replaceError: unknown) {
          resourceLogger.warn('Failed to replace resource after 409 conflict', {
            error: ensureError(replaceError).message,
          });
        }
        return undefined;
      }
    }
  }

  /**
   * Apply a resource to the Kubernetes cluster with retry logic, conflict handling,
   * and support for both create and patch operations.
   */
  async applyResourceToCluster(
    resolvedResource: KubernetesResource,
    options: DeploymentOptions,
    resourceLogger: TypeKroLogger
  ): Promise<k8s.KubernetesObject> {
    if (options.dryRun) {
      resourceLogger.debug('Dry run mode: simulating resource creation');
      return {
        ...resolvedResource,
        metadata: {
          ...resolvedResource.metadata,
          uid: 'dry-run-uid',
        },
      } as k8s.KubernetesObject;
    }

    const retryPolicy = options.retryPolicy || {
      maxRetries: DEFAULT_MAX_RETRIES,
      backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
      initialDelay: DEFAULT_FAST_POLL_INTERVAL,
      maxDelay: DEFAULT_MAX_RETRY_DELAY,
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        resourceLogger.debug('Applying resource to cluster', { attempt });

        // Check if resource already exists
        const existing = await this.checkResourceExists(resolvedResource, resourceLogger);

        let appliedResource: k8s.KubernetesObject;
        if (existing) {
          // Resource exists, use patch for safer updates
          const cleanPayload = this.buildPatchPayload(resolvedResource);

          // Redact sensitive fields from Secret resources before logging
          if (cleanPayload.kind === 'Secret') {
            const { data: _data, stringData: _stringData, ...safePayload } = cleanPayload;
            resourceLogger.debug('Resource exists, patching', {
              patchPayload: safePayload,
              redacted: ['data', 'stringData'],
            });
          } else {
            resourceLogger.debug('Resource exists, patching', { patchPayload: cleanPayload });
          }

          appliedResource = await patchResourceWithCorrectContentType(this.k8sApi, cleanPayload);
        } else {
          // Resource does not exist, create it
          resourceLogger.debug('Resource does not exist, creating');

          // Log Secret resource metadata (sensitive fields redacted)
          if (resolvedResource.kind === 'Secret') {
            resourceLogger.debug('Creating Secret resource', {
              name: resolvedResource.metadata?.name,
              namespace: resolvedResource.metadata?.namespace,
              hasData: 'data' in resolvedResource,
              hasStringData: 'stringData' in resolvedResource,
              dataKeyCount: resolvedResource.data ? Object.keys(resolvedResource.data).length : 0,
            });
          }

          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          appliedResource = await this.k8sApi.create(cleanResource);
        }

        resourceLogger.debug('Resource applied successfully', {
          appliedName: appliedResource.metadata?.name,
          appliedNamespace: appliedResource.metadata?.namespace,
          operation: existing ? 'patched' : 'created',
          attempt,
        });

        return appliedResource;
      } catch (error: unknown) {
        lastError = ensureError(error);

        // Check for 409 Conflict errors - resource already exists
        const apiError = error as KubernetesApiError;
        const is409 =
          apiError.statusCode === 409 ||
          apiError.response?.statusCode === 409 ||
          apiError.body?.code === 409 ||
          (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 409'));

        if (is409) {
          const conflictStrategy = options.conflictStrategy || 'warn';
          const result = await this.handleConflictStrategy(
            resolvedResource,
            conflictStrategy,
            resourceLogger
          );
          if (result) {
            return result;
          }
        }

        resourceLogger.error('Failed to apply resource to cluster', lastError, { attempt });

        // Check for HTTP 415 Unsupported Media Type errors
        if (isUnsupportedMediaTypeError(error)) {
          const acceptedTypes = extractAcceptedMediaTypes(error);
          throw new UnsupportedMediaTypeError(
            resolvedResource.metadata?.name || 'unknown',
            resolvedResource.kind || 'Unknown',
            acceptedTypes,
            lastError
          );
        }

        // If this was the last attempt, throw the error
        if (attempt >= retryPolicy.maxRetries) {
          throw new ResourceDeploymentError(
            resolvedResource.metadata?.name || 'unknown',
            resolvedResource.kind || 'Unknown',
            lastError
          );
        }

        // Calculate delay for next attempt
        const delay = Math.min(
          retryPolicy.initialDelay * retryPolicy.backoffMultiplier ** attempt,
          retryPolicy.maxDelay
        );

        resourceLogger.debug('Retrying resource deployment', {
          attempt: attempt + 1,
          maxRetries: retryPolicy.maxRetries,
          delay,
        });

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // This should be unreachable due to the throw in the last attempt, but TypeScript needs it
    throw new ResourceDeploymentError(
      resolvedResource.metadata?.name || 'unknown',
      resolvedResource.kind || 'Unknown',
      lastError || new Error('Unknown deployment error')
    );
  }

  /**
   * Check if a resource already exists in the cluster.
   * Returns the existing resource if found, or undefined if it doesn't exist (404).
   * Throws for unexpected errors (non-404).
   */
  async checkResourceExists(
    resource: KubernetesResource,
    resourceLogger: TypeKroLogger
  ): Promise<k8s.KubernetesObject | undefined> {
    try {
      return await this.k8sApi.read({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        metadata: this.buildResourceIdentityMetadata(resource),
      });
    } catch (error: unknown) {
      const apiError = error as KubernetesApiError;
      // Check for 404 in various error formats
      const is404 =
        apiError.statusCode === 404 ||
        apiError.response?.statusCode === 404 ||
        apiError.body?.code === 404 ||
        (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 404'));

      if (is404) {
        // 404 means resource doesn't exist - this is expected, we'll create it
        return undefined;
      }

      // Check for "Unrecognized API version and kind" errors - CRD not installed yet
      const isUnrecognizedApiError =
        typeof apiError.message === 'string' &&
        apiError.message.includes('Unrecognized API version and kind');

      if (isUnrecognizedApiError) {
        resourceLogger.debug('CRD not yet registered, will retry after CRD establishment', {
          error: ensureError(error).message,
        });
      } else {
        resourceLogger.error('Error checking resource existence', ensureError(error));
      }
      throw error;
    }
  }
}
