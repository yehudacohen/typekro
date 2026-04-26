/**
 * Alchemy Deployer Implementations
 *
 * This module provides concrete implementations of TypeKroDeployer
 * for different deployment strategies (direct and Kro).
 */

import { DEFAULT_DEPLOYMENT_TIMEOUT } from '../core/config/defaults.js';
import { DependencyGraph } from '../core/dependencies/index.js';
import { ResourceDeploymentError } from '../core/deployment/errors.js';
import { getComponentLogger } from '../core/logging/index.js';
import { copyResourceMetadata, getReadinessEvaluator } from '../core/metadata/index.js';
import { ensureReadinessEvaluator } from '../core/readiness/index.js';
import { generateDeterministicResourceId, getResourceId } from '../core/resources/id.js';
import type { DeploymentOptions, DeploymentResourceGraph } from '../core/types/deployment.js';
import type { DeployableK8sResource, Enhanced } from '../core/types/kubernetes.js';
import type { TypeKroDeployer } from './types.js';

const logger = getComponentLogger('deployers');

interface KroTypeKroDeployerOptions {
  /** Finalizer-safe KRO instance deletion supplied by the owning factory. */
  deleteInstance?: (name: string) => Promise<void>;
}

function getKubernetesErrorCode(error: unknown): number | undefined {
  const k8sError = error as { statusCode?: number; code?: number; body?: { code?: number } };
  return k8sError.statusCode ?? k8sError.code ?? k8sError.body?.code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Direct deployment implementation using TypeKro's DirectDeploymentEngine
 */
export class DirectTypeKroDeployer implements TypeKroDeployer {
  constructor(private engine: import('../core/deployment/engine.js').DirectDeploymentEngine) {}

  async dispose(): Promise<void> {
    await this.engine.dispose();
  }

  /**
   * Create a ResourceGraph for a single resource
   * This helper function reduces duplication between deploy and delete operations
   */
  private createResourceGraph<T extends Enhanced<any, any>>(resource: T): DeploymentResourceGraph {
    const resourceWithId = {
      ...resource,
      id: getResourceId(resource, 'unnamed'),
    };

    // Preserve resource metadata (resourceId, readinessEvaluator, etc.) via WeakMap
    copyResourceMetadata(resource, resourceWithId);

    // Create a proper DependencyGraph instance
    const dependencyGraph = new DependencyGraph();
    dependencyGraph.addNode(
      resourceWithId.id,
      resourceWithId as DeployableK8sResource<Enhanced<unknown, unknown>>
    );

    return {
      name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
      resources: [
        {
          id: resourceWithId.id,
          manifest: resourceWithId as DeployableK8sResource<Enhanced<unknown, unknown>>,
        },
      ],
      dependencyGraph,
    };
  }

  async deploy<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<T> {
    // Ensure the resource has a readiness evaluator using factory functions or registry lookup
    // The ensureReadinessEvaluator function:
    // 1. Returns the resource if it already has a readinessEvaluator attached
    // 2. Looks up the evaluator in the global ReadinessEvaluatorRegistry by kind
    // 3. Throws an error if no evaluator is found
    const resourceWithEvaluator = ensureReadinessEvaluator(resource);

    logger.debug('Ensured readiness evaluator for resource', {
      kind: resource.kind,
      name: resource.metadata?.name,
      hasEvaluator: typeof getReadinessEvaluator(resourceWithEvaluator) === 'function',
    });

    const resourceGraph = this.createResourceGraph(resourceWithEvaluator);

    const deploymentOptions = {
      ...options,
      mode: 'direct' as const,
      namespace: options.namespace || 'default',
      waitForReady: options.waitForReady ?? true,
      timeout: options.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
    };

    const result = await this.engine.deploy(resourceGraph, deploymentOptions);

    if (result.status === 'failed') {
      const firstError = result.errors[0]?.error;
      const deploymentError = new ResourceDeploymentError(
        resource.metadata?.name || 'unnamed',
        resource.kind || 'Unknown',
        firstError || new Error('Unknown deployment error')
      );
      // Add additional context from all errors
      if (result.errors.length > 1) {
        deploymentError.message += ` (and ${result.errors.length - 1} other errors)`;
      }
      throw deploymentError;
    }

    // Return the deployed resource with readiness evaluator
    return resourceWithEvaluator;
  }

  async delete<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void> {
    // Create a DeployedResource for the deleteResource method
    const deployedResource = {
      id: getResourceId(resource, 'unnamed'),
      kind: resource.kind || 'Unknown',
      name: resource.metadata?.name || 'unnamed',
      namespace: options.namespace || resource.metadata?.namespace || 'default',
      manifest: resource,
      status: 'deployed' as const,
      deployedAt: new Date(),
    };

    // Use the engine's unified deleteResource method
    await this.engine.deleteResource(deployedResource);
  }
}

/**
 * Kro deployment implementation using TypeKro's DirectDeploymentEngine
 * This leverages the same underlying deployment engine for consistency
 */
export class KroTypeKroDeployer implements TypeKroDeployer {
  constructor(
    private engine: import('../core/deployment/engine.js').DirectDeploymentEngine,
    private readonly deployerOptions: KroTypeKroDeployerOptions = {}
  ) {}

  async dispose(): Promise<void> {
    await this.engine.dispose();
  }

  async deploy<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<T> {
    const resourceId =
      resource.id ||
      generateDeterministicResourceId(
        resource.kind || 'Resource',
        resource.metadata?.name || 'unnamed',
        options.namespace
      );
    const deployableResource = resource as DeployableK8sResource<Enhanced<unknown, unknown>>;
    const dependencyGraph = new DependencyGraph();
    dependencyGraph.addNode(resourceId, deployableResource);

    // Convert single resource to ResourceGraph for DirectDeploymentEngine
    const resourceGraph: DeploymentResourceGraph = {
      name: resource.metadata?.name || 'unnamed-resource',
      resources: [
        {
          id: resourceId,
          manifest: deployableResource,
        },
      ],
      dependencyGraph,
    };

    const result = await this.engine.deploy(resourceGraph, options);

    if (result.status === 'failed') {
      const firstError = result.errors[0]?.error;
      const deploymentError = new ResourceDeploymentError(
        resource.metadata?.name || 'unnamed',
        resource.kind || 'Unknown',
        firstError || new Error('Unknown deployment error')
      );
      if (result.errors.length > 1) {
        deploymentError.message += ` (and ${result.errors.length - 1} other errors)`;
      }
      throw deploymentError;
    }

    // Return the original resource (DirectDeploymentEngine doesn't modify the input)
    return resource;
  }

  async delete<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void> {
    if (resource.kind === 'ResourceGraphDefinition') {
      logger.debug('Skipping Alchemy RGD delete; KRO instance deletion owns finalizer-safe cleanup', {
        name: resource.metadata?.name,
      });
      return;
    }

    const name = resource.metadata?.name || 'unnamed';
    if (this.deployerOptions.deleteInstance) {
      await this.deployerOptions.deleteInstance(name);
      return;
    }

    const namespace = options.namespace || resource.metadata?.namespace || 'default';
    const k8sApi = this.engine.getKubernetesApi();
    const deleteTarget = {
      apiVersion: resource.apiVersion,
      kind: resource.kind || 'Unknown',
      metadata: { name, namespace },
    };

    try {
      await k8sApi.delete(deleteTarget as any);
    } catch (error: unknown) {
      if (getKubernetesErrorCode(error) !== 404) {
        throw error;
      }
      return;
    }

    const timeout = options.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        await k8sApi.read(deleteTarget as any);
      } catch (error: unknown) {
        if (getKubernetesErrorCode(error) === 404) {
          return;
        }
        throw error;
      }
      await delay(2000);
    }

    logger.warn('KRO resource deletion still in progress; preserving RGD/CRD for finalizer processing', {
      kind: resource.kind,
      name,
      namespace,
      timeout,
    });
  }
}
