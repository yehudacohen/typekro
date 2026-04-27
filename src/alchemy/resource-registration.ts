/**
 * Alchemy Resource Type Registration
 *
 * This module handles dynamic resource type registration for TypeKro
 * resources with alchemy's resource management system.
 *
 * Uses ensureResourceTypeRegistered() to avoid "Resource already exists" errors
 * and provides centralized type registration logic.
 */

import type { KubeConfig } from '@kubernetes/client-node';
import { type Context, PROVIDERS, Resource } from 'alchemy';
import { DEFAULT_DEPLOYMENT_TIMEOUT } from '../core/config/defaults.js';
import { ensureError } from '../core/errors.js';
import { createKubernetesClientProvider } from '../core/kubernetes/client-provider.js';
import { getComponentLogger, type TypeKroLogger } from '../core/logging/index.js';
import type { DeploymentOptions } from '../core/types/deployment.js';
import type { Enhanced } from '../core/types/kubernetes.js';
import {
  DirectTypeKroDeployer,
  KroTypeKroDeployer,
  ResourceGraphDefinitionDeletionDeferredError,
} from './deployers.js';
import { deleteKroDefinition, deleteKroInstanceFinalizerSafe, hasKroInstances } from './kro-delete.js';
import type { KroDeletionOptions } from './kro-delete.js';
import { inferAlchemyTypeFromTypeKroResource } from './type-inference.js';
import type { TypeKroDeployer, TypeKroResource, TypeKroResourceProps } from './types.js';

/**
 * Serializable resource properties stored by Alchemy after deployment.
 * These are the clean, cloneable fields that represent deployed state.
 */
interface DeployedResourceProperties<T extends Enhanced<unknown, unknown>> {
  resource: T;
  namespace: string;
  deployedResource: T;
  ready: boolean;
  deployedAt: number;
}

// Global registry to track registered resource types
const REGISTERED_TYPES = new Map<string, unknown>();

/**
 * Dynamic registration function with full type safety
 *
 * This function ensures each resource type is registered only once,
 * avoiding "Resource already exists" errors while maintaining type safety.
 */
// Return type is intentionally `any` because alchemy's Provider/Handler types have complex
// `this` context bindings (Context<any, any>) that cannot be cleanly represented without `any`.
// Callers invoke the returned provider as a regular function, but alchemy's internal types
// require `this: Context<...>` which is bound at runtime by the alchemy framework.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        const { deployer, dispose } = await _resolveDeployer(props, 'deployment');

        try {
          // Deploy resource and create result
          const { resourceProperties } = await _deployAndCreateResult(props, deployer);

          // Log deployment success
          _logDeploymentSuccess(alchemyLogger, alchemyType, props, resourceProperties, this);

          // Execute Alchemy context function
          return _executeAlchemyContext(this, resourceProperties, alchemyLogger, alchemyType);
        } finally {
          await dispose();
        }
      } catch (error: unknown) {
        alchemyLogger.error('Error deploying resource through Alchemy', ensureError(error));
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
async function _createDeployer<T extends Enhanced<unknown, unknown>>(
  kc: import('@kubernetes/client-node').KubeConfig,
  props: TypeKroResourceProps<T>
): Promise<TypeKroDeployer> {
  // Use dynamic import to avoid circular dependencies
  const { DirectDeploymentEngine } = await import('../core/deployment/engine.js');
  const engine = new DirectDeploymentEngine(kc);

  if (props.deploymentStrategy === 'direct') {
    return new DirectTypeKroDeployer(engine);
  }

  const kroDeletion = props.kroDeletion ?? inferKroDeletionOptions(props);
  return new KroTypeKroDeployer(engine, kroDeletion ? {
    deleteInstance: (name: string) => deleteKroInstanceFinalizerSafe(kc, name, kroDeletion),
    shouldSkipRgdDelete: () => hasKroInstances(kc, kroDeletion),
    deleteResourceGraphDefinition: () => deleteKroDefinition(kc, kroDeletion),
  } : {});
}

function fullApiVersion(apiVersion: unknown, group: unknown): string | undefined {
  if (typeof apiVersion !== 'string' || apiVersion.length === 0) return undefined;
  if (apiVersion.includes('/')) return apiVersion;
  return typeof group === 'string' && group.length > 0 ? `${group}/${apiVersion}` : apiVersion;
}

function apiGroup(apiVersion: unknown): string | undefined {
  return typeof apiVersion === 'string' && apiVersion.includes('/')
    ? apiVersion.split('/')[0]
    : undefined;
}

function inferKroDeletionOptions<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): KroDeletionOptions | undefined {
  if (props.deploymentStrategy !== 'kro') return undefined;

  const resource = props.resource as {
    apiVersion?: unknown;
    kind?: unknown;
    metadata?: {
      name?: unknown;
      namespace?: unknown;
      labels?: Record<string, unknown>;
    };
    spec?: { schema?: { apiVersion?: unknown; group?: unknown; kind?: unknown } };
  };

  if (resource.kind === 'ResourceGraphDefinition') {
    const schema = resource.spec?.schema;
    const apiVersion = fullApiVersion(schema?.apiVersion, schema?.group);
    if (
      typeof resource.metadata?.name !== 'string' ||
      typeof schema?.kind !== 'string' ||
      !apiVersion
    ) {
      return undefined;
    }

    return {
      apiVersion,
      kind: schema.kind,
      ...(typeof schema.group === 'string' && { group: schema.group }),
      namespace: typeof resource.metadata.namespace === 'string' ? resource.metadata.namespace : props.namespace,
      rgdName: resource.metadata.name,
      timeout: props.options?.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
    };
  }

  const rgdName = resource.metadata?.labels?.['typekro.io/rgd'];
  if (
    typeof rgdName !== 'string' ||
    typeof resource.apiVersion !== 'string' ||
    typeof resource.kind !== 'string'
  ) {
    return undefined;
  }

  const group = apiGroup(resource.apiVersion);
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    ...(group && { group }),
    namespace: typeof resource.metadata?.namespace === 'string' ? resource.metadata.namespace : props.namespace,
    rgdName,
    timeout: props.options?.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
  };
}

