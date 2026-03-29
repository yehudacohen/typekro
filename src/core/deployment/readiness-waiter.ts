/**
 * Readiness Waiter
 *
 * Handles waiting for Kubernetes resources to become ready after deployment,
 * using factory-provided readiness evaluators with polling loops.
 */

import type * as k8s from '@kubernetes/client-node';
import { DEFAULT_DEPLOYMENT_TIMEOUT, DEFAULT_POLL_INTERVAL } from '../config/defaults.js';
import { DeploymentTimeoutError, ensureError, ResourceGraphFactoryError } from '../errors.js';
import type { TypeKroLogger } from '../logging/index.js';
import { getMetadataField, getReadinessEvaluator } from '../metadata/index.js';
import type { DeploymentEvent, DeploymentOptions } from '../types/deployment.js';
import type { DeployedResource, ResourceStatus } from '../types.js';
import type { DebugLogger } from './debug-logger.js';
import { enhanceResourceForEvaluation } from './k8s-helpers.js';
import type { ResourceReadinessChecker } from './readiness.js';

/**
 * Dependencies injected from the deployment engine
 */
export interface ReadinessWaiterDeps {
  abortableDelay: (ms: number, signal?: AbortSignal) => Promise<void>;
  withAbortSignal: <T>(operation: Promise<T>, signal?: AbortSignal) => Promise<T>;
  emitEvent: (options: DeploymentOptions, event: DeploymentEvent) => void;
}

/**
 * Handles readiness checking and waiting for deployed Kubernetes resources
 */
export class ReadinessWaiter {
  constructor(
    private k8sApi: k8s.KubernetesObjectApi,
    private readyResources: Set<string>,
    private readinessChecker: ResourceReadinessChecker,
    private logger: TypeKroLogger,
    private debugLogger?: DebugLogger,
    private deps?: ReadinessWaiterDeps
  ) {}

  /**
   * Update the debug logger (e.g., when debug logging is enabled mid-deployment)
   */
  setDebugLogger(debugLogger: DebugLogger): void {
    this.debugLogger = debugLogger;
  }

  /**
   * Check if a deployed resource is ready using the factory-provided readiness evaluator
   */
  async isDeployedResourceReady(deployedResource: DeployedResource): Promise<boolean> {
    try {
      // Check if the deployed resource has a factory-provided readiness evaluator (via WeakMap)
      const readinessEvaluator = getReadinessEvaluator(deployedResource.manifest);

      // Create a resource reference for the API call (shared by both paths).
      // Cluster-scoped resources (Namespace, ClusterRole, etc.) must omit namespace.
      const isClusterScoped = getMetadataField(deployedResource.manifest, 'scope') === 'cluster';
      const resourceRef = {
        apiVersion: deployedResource.manifest.apiVersion || '',
        kind: deployedResource.kind,
        metadata: {
          name: deployedResource.name,
          ...(isClusterScoped ? {} : { namespace: deployedResource.namespace }),
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
   * Wait for a resource to be ready
   * @param deployedResource - The deployed resource to wait for
   * @param options - Deployment options
   * @param abortSignal - Optional AbortSignal to cancel the wait
   */
  async waitForResourceReady(
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
    const readinessEvaluator = getReadinessEvaluator(deployedResource.manifest);

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
        const clusterScoped = getMetadataField(deployedResource.manifest, 'scope') === 'cluster';
        const liveResource = await this.withAbortSignal(
          this.k8sApi.read({
            apiVersion: deployedResource.manifest.apiVersion || '',
            kind: deployedResource.kind,
            metadata: {
              name: deployedResource.name,
              ...(clusterScoped ? {} : { namespace: deployedResource.namespace }),
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

        // Log and emit status update
        if (lastStatus && typeof lastStatus === 'object' && 'message' in lastStatus) {
          this.logger.debug('Resource not ready yet', {
            resourceId: deployedResource.id,
            kind: deployedResource.kind,
            name: deployedResource.name,
            reason: lastStatus.reason,
            message: lastStatus.message,
          });

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

        // Log and emit error status event
        this.logger.warn('Unable to read resource status during readiness poll', {
          resourceId: deployedResource.id,
          kind: deployedResource.kind,
          name: deployedResource.name,
          namespace: deployedResource.namespace,
          error: ensureError(error).message,
        });

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
   * Abortable delay - delegates to injected dependency or falls back to simple delay
   */
  private abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.deps?.abortableDelay) {
      return this.deps.abortableDelay(ms, signal);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wrap an async operation with abort signal handling - delegates to injected dependency
   */
  private withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.deps?.withAbortSignal) {
      return this.deps.withAbortSignal(operation, signal);
    }
    return operation;
  }

  /**
   * Emit deployment events - delegates to injected dependency
   */
  private emitEvent(options: DeploymentOptions, event: DeploymentEvent): void {
    if (this.deps?.emitEvent) {
      this.deps.emitEvent(options, event);
    }
  }
}
