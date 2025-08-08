/**
 * Alchemy Dynamic Resource Registration
 * 
 * This module provides dynamic resource type registration for TypeKro
 * resources with alchemy's resource management system.
 * 
 * Uses ensureResourceTypeRegistered() to avoid "Resource already exists" errors
 * and provides centralized deployment logic through TypeKroDeployer interface.
 */

import type { Context, Resource as AlchemyResource } from 'alchemy';
import { Resource, PROVIDERS } from 'alchemy';
import { getComponentLogger } from '../core/logging/index.js';
import type { Enhanced } from '../core/types/kubernetes.js';
import type { DeploymentOptions } from '../core/types/deployment.js';
import type { DirectDeploymentEngine } from '../core/deployment/engine.js';
import type { KroDeploymentEngine } from '../factories/kro/deployment-engine.js';
import { generateDeterministicResourceId } from '../utils/helpers.js';

// Global registry to track registered resource types
const REGISTERED_TYPES = new Map<string, any>();

/**
 * Centralized deployment interface that abstracts deployment logic
 */
export interface TypeKroDeployer {
    /**
     * Deploy a TypeKro resource to Kubernetes
     */
    deploy<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<T>;

    /**
     * Delete a TypeKro resource from Kubernetes
     */
    delete<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<void>;
}

/**
 * Properties for creating or updating a TypeKro resource through alchemy
 */
export interface TypeKroResourceProps<T extends Enhanced<any, any>> {
    /**
     * The TypeKro Enhanced resource to deploy
     */
    resource: T;

    /**
     * The namespace to deploy the resource to
     */
    namespace: string;

    /**
     * The deployer instance to use for deployment operations
     */
    deployer: TypeKroDeployer;

    /**
     * Optional deployment options
     */
    options?: {
        waitForReady?: boolean;
        timeout?: number;
    };
}

/**
 * Output returned after TypeKro resource deployment through alchemy
 * Following alchemy pattern: interface name matches exported resource name
 */
export interface TypeKroResource<T extends Enhanced<any, any>> extends AlchemyResource<string> {
    /**
     * The original TypeKro resource
     */
    resource: T;

    /**
     * The namespace the resource was deployed to
     */
    namespace: string;

    /**
     * The deployed resource with live status from the cluster
     */
    deployedResource: T;

    /**
     * Whether the resource is ready and available
     */
    ready: boolean;

    /**
     * Deployment timestamp
     */
    deployedAt: number;
}

/**
 * Dynamic registration function with full type safety
 * 
 * This function ensures each resource type is registered only once,
 * avoiding "Resource already exists" errors while maintaining type safety.
 */
export function ensureResourceTypeRegistered<T extends Enhanced<any, any>>(
    resource: T
): any {
    const alchemyType = inferAlchemyTypeFromTypeKroResource(resource);

    // Check if already registered in our local cache
    if (REGISTERED_TYPES.has(alchemyType)) {
        return REGISTERED_TYPES.get(alchemyType)!;
    }

    // Check if already registered in alchemy's global registry
    if (PROVIDERS.has(alchemyType)) {
        const existingProvider = PROVIDERS.get(alchemyType);
        REGISTERED_TYPES.set(alchemyType, existingProvider);
        return existingProvider;
    }

    // Register new resource type following alchemy's pseudo-class pattern
    const ResourceProvider = Resource(
        alchemyType,
        async function (
            this: Context<TypeKroResource<T>>,
            _id: string,
            props: TypeKroResourceProps<T>
        ): Promise<TypeKroResource<T>> {
            const alchemyLogger = getComponentLogger('alchemy-deployment').child({ alchemyType });
            
            if (this.phase === 'delete') {
                try {
                    // Use centralized deployer for deletion
                    await props.deployer.delete(props.resource, {
                        mode: 'alchemy' as const,
                        namespace: props.namespace,
                        ...props.options
                    });
                } catch (error) {
                    alchemyLogger.error('Error deleting resource', error as Error);
                }
                return this.destroy();
            }

            // Deploy using centralized deployer
            const deployedResource = await props.deployer.deploy(props.resource, {
                mode: 'alchemy' as const,
                namespace: props.namespace,
                waitForReady: props.options?.waitForReady ?? true,
                timeout: props.options?.timeout ?? 300000,
            });

            return this({
                resource: props.resource,
                namespace: props.namespace,
                deployedResource,
                ready: true,
                deployedAt: Date.now(),
            });
        }
    );

    // Cache the registered provider
    REGISTERED_TYPES.set(alchemyType, ResourceProvider);

    return ResourceProvider;
}

/**
 * Type-safe inference function that determines alchemy type from TypeKro resource
 */
export function inferAlchemyTypeFromTypeKroResource<T extends Enhanced<any, any>>(
    resource: T
): string {
    if (resource.apiVersion === 'kro.run/v1alpha1' && resource.kind === 'ResourceGraphDefinition') {
        return 'kro::ResourceGraphDefinition';
    }

    if (resource.apiVersion?.includes('kro.run')) {
        return `kro::${resource.kind}`;
    }

    return `kubernetes::${resource.kind}`;
}

/**
 * Direct deployment implementation using TypeKro's DirectDeploymentEngine
 */
export class DirectTypeKroDeployer implements TypeKroDeployer {
    constructor(private engine: DirectDeploymentEngine) { }

    async deploy<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<T> {
        // Create a resource graph for this single resource
        const resourceWithId = {
            ...resource,
            id: resource.id || resource.metadata?.name || 'unnamed'
        };

        const resourceGraph = {
            name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
            resources: [resourceWithId as any],
            dependencyGraph: { nodes: [resourceWithId], edges: [] }
        };

        const deploymentOptions = {
            mode: 'direct' as const,
            namespace: options.namespace || 'default',
            waitForReady: options.waitForReady ?? true,
            timeout: options.timeout ?? 300000,
        };

        const result = await this.engine.deploy(resourceGraph, deploymentOptions);

        if (result.status === 'failed') {
            throw new Error(`Deployment failed: ${result.errors.map(e => e.error.message).join(', ')}`);
        }

        // Return the deployed resource (in a real implementation, this would have updated status)
        return resource;
    }

    async delete<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<void> {
        // Create a resource graph for deletion
        const resourceGraph = {
            name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
            resources: [resource],
            dependencyGraph: { nodes: [resource], edges: [] }
        };

        const _deploymentOptions = {
            mode: 'direct' as const,
            namespace: options.namespace || 'default',
        };

        // Use the engine's rollback functionality for deletion
        await this.engine.rollback(resourceGraph.name);
    }
}

/**
 * Kro deployment implementation using TypeKro's KroDeploymentEngine
 */
export class KroTypeKroDeployer implements TypeKroDeployer {
    constructor(private engine: KroDeploymentEngine) { }

    async deploy<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<T> {
        return this.engine.deployResource(resource, options);
    }

    async delete<T extends Enhanced<any, any>>(
        resource: T,
        options: DeploymentOptions
    ): Promise<void> {
        await this.engine.deleteResource(resource, options);
    }
}

/**
 * Utility function to create deterministic resource IDs for alchemy resources
 */
export function createAlchemyResourceId<T extends Enhanced<any, any>>(
    resource: T,
    namespace?: string
): string {
    const kind = resource.kind || 'Resource';
    const name = resource.metadata?.name || 'unnamed';

    return generateDeterministicResourceId(kind, name, namespace);
}

/**
 * Clear the registered types cache (useful for testing)
 */
export function clearRegisteredTypes(): void {
    REGISTERED_TYPES.clear();
}