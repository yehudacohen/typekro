/**
 * Resource Rollback Manager
 *
 * This module provides consolidated rollback logic for all deployment modes,
 * ensuring consistent behavior and eliminating code duplication.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_DELETE_TIMEOUT,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_POLL_INTERVAL,
} from '../config/defaults.js';
import { DeploymentTimeoutError, ensureError, TypeKroError } from '../errors.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { getMetadataField } from '../metadata/index.js';
import type {
  DeployedResource,
  DeploymentError,
  DeploymentEvent,
  DeploymentOptions,
  RollbackResult,
} from '../types/deployment.js';
import type {
  Enhanced,
  KubernetesResource,
  KubernetesResourceHeader,
} from '../types/kubernetes.js';
import { isNotFoundError } from './k8s-helpers.js';
import { getEffectiveScopes, scopesMatchFilter } from './resource-tagging.js';

/**
 * Configuration for rollback operations
 */
export interface RollbackConfig {
  timeout?: number | undefined;
  gracePeriod?: number | undefined;
  force?: boolean | undefined;
  abortSignal?: AbortSignal | undefined;
  emitEvent?: ((event: DeploymentEvent) => void) | undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Consolidated rollback manager for all deployment modes
 */
export class ResourceRollbackManager {
  private logger = getComponentLogger('rollback-manager');

  constructor(private k8sApi: k8s.KubernetesObjectApi) {}

  /**
   * Rollback a list of resources in reverse dependency order
   */
  async rollbackResources(
    resources: Enhanced<unknown, unknown>[],
    config: RollbackConfig = {}
  ): Promise<RollbackResult> {
    const startTime = Date.now();
    const rolledBackResources: string[] = [];
    const errors: DeploymentError[] = [];

    // Emit rollback started event
    this.emitEvent(config, {
      type: 'rollback',
      message: `Starting rollback of ${resources.length} resources`,
      timestamp: new Date(),
    });

    // Rollback resources in reverse order (reverse dependency order)
    const reversedResources = [...resources].reverse();

    for (const resource of reversedResources) {
      try {
        await this.rollbackSingleResource(resource, config);
        rolledBackResources.push(this.getResourceIdentifier(resource));

        this.emitEvent(config, {
          type: 'progress',
          resourceId: this.getResourceIdentifier(resource),
          message: `Successfully rolled back ${resource.kind}/${resource.metadata?.name}`,
          timestamp: new Date(),
        });
      } catch (error: unknown) {
        const resourceId = this.getResourceIdentifier(resource);
        errors.push({
          resourceId,
          phase: 'rollback' as const,
          error: ensureError(error),
          timestamp: new Date(),
        });

        this.emitEvent(config, {
          type: 'failed',
          resourceId,
          message: `Failed to rollback ${resource.kind}/${resource.metadata?.name}: ${ensureError(error).message}`,
          timestamp: new Date(),
          error: ensureError(error),
        });

        // Continue with remaining resources even if one fails
        this.logger.error('Rollback error', ensureError(error));
      }
    }

    const duration = Date.now() - startTime;
    const status =
      errors.length === 0 ? 'success' : rolledBackResources.length > 0 ? 'partial' : 'failed';

    this.emitEvent(config, {
      type: 'completed',
      message: `Rollback completed: ${rolledBackResources.length} succeeded, ${errors.length} failed`,
      timestamp: new Date(),
    });

    return {
      deploymentId: `rollback-${Date.now()}`,
      rolledBackResources,
      duration,
      status,
      errors,
    };
  }

  /**
   * Rollback a single resource
   */
  private async rollbackSingleResource(
    resource: Enhanced<unknown, unknown>,
    config: RollbackConfig
  ): Promise<void> {
    throwIfAborted(config.abortSignal);
    // Extract string values from metadata
    const name = this.extractStringValue(resource.metadata?.name);
    const namespace = this.extractStringValue(resource.metadata?.namespace);

    if (!name) {
      throw new TypeKroError(
        `Resource name is required for deletion: ${this.getResourceIdentifier(resource)}`,
        'MISSING_RESOURCE_NAME',
        { resourceIdentifier: this.getResourceIdentifier(resource), operation: 'deletion' }
      );
    }

    try {
      // Attempt graceful deletion first
      const deleteObject: {
        apiVersion: string;
        kind: string;
        metadata: { name: string; namespace?: string };
      } = {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        metadata: { name },
      };

      if (namespace) {
        deleteObject.metadata.namespace = namespace;
      }

      await this.k8sApi.delete(deleteObject, undefined, undefined, config.gracePeriod);

      // Wait for deletion to complete if timeout is specified
      if (config.timeout !== undefined) {
        await this.waitForResourceDeletion(resource, config.timeout, config.abortSignal);
      }
    } catch (error: unknown) {
      const k8sError = error as { statusCode?: number; message?: string };

      // If resource is already gone (404), consider it successful
      if (k8sError.statusCode === 404) {
        return;
      }

      // If force deletion is enabled and graceful deletion failed, try force deletion
      if (config.force && k8sError.statusCode !== 404) {
        try {
          await this.forceDeleteResource(resource);
          return;
        } catch (_forceError: unknown) {
          // If force deletion also fails, throw the original error
          throw error;
        }
      }

      throw error;
    }
  }

