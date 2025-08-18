/**
 * Alchemy Resource Type Registration
 * 
 * This module handles dynamic resource type registration for TypeKro
 * resources with alchemy's resource management system.
 * 
 * Uses ensureResourceTypeRegistered() to avoid "Resource already exists" errors
 * and provides centralized type registration logic.
 */

import { Resource, PROVIDERS, type Context } from 'alchemy';
import { type TypeKroLogger, getComponentLogger } from '../core/logging/index.js';
import { 
    createKubernetesClientProvider,
} from '../core/kubernetes/client-provider.js';
import type { Enhanced } from '../core/types/kubernetes.js';
import { DirectTypeKroDeployer, KroTypeKroDeployer } from './deployers.js';
import { inferAlchemyTypeFromTypeKroResource } from './type-inference.js';
import type { TypeKroResourceProps, TypeKroResource, TypeKroDeployer } from './types.js';
import type { KubeConfig } from '@kubernetes/client-node';

// Global registry to track registered resource types
const REGISTERED_TYPES = new Map<string, unknown>();

/**
 * Dynamic registration function with full type safety
 * 
 * This function ensures each resource type is registered only once,
 * avoiding "Resource already exists" errors while maintaining type safety.
 */
export function ensureResourceTypeRegistered<T extends Enhanced<unknown, unknown>>(
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
                // Create kubeconfig and deployer using centralized provider
                const kc = _createClientProvider(props, 'deployment');
                const deployer = await _createDeployer(kc, props.deploymentStrategy);

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
 * Create KubernetesClientProvider using centralized configuration management
 * Eliminates complex multi-stage fallback logic and consolidates TLS handling
 */
function _createClientProvider<T extends Enhanced<unknown, unknown>>(
    props: TypeKroResourceProps<T>, 
    phase: string
): KubeConfig {
    const alchemyLogger = getComponentLogger('alchemy-deployment');
    
    alchemyLogger.debug(`Creating KubernetesClientProvider for alchemy handler (${phase} phase)`, {
        hasKubeConfigOptions: !!props.kubeConfigOptions,
        skipTLSVerify: props.kubeConfigOptions?.skipTLSVerify,
        hasCluster: !!props.kubeConfigOptions?.cluster,
        hasUser: !!props.kubeConfigOptions?.user,
    });

    // Use the centralized KubernetesClientProvider with the provided configuration
    const clientProvider = createKubernetesClientProvider(props.kubeConfigOptions);
    
    // Get the configured KubeConfig from the provider
    const kubeConfig = clientProvider.getKubeConfig();
    
    alchemyLogger.debug(`KubernetesClientProvider created successfully (${phase} phase)`, {
        currentContext: kubeConfig.getCurrentContext(),
        server: kubeConfig.getCurrentCluster()?.server,
        skipTLSVerify: kubeConfig.getCurrentCluster()?.skipTLSVerify,
    });

    return kubeConfig;
}

/**
 * Create the appropriate deployer based on the deployment strategy
 */
async function _createDeployer<_T extends Enhanced<unknown, unknown>>(
    kc: import('@kubernetes/client-node').KubeConfig, 
    strategy: 'direct' | 'kro'
): Promise<TypeKroDeployer> {
    // Use dynamic import to avoid circular dependencies
    const { DirectDeploymentEngine } = await import('../core/deployment/engine.js');
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
async function _handleResourceDeletion<T extends Enhanced<unknown, unknown>>(
    context: Context<TypeKroResource<T>>,
    props: TypeKroResourceProps<T>,
    logger: TypeKroLogger
): Promise<TypeKroResource<T>> {
    try {
        const kc = _createClientProvider(props, 'delete');
        const deployer = await _createDeployer(kc, props.deploymentStrategy);

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
async function _deployAndCreateResult<T extends Enhanced<unknown, unknown>>(
    props: TypeKroResourceProps<T>,
    deployer: TypeKroDeployer
): Promise<{ resourceProperties: any }> {
    // Deploy using the created deployer - pass the original resource with KubernetesRef objects
    // The deployer will handle reference resolution internally
    const deployedResource = await deployer.deploy(props.resource, {
        mode: 'alchemy' as const,
        namespace: props.namespace,
        waitForReady: props.options?.waitForReady ?? true,
        timeout: props.options?.timeout ?? 300000,
    });

    // Create clean, serializable versions for Alchemy storage
    // Only serialize the data that Alchemy needs to store, not the functional parts
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
function _logDeploymentSuccess<T extends Enhanced<unknown, unknown>>(
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
function _executeAlchemyContext<T extends Enhanced<unknown, unknown>>(
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

/**
 * Clear the registered types cache (useful for testing)
 */
export function clearRegisteredTypes(): void {
    REGISTERED_TYPES.clear();
}