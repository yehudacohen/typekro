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
import * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../core/logging/index.js';
import type { Enhanced, DeployableK8sResource } from '../core/types/kubernetes.js';
import type { DeploymentOptions, ResourceGraph } from '../core/types/deployment.js';
import { DirectDeploymentEngine } from '../core/deployment/engine.js';
import { DependencyGraph } from '../core/dependencies/index.js';
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
 * Serializable kubeConfig options that can be passed through Alchemy
 */
export interface SerializableKubeConfigOptions {
    /**
     * SECURITY WARNING: Only set to true in non-production environments.
     * This disables TLS certificate verification and makes connections vulnerable
     * to man-in-the-middle attacks.
     * 
     * @default false (secure by default)
     */
    skipTLSVerify?: boolean;

    /**
     * Custom cluster server URL (optional)
     */
    server?: string;

    /**
     * Custom context name (optional)
     */
    context?: string;

    /**
     * Complete cluster configuration (optional)
     */
    cluster?: {
        name: string;
        server: string;
        skipTLSVerify?: boolean;
        caData?: string;
        caFile?: string;
    };

    /**
     * Complete user configuration (optional)
     */
    user?: {
        name: string;
        token?: string;
        certData?: string;
        certFile?: string;
        keyData?: string;
        keyFile?: string;
    };
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
     * The deployment strategy to use
     */
    deploymentStrategy: 'direct' | 'kro';

    /**
     * Serializable kubeConfig options
     */
    kubeConfigOptions?: SerializableKubeConfigOptions;

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

    /**
     * Centralized kubeconfig creation helper function
     * Eliminates code duplication between deployment and delete phases
     */
    function _buildKubeConfig(props: TypeKroResourceProps<T>, phase: string): k8s.KubeConfig {
        const alchemyLogger = getComponentLogger('alchemy-deployment');
        const kc = new k8s.KubeConfig();
        
        alchemyLogger.debug(`Received kubeconfig options in alchemy handler (${phase} phase)`, {
            hasKubeConfigOptions: !!props.kubeConfigOptions,
            skipTLSVerify: props.kubeConfigOptions?.skipTLSVerify,
            hasCluster: !!props.kubeConfigOptions?.cluster,
            hasUser: !!props.kubeConfigOptions?.user,
            kubeConfigOptions: JSON.stringify(props.kubeConfigOptions, null, 2)
        });
        
        // If complete cluster/user configuration is provided, use it directly
        if (props.kubeConfigOptions?.cluster && props.kubeConfigOptions?.user) {
            // Create kubeconfig from provided cluster and user configuration
            const clusterConfig = props.kubeConfigOptions.cluster;
            const userConfig = props.kubeConfigOptions.user;
            const contextName = props.kubeConfigOptions.context || 'alchemy-context';

            kc.clusters = [{
                name: clusterConfig.name,
                server: clusterConfig.server,
                ...(clusterConfig.skipTLSVerify !== undefined && { skipTLSVerify: clusterConfig.skipTLSVerify }),
                ...(clusterConfig.caData && { caData: clusterConfig.caData }),
                ...(clusterConfig.caFile && { caFile: clusterConfig.caFile }),
            }];

            kc.users = [{
                name: userConfig.name,
                ...(userConfig.token && { token: userConfig.token }),
                ...(userConfig.certData && { certData: userConfig.certData }),
                ...(userConfig.certFile && { certFile: userConfig.certFile }),
                ...(userConfig.keyData && { keyData: userConfig.keyData }),
                ...(userConfig.keyFile && { keyFile: userConfig.keyFile }),
            }];

            kc.contexts = [{
                name: contextName,
                cluster: clusterConfig.name,
                user: userConfig.name,
            }];

            kc.setCurrentContext(contextName);
        } else {
            // Fallback to loading from default and applying options
            kc.loadFromDefault();

            // Apply serializable kubeConfig options if provided
            if (props.kubeConfigOptions) {
                const cluster = kc.getCurrentCluster();

                if (props.kubeConfigOptions.skipTLSVerify && cluster) {
                    const modifiedCluster = { ...cluster, skipTLSVerify: true };
                    kc.clusters = kc.clusters.map((c) => (c === cluster ? modifiedCluster : c));
                }

                if (props.kubeConfigOptions.server && cluster) {
                    // Create a new cluster object with the updated server
                    const updatedCluster = { ...cluster, server: props.kubeConfigOptions.server };
                    kc.clusters = kc.clusters.map((c) => (c === cluster ? updatedCluster : c));
                }

                if (props.kubeConfigOptions.context) {
                    kc.setCurrentContext(props.kubeConfigOptions.context);
                }
            }
        }

        return kc;
    }

    /**
     * Create the appropriate deployer based on the deployment strategy
     */
    function _createDeployer(kc: k8s.KubeConfig, strategy: 'direct' | 'kro'): TypeKroDeployer {
        const engine = new DirectDeploymentEngine(kc);
        
        if (strategy === 'direct') {
            return new DirectTypeKroDeployer(engine);
        } else {
            return new KroTypeKroDeployer(engine);
        }
    }

    /**
     * Handle resource deletion phase
     */
    async function _handleResourceDeletion(
        context: Context<TypeKroResource<T>>,
        props: TypeKroResourceProps<T>,
        logger: any
    ): Promise<TypeKroResource<T>> {
        try {
            const kc = _buildKubeConfig(props, 'delete');
            const deployer = _createDeployer(kc, props.deploymentStrategy);

            await deployer.delete(props.resource, {
                mode: 'alchemy' as const,
                namespace: props.namespace,
                ...props.options
            });
        } catch (error) {
            logger.error('Error deleting resource', error as Error);
        }
        return context.destroy();
    }

    /**
     * Deploy resource and create deployment result
     */
    async function _deployAndCreateResult(
        props: TypeKroResourceProps<T>,
        deployer: TypeKroDeployer
    ): Promise<{ resourceProperties: any }> {
        // Deploy using the created deployer
        const deployedResource = await deployer.deploy(props.resource, {
            mode: 'alchemy' as const,
            namespace: props.namespace,
            waitForReady: props.options?.waitForReady ?? true,
            timeout: props.options?.timeout ?? 300000,
        });

        // Create clean, serializable versions of the resources for Alchemy
        // Strip out any non-serializable objects like loggers, proxies, etc.
        const cleanResource = JSON.parse(JSON.stringify(props.resource));
        const cleanDeployedResource = JSON.parse(JSON.stringify(deployedResource));

        // Create the resource properties for Alchemy
        const resourceProperties = {
            resource: cleanResource,
            namespace: props.namespace,
            deployedResource: cleanDeployedResource,
            ready: true,
            deployedAt: Date.now(),
        };

        return { resourceProperties };
    }

    /**
     * Log deployment success and context details
     */
    function _logDeploymentSuccess(
        logger: any,
        alchemyType: string,
        props: TypeKroResourceProps<T>,
        resourceProperties: any,
        context: Context<TypeKroResource<T>>
    ): void {
        // Log successful deployment
        logger.debug('Successfully deployed resource through Alchemy', {
            alchemyType,
            resourceKind: props.resource.kind,
            resourceName: props.resource.metadata?.name,
            namespace: props.namespace,
            resourceProperties: {
                hasResource: !!resourceProperties.resource,
                hasNamespace: !!resourceProperties.namespace,
                hasDeployedResource: !!resourceProperties.deployedResource,
                ready: resourceProperties.ready,
                deployedAt: resourceProperties.deployedAt,
            },
        });

        // Log the exact data we're about to pass to Alchemy's context function
        logger.debug('About to call Alchemy context function', {
            alchemyType,
            contextPhase: context.phase,
            contextId: context.id,
            contextFqn: context.fqn,
            resourcePropertiesKeys: Object.keys(resourceProperties),
            resourcePropertiesStringified: JSON.stringify(resourceProperties, (_key, value) => {
                // Handle circular references and complex objects
                if (typeof value === 'object' && value !== null) {
                    if (value.constructor && value.constructor.name !== 'Object') {
                        return `[${value.constructor.name}]`;
                    }
                }
                return value;
            }, 2),
        });
    }

    /**
     * Execute Alchemy context function with proper error handling
     */
    function _executeAlchemyContext(
        context: Context<TypeKroResource<T>>,
        resourceProperties: any,
        logger: any,
        alchemyType: string
    ): TypeKroResource<T> {
        try {
            const result = context(resourceProperties);

            logger.debug('Alchemy context function returned successfully', {
                alchemyType,
                resultType: typeof result,
                resultKeys: result ? Object.keys(result) : [],
                hasAlchemySymbols: result ? Object.getOwnPropertySymbols(result).length > 0 : false,
            });

            return result;
        } catch (contextError) {
            logger.error('Alchemy context function failed', contextError as Error, {
                alchemyType,
                errorMessage: (contextError as Error).message,
                errorStack: (contextError as Error).stack,
            });
            throw contextError;
        }
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

            // Log the context details for debugging
            alchemyLogger.debug('Alchemy resource handler called', {
                alchemyType,
                resourceId: _id,
                phase: this.phase,
                contextId: this.id,
                contextFqn: this.fqn,
                resourceKind: props.resource.kind,
                resourceName: props.resource.metadata?.name,
            });

            // Handle deletion phase
            if (this.phase === 'delete') {
                return await _handleResourceDeletion(this, props, alchemyLogger);
            }

            try {
                // Create kubeconfig and deployer
                const kc = _buildKubeConfig(props, 'deployment');
                const deployer = _createDeployer(kc, props.deploymentStrategy);

                // Deploy resource and create result
                const { resourceProperties } = await _deployAndCreateResult(props, deployer);

                // Log deployment success
                _logDeploymentSuccess(alchemyLogger, alchemyType, props, resourceProperties, this);

                // Execute Alchemy context function
                return _executeAlchemyContext(this, resourceProperties, alchemyLogger, alchemyType);
            } catch (error) {
                alchemyLogger.error('Error deploying resource through Alchemy', error as Error);
                throw error;
            }
        }
    );

    // Cache the registered provider
    REGISTERED_TYPES.set(alchemyType, ResourceProvider);

    return ResourceProvider;
}