  /**
   * Force delete a resource (sets gracePeriod to 0)
   */
  private async forceDeleteResource(resource: Enhanced<unknown, unknown>): Promise<void> {
    const name = this.extractStringValue(resource.metadata?.name);
    const namespace = this.extractStringValue(resource.metadata?.namespace);

    if (!name) {
      throw new TypeKroError(
        `Resource name is required for force deletion: ${this.getResourceIdentifier(resource)}`,
        'MISSING_RESOURCE_NAME',
        { resourceIdentifier: this.getResourceIdentifier(resource), operation: 'force-deletion' }
      );
    }

    const deleteObject: {
      apiVersion: string;
      kind: string;
      metadata: { name: string; namespace?: string };
      spec?: { gracePeriodSeconds: number };
    } = {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: { name },
    };

    if (namespace) {
      deleteObject.metadata.namespace = namespace;
    }

    await this.k8sApi.delete(deleteObject, undefined, undefined, 0); // gracePeriod = 0 for force deletion
  }

  /**
   * Wait for a resource to be deleted
   */
  private async waitForResourceDeletion(
    resource: Enhanced<unknown, unknown>,
    timeout: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const name = this.extractStringValue(resource.metadata?.name);
    if (!name) {
      throw new TypeKroError(
        `Resource name is required for deletion check: ${this.getResourceIdentifier(resource)}`,
        'MISSING_RESOURCE_NAME',
        {
          resourceIdentifier: this.getResourceIdentifier(resource),
          operation: 'deletion-check',
        }
      );
    }
    const namespace = this.extractStringValue(resource.metadata?.namespace);
    await this.waitForDeletionByHeader(
      {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        name,
        ...(namespace ? { namespace } : {}),
      },
      timeout,
      abortSignal
    );
  }

  /**
   * The ONE gating wait shared by every deletion path: poll `read` until the
   * resource returns a real 404, and THROW {@link DeploymentTimeoutError} if it
   * does not within `timeout`. Unlike a best-effort wait it NEVER returns
   * silently on timeout — a stuck finalizer surfaces as an error so the caller
   * does not proceed to a dependent step (e.g. deleting a Namespace while its
   * generated CRD is still Terminating). Transient non-404 read errors are
   * retried until the deadline.
   */
  private async waitForDeletionByHeader(
    target: { apiVersion: string; kind: string; name: string; namespace?: string },
    timeout: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = Math.min(DEFAULT_POLL_INTERVAL, Math.max(1, timeout));
    const metadata = target.namespace
      ? { name: target.name, namespace: target.namespace }
      : { name: target.name };

    while (Date.now() - startTime < timeout) {
      throwIfAborted(abortSignal);
      try {
        await this.k8sApi.read({
          apiVersion: target.apiVersion,
          kind: target.kind,
          metadata,
        } as unknown as KubernetesResourceHeader<KubernetesResource>);
        // Resource still exists, wait and try again
        await abortableDelay(pollInterval, abortSignal);
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          // Resource is gone, deletion successful
          return;
        }
        // Other errors might be transient, continue waiting
        await abortableDelay(pollInterval, abortSignal);
      }
    }

    throw new DeploymentTimeoutError(
      `Timeout waiting for resource deletion: ${target.kind}/${target.name}`,
      target.kind,
      target.name,
      timeout,
      'deletion'
    );
  }

  /**
   * Gate on an already-requested deletion without issuing a second delete.
   * KRO clears its owner finalizer after requesting child deletion, so callers
   * use this to prove every child has actually reached 404.
   */
  async waitForResourceGone(
    target: { apiVersion: string; kind: string; name: string; namespace?: string },
    options: { timeout?: number; abortSignal?: AbortSignal } = {}
  ): Promise<void> {
    await this.waitForDeletionByHeader(
      target,
      options.timeout ?? DEFAULT_DELETE_TIMEOUT,
      options.abortSignal
    );
  }

