/**
 * Direct Deployment Engine
 *
 * Orchestrates the deployment of Kubernetes resources directly to a cluster
 * without requiring the Kro controller, using in-process dependency resolution.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  DEFAULT_CRD_READY_TIMEOUT,
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_READINESS_TIMEOUT,
} from '../config/defaults.js';
import { DependencyResolver } from '../dependencies/index.js';
import { CircularDependencyError, ensureError, ResourceGraphFactoryError } from '../errors.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { copyResourceMetadata, getMetadataField, getResourceId as getResourceMetadataId } from '../metadata/index.js';
import { ensureReadinessEvaluator } from '../readiness/index.js';
import { DeploymentMode, ReferenceResolver } from '../references/index.js';
import { getResourceId } from '../resources/id.js';
import type {
  ClosureDependencyInfo,
  DeploymentClosure,
  DeploymentContext,
  DeploymentError,
  DeploymentEvent,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResourceGraph,
  DeploymentResult,
  DeploymentStateRecord,
  EnhancedDeploymentPlan,
  ResolutionContext,
  RollbackResult,
} from '../types/deployment.js';
import type { Scope } from '../types/serialization.js';
import type {
  DeployableK8sResource,
  DeployedResource,
  Enhanced,
  KubernetesObjectWithStatus,
  KubernetesResource,
} from '../types.js';
import { analyzeClosureDependencies, integrateClosuresIntoPlan } from './closure-planner.js';
import { CRDManager } from './crd-manager.js';
import { createDebugLoggerFromDeploymentOptions, type DebugLogger } from './debug-logger.js';
import { createEventMonitor, type EventMonitor } from './event-monitor.js';
import { ResourceReadinessChecker } from './readiness.js';
import { ReadinessWaiter } from './readiness-waiter.js';
import { ResourceApplier } from './resource-applier.js';
import { ResourceRollbackManager } from './rollback-manager.js';

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
  private resourceApplier: ResourceApplier;
  private rollbackManager: ResourceRollbackManager;
  private readinessWaiter: ReadinessWaiter;
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
    this.resourceApplier = new ResourceApplier(this.k8sApi, this.referenceResolver, this.logger);
    this.rollbackManager = new ResourceRollbackManager(this.k8sApi);
    this.readinessWaiter = new ReadinessWaiter(
      this.k8sApi,
      this.readyResources,
      this.readinessChecker,
      this.logger,
      undefined,
      {
        abortableDelay: this.abortableDelay.bind(this),
        withAbortSignal: this.withAbortSignal.bind(this),
        emitEvent: this.emitEvent.bind(this),
      }
    );
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
    return this.readinessWaiter.isDeployedResourceReady(deployedResource);
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

    const { abortController: deploymentAbortController, timeoutId } = this.setupDeploymentTimeout(
      deploymentId,
      options,
      deploymentLogger
    );
    const abortSignal = deploymentAbortController.signal;

    deploymentLogger.info(
      Object.keys(closures).length === 0
        ? 'Starting deployment'
        : 'Starting deployment with closures',
      {
        options,
        closures: Object.keys(closures),
      }
    );

    try {
      this.emitEvent(options, {
        type: 'started',
        message: `Starting deployment of ${graph.resources.length} resources and ${Object.keys(closures).length} closures`,
        timestamp: new Date(),
      });

      // Validate, plan, initialize monitoring, and build resolution context
      const { enhancedPlan, context, resourceKeyMapping } = await this.validateAndPlanDeployment(
        graph,
        closures,
        spec,
        options,
        startTime,
        deployedResources,
        deploymentLogger
      );

      // Deploy resources and closures level by level with proper dependency handling
      for (let levelIndex = 0; levelIndex < enhancedPlan.levels.length; levelIndex++) {
        const currentLevel = enhancedPlan.levels[levelIndex];
        if (!currentLevel) {
          continue;
        }

        const earlyReturn = await this.deployLevel(
          levelIndex,
          currentLevel,
          graph,
          deployedResources,
          errors,
          context,
          resourceKeyMapping,
          options,
          alchemyScope,
          abortSignal,
          startTime,
          deploymentId,
          deploymentLogger
        );

        // If deployLevel returned a result, it means rollback occurred — return immediately
        if (earlyReturn) {
          await this.cleanupDeployment(deploymentAbortController, timeoutId, deploymentLogger);
          return earlyReturn;
        }
      }

      const result = this.buildDeploymentResult(
        deploymentId,
        graph,
        enhancedPlan,
        deployedResources,
        errors,
        startTime,
        options,
        deploymentLogger
      );

      await this.cleanupDeployment(deploymentAbortController, timeoutId, deploymentLogger);

      // Store deployment state for rollback
      this.deploymentState.set(deploymentId, {
        deploymentId,
        resources: deployedResources,
        dependencyGraph: graph.dependencyGraph,
        startTime: new Date(startTime),
        endTime: new Date(),
        status:
          result.status === 'success'
            ? 'completed'
            : result.status === 'partial'
              ? 'completed'
              : 'failed',
        options,
      });

      return result;
    } catch (error: unknown) {
      // Re-throw circular dependency errors immediately - these are configuration errors
      if (error instanceof CircularDependencyError) {
        // Clean up abort controller and timeout before re-throwing
        await this.cleanupDeployment(deploymentAbortController, timeoutId, deploymentLogger);
        throw error;
      }

      // Clean up abort controller and timeout
      await this.cleanupDeployment(deploymentAbortController, timeoutId, deploymentLogger);

      const duration = Date.now() - startTime;
      this.emitEvent(options, {
        type: 'failed',
        message: `Deployment with closures failed: ${ensureError(error).message}`,
        timestamp: new Date(),
        error: ensureError(error),
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
            error: ensureError(error),
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Create an AbortController and set up a timeout that aborts the deployment
   * when the configured timeout is reached. Also stops event monitoring on timeout.
   * @param deploymentId - The unique deployment ID for logging
   * @param options - Deployment options containing the timeout configuration
   * @param deploymentLogger - Logger scoped to this deployment
   * @returns The AbortController and timeout ID for cleanup
   */
  private setupDeploymentTimeout(
    deploymentId: string,
    options: DeploymentOptions,
    deploymentLogger: ReturnType<typeof this.logger.child>
  ): { abortController: AbortController; timeoutId: ReturnType<typeof setTimeout> } {
    const abortController = this.createTrackedAbortController();
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

      abortController.abort();
    }, timeout);

    return { abortController, timeoutId };
  }

  /**
   * Validate the dependency graph for cycles, analyze deployment order,
   * integrate closures into the plan, initialize event/debug monitoring,
   * and build the resource key mapping and resolution context.
   * @param graph - The deployment resource graph
   * @param closures - Map of deployment closures keyed by name
   * @param spec - The resource graph spec for closure dependency analysis
   * @param options - Deployment options
   * @param startTime - Deployment start timestamp for event monitoring
   * @param deployedResources - Mutable array of deployed resources (used in resolution context)
   * @param deploymentLogger - Logger scoped to this deployment
   * @returns Enhanced plan, resolution context, and resource key mapping
   */
  private async validateAndPlanDeployment<TSpec>(
    graph: DeploymentResourceGraph,
    closures: Record<string, DeploymentClosure>,
    spec: TSpec,
    options: DeploymentOptions,
    startTime: number,
    deployedResources: DeployedResource[],
    deploymentLogger: ReturnType<typeof this.logger.child>
  ): Promise<{
    enhancedPlan: EnhancedDeploymentPlan;
    context: ResolutionContext;
    resourceKeyMapping: Map<string, unknown>;
  }> {
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
    await this.initializeEventMonitoring(options, startTime, deploymentLogger);

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

    // 5. Create resolution context with resourceKeyMapping for cross-resource references
    // The resourceKeyMapping maps original resource IDs (like 'webappDeployment') to their manifests
    const resourceKeyMapping = new Map<string, unknown>();
    for (const resource of graph.resources) {
      const manifest = resource.manifest as KubernetesResource;
      const originalResourceId = getResourceMetadataId(manifest);
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

    return { enhancedPlan, context, resourceKeyMapping };
  }

  /**
   * Initialize and start Kubernetes event monitoring if enabled in deployment options.
   * Logs a warning and continues if initialization fails.
   * @param options - Deployment options containing event monitoring configuration
   * @param startTime - Deployment start timestamp to filter events
   * @param deploymentLogger - Logger scoped to this deployment
   */
  private async initializeEventMonitoring(
    options: DeploymentOptions,
    startTime: number,
    deploymentLogger: ReturnType<typeof this.logger.child>
  ): Promise<void> {
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
  }

  /**
   * Deploy a single level of resources and closures in parallel. Processes results,
   * handles rollback on failure if configured, and logs level performance metrics.
   * Returns a DeploymentResult if rollback occurred (early exit), or undefined to continue.
   * @param levelIndex - Zero-based index of the current level
   * @param currentLevel - The level definition containing resource IDs and closures
   * @param graph - The full deployment resource graph
   * @param deployedResources - Mutable array accumulating deployed resources across levels
   * @param errors - Mutable array accumulating deployment errors across levels
   * @param context - Resolution context for cross-resource references
   * @param resourceKeyMapping - Map from resource IDs to their manifests (updated with live data)
   * @param options - Deployment options
   * @param alchemyScope - Optional alchemy scope for closure deployment context
   * @param abortSignal - Signal to abort deployment operations
   * @param startTime - Deployment start timestamp (used for rollback duration calculation)
   * @param deploymentId - Unique deployment ID for result building
   * @param deploymentLogger - Logger scoped to this deployment
   * @returns DeploymentResult if rollback occurred, undefined otherwise
   */
  private async deployLevel(
    levelIndex: number,
    currentLevel: { resources: string[]; closures: ClosureDependencyInfo[] },
    graph: DeploymentResourceGraph,
    deployedResources: DeployedResource[],
    errors: DeploymentError[],
    context: ResolutionContext,
    resourceKeyMapping: Map<string, unknown>,
    options: DeploymentOptions,
    alchemyScope: Scope | undefined,
    abortSignal: AbortSignal,
    startTime: number,
    deploymentId: string,
    deploymentLogger: ReturnType<typeof this.logger.child>
  ): Promise<DeploymentResult | undefined> {
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
            namespace: resourceWithEvaluator.metadata?.namespace || options.namespace || 'default',
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

    return undefined;
  }

  /**
   * Build the final DeploymentResult after all levels have been deployed.
   * Logs comprehensive performance metrics and emits completion/failure events.
   * @param deploymentId - Unique deployment ID
   * @param graph - The deployment resource graph
   * @param enhancedPlan - The enhanced deployment plan with closure information
   * @param deployedResources - All deployed resources across all levels
   * @param errors - All deployment errors across all levels
   * @param startTime - Deployment start timestamp
   * @param options - Deployment options for event emission
   * @param deploymentLogger - Logger scoped to this deployment
   * @returns The final deployment result
   */
  private buildDeploymentResult(
    deploymentId: string,
    graph: DeploymentResourceGraph,
    enhancedPlan: EnhancedDeploymentPlan,
    deployedResources: DeployedResource[],
    errors: DeploymentError[],
    startTime: number,
    options: DeploymentOptions,
    deploymentLogger: ReturnType<typeof this.logger.child>
  ): DeploymentResult {
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

    return {
      deploymentId,
      resources: deployedResources,
      dependencyGraph: graph.dependencyGraph,
      duration,
      status,
      errors,
    };
  }

  /**
   * Stop event monitoring, clear the deployment timeout, and remove the
   * abort controller from tracking. Safe to call multiple times.
   * @param abortController - The deployment's AbortController to untrack
   * @param timeoutId - The timeout ID to clear
   * @param deploymentLogger - Logger scoped to this deployment
   */
  private async cleanupDeployment(
    abortController: AbortController,
    timeoutId: ReturnType<typeof setTimeout>,
    deploymentLogger: ReturnType<typeof this.logger.child>
  ): Promise<void> {
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
    this.removeTrackedAbortController(abortController);
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
    const originalResourceId = getResourceMetadataId(deployedRes.manifest);
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

    // Resource ID from WeakMap metadata or deterministic ID generation
    const internalId = getResourceMetadataId(resource);
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
    const resolvedRef = await this.resourceApplier.resolveResourceReferences(
      resource,
      context,
      options,
      resourceLogger
    );

    // 2. Apply namespace if specified, but only if resource doesn't already have one
    const resolvedResource = this.resourceApplier.applyNamespaceToResource(
      resolvedRef,
      options.namespace,
      resourceLogger
    );

    // Preserve metadata (readinessEvaluator, scope, resourceId, etc.) from the
    // original Enhanced proxy onto the resolved resource. Reference resolution
    // and namespace application create new plain objects, losing WeakMap entries.
    copyResourceMetadata(resource, resolvedResource);

    // 3. Apply the resource to the cluster (or simulate for dry run)
    await this.resourceApplier.applyResourceToCluster(resolvedResource, options, resourceLogger);

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
    return this.readinessWaiter.waitForResourceReady(deployedResource, options, abortSignal);
  }

  /**
   * Rollback deployed resources
   */
  private async rollbackDeployedResources(
    deployedResources: DeployedResource[],
    options: DeploymentOptions
  ): Promise<{ rolledBackResources: string[]; errors: DeploymentError[] }> {
    return this.rollbackManager.rollbackDeployedResources(deployedResources, options);
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
    return this.rollbackManager.deleteDeployedResource(resource);
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
      // Use graph-based reverse-topological deletion when the dependency
      // graph is available. This ensures dependents are deleted before their
      // dependencies (e.g., App before Database, Database before Namespace),
      // preventing finalizer deadlocks and stuck namespace termination.
      let orderedResources = deploymentRecord.resources;
      if (deploymentRecord.dependencyGraph) {
        const sharedIds = new Set<string>();
        for (const r of deploymentRecord.resources) {
          if (getMetadataField(r.manifest, 'lifecycle') === 'shared') {
            sharedIds.add(r.id);
          }
        }
        try {
          const deletionPlan = this.dependencyResolver.analyzeDeletionOrder(
            deploymentRecord.dependencyGraph,
            sharedIds.size > 0 ? sharedIds : undefined
          );

          // Map graph node IDs to DeployedResource objects in deletion order
          const resourceMap = new Map(deploymentRecord.resources.map(r => [r.id, r]));
          orderedResources = [];
          for (const level of deletionPlan.levels) {
            for (const id of level) {
              const resource = resourceMap.get(id);
              if (resource) orderedResources.push(resource);
            }
          }

          this.logger.debug('Using graph-based deletion order', {
            deploymentId,
            levels: deletionPlan.levels.length,
            resourceCount: orderedResources.length,
            sharedSkipped: sharedIds.size,
          });
        } catch (graphError: unknown) {
          this.logger.warn('Graph-based deletion order failed, falling back to reverse order', {
            error: ensureError(graphError).message,
          });
          // Fall back to flat reverse order
          orderedResources = [...deploymentRecord.resources].reverse();
        }
      }

      const { rolledBackResources, errors } = await this.rollbackDeployedResources(
        orderedResources,
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
