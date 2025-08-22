/**
 * Resource Rollback Manager
 *
 * This module provides consolidated rollback logic for all deployment modes,
 * ensuring consistent behavior and eliminating code duplication.
 */

import * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import type { DeploymentError, DeploymentEvent, RollbackResult } from '../types/deployment.js';
import type {
  Enhanced,
  KubernetesResource,
  KubernetesResourceHeader,
} from '../types/kubernetes.js';

/**
 * Configuration for rollback operations
 */
export interface RollbackConfig {
  timeout?: number | undefined;
  gracePeriod?: number | undefined;
  force?: boolean | undefined;
  emitEvent?: ((event: DeploymentEvent) => void) | undefined;
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
      } catch (error) {
        const resourceId = this.getResourceIdentifier(resource);
        errors.push({
          resourceId,
          phase: 'rollback' as const,
          error: error instanceof Error ? error : new Error(String(error)),
          timestamp: new Date(),
        });

        this.emitEvent(config, {
          type: 'failed',
          resourceId,
          message: `Failed to rollback ${resource.kind}/${resource.metadata?.name}: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
          error: error instanceof Error ? error : new Error(String(error)),
        });

        // Continue with remaining resources even if one fails
        this.logger.warn('Rollback error', error as Error);
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
    // Extract string values from metadata
    const name = this.extractStringValue(resource.metadata?.name);
    const namespace = this.extractStringValue(resource.metadata?.namespace);

    if (!name) {
      throw new Error(
        `Resource name is required for deletion: ${this.getResourceIdentifier(resource)}`
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
        await this.waitForResourceDeletion(resource, config.timeout);
      }
    } catch (error) {
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
        } catch (_forceError) {
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
      throw new Error(
        `Resource name is required for force deletion: ${this.getResourceIdentifier(resource)}`
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
    timeout: number
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < timeout) {
      try {
        const name = this.extractStringValue(resource.metadata?.name);
        const namespace = this.extractStringValue(resource.metadata?.namespace);

        if (!name) {
          throw new Error(
            `Resource name is required for deletion check: ${this.getResourceIdentifier(resource)}`
          );
        }
        if (!namespace) {
          throw new Error(
            `Resource name is required for deletion check: ${this.getResourceIdentifier(resource)}`
          );
        }

        const readObject: KubernetesResourceHeader<KubernetesResource> = {
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          metadata: { name, namespace },
        };

        if (namespace) {
          readObject.metadata.namespace = namespace;
        }

        await this.k8sApi.read(readObject);

        // Resource still exists, wait and try again
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        const k8sError = error as { statusCode?: number };
        if (k8sError.statusCode === 404) {
          // Resource is gone, deletion successful
          return;
        }
        // Other errors might be transient, continue waiting
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(
      `Timeout waiting for resource deletion: ${this.getResourceIdentifier(resource)}`
    );
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
   * Emit an event if callback is provided
   */
  private emitEvent(config: RollbackConfig, event: DeploymentEvent): void {
    if (config.emitEvent) {
      config.emitEvent(event);
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
 */
export function createRollbackManagerWithKubeConfig(
  kubeConfig: k8s.KubeConfig
): ResourceRollbackManager {
  const k8sApi = kubeConfig.makeApiClient(k8s.KubernetesObjectApi);
  return new ResourceRollbackManager(k8sApi);
}
