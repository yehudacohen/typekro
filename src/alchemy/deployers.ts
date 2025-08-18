/**
 * Alchemy Deployer Implementations
 * 
 * This module provides concrete implementations of TypeKroDeployer
 * for different deployment strategies (direct and Kro).
 */

import type { Enhanced } from '../core/types/kubernetes.js';
import type { DeploymentOptions, ResourceGraph } from '../core/types/deployment.js';
import type { DeployableK8sResource } from '../core/types/kubernetes.js';
import { DependencyGraph } from '../core/dependencies/index.js';
import { generateDeterministicResourceId } from '../utils/helpers.js';
import { ResourceDeploymentError } from '../core/types/deployment.js';
import type { TypeKroDeployer } from './types.js';
import { ensureReadinessEvaluator } from '../utils/helpers.js'
/**
 * Direct deployment implementation using TypeKro's DirectDeploymentEngine
 */
export class DirectTypeKroDeployer implements TypeKroDeployer {
    constructor(private engine: import('../core/deployment/engine.js').DirectDeploymentEngine) { }

    /**
     * Recreate readiness evaluator with proper closure context
     * This fixes the issue where JSON serialization breaks closures
     */
    private recreateReadinessEvaluator<T extends Enhanced<any, any>>(resource: T): T {
        // Only handle Deployment resources for now
        if (resource.kind !== 'Deployment') {
            return resource;
        }

        // Extract the expected replicas from the resource spec
        const expectedReplicas = (resource.spec as any)?.replicas || 1;

        // Create a new readiness evaluator with the correct closure
        const newReadinessEvaluator = (liveResource: any) => {
            try {
                const status = liveResource.status;

                // Handle missing status gracefully
                if (!status) {
                    return {
                        ready: false,
                        reason: 'StatusMissing',
                        message: 'Deployment status not available yet',
                        details: { expectedReplicas }
                    };
                }

                const readyReplicas = status.readyReplicas || 0;
                const availableReplicas = status.availableReplicas || 0;

                // Check if deployment is ready
                const ready = readyReplicas >= expectedReplicas && availableReplicas >= expectedReplicas;

                if (ready) {
                    return {
                        ready: true,
                        message: `Deployment has ${readyReplicas}/${expectedReplicas} ready replicas and ${availableReplicas}/${expectedReplicas} available replicas`
                    };
                } else {
                    return {
                        ready: false,
                        reason: 'ReplicasNotReady',
                        message: `Waiting for replicas: ${readyReplicas}/${expectedReplicas} ready, ${availableReplicas}/${expectedReplicas} available`,
                        details: {
                            expectedReplicas,
                            readyReplicas,
                            availableReplicas,
                            updatedReplicas: status.updatedReplicas || 0
                        }
                    };
                }
            } catch (error) {
                return {
                    ready: false,
                    reason: 'EvaluationError',
                    message: `Error evaluating deployment readiness: ${error}`,
                    details: { expectedReplicas, error: String(error) }
                };
            }
        };

        // Replace the readiness evaluator with the new one
        Object.defineProperty(resource, 'readinessEvaluator', {
            value: newReadinessEvaluator,
            enumerable: false,
            configurable: true,
            writable: false
        });

        return resource;
    }

    /**
     * Create a ResourceGraph for a single resource
     * This helper function reduces duplication between deploy and delete operations
     */
    private createResourceGraph<T extends Enhanced<any, any>>(resource: T): ResourceGraph {
        const resourceWithId = {
            ...resource,
            id: resource.id || resource.metadata?.name || 'unnamed'
        };

        // Preserve the readinessEvaluator function if it exists (it's non-enumerable)
        const originalResource = resource as any;
        if (originalResource.readinessEvaluator && typeof originalResource.readinessEvaluator === 'function') {
            Object.defineProperty(resourceWithId, 'readinessEvaluator', {
                value: originalResource.readinessEvaluator,
                enumerable: false,
                configurable: true,
                writable: false
            });
        }

        // Create a proper DependencyGraph instance
        const dependencyGraph = new DependencyGraph();
        dependencyGraph.addNode(resourceWithId.id, resourceWithId as any);

        return {
            name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
            resources: [{
                id: resourceWithId.id,
                manifest: resourceWithId as any
            }],
            dependencyGraph
        };
    }

    async deploy<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<T> {
        // Ensure the resource has a readiness evaluator using factory functions
        const resourceWithEvaluator = ensureReadinessEvaluator(resource);
        
        // Fix any broken closures in the readiness evaluator before deployment
        const resourceWithFixedEvaluator = this.recreateReadinessEvaluator(resourceWithEvaluator);
        
        const resourceGraph = this.createResourceGraph(resourceWithFixedEvaluator);

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
        return resourceWithFixedEvaluator;
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
    constructor(private engine: import('../core/deployment/engine.js').DirectDeploymentEngine) { }

    async deploy<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<T> {
        // Convert single resource to ResourceGraph for DirectDeploymentEngine
        const resourceGraph: ResourceGraph = {
            name: resource.metadata?.name || 'unnamed-resource',
            resources: [{
                id: resource.id || generateDeterministicResourceId(resource.kind || 'Resource', resource.metadata?.name || 'unnamed', options.namespace),
                manifest: resource as DeployableK8sResource<Enhanced<unknown, unknown>>
            }],
            dependencyGraph: new DependencyGraph()
        };

        const _result = await this.engine.deploy(resourceGraph, options);

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