  /**
   * Delete a single resource by header and GATE on its real 404, throwing
   * {@link DeploymentTimeoutError} if it does not disappear within `timeout`.
   *
   * This is the engine's ONE gating deletion primitive, reused by the KRO
   * teardown sequence (CR → RGD → CRD → Namespace) and the Alchemy KRO delete
   * path so there is a single, real gate everywhere — replacing the hand-rolled
   * "poll then silently return on timeout" waits that let a slow teardown
   * proceed to the next step while the previous resource was still Terminating.
   *
   * A 404 on the delete itself is treated as success (already gone). Any other
   * delete error propagates. On success, the read gate runs to a real 404.
   */
  async deleteResourceAndWait(
    target: { apiVersion: string; kind: string; name: string; namespace?: string },
    options: { timeout?: number; gracePeriod?: number; abortSignal?: AbortSignal } = {}
  ): Promise<void> {
    throwIfAborted(options.abortSignal);
    const timeout = options.timeout ?? DEFAULT_DELETE_TIMEOUT;
    const metadata = target.namespace
      ? { name: target.name, namespace: target.namespace }
      : { name: target.name };

    try {
      await this.k8sApi.delete(
        { apiVersion: target.apiVersion, kind: target.kind, metadata } as k8s.KubernetesObject,
        undefined,
        undefined,
        options.gracePeriod
      );
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        this.logger.debug('Resource already gone before delete', {
          kind: target.kind,
          name: target.name,
        });
        return;
      }
      throw error;
    }

