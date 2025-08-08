/**
 * Direct Deployment Engine
 *
 * Orchestrates the deployment of Kubernetes resources directly to a cluster
 * without requiring the Kro controller, using in-process dependency resolution.
 */

import * as k8s from '@kubernetes/client-node';
import { DependencyResolver } from '../dependencies/index.js';
import { CircularDependencyError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { ReferenceResolver } from '../references/index.js';
import type {
  DeploymentError,
  DeploymentEvent,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResult,
  DeploymentStateRecord,
  ResolutionContext,
  ResourceGraph,
  RollbackResult,
} from '../types/deployment.js';
import { ResourceDeploymentError } from '../types/deployment.js';
import type {
  DeployableK8sResource,
  DeployedResource,
  DeploymentResource,
  Enhanced,
  KubernetesResource,
} from '../types.js';
import { ResourceReadinessChecker } from './readiness.js';
import { StatusHydrator } from './status-hydrator.js';

export class DirectDeploymentEngine {
  private dependencyResolver: DependencyResolver;
  private referenceResolver: ReferenceResolver;
  private k8sApi: k8s.KubernetesObjectApi;
  private readinessChecker: ResourceReadinessChecker;
  private statusHydrator: StatusHydrator;
  private deploymentState: Map<string, DeploymentStateRecord> = new Map();
  private logger = getComponentLogger('deployment-engine');

  constructor(
    private kubeClient: k8s.KubeConfig,
    k8sApi?: k8s.KubernetesObjectApi,
    referenceResolver?: ReferenceResolver
  ) {
    this.dependencyResolver = new DependencyResolver();
    this.referenceResolver = referenceResolver || new ReferenceResolver(kubeClient, k8sApi);
    this.k8sApi = k8sApi || k8s.KubernetesObjectApi.makeApiClient(kubeClient);
    this.readinessChecker = new ResourceReadinessChecker(this.k8sApi);
    this.statusHydrator = new StatusHydrator(this.k8sApi);
  }

  /**
   * Deploy a resource graph to the Kubernetes cluster
   */
  async deploy(graph: ResourceGraph, options: DeploymentOptions): Promise<DeploymentResult> {
    const deploymentId = this.generateDeploymentId();
    const startTime = Date.now();
    const deployedResources: DeployedResource[] = [];
    const errors: DeploymentError[] = [];

    const deploymentLogger = this.logger.child({ deploymentId, resourceCount: graph.resources.length });
    deploymentLogger.info('Starting deployment', { options });

    try {
      this.emitEvent(options, {
        type: 'started',
        message: `Starting deployment of ${graph.resources.length} resources`,
        timestamp: new Date(),
      });

      // 1. Validate no cycles in dependency graph
      deploymentLogger.debug('Validating dependency graph', { dependencyGraph: graph.dependencyGraph });
      this.dependencyResolver.validateNoCycles(graph.dependencyGraph);

      // 2. Get deployment order
      deploymentLogger.debug('Computing topological order');
      const deploymentOrder = this.dependencyResolver.getTopologicalOrder(graph.dependencyGraph);
      deploymentLogger.info('Deployment order determined', { deploymentOrder });

      // 3. Create resolution context
      const context: ResolutionContext = {
        deployedResources,
        kubeClient: this.kubeClient,
        ...(options.namespace && { namespace: options.namespace }),
        timeout: options.timeout || 30000,
      };

      // 4. Deploy resources in dependency order
      for (const resourceId of deploymentOrder) {
        const resourceLogger = deploymentLogger.child({ resourceId });
        resourceLogger.info('Starting resource deployment');
        resourceLogger.debug('Available resources in graph', { 
          availableResources: graph.resources.map(r => ({ 
            id: r.id, 
            kind: r.manifest?.kind, 
            name: r.manifest?.metadata?.name 
          }))
        });

        const resource = graph.resources.find((r) => r.id === resourceId);
        if (!resource) {
          resourceLogger.error('Resource not found in graph');
          const error = new Error(`Resource with id '${resourceId}' not found in graph`);
          errors.push({
            resourceId,
            phase: 'validation',
            error,
            timestamp: new Date(),
          });
          continue;
        }

        resourceLogger.debug('Found resource in graph', { 
          resourceId: resource.id, 
          kind: resource.manifest?.kind,
          name: resource.manifest?.metadata?.name 
        });

        try {
          resourceLogger.debug('Calling deploySingleResource');
          const deployedResource = await this.deploySingleResource(
            resource.manifest,
            context,
            options
          );
          resourceLogger.info('Resource deployed successfully');
          deployedResources.push(deployedResource);
        } catch (error) {
          resourceLogger.error('Resource deployment failed', error as Error);
          const deploymentError = {
            resourceId,
            phase: 'deployment' as const,
            error: error as Error,
            timestamp: new Date(),
          };
          errors.push(deploymentError);

          // Add failed resource to deployed resources list
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
          deployedResources.push(failedResource);

          if (options.rollbackOnFailure) {
            await this.rollbackDeployedResources(deployedResources, options);

            // Return failed status immediately after rollback
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
        }
      }

      const duration = Date.now() - startTime;
      const successfulResources = deployedResources.filter((r) => r.status !== 'failed');
      const status =
        errors.length === 0 ? 'success' : successfulResources.length > 0 ? 'partial' : 'failed';

      this.emitEvent(options, {
        type: status === 'success' ? 'completed' : 'failed',
        message: `Deployment ${status} in ${duration}ms`,
        timestamp: new Date(),
      });

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
        throw error;
      }

      const duration = Date.now() - startTime;

      this.emitEvent(options, {
        type: 'failed',
        message: `Deployment failed: ${error}`,
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
  }

  /**
   * Deploy a single resource
   */
  private async deploySingleResource(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>,
    context: ResolutionContext,
    options: DeploymentOptions
  ): Promise<DeployedResource> {
    const resourceId = resource.id || (resource as any).__resourceId || resource.metadata?.name || 'unknown';
    const resourceLogger = this.logger.child({ 
      resourceId, 
      kind: resource.kind, 
      name: resource.metadata?.name 
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
        originalMetadata: resource.metadata 
      });

      const resolveTimeout = options.timeout || 30000;
      resolvedResource = (await Promise.race([
        this.referenceResolver.resolveReferences(resource, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Reference resolution timeout')), resolveTimeout)
        ),
      ])) as KubernetesResource;

      resourceLogger.debug('References resolved successfully', { 
        resolvedMetadata: resolvedResource.metadata,
        hasReadinessEvaluator: !!(resolvedResource as any).readinessEvaluator
      });
    } catch (error) {
      // If reference resolution fails, use the original resource
      // This allows deployment to continue even if some references can't be resolved
      resourceLogger.warn('Reference resolution failed, using original resource', error as Error);
      resolvedResource = resource;
    }

    // 2. Apply namespace if specified
    if (options.namespace && resolvedResource.metadata) {
      resolvedResource.metadata.namespace = options.namespace;
    }
    


    // 3. Handle dry run
    if (options.dryRun) {
      return {
        id: resourceId,
        kind: resource.kind,
        name: resource.metadata?.name || 'unknown',
        namespace: resolvedResource.metadata?.namespace || 'default',
        manifest: resolvedResource,
        status: 'deployed',
        deployedAt: new Date(),
      };
    }

    // 4. Deploy to cluster with retry logic
    const deployedManifest: KubernetesResource = await this.deployToCluster(
      resolvedResource,
      options
    );

    // 5. Create deployed resource record
    // Use the original Enhanced proxy object as the manifest, but update its metadata
    // to reflect the deployed state from the Kubernetes API response
    const enhancedManifest = resolvedResource as Enhanced<any, any>;

    // Update the metadata to reflect the actual deployed state
    if (deployedManifest.metadata) {
      Object.assign(enhancedManifest.metadata || {}, deployedManifest.metadata);
    }

    const deployedResource: DeployedResource = {
      id: resourceId,
      kind: resource.kind,
      name: resource.metadata?.name || 'unknown',
      namespace: deployedManifest.metadata?.namespace || 'default',
      manifest: enhancedManifest,
      status: 'deployed',
      deployedAt: new Date(),
    };

    // 6. Wait for readiness if requested
    if (options.waitForReady) {
      resourceLogger.info('Waiting for resource readiness');
      await this.waitForResourceReady(deployedResource, options);
      resourceLogger.info('Resource is ready');
      deployedResource.status = 'ready';
    }

    this.emitEvent(options, {
      type: 'progress',
      resourceId,
      message: `Successfully deployed ${resource.kind}/${resource.metadata?.name}`,
      timestamp: new Date(),
    });

    return deployedResource;
  }

  /**
   * Deploy a single resource (public method for testing)
   */
  async deployResource(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>,
    options: DeploymentOptions = { mode: 'direct' }
  ): Promise<DeployedResource> {
    const context: ResolutionContext = {
      deployedResources: [],
      kubeClient: this.kubeClient,
      ...(options.namespace && { namespace: options.namespace }),
      timeout: options.timeout || 30000,
    };

    return this.deploySingleResource(resource, context, options);
  }

  /**
   * Wait for a resource to be ready (public method for KroResourceFactory integration)
   */
  async waitForResourceReadiness(
    deployedResource: DeployedResource,
    options: DeploymentOptions
  ): Promise<void> {
    return this.waitForResourceReady(deployedResource, options);
  }

  /**
   * Deploy a resource to the Kubernetes cluster
   */
  private async deployToCluster(
    resource: KubernetesResource,
    options: DeploymentOptions
  ): Promise<KubernetesResource> {
    const deployLogger = this.logger.child({ 
      kind: resource.kind, 
      name: resource.metadata?.name,
      namespace: resource.metadata?.namespace 
    });
    const retryPolicy = options.retryPolicy || {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelay: 1000,
      maxDelay: 10000,
    };

    let lastError: Error | undefined;
    let delay = retryPolicy.initialDelay;

    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        // Check if resource already exists
        let existingResource: k8s.KubernetesObject | undefined;
        try {
          const apiTimeout = options.timeout || 30000;
          const { body } = await Promise.race([
            this.k8sApi.read({
              apiVersion: resource.apiVersion,
              kind: resource.kind,
              metadata: {
                name: resource.metadata.name || resource.id || 'unknown',
                namespace: resource.metadata.namespace || 'default',
              },
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('API read timeout')), apiTimeout)
            ),
          ]) as { body: k8s.KubernetesObject };
          existingResource = body;
        } catch (error: unknown) {
          const k8sError = error as { statusCode?: number };
          if (k8sError.statusCode !== 404) {
            throw error;
          }
          // Resource doesn't exist, which is expected for creation
        }

        if (existingResource) {
          // Resource exists, update it
          // Create merged resource with proper metadata handling
          const mergedResource: k8s.KubernetesObject = {
            ...resource,
            metadata: {
              ...existingResource.metadata,
              ...resource.metadata,
              ...(existingResource.metadata?.resourceVersion && {
                resourceVersion: existingResource.metadata.resourceVersion,
              }),
            },
          };

          const apiTimeout = options.timeout || 30000;
          const { body } = await Promise.race([
            this.k8sApi.replace(mergedResource),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('API replace timeout')), apiTimeout)
            ),
          ]) as { body: k8s.KubernetesObject };
          return this.convertK8sObjectToKubernetesResource(body);
        } else {
          // Resource doesn't exist, create it
          // Use JSON serialization to correctly handle the Enhanced proxy and convert it to a plain object.
          // This ensures all properties, including metadata from proxied objects, are correctly resolved before the API call.
          const plainResource: k8s.KubernetesObject = JSON.parse(JSON.stringify(resource));


          
          const apiTimeout = options.timeout || 30000;
          const { body } = await Promise.race([
            this.k8sApi.create(plainResource),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('API create timeout')), apiTimeout)
            ),
          ]) as { body: k8s.KubernetesObject };
          return this.convertK8sObjectToKubernetesResource(body);
        }
      } catch (error) {
        // Enhanced error handling with detailed information
        const k8sError = error as any;
        let errorMessage = 'Unknown error';
        let errorDetails: any = {};

        if (k8sError.response) {
          // HTTP response error
          errorMessage = `HTTP ${k8sError.response.statusCode || 'unknown'}: ${k8sError.response.statusMessage || 'Request failed'}`;
          errorDetails = {
            statusCode: k8sError.response.statusCode,
            statusMessage: k8sError.response.statusMessage,
            body: k8sError.response.body,
            url: k8sError.response.url,
          };
        } else if (k8sError.statusCode) {
          // Kubernetes API error
          errorMessage = `Kubernetes API error ${k8sError.statusCode}: ${k8sError.message || 'Request failed'}`;
          errorDetails = {
            statusCode: k8sError.statusCode,
            message: k8sError.message,
            body: k8sError.body,
          };
        } else if (k8sError.code) {
          // Network/connection error
          errorMessage = `Network error ${k8sError.code}: ${k8sError.message || 'Connection failed'}`;
          errorDetails = {
            code: k8sError.code,
            errno: k8sError.errno,
            syscall: k8sError.syscall,
            hostname: k8sError.hostname,
            port: k8sError.port,
          };
        } else {
          // Generic error
          errorMessage = k8sError.message || String(error);
          errorDetails = {
            name: k8sError.name,
            stack: k8sError.stack,
          };
        }

        // Create enhanced error with details
        const enhancedError = new Error(errorMessage);
        (enhancedError as any).details = errorDetails;
        (enhancedError as any).originalError = error;
        (enhancedError as any).attempt = attempt + 1;
        (enhancedError as any).resourceInfo = {
          kind: resource.kind,
          name: resource.metadata?.name,
          namespace: resource.metadata?.namespace,
          apiVersion: resource.apiVersion,
        };

        lastError = enhancedError;

        // Log detailed error information for debugging
        deployLogger.error('Deployment attempt failed', error as Error, {
          attempt: attempt + 1,
          errorMessage,
          details: errorDetails,
          apiVersion: resource.apiVersion,
        });

        if (attempt < retryPolicy.maxRetries) {
          deployLogger.info('Retrying deployment', { delayMs: delay, attempt: attempt + 1 });
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * retryPolicy.backoffMultiplier, retryPolicy.maxDelay);
        }
      }
    }

    throw new ResourceDeploymentError(
      resource.metadata?.name || 'unknown',
      resource.kind,
      lastError || new Error('Unknown deployment error')
    );
  }

  /**
   * Convert Kubernetes API object to our KubernetesResource type
   */
  private convertK8sObjectToKubernetesResource(
    k8sObject: k8s.KubernetesObject
  ): KubernetesResource {
    // Use our type-safe approach to extract spec and status
    const spec = this.extractFieldFromK8sObject(k8sObject, 'spec');
    const status = this.extractFieldFromK8sObject(k8sObject, 'status');

    return {
      apiVersion: k8sObject.apiVersion || '',
      kind: k8sObject.kind || '',
      metadata: k8sObject.metadata || {},
      spec,
      status,
      ...k8sObject, // Include any additional fields
    } as KubernetesResource;
  }

  /**
   * Type-safe field extraction from Kubernetes objects
   */
  private extractFieldFromK8sObject(obj: k8s.KubernetesObject, field: string): unknown {
    return (obj as Record<string, unknown>)[field];
  }

  /**
   * Rollback deployed resources in reverse order
   */
  private async rollbackDeployedResources(
    deployedResources: DeployedResource[],
    options: DeploymentOptions
  ): Promise<void> {
    this.emitEvent(options, {
      type: 'rollback',
      message: `Rolling back ${deployedResources.length} deployed resources`,
      timestamp: new Date(),
    });

    // Rollback in reverse order
    const reversedResources = [...deployedResources].reverse();

    for (const resource of reversedResources) {
      try {
        await this.k8sApi.delete({
          apiVersion: resource.manifest.apiVersion,
          kind: resource.kind,
          metadata: {
            name: resource.name,
            namespace: resource.namespace,
          },
        });

        this.emitEvent(options, {
          type: 'rollback',
          resourceId: resource.id,
          message: `Rolled back ${resource.kind}/${resource.name}`,
          timestamp: new Date(),
        });
      } catch (error) {
        this.emitEvent(options, {
          type: 'rollback',
          resourceId: resource.id,
          message: `Failed to rollback ${resource.kind}/${resource.name}: ${error}`,
          timestamp: new Date(),
          error: error as Error,
        });
      }
    }
  }

  /**
   * Rollback a deployment by ID
   */
  async rollbackDeployment(deploymentId: string): Promise<RollbackResult> {
    const startTime = Date.now();
    const deploymentRecord = this.deploymentState.get(deploymentId);

    if (!deploymentRecord) {
      throw new Error(`Deployment ${deploymentId} not found. Cannot rollback.`);
    }

    const rolledBackResources: string[] = [];
    const errors: DeploymentError[] = [];

    // Only rollback successfully deployed resources
    const resourcesToRollback = deploymentRecord.resources.filter(
      (r) => r.status === 'deployed' || r.status === 'ready'
    );

    if (resourcesToRollback.length === 0) {
      return {
        deploymentId,
        rolledBackResources: [],
        duration: Date.now() - startTime,
        status: 'success',
        errors: [],
      };
    }

    // Rollback in reverse order
    const reversedResources = [...resourcesToRollback].reverse();

    for (const resource of reversedResources) {
      try {
        await this.deleteResource(resource);
        rolledBackResources.push(resource.id);
      } catch (error) {
        errors.push({
          resourceId: resource.id,
          phase: 'rollback',
          error: error as Error,
          timestamp: new Date(),
        });
      }
    }

    const duration = Date.now() - startTime;
    const status =
      errors.length === 0 ? 'success' : rolledBackResources.length > 0 ? 'partial' : 'failed';

    return {
      deploymentId,
      rolledBackResources,
      duration,
      status,
      errors,
    };
  }

  /**
   * Get deployment status by ID
   */
  getDeploymentStatus(deploymentId: string): DeploymentOperationStatus | undefined {
    const deploymentRecord = this.deploymentState.get(deploymentId);

    if (!deploymentRecord) {
      return undefined;
    }

    return {
      deploymentId,
      status: deploymentRecord.status,
      startTime: deploymentRecord.startTime,
      ...(deploymentRecord.endTime && { endTime: deploymentRecord.endTime }),
      resources: deploymentRecord.resources,
    };
  }

  /**
   * Get deployment status by ID (alias for getDeploymentStatus)
   */
  async getStatus(deploymentId: string): Promise<DeploymentOperationStatus> {
    const status = this.getDeploymentStatus(deploymentId);

    if (!status) {
      return {
        deploymentId,
        status: 'unknown',
        startTime: new Date(),
        duration: 0,
        resources: [],
      };
    }

    return {
      ...status,
      duration: status.endTime
        ? status.endTime.getTime() - status.startTime.getTime()
        : Date.now() - status.startTime.getTime(),
    };
  }

  /**
   * Rollback a deployment by ID (alias for rollbackDeployment)
   */
  async rollback(deploymentId: string): Promise<RollbackResult> {
    return this.rollbackDeployment(deploymentId);
  }

  /**
   * Check if a resource is ready (exposed for testing)
   */
  isResourceReady(resource: DeploymentResource): boolean {
    return this.readinessChecker.isResourceReady(resource);
  }

  /**
   * Delete a resource with graceful handling of finalizers
   */
  private async deleteResource(resource: DeployedResource): Promise<void> {
    const deleteLogger = this.logger.child({ 
      kind: resource.kind, 
      name: resource.name,
      namespace: resource.namespace 
    });
    
    try {
      // First attempt normal deletion
      await this.k8sApi.delete({
        apiVersion: resource.manifest.apiVersion,
        kind: resource.manifest.kind,
        metadata: {
          name: resource.name,
          namespace: resource.namespace,
        },
      } as k8s.KubernetesObject);

      // Wait for deletion to complete (with timeout)
      const timeout = 30000; // 30 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          // Type assertion needed for Kubernetes client API boundary
          const readRequest = {
            apiVersion: resource.manifest.apiVersion,
            kind: resource.manifest.kind,
            metadata: {
              name: resource.name,
              namespace: resource.namespace,
            },
          };
          await this.k8sApi.read(readRequest as Parameters<typeof this.k8sApi.read>[0]);

          // Resource still exists, wait a bit more
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (_error) {
          // Resource not found - deletion successful
          return;
        }
      }

      // If we get here, deletion timed out - might have finalizers
      deleteLogger.warn('Resource deletion timed out - may have finalizers');
    } catch (error) {
      // If the resource doesn't exist, that's fine for rollback
      if (this.isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  /**
   * Type-safe check for 404 Not Found errors
   */
  private isNotFoundError(error: unknown): boolean {
    return !!(
      error &&
      typeof error === 'object' &&
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'statusCode' in error.response &&
      error.response.statusCode === 404
    );
  }

  /**
   * Generate a unique deployment ID
   */
  private generateDeploymentId(): string {
    return `deployment-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
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
   * Enhanced waitForResourceReady that checks for custom readiness evaluators
   * and integrates status hydration
   */
  private async waitForResourceReady(
    deployedResource: DeployedResource,
    options: DeploymentOptions
  ): Promise<void> {
    const readinessLogger = this.logger.child({ 
      resourceId: deployedResource.id,
      kind: deployedResource.kind,
      name: deployedResource.name 
    });
    
    readinessLogger.debug('Starting resource readiness check');

    // Check if resource has factory-provided readiness evaluator
    const readinessEvaluator = (deployedResource.manifest as Enhanced<any, any>).readinessEvaluator;
    readinessLogger.debug('Checking for custom readiness evaluator', { 
      hasCustomEvaluator: !!readinessEvaluator 
    });

    if (readinessEvaluator) {
      try {
        readinessLogger.debug('Using custom readiness evaluator');
        return await this.waitForResourceReadyWithCustomEvaluator(
          deployedResource,
          readinessEvaluator,
          options
        );
      } catch (error) {
        // If custom readiness fails, fall back to generic checking
        readinessLogger.warn('Custom readiness evaluation failed, falling back to generic checking', error as Error);
        this.emitEvent(options, {
          type: 'resource-warning',
          resourceId: deployedResource.id,
          message: `Custom readiness evaluation failed, using generic checking: ${error}`,
          timestamp: new Date(),
        });
      }
    }

    // Use existing ResourceReadinessChecker as fallback
    readinessLogger.debug('Using generic readiness checker');
    return this.readinessChecker.waitForResourceReady(deployedResource, options, (event) =>
      this.emitEvent(options, event)
    );
  }

  /**
   * Use factory-provided readiness evaluator with integrated status hydration
   */
  private async waitForResourceReadyWithCustomEvaluator(
    deployedResource: DeployedResource,
    readinessEvaluator: (liveResource: any) => any,
    options: DeploymentOptions
  ): Promise<void> {
    const startTime = Date.now();
    const timeout = options.timeout || 300000; // 5 minutes default
    let lastStatus: any = null;

    while (Date.now() - startTime < timeout) {
      try {
        // Get current resource state
        const liveResource = await this.k8sApi.read({
          apiVersion: deployedResource.manifest.apiVersion,
          kind: deployedResource.kind,
          metadata: {
            name: deployedResource.name,
            namespace: deployedResource.namespace,
          },
        } as any);

        // Use factory-provided evaluator to get structured status
        const status = readinessEvaluator(liveResource.body);

        // Emit status updates when status changes
        if (!lastStatus || lastStatus.message !== status.message) {
          this.emitEvent(options, {
            type: status.ready ? 'resource-ready' : 'resource-status',
            resourceId: deployedResource.id,
            message: status.message || (status.ready ? 'Resource is ready' : 'Resource not ready'),
            timestamp: new Date(),
            ...(status.details && { details: status.details }),
          });
          lastStatus = status;
        }

        if (status.ready) {
          // Resource is ready - now hydrate status fields using the same live resource data
          if (options.hydrateStatus !== false) {
            await this.hydrateResourceStatus(deployedResource, liveResource.body);
          }
          return;
        }

        // Wait before next check (existing polling interval)
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        // If we can't read the resource, it's not ready yet
        this.emitEvent(options, {
          type: 'resource-status',
          resourceId: deployedResource.id,
          message: `Unable to read resource status: ${error}`,
          timestamp: new Date(),
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Provide detailed timeout error with last known status
    const timeoutMessage = lastStatus
      ? `Timeout waiting for ${deployedResource.kind}/${deployedResource.name}: ${lastStatus.message}`
      : `Timeout waiting for ${deployedResource.kind}/${deployedResource.name} to be ready`;

    throw new Error(timeoutMessage);
  }

  /**
   * Hydrate status fields using already-fetched live resource data
   * This eliminates duplicate API calls by reusing data from readiness checking
   */
  private async hydrateResourceStatus(deployedResource: DeployedResource, liveResourceData: any): Promise<void> {
    const hydrationLogger = this.logger.child({ 
      resourceName: deployedResource.name,
      kind: deployedResource.kind 
    });
    
    try {
      hydrationLogger.debug('Starting status hydration');

      const enhanced = deployedResource.manifest as Enhanced<any, any>;
      hydrationLogger.debug('Status hydration details', {
        isProxy: enhanced.constructor.name,
        hasStatus: !!enhanced.status
      });

      // Use StatusHydrator with already-fetched live data
      const result = await this.statusHydrator.hydrateStatusFromLiveData(enhanced, liveResourceData, deployedResource);
      hydrationLogger.debug('Status hydration completed', { result });

    } catch (error) {
      hydrationLogger.warn('Status hydration failed', error as Error);
      // Don't fail the deployment if status hydration fails
    }
  }
}
