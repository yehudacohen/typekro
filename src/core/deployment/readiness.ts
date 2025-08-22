/**
 * Resource Readiness Checking
 *
 * Handles checking if Kubernetes resources are ready after deployment
 */

import type * as k8s from '@kubernetes/client-node';
import type { DeploymentEvent, DeploymentOptions, ReadinessConfig } from '../types/deployment.js';
import { ResourceReadinessTimeoutError } from '../types/deployment.js';
import type {
  DeployedResource,
  DeploymentResource,
  GenericResourceStatus as K8sGenericResourceStatus,
} from '../types.js';

export class ResourceReadinessChecker {
  private onResourceReady?: (resource: DeployedResource) => void;

  constructor(private k8sApi: k8s.KubernetesObjectApi) {}

  /**
   * Set callback to be called when a resource becomes ready
   */
  setOnResourceReady(callback: (resource: DeployedResource) => void): void {
    this.onResourceReady = callback;
  }

  /**
   * Wait for a resource to be ready using polling
   */
  async waitForResourceReady(
    deployedResource: DeployedResource,
    options: DeploymentOptions,
    emitEvent: (event: DeploymentEvent) => void
  ): Promise<void> {
    // Skip polling for resources that are immediately ready
    if (this.isImmediatelyReady(deployedResource.kind)) {
      emitEvent({
        type: 'progress',
        resourceId: deployedResource.id,
        message: `${deployedResource.kind}/${deployedResource.name} is ready after 0ms`,
        timestamp: new Date(),
      });
      return;
    }

    const readinessConfig = this.getReadinessConfig(options);
    await this.waitForResourceReadyWithPolling(
      deployedResource,
      options,
      readinessConfig,
      emitEvent
    );
  }

  /**
   * Check if a resource type is immediately ready when created
   */
  private isImmediatelyReady(kind: string): boolean {
    return ['ConfigMap', 'Secret', 'CronJob'].includes(kind);
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
        const { body: currentResource } = await this.k8sApi.read({
          apiVersion: deployedResource.manifest.apiVersion,
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        });

        if (this.isResourceReady(currentResource)) {
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
      } catch (error) {
        // Log error but continue polling
        if (attempt % readinessConfig.progressInterval === 0) {
          emitEvent({
            type: 'progress',
            resourceId: deployedResource.id,
            message: `Error checking readiness for ${deployedResource.kind}/${deployedResource.name}: ${error}`,
            timestamp: new Date(),
          });
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, readinessConfig.errorRetryDelay));
      }
    }

    throw new ResourceReadinessTimeoutError(deployedResource, readinessConfig.timeout);
  }

  /**
   * Get readiness configuration with defaults
   */
  private getReadinessConfig(options: DeploymentOptions): ReadinessConfig {
    return {
      timeout: options.timeout || 300000, // 5 minutes default
      initialDelay: 1000, // 1 second
      maxDelay: 10000, // 10 seconds max
      backoffMultiplier: 1.5,
      errorRetryDelay: 2000, // 2 seconds on error
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
   * Check if a resource is ready based on its kind and status
   */
  /**
   * Simple fallback readiness check for resources without custom evaluators
   * This should only be used when factory-level readiness evaluators are not available
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
