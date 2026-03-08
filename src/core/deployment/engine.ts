/**
 * Direct Deployment Engine
 *
 * Orchestrates the deployment of Kubernetes resources directly to a cluster
 * without requiring the Kro controller, using in-process dependency resolution.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_BACKOFF_MULTIPLIER,
  DEFAULT_CONFLICT_RETRY_DELAY,
  DEFAULT_CRD_READY_TIMEOUT,
  DEFAULT_DELETE_TIMEOUT,
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_DELAY,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_READINESS_TIMEOUT,
} from '../config/defaults.js';
import { DependencyResolver } from '../dependencies/index.js';
import {
  CircularDependencyError,
  DeploymentTimeoutError,
  ensureError,
  ResourceGraphFactoryError,
} from '../errors.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { ensureReadinessEvaluator } from '../readiness/index.js';
import { DeploymentMode, ReferenceResolver } from '../references/index.js';
import { getResourceId } from '../resources/id.js';
import type {
  DeploymentClosure,
  DeploymentContext,
  DeploymentError,
  DeploymentEvent,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResourceGraph,
  DeploymentResult,
  DeploymentStateRecord,
  ResolutionContext,
  RollbackResult,
} from '../types/deployment.js';
import type { Scope } from '../types/serialization.js';
import type {
  DeployableK8sResource,
  DeployedResource,
  Enhanced,
  KubernetesApiError,
  KubernetesObjectWithStatus,
  KubernetesResource,
  ResourceStatus,
  WithResourceId,
} from '../types.js';
import { analyzeClosureDependencies, integrateClosuresIntoPlan } from './closure-planner.js';
import { CRDManager } from './crd-manager.js';
import { createDebugLoggerFromDeploymentOptions, type DebugLogger } from './debug-logger.js';
import {
  ResourceConflictError,
  ResourceDeploymentError,
  UnsupportedMediaTypeError,
} from './errors.js';
import { createEventMonitor, type EventMonitor } from './event-monitor.js';
import {
  enhanceResourceForEvaluation,
  extractAcceptedMediaTypes,
  isNotFoundError,
  isUnsupportedMediaTypeError,
  patchResourceWithCorrectContentType,
} from './k8s-helpers.js';
import { ResourceReadinessChecker } from './readiness.js';

/** Result of deploying a single resource or executing a closure within a level */
interface LevelDeploymentResult {
  success: boolean;
  type?: 'closure' | undefined;
  resourceId?: string | undefined;
  name?: string | undefined;
  deployedResource?: DeployedResource | undefined;
  result?: unknown[] | undefined;
  error?:
    | {
        resourceId: string;
        phase: 'validation' | 'deployment';
        error: Error;
        timestamp: Date;
      }
    | undefined;
}

export class DirectDeploymentEngine {
  private dependencyResolver: DependencyResolver;
  private referenceResolver: ReferenceResolver;
  private k8sApi: k8s.KubernetesObjectApi;
  private readinessChecker: ResourceReadinessChecker;
  private debugLogger?: DebugLogger;
  private eventMonitor?: EventMonitor;
  private deploymentState: Map<string, DeploymentStateRecord> = new Map();
  private crdManager: CRDManager;
  private readyResources: Set<string> = new Set(); // Track resources that are already ready
  private activeAbortControllers: Set<AbortController> = new Set(); // Track active abort controllers for cleanup
  private logger = getComponentLogger('deployment-engine');

