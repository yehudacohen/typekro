/**
 * Alchemy Deployer Implementations
 *
 * This module provides concrete implementations of TypeKroDeployer
 * for different deployment strategies (direct and Kro).
 */

import { DependencyGraph } from '../core/dependencies/index.js';
import { getComponentLogger } from '../core/logging/index.js';
import type { DeploymentOptions, ResourceGraph } from '../core/types/deployment.js';
import { ResourceDeploymentError } from '../core/types/deployment.js';
import type { DeployableK8sResource, Enhanced } from '../core/types/kubernetes.js';
import { ensureReadinessEvaluator, generateDeterministicResourceId } from '../utils/helpers.js';
import type { TypeKroDeployer } from './types.js';

const logger = getComponentLogger('deployers');

/**
 * Direct deployment implementation using TypeKro's DirectDeploymentEngine
 */
export class DirectTypeKroDeployer implements TypeKroDeployer {
  constructor(private engine: import('../core/deployment/engine.js').DirectDeploymentEngine) {}

  /**
   * Create a ResourceGraph for a single resource
   * This helper function reduces duplication between deploy and delete operations
   */
  private createResourceGraph<T extends Enhanced<any, any>>(resource: T): ResourceGraph {
    const resourceWithId = {
      ...resource,
      id: resource.id || resource.metadata?.name || 'unnamed',
    };

    // Preserve the readinessEvaluator function if it exists (it's non-enumerable)
    const originalResource = resource as any;
    if (
      originalResource.readinessEvaluator &&
      typeof originalResource.readinessEvaluator === 'function'
    ) {
      Object.defineProperty(resourceWithId, 'readinessEvaluator', {
        value: originalResource.readinessEvaluator,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

    // Create a proper DependencyGraph instance
    const dependencyGraph = new DependencyGraph();
    dependencyGraph.addNode(resourceWithId.id, resourceWithId as any);

    return {
      name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
      resources: [
        {
          id: resourceWithId.id,
          manifest: resourceWithId as any,
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
      hasEvaluator: typeof (resourceWithEvaluator as any).readinessEvaluator === 'function',
    });

    const resourceGraph = this.createResourceGraph(resourceWithEvaluator);

    const deploymentOptions = {
      mode: 'direct' as const,
      namespace: options.namespace || 'default',
      waitForReady: options.waitForReady ?? true,
      timeout: options.timeout ?? 300000,
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
      id: resource.id || resource.metadata?.name || 'unnamed',
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
  constructor(private engine: import('../core/deployment/engine.js').DirectDeploymentEngine) {}

  async deploy<T extends Enhanced<any, any>>(resource: T, options: DeploymentOptions): Promise<T> {
    // Convert single resource to ResourceGraph for DirectDeploymentEngine
    const resourceGraph: ResourceGraph = {
      name: resource.metadata?.name || 'unnamed-resource',
      resources: [
        {
          id:
            resource.id ||
            generateDeterministicResourceId(
              resource.kind || 'Resource',
              resource.metadata?.name || 'unnamed',
              options.namespace
            ),
          manifest: resource as DeployableK8sResource<Enhanced<unknown, unknown>>,
        },
      ],
      dependencyGraph: new DependencyGraph(),
    };

    await this.engine.deploy(resourceGraph, options);

    // Return the original resource (DirectDeploymentEngine doesn't modify the input)
    return resource;
  }

  async delete<T extends Enhanced<any, any>>(
    resource: T,
    options: DeploymentOptions
  ): Promise<void> {
    // Create a DeployedResource for the deleteResource method
    const deployedResource = {
      id: resource.id || resource.metadata?.name || 'unnamed',
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