    await this.waitForDeletionByHeader(target, timeout, options.abortSignal);
  }

  /**
   * Extract string value from potentially complex metadata field
   */
  private extractStringValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && 'toString' in value) {
      return String(value);
    }
    return undefined;
  }

  /**
   * Get a human-readable identifier for a resource
   */
  private getResourceIdentifier(resource: Enhanced<unknown, unknown>): string {
    const name = this.extractStringValue(resource.metadata?.name) || 'unknown';
    const namespace = this.extractStringValue(resource.metadata?.namespace) || 'default';
    return `${resource.kind}/${name} (${namespace})`;
  }

  /**
   * Rollback resources that are already in the correct deletion order
   * with scope filtering already applied. Used by `engine.rollbackRecord`
   * which computes reverse-topological order and scope exclusions.
   */
  async rollbackOrderedResources(
    deployedResources: DeployedResource[],
    options: DeploymentOptions
  ): Promise<{
    rolledBackResources: string[];
    deletedResources: DeployedResource[];
    errors: DeploymentError[];
  }> {
    return this.deleteResourceList(deployedResources, options);
  }

  /**
   * Rollback resources in reverse-deployment order, skipping scoped
   * resources. Used by the deploy-failure auto-rollback path where
   * resources are in deployment order and scope filtering hasn't been
   * applied.
   */
  async rollbackDeployedResources(
    deployedResources: DeployedResource[],
    options: DeploymentOptions
  ): Promise<{
    rolledBackResources: string[];
    deletedResources: DeployedResource[];
    errors: DeploymentError[];
  }> {
    const filtered = [...deployedResources].reverse().filter((r) => {
      const scopes = getEffectiveScopes(r.manifest);
      if (options.targetScopes !== undefined) {
        return scopesMatchFilter(scopes, options.targetScopes);
      }
      if (scopes.length > 0) {
        this.logger.debug('Skipping scoped resource during rollback', {
          resourceId: r.id,
          kind: r.kind,
          name: r.name,
          scopes,
        });
        return false;
      }
      return true;
    });
    return this.deleteResourceList(filtered, options);
  }

  /**
   * Core deletion loop — iterates the resource list in order, deleting
   * each non-failed resource. Shared by both ordered and unordered paths.
   */
  private async deleteResourceList(
    resources: DeployedResource[],
    options: DeploymentOptions
  ): Promise<{
    rolledBackResources: string[];
    deletedResources: DeployedResource[];
    errors: DeploymentError[];
  }> {
    this.emitDeploymentEvent(options, {
      type: 'rollback',
      message: 'Starting rollback of deployed resources',
      timestamp: new Date(),
    });

    const rolledBackResources: string[] = [];
    const deletedResources: DeployedResource[] = [];
    const errors: DeploymentError[] = [];

    for (const resource of resources) {
      if (resource.status === 'failed' && resource.applied !== true) continue;

      try {
        await this.deleteDeployedResource(resource, options.timeout, options.abortSignal);

        rolledBackResources.push(`${resource.kind}/${resource.name}`);
        deletedResources.push(resource);
      } catch (error: unknown) {
        this.logger.warn('Failed to delete resource during rollback', {
          error: ensureError(error),
          resourceId: resource.id,
          kind: resource.kind,
          name: resource.name,
        });

        errors.push({
          resourceId: resource.id,
          phase: 'rollback',
          error: ensureError(error),
          timestamp: new Date(),
        });
      }
    }

    return { rolledBackResources, deletedResources, errors };
  }

  /**
   * Delete a single deployed resource from the cluster and wait for
   * deletion to complete.
   *
   * This method does NOT perform scope filtering — the caller (typically
   * `engine.rollbackRecord`) is responsible for deciding which resources
   * should be deleted. Filtering at this level would silently drop
   * resources that the caller explicitly targeted for deletion.
   */
  async deleteDeployedResource(
    resource: DeployedResource,
    timeout?: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(abortSignal);
    const deleteLogger = this.logger.child({
      resourceId: resource.id,
      kind: resource.kind,
      name: resource.name,
    });

    const isClusterScoped = getMetadataField(resource.manifest, 'scope') === 'cluster';
    const metadata = {
      name: resource.name,
      ...(isClusterScoped ? {} : { namespace: resource.namespace }),
    };

    try {
      try {
        await this.k8sApi.delete({
          apiVersion: resource.manifest.apiVersion || '',
          kind: resource.kind,
          metadata,
        } as k8s.KubernetesObject);
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          deleteLogger.debug('Resource already deleted');
          return;
        }
        throw error;
      }

      // Namespace deletion is asynchronous and may be blocked by PVCs that
      // Kubernetes cannot garbage-collect until their volumes are released.
      // DirectResourceFactory owns that lifecycle: it removes PVCs only for
      // explicitly targeted Namespaces and waits for the Namespace 404. Do
      // not consume the generic per-resource timeout here before that cleanup
      // has had a chance to run.
      if (resource.kind === 'Namespace') {
        return;
      }

      // Wait for resource to be deleted
      const deleteTimeout = timeout ?? DEFAULT_DELETE_TIMEOUT;
      const startTime = Date.now();

      while (Date.now() - startTime < deleteTimeout) {
        throwIfAborted(abortSignal);
        try {
          await this.k8sApi.read({
            apiVersion: resource.manifest.apiVersion || '',
            kind: resource.kind,
            metadata,
          });

          // Resource still exists, wait and try again
          await abortableDelay(DEFAULT_FAST_POLL_INTERVAL, abortSignal);
        } catch (error: unknown) {
          // Resource not found, deletion successful
          if (isNotFoundError(error)) {
            deleteLogger.debug('Resource successfully deleted');
            return;
          }
          throw error;
        }
      }

      throw new DeploymentTimeoutError(
        `Timeout waiting for resource ${resource.kind}/${resource.name} to be deleted`,
        resource.kind,
        resource.name,
        deleteTimeout,
        'deletion'
      );
    } catch (error: unknown) {
      deleteLogger.error('Failed to delete resource', ensureError(error));
      throw error;
    }
  }

  /**
   * Emit an event if callback is provided (for RollbackConfig)
   */
  private emitEvent(config: RollbackConfig, event: DeploymentEvent): void {
    if (config.emitEvent) {
      config.emitEvent(event);
    }
  }

  /**
   * Emit an event if progressCallback is provided (for DeploymentOptions)
   */
  private emitDeploymentEvent(options: DeploymentOptions, event: DeploymentEvent): void {
    if (options.progressCallback) {
      options.progressCallback(event);
    }
  }
}

/**
 * Factory function for creating rollback managers
 */
export function createRollbackManager(k8sApi: k8s.KubernetesObjectApi): ResourceRollbackManager {
  return new ResourceRollbackManager(k8sApi);
}

/**
 * Factory function for creating rollback managers with KubeConfig
 * Uses createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
 */
export function createRollbackManagerWithKubeConfig(
  kubeConfig: k8s.KubeConfig
): ResourceRollbackManager {
  // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
  // This works around Bun's fetch TLS issues (https://github.com/oven-sh/bun/issues/10642)
  const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
  return new ResourceRollbackManager(k8sApi);
}
