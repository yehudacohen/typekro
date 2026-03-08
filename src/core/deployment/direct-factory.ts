/**
 * DirectResourceFactory implementation for direct deployment mode
 *
 * This factory handles direct deployment of Kubernetes resources using TypeKro's
 * internal dependency resolution engine, without requiring the Kro controller.
 */

import * as yaml from 'js-yaml';
import { toCamelCase } from '../../utils/string.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import {
  DEFAULT_DELETE_TIMEOUT,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_MAX_RECURSION_DEPTH,
} from '../config/defaults.js';
import { DependencyResolver } from '../dependencies/index.js';
import {
  ensureError,
  ResourceGraphFactoryError,
  TypeKroError,
  ValidationError,
} from '../errors.js';
import {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  type KubernetesClientConfig,
  type KubernetesClientProvider,
} from '../kubernetes/client-provider.js';
import { getComponentLogger } from '../logging/index.js';
import type {
  DeploymentClosure,
  DeploymentError,
  DeploymentResourceGraph,
  DeploymentResult,
  DirectResourceFactory,
  FactoryOptions,
  FactoryStatus,
  RollbackResult,
} from '../types/deployment.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KubernetesResource,
  ResourceStatus,
  WithResourceId,
} from '../types/kubernetes.js';
// Alchemy integration
import type {
  KroCompatibleType,
  SchemaDefinition,
  Scope,
  StatusBuilder,
} from '../types/serialization.js';
import { DirectDeploymentEngine } from './engine.js';
import { ResourceReadinessChecker } from './readiness.js';
import { createRollbackManagerWithKubeConfig } from './rollback-manager.js';
import { generateInstanceName } from './shared-utilities.js';
import { AlchemyDeploymentStrategy, DirectDeploymentStrategy } from './strategies/index.js';

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
  private readonly statusBuilder: StatusBuilder<TSpec, TStatus, any> | undefined;
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
    statusBuilder?: StatusBuilder<TSpec, TStatus, any>,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.alchemyScope = options.alchemyScope;
    this.isAlchemyManaged = !!options.alchemyScope;
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.statusBuilder = statusBuilder;
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
      ...(options.httpTimeouts && { httpTimeouts: options.httpTimeouts }),
      // Add other configuration options as needed
    };

    this.logger.debug('Creating new KubernetesClientProvider with configuration', {
      skipTLSVerify: clientConfig.skipTLSVerify,
      hasCustomHttpTimeouts: !!options.httpTimeouts,
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
      // Pass HTTP timeout configuration if provided in factory options
      this.deploymentEngine = new DirectDeploymentEngine(
        kubeConfig,
        undefined,
        undefined,
        'direct',
        this.factoryOptions.httpTimeouts
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
    this.logger.debug('DirectResourceFactory deploy called', {
      factoryName: this.name,
      hasStatusBuilder: !!this.statusBuilder,
    });

    // Use the consolidated deployment strategy
    const strategy = this.getDeploymentStrategy();

    this.logger.debug('Got deployment strategy', {
      strategyType: strategy.constructor.name,
    });

    const instance = await strategy.deploy(spec);

    // Check if deployment failed and throw for user-facing error handling
    if (instance.metadata?.annotations?.['typekro.io/deployment-status'] === 'failed') {
      const errorMessage =
        instance.metadata?.annotations?.['typekro.io/deployment-error'] ||
        'Deployment failed - check logs for details';
      throw new ResourceGraphFactoryError(errorMessage, this.name, 'deployment');
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
      this.statusBuilder,
      this.resources,
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
        this.statusBuilder,
        this.resources,
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
      throw new TypeKroError(`Instance not found: ${name}`, 'INSTANCE_NOT_FOUND', {
        instanceName: name,
        factoryName: this.name,
      });
    }

    try {
      // Use the deployment engine to delete resources using actual deployment ID
      const engine = this.getDeploymentEngine();
      const deploymentId = instance.metadata?.annotations?.['typekro.io/deployment-id'];
      if (!deploymentId) {
        throw new TypeKroError(
          `Instance ${name} does not have a deployment ID annotation. Cannot perform cleanup.`,
          'MISSING_DEPLOYMENT_ID',
          { instanceName: name, factoryName: this.name }
        );
      }
      const rollbackResult = await engine.rollback(deploymentId);

      // Wait for any namespaces to be fully deleted before returning.
      // Namespace deletion is asynchronous (enters "Terminating" phase) and can
      // cause race conditions if the caller immediately re-creates resources.
      const deletedNamespaces = rollbackResult.rolledBackResources
        .filter((r) => r.startsWith('Namespace/'))
        .map((r) => r.split('/')[1]!);

      if (deletedNamespaces.length > 0) {
        const k8sApi = engine.getKubernetesApi();
        const deleteTimeout = this.factoryOptions.timeout ?? DEFAULT_DELETE_TIMEOUT;
        await this.waitForNamespaceDeletion(k8sApi, deletedNamespaces, deleteTimeout);
      }

      // Remove from tracking
      this.deployedInstances.delete(name);
    } catch (error: unknown) {
      // If the deployment isn't found in the state, it may have already been cleaned up
      // or the deployment ID format changed. Log and remove from tracking anyway.
      const errorMessage = ensureError(error).message;
      if (errorMessage.includes('not found') || errorMessage.includes('Cannot rollback')) {
        this.deployedInstances.delete(name);
        // Don't throw - the instance is already gone
        return;
      }
      throw new ResourceGraphFactoryError(
        `Failed to delete instance ${name}: ${errorMessage}`,
        this.name,
        'cleanup'
      );
    }
  }

  /**
   * Poll until the given namespaces no longer exist (HTTP 404).
   * Namespaces enter a "Terminating" phase on deletion and may take time
   * to fully disappear, especially when finalizers or remaining resources
   * are involved.
   */
  private async waitForNamespaceDeletion(
    k8sApi: import('@kubernetes/client-node').KubernetesObjectApi,
    namespaces: string[],
    timeout: number
  ): Promise<void> {
    const pollInterval = DEFAULT_FAST_POLL_INTERVAL;

    for (const ns of namespaces) {
      // Each namespace gets its own timeout budget
      const nsStartTime = Date.now();
      while (Date.now() - nsStartTime < timeout) {
        try {
          await k8sApi.read({
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: ns },
          });
          // Namespace still exists (likely "Terminating"), keep polling
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        } catch (error: unknown) {
          // 404 means the namespace is fully gone
          const k8sErr = error as { statusCode?: number; body?: { code?: number } };
          if (k8sErr.statusCode === 404 || k8sErr.body?.code === 404) {
            this.logger.debug('Namespace fully deleted', { namespace: ns });
            break;
          }
          // Unexpected error — log and stop waiting for this namespace
          this.logger.warn('Error polling namespace deletion', {
            namespace: ns,
            error: ensureError(error).message,
          });
          break;
        }
      }
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
          } catch (error: unknown) {
            // Resource not found or API error - consider it failed
            failedCount++;
            const healthError: DeploymentError = {
              resourceId: deployedResource.id,
              phase: 'readiness',
              error: ensureError(error),
              timestamp: new Date(),
            };
            healthErrors.push(healthError);

            healthLogger.error('Failed to check resource health', ensureError(error), {
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
    } catch (error: unknown) {
      healthLogger.error('Error checking factory health', ensureError(error));
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
            // In the new API, methods return objects directly (no .body wrapper)
            const liveResource = await k8sApi.read(resourceRef);

            const isReady = readinessChecker.isResourceReady(liveResource);

            if (isReady) {
              healthyCount++;
            } else {
              degradedCount++;
            }
          } catch (error: unknown) {
            failedCount++;
            const healthError: DeploymentError = {
              resourceId: deployedResource.id,
              phase: 'readiness',
              error: ensureError(error),
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
    } catch (error: unknown) {
      healthLogger.error('Error getting health details', ensureError(error));
      return {
        health: 'failed',
        resourceCounts: { healthy: 0, degraded: 0, failed: 0, total: 0 },
        errors: [
          {
            resourceId: 'factory',
            phase: 'readiness',
            error: ensureError(error),
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
   * Generate YAML for instance deployment.
   *
   * In direct mode this produces plain Kubernetes manifests with all schema
   * references resolved from the provided spec.  If any KubernetesRef or
   * CelExpression objects remain after resolution (cross-resource references,
   * explicit Cel.expr/Cel.template calls, $-prefixed optional access) a
   * ValidationError is thrown — those constructs require the Kro controller
   * or runtime deployment via deploy().
   */
  toYaml(spec: TSpec): string {
    // Resolve references with the actual spec values
    const resolvedResources = this.resolveResourcesForSpec(spec);

    // Validate that all values are fully resolved — no KubernetesRef or
    // CelExpression objects should remain in direct-mode YAML output.
    const unresolvedRefs = findUnresolvedReferences(resolvedResources);
    if (unresolvedRefs.length > 0) {
      const details = unresolvedRefs.map((r) => `  - ${r.path}: ${r.description}`).join('\n');
      throw new ValidationError(
        `Cannot generate direct-mode YAML: ${unresolvedRefs.length} unresolved reference(s) found.\n` +
          `Direct mode toYaml() produces plain Kubernetes manifests where all values must be resolved.\n\n` +
          `Unresolved references:\n${details}\n\n` +
          `To fix this, either:\n` +
          `  1. Use factory('kro') to generate Kro-managed YAML with CEL expressions\n` +
          `  2. Use deploy() which resolves all references at runtime against the live cluster\n` +
          `  3. Remove Cel.expr() / Cel.template() / cross-resource references from your resource builder`,
        'DirectResourceFactory',
        this.name,
        undefined,
        [
          'Use factory("kro") for resource graphs with CEL expressions or cross-resource references',
          'Use deploy() for runtime resolution against the live cluster',
          'Remove explicit Cel.expr() / Cel.template() calls if direct-mode YAML is needed',
        ]
      );
    }

    // Generate individual Kubernetes resource YAML manifests (not RGD).
    // Uses js-yaml for safe serialization — avoids YAML injection via string interpolation.
    const yamlParts = Object.values(resolvedResources).map((resource) => {
      // Remove TypeKro-specific fields and generate clean Kubernetes YAML
      const cleanResource = { ...resource } as KubernetesResource & { id?: string };
      delete cleanResource.id; // Remove TypeKro id field

      // Build a clean manifest object for yaml.dump
      const manifest: Record<string, unknown> = {
        apiVersion: cleanResource.apiVersion,
        kind: cleanResource.kind,
        metadata: {
          name: cleanResource.metadata?.name,
          namespace: this.namespace,
          ...(cleanResource.metadata?.labels
            ? { labels: cleanResource.metadata.labels }
            : undefined),
        },
      };

      // Handle different resource types
      const resourceWithSpec = cleanResource as KubernetesResource & {
        spec?: Record<string, unknown>;
      };
      if (resourceWithSpec.spec) {
        manifest.spec = resourceWithSpec.spec;
      }

      const resourceWithData = cleanResource as KubernetesResource & {
        data?: Record<string, string | unknown>;
      };
      if (resourceWithData.data) {
        manifest.data = resourceWithData.data;
      }

      // JSON round-trip strips non-serializable values (functions, symbols, proxies)
      // that may remain in resolved resources before safe YAML serialization.
      const safeManifest = JSON.parse(JSON.stringify(manifest));
      return yaml.dump(safeManifest, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
    });

    return yamlParts.join('\n---\n');
  }

  /**
   * Create a resource graph for a specific instance
   */
  public createResourceGraphForInstance(spec: TSpec): DeploymentResourceGraph {
    const dependencyResolver = new DependencyResolver();
    const resolvedResources = this.resolveResourcesForSpec(spec);

    const instanceName = this.generateInstanceName(spec);
    const resourceArray = Object.values(resolvedResources).map((resource, index) => {
      this.logger.debug('Processing resource for ID generation', {
        index,
        resourceId: resource.id,
        resourceKind: resource.kind,
        hasId: !!resource.id,
        resourceKeys: Object.keys(resource),
      });
      const baseId = `${instanceName}-resource-${index}-${resource.id || resource.kind?.toLowerCase() || 'unknown'}`;
      const finalId = toCamelCase(baseId);
      this.logger.debug('Generated resource ID', {
        index,
        originalId: resource.id,
        resourceKind: resource.kind,
        baseId,
        finalId,
      });
      const resourceWithId = {
        ...resource,
        id: finalId,
      };

      // Preserve the __resourceId property if it exists (it's non-enumerable)
      // This is the original resource ID (e.g., 'webappConfig') that's used for cross-resource references
      // Note: For Enhanced proxy resources, __resourceId is on the target object and accessible via Reflect.get
      const originalResourceId = (resource as WithResourceId).__resourceId;

      // Also check if the resource has an 'id' property that was set by the factory
      // The proxy returns resourceId when accessing 'id' property
      const resourceIdFromProxy = resource.id;
      const effectiveOriginalId = originalResourceId || resourceIdFromProxy;

      this.logger.debug('Checking __resourceId preservation', {
        originalResourceId,
        resourceIdFromProxy,
        effectiveOriginalId,
        hasOriginalResourceId: !!originalResourceId,
        hasResourceIdFromProxy: !!resourceIdFromProxy,
      });

      if (effectiveOriginalId) {
        Object.defineProperty(resourceWithId, '__resourceId', {
          value: effectiveOriginalId,
          enumerable: false,
          configurable: true,
        });
        this.logger.debug('Preserved __resourceId on resource', {
          originalResourceId: effectiveOriginalId,
          newId: finalId,
        });
      }

      // Preserve the readinessEvaluator function if it exists (it's non-enumerable)
      const originalResource = resource as {
        readinessEvaluator?: (resource: unknown) => ResourceStatus;
      };
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
   * This uses composition re-execution when available, or falls back to reference resolution
   */
  private reExecutedStatus: TStatus | null = null; // Store the re-executed status

  private resolveResourcesForSpec(spec: TSpec): Record<string, KubernetesResource> {
    // Reset the re-executed status
    this.reExecutedStatus = null;

    // Check if we have composition re-execution parameters
    if (this.factoryOptions.compositionFn && this.factoryOptions.compositionDefinition) {
      this.logger.debug('Re-executing composition with actual spec values', {
        hasCompositionFn: !!this.factoryOptions.compositionFn,
        hasCompositionDefinition: !!this.factoryOptions.compositionDefinition,
      });

      try {
        // Re-execute the composition with actual spec values
        const reExecutionResult = this.reExecuteCompositionWithActualValues(spec);
        if (reExecutionResult) {
          this.logger.debug('Successfully re-executed composition with actual values', {
            resourceCount: Object.keys(reExecutionResult.resources).length,
            statusFields: reExecutionResult.status ? Object.keys(reExecutionResult.status) : [],
          });

          // Store the re-executed status for later use
          this.reExecutedStatus = reExecutionResult.status;

          return reExecutionResult.resources;
        }
      } catch (error: unknown) {
        this.logger.error(
          'Failed to re-execute composition, falling back to reference resolution',
          ensureError(error)
        );
      }
    }

    // Fall back to the original reference resolution approach
    this.logger.debug(
      'Using reference resolution approach (no composition re-execution available)'
    );
    const resolvedResources: Record<string, KubernetesResource> = {};
    for (const [key, resource] of Object.entries(this.resources)) {
      try {
        // CORRECTED: Go directly from the resource template (with proxy objects)
        // to resolving the values from the provided spec.
        const resolvedResource = this.resolveSchemaReferencesToValues(resource, spec);
        resolvedResources[key] = resolvedResource as KubernetesResource;
      } catch (error: unknown) {
        // If resolution fails, use the original resource
        this.logger.error('Failed to resolve references for resource', ensureError(error));
        resolvedResources[key] = resource;
      }
    }

    return resolvedResources;
  }

  /**
   * Re-execute the composition function with actual spec values
   * This provides actual values instead of proxy functions to the composition
   */
  private reExecuteCompositionWithActualValues(
    spec: TSpec
  ): { resources: Record<string, KubernetesResource>; status: TStatus } | null {
    if (!this.factoryOptions.compositionFn || !this.factoryOptions.compositionDefinition) {
      return null;
    }

    try {
      this.logger.debug('Re-executing composition with actual spec values');

      // Composition context utilities are now statically imported from core

      // Create a new composition context for re-execution.
      // Enable ID deduplication so forEach loops that create multiple resources
      // with the same id (e.g., 'regionDep') get unique keys ('regionDep', 'regionDep-1', etc.)
      const reExecutionContext = createCompositionContext('re-execution', {
        deduplicateIds: true,
      });

      // Execute the composition function within the new context and capture both resources and status
      const { resources, status } = runWithCompositionContext(reExecutionContext, () => {
        // Execute the composition function with actual spec values
        const computedStatus = this.factoryOptions.compositionFn?.(spec);
        return {
          resources: reExecutionContext.resources,
          status: computedStatus,
        };
      });

      this.logger.debug('Composition re-execution completed', {
        capturedResourceCount: Object.keys(resources).length,
        resourceIds: Object.keys(resources),
        statusFields: status ? Object.keys(status) : [],
      });

      // Convert Enhanced resources back to KubernetesResource format.
      // Filter out externalRef resources — they already exist in the cluster
      // and should NOT be deployed in direct mode.
      const kubernetesResources: Record<string, KubernetesResource> = {};
      for (const [id, enhanced] of Object.entries(resources)) {
        // Skip external references — they're not managed by us
        const enhancedRecord = enhanced as unknown as Record<string, unknown>;
        if (enhancedRecord.__externalRef === true) {
          this.logger.debug('Skipping externalRef resource in direct mode', { id });
          continue;
        }

        // Extract the underlying Kubernetes resource from the Enhanced proxy
        const kubernetesResource = this.extractKubernetesResourceFromEnhanced(
          enhanced as Enhanced<any, any>
        );
        kubernetesResources[id] = kubernetesResource;
      }

      // The status returned from re-execution should preserve CEL expressions
      // Only spec-based values should be resolved, resource-based CEL expressions should remain
      return {
        resources: kubernetesResources,
        status: status as TStatus,
      };
    } catch (error: unknown) {
      this.logger.error('Failed to re-execute composition', ensureError(error));
      return null;
    }
  }

  /**
   * Get the re-executed status if available
   * This is used by the deployment strategy to use computed status instead of calling status builder with proxy functions
   */
  public getReExecutedStatus(): TStatus | null {
    return this.reExecutedStatus;
  }

  /**
   * Deep resolve any KubernetesRef objects in a value to their string representation
   * This is needed because when composition functions build objects with schema proxy values,
   * those values are KubernetesRef objects that need to be converted to actual values or
   * placeholder strings for serialization.
   *
   * For schema references (resourceId === '__schema__'), we return a placeholder that will
   * be resolved later when actual spec values are available.
   *
   * For resource references, we return a CEL expression placeholder.
   */
  private deepResolveKubernetesRefs(value: unknown, path = 'root'): unknown {
    // Handle KubernetesRef objects
    if (isKubernetesRef(value)) {
      this.logger.trace('Found KubernetesRef in value', {
        path,
        resourceId: value.resourceId,
        fieldPath: value.fieldPath,
      });

      // For schema references, return a marker that can be resolved later
      if (value.resourceId === '__schema__') {
        return `__KUBERNETES_REF___schema___${value.fieldPath}__`;
      }

      // For resource references, return a CEL expression placeholder
      return `__KUBERNETES_REF_${value.resourceId}_${value.fieldPath}__`;
    }

    // Handle CelExpression objects
    if (isCelExpression(value)) {
      this.logger.trace('Found CelExpression in value', {
        path,
        expression: value.expression,
      });
      return value.expression;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item, index) => this.deepResolveKubernetesRefs(item, `${path}[${index}]`));
    }

    // Handle objects
    if (value !== null && typeof value === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = this.deepResolveKubernetesRefs(val, `${path}.${key}`);
      }
      return resolved;
    }

    // Return primitives as-is
    return value;
  }

  /**
   * Extract the underlying Kubernetes resource from an Enhanced proxy
   *
   * IMPORTANT: This method preserves ALL enumerable properties from the Enhanced resource,
   * not just standard Kubernetes fields. This is critical for resources like Secret (data),
   * ConfigMap (data, binaryData), RBAC resources (rules, roleRef, subjects), etc.
   *
   * It also resolves any KubernetesRef objects in the resource properties to their
   * string representations, which is critical for HelmRelease values that may contain
   * schema proxy references.
   */
  private extractKubernetesResourceFromEnhanced(enhanced: Enhanced<any, any>): KubernetesResource {
    // Start with required Kubernetes resource structure
    const resource: KubernetesResource = {
      apiVersion: enhanced.apiVersion,
      kind: enhanced.kind,
      metadata: this.deepResolveKubernetesRefs(enhanced.metadata) as KubernetesResource['metadata'],
    };

    // Preserve ALL other enumerable properties from the Enhanced resource
    // This ensures resource-specific fields (data, rules, roleRef, etc.) are not lost
    for (const [key, value] of Object.entries(enhanced)) {
      // Skip the core fields we've already set
      if (key === 'apiVersion' || key === 'kind' || key === 'metadata') {
        continue;
      }

      // Include all other properties (spec, status, data, rules, etc.)
      // Deep resolve any KubernetesRef objects in the value
      if (value !== undefined && value !== null) {
        (resource as unknown as Record<string, unknown>)[key] =
          this.deepResolveKubernetesRefs(value);
      }
    }

    // Preserve the non-enumerable id field if it exists (needed for resource mapping in CEL resolution)
    if (enhanced.id) {
      resource.id = enhanced.id;
    }

    // Preserve the non-enumerable readinessEvaluator if it exists.
    // This is critical for the deployment engine to know when a resource is ready.
    const enhancedRecord = enhanced as Record<string, unknown>;
    const readinessEvaluator = enhancedRecord.readinessEvaluator;
    if (typeof readinessEvaluator === 'function') {
      Object.defineProperty(resource, 'readinessEvaluator', {
        value: readinessEvaluator,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

    return resource;
  }

  /**
   * Traverse a spec object using dot-separated path parts, returning the resolved value.
   * Shared by both KubernetesRef resolution (Case 1) and template marker resolution (Case 4).
   */
  private traverseSpec(
    spec: TSpec,
    pathParts: string[],
    logPath: string
  ): { found: true; value: unknown } | { found: false } {
    let currentValue: unknown = spec;
    this.logger.trace('Traversing spec with path parts', { pathParts });
    for (const part of pathParts) {
      if (currentValue && typeof currentValue === 'object' && part in currentValue) {
        currentValue = (currentValue as Record<string, unknown>)[part];
      } else {
        this.logger.warn('Path part not found in spec', {
          path: logPath,
          part,
          availableKeys:
            currentValue && typeof currentValue === 'object' ? Object.keys(currentValue) : [],
        });
        return { found: false };
      }
    }
    return { found: true, value: currentValue };
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
      const resolved = this.traverseSpec(spec, pathParts.slice(1), path);
      if (resolved.found) {
        this.logger.trace('Resolved schema KubernetesRef to value', {
          path,
          resolvedValue: resolved.value,
        });
        return resolved.value;
      }
      return resource;
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

      // Debug: Check if id field is being preserved
      const resourceRecord = resource as Record<string, unknown>;
      if (path === 'root' && resourceRecord.id) {
        this.logger.debug('Resource ID preservation check', {
          path,
          originalId: resourceRecord.id,
          resolvedId: resolved.id,
          originalKeys: Object.keys(resource),
          resolvedKeys: Object.keys(resolved),
        });
      }

      // FIX: Explicitly check for and preserve the non-enumerable readinessEvaluator property.
      const evaluator = (resource as { readinessEvaluator?: (resource: unknown) => boolean })
        .readinessEvaluator;
      if (typeof evaluator === 'function') {
        this.logger.trace('Preserving readiness evaluator for resource', { path });
        Object.defineProperty(resolved, 'readinessEvaluator', {
          value: evaluator,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }

      // FIX: Preserve the id field if it exists (needed for resource mapping in CEL resolution)
      if (resourceRecord.id) {
        this.logger.trace('Preserving resource id field', { path, id: resourceRecord.id });
        resolved.id = resourceRecord.id;
      }

      return resolved;
    }

    // Case 4: Handle strings that contain __KUBERNETES_REF_ markers from template literals
    // These are generated when schema references are used in template literals like `${schema.spec.name}-suffix`
    if (typeof resource === 'string' && resource.includes('__KUBERNETES_REF_')) {
      this.logger.trace('Found string with KubernetesRef markers', { path, value: resource });

      // Replace all __KUBERNETES_REF_ markers with actual values from spec
      // Pattern: __KUBERNETES_REF_{resourceId}_{fieldPath}__
      // For schema: __KUBERNETES_REF___schema___{fieldPath}__
      // The fieldPath for schema refs is like "spec.baseName" or "spec.nested.field"
      const resolvedString = resource.replace(
        /__KUBERNETES_REF___schema___(.+?)__/g,
        (_match, fieldPath) => {
          // fieldPath is like "spec.baseName" - we need to traverse starting from the schema root
          const pathParts = fieldPath.split('.');

          // The first part should be 'spec' or 'status'
          if (pathParts[0] === 'spec') {
            const resolved = this.traverseSpec(spec, pathParts.slice(1), path);
            if (resolved.found) {
              this.logger.trace('Resolved schema marker to value', {
                fieldPath,
                resolvedValue: resolved.value,
              });
              return String(resolved.value);
            }
            return _match; // Keep original marker if path not found
          } else {
            // Status references or other paths - keep as-is for now
            this.logger.trace('Keeping non-spec schema reference marker', {
              fieldPath,
            });
            return _match;
          }
        }
      );

      // Also handle non-schema resource references (keep them as-is for now)
      // Pattern: __KUBERNETES_REF_{resourceId}_{fieldPath}__ where resourceId is not __schema__

      this.logger.trace('Resolved string with markers', {
        path,
        original: resource,
        resolved: resolvedString,
      });
      return resolvedString;
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

/** Describes an unresolved reference found during direct-mode toYaml() validation. */
interface UnresolvedReference {
  /** Dot-separated path to the value, e.g. "spec.containers[0].env.DATABASE_HOST" */
  path: string;
  /** Human-readable description of the reference type */
  description: string;
}

/**
 * Recursively walk a resolved resource tree and collect any remaining
 * KubernetesRef or CelExpression objects.  These cannot be serialized
 * in direct-mode YAML and indicate the user should use Kro mode or deploy().
 */
function findUnresolvedReferences(
  resources: Record<string, KubernetesResource>
): UnresolvedReference[] {
  const refs: UnresolvedReference[] = [];
  const visited = new WeakSet<object>();

  function walk(value: unknown, path: string, depth: number): void {
    if (value == null || typeof value !== 'object') {
      // Check for __KUBERNETES_REF_ marker strings left in resolved primitives
      if (typeof value === 'string' && value.includes('__KUBERNETES_REF_')) {
        refs.push({ path, description: `Unresolved reference marker: ${value}` });
      }
      return;
    }

    if (depth >= DEFAULT_MAX_RECURSION_DEPTH) return;
    if (visited.has(value)) return;
    visited.add(value);

    if (isKubernetesRef(value)) {
      const ref = value as { resourceId?: string; fieldPath?: string };
      refs.push({
        path,
        description: `KubernetesRef(${ref.resourceId ?? '?'}.${ref.fieldPath ?? '?'})`,
      });
      return;
    }

    if (isCelExpression(value)) {
      const expr = value as { expression?: string };
      refs.push({
        path,
        description: `CelExpression(${expr.expression ?? '?'})`,
      });
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  }

  for (const [resourceKey, resource] of Object.entries(resources)) {
    const label = `${resource.kind ?? 'Resource'}/${resource.metadata?.name ?? resourceKey}`;
    walk(resource, label, 0);
  }

  return refs;
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
  statusBuilder?: StatusBuilder<TSpec, TStatus, any>,
  options: FactoryOptions = {}
): DirectResourceFactory<TSpec, TStatus> {
  return new DirectResourceFactoryImpl<TSpec, TStatus>(
    name,
    resources,
    schemaDefinition,
    statusBuilder,
    options
  );
}