  constructor(
    private kubeClient: k8s.KubeConfig,
    k8sApi?: k8s.KubernetesObjectApi,
    referenceResolver?: ReferenceResolver,
    private deploymentMode: DeploymentMode = DeploymentMode.DIRECT,
    httpTimeouts?: DeploymentOptions['httpTimeouts']
  ) {
    this.dependencyResolver = new DependencyResolver();
    this.referenceResolver =
      referenceResolver || new ReferenceResolver(kubeClient, this.deploymentMode, k8sApi);
    // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
    // This works around Bun's fetch TLS issues (https://github.com/oven-sh/bun/issues/10642)
    // Pass HTTP timeout configuration if provided
    this.k8sApi = k8sApi || createBunCompatibleKubernetesObjectApi(kubeClient, httpTimeouts);
    this.readinessChecker = new ResourceReadinessChecker(this.k8sApi);
    this.crdManager = new CRDManager(
      this.k8sApi,
      kubeClient,
      this.abortableDelay.bind(this),
      this.withAbortSignal.bind(this)
    );

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

      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeoutId);
          reject(new DOMException('Delay aborted', 'AbortError'));
        },
        { once: true }
      );
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
        .catch((error: unknown) => {
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
   * Check if a deployed resource is ready using the factory-provided readiness evaluator
   */
  public async isDeployedResourceReady(deployedResource: DeployedResource): Promise<boolean> {
    try {
      // Check if the deployed resource has a factory-provided readiness evaluator
      const readinessEvaluator = (deployedResource.manifest as Enhanced<unknown, unknown>)
        .readinessEvaluator;

      // Create a resource reference for the API call (shared by both paths)
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

      if (readinessEvaluator) {
        // Apply kind-specific enhancements before calling custom evaluator
        const enhancedResource = enhanceResourceForEvaluation(liveResource, deployedResource.kind);

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
      }

      // Fallback to generic readiness checker
      return this.readinessChecker.isResourceReady(liveResource);
    } catch (error: unknown) {
      this.logger.debug('Failed to check resource readiness', {
        error: ensureError(error),
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
  async deploy(
    graph: DeploymentResourceGraph,
    options: DeploymentOptions
  ): Promise<DeploymentResult> {
    // Delegate to deployWithClosures with no closures and a dummy spec.
    // The closure integration code is a no-op when the closures map is empty.
    return this.deployWithClosures(graph, {}, options, undefined);
  }

  /**
   * Deploy a resource graph with deployment closures integrated into level-based execution
   */
  async deployWithClosures<TSpec>(
    graph: DeploymentResourceGraph,
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
    const timeout = options.timeout || DEFAULT_DEPLOYMENT_TIMEOUT;
    const timeoutId = setTimeout(() => {
      deploymentLogger.debug('Deployment timeout reached, aborting operations', {
        deploymentId,
        timeout,
      });

      // Stop event monitoring immediately when timeout is reached
      // This prevents watch connections from continuing to run and throwing errors
      if (this.eventMonitor) {
        this.eventMonitor.stopMonitoring().catch((error: unknown) => {
          deploymentLogger.debug('Error stopping event monitoring on timeout', {
            error: ensureError(error).message,
          });
        });
      }

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
        } catch (error: unknown) {
          deploymentLogger.warn('Failed to initialize event monitoring, continuing without it', {
            error: ensureError(error).message,
          });
        }
      }

      // 3.1. Initialize debug logging if enabled
      if (options.debugLogging?.enabled) {
        this.debugLogger = createDebugLoggerFromDeploymentOptions(options);
        this.readinessChecker.setDebugLogger(this.debugLogger);
        deploymentLogger.debug('Debug logging initialized');
      }

      // 4. Analyze closure dependencies and integrate into deployment plan
      const closureDependencies = analyzeClosureDependencies(
        closures,
        spec,
        graph.dependencyGraph,
        this.dependencyResolver
      );
      const enhancedPlan = integrateClosuresIntoPlan(deploymentPlan, closureDependencies);

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
        const manifest = resource.manifest as KubernetesResource & WithResourceId;
        const originalResourceId = manifest.__resourceId;
        if (originalResourceId) {
          // Convert the Enhanced proxy to a plain object for reliable field extraction
          // The proxy's toJSON method returns a clean object without proxy behavior
          const plainManifest =
            typeof manifest.toJSON === 'function'
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
        timeout: options.timeout || DEFAULT_READINESS_TIMEOUT,
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
          kubeConfig: this.kubeClient,
          ...(alchemyScope && { alchemyScope }),
          ...(options.namespace && { namespace: options.namespace }),
          deployedResources: deployedResourcesMap,
          resolveReference: async (ref: unknown): Promise<unknown> => {
            // Enhanced reference resolution - will be improved in future tasks
            return ref;
          },
        };

        // Prepare promises for both resources and closures
        const levelPromises: Promise<LevelDeploymentResult>[] = [];

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
            await this.crdManager.waitForCRDIfCustomResource(
              resource.manifest,
              options,
              resourceLogger,
              abortSignal
            );

            const resourceWithEvaluator = ensureReadinessEvaluator(resource.manifest);

            // Add resource to event monitoring before deployment to capture creation events
            // NOTE: This is fire-and-forget to avoid blocking the deployment path.
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
              this.eventMonitor.addResources([preDeployedResource]).then(
                () => {
                  resourceLogger.debug('Added resource to event monitoring before deployment');
                },
                (error: unknown) => {
                  resourceLogger.warn(
                    'Failed to add resource to event monitoring, continuing deployment',
                    { error: ensureError(error).message }
                  );
                }
              );
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
          } catch (error: unknown) {
            resourceLogger.error('Resource deployment failed', ensureError(error));
            const failedResource: DeployedResource = {
              id: resourceId,
              kind: resource.manifest.kind,
              name: resource.manifest.metadata?.name || 'unknown',
              namespace: resource.manifest.metadata?.namespace || 'default',
              manifest: resource.manifest,
              status: 'failed',
              deployedAt: new Date(),
              error: ensureError(error),
            };
            return {
              success: false,
              resourceId,
              deployedResource: failedResource,
              error: {
                resourceId,
                phase: 'deployment' as const,
                error: ensureError(error),
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
          } catch (error: unknown) {
            closureLogger.error('Closure execution failed', ensureError(error));
            return {
              success: false,
              type: 'closure' as const,
              name: closureInfo.name,
              error: {
                resourceId: `closure-${closureInfo.name}`,
                phase: 'deployment' as const,
                error: ensureError(error),
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

                await this.updateResourceKeyMappingWithLiveResource(
                  deploymentResult.deployedResource,
                  resourceKeyMapping,
                  deploymentLogger
                );
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

      // Stop event monitoring
      if (this.eventMonitor) {
        try {
          await this.eventMonitor.stopMonitoring();
          deploymentLogger.debug('Event monitoring stopped');
        } catch (error: unknown) {
          deploymentLogger.warn('Failed to stop event monitoring cleanly', {
            error: ensureError(error).message,
          });
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
    } catch (error: unknown) {
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
        error: ensureError(error),
      });

      // Stop event monitoring on error
      if (this.eventMonitor) {
        try {
          await this.eventMonitor.stopMonitoring();
        } catch (cleanupError: unknown) {
          // Ignore cleanup errors in error path
          this.logger.debug('Ignored cleanup error stopping event monitor', {
            err: cleanupError,
          });
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
            error: ensureError(error),
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Update the resourceKeyMapping with a live resource fetched from the cluster.
   * This is critical for CEL expression evaluation which needs access to resource status.
   */
  private async updateResourceKeyMappingWithLiveResource(
    deployedRes: DeployedResource,
    resourceKeyMapping: Map<string, unknown>,
    logger: ReturnType<typeof getComponentLogger>
  ): Promise<void> {
    const manifestWithId = deployedRes.manifest as KubernetesResource & WithResourceId;
    const originalResourceId = manifestWithId.__resourceId;
    if (!originalResourceId || !resourceKeyMapping.has(originalResourceId)) {
      return;
    }
    try {
      const liveResource = await this.k8sApi.read({
        apiVersion: deployedRes.manifest.apiVersion || '',
        kind: deployedRes.kind,
        metadata: {
          name: deployedRes.name,
          namespace: deployedRes.namespace,
        },
      });
      resourceKeyMapping.set(originalResourceId, liveResource);
      logger.debug('Updated resourceKeyMapping with live resource status', {
        originalResourceId,
        kind: deployedRes.kind,
        name: deployedRes.name,
        hasStatus: !!(liveResource as KubernetesObjectWithStatus).status,
      });
    } catch (error: unknown) {
      logger.warn('Failed to update resourceKeyMapping with live resource', {
        originalResourceId,
        error: ensureError(error).message,
      });
    }
  }

  /**
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

    // __resourceId is an internal non-enumerable field set by createGenericProxyResource
    const internalId = (resource as KubernetesResource & WithResourceId).__resourceId;
    const resourceId = internalId || getResourceId(resource);
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
    const resolvedRef = await this.resolveResourceReferences(
      resource,
      context,
      options,
      resourceLogger
    );

    // 2. Apply namespace if specified, but only if resource doesn't already have one
    const resolvedResource = this.applyNamespaceToResource(
      resolvedRef,
      options.namespace,
      resourceLogger
    );

    // 3. Apply the resource to the cluster (or simulate for dry run)
    await this.applyResourceToCluster(resolvedResource, options, resourceLogger);

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
   * Serialize a resource for sending to the Kubernetes API.
   * Calls toJSON() if available (to preserve arrays via custom implementation),
   * then deep-clones via JSON to strip proxy wrappers, and removes internal fields.
   */
  private serializeResourceForK8s(
    resource: KubernetesResource | Partial<KubernetesResource>
  ): Record<string, unknown> {
    const toJSON = (resource as KubernetesResource).toJSON;
    const jsonResource = typeof toJSON === 'function' ? toJSON.call(resource) : resource;

    // Deep clone to remove any proxy wrappers that might cause serialization issues
    const cleanResource: Record<string, unknown> = JSON.parse(JSON.stringify(jsonResource));

    // Strip internal TypeKro fields that should not be sent to Kubernetes
    // The 'id' field is used internally for resource mapping but is not a valid K8s field
    delete cleanResource.id;

    return cleanResource;
  }

  /**
   * Resolve all references in a resource, with timeout and fallback behavior.
   * Falls back to the original resource if resolution fails.
   */
  private async resolveResourceReferences(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>,
    context: ResolutionContext,
    options: DeploymentOptions,
    resourceLogger: ReturnType<typeof this.logger.child>
  ): Promise<KubernetesResource> {
    try {
      resourceLogger.debug('Resolving resource references', {
        originalMetadata: resource.metadata,
      });
      const resolveTimeout = options.timeout || DEFAULT_READINESS_TIMEOUT;
      const resolvedResource = (await Promise.race([
        this.referenceResolver.resolveReferences(resource, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Reference resolution timeout')), resolveTimeout)
        ),
      ])) as KubernetesResource;
      // Check for readinessEvaluator which may be on Enhanced resources
      const enhancedResource = resolvedResource as KubernetesResource & {
        readinessEvaluator?: (liveResource: unknown) => ResourceStatus;
      };
      resourceLogger.debug('References resolved successfully', {
        resolvedMetadata: resolvedResource.metadata,
        hasReadinessEvaluator: !!enhancedResource.readinessEvaluator,
      });
      return resolvedResource;
    } catch (error: unknown) {
      // In Alchemy deployments, resourceKeyMapping is often empty because resources are deployed
      // one at a time. This is expected behavior, so we log at debug level instead of warn.
      const hasResourceKeyMapping =
        context.resourceKeyMapping && context.resourceKeyMapping.size > 0;
      if (hasResourceKeyMapping) {
        resourceLogger.warn('Reference resolution failed, using original resource', {
          error: ensureError(error).message,
        });
      } else {
        resourceLogger.debug(
          'Reference resolution skipped (no resourceKeyMapping), using original resource',
          {
            error: ensureError(error).message,
          }
        );
      }
      return resource;
    }
  }

  /**
   * Apply a namespace to a resource if one is specified and the resource doesn't already have one.
   * Preserves non-enumerable properties (readinessEvaluator, __resourceId) on the new object.
   */
  private applyNamespaceToResource(
    resource: KubernetesResource,
    namespace: string | undefined,
    resourceLogger: ReturnType<typeof this.logger.child>
  ): KubernetesResource {
    if (!namespace || !resource.metadata || typeof resource.metadata.namespace === 'string') {
      return resource;
    }

    resourceLogger.debug('Applying namespace from deployment options', {
      targetNamespace: namespace,
      currentNamespace: resource.metadata.namespace,
      currentNamespaceType: typeof resource.metadata.namespace,
    });

    // Create a completely new metadata object to avoid proxy issues
    const newMetadata = {
      ...resource.metadata,
      namespace,
    };

    // Preserve the readiness evaluator when creating the new resource
    const newResource = {
      ...resource,
      metadata: newMetadata,
    };

    // Copy the non-enumerable readiness evaluator if it exists
    const resourceWithEvaluator = resource as KubernetesResource &
      WithResourceId & {
        readinessEvaluator?: (liveResource: unknown) => ResourceStatus;
      };
    const readinessEvaluator = resourceWithEvaluator.readinessEvaluator;
    if (readinessEvaluator) {
      Object.defineProperty(newResource, 'readinessEvaluator', {
        value: readinessEvaluator,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

    // Copy the non-enumerable __resourceId if it exists (used for cross-resource references)
    const originalResourceId = resourceWithEvaluator.__resourceId;
    if (originalResourceId) {
      Object.defineProperty(newResource, '__resourceId', {
        value: originalResourceId,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }

    return newResource;
  }

  /**
   * Build a patch payload from a resource, including special-cased fields for Secrets and RBAC resources.
   */
  private buildPatchPayload(resource: KubernetesResource): Record<string, unknown> {
    const patchPayload: Partial<KubernetesResource> = {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: resource.metadata,
    };

    // Include spec if present (most resources)
    if (resource.spec !== undefined) {
      patchPayload.spec = resource.spec;
    }

    // Include data if present (Secrets)
    if (resource.data !== undefined) {
      patchPayload.data = resource.data;
    }

    // Include stringData if present (Secrets)
    if (resource.stringData !== undefined) {
      patchPayload.stringData = resource.stringData;
    }

    // Include rules if present (RBAC resources)
    if (resource.rules !== undefined) {
      // Ensure arrays are preserved (not converted to objects with numeric keys)
      const rules = resource.rules;
      patchPayload.rules = Array.isArray(rules) ? [...rules] : rules;
    }

    // Include subjects if present (ClusterRoleBinding, RoleBinding)
    if (resource.subjects !== undefined) {
      // Ensure arrays are preserved (not converted to objects with numeric keys)
      const subjects = resource.subjects;
      patchPayload.subjects = Array.isArray(subjects) ? [...subjects] : subjects;
    }

    // Include roleRef if present (ClusterRoleBinding, RoleBinding)
    if (resource.roleRef !== undefined) {
      patchPayload.roleRef = resource.roleRef;
    }

    return this.serializeResourceForK8s(patchPayload);
  }

  /**
   * Handle a 409 Conflict error based on the configured conflict strategy.
   * Returns the applied resource if the conflict was handled, or undefined if it wasn't.
   */
  private async handleConflictStrategy(
    resolvedResource: KubernetesResource,
    conflictStrategy: NonNullable<DeploymentOptions['conflictStrategy']>,
    resourceLogger: ReturnType<typeof this.logger.child>
  ): Promise<k8s.KubernetesObject | undefined> {
    const resourceName = resolvedResource.metadata?.name || 'unknown';
    const resourceKind = resolvedResource.kind || 'Unknown';
    const resourceNamespace = resolvedResource.metadata?.namespace;

    resourceLogger.debug('Resource already exists (409)', {
      name: resourceName,
      kind: resourceKind,
      conflictStrategy,
    });

    switch (conflictStrategy) {
      case 'fail':
        throw new ResourceConflictError(resourceName, resourceKind, resourceNamespace);

      case 'warn': {
        resourceLogger.warn('Resource already exists, treating as success', {
          name: resourceName,
          kind: resourceKind,
          namespace: resourceNamespace,
        });
        try {
          const result = await this.k8sApi.read({
            apiVersion: resolvedResource.apiVersion,
            kind: resolvedResource.kind,
            metadata: {
              name: resourceName,
              namespace: resourceNamespace || 'default',
            },
          });
          return result;
        } catch (readError: unknown) {
          resourceLogger.warn('Failed to read existing resource after 409, falling back to patch', {
            error: ensureError(readError).message,
          });
          // Fall back to patch strategy
          try {
            const cleanResource = this.serializeResourceForK8s(resolvedResource);
            const result = await patchResourceWithCorrectContentType(this.k8sApi, cleanResource);
            resourceLogger.debug(
              'Resource patched successfully after 409 conflict (warn fallback)'
            );
            return result;
          } catch (patchError: unknown) {
            resourceLogger.warn('Failed to patch resource after 409 conflict', {
              error: ensureError(patchError).message,
            });
          }
        }
        return undefined;
      }

      case 'patch': {
        try {
          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          const result = await patchResourceWithCorrectContentType(this.k8sApi, cleanResource);
          resourceLogger.debug('Resource patched successfully after 409 conflict');
          return result;
        } catch (patchError: unknown) {
          resourceLogger.warn('Failed to patch resource after 409 conflict', {
            error: ensureError(patchError).message,
          });
        }
        return undefined;
      }

      case 'replace': {
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
          await new Promise((resolve) => setTimeout(resolve, DEFAULT_CONFLICT_RETRY_DELAY));

          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          const result = await this.k8sApi.create(cleanResource);
          resourceLogger.debug('Resource replaced successfully after 409 conflict');
          return result;
        } catch (replaceError: unknown) {
          resourceLogger.warn('Failed to replace resource after 409 conflict', {
            error: ensureError(replaceError).message,
          });
        }
        return undefined;
      }
    }
  }

  /**
   * Apply a resource to the Kubernetes cluster with retry logic, conflict handling,
   * and support for both create and patch operations.
   */
  private async applyResourceToCluster(
    resolvedResource: KubernetesResource,
    options: DeploymentOptions,
    resourceLogger: ReturnType<typeof this.logger.child>
  ): Promise<k8s.KubernetesObject> {
    if (options.dryRun) {
      resourceLogger.debug('Dry run mode: simulating resource creation');
      return {
        ...resolvedResource,
        metadata: {
          ...resolvedResource.metadata,
          uid: 'dry-run-uid',
        },
      } as k8s.KubernetesObject;
    }

    const retryPolicy = options.retryPolicy || {
      maxRetries: DEFAULT_MAX_RETRIES,
      backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
      initialDelay: DEFAULT_FAST_POLL_INTERVAL,
      maxDelay: DEFAULT_MAX_RETRY_DELAY,
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        resourceLogger.debug('Applying resource to cluster', { attempt });

        // Check if resource already exists
        const existing = await this.checkResourceExists(resolvedResource, resourceLogger);

        let appliedResource: k8s.KubernetesObject;
        if (existing) {
          // Resource exists, use patch for safer updates
          const cleanPayload = this.buildPatchPayload(resolvedResource);

          // Redact sensitive fields from Secret resources before logging
          if (cleanPayload.kind === 'Secret') {
            const { data: _data, stringData: _stringData, ...safePayload } = cleanPayload;
            resourceLogger.debug('Resource exists, patching', {
              patchPayload: safePayload,
              redacted: ['data', 'stringData'],
            });
          } else {
            resourceLogger.debug('Resource exists, patching', { patchPayload: cleanPayload });
          }

          appliedResource = await patchResourceWithCorrectContentType(this.k8sApi, cleanPayload);
        } else {
          // Resource does not exist, create it
          resourceLogger.debug('Resource does not exist, creating');

          // Log Secret resource metadata (sensitive fields redacted)
          if (resolvedResource.kind === 'Secret') {
            resourceLogger.debug('Creating Secret resource', {
              name: resolvedResource.metadata?.name,
              namespace: resolvedResource.metadata?.namespace,
              hasData: 'data' in resolvedResource,
              hasStringData: 'stringData' in resolvedResource,
              dataKeyCount: resolvedResource.data ? Object.keys(resolvedResource.data).length : 0,
            });
          }

          const cleanResource = this.serializeResourceForK8s(resolvedResource);
          appliedResource = await this.k8sApi.create(cleanResource);
        }

        resourceLogger.debug('Resource applied successfully', {
          appliedName: appliedResource.metadata?.name,
          appliedNamespace: appliedResource.metadata?.namespace,
          operation: existing ? 'patched' : 'created',
          attempt,
        });

        return appliedResource;
      } catch (error: unknown) {
        lastError = ensureError(error);

        // Check for 409 Conflict errors - resource already exists
        const apiError = error as KubernetesApiError;
        const is409 =
          apiError.statusCode === 409 ||
          apiError.response?.statusCode === 409 ||
          apiError.body?.code === 409 ||
          (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 409'));

        if (is409) {
          const conflictStrategy = options.conflictStrategy || 'warn';
          const result = await this.handleConflictStrategy(
            resolvedResource,
            conflictStrategy,
            resourceLogger
          );
          if (result) {
            return result;
          }
        }

        resourceLogger.error('Failed to apply resource to cluster', lastError, { attempt });

        // Check for HTTP 415 Unsupported Media Type errors
        if (isUnsupportedMediaTypeError(error)) {
          const acceptedTypes = extractAcceptedMediaTypes(error);
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

    // This should be unreachable due to the throw in the last attempt, but TypeScript needs it
    throw new ResourceDeploymentError(
      resolvedResource.metadata?.name || 'unknown',
      resolvedResource.kind || 'Unknown',
      lastError || new Error('Unknown deployment error')
    );
  }

  /**
   * Check if a resource already exists in the cluster.
   * Returns the existing resource if found, or undefined if it doesn't exist (404).
   * Throws for unexpected errors (non-404).
   */
  private async checkResourceExists(
    resource: KubernetesResource,
    resourceLogger: ReturnType<typeof this.logger.child>
  ): Promise<k8s.KubernetesObject | undefined> {
    try {
      return await this.k8sApi.read({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        metadata: {
          name: resource.metadata?.name || '',
          namespace: resource.metadata?.namespace || 'default',
        },
      });
    } catch (error: unknown) {
      const apiError = error as KubernetesApiError;
      // Check for 404 in various error formats
      const is404 =
        apiError.statusCode === 404 ||
        apiError.response?.statusCode === 404 ||
        apiError.body?.code === 404 ||
        (typeof apiError.message === 'string' && apiError.message.includes('HTTP-Code: 404'));

      if (is404) {
        // 404 means resource doesn't exist - this is expected, we'll create it
        return undefined;
      }

      // Check for "Unrecognized API version and kind" errors - CRD not installed yet
      const isUnrecognizedApiError =
        typeof apiError.message === 'string' &&
        apiError.message.includes('Unrecognized API version and kind');

      if (isUnrecognizedApiError) {
        resourceLogger.debug('CRD not yet registered, will retry after CRD establishment', {
          error: ensureError(error).message,
        });
      } else {
        resourceLogger.error('Error checking resource existence', ensureError(error));
      }
      throw error;
    }
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
    const enhancedManifest = deployedResource.manifest as Enhanced<unknown, unknown>;
    const readinessEvaluator = enhancedManifest.readinessEvaluator;

    // Debug logging removed

    if (!readinessEvaluator) {
      const errorMessage = `Resource ${deployedResource.kind}/${deployedResource.name} does not have a factory-provided readiness evaluator`;
      this.logger.error('Missing factory-provided readiness evaluator');
      throw new ResourceGraphFactoryError(errorMessage, deployedResource.id, 'deployment');
    }

    const startTime = Date.now();
    const timeout = options.timeout || DEFAULT_DEPLOYMENT_TIMEOUT;
    let lastStatus: ResourceStatus | null = null;

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
        const enhancedResource = enhanceResourceForEvaluation(liveResource, deployedResource.kind);

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
          await this.abortableDelay(DEFAULT_POLL_INTERVAL, abortSignal);
        } catch (error: unknown) {
          if (
            error instanceof DOMException &&
            (error.name === 'AbortError' || error.name === 'TimeoutError')
          ) {
            throw error; // Re-throw abort/timeout errors
          }
          // Ignore other errors from delay
        }
      } catch (error: unknown) {
        // Re-throw abort/timeout errors immediately
        if (
          error instanceof DOMException &&
          (error.name === 'AbortError' || error.name === 'TimeoutError')
        ) {
          throw error;
        }

        // Emit error status event
        this.emitEvent(options, {
          type: 'resource-status',
          resourceId: deployedResource.id,
          message: `Unable to read resource status: ${ensureError(error).message}`,
          timestamp: new Date(),
        });

        // If we can't read the resource, it's not ready yet - use abortable delay
        try {
          await this.abortableDelay(DEFAULT_POLL_INTERVAL, abortSignal);
        } catch (delayError: unknown) {
          if (
            delayError instanceof DOMException &&
            (delayError.name === 'AbortError' || delayError.name === 'TimeoutError')
          ) {
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

    throw new DeploymentTimeoutError(
      timeoutMessage,
      deployedResource.kind,
      deployedResource.name,
      timeout,
      'readiness'
    );
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
      } catch (error: unknown) {
        // Log and collect errors for individual resource deletion failures
        this.logger.warn('Failed to delete resource during rollback', {
          error: ensureError(error),
          resourceId: resource.id,
          kind: resource.kind,
          name: resource.name,
        });

        errors.push({
          resourceId: resource.id,
          phase: 'rollback',
          error: ensureError(error),
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
    return `deployment-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
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
      timeout: options.timeout || DEFAULT_READINESS_TIMEOUT,
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
      const timeout = DEFAULT_DELETE_TIMEOUT;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          await this.k8sApi.read({
            apiVersion: resource.manifest.apiVersion || '',
            kind: resource.kind,
            metadata: {
              name: resource.name,
              namespace: resource.namespace,
            },
          });

          // Resource still exists, wait and try again
          await new Promise((resolve) => setTimeout(resolve, DEFAULT_FAST_POLL_INTERVAL));
        } catch (error: unknown) {
          // Resource not found, deletion successful
          if (isNotFoundError(error)) {
            deleteLogger.debug('Resource successfully deleted');
            return;
          }
          throw error;
        }
      }

      throw new DeploymentTimeoutError(
        `Timeout waiting for resource ${resource.kind}/${resource.name} to be deleted`,
        resource.kind,
        resource.name,
        timeout,
        'deletion'
      );
    } catch (error: unknown) {
      deleteLogger.error('Failed to delete resource', ensureError(error));
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
      throw new ResourceGraphFactoryError(
        `Deployment ${deploymentId} not found. Cannot rollback.`,
        deploymentId,
        'cleanup'
      );
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
    } catch (error: unknown) {
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
            error: ensureError(error),
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
   * Public method to wait for CRD readiness by name
   */
  async waitForCRDReady(
    crdName: string,
    timeout: number = DEFAULT_CRD_READY_TIMEOUT,
    abortSignal?: AbortSignal
  ): Promise<void> {
    await this.crdManager.waitForCRDReady(crdName, this.deploymentMode, timeout, abortSignal);
  }
}
