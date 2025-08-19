/**
 * DirectResourceFactory implementation for direct deployment mode
 *
 * This factory handles direct deployment of Kubernetes resources using TypeKro's
 * internal dependency resolution engine, without requiring the Kro controller.
 */
import { DependencyResolver } from '../dependencies/index.js';
import { DirectDeploymentEngine } from './engine.js';
import { getComponentLogger } from '../logging/index.js';
import { createRollbackManagerWithKubeConfig } from './rollback-manager.js';
import {
  type KubernetesClientProvider,
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  type KubernetesClientConfig,
} from '../kubernetes/client-provider.js';
import { DirectDeploymentStrategy, AlchemyDeploymentStrategy } from './strategies/index.js';
import { ResourceReadinessChecker } from './readiness.js';
import { generateInstanceName } from './shared-utilities.js';
import { toCamelCase } from '../../utils/helpers.js';
import type {
  DeploymentResult,
  DirectResourceFactory,
  FactoryOptions,
  FactoryStatus,
  RollbackResult,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';
import type { DeploymentError, ResourceGraph, DeploymentClosure } from '../types/deployment.js';
// Alchemy integration
import type { Scope } from '../types/serialization.js';
import { isCelExpression, isKubernetesRef } from '../dependencies/type-guards.js';

/**
 * DirectResourceFactory implementation
 *
 * Handles direct deployment of Kubernetes resources using TypeKro's dependency resolution.
 * Each deployment creates individual Kubernetes resources directly in the cluster.
 */
export class DirectResourceFactoryImpl<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> implements DirectResourceFactory<TSpec, TStatus>
{
  readonly mode = 'direct' as const;
  readonly name: string;
  readonly namespace: string;
  readonly isAlchemyManaged: boolean;

  private readonly resources: Record<string, KubernetesResource>;
  private readonly closures: Record<string, DeploymentClosure>;
  private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
  private deploymentEngine?: DirectDeploymentEngine;
  private readonly alchemyScope: Scope | undefined;
  private readonly factoryOptions: FactoryOptions;
  private readonly deployedInstances: Map<string, Enhanced<TSpec, TStatus>> = new Map();
  private readonly logger = getComponentLogger('direct-factory');
  private clientProvider?: KubernetesClientProvider;

  constructor(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.alchemyScope = options.alchemyScope;
    this.isAlchemyManaged = !!options.alchemyScope;
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.factoryOptions = options;

    // Don't initialize client provider in constructor - do it lazily when needed
    // This allows tests to create factories without requiring a kubeconfig
  }

  /**
   * Get or create the Kubernetes client provider (lazy initialization)
   */
  private getClientProvider(): KubernetesClientProvider {
    if (!this.clientProvider) {
      this.clientProvider = this.createClientProvider(this.factoryOptions);
    }
    return this.clientProvider;
  }

  /**
   * Create and configure the Kubernetes client provider
   */
  private createClientProvider(options: FactoryOptions): KubernetesClientProvider {
    // If a pre-configured kubeConfig is provided, use it directly
    if (options.kubeConfig) {
      this.logger.debug('Using pre-configured KubeConfig from factory options');
      return createKubernetesClientProviderWithKubeConfig(options.kubeConfig);
    }

    // Create client provider with configuration from factory options
    const clientConfig: KubernetesClientConfig = {
      ...(options.skipTLSVerify !== undefined && { skipTLSVerify: options.skipTLSVerify }),
      // Add other configuration options as needed
    };

    this.logger.debug('Creating new KubernetesClientProvider with configuration', {
      skipTLSVerify: clientConfig.skipTLSVerify,
    });

    return createKubernetesClientProvider(clientConfig);
  }

  /**
   * Get or create the deployment engine using the centralized client provider
   */
  private getDeploymentEngine(): DirectDeploymentEngine {
    if (!this.deploymentEngine) {
      this.logger.debug('Creating DirectDeploymentEngine with KubernetesClientProvider');

      // Get the KubeConfig from the centralized provider (lazy initialization)
      const clientProvider = this.getClientProvider();
      const kubeConfig = clientProvider.getKubeConfig();

      // Create the deployment engine with the provider's KubeConfig
      this.deploymentEngine = new DirectDeploymentEngine(
        kubeConfig,
        undefined,
        undefined,
        'direct'
      );

      this.logger.debug('DirectDeploymentEngine created successfully', {
        currentContext: kubeConfig.getCurrentContext(),
        server: kubeConfig.getCurrentCluster()?.server,
      });
    }
    return this.deploymentEngine;
  }

  /**
   * Deploy a new instance with the given spec
   */
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // Use the consolidated deployment strategy
    const strategy = this.getDeploymentStrategy();
    const instance = await strategy.deploy(spec);

    // Check if deployment failed and throw for user-facing error handling
    if (instance.metadata?.annotations?.['typekro.io/deployment-status'] === 'failed') {
      const errorMessage =
        instance.metadata?.annotations?.['typekro.io/deployment-error'] ||
        'Deployment failed - check logs for details';
      throw new Error(errorMessage);
    }

    // Track the deployed instance
    const instanceName = this.generateInstanceName(spec);
    this.deployedInstances.set(instanceName, instance);

    return instance;
  }

  /**
   * Get the appropriate deployment strategy based on configuration
   */
  private getDeploymentStrategy() {
    // Create base strategy
    const baseStrategy = new DirectDeploymentStrategy(
      this.name,
      this.namespace,
      this.schemaDefinition,
      this.factoryOptions,
      this.getDeploymentEngine(),
      this // This factory acts as the resource resolver
    );

    // Wrap with alchemy if needed
    if (this.isAlchemyManaged && this.alchemyScope) {
      return new AlchemyDeploymentStrategy(
        this.name,
        this.namespace,
        this.schemaDefinition,
        this.factoryOptions,
        this.alchemyScope,
        baseStrategy
      );
    }

    return baseStrategy;
  }

  /**
   * Get all deployed instances
   */
  async getInstances(): Promise<Enhanced<TSpec, TStatus>[]> {
    return Array.from(this.deployedInstances.values());
  }

  /**
   * Delete a specific instance by name
   */
  async deleteInstance(name: string): Promise<void> {
    const instance = this.deployedInstances.get(name);
    if (!instance) {
      throw new Error(`Instance not found: ${name}`);
    }

    try {
      // Use the deployment engine to delete the resources
      const engine = this.getDeploymentEngine();
      await engine.rollback(`${this.name}-${name}`);

      // Remove from tracking
      this.deployedInstances.delete(name);
    } catch (error) {
      throw new Error(
        `Failed to delete instance ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get factory status with real health checking using readiness evaluators
   */
  async getStatus(): Promise<FactoryStatus> {
    const instances = await this.getInstances();

    // If no instances, we're healthy by definition
    let health: 'healthy' | 'degraded' | 'failed' = 'healthy';

    if (instances.length > 0) {
      // Only perform cluster health checking if we have deployed instances
      health = await this.checkFactoryHealth();
    }

    return {
      name: this.name,
      mode: this.mode,
      isAlchemyManaged: this.isAlchemyManaged,
      namespace: this.namespace,
      instanceCount: instances.length,
      health,
    };
  }

  /**
   * Check the overall health of the factory by leveraging existing ResourceReadinessChecker
   */
  private async checkFactoryHealth(): Promise<'healthy' | 'degraded' | 'failed'> {
    const healthLogger = this.logger.child({ method: 'checkFactoryHealth' });

    try {
      const engine = this.getDeploymentEngine();

      // Get all deployment states from the engine
      const deploymentStates = engine.getAllDeploymentStates();

      if (deploymentStates.length === 0) {
        healthLogger.debug('No deployments found, factory is healthy');
        return 'healthy';
      }

      let healthyCount = 0;
      let degradedCount = 0;
      let failedCount = 0;
      let totalResources = 0;
      const healthErrors: DeploymentError[] = [];

      // Check health of all resources across all deployments
      for (const deploymentState of deploymentStates) {
        for (const deployedResource of deploymentState.resources) {
          totalResources++;

          try {
            // Use the deployment engine's readiness logic (includes custom evaluators + fallback)
            const engine = this.getDeploymentEngine();
            const isReady = await engine.isDeployedResourceReady(deployedResource);

            if (isReady) {
              healthyCount++;
            } else {
              // Resource exists but not ready - consider degraded
              degradedCount++;
              healthLogger.info('Resource not ready', {
                resourceId: deployedResource.id,
                kind: deployedResource.kind,
                name: deployedResource.name,
                namespace: deployedResource.namespace,
              });
            }
          } catch (error) {
            // Resource not found or API error - consider it failed
            failedCount++;
            const healthError: DeploymentError = {
              resourceId: deployedResource.id,
              phase: 'readiness',
              error: error instanceof Error ? error : new Error(String(error)),
              timestamp: new Date(),
            };
            healthErrors.push(healthError);

            healthLogger.error('Failed to check resource health', error as Error, {
              resourceId: deployedResource.id,
            });
          }
        }
      }

      // Log health errors for debugging
      if (healthErrors.length > 0) {
        healthLogger.debug('Health check errors encountered', {
          errorCount: healthErrors.length,
          errors: healthErrors.map((e) => ({
            resourceId: e.resourceId,
            phase: e.phase,
            message: e.error.message,
          })),
        });
      }

      // Determine overall health based on resource status distribution
      if (failedCount > 0) {
        healthLogger.info('Factory health: failed', {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
          errorCount: healthErrors.length,
        });
        return 'failed';
      } else if (degradedCount > 0) {
        healthLogger.info('Factory health: degraded', {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
        });
        return 'degraded';
      } else {
        healthLogger.info('Factory health: healthy', {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
        });
        return 'healthy';
      }
    } catch (error) {
      healthLogger.error('Error checking factory health', error as Error);
      return 'failed';
    }
  }

  /**
   * Get detailed health information including any errors encountered
   * Useful for debugging and monitoring
   */
  async getHealthDetails(): Promise<{
    health: 'healthy' | 'degraded' | 'failed';
    resourceCounts: {
      healthy: number;
      degraded: number;
      failed: number;
      total: number;
    };
    errors: DeploymentError[];
  }> {
    const healthLogger = this.logger.child({ method: 'getHealthDetails' });

    // Check if we have any instances first to avoid initializing engine unnecessarily
    const instances = await this.getInstances();
    if (instances.length === 0) {
      return {
        health: 'healthy',
        resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
        errors: [],
      };
    }

    try {
      const engine = this.getDeploymentEngine();
      const deploymentStates = engine.getAllDeploymentStates();

      if (deploymentStates.length === 0) {
        return {
          health: 'healthy',
          resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
          errors: [],
        };
      }

      const k8sApi = engine.getKubernetesApi();
      const readinessChecker = new ResourceReadinessChecker(k8sApi);

      let healthyCount = 0;
      let degradedCount = 0;
      let failedCount = 0;
      let totalResources = 0;
      const healthErrors: DeploymentError[] = [];

      // Check health of all resources across all deployments
      for (const deploymentState of deploymentStates) {
        for (const deployedResource of deploymentState.resources) {
          totalResources++;

          try {
            const resourceRef = {
              apiVersion: deployedResource.manifest.apiVersion || '',
              kind: deployedResource.kind,
              metadata: {
                name: deployedResource.name,
                namespace: deployedResource.namespace,
              },
            };
            const liveResource = await k8sApi.read(resourceRef);

            const isReady = readinessChecker.isResourceReady(liveResource.body);

            if (isReady) {
              healthyCount++;
            } else {
              degradedCount++;
            }
          } catch (error) {
            failedCount++;
            const healthError: DeploymentError = {
              resourceId: deployedResource.id,
              phase: 'readiness',
              error: error instanceof Error ? error : new Error(String(error)),
              timestamp: new Date(),
            };
            healthErrors.push(healthError);
          }
        }
      }

      const health = failedCount > 0 ? 'failed' : degradedCount > 0 ? 'degraded' : 'healthy';

      return {
        health,
        resourceCounts: {
          healthy: healthyCount,
          degraded: degradedCount,
          failed: failedCount,
          total: totalResources,
        },
        errors: healthErrors,
      };
    } catch (error) {
      healthLogger.error('Error getting health details', error as Error);
      return {
        health: 'failed',
        resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
        errors: [
          {
            resourceId: 'factory',
            phase: 'readiness',
            error: error instanceof Error ? error : new Error(String(error)),
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Rollback all deployments made by this factory
   */
  async rollback(): Promise<RollbackResult> {
    this.logger.debug('Starting rollback for all deployed instances');

    // Get kubeConfig from the centralized provider (lazy initialization)
    const clientProvider = this.getClientProvider();
    const kubeConfig = clientProvider.getKubeConfig();

    // Create rollback manager with the provider's KubeConfig
    const rollbackManager = createRollbackManagerWithKubeConfig(kubeConfig);

    // Get all deployed instances as Enhanced resources
    const resourcesToRollback = Array.from(this.deployedInstances.values());

    this.logger.debug('Rolling back resources', {
      resourceCount: resourcesToRollback.length,
      instanceNames: Array.from(this.deployedInstances.keys()),
    });

    // Perform rollback using consolidated logic
    const result = await rollbackManager.rollbackResources(resourcesToRollback, {
      timeout: this.factoryOptions.timeout || undefined,
      emitEvent: this.factoryOptions.progressCallback || undefined,
    });

    // Clear all tracked instances after rollback
    this.deployedInstances.clear();

    this.logger.info('Rollback completed', {
      status: result.status,
      resourceCount: result.rolledBackResources.length,
    });

    return result;
  }

  /**
   * Perform a dry run deployment
   */
  async toDryRun(spec: TSpec): Promise<DeploymentResult> {
    const resourceGraph = this.createResourceGraphForInstance(spec);

    const deploymentOptions = {
      mode: 'direct' as const,
      namespace: this.namespace,
      ...(this.factoryOptions.timeout && { timeout: this.factoryOptions.timeout }),
      waitForReady: false, // Don't wait for readiness in dry run
      dryRun: true,
      ...(this.factoryOptions.retryPolicy && { retryPolicy: this.factoryOptions.retryPolicy }),
      ...(this.factoryOptions.progressCallback && {
        progressCallback: this.factoryOptions.progressCallback,
      }),
    };

    return this.getDeploymentEngine().deploy(resourceGraph, deploymentOptions);
  }

  /**
   * Generate YAML for instance deployment
   */
  toYaml(spec: TSpec): string {
    // Resolve references with the actual spec values
    const resolvedResources = this.resolveResourcesForSpec(spec);

    // Generate individual Kubernetes resource YAML manifests (not RGD)
    const yamlParts = Object.values(resolvedResources).map((resource) => {
      // Remove TypeKro-specific fields and generate clean Kubernetes YAML
      const cleanResource = { ...resource } as KubernetesResource & { id?: string };
      delete cleanResource.id; // Remove TypeKro id field

      // Simple YAML serialization for Kubernetes resources
      let yamlContent = `apiVersion: ${cleanResource.apiVersion}
kind: ${cleanResource.kind}
metadata:
  name: ${cleanResource.metadata?.name}
  namespace: ${this.namespace}`;

      // Add labels if present
      if (cleanResource.metadata?.labels) {
        yamlContent += `\n  labels:\n${Object.entries(cleanResource.metadata.labels)
          .map(([k, v]) => `    ${k}: ${v}`)
          .join('\n')}`;
      }

      // Handle different resource types
      const resourceWithSpec = cleanResource as KubernetesResource & {
        spec?: Record<string, unknown>;
      };
      if (resourceWithSpec.spec) {
        yamlContent += `\nspec:\n${Object.entries(resourceWithSpec.spec)
          .map(
            ([key, value]) =>
              `  ${key}: ${
                typeof value === 'object'
                  ? JSON.stringify(value, null, 2)
                      .split('\n')
                      .map((line, i) => (i === 0 ? line : `  ${line}`))
                      .join('\n')
                  : value
              }`
          )
          .join('\n')}`;
      }

      const resourceWithData = cleanResource as KubernetesResource & {
        data?: Record<string, string | unknown>;
      };
      if (resourceWithData.data) {
        yamlContent += `\ndata:\n${Object.entries(resourceWithData.data)
          .map(
            ([key, value]) =>
              `  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`
          )
          .join('\n')}`;
      }

      return yamlContent;
    });

    return yamlParts.join('\n---\n');
  }

  /**
   * Create a resource graph for a specific instance
   */
  public createResourceGraphForInstance(spec: TSpec): ResourceGraph {
    const dependencyResolver = new DependencyResolver();
    const resolvedResources = this.resolveResourcesForSpec(spec);

    const instanceName = this.generateInstanceName(spec);
    const resourceArray = Object.values(resolvedResources).map((resource, index) => {
      const baseId = `${instanceName}-resource-${index}-${resource.id || resource.kind?.toLowerCase() || 'unknown'}`;
      const resourceWithId = {
        ...resource,
        id: toCamelCase(baseId),
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

      return resourceWithId;
    });

    // Convert to DeployableK8sResource format expected by dependency resolver
    const deployableResources = resourceArray as DeployableK8sResource<
      Enhanced<unknown, unknown>
    >[];
    const dependencyGraph = dependencyResolver.buildDependencyGraph(deployableResources);

    // Create resources in the format expected by DirectDeploymentEngine
    const formattedResources = deployableResources.map((resource) => ({
      id: resource.id, // Already prefixed with instance name above
      manifest: resource,
    }));

    return {
      name: `${this.name}-instance`,
      resources: formattedResources,
      dependencyGraph,
    };
  }

  /**
   * Resolve resources for a specific spec
   * This uses the existing processResourceReferences system to handle schema references
   */
  private resolveResourcesForSpec(spec: TSpec): Record<string, KubernetesResource> {
    const resolvedResources: Record<string, KubernetesResource> = {};
    for (const [key, resource] of Object.entries(this.resources)) {
      try {
        // CORRECTED: Go directly from the resource template (with proxy objects)
        // to resolving the values from the provided spec.
        const resolvedResource = this.resolveSchemaReferencesToValues(resource, spec);
        resolvedResources[key] = resolvedResource as KubernetesResource;
      } catch (error) {
        // If resolution fails, use the original resource
        this.logger.warn('Failed to resolve references for resource', error as Error);
        resolvedResources[key] = resource;
      }
    }

    return resolvedResources;
  }

  /**
   * Resolve schema references and CEL expressions to actual values for direct deployment.
   * This is the final, corrected version that handles both direct proxies and Cel.expr wrappers.
   */
  private resolveSchemaReferencesToValues(resource: unknown, spec: TSpec, path = 'root'): unknown {
    this.logger.trace('Resolving schema references', {
      path,
      type: typeof resource,
      isObject: resource !== null && typeof resource === 'object',
    });

    // Case 1: Handle direct schema proxy objects (e.g., schema.spec.replicas)
    if (isKubernetesRef(resource) && resource.resourceId === '__schema__') {
      this.logger.trace('Found schema KubernetesRef', { path, fieldPath: resource.fieldPath });
      const pathParts = resource.fieldPath.split('.');
      let currentValue: any = spec;
      // Skip the first part ('spec') and traverse the spec object
      this.logger.trace('Traversing spec with path parts', { pathParts: pathParts.slice(1) });
      for (const part of pathParts.slice(1)) {
        if (currentValue && typeof currentValue === 'object' && part in currentValue) {
          const oldValue = currentValue;
          currentValue = currentValue[part];
          this.logger.trace('Successfully traversed spec part', {
            part,
            oldValue: JSON.stringify(oldValue),
            newValue: JSON.stringify(currentValue),
          });
        } else {
          this.logger.warn('Path part not found in spec, returning original reference', {
            path,
            part,
            spec: JSON.stringify(spec),
          });
          return resource;
          // Path not found, return original
        }
      }
      this.logger.trace('Resolved schema KubernetesRef to value', {
        path,
        resolvedValue: currentValue,
      });
      return currentValue;
    }

    // Case 2: Handle CelExpression objects (e.g., Cel.expr(schema.spec.name, '-db'))
    if (isCelExpression(resource)) {
      this.logger.trace('Found CEL Expression', { path, expression: resource.expression });
      // The .expression property holds a string like "schema.spec.name-db-config"
      let expressionString = resource.expression;
      // Use regex to find all `schema.spec.fieldName` placeholders in the string
      // and replace them with the corresponding values from the spec object.
      // The 'g' flag ensures all occurrences are replaced.
      expressionString = expressionString.replace(/schema\.spec\.(\w+)/g, (_match, fieldName) => {
        const value = (spec as Record<string, unknown>)[fieldName];
        this.logger.trace('Replacing CEL placeholder', { fieldName, value });
        // If the value exists in the spec, convert it to a string for concatenation.
        // Otherwise, keep the original placeholder (though this shouldn't happen in valid cases).

        return value !== undefined ? String(value) : _match;
      });
      this.logger.trace('Resolved CEL expression to value', {
        path,
        resolvedValue: expressionString,
      });
      // The result is the final, resolved string.
      return expressionString;
    }

    // Case 3: Recursively traverse arrays and plain objects (no changes here)
    if (Array.isArray(resource)) {
      this.logger.trace('Traversing array', { path });
      return resource.map((item, index) =>
        this.resolveSchemaReferencesToValues(item, spec, `${path}[${index}]`)
      );
    }

    if (resource && typeof resource === 'object') {
      this.logger.trace('Traversing object', { path, keys: Object.keys(resource) });
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(resource)) {
        resolved[key] = this.resolveSchemaReferencesToValues(value, spec, `${path}.${key}`);
      }

      // FIX: Explicitly check for and preserve the non-enumerable readinessEvaluator property.
      const evaluator = (resource as any).readinessEvaluator;
      if (typeof evaluator === 'function') {
        this.logger.trace('Preserving readiness evaluator for resource', { path });
        Object.defineProperty(resolved, 'readinessEvaluator', {
          value: evaluator,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }

      return resolved;
    }

    this.logger.trace('Returning primitive value as-is', { path, value: resource });
    // Return primitives and other types as-is.
    return resource;
  }

  /**
   * Generate instance name from spec
   */
  private generateInstanceName(spec: TSpec): string {
    // Use the imported shared utility
    return generateInstanceName(spec);
  }
}

/**
 * Create a DirectResourceFactory instance
 */
export function createDirectResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  name: string,
  resources: Record<string, KubernetesResource>,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  options: FactoryOptions = {}
): DirectResourceFactory<TSpec, TStatus> {
  return new DirectResourceFactoryImpl<TSpec, TStatus>(name, resources, schemaDefinition, options);
}
