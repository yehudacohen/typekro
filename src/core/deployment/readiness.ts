/**
 * Resource Readiness Checking
 *
 * Handles checking if Kubernetes resources are ready after deployment
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_READINESS_MAX_BACKOFF,
  DEFAULT_READINESS_PROBE_TIMEOUT,
} from '../config/defaults.js';
import { ensureError } from '../errors.js';
import type { DeploymentEvent, DeploymentOptions, ReadinessConfig } from '../types/deployment.js';
import type {
  DeployedResource,
  DeploymentResource,
  GenericResourceStatus as K8sGenericResourceStatus,
} from '../types.js';
import type { DebugLogger } from './debug-logger.js';
import { ResourceReadinessTimeoutError } from './errors.js';

export class ResourceReadinessChecker {
  private onResourceReady?: (resource: DeployedResource) => void;
  private debugLogger?: DebugLogger;

  constructor(private k8sApi: k8s.KubernetesObjectApi) {}

  /**
   * Set callback to be called when a resource becomes ready
   */
  setOnResourceReady(callback: (resource: DeployedResource) => void): void {
    this.onResourceReady = callback;
  }

  /**
   * Set debug logger for enhanced status logging
   */
  setDebugLogger(debugLogger: DebugLogger): void {
    this.debugLogger = debugLogger;
  }

  /**
   * Wait for a resource to be ready using polling
   */
  async waitForResourceReady(
    deployedResource: DeployedResource,
    options: DeploymentOptions,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    const readinessConfig = this.getReadinessConfig(options);
    await this.waitForResourceReadyWithPolling(
      deployedResource,
      options,
      readinessConfig,
      emitEvent
    );
  }

  /**
   * Wait for resource readiness using polling
   */
  private async waitForResourceReadyWithPolling(
    deployedResource: DeployedResource,
    _options: DeploymentOptions,
    readinessConfig: ReadinessConfig,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;

    emitEvent({
      type: 'progress',
      resourceId: deployedResource.id,
      message: `Polling for ${deployedResource.kind}/${deployedResource.name} to be ready`,
      timestamp: new Date(),
    });

    while (Date.now() - startTime < readinessConfig.timeout) {
      attempt++;

      try {
        // In the new API, methods return objects directly (no .body wrapper).
        // Bound the probe with a HARD per-attempt deadline (clamped to the
        // remaining budget) so a read that hangs before the HTTP layer arms its
        // own timeout — e.g. exec credential auth (`aws eks get-token`) blocking
        // on expired credentials — cannot stall the poll loop indefinitely. This
        // path has no abort signal, so the deadline is the only escape hatch.
        const currentResource = await this.readWithDeadline(
          {
            apiVersion: deployedResource.manifest.apiVersion,
            kind: deployedResource.kind,
            metadata: {
              name: deployedResource.name,
              namespace: deployedResource.namespace,
            },
          },
          readinessConfig.timeout - (Date.now() - startTime)
        );

        const isReady = this.isResourceReady(currentResource);

        // Debug logging for status polling
        if (this.debugLogger) {
          this.debugLogger.logResourceStatus(
            deployedResource,
            (currentResource as { status?: unknown }).status || currentResource,
            isReady,
            {
              attempt,
              elapsedTime: Date.now() - startTime,
              isTimeout: false,
              progressCallback: emitEvent,
            }
          );
        }

        if (isReady) {
          const duration = Date.now() - startTime;

          // Mark resource as ready in the deployment engine's tracking
          if (this.onResourceReady) {
            this.onResourceReady(deployedResource);
          }

          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `${deployedResource.kind}/${deployedResource.name} is ready after ${duration}ms`,
            timestamp: new Date(),
          });
          return;
        }

        // Emit progress update
        if (attempt % readinessConfig.progressInterval === 0) {
          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `Still waiting for ${deployedResource.kind}/${deployedResource.name} (attempt ${attempt})`,
            timestamp: new Date(),
          });
        }

        // Wait before next check with exponential backoff
        const delay = Math.min(
          readinessConfig.initialDelay * readinessConfig.backoffMultiplier ** (attempt - 1),
          readinessConfig.maxDelay
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error: unknown) {
        // Debug logging for API errors
        if (this.debugLogger) {
          this.debugLogger.logApiError(deployedResource, ensureError(error), {
            attempt,
            elapsedTime: Date.now() - startTime,
            isTimeout: false,
            progressCallback: emitEvent,
          });
        }

        // Log error but continue polling
        if (attempt % readinessConfig.progressInterval === 0) {
          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `Error checking readiness for ${deployedResource.kind}/${deployedResource.name}: ${ensureError(error).message}`,
            timestamp: new Date(),
          });
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, readinessConfig.errorRetryDelay));
      }
    }

    // Debug logging for timeout with final status
    if (this.debugLogger) {
      try {
        // In the new API, methods return objects directly (no .body wrapper)
        const finalResource = await this.k8sApi.read({
          apiVersion: deployedResource.manifest.apiVersion,
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        });

        this.debugLogger.logTimeout(
          deployedResource,
          (finalResource as { status?: unknown }).status || finalResource,
          Date.now() - startTime,
          attempt
        );
      } catch (_error: unknown) {
        // If we can't get final status, log timeout without it
        this.debugLogger.logTimeout(
          deployedResource,
          { error: 'Could not retrieve final status' },
          Date.now() - startTime,
          attempt
        );
      }
    }

    throw new ResourceReadinessTimeoutError(deployedResource, readinessConfig.timeout);
  }

  /**
   * Read a resource from the cluster bounded by a HARD per-attempt deadline.
   *
   * Races the read against a wall-clock timer (the smaller of the remaining
   * readiness budget and a per-attempt probe cap) so an attempt that never
   * settles — because the underlying client or its exec credential auth is
   * stuck and ignores the abort — is force-rejected. The deadline rejection
   * (a `ReadinessProbeTimeoutError`) is caught by the poll loop and treated as
   * a transient read failure, so polling continues until the OVERALL budget is
   * exhausted and the loop throws ResourceReadinessTimeoutError.
   */
  private async readWithDeadline(
    resourceRef: Parameters<k8s.KubernetesObjectApi['read']>[0],
    remainingBudgetMs: number
  ): Promise<k8s.KubernetesObject> {
    const deadlineMs = Math.max(1, Math.min(DEFAULT_READINESS_PROBE_TIMEOUT, remainingBudgetMs));

    const readPromise = this.k8sApi.read(resourceRef);
    // Swallow the non-winning branch's rejection so a dangling read promise does
    // not surface as an unhandled rejection after the deadline wins the race.
    // (The pending socket is unref'd by the HTTP layer, so it won't keep the
    // process alive.)
    readPromise.catch(() => undefined);

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        const err = new Error(`Readiness probe timed out after ${deadlineMs}ms`);
        err.name = 'ReadinessProbeTimeoutError';
        reject(err);
      }, deadlineMs);
      deadlineTimer.unref?.();
    });

    try {
      return (await Promise.race([readPromise, deadline])) as k8s.KubernetesObject;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  /**
   * Get readiness configuration with defaults
   */
  private getReadinessConfig(options: DeploymentOptions): ReadinessConfig {
    return {
      timeout: options.timeout || DEFAULT_DEPLOYMENT_TIMEOUT,
      initialDelay: DEFAULT_FAST_POLL_INTERVAL,
      maxDelay: DEFAULT_READINESS_MAX_BACKOFF,
      backoffMultiplier: 1.5,
      errorRetryDelay: DEFAULT_POLL_INTERVAL,
      progressInterval: 5, // Emit progress every 5 attempts
    };
  }

  /**
   * Type-safe field extraction from Kubernetes objects
   */
  private extractFieldFromK8sObject(obj: k8s.KubernetesObject, field: string): unknown {
    return (obj as Record<string, unknown>)[field];
  }

  /**
   * Type-safe status extraction
   */
  private getResourceStatus<T = K8sGenericResourceStatus>(
    resource: DeploymentResource
  ): T | undefined {
    if ('status' in resource && 'spec' in resource) {
      // Our KubernetesResource type - status is unknown, explicit typing needed
      return resource.status as T | undefined;
    }
    // k8s.KubernetesObject - dynamic field access needed
    return this.extractFieldFromK8sObject(resource, 'status') as T | undefined;
  }

  /**
   * Simple fallback readiness check for resources without custom evaluators.
   * @deprecated All resources should have factory-provided readiness evaluators.
   * This fallback exists only for backward compatibility during migration.
   */
  isResourceReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus(resource);

    // If no status, resource is not ready (can't verify it exists)
    if (!status) {
      return false;
    }

    // For resources with status, check for common readiness patterns
    return this.isGenericResourceReady(resource);
  }

  /**
   * Generic readiness check for unknown resource types
   */
  private isGenericResourceReady(resource: DeploymentResource): boolean {
    const status = this.getResourceStatus<K8sGenericResourceStatus>(resource);

    // Check for common readiness indicators
    if (status?.conditions) {
      const readyCondition = status.conditions.find((c) => c.type === 'Ready');
      if (readyCondition) {
        return readyCondition.status === 'True';
      }

      // Check for Available condition
      const availableCondition = status.conditions.find((c) => c.type === 'Available');
      if (availableCondition) {
        return availableCondition.status === 'True';
      }
    }

    // If no specific conditions, assume ready if status exists
    return true;
  }
}