/** Internal test hook for legacy Alchemy KRO state rehydration. */
export const inferKroDeletionOptionsForTest = inferKroDeletionOptions;

async function _resolveDeployer<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  phase: string
): Promise<{ deployer: TypeKroDeployer; dispose: () => Promise<void> }> {
  if (props.deployer) {
    return { deployer: props.deployer, dispose: async () => {} };
  }

  const kc = _createClientProvider(props, phase);
  const deployer = await _createDeployer(kc, props);
  return {
    deployer,
    dispose: async () => {
      await deployer.dispose?.();
    },
  };
}

/**
 * Handle resource deletion phase
 */
async function _handleResourceDeletion<T extends Enhanced<unknown, unknown>>(
  context: Context<TypeKroResource<T>>,
  props: TypeKroResourceProps<T>,
  logger: TypeKroLogger
): Promise<TypeKroResource<T>> {
  const { deployer, dispose } = await _resolveDeployer(props, 'delete');
  try {
    await deployer.delete(props.resource, {
      mode: 'alchemy' as const,
      namespace: props.namespace,
      ...props.options,
    });
  } catch (error: unknown) {
    if (error instanceof ResourceGraphDefinitionDeletionDeferredError) {
      logger.debug('Deferring Alchemy state deletion for ResourceGraphDefinition', {
        resourceName: props.resource.metadata?.name,
        reason: error.message,
      });
      return {
        ...context,
        resource: props.resource,
        namespace: props.namespace,
        deployedResource: props.resource,
        ready: false,
        deployedAt: Date.now(),
      } as unknown as TypeKroResource<T>;
    }
    logger.error('Error deleting resource', ensureError(error));
    throw error;
  } finally {
    await dispose();
  }
  return context.destroy();
}

/** Internal test hook for deletion semantics. */
export const handleResourceDeletionForTest = _handleResourceDeletion;

/**
 * Deploy resource and create deployment result
 */
async function _deployAndCreateResult<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>,
  deployer: TypeKroDeployer
): Promise<{ resourceProperties: DeployedResourceProperties<T> }> {
  const deploymentOptions = buildAlchemyDeploymentOptions(props);

  // Deploy using the created deployer - pass the original resource with KubernetesRef objects
  // The deployer will handle reference resolution internally
  const deployedResource = await deployer.deploy(props.resource, deploymentOptions);

  // Create clean, serializable versions for Alchemy storage.
  // We use JSON.parse(JSON.stringify()) deliberately instead of structuredClone because:
  // 1. Enhanced<> resources contain non-cloneable values (Symbols like pino.chindings,
  //    KUBERNETES_REF_BRAND, plus functions like readinessEvaluator) that cause
  //    structuredClone to throw "Cannot serialize unique symbol" errors.
  // 2. JSON round-trip strips symbols, functions, and undefined values — which is
  //    exactly the behavior we want for creating clean Alchemy state entries.
  const cleanResource = JSON.parse(JSON.stringify(props.resource)) as T;
  const cleanDeployedResource = JSON.parse(JSON.stringify(deployedResource)) as T;

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

export function buildAlchemyDeploymentOptions<T extends Enhanced<unknown, unknown>>(
  props: TypeKroResourceProps<T>
): DeploymentOptions {
  const {
    waitForReady,
    timeout,
    ...deploymentMetadataOptions
  } = props.options ?? {};

  return {
    mode: 'alchemy' as const,
    namespace: props.namespace,
    ...deploymentMetadataOptions,
    waitForReady: waitForReady ?? true,
    timeout: timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
  };
}

/**
 * Log deployment success and context details
 */
function _logDeploymentSuccess<T extends Enhanced<unknown, unknown>>(
  logger: TypeKroLogger,
  alchemyType: string,
  props: TypeKroResourceProps<T>,
  resourceProperties: DeployedResourceProperties<T>,
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
    resourcePropertiesStringified: JSON.stringify(
      resourceProperties,
      (_key, value) => {
        // Handle circular references and complex objects
        if (typeof value === 'object' && value !== null) {
          if (value.constructor && value.constructor.name !== 'Object') {
            return `[${value.constructor.name}]`;
          }
        }
        return value;
      },
      2
    ),
  });
}

/**
 * Execute Alchemy context function with proper error handling
 */
function _executeAlchemyContext<T extends Enhanced<unknown, unknown>>(
  context: Context<TypeKroResource<T>>,
  resourceProperties: DeployedResourceProperties<T>,
  logger: TypeKroLogger,
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
  } catch (contextError: unknown) {
    logger.error('Alchemy context function failed', ensureError(contextError), {
      alchemyType,
      errorMessage: ensureError(contextError).message,
      errorStack: ensureError(contextError).stack,
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
