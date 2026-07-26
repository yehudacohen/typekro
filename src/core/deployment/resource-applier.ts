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
import type { ArtifactApplyPolicy } from '../planning/artifacts.js';
import type { ReferenceResolver } from '../references/index.js';
import { compareKubernetesResources, formatCanonicalDrift } from '../resources/live-comparison.js';
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
  ResourceReplacementTimeoutError,
  ServerSideApplyConflictError,
  UnsupportedMediaTypeError,
} from './errors.js';
import {
  extractAcceptedMediaTypes,
  isConflictError,
  isNotFoundError,
  isUnsupportedMediaTypeError,
  patchResourceWithCorrectContentType,
} from './k8s-helpers.js';
import { applyTypekroTags, getEffectiveScopes } from './resource-tagging.js';

/** Host-neutral contract for applying one compiled Kubernetes artifact operation. */
export interface ArtifactResourceApplier {
  applyArtifactResource(
    resource: KubernetesResource,
    policy: ArtifactApplyPolicy | undefined,
    options: DeploymentOptions,
    resourceLogger: TypeKroLogger
  ): Promise<k8s.KubernetesObject>;
}

export class ResourceApplier implements ArtifactResourceApplier {
  constructor(
    private k8sApi: k8s.KubernetesObjectApi,
    private referenceResolver: ReferenceResolver | undefined,
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

  private throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  private async abortableDelay(delay: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private isImmutableFieldError(error: unknown): boolean {
    const apiError = error as KubernetesApiError & { code?: number };
    const statusCode =
      apiError.statusCode ?? apiError.response?.statusCode ?? apiError.body?.code ?? apiError.code;
    if (statusCode !== 422) return false;
    const message = `${apiError.body?.message ?? ''} ${ensureError(error).message}`;
    return /\bimmutable\b|may not be changed|may not change once set/i.test(message);
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

    // Strip internal TypeKro fields that should not be sent to Kubernetes.
    // These fields are used for local resource mapping/scope rehydration but
    // are not valid top-level Kubernetes manifest fields.
    delete cleanResource.id;
    delete cleanResource.scope;

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
    if (!this.referenceResolver) {
      resourceLogger.debug('Reference resolution is unavailable for this artifact applier');
      return resource;
    }
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
    resourceLogger: TypeKroLogger,
    abortSignal?: AbortSignal,
    timeout = DEFAULT_READINESS_TIMEOUT
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

          await this.waitForResourceDeletion(
            resolvedResource,
            resourceLogger,
            abortSignal,
            timeout
          );

          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          const result = await this.k8sApi.create(cleanResource);
          resourceLogger.debug('Resource replaced successfully after 409 conflict');
          return result;
        } catch (replaceError: unknown) {
          if (replaceError instanceof ResourceReplacementTimeoutError || abortSignal?.aborted) {
            throw replaceError;
          }
          resourceLogger.warn('Failed to replace resource after 409 conflict', {
            error: ensureError(replaceError).message,
          });
        }
        return undefined;
      }
    }
  }

  private async createResource(
    resource: KubernetesResource,
    resourceLogger: TypeKroLogger,
    fieldManager?: string
  ): Promise<k8s.KubernetesObject> {
    if (resource.kind === 'Secret') {
      resourceLogger.debug('Creating Secret resource', {
        name: resource.metadata?.name,
        namespace: resource.metadata?.namespace,
        hasData: 'data' in resource,
        hasStringData: 'stringData' in resource,
        dataKeyCount: resource.data ? Object.keys(resource.data).length : 0,
      });
    }
    const manifest = this.serializeResourceForK8s(resource);
    return fieldManager
      ? await this.k8sApi.create(manifest, undefined, undefined, fieldManager)
      : await this.k8sApi.create(manifest);
  }

  private async patchResource(
    resource: KubernetesResource,
    resourceLogger: TypeKroLogger,
    patchType: 'merge' | 'strategic' = 'merge'
  ): Promise<k8s.KubernetesObject> {
    const cleanPayload = this.buildPatchPayload(resource);
    if (cleanPayload.kind === 'Secret') {
      const { data: _data, stringData: _stringData, ...safePayload } = cleanPayload;
      resourceLogger.debug('Resource exists, patching', {
        patchPayload: safePayload,
        redacted: ['data', 'stringData'],
      });
    } else {
      resourceLogger.debug('Resource exists, patching', { patchPayload: cleanPayload });
    }
    return await patchResourceWithCorrectContentType(this.k8sApi, cleanPayload, patchType);
  }

  private async replaceResource(
    resource: KubernetesResource,
    exists: boolean,
    resourceLogger: TypeKroLogger,
    abortSignal?: AbortSignal,
    timeout = DEFAULT_READINESS_TIMEOUT,
    fieldManager?: string
  ): Promise<k8s.KubernetesObject> {
    if (exists) {
      resourceLogger.debug('Deleting existing resource for replace policy');
      await this.k8sApi.delete({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        metadata: this.buildResourceIdentityMetadata(resource),
      });
      await this.waitForResourceDeletion(resource, resourceLogger, abortSignal, timeout);
    }
    return await this.createResource(resource, resourceLogger, fieldManager);
  }

  private async waitForResourceDeletion(
    resource: KubernetesResource,
    resourceLogger: TypeKroLogger,
    abortSignal?: AbortSignal,
    timeout = DEFAULT_READINESS_TIMEOUT
  ): Promise<void> {
    const startedAt = Date.now();
    const identity = {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: this.buildResourceIdentityMetadata(resource),
    };

    while (true) {
      this.throwIfAborted(abortSignal);
      try {
        await this.k8sApi.read(identity);
      } catch (error: unknown) {
        if (isNotFoundError(error)) return;
        throw error;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeout) {
        throw new ResourceReplacementTimeoutError(
          resource.metadata?.name || 'unknown',
          resource.kind || 'Unknown',
          timeout
        );
      }
      const delay = Math.min(DEFAULT_CONFLICT_RETRY_DELAY, Math.max(1, timeout - elapsed));
      resourceLogger.debug('Waiting for previous resource object to finish deleting', {
        name: resource.metadata?.name,
        kind: resource.kind,
        elapsed,
        timeout,
      });
      await this.abortableDelay(delay, abortSignal);
    }
  }

  private async serverSideApply(
    resource: KubernetesResource,
    policy: Extract<ArtifactApplyPolicy, { strategy: 'server-side-apply' }>,
    resourceLogger: TypeKroLogger
  ): Promise<k8s.KubernetesObject> {
    const manifest = this.serializeResourceForK8s(resource) as k8s.KubernetesObject;
    const apply = () =>
      this.k8sApi.patch(
        manifest,
        undefined,
        undefined,
        policy.fieldManager,
        policy.fieldConflictPolicy === 'force-owned-fields',
        'application/apply-patch+yaml'
      );

    try {
      return await apply();
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
      resourceLogger.debug('SSA target is absent; creating resource');
      try {
        return await this.createResource(resource, resourceLogger, policy.fieldManager);
      } catch (createError: unknown) {
        if (!isConflictError(createError)) throw createError;
        resourceLogger.debug('SSA create raced with another writer; retrying apply');
        return await apply();
      }
    }
  }

  private async applyWithPolicy(
    resource: KubernetesResource,
    policy: ArtifactApplyPolicy | undefined,
    resourceLogger: TypeKroLogger,
    abortSignal?: AbortSignal,
    timeout = DEFAULT_READINESS_TIMEOUT
  ): Promise<{ resource: k8s.KubernetesObject; operation: string }> {
    const effectivePolicy: ArtifactApplyPolicy = policy ?? {
      strategy: 'create-or-patch',
      existingResource: 'patch',
      immutableFieldPolicy: 'fail',
    };
    if (effectivePolicy.strategy === 'server-side-apply') {
      try {
        return {
          resource: await this.serverSideApply(resource, effectivePolicy, resourceLogger),
          operation: 'server-side-applied',
        };
      } catch (error: unknown) {
        if (
          effectivePolicy.immutableFieldPolicy === 'recreate' &&
          this.isImmutableFieldError(error)
        ) {
          return {
            resource: await this.replaceResource(
              resource,
              true,
              resourceLogger,
              abortSignal,
              timeout,
              effectivePolicy.fieldManager
            ),
            operation: 'recreated',
          };
        }
        throw error;
      }
    }

    const existing = await this.checkResourceExists(resource, resourceLogger);
    if (effectivePolicy.strategy === 'create-only') {
      if (existing) {
        throw new ResourceConflictError(
          resource.metadata?.name || 'unknown',
          resource.kind || 'Unknown',
          resource.metadata?.namespace
        );
      }
      return {
        resource: await this.createResource(resource, resourceLogger),
        operation: 'created',
      };
    }
    if (effectivePolicy.strategy === 'replace') {
      return {
        resource: await this.replaceResource(
          resource,
          existing !== undefined,
          resourceLogger,
          abortSignal,
          timeout
        ),
        operation: existing ? 'replaced' : 'created',
      };
    }
    if (!existing) {
      return {
        resource: await this.createResource(resource, resourceLogger),
        operation: 'created',
      };
    }
    switch (effectivePolicy.existingResource) {
      case 'fail':
        throw new ResourceConflictError(
          resource.metadata?.name || 'unknown',
          resource.kind || 'Unknown',
          resource.metadata?.namespace
        );
      case 'warn':
        resourceLogger.warn('Resource already exists; preserving it by artifact policy', {
          name: resource.metadata?.name,
          kind: resource.kind,
          namespace: resource.metadata?.namespace,
        });
        return { resource: existing, operation: 'preserved' };
      case 'replace':
        return {
          resource: await this.replaceResource(
            resource,
            true,
            resourceLogger,
            abortSignal,
            timeout
          ),
          operation: 'replaced',
        };
      case 'patch': {
        if (resource.kind !== 'Secret') {
          const comparison = compareKubernetesResources(resource, existing as KubernetesResource);
          if (comparison.equal) {
            resourceLogger.debug('Existing resource already matches canonical desired state', {
              name: resource.metadata?.name,
              kind: resource.kind,
              namespace: resource.metadata?.namespace,
              canonicalizers: comparison.canonicalizers,
            });
            return { resource: existing, operation: 'unchanged' };
          }
          resourceLogger.debug('Canonical desired/live drift requires patching', {
            name: resource.metadata?.name,
            kind: resource.kind,
            namespace: resource.metadata?.namespace,
            drift: formatCanonicalDrift(comparison.differences),
            differences: comparison.differences,
            canonicalizers: comparison.canonicalizers,
          });
        }
        try {
          return {
            resource: await this.patchResource(resource, resourceLogger, effectivePolicy.patchType),
            operation: 'patched',
          };
        } catch (error: unknown) {
          if (
            effectivePolicy.immutableFieldPolicy === 'recreate' &&
            this.isImmutableFieldError(error)
          ) {
            return {
              resource: await this.replaceResource(
                resource,
                true,
                resourceLogger,
                abortSignal,
                timeout
              ),
              operation: 'recreated',
            };
          }
          throw error;
        }
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
    return this.applyArtifactResource(
      resolvedResource,
      getMetadataField(resolvedResource as object, 'applyPolicy'),
      options,
      resourceLogger
    );
  }

  /** Apply one compiled artifact operation through the canonical policy executor. */
  async applyArtifactResource(
    resolvedResource: KubernetesResource,
    applyPolicy: ArtifactApplyPolicy | undefined,
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
      this.throwIfAborted(options.abortSignal);
      try {
        resourceLogger.debug('Applying resource to cluster', { attempt });

        const { resource: appliedResource, operation } = await this.applyWithPolicy(
          resolvedResource,
          applyPolicy,
          resourceLogger,
          options.abortSignal,
          options.timeout ?? DEFAULT_READINESS_TIMEOUT
        );

        resourceLogger.debug('Resource applied successfully', {
          appliedName: appliedResource.metadata?.name,
          appliedNamespace: appliedResource.metadata?.namespace,
          operation,
          attempt,
        });

        return appliedResource;
      } catch (error: unknown) {
        if (options.abortSignal?.aborted) {
          throw options.abortSignal.reason ?? error;
        }
        if (
          error instanceof ResourceConflictError ||
          error instanceof ResourceReplacementTimeoutError ||
          error instanceof ServerSideApplyConflictError
        ) {
          throw error;
        }
        lastError = ensureError(error);

        // Check for 409 Conflict errors - resource already exists
        const apiError = error as KubernetesApiError;
        const is409 =
          apiError.statusCode === 409 ||
          apiError.response?.statusCode === 409 ||
          apiError.body?.code === 409 ||
          (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 409'));

        if (is409) {
          if (applyPolicy?.strategy === 'server-side-apply') {
            throw new ServerSideApplyConflictError(
              resolvedResource.metadata?.name || 'unknown',
              resolvedResource.kind || 'Unknown',
              applyPolicy.fieldManager,
              applyPolicy.fieldConflictPolicy,
              ensureError(error)
            );
          }
          const conflictStrategy =
            applyPolicy?.strategy === 'create-or-patch'
              ? applyPolicy.existingResource
              : applyPolicy?.strategy === 'replace'
                ? 'replace'
                : applyPolicy?.strategy === 'create-only'
                  ? 'fail'
                  : options.conflictStrategy || 'warn';
          const result = await this.handleConflictStrategy(
            resolvedResource,
            conflictStrategy,
            resourceLogger,
            options.abortSignal,
            options.timeout ?? DEFAULT_READINESS_TIMEOUT
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
        await this.abortableDelay(delay, options.abortSignal);
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