/**
 * Reserved resource type names that cannot be used
 */
const RESERVED_RESOURCE_TYPE_NAMES = new Set([
    'Resource',
    'Provider',
    'Context',
    'State',
    'Config',
    'Alchemy',
    'TypeKro',
]);

/**
 * Validation rules for resource type names
 */
const RESOURCE_TYPE_VALIDATION = {
    maxLength: 100,
    allowedCharacters: /^[a-zA-Z][a-zA-Z0-9]*$/,
    reservedNames: RESERVED_RESOURCE_TYPE_NAMES,
};

/**
 * Validate resource type naming patterns
 */
function validateResourceTypeName(kind: string): void {
    if (!kind) {
        throw new Error('Resource kind is required for type inference');
    }

    if (kind.length > RESOURCE_TYPE_VALIDATION.maxLength) {
        throw new Error(`Resource kind '${kind}' exceeds maximum length of ${RESOURCE_TYPE_VALIDATION.maxLength} characters`);
    }

    if (!RESOURCE_TYPE_VALIDATION.allowedCharacters.test(kind)) {
        throw new Error(`Resource kind '${kind}' contains invalid characters. Only alphanumeric characters are allowed, starting with a letter.`);
    }

    if (RESOURCE_TYPE_VALIDATION.reservedNames.has(kind)) {
        throw new Error(`Resource kind '${kind}' is a reserved name and cannot be used`);
    }
}

/**
 * Type-safe inference function that determines alchemy type from TypeKro resource
 * Enhanced to handle individual Kubernetes resources with proper validation
 */
export function inferAlchemyTypeFromTypeKroResource<T extends Enhanced<any, any>>(
    resource: T
): string {
    // Validate that the resource has a kind
    if (!resource.kind) {
        throw new Error('Resource must have a kind field for Alchemy type inference');
    }

    // Validate the resource kind naming patterns
    validateResourceTypeName(resource.kind);

    // Handle Kro ResourceGraphDefinitions
    if (resource.apiVersion === 'kro.run/v1alpha1' && resource.kind === 'ResourceGraphDefinition') {
        return 'kro::ResourceGraphDefinition';
    }

    // Handle Kro custom resources
    if (resource.apiVersion?.includes('kro.run')) {
        return `kro::${resource.kind}`;
    }

    // Handle individual Kubernetes resources
    // This ensures proper naming like kubernetes::Deployment, kubernetes::Service, etc.
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

        // Create a proper DependencyGraph instance
        const dependencyGraph = new DependencyGraph();
        dependencyGraph.addNode(resourceWithId.id, resourceWithId as any);

        const resourceGraph = {
            name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
            resources: [{
                id: resourceWithId.id,
                manifest: resourceWithId as any
            }],
            dependencyGraph
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
        _options: DeploymentOptions
    ): Promise<void> {
        // Create a resource graph for deletion
        // Create a proper DependencyGraph instance
        const dependencyGraph = new DependencyGraph();
        const resourceId = resource.id || resource.metadata?.name || 'unnamed';
        dependencyGraph.addNode(resourceId, resource as any);

        const resourceGraph = {
            name: `${resource.kind?.toLowerCase()}-${resource.metadata?.name || 'unnamed'}`,
            resources: [{
                id: resourceId,
                manifest: resource as any
            }],
            dependencyGraph
        };

        // Use the engine's rollback functionality for deletion
        await this.engine.rollback(resourceGraph.name);
    }
}

/**
 * Kro deployment implementation using TypeKro's DirectDeploymentEngine
 * This leverages the same underlying deployment engine for consistency
 */
export class KroTypeKroDeployer implements TypeKroDeployer {
    constructor(private engine: DirectDeploymentEngine) { }

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
        // For deletion, we can use the k8s API directly since DirectDeploymentEngine
        // doesn't have a single resource delete method
        const k8sApi = this.engine.getKubernetesApi(); // Use public getter method
        
        try {
            await k8sApi.delete({
                apiVersion: resource.apiVersion,
                kind: resource.kind,
                metadata: {
                    name: resource.metadata?.name,
                    namespace: options.namespace || 'default',
                },
            } as any);
        } catch (error: any) {
            if (error.statusCode !== 404) {
                throw new Error(`Failed to delete ${resource.kind}/${resource.metadata?.name}: ${error.message}`);
            }
            // Resource already deleted, ignore 404
        }
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