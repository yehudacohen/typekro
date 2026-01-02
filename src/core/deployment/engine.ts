/**
 * Direct Deployment Engine
 *
 * Orchestrates the deployment of Kubernetes resources directly to a cluster
 * without requiring the Kro controller, using in-process dependency resolution.
 */

import type * as k8s from '@kubernetes/client-node';
import { ensureReadinessEvaluator } from '../../utils/helpers.js';
import { DependencyResolver } from '../dependencies/index.js';
import { CircularDependencyError } from '../errors.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import type { DeploymentModeType } from '../references/index.js';
import { DeploymentMode, ReferenceResolver } from '../references/index.js';
import type {
  ClosureDependencyInfo,
  DeploymentClosure,
  DeploymentContext,
  DeploymentError,
  DeploymentEvent,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResult,
  DeploymentStateRecord,
  EnhancedDeploymentPlan,
  ResolutionContext,
  ResourceGraph,
  RollbackResult,
} from '../types/deployment.js';
import { ResourceDeploymentError, ResourceConflictError, UnsupportedMediaTypeError } from '../types/deployment.js';
import type { Scope } from '../types/serialization.js';
import type {
  CustomResourceDefinitionItem,
  CustomResourceDefinitionList,
  DeployableK8sResource,
  DeployedResource,
  Enhanced,
  KubernetesApiError,
  KubernetesCondition,
  KubernetesResource,
  ResourceWithConditions,
} from '../types.js';
import { createDebugLoggerFromDeploymentOptions, type DebugLogger } from './debug-logger.js';
import { ResourceReadinessChecker } from './readiness.js';
import { StatusHydrator } from './status-hydrator.js';
import { type EventMonitor, createEventMonitor } from './event-monitor.js';

export class DirectDeploymentEngine {
  private dependencyResolver: DependencyResolver;
  private referenceResolver: ReferenceResolver;
  private k8sApi: k8s.KubernetesObjectApi;
  private readinessChecker: ResourceReadinessChecker;
  private statusHydrator: StatusHydrator;
  private debugLogger?: DebugLogger;
  private eventMonitor?: EventMonitor;
  private deploymentState: Map<string, DeploymentStateRecord> = new Map();
  private readyResources: Set<string> = new Set(); // Track resources that are already ready
  private activeAbortControllers: Set<AbortController> = new Set(); // Track active abort controllers for cleanup
  private logger = getComponentLogger('deployment-engine');

  constructor(
    private kubeClient: k8s.KubeConfig,
    k8sApi?: k8s.KubernetesObjectApi,
    referenceResolver?: ReferenceResolver,
    private deploymentMode: DeploymentModeType = DeploymentMode.DIRECT
  ) {
    this.dependencyResolver = new DependencyResolver();
    this.referenceResolver =
      referenceResolver || new ReferenceResolver(kubeClient, this.deploymentMode, k8sApi);
    // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
    // This works around Bun's fetch TLS issues (https://github.com/oven-sh/bun/issues/10642)
    this.k8sApi = k8sApi || createBunCompatibleKubernetesObjectApi(kubeClient);
    this.readinessChecker = new ResourceReadinessChecker(this.k8sApi);
    this.statusHydrator = new StatusHydrator(this.k8sApi);
    // this.eventFilter = createEventFilter();

    // Set up callback to track ready resources
    this.readinessChecker.setOnResourceReady((resource) => {
      const resourceKey = `${resource.kind}/${resource.name}/${resource.namespace}`;
      this.readyResources.add(resourceKey);
      this.logger.debug('Resource marked as ready via generic readiness checker', {
        resourceKey,
        totalReady: this.readyResources.size,
      });
    });
  }

  /**
   * Create an abortable delay that can be cancelled via AbortSignal
   * @param ms - Delay in milliseconds
   * @param signal - Optional AbortSignal to cancel the delay
   * @returns Promise that resolves after the delay or rejects if aborted
   */
  private abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Delay aborted', 'AbortError'));
        return;
      }

      const timeoutId = setTimeout(() => {
        resolve();
      }, ms);

      signal?.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new DOMException('Delay aborted', 'AbortError'));
      }, { once: true });
    });
  }

  /**
   * Wrap an async operation with abort signal handling
   * If the signal is aborted, the promise will reject with AbortError
   * Note: This doesn't actually cancel the underlying operation, but it allows
   * the caller to stop waiting for it and handle the abort gracefully
   * @param operation - The async operation to wrap
   * @param signal - Optional AbortSignal to cancel the wait
   * @returns Promise that resolves with the operation result or rejects if aborted
   */
  private async withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return operation;
    }

    if (signal.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    return new Promise<T>((resolve, reject) => {
      const abortHandler = () => {
        reject(new DOMException('Operation aborted', 'AbortError'));
      };

      signal.addEventListener('abort', abortHandler, { once: true });

      operation
        .then((result) => {
          signal.removeEventListener('abort', abortHandler);
          resolve(result);
        })
        .catch((error) => {
          signal.removeEventListener('abort', abortHandler);
          // If the signal was aborted, throw AbortError instead of the original error
          if (signal.aborted) {
            reject(new DOMException('Operation aborted', 'AbortError'));
          } else {
            reject(error);
          }
        });
    });
  }

  /**
   * Create and track an AbortController for a deployment operation
   * @returns AbortController that is tracked for cleanup
   */
  private createTrackedAbortController(): AbortController {
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);
    return controller;
  }

  /**
   * Remove an AbortController from tracking
   * @param controller - The AbortController to remove
   */
  private removeTrackedAbortController(controller: AbortController): void {
    this.activeAbortControllers.delete(controller);
  }

  /**
   * Abort all active operations and clean up
   * This is called when a deployment times out or is cancelled
   */
  public abortAllOperations(): void {
    this.logger.debug('Aborting all active operations', {
      activeControllers: this.activeAbortControllers.size,
    });
    for (const controller of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
  }

  /**
   * Get the Kubernetes API client for external integrations
   * @returns The configured KubernetesObjectApi instance
   */
  public getKubernetesApi(): k8s.KubernetesObjectApi {
    return this.k8sApi;
  }

  /**
   * Enhance a resource for evaluation by applying kind-specific logic
   * This allows generic evaluators to work correctly without needing special cases
   */
  private enhanceResourceForEvaluation(
    resource: ResourceWithConditions,
    kind: string
  ): ResourceWithConditions {
    // For HelmRepository resources, handle OCI special case
    if (kind === 'HelmRepository') {
      const spec = resource.spec as { type?: string } | undefined;
      const isOciRepository = spec?.type === 'oci';
      const hasBeenProcessed = resource.metadata?.generation && resource.metadata?.resourceVersion;

      // If it's an OCI repo without Ready condition, synthesize one
      // OCI repositories don't get status conditions from Flux, but they are functional
      // once they've been processed (have generation and resourceVersion)
      if (
        isOciRepository &&
        hasBeenProcessed &&
        !resource.status?.conditions?.some((c: KubernetesCondition) => c.type === 'Ready')
      ) {
        return {
          ...resource,
          status: {
            ...resource.status,
            conditions: [
              ...(resource.status?.conditions || []),
              {
                type: 'Ready',
                status: 'True',
                message: 'OCI repository is functional',
                reason: 'OciRepositoryProcessed',
              },
            ],
          },
        };
      }
    }

    return resource;
  }

  /**
   * Check if a deployed resource is ready using the factory-provided readiness evaluator
   */
  public async isDeployedResourceReady(deployedResource: DeployedResource): Promise<boolean> {
    try {
      // Check if the deployed resource has a factory-provided readiness evaluator
      const readinessEvaluator = (deployedResource.manifest as Enhanced<any, any>)
        .readinessEvaluator;

      if (readinessEvaluator) {
        // Use the factory-provided readiness evaluator
        // Create a resource reference for the API call
        const resourceRef = {
          apiVersion: deployedResource.manifest.apiVersion || '',
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        };

        // Get the live resource from the cluster
        // In the new API, methods return objects directly (no .body wrapper)
        const liveResource = await this.k8sApi.read(resourceRef);

        // Apply kind-specific enhancements before calling custom evaluator
        const enhancedResource = this.enhanceResourceForEvaluation(
          liveResource,
          deployedResource.kind
        );

        // Use the factory-provided readiness evaluator
        const result = readinessEvaluator(enhancedResource);

        let readinessResult: { ready: boolean; reason?: string; details?: Record<string, unknown> };

        if (typeof result === 'boolean') {
          readinessResult = { ready: result };
        } else if (result && typeof result === 'object' && 'ready' in result) {
          readinessResult = result as {
            ready: boolean;
            reason?: string;
            details?: Record<string, unknown>;
          };
        } else {
          this.logger.warn('Readiness evaluator returned unexpected result', {
            resourceId: deployedResource.id,
            result,
          });
          readinessResult = { ready: false, reason: 'Invalid evaluator result' };
        }

        // Debug logging for readiness evaluation
        if (this.debugLogger) {
          this.debugLogger.logReadinessEvaluation(
            deployedResource,
            readinessEvaluator,
            readinessResult
          );
        }

        return readinessResult.ready;
      } else {
        // Fallback to generic readiness checker
        const resourceRef = {
          apiVersion: deployedResource.manifest.apiVersion || '',
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        };

        // In the new API, methods return objects directly (no .body wrapper)
        const liveResource = await this.k8sApi.read(resourceRef);
        return this.readinessChecker.isResourceReady(liveResource);
      }
    } catch (error) {
      this.logger.debug('Failed to check resource readiness', {
        error: error as Error,
        resourceId: deployedResource.id,
        kind: deployedResource.kind,
        name: deployedResource.name,
        namespace: deployedResource.namespace,
      });
      return false;
    }
  }

  /**
   * Get all deployment states for health checking
   */
  public getAllDeploymentStates(): DeploymentStateRecord[] {
    return Array.from(this.deploymentState.values());
  }

  /**
   * Deploy a resource graph to the Kubernetes cluster
   */
  async deploy(graph: ResourceGraph, options: DeploymentOptions): Promise<DeploymentResult> {
    const deploymentId = this.generateDeploymentId();
    const startTime = Date.now();
    const deployedResources: DeployedResource[] = [];

    // Create an AbortController for this deployment to enable proper cancellation
    const deploymentAbortController = this.createTrackedAbortController();
    const abortSignal = deploymentAbortController.signal;

    // Set up timeout-based abort if timeout is specified
    const timeout = options.timeout || 300000; // 5 minutes default
    const timeoutId = setTimeout(() => {
      this.logger.debug('Deployment timeout reached, aborting operations', {
        deploymentId,
        timeout,
      });
      deploymentAbortController.abort();
    }, timeout);
    const errors: DeploymentError[] = [];
    const deploymentLogger = this.logger.child({
      deploymentId,
      resourceCount: graph.resources.length,
    });
    deploymentLogger.info('Starting deployment', { options });

    try {
      this.emitEvent(options, {
        type: 'started',
        message: `Starting deployment of ${graph.resources.length} resources`,
        timestamp: new Date(),
      });

      // 1. Validate no cycles in dependency graph
      deploymentLogger.debug('Validating dependency graph', {
        dependencyGraph: graph.dependencyGraph,
      });
      this.dependencyResolver.validateNoCycles(graph.dependencyGraph);

      // 2. Analyze deployment order and identify parallel stages
      deploymentLogger.debug('Analyzing deployment order for parallel execution');
      const deploymentPlan = this.dependencyResolver.analyzeDeploymentOrder(graph.dependencyGraph);
      deploymentLogger.debug('Deployment plan determined', {
        levels: deploymentPlan.levels.length,
        totalResources: deploymentPlan.totalResources,
        maxParallelism: deploymentPlan.maxParallelism,
      });

      // 3. Initialize and start event monitoring if enabled
      if (options.eventMonitoring?.enabled) {
        try {
          this.eventMonitor = createEventMonitor(this.kubeClient, {
            namespace: options.namespace || 'default',
            eventTypes: options.eventMonitoring.eventTypes || ['Warning', 'Error'],
            includeChildResources: options.eventMonitoring.includeChildResources ?? true,
            startTime: new Date(startTime),
            ...(options.progressCallback && { progressCallback: options.progressCallback }),
          });

          // Start monitoring immediately to capture all deployment events
          await this.eventMonitor.startMonitoring([]);
          deploymentLogger.debug('Event monitoring started for deployment');
        } catch (error) {
          deploymentLogger.warn(
            'Failed to initialize event monitoring, continuing without it',
            error as Error
          );
        }
      }

      // 3.1. Initialize debug logging if enabled
      if (options.debugLogging?.enabled) {
        this.debugLogger = createDebugLoggerFromDeploymentOptions(options);
        this.readinessChecker.setDebugLogger(this.debugLogger);
        deploymentLogger.debug('Debug logging initialized');
      }

      // 4. Create resolution context with resourceKeyMapping for cross-resource references
      // The resourceKeyMapping maps original resource IDs (like 'webappDeployment') to their manifests
      // This allows the reference resolver to find resources by their original IDs during deployment
      const resourceKeyMapping = new Map<string, unknown>();
      for (const resource of graph.resources) {
        const manifest = resource.manifest as KubernetesResource & { __resourceId?: string };
        const originalResourceId = manifest.__resourceId;
        if (originalResourceId) {
          // Convert the Enhanced proxy to a plain object for reliable field extraction
          // The proxy's toJSON method returns a clean object without proxy behavior
          const plainManifest = typeof manifest.toJSON === 'function' 
            ? manifest.toJSON() 
            : JSON.parse(JSON.stringify(manifest));
          resourceKeyMapping.set(originalResourceId, plainManifest);
          deploymentLogger.debug('Added resource to resourceKeyMapping', {
            originalResourceId,
            kind: manifest.kind,
            name: manifest.metadata?.name,
          });
        }
      }

      const context: ResolutionContext = {
        deployedResources,
        kubeClient: this.kubeClient,
        resourceKeyMapping,
        ...(options.namespace && { namespace: options.namespace }),
        timeout: options.timeout || 30000,
      };

      // 5. Deploy resources in parallel stages
      for (let levelIndex = 0; levelIndex < deploymentPlan.levels.length; levelIndex++) {
        const currentLevel = deploymentPlan.levels[levelIndex];
        if (!currentLevel) {
          continue;
        }

        const levelLogger = deploymentLogger.child({
          level: levelIndex + 1,
          resourceCount: currentLevel.length,
        });
        levelLogger.debug(
          `Deploying level ${levelIndex + 1} with ${currentLevel.length} resources in parallel`
        );

        // Track performance metrics for this level
        const levelStartTime = Date.now();

        // Deploy all resources in this level in parallel
        const levelPromises = currentLevel.map(async (resourceId) => {
          const resourceLogger = deploymentLogger.child({ resourceId });
          resourceLogger.debug('Starting resource deployment');

          const resource = graph.resources.find((r) => r.id === resourceId);
          if (!resource) {
            resourceLogger.error('Resource not found in graph');
            const error = new Error(`Resource with id '${resourceId}' not found in graph`);
            return {
              success: false,
              resourceId,
              error: {
                resourceId,
                phase: 'validation' as const,
                error,
                timestamp: new Date(),
              },
            };
          }

          resourceLogger.debug('Found resource in graph', {
            resourceId: resource.id,
            kind: resource.manifest?.kind,
            name: resource.manifest?.metadata?.name,
          });

          try {
            resourceLogger.debug('Calling deploySingleResource');

            // Wait for CRD establishment if this is a custom resource
            await this.waitForCRDIfCustomResource(resource.manifest, options, resourceLogger, abortSignal);

            // FIX: Unconditionally ensure the readiness evaluator is attached just before deployment.
            const resourceWithEvaluator = ensureReadinessEvaluator(resource.manifest);

            // Add resource to event monitoring before deployment to capture creation events
            if (this.eventMonitor) {
              const preDeployedResource: DeployedResource = {
                id: resourceId,
                kind: resourceWithEvaluator.kind,
                name: resourceWithEvaluator.metadata?.name || 'unknown',
                namespace:
                  resourceWithEvaluator.metadata?.namespace || options.namespace || 'default',
                manifest: resourceWithEvaluator,
                status: 'deployed',
                deployedAt: new Date(),
              };
              try {
                await this.eventMonitor.addResources([preDeployedResource]);
                resourceLogger.debug('Added resource to event monitoring before deployment');
              } catch (error) {
                resourceLogger.warn(
                  'Failed to add resource to event monitoring, continuing deployment',
                  error as Error
                );
              }
            }

            const deployedResource = await this.deploySingleResource(
              resourceWithEvaluator,
              context,
              options,
              abortSignal
            );
            resourceLogger.debug('Resource deployed successfully');

            return {
              success: true,
              resourceId,
              deployedResource,
            };
          } catch (error) {
            resourceLogger.error('Resource deployment failed', error as Error);
            const failedResource: DeployedResource = {
              id: resourceId,
              kind: resource.manifest.kind,
              name: resource.manifest.metadata?.name || 'unknown',
              namespace: resource.manifest.metadata?.namespace || 'default',
              manifest: resource.manifest,
              status: 'failed',
              deployedAt: new Date(),
              error: error as Error,
            };
            return {
              success: false,
              resourceId,
              deployedResource: failedResource,
              error: {
                resourceId,
                phase: 'deployment' as const,
                error: error as Error,
                timestamp: new Date(),
              },
            };
          }
        });

        // Wait for all resources in this level to complete
        const levelResults = await Promise.allSettled(levelPromises);

        // Process results and handle errors
        let levelHasFailures = false;
        for (const result of levelResults) {
          if (result.status === 'fulfilled') {
            const deploymentResult = result.value;
            if (deploymentResult.success && deploymentResult.deployedResource) {
              deployedResources.push(deploymentResult.deployedResource);
              
              // Update resourceKeyMapping with the live resource from the cluster (including status)
              // This is critical for CEL expression evaluation which needs access to resource status
              const deployedRes = deploymentResult.deployedResource;
              const manifestWithId = deployedRes.manifest as KubernetesResource & { __resourceId?: string };
              const originalResourceId = manifestWithId.__resourceId;
              if (originalResourceId && resourceKeyMapping.has(originalResourceId)) {
                try {
                  // Query the live resource from the cluster to get its current status
                  const liveResource = await this.k8sApi.read({
                    apiVersion: deployedRes.manifest.apiVersion || '',
                    kind: deployedRes.kind,
                    metadata: {
                      name: deployedRes.name,
                      namespace: deployedRes.namespace,
                    },
                  });
                  resourceKeyMapping.set(originalResourceId, liveResource);
                  deploymentLogger.debug('Updated resourceKeyMapping with live resource status', {
                    originalResourceId,
                    kind: deployedRes.kind,
                    name: deployedRes.name,
                    hasStatus: !!(liveResource as any).status,
                  });
                } catch (error) {
                  deploymentLogger.warn('Failed to update resourceKeyMapping with live resource', {
                    originalResourceId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            } else {
              levelHasFailures = true;
              if (deploymentResult.error) {
                errors.push(deploymentResult.error);
              }
              if (deploymentResult.deployedResource) {
                deployedResources.push(deploymentResult.deployedResource);
              }
            }
          } else {
            // Promise was rejected
            levelHasFailures = true;
            levelLogger.error('Unexpected promise rejection in parallel deployment', result.reason);
          }
        }

        // Resources are now added to event monitoring before deployment (see individual resource deployment above)

        // Handle rollback if there are failures and rollback is enabled
        if (levelHasFailures && options.rollbackOnFailure) {
          levelLogger.warn('Level deployment failed, initiating rollback');
          await this.rollbackDeployedResources(deployedResources, options);

          const duration = Date.now() - startTime;
          this.emitEvent(options, {
            type: 'rollback',
            message: `Deployment failed and rolled back in ${duration}ms`,
            timestamp: new Date(),
          });
          return {
            deploymentId,
            resources: deployedResources,
            dependencyGraph: graph.dependencyGraph,
            duration,
            status: 'failed',
            errors,
          };
        }

        // Calculate level performance metrics
        const levelDuration = Date.now() - levelStartTime;
        const successfulCount = levelResults.filter(
          (r) => r.status === 'fulfilled' && r.value.success
        ).length;
        const failedCount = levelResults.filter(
          (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)
        ).length;

        levelLogger.info(`Level ${levelIndex + 1} deployment completed`, {
          successful: successfulCount,
          failed: failedCount,
          duration: levelDuration,
          parallelism: currentLevel.length,
          averageTimePerResource: Math.round(levelDuration / currentLevel.length),
        });
      }

      const duration = Date.now() - startTime;
      const successfulResources = deployedResources.filter((r) => r.status !== 'failed');
      const status =
        errors.length === 0 ? 'success' : successfulResources.length > 0 ? 'partial' : 'failed';

      // Log comprehensive performance metrics
      deploymentLogger.info('Parallel deployment performance metrics', {
        totalDuration: duration,
        totalResources: deploymentPlan.totalResources,
        parallelLevels: deploymentPlan.levels.length,
        maxParallelism: deploymentPlan.maxParallelism,
        averageTimePerResource: Math.round(duration / deploymentPlan.totalResources),
        successfulResources: successfulResources.length,
        failedResources: errors.length,
        parallelismEfficiency: Math.round(
          (deploymentPlan.totalResources /
            deploymentPlan.levels.length /
            deploymentPlan.maxParallelism) *
            100
        ),
        status,
      });

      this.emitEvent(options, {
        type: status === 'success' ? 'completed' : 'failed',
        message: `Deployment ${status} in ${duration}ms (${deploymentPlan.levels.length} parallel levels, max ${deploymentPlan.maxParallelism} concurrent)`,
        timestamp: new Date(),
      });

      // Stop event monitoring
      if (this.eventMonitor) {
        try {
          await this.eventMonitor.stopMonitoring();
          deploymentLogger.debug('Event monitoring stopped');
        } catch (error) {
          deploymentLogger.warn('Failed to stop event monitoring cleanly', error as Error);
        }
      }

      // Clean up abort controller and timeout
      clearTimeout(timeoutId);
      this.removeTrackedAbortController(deploymentAbortController);

      // Store deployment state for rollback
      this.deploymentState.set(deploymentId, {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        startTime: new Date(startTime),
        endTime: new Date(),
        status: status === 'success' ? 'completed' : status === 'partial' ? 'completed' : 'failed',
        options,
      });

      return {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        duration,
        status,
        errors,
      };
    } catch (error) {
      // Re-throw circular dependency errors immediately - these are configuration errors
      if (error instanceof CircularDependencyError) {
        // Clean up abort controller and timeout before re-throwing
        clearTimeout(timeoutId);
        this.removeTrackedAbortController(deploymentAbortController);
        throw error;
      }

      // Clean up abort controller and timeout
      clearTimeout(timeoutId);
      this.removeTrackedAbortController(deploymentAbortController);

      const duration = Date.now() - startTime;
      this.emitEvent(options, {
        type: 'failed',
        message: `Deployment failed: ${error}`,
        timestamp: new Date(),
        error: error as Error,
      });

      // Stop event monitoring on error
      if (this.eventMonitor) {
        try {
          await this.eventMonitor.stopMonitoring();
        } catch (_cleanupError) {
          // Ignore cleanup errors in error path
        }
      }

      // Store deployment state even for failed deployments (for rollback)
      this.deploymentState.set(deploymentId, {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        startTime: new Date(startTime),
        endTime: new Date(),
        status: 'failed',
        options,
      });

      return {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        duration,
        status: 'failed',
        errors: [
          {
            resourceId: 'deployment',
            phase: 'deployment',
            error: error as Error,
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Analyze closure dependencies to determine execution levels
   */
  private analyzeClosureDependencies<TSpec>(
    closures: Record<string, DeploymentClosure>,
    spec: TSpec,
    dependencyGraph: import('../dependencies/index.js').DependencyGraph
  ): ClosureDependencyInfo[] {
    const closureDependencies: ClosureDependencyInfo[] = [];

    for (const [name, closure] of Object.entries(closures)) {
      // For now, analyze dependencies by examining the closure's configuration
      // This is a simplified implementation - in practice, we would need to analyze
      // the closure's arguments to detect resource references
      const dependencies = this.extractClosureDependencies(closure, spec);

      // Determine execution level based on dependencies
      // For now, assign all closures to level -1 to ensure they run before all resources
      // This is especially important for closures that install CRDs (like fluxSystem)
      let level = -1;
      if (dependencies.length > 0) {
        // Find the maximum level of any dependency + 1
        for (const depId of dependencies) {
          const depLevel = this.getResourceLevel(depId, dependencyGraph);
          level = Math.max(level, depLevel + 1);
        }
      }

      closureDependencies.push({
        name,
        closure,
        dependencies,
        level,
      });
    }

    return closureDependencies;
  }

  /**
   * Extract dependencies from a closure by analyzing its configuration
   * This is a simplified implementation - in practice, we would need more sophisticated analysis
   */
  private extractClosureDependencies<TSpec>(_closure: DeploymentClosure, _spec: TSpec): string[] {
    // For now, return empty dependencies since closures typically don't depend on Enhanced<> resources
    // In the future, this could analyze closure arguments for resource references
    return [];
  }

  /**
   * Get the execution level of a resource in the dependency graph
   */
  private getResourceLevel(
    resourceId: string,
    dependencyGraph: import('../dependencies/index.js').DependencyGraph
  ): number {
    // Find the level where this resource appears in the deployment plan
    const deploymentPlan = this.dependencyResolver.analyzeDeploymentOrder(dependencyGraph);

    for (let levelIndex = 0; levelIndex < deploymentPlan.levels.length; levelIndex++) {
      const level = deploymentPlan.levels[levelIndex];
      if (level?.includes(resourceId)) {
        return levelIndex;
      }
    }

    return 0; // Default to level 0 if not found
  }

  /**
   * Integrate closures into the deployment plan based on their dependencies
   */
  private integrateClosuresIntoPlan(
    deploymentPlan: { levels: string[][]; totalResources: number; maxParallelism: number },
    closureDependencies: ClosureDependencyInfo[]
  ): EnhancedDeploymentPlan {
    // Create enhanced levels with both resources and closures
    const enhancedLevels: Array<{ resources: string[]; closures: ClosureDependencyInfo[] }> = [];

    // Check if we have any closures at level -1 (pre-resource level)
    const preResourceClosures = closureDependencies.filter((c) => c.level === -1);

    // If we have pre-resource closures, add them as level 0 and shift everything else
    if (preResourceClosures.length > 0) {
      enhancedLevels.push({
        resources: [],
        closures: preResourceClosures,
      });
    }

    // Initialize levels with existing resources (shifted if we added a pre-resource level)
    for (let i = 0; i < deploymentPlan.levels.length; i++) {
      enhancedLevels.push({
        resources: deploymentPlan.levels[i] || [],
        closures: [],
      });
    }

    // Add closures to their appropriate levels (excluding level -1 which we already handled)
    for (const closureInfo of closureDependencies) {
      if (closureInfo.level === -1) {
        continue; // Already handled above
      }

      // Adjust level index if we added a pre-resource level
      const adjustedLevel =
        preResourceClosures.length > 0 ? closureInfo.level + 1 : closureInfo.level;

      // Ensure we have enough levels
      while (enhancedLevels.length <= adjustedLevel) {
        enhancedLevels.push({ resources: [], closures: [] });
      }

      const targetLevel = enhancedLevels[adjustedLevel];
      if (targetLevel) {
        targetLevel.closures.push(closureInfo);
      }
    }

    return {
      levels: enhancedLevels,
      totalResources: deploymentPlan.totalResources,
      totalClosures: closureDependencies.length,
      maxParallelism: Math.max(
        deploymentPlan.maxParallelism,
        Math.max(...enhancedLevels.map((level) => level.closures.length))
      ),
    };
  }

  /**
   * Deploy a resource graph with deployment closures integrated into level-based execution
   */
  async deployWithClosures<TSpec>(
    graph: ResourceGraph,
    closures: Record<string, DeploymentClosure>,
    options: DeploymentOptions,
    spec: TSpec,
    alchemyScope?: Scope
  ): Promise<DeploymentResult> {
    const deploymentId = this.generateDeploymentId();
    const startTime = Date.now();
    const deployedResources: DeployedResource[] = [];
    const errors: DeploymentError[] = [];
    const deploymentLogger = this.logger.child({
      deploymentId,
      resourceCount: graph.resources.length,
      closureCount: Object.keys(closures).length,
    });

    // Create an AbortController for this deployment to enable proper cancellation
    const deploymentAbortController = this.createTrackedAbortController();
    const abortSignal = deploymentAbortController.signal;

    // Set up timeout-based abort if timeout is specified
    const timeout = options.timeout || 300000; // 5 minutes default
    const timeoutId = setTimeout(() => {
      deploymentLogger.debug('Deployment timeout reached, aborting operations', {
        deploymentId,
        timeout,
      });
      deploymentAbortController.abort();
    }, timeout);

    deploymentLogger.info('Starting deployment with closures', {
      options,
      closures: Object.keys(closures),
    });

    try {
      this.emitEvent(options, {
        type: 'started',
        message: `Starting deployment of ${graph.resources.length} resources and ${Object.keys(closures).length} closures`,
        timestamp: new Date(),
      });

      // 1. Validate no cycles in dependency graph
      deploymentLogger.debug('Validating dependency graph', {
        dependencyGraph: graph.dependencyGraph,
      });
      this.dependencyResolver.validateNoCycles(graph.dependencyGraph);

      // 2. Analyze deployment order and identify parallel stages
      deploymentLogger.debug('Analyzing deployment order for parallel execution');
      const deploymentPlan = this.dependencyResolver.analyzeDeploymentOrder(graph.dependencyGraph);
      deploymentLogger.debug('Deployment plan determined', {
        levels: deploymentPlan.levels.length,
        totalResources: deploymentPlan.totalResources,
        maxParallelism: deploymentPlan.maxParallelism,
      });

      // 3. Analyze closure dependencies and integrate into deployment plan
      const closureDependencies = this.analyzeClosureDependencies(
        closures,
        spec,
        graph.dependencyGraph
      );
      const enhancedPlan = this.integrateClosuresIntoPlan(deploymentPlan, closureDependencies);

      deploymentLogger.debug('Enhanced deployment plan with closures', {
        levels: enhancedPlan.levels.length,
        totalResources: enhancedPlan.totalResources,
        totalClosures: enhancedPlan.totalClosures,
        maxParallelism: enhancedPlan.maxParallelism,
      });

      // 4. Create resolution context with resourceKeyMapping for cross-resource references
      // The resourceKeyMapping maps original resource IDs (like 'webappDeployment') to their manifests
      const resourceKeyMapping = new Map<string, unknown>();
      for (const resource of graph.resources) {
        const manifest = resource.manifest as KubernetesResource & { __resourceId?: string };
        const originalResourceId = manifest.__resourceId;
        if (originalResourceId) {
          // Convert the Enhanced proxy to a plain object for reliable field extraction
          // The proxy's toJSON method returns a clean object without proxy behavior
          const plainManifest = typeof manifest.toJSON === 'function' 
            ? manifest.toJSON() 
            : JSON.parse(JSON.stringify(manifest));
          resourceKeyMapping.set(originalResourceId, plainManifest);
          deploymentLogger.debug('Added resource to resourceKeyMapping', {
            originalResourceId,
            kind: manifest.kind,
            name: manifest.metadata?.name,
          });
        }
      }

      const context: ResolutionContext = {
        deployedResources,
        kubeClient: this.kubeClient,
        resourceKeyMapping,
        ...(options.namespace && { namespace: options.namespace }),
        timeout: options.timeout || 30000,
      };

      // 5. Deploy resources and closures level by level with proper dependency handling
      for (let levelIndex = 0; levelIndex < enhancedPlan.levels.length; levelIndex++) {
        const currentLevel = enhancedPlan.levels[levelIndex];
        if (!currentLevel) {
          continue;
        }

        const levelLogger = deploymentLogger.child({
          level: levelIndex + 1,
          resourceCount: currentLevel.resources.length,
          closureCount: currentLevel.closures.length,
        });
        levelLogger.debug(
          `Deploying level ${levelIndex + 1} with ${currentLevel.resources.length} resources and ${currentLevel.closures.length} closures in parallel`
        );

        const levelStartTime = Date.now();

        // Create deployment context for closures at this level
        const deployedResourcesMap = new Map<string, DeployedResource>();
        // Populate with resources from previous levels
        for (const resource of deployedResources) {
          deployedResourcesMap.set(resource.id, resource);
        }

        const deploymentContext: DeploymentContext = {
          kubernetesApi: this.k8sApi,
          ...(alchemyScope && { alchemyScope }),
          ...(options.namespace && { namespace: options.namespace }),
          deployedResources: deployedResourcesMap,
          resolveReference: async (ref: unknown): Promise<unknown> => {
            // Enhanced reference resolution - will be improved in future tasks
            return ref;
          },
        };

        // Prepare promises for both resources and closures
        const levelPromises: Promise<any>[] = [];

        // Add resource deployment promises
        const resourcePromises = currentLevel.resources.map(async (resourceId) => {
          const resourceLogger = deploymentLogger.child({ resourceId });
          resourceLogger.debug('Starting resource deployment');

          const resource = graph.resources.find((r) => r.id === resourceId);
          if (!resource) {
            resourceLogger.error('Resource not found in graph');
            const error = new Error(`Resource with id '${resourceId}' not found in graph`);
            return {
              success: false,
              resourceId,
              error: {
                resourceId,
                phase: 'validation' as const,
                error,
                timestamp: new Date(),
              },
            };
          }

          resourceLogger.debug('Found resource in graph', {
            resourceId: resource.id,
            kind: resource.manifest?.kind,
            name: resource.manifest?.metadata?.name,
          });

          try {
            resourceLogger.debug('Calling deploySingleResource');

            // Wait for CRD establishment if this is a custom resource
            await this.waitForCRDIfCustomResource(resource.manifest, options, resourceLogger, abortSignal);

            const resourceWithEvaluator = ensureReadinessEvaluator(resource.manifest);
            const deployedResource = await this.deploySingleResource(
              resourceWithEvaluator,
              context,
              options,
              abortSignal
            );
            resourceLogger.debug('Resource deployed successfully');

            return {
              success: true,
              resourceId,
              deployedResource,
            };
          } catch (error) {
            resourceLogger.error('Resource deployment failed', error as Error);
            const failedResource: DeployedResource = {
              id: resourceId,
              kind: resource.manifest.kind,
              name: resource.manifest.metadata?.name || 'unknown',
              namespace: resource.manifest.metadata?.namespace || 'default',
              manifest: resource.manifest,
              status: 'failed',
              deployedAt: new Date(),
              error: error as Error,
            };
            return {
              success: false,
              resourceId,
              deployedResource: failedResource,
              error: {
                resourceId,
                phase: 'deployment' as const,
                error: error as Error,
                timestamp: new Date(),
              },
            };
          }
        });

        // Add closure execution promises
        const closurePromises = currentLevel.closures.map(async (closureInfo) => {
          const closureLogger = levelLogger.child({ closureName: closureInfo.name });
          closureLogger.debug('Executing closure at level', { level: levelIndex + 1 });

          try {
            const result = await closureInfo.closure(deploymentContext);
            closureLogger.debug('Closure executed successfully', {
              resultCount: result?.length || 0,
            });
            return {
              success: true,
              type: 'closure' as const,
              name: closureInfo.name,
              result,
            };
          } catch (error) {
            closureLogger.error('Closure execution failed', error as Error);
            return {
              success: false,
              type: 'closure' as const,
              name: closureInfo.name,
              error: {
                resourceId: `closure-${closureInfo.name}`,
                phase: 'deployment' as const,
                error: error as Error,
                timestamp: new Date(),
              },
            };
          }
        });

        // Combine all promises for this level
        levelPromises.push(...resourcePromises, ...closurePromises);

        // Wait for all resources and closures in this level to complete
        const levelResults = await Promise.allSettled(levelPromises);

        // Process results and handle errors
        let levelHasFailures = false;
        let successfulResources = 0;
        let successfulClosures = 0;
        let failedResources = 0;
        let failedClosures = 0;

        for (const result of levelResults) {
          if (result.status === 'fulfilled') {
            const deploymentResult = result.value;

            if (deploymentResult.type === 'closure') {
              // Handle closure result
              if (deploymentResult.success) {
                successfulClosures++;
              } else {
                levelHasFailures = true;
                failedClosures++;
                if (deploymentResult.error) {
                  errors.push(deploymentResult.error);
                }
              }
            } else {
              // Handle resource result
              if (deploymentResult.success && deploymentResult.deployedResource) {
                deployedResources.push(deploymentResult.deployedResource);
                successfulResources++;
                
                // Update resourceKeyMapping with the live resource from the cluster (including status)
                // This is critical for CEL expression evaluation which needs access to resource status
                const deployedRes = deploymentResult.deployedResource;
                const manifestWithId = deployedRes.manifest as KubernetesResource & { __resourceId?: string };
                const originalResourceId = manifestWithId.__resourceId;
                if (originalResourceId && resourceKeyMapping.has(originalResourceId)) {
                  try {
                    // Query the live resource from the cluster to get its current status
                    const liveResource = await this.k8sApi.read({
                      apiVersion: deployedRes.manifest.apiVersion || '',
                      kind: deployedRes.kind,
                      metadata: {
                        name: deployedRes.name,
                        namespace: deployedRes.namespace,
                      },
                    });
                    resourceKeyMapping.set(originalResourceId, liveResource);
                    deploymentLogger.debug('Updated resourceKeyMapping with live resource status', {
                      originalResourceId,
                      kind: deployedRes.kind,
                      name: deployedRes.name,
                      hasStatus: !!(liveResource as any).status,
                    });
                  } catch (error) {
                    deploymentLogger.warn('Failed to update resourceKeyMapping with live resource', {
                      originalResourceId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  }
                }
              } else {
                levelHasFailures = true;
                failedResources++;
                if (deploymentResult.error) {
                  errors.push(deploymentResult.error);
                }
                if (deploymentResult.deployedResource) {
                  deployedResources.push(deploymentResult.deployedResource);
                }
              }
            }
          } else {
            levelHasFailures = true;
            levelLogger.error('Unexpected promise rejection in parallel deployment', result.reason);
          }
        }

        // Handle rollback if there are failures and rollback is enabled
        if (levelHasFailures && options.rollbackOnFailure) {
          levelLogger.warn('Level deployment failed, initiating rollback');
          await this.rollbackDeployedResources(deployedResources, options);

          const duration = Date.now() - startTime;
          this.emitEvent(options, {
            type: 'rollback',
            message: `Deployment failed and rolled back in ${duration}ms`,
            timestamp: new Date(),
          });
          return {
            deploymentId,
            resources: deployedResources,
            dependencyGraph: graph.dependencyGraph,
            duration,
            status: 'failed',
            errors,
          };
        }

        // Calculate level performance metrics
        const levelDuration = Date.now() - levelStartTime;
        const totalOperations = currentLevel.resources.length + currentLevel.closures.length;

        levelLogger.info(`Level ${levelIndex + 1} deployment completed`, {
          resources: { successful: successfulResources, failed: failedResources },
          closures: { successful: successfulClosures, failed: failedClosures },
          duration: levelDuration,
          parallelism: totalOperations,
          averageTimePerOperation:
            totalOperations > 0 ? Math.round(levelDuration / totalOperations) : 0,
        });
      }

      const duration = Date.now() - startTime;
      const successfulResources = deployedResources.filter((r) => r.status !== 'failed');
      const status =
        errors.length === 0 ? 'success' : successfulResources.length > 0 ? 'partial' : 'failed';

      // Log comprehensive performance metrics
      deploymentLogger.info('Parallel deployment with closures performance metrics', {
        totalDuration: duration,
        totalResources: enhancedPlan.totalResources,
        totalClosures: enhancedPlan.totalClosures,
        parallelLevels: enhancedPlan.levels.length,
        maxParallelism: enhancedPlan.maxParallelism,
        averageTimePerResource:
          enhancedPlan.totalResources > 0 ? Math.round(duration / enhancedPlan.totalResources) : 0,
        successfulResources: successfulResources.length,
        failedResources: errors.length,
        status,
      });

      this.emitEvent(options, {
        type: status === 'success' ? 'completed' : 'failed',
        message: `Deployment with closures ${status} in ${duration}ms (${enhancedPlan.totalClosures} closures + ${enhancedPlan.totalResources} resources across ${enhancedPlan.levels.length} levels)`,
        timestamp: new Date(),
      });

      // Clean up abort controller and timeout
      clearTimeout(timeoutId);
      this.removeTrackedAbortController(deploymentAbortController);

      // Store deployment state for rollback
      this.deploymentState.set(deploymentId, {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        startTime: new Date(startTime),
        endTime: new Date(),
        status: status === 'success' ? 'completed' : status === 'partial' ? 'completed' : 'failed',
        options,
      });

      return {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        duration,
        status,
        errors,
      };
    } catch (error) {
      // Re-throw circular dependency errors immediately - these are configuration errors
      if (error instanceof CircularDependencyError) {
        // Clean up abort controller and timeout before re-throwing
        clearTimeout(timeoutId);
        this.removeTrackedAbortController(deploymentAbortController);
        throw error;
      }

      // Clean up abort controller and timeout
      clearTimeout(timeoutId);
      this.removeTrackedAbortController(deploymentAbortController);

      const duration = Date.now() - startTime;
      this.emitEvent(options, {
        type: 'failed',
        message: `Deployment with closures failed: ${error}`,
        timestamp: new Date(),
        error: error as Error,
      });

      // Store deployment state even for failed deployments (for rollback)
      this.deploymentState.set(deploymentId, {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        startTime: new Date(startTime),
        endTime: new Date(),
        status: 'failed',
        options,
      });

      return {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        duration,
        status: 'failed',
        errors: [
          {
            resourceId: 'deployment',
            phase: 'deployment',
            error: error as Error,
            timestamp: new Date(),
          },
        ],
      };
    }
  } /**

   * Deploy a single resource
   */
  private async deploySingleResource(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>,
    context: ResolutionContext,
    options: DeploymentOptions,
    abortSignal?: AbortSignal
  ): Promise<DeployedResource> {
    // Check if already aborted
    if (abortSignal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    // __resourceId is an internal field that may be set during resource processing
    const resourceWithInternalId = resource as KubernetesResource & { __resourceId?: string };
    const resourceId =
      resource.id || resourceWithInternalId.__resourceId || resource.metadata?.name || 'unknown';
    const resourceLogger = this.logger.child({
      resourceId,
      kind: resource.kind,
      name: resource.metadata?.name,
    });
    resourceLogger.debug('Starting single resource deployment');

    this.emitEvent(options, {
      type: 'progress',
      resourceId,
      message: `Deploying ${resource.kind}/${resource.metadata?.name}`,
      timestamp: new Date(),
    });

    // 1. Resolve all references in the resource
    let resolvedResource: KubernetesResource;
    try {
      resourceLogger.debug('Resolving resource references', {
        originalMetadata: resource.metadata,
      });
      const resolveTimeout = options.timeout || 30000;
      resolvedResource = (await Promise.race([
        this.referenceResolver.resolveReferences(resource, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Reference resolution timeout')), resolveTimeout)
        ),
      ])) as KubernetesResource;
      // Check for readinessEvaluator which may be on Enhanced resources
      const enhancedResource = resolvedResource as KubernetesResource & {
        readinessEvaluator?: (liveResource: unknown) => { ready: boolean; message?: string };
      };
      resourceLogger.debug('References resolved successfully', {
        resolvedMetadata: resolvedResource.metadata,
        hasReadinessEvaluator: !!enhancedResource.readinessEvaluator,
      });
    } catch (error) {
      // In Alchemy deployments, resourceKeyMapping is often empty because resources are deployed
      // one at a time. This is expected behavior, so we log at debug level instead of warn.
      const hasResourceKeyMapping = context.resourceKeyMapping && context.resourceKeyMapping.size > 0;
      if (hasResourceKeyMapping) {
        resourceLogger.warn('Reference resolution failed, using original resource', error as Error);
      } else {
        resourceLogger.debug('Reference resolution skipped (no resourceKeyMapping), using original resource', {
          error: (error as Error).message,
        });
      }
      resolvedResource = resource;
    }

    // 2. Apply namespace if specified, but only if resource doesn't already have one
    if (
      options.namespace &&
      resolvedResource.metadata &&
      typeof resolvedResource.metadata.namespace !== 'string'
    ) {
      resourceLogger.debug('Applying namespace from deployment options', {
        targetNamespace: options.namespace,
        currentNamespace: resolvedResource.metadata.namespace,
        currentNamespaceType: typeof resolvedResource.metadata.namespace,
      });

      // Create a completely new metadata object to avoid proxy issues
      const newMetadata = {
        ...resolvedResource.metadata,
        namespace: options.namespace,
      };

      // Preserve the readiness evaluator when creating the new resource
      const newResolvedResource = {
        ...resolvedResource,
        metadata: newMetadata,
      };

      // Copy the non-enumerable readiness evaluator if it exists
      const resourceWithEvaluator = resolvedResource as KubernetesResource & {
        readinessEvaluator?: (liveResource: unknown) => { ready: boolean; message?: string };
        __resourceId?: string;
      };
      const readinessEvaluator = resourceWithEvaluator.readinessEvaluator;
      if (readinessEvaluator) {
        Object.defineProperty(newResolvedResource, 'readinessEvaluator', {
          value: readinessEvaluator,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }

      // Copy the non-enumerable __resourceId if it exists (used for cross-resource references)
      const originalResourceId = resourceWithEvaluator.__resourceId;
      if (originalResourceId) {
        Object.defineProperty(newResolvedResource, '__resourceId', {
          value: originalResourceId,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }

      resolvedResource = newResolvedResource;
    }

    // 3. Apply the resource to the cluster (or simulate for dry run)
    let appliedResource: k8s.KubernetesObject;

    if (options.dryRun) {
      // In dry run mode, don't actually create the resource
      resourceLogger.debug('Dry run mode: simulating resource creation');
      appliedResource = {
        ...resolvedResource,
        metadata: {
          ...resolvedResource.metadata,
          uid: 'dry-run-uid',
        },
      } as k8s.KubernetesObject;
    } else {
      // Apply resource with retry logic
      const retryPolicy = options.retryPolicy || {
        maxRetries: 3,
        backoffMultiplier: 2,
        initialDelay: 1000,
        maxDelay: 30000,
      };

      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
        try {
          resourceLogger.debug('Applying resource to cluster', { attempt });

          // Check if resource already exists
          let existing: k8s.KubernetesObject | undefined;
          try {
            // In the new API, methods return objects directly (no .body wrapper)
            existing = await this.k8sApi.read({
              apiVersion: resolvedResource.apiVersion,
              kind: resolvedResource.kind,
              metadata: {
                name: resolvedResource.metadata?.name || '',
                namespace: resolvedResource.metadata?.namespace || 'default',
              },
            });
          } catch (error: unknown) {
            // If it's a 404, the resource doesn't exist, which is expected for creation
            const apiError = error as KubernetesApiError;
            // Check for 404 in various error formats:
            // - apiError.statusCode (direct property)
            // - apiError.response?.statusCode (nested response)
            // - apiError.body?.code (body code)
            // - error message containing "HTTP-Code: 404"
            const is404 =
              apiError.statusCode === 404 ||
              apiError.response?.statusCode === 404 ||
              apiError.body?.code === 404 ||
              (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 404'));

            if (!is404) {
              // Also check for "Unrecognized API version and kind" errors - these indicate
              // the CRD is not installed yet, which should trigger CRD waiting logic
              const isUnrecognizedApiError =
                typeof apiError.message === 'string' &&
                apiError.message.includes('Unrecognized API version and kind');

              if (isUnrecognizedApiError) {
                resourceLogger.debug(
                  'CRD not yet registered, will retry after CRD establishment',
                  error as Error
                );
              } else {
                resourceLogger.error('Error checking resource existence', error as Error);
              }
              throw error;
            }
            // 404 means resource doesn't exist - this is expected, we'll create it below
          }

          if (existing) {
            // Resource exists, use patch for safer updates
            // Log the full resource being patched, including non-standard fields like 'data' for Secrets
            const patchPayload: Partial<KubernetesResource> = {
              apiVersion: resolvedResource.apiVersion,
              kind: resolvedResource.kind,
              metadata: resolvedResource.metadata,
            };

            // Include spec if present (most resources)
            if (resolvedResource.spec !== undefined) {
              patchPayload.spec = resolvedResource.spec;
            }

            // Include data if present (Secrets)
            if (resolvedResource.data !== undefined) {
              patchPayload.data = resolvedResource.data;
            }

            // Include stringData if present (Secrets)
            if (resolvedResource.stringData !== undefined) {
              patchPayload.stringData = resolvedResource.stringData;
            }

            // Include rules if present (RBAC resources)
            if (resolvedResource.rules !== undefined) {
              // Ensure arrays are preserved (not converted to objects with numeric keys)
              const rules = resolvedResource.rules;
              patchPayload.rules = Array.isArray(rules) ? [...rules] : rules;
            }

            // Include subjects if present (ClusterRoleBinding, RoleBinding)
            if (resolvedResource.subjects !== undefined) {
              // Ensure arrays are preserved (not converted to objects with numeric keys)
              const subjects = resolvedResource.subjects;
              patchPayload.subjects = Array.isArray(subjects) ? [...subjects] : subjects;
            }

            // Include roleRef if present (ClusterRoleBinding, RoleBinding)
            if (resolvedResource.roleRef !== undefined) {
              patchPayload.roleRef = resolvedResource.roleRef;
            }

            // Explicitly call toJSON to ensure arrays are preserved via our custom toJSON implementation
            // Then use JSON.parse(JSON.stringify()) to ensure we have a plain object without proxies
            const jsonPayload =
              typeof resolvedResource.toJSON === 'function'
                ? resolvedResource.toJSON()
                : patchPayload;

            // Deep clone to remove any proxy wrappers that might cause serialization issues
            const cleanPayload = JSON.parse(JSON.stringify(jsonPayload));

            // Strip internal TypeKro fields that should not be sent to Kubernetes
            // The 'id' field is used internally for resource mapping but is not a valid K8s field
            delete cleanPayload.id;

            resourceLogger.debug('Resource exists, patching', { patchPayload: cleanPayload });
            // In the new API, methods return objects directly (no .body wrapper)
            appliedResource = await this.patchResourceWithCorrectContentType(cleanPayload);
          } else {
            // Resource does not exist, create it
            resourceLogger.debug('Resource does not exist, creating');

            // DEBUG: Log the resource being created for Secrets
            if (resolvedResource.kind === 'Secret') {
              resourceLogger.debug('Creating Secret resource', {
                name: resolvedResource.metadata?.name,
                hasData: 'data' in resolvedResource,
                hasSpec: 'spec' in resolvedResource,
                dataKeys: resolvedResource.data ? Object.keys(resolvedResource.data) : [],
                specValue: resolvedResource.spec,
              });
            }

            // Explicitly call toJSON to ensure arrays are preserved via our custom toJSON implementation
            // Then use JSON.parse(JSON.stringify()) to ensure we have a plain object without proxies
            const jsonResource =
              typeof resolvedResource.toJSON === 'function'
                ? resolvedResource.toJSON()
                : resolvedResource;

            // Deep clone to remove any proxy wrappers that might cause serialization issues
            const cleanResource = JSON.parse(JSON.stringify(jsonResource));

            // Strip internal TypeKro fields that should not be sent to Kubernetes
            // The 'id' field is used internally for resource mapping but is not a valid K8s field
            delete cleanResource.id;

            // In the new API, methods return objects directly (no .body wrapper)
            appliedResource = await this.k8sApi.create(cleanResource);
          }

          resourceLogger.debug('Resource applied successfully', {
            appliedName: appliedResource.metadata?.name,
            appliedNamespace: appliedResource.metadata?.namespace,
            operation: existing ? 'patched' : 'created',
            attempt,
          });

          // Success - break out of retry loop
          break;
        } catch (error) {
          lastError = error as Error;

          // Check for 409 Conflict errors - resource already exists
          const apiError = error as KubernetesApiError;
          const is409 =
            apiError.statusCode === 409 ||
            apiError.response?.statusCode === 409 ||
            apiError.body?.code === 409 ||
            (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 409'));

          if (is409) {
            const conflictStrategy = options.conflictStrategy || 'warn';
            const resourceName = resolvedResource.metadata?.name || 'unknown';
            const resourceKind = resolvedResource.kind || 'Unknown';
            const resourceNamespace = resolvedResource.metadata?.namespace;
            let conflictHandled = false;

            resourceLogger.debug('Resource already exists (409)', {
              name: resourceName,
              kind: resourceKind,
              conflictStrategy,
            });

            // Handle based on conflict strategy
            switch (conflictStrategy) {
              case 'fail':
                // Throw error immediately - don't retry
                throw new ResourceConflictError(resourceName, resourceKind, resourceNamespace);

              case 'warn':
                // Log warning and treat as success - fetch existing resource
                resourceLogger.warn('Resource already exists, treating as success', {
                  name: resourceName,
                  kind: resourceKind,
                  namespace: resourceNamespace,
                });
                try {
                  // Fetch the existing resource to return it
                  appliedResource = await this.k8sApi.read({
                    apiVersion: resolvedResource.apiVersion,
                    kind: resolvedResource.kind,
                    metadata: {
                      name: resourceName,
                      namespace: resourceNamespace || 'default',
                    },
                  });
                  conflictHandled = true;
                } catch (readError) {
                  resourceLogger.warn('Failed to read existing resource after 409, falling back to patch', readError as Error);
                  // Fall back to patch strategy
                  try {
                    const jsonResource =
                      typeof resolvedResource.toJSON === 'function'
                        ? resolvedResource.toJSON()
                        : resolvedResource;
                    const cleanResource = JSON.parse(JSON.stringify(jsonResource));
                    delete cleanResource.id;

                    appliedResource = await this.patchResourceWithCorrectContentType(cleanResource);
                    resourceLogger.debug('Resource patched successfully after 409 conflict (warn fallback)');
                    conflictHandled = true;
                  } catch (patchError) {
                    resourceLogger.warn('Failed to patch resource after 409 conflict', patchError as Error);
                  }
                }
                break;

              case 'patch':
                // Attempt to patch the existing resource
                try {
                  const jsonResource =
                    typeof resolvedResource.toJSON === 'function'
                      ? resolvedResource.toJSON()
                      : resolvedResource;
                  const cleanResource = JSON.parse(JSON.stringify(jsonResource));
                  delete cleanResource.id;

                  appliedResource = await this.patchResourceWithCorrectContentType(cleanResource);
                  resourceLogger.debug('Resource patched successfully after 409 conflict');
                  conflictHandled = true;
                } catch (patchError) {
                  resourceLogger.warn('Failed to patch resource after 409 conflict', patchError as Error);
                }
                break;

              case 'replace':
                // Delete and recreate the resource
                try {
                  resourceLogger.debug('Deleting existing resource for replace strategy');
                  await this.k8sApi.delete({
                    apiVersion: resolvedResource.apiVersion,
                    kind: resolvedResource.kind,
                    metadata: {
                      name: resourceName,
                      namespace: resourceNamespace || 'default',
                    },
                  });
                  
                  // Wait a moment for deletion to propagate
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  
                  // Create the new resource
                  const jsonResource =
                    typeof resolvedResource.toJSON === 'function'
                      ? resolvedResource.toJSON()
                      : resolvedResource;
                  const cleanResource = JSON.parse(JSON.stringify(jsonResource));
                  delete cleanResource.id;

                  appliedResource = await this.k8sApi.create(cleanResource);
                  resourceLogger.debug('Resource replaced successfully after 409 conflict');
                  conflictHandled = true;
                } catch (replaceError) {
                  resourceLogger.warn('Failed to replace resource after 409 conflict', replaceError as Error);
                }
                break;
            }

            // If we successfully handled the conflict, break out of retry loop
            if (conflictHandled) {
              break;
            }
          }

          resourceLogger.error('Failed to apply resource to cluster', lastError, { attempt });

          // Check for HTTP 415 Unsupported Media Type errors
          if (this.isUnsupportedMediaTypeError(error)) {
            const acceptedTypes = this.extractAcceptedMediaTypes(error);
            throw new UnsupportedMediaTypeError(
              resolvedResource.metadata?.name || 'unknown',
              resolvedResource.kind || 'Unknown',
              acceptedTypes,
              lastError
            );
          }

          // If this was the last attempt, throw the error
          if (attempt >= retryPolicy.maxRetries) {
            throw new ResourceDeploymentError(
              resolvedResource.metadata?.name || 'unknown',
              resolvedResource.kind || 'Unknown',
              lastError
            );
          }

          // Calculate delay for next attempt
          const delay = Math.min(
            retryPolicy.initialDelay * retryPolicy.backoffMultiplier ** attempt,
            retryPolicy.maxDelay
          );

          resourceLogger.debug('Retrying resource deployment', {
            attempt: attempt + 1,
            maxRetries: retryPolicy.maxRetries,
            delay,
          });

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // 4. Create deployed resource record
    const deployedResource: DeployedResource = {
      id: resourceId,
      kind: resolvedResource.kind || 'Unknown',
      name: resolvedResource.metadata?.name || 'unknown',
      namespace: resolvedResource.metadata?.namespace || 'default',
      manifest: resolvedResource,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // 5. Wait for resource to be ready if requested
    if (options.waitForReady !== false) {
      resourceLogger.debug('Waiting for resource to be ready');
      await this.waitForResourceReady(deployedResource, options, abortSignal);
      deployedResource.status = 'ready';
    }

    resourceLogger.debug('Single resource deployment completed');
    return deployedResource;
  }

  /**
   * Wait for a resource to be ready
   * @param deployedResource - The deployed resource to wait for
   * @param options - Deployment options
   * @param abortSignal - Optional AbortSignal to cancel the wait
   */
  private async waitForResourceReady(
    deployedResource: DeployedResource,
    options: DeploymentOptions,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const resourceKey = `${deployedResource.kind}/${deployedResource.name}/${deployedResource.namespace}`;

    // Check if already marked as ready
    if (deployedResource.status === 'ready' || this.readyResources.has(resourceKey)) {
      this.logger.debug('Resource already marked as ready', { resourceKey });
      return;
    }

    // Check if already aborted
    if (abortSignal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    // Safety-first approach: check for readiness evaluator before starting the wait loop
    // Import ResourceStatus type for proper typing
    type ResourceStatusResult = {
      ready: boolean;
      reason?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
    const enhancedManifest = deployedResource.manifest as Enhanced<unknown, unknown>;
    const readinessEvaluator = enhancedManifest.readinessEvaluator;

    // Debug logging removed

    if (!readinessEvaluator) {
      const errorMessage = `Resource ${deployedResource.kind}/${deployedResource.name} does not have a factory-provided readiness evaluator`;
      this.logger.error('Missing factory-provided readiness evaluator');
      throw new Error(errorMessage);
    }

    const startTime = Date.now();
    const timeout = options.timeout || 300000; // 5 minutes default
    let lastStatus: ResourceStatusResult | null = null;

    while (Date.now() - startTime < timeout) {
      // Check if aborted before each iteration
      if (abortSignal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      try {
        // Use custom readiness evaluator
        // In the new API, methods return objects directly (no .body wrapper)
        // Wrap with abort signal handling to stop waiting if aborted
        const liveResource = await this.withAbortSignal(
          this.k8sApi.read({
            apiVersion: deployedResource.manifest.apiVersion || '',
            kind: deployedResource.kind,
            metadata: {
              name: deployedResource.name,
              namespace: deployedResource.namespace,
            },
          }),
          abortSignal
        );

        // Apply kind-specific enhancements before calling custom evaluator
        const enhancedResource = this.enhanceResourceForEvaluation(
          liveResource,
          deployedResource.kind
        );

        const result = readinessEvaluator(enhancedResource);

        if (typeof result === 'boolean') {
          if (result) {
            this.readyResources.add(resourceKey);

            this.emitEvent(options, {
              type: 'resource-ready',
              resourceId: deployedResource.id,
              message: `${deployedResource.kind}/${deployedResource.name} ready (custom evaluator)`,
              timestamp: new Date(),
            });

            return;
          }
        } else if (result && typeof result === 'object' && 'ready' in result) {
          lastStatus = result;
          if (result.ready) {
            this.readyResources.add(resourceKey);

            this.emitEvent(options, {
              type: 'resource-ready',
              resourceId: deployedResource.id,
              message:
                result.message ||
                `${deployedResource.kind}/${deployedResource.name} ready (custom evaluator)`,
              timestamp: new Date(),
            });

            return;
          }
        }

        // Emit status update if we have status information
        if (lastStatus && typeof lastStatus === 'object' && 'message' in lastStatus) {
          this.emitEvent(options, {
            type: 'resource-status',
            resourceId: deployedResource.id,
            message: `${deployedResource.kind}/${deployedResource.name}: ${lastStatus.message}`,
            timestamp: new Date(),
          });
        }

        // Wait before next check - use abortable delay
        try {
          await this.abortableDelay(2000, abortSignal);
        } catch (error) {
          if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
            throw error; // Re-throw abort/timeout errors
          }
          // Ignore other errors from delay
        }
      } catch (error) {
        // Re-throw abort/timeout errors immediately
        if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw error;
        }

        // Emit error status event
        this.emitEvent(options, {
          type: 'resource-status',
          resourceId: deployedResource.id,
          message: `Unable to read resource status: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });

        // If we can't read the resource, it's not ready yet - use abortable delay
        try {
          await this.abortableDelay(2000, abortSignal);
        } catch (delayError) {
          if (delayError instanceof DOMException && (delayError.name === 'AbortError' || delayError.name === 'TimeoutError')) {
            throw delayError; // Re-throw abort/timeout errors
          }
          // Ignore other errors from delay
        }
      }
    }

    // Timeout reached
    const timeoutMessage = lastStatus
      ? `Timeout waiting for ${deployedResource.kind}/${deployedResource.name}: ${lastStatus.message}`
      : `Timeout waiting for ${deployedResource.kind}/${deployedResource.name} to be ready`;

    throw new Error(timeoutMessage);
  }

  /**
   * Rollback deployed resources
   */
  private async rollbackDeployedResources(
    deployedResources: DeployedResource[],
    options: DeploymentOptions
  ): Promise<{ rolledBackResources: string[]; errors: DeploymentError[] }> {
    this.emitEvent(options, {
      type: 'rollback',
      message: 'Starting rollback of deployed resources',
      timestamp: new Date(),
    });

    const rolledBackResources: string[] = [];
    const errors: DeploymentError[] = [];

    // Rollback in reverse order
    const reversedResources = [...deployedResources].reverse();

    for (const resource of reversedResources) {
      // Only try to rollback resources that were actually deployed (not failed)
      if (resource.status === 'failed') {
        continue; // Skip resources that failed to deploy
      }

      try {
        await this.k8sApi.delete({
          apiVersion: resource.manifest.apiVersion || '',
          kind: resource.kind,
          metadata: {
            name: resource.name,
            namespace: resource.namespace,
          },
        } as k8s.KubernetesObject);

        rolledBackResources.push(`${resource.kind}/${resource.name}`);
      } catch (error) {
        // Log and collect errors for individual resource deletion failures
        this.logger.warn('Failed to delete resource during rollback', {
          error: error as Error,
          resourceId: resource.id,
          kind: resource.kind,
          name: resource.name,
        });

        errors.push({
          resourceId: resource.id,
          phase: 'rollback',
          error: error as Error,
          timestamp: new Date(),
        });
      }
    }

    return { rolledBackResources, errors };
  }

  /**
   * Generate a unique deployment ID
   */
  private generateDeploymentId(): string {
    return `deployment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Emit deployment events
   */
  private emitEvent(options: DeploymentOptions, event: DeploymentEvent): void {
    if (options.progressCallback) {
      options.progressCallback(event);
    }
  }

  /**
   * Deploy a single resource (legacy method for compatibility)
   */
  async deployResource(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>,
    options: DeploymentOptions
  ): Promise<DeployedResource> {
    const context: ResolutionContext = {
      deployedResources: [],
      kubeClient: this.kubeClient,
      ...(options.namespace && { namespace: options.namespace }),
      timeout: options.timeout || 30000,
    };

    // Legacy method - no abort signal support
    return this.deploySingleResource(resource, context, options, undefined);
  }

  /**
   * Delete a resource from the cluster
   */
  async deleteResource(resource: DeployedResource): Promise<void> {
    const deleteLogger = this.logger.child({
      resourceId: resource.id,
      kind: resource.kind,
      name: resource.name,
    });

    try {
      await this.k8sApi.delete({
        apiVersion: resource.manifest.apiVersion || '',
        kind: resource.kind,
        metadata: {
          name: resource.name,
          namespace: resource.namespace,
        },
      } as k8s.KubernetesObject);

      // Wait for resource to be deleted
      const timeout = 30000; // 30 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          await this.k8sApi.read({
            apiVersion: resource.manifest.apiVersion || '',
            kind: resource.kind,
            metadata: {
              name: resource.name!,
              namespace: resource.namespace!,
            },
          });

          // Resource still exists, wait and try again
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          // Resource not found, deletion successful
          if (this.isNotFoundError(error)) {
            deleteLogger.debug('Resource successfully deleted');
            return;
          }
          throw error;
        }
      }

      throw new Error(
        `Timeout waiting for resource ${resource.kind}/${resource.name} to be deleted`
      );
    } catch (error) {
      deleteLogger.error('Failed to delete resource', error as Error);
      throw error;
    }
  }

  /**
   * Wait for resource readiness (legacy method for compatibility)
   */
  async waitForResourceReadiness(
    resource: DeployedResource,
    options: DeploymentOptions
  ): Promise<void> {
    // Legacy method - no abort signal support
    return this.waitForResourceReady(resource, options, undefined);
  }

  /**
   * Rollback a deployment by ID
   */
  async rollback(deploymentId: string): Promise<RollbackResult> {
    const startTime = Date.now();
    const deploymentRecord = this.deploymentState.get(deploymentId);

    if (!deploymentRecord) {
      throw new Error(`Deployment ${deploymentId} not found. Cannot rollback.`);
    }

    try {
      const { rolledBackResources, errors } = await this.rollbackDeployedResources(
        deploymentRecord.resources,
        deploymentRecord.options
      );

      const status =
        errors.length === 0 ? 'success' : rolledBackResources.length > 0 ? 'partial' : 'failed';

      return {
        deploymentId,
        rolledBackResources,
        duration: Date.now() - startTime,
        status,
        errors,
      };
    } catch (error) {
      // This shouldn't happen now since rollbackDeployedResources handles its own errors
      return {
        deploymentId,
        rolledBackResources: [],
        duration: Date.now() - startTime,
        status: 'failed',
        errors: [
          {
            resourceId: deploymentId,
            phase: 'rollback',
            error: error as Error,
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Get deployment status by ID
   */
  async getStatus(deploymentId: string): Promise<DeploymentOperationStatus> {
    const deploymentRecord = this.deploymentState.get(deploymentId);

    if (!deploymentRecord) {
      return {
        deploymentId,
        status: 'unknown',
        startTime: new Date(),
        resources: [],
      };
    }

    const result: DeploymentOperationStatus = {
      deploymentId,
      status:
        deploymentRecord.status === 'completed'
          ? 'completed'
          : deploymentRecord.status === 'failed'
            ? 'failed'
            : 'running',
      startTime: deploymentRecord.startTime,
      resources: deploymentRecord.resources,
    };

    if (deploymentRecord.endTime) {
      result.endTime = deploymentRecord.endTime;
      result.duration = deploymentRecord.endTime.getTime() - deploymentRecord.startTime.getTime();
    }

    return result;
  }

  /**
   * Patch a resource with the correct Content-Type header for merge patch operations
   * This fixes HTTP 415 "Unsupported Media Type" errors that occur when using the generic patch method
   * In the new API, methods return objects directly (no .body wrapper)
   */
  private async patchResourceWithCorrectContentType(
    resource: k8s.KubernetesObject
  ): Promise<k8s.KubernetesObject> {
    // DEBUG: Log the resource being sent to K8s API for Secrets
    if (resource.kind === 'Secret') {
      const secretResource = resource as k8s.KubernetesObject & {
        data?: Record<string, string>;
        spec?: unknown;
      };
      this.logger.debug('Patching Secret resource', {
        name: resource.metadata?.name,
        hasData: 'data' in resource,
        hasSpec: 'spec' in resource,
        dataKeys: secretResource.data ? Object.keys(secretResource.data) : [],
        specValue: secretResource.spec,
      });
    }

    // The k8sApi.patch method requires the full content-type string for the patchStrategy parameter
    // Use 'application/merge-patch+json' for merge patch operations
    // See: https://kubernetes.io/docs/tasks/manage-kubernetes-objects/update-api-object-kubectl-patch/
    return await this.k8sApi.patch(
      resource,
      undefined, // pretty
      undefined, // dryRun
      undefined, // fieldManager
      undefined, // force
      'application/merge-patch+json' // patchStrategy - must be the full content-type string
    );
  }

  /**
   * Check if an error is a "not found" error
   */
  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === 'object') {
      const k8sError = error as KubernetesApiError;
      return k8sError.statusCode === 404 || k8sError.body?.code === 404;
    }
    return false;
  }

  /**
   * Wait for CRD establishment if the resource is a custom resource
   */
  private async waitForCRDIfCustomResource(
    resource: KubernetesResource,
    options: DeploymentOptions,
    logger: ReturnType<typeof getComponentLogger>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    // Check if already aborted
    if (abortSignal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    // Skip if this is not a custom resource
    if (!this.isCustomResource(resource)) {
      return;
    }

    const crdName = await this.getCRDNameForResource(resource);
    if (!crdName) {
      logger.warn('Could not determine CRD name for custom resource', {
        kind: resource.kind,
        apiVersion: resource.apiVersion,
      });
      return;
    }

    logger.debug('Custom resource detected, waiting for CRD establishment', {
      resourceKind: resource.kind,
      crdName,
    });

    await this.waitForCRDEstablishment({ metadata: { name: crdName } }, options, logger, abortSignal);

    logger.debug('CRD established, proceeding with custom resource deployment', {
      resourceKind: resource.kind,
      crdName,
    });
  }

  /**
   * Check if a resource is a custom resource (not a built-in Kubernetes resource)
   */
  private isCustomResource(resource: KubernetesResource): boolean {
    if (!resource.apiVersion || !resource.kind) {
      return false;
    }

    // Built-in Kubernetes API groups that are NOT custom resources
    const builtInApiGroups = [
      'v1', // Core API group
      'apps/v1',
      'extensions/v1beta1',
      'networking.k8s.io/v1',
      'policy/v1',
      'rbac.authorization.k8s.io/v1',
      'storage.k8s.io/v1',
      'apiextensions.k8s.io/v1', // CRDs themselves
      'admissionregistration.k8s.io/v1',
      'apiregistration.k8s.io/v1',
      'authentication.k8s.io/v1',
      'authorization.k8s.io/v1',
      'autoscaling/v1',
      'autoscaling/v2',
      'batch/v1',
      'certificates.k8s.io/v1',
      'coordination.k8s.io/v1',
      'discovery.k8s.io/v1',
      'events.k8s.io/v1',
      'flowcontrol.apiserver.k8s.io/v1beta3',
      'node.k8s.io/v1',
      'scheduling.k8s.io/v1',
    ];

    return !builtInApiGroups.includes(resource.apiVersion);
  }

  /**
   * Get the CRD name for a custom resource
   */
  private async getCRDNameForResource(resource: KubernetesResource): Promise<string | null> {
    if (!resource.apiVersion || !resource.kind) {
      return null;
    }

    // Only return CRD name for custom resources
    if (!this.isCustomResource(resource)) {
      return null;
    }

    // Extract group from apiVersion (e.g., "example.com/v1" -> "example.com")
    const apiVersionParts = resource.apiVersion.split('/');
    const group = apiVersionParts.length > 1 ? apiVersionParts[0] : '';

    if (!group) {
      return null; // Core API resources don't have CRDs
    }

    try {
      // Try to find the CRD by querying the API
      const crds = await this.k8sApi.list('apiextensions.k8s.io/v1', 'CustomResourceDefinition');

      // Look for a CRD that matches our group and kind
      // In the new API, methods return objects directly (no .body wrapper)
      const crdList = crds as unknown as CustomResourceDefinitionList;
      const matchingCrd = crdList?.items?.find((crd: CustomResourceDefinitionItem) => {
        const crdSpec = crd.spec;
        return crdSpec?.group === group && crdSpec?.names?.kind === resource.kind;
      });

      if (matchingCrd) {
        return matchingCrd.metadata?.name ?? null;
      }
    } catch (error) {
      // If we can't query CRDs, fall back to heuristic
      console.warn('Failed to query CRDs, using heuristic for CRD name generation:', error);
    }

    // Fallback: Convert Kind to plural lowercase (simple heuristic)
    const kind = resource.kind.toLowerCase();
    const plural = kind.endsWith('s') ? kind : `${kind}s`;

    return `${plural}.${group}`;
  }

  /**
   * Public method to wait for CRD readiness by name
   */
  async waitForCRDReady(crdName: string, timeout: number = 300000, abortSignal?: AbortSignal): Promise<void> {
    const logger = this.logger.child({ crdName, timeout });
    const options: DeploymentOptions = {
      mode: this.deploymentMode as 'direct' | 'kro' | 'alchemy' | 'auto',
      timeout,
    };

    await this.waitForCRDEstablishment({ metadata: { name: crdName } }, options, logger, abortSignal);
  }

  /**
   * Wait for a CRD to be established in the cluster
   */
  private async waitForCRDEstablishment(
    crd: { metadata?: { name?: string } },
    options: DeploymentOptions,
    logger: ReturnType<typeof getComponentLogger>,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const crdName = crd.metadata?.name;
    const timeout = options.timeout || 300000; // 5 minutes default
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    logger.debug('Waiting for CRD to exist and be established', { crdName, timeout });

    while (Date.now() - startTime < timeout) {
      // Check if aborted before each iteration
      if (abortSignal?.aborted) {
        throw new DOMException('Operation aborted', 'AbortError');
      }

      try {
        // Check if CRD is established by reading its status
        // Wrap with abort signal handling
        const crdStatus = await this.withAbortSignal(
          this.k8sApi.read({
            apiVersion: 'apiextensions.k8s.io/v1',
            kind: 'CustomResourceDefinition',
            metadata: { name: crdName }, // CRDs are cluster-scoped, no namespace needed
          } as { metadata: { name: string } }),
          abortSignal
        );

        // In the new API, methods return objects directly (no .body wrapper)
        const crdItem = crdStatus as unknown as CustomResourceDefinitionItem;
        const conditions = crdItem?.status?.conditions || [];
        const establishedCondition = conditions.find(
          (c: KubernetesCondition) => c.type === 'Established'
        );

        if (establishedCondition?.status === 'True') {
          logger.debug('CRD exists and is established', { crdName });
          return;
        }

        logger.debug('CRD exists but not yet established, waiting...', {
          crdName,
          establishedStatus: establishedCondition?.status || 'unknown',
        });
      } catch (error) {
        // Re-throw abort/timeout errors immediately
        if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw error;
        }

        // CRD might not exist yet (e.g., being installed by a closure)
        // This is expected in scenarios where closures install CRDs
        logger.debug('CRD not found yet, waiting for it to be created...', {
          crdName,
          error: (error as Error).message,
        });
      }

      // Wait before next poll - use abortable delay
      try {
        await this.abortableDelay(pollInterval, abortSignal);
      } catch (error) {
        if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw error; // Re-throw abort/timeout errors
        }
        // Ignore other errors from delay
      }
    }

    // Timeout reached
    throw new Error(`Timeout waiting for CRD ${crdName} to be established after ${timeout}ms`);
  }

  /**
   * Check if an error is an HTTP 415 Unsupported Media Type error
   */
  private isUnsupportedMediaTypeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const apiError = error as KubernetesApiError;
    return (
      apiError.statusCode === 415 ||
      apiError.response?.statusCode === 415 ||
      apiError.body?.code === 415
    );
  }

  /**
   * Extract accepted media types from HTTP 415 error message
   */
  private extractAcceptedMediaTypes(error: unknown): string[] {
    const defaultTypes = [
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ];

    try {
      // Try to extract from error message
      const apiError = error as KubernetesApiError;
      const message = apiError.message || apiError.body?.message || '';
      const match = message.match(/accepted media types include: ([^"]+)/);

      if (match && match[1]) {
        return match[1].split(', ').map((type: string) => type.trim());
      }
    } catch (_e) {
      // Fallback to default types
    }

    return defaultTypes;
  }
}
