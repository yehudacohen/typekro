/**
 * Base Deployment Strategy
 *
 * This module provides the abstract base class for deployment strategies
 * with common template method pattern implementation.
 */

import { StatusHydrationError } from '../../errors.js';
import { createBunCompatibleKubernetesObjectApi } from '../../kubernetes/bun-api-client.js';
import { getComponentLogger } from '../../logging/index.js';
import { createResourcesProxy } from '../../references/schema-proxy.js';
import type { DeploymentResult, FactoryOptions } from '../../types/deployment.js';
import type { Enhanced, KubernetesResource } from '../../types/kubernetes.js';
import type {
  KroCompatibleType,
  SchemaDefinition,
  SchemaProxy,
  StatusBuilder,
} from '../../types/serialization.js';
import { createEnhancedMetadata, generateInstanceName, validateSpec } from '../shared-utilities.js';

/**
 * Base deployment strategy interface
 */
export interface DeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> {
  deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>>;
}

/**
 * Abstract base class for deployment strategies
 */
export abstract class BaseDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> implements DeploymentStrategy<TSpec, TStatus>
{
  protected readonly logger = getComponentLogger('deployment-strategy');

  constructor(
    protected factoryName: string,
    protected namespace: string,
    protected schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    protected statusBuilder?: StatusBuilder<TSpec, TStatus, any>,
    protected resourceKeys?: Record<string, KubernetesResource>,
    protected factoryOptions: FactoryOptions = {}
  ) {}

  /**
   * Template method for deployment - defines the common flow
   */
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    this.logger.debug('Base strategy deploy called', {
      factoryName: this.factoryName,
      hasStatusBuilder: !!this.statusBuilder,
      hasResourceKeys: !!this.resourceKeys,
    });

    // Step 1: Validate spec (common to all strategies)
    validateSpec(spec, this.schemaDefinition);

    // Step 2: Generate instance name (common to all strategies)
    const instanceName = generateInstanceName(spec);

    this.logger.debug('Starting deployment execution', {
      instanceName,
      factoryName: this.factoryName,
    });

    // Step 3: Execute strategy-specific deployment
    const deploymentResult = await this.executeDeployment(spec, instanceName);

    // Step 4: Create Enhanced proxy (common to all strategies)
    return await this.createEnhancedProxy(spec, instanceName, deploymentResult);
  }

  /**
   * Strategy-specific deployment logic - implemented by subclasses
   */
  protected abstract executeDeployment(
    spec: TSpec,
    instanceName: string
  ): Promise<DeploymentResult>;

  /**
   * Create Enhanced proxy - common logic with strategy-specific customization
   */
  protected async createEnhancedProxy(
    spec: TSpec,
    instanceName: string,
    deploymentResult: DeploymentResult
  ): Promise<Enhanced<TSpec, TStatus>> {
    const metadata = createEnhancedMetadata(
      instanceName,
      this.namespace,
      this.factoryName,
      this.getStrategyMode()
    );

    // Add deployment status and ID to metadata for factory-level error handling and cleanup
    if (deploymentResult?.status) {
      metadata.annotations = metadata.annotations || {};
      metadata.annotations['typekro.io/deployment-status'] = deploymentResult.status;

      // Store deployment ID for cleanup/rollback
      if (deploymentResult.deploymentId) {
        metadata.annotations['typekro.io/deployment-id'] = deploymentResult.deploymentId;
      }

      // Add error message for failed deployments
      if (deploymentResult.status === 'failed' && deploymentResult.errors?.length > 0) {
        const firstError = deploymentResult.errors[0];
        metadata.annotations['typekro.io/deployment-error'] =
          firstError?.error?.message || 'Unknown deployment error';
      }
    }

    // Build status using the status builder if available, otherwise extract from resources
    let status: TStatus = {} as TStatus;

    this.logger.debug('Status building attempt', {
      instanceName,
      hasStatusBuilder: !!this.statusBuilder,
      hasResourceKeys: !!this.resourceKeys,
      hasDeploymentResult: !!deploymentResult,
      deploymentResultType: deploymentResult ? typeof deploymentResult : 'undefined',
    });

    if (this.statusBuilder) {
      // CRITICAL: Status hydration requires waitForReady: true
      // When waitForReady is false, resources may not have status yet
      // Return proxy with spec accessible but status set to null
      if (this.factoryOptions.waitForReady === false) {
        this.logger.info('Status hydration skipped: waitForReady is false', {
          instanceName,
          message: 'Set waitForReady: true to enable status hydration',
        });

        // Status unavailable when waitForReady is false — resources may not have status yet.
        // Consumers should check for empty status when waitForReady is false.
        status = {} as TStatus;
      }
      // Honor hydrateStatus: false — skip cluster queries for status enrichment.
      // The deployment itself already succeeded; status hydration is a best-effort
      // enrichment that makes the return value richer but isn't on the critical path.
      else if (this.factoryOptions.hydrateStatus === false) {
        this.logger.info('Status hydration skipped: hydrateStatus is false', {
          instanceName,
          message: 'Set hydrateStatus: true (default) to enable post-deployment status hydration',
        });
        status = {} as TStatus;
      }
      // Check deployment status before attempting hydration (only if waitForReady is true)
      else if (deploymentResult) {
        if (deploymentResult.status === 'failed') {
          // Extract failed resources with full details
          const resourcesById = new Map(deploymentResult.resources.map((r) => [r.id, r]));

          const failedResources = deploymentResult.errors.map((err) => {
            const resource = resourcesById.get(err.resourceId);
            return {
              id: err.resourceId,
              kind: resource?.kind || 'Unknown',
              name: resource?.name || 'unknown',
              error: err.error?.message || String(err.error),
            };
          });

          throw StatusHydrationError.forFailedDeployment(instanceName, failedResources);
        }

        if (deploymentResult.status === 'partial') {
          const resourcesById = new Map(deploymentResult.resources.map((r) => [r.id, r]));

          const failedResources = deploymentResult.errors.map((err) => {
            const resource = resourcesById.get(err.resourceId);
            return {
              id: err.resourceId,
              kind: resource?.kind || 'Unknown',
              name: resource?.name || 'unknown',
              error: err.error?.message || String(err.error),
            };
          });
          const successCount = deploymentResult.resources
            ? deploymentResult.resources.length - deploymentResult.errors.length
            : 0;

          throw StatusHydrationError.forPartialDeployment(
            instanceName,
            failedResources,
            successCount
          );
        }
      }

      // Only proceed with status hydration if waitForReady: true, hydrateStatus: true,
      // and deployment succeeded
      if (
        this.factoryOptions.waitForReady !== false &&
        this.factoryOptions.hydrateStatus !== false
      ) {
        // Cap status hydration at 60s — this is post-deployment enrichment, not the
        // deployment itself. If cluster reads are slow, gracefully degrade rather than
        // blocking indefinitely.
        const hydrationTimeout = Math.min(this.factoryOptions.timeout || 60000, 60000);

        try {
          let hydrationTimer: ReturnType<typeof setTimeout> | undefined;
          status = await Promise.race([
            this.hydrateStatusFromCluster(spec, instanceName, deploymentResult),
            new Promise<never>((_, reject) => {
              hydrationTimer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Status hydration timed out after ${hydrationTimeout}ms. ` +
                        `Deployment succeeded but post-deployment status enrichment was slow. ` +
                        `Set hydrateStatus: false to skip status hydration if not needed.`
                    )
                  ),
                hydrationTimeout
              );
            }),
          ]);
          // Clear the timeout timer on success to prevent unhandled rejection
          if (hydrationTimer !== undefined) clearTimeout(hydrationTimer);
        } catch (error) {
          this.logger.warn(
            'Status hydration failed or timed out, falling back to resource extraction',
            {
              instanceName,
              error: error instanceof Error ? error.message : String(error),
            }
          );

          // Fallback to extracting status from the first deployed resource
          if (
            deploymentResult &&
            'resources' in deploymentResult &&
            deploymentResult.resources.length > 0
          ) {
            const firstResource = deploymentResult.resources[0];
            if (firstResource?.manifest && 'status' in firstResource.manifest) {
              status = firstResource.manifest.status as TStatus;
            }
          }
        }
      }
    } else {
      // No status builder available, extract from the first deployed resource
      if (
        deploymentResult &&
        'resources' in deploymentResult &&
        deploymentResult.resources.length > 0
      ) {
        const firstResource = deploymentResult.resources[0];
        if (firstResource?.manifest && 'status' in firstResource.manifest) {
          status = firstResource.manifest.status as TStatus;
        }
      }
    }

    return {
      apiVersion: this.getApiVersion(),
      kind: this.getKind(),
      spec,
      status,
      metadata,
    } as unknown as Enhanced<TSpec, TStatus>;
  }

  /**
   * Hydrate status by querying live resource data from the cluster.
   *
   * This method:
   * 1. Queries each deployed resource ONCE from the cluster to get live status
   * 2. Builds the enhanced resources map for the status builder
   * 3. Calls the status builder with live resource data
   * 4. Resolves any CEL expressions in the computed status
   *
   * All cluster reads use a single shared K8s API client. Resources are queried
   * only once and the results are reused for both the status builder and CEL
   * resolution mapping.
   */
  private async hydrateStatusFromCluster(
    spec: TSpec,
    instanceName: string,
    deploymentResult: DeploymentResult
  ): Promise<TStatus> {
    // Create enhanced resources for the status builder using original resource keys
    const enhancedResources: Record<string, Enhanced<unknown, unknown>> = {};

    // Track live resources by original key — queried once, reused for CEL resolution
    const liveResourcesByKey = new Map<string, unknown>();

    // Create a SINGLE K8s API client for all cluster reads (shared across hydration and CEL resolution)
    const k8sApi = this.factoryOptions.kubeConfig
      ? createBunCompatibleKubernetesObjectApi(this.factoryOptions.kubeConfig)
      : undefined;

    if (deploymentResult && 'resources' in deploymentResult && this.resourceKeys) {
      // Create a mapping from resource ID to deployed resource
      const deployedResourcesById: Record<string, unknown> = {};
      for (const deployedResource of deploymentResult.resources) {
        if (deployedResource?.manifest) {
          deployedResourcesById[deployedResource.id] = deployedResource;
        }
      }

      this.logger.debug('Resource mapping debug', {
        instanceName,
        originalResourceKeys: Object.keys(this.resourceKeys),
        deployedResourceIds: Object.keys(deployedResourcesById),
        deployedResourceDetails: deploymentResult.resources.map((r) => ({
          id: r.id,
          kind: r.manifest?.kind,
          name: r.manifest?.metadata?.name,
          labels: r.manifest?.metadata?.labels,
        })),
        resourceKeysMapping: Object.entries(this.resourceKeys).map(([key, resource]) => ({
          key,
          resourceId: resource.id,
          resourceKind: resource.kind,
          resourceName: resource.metadata?.name,
          hasDeployedResource: !!(resource.id && deployedResourcesById[resource.id]),
        })),
      });

      // Map original resource keys to deployed resources by matching kind and name.
      // Query each resource from the cluster ONCE to get live status.
      for (const [originalKey, originalResource] of Object.entries(this.resourceKeys)) {
        // Find deployed resource by matching kind and name
        const deployedResource = deploymentResult.resources.find(
          (dr) =>
            dr.manifest?.kind === originalResource.kind &&
            dr.manifest?.metadata?.name === originalResource.metadata?.name
        );

        if (deployedResource?.manifest) {
          // Try to get the actual resource status from the cluster
          let actualResource = deployedResource.manifest;

          if (k8sApi) {
            try {
              actualResource = (await k8sApi.read({
                apiVersion: deployedResource.manifest.apiVersion,
                kind: deployedResource.manifest.kind,
                metadata: {
                  name: deployedResource.manifest.metadata?.name || '',
                  namespace:
                    deployedResource.manifest.metadata?.namespace || this.namespace || 'default',
                },
              })) as KubernetesResource<unknown, unknown>;
            } catch (_error) {
              // Cluster read failed — fall back to the deployment manifest.
              // This is expected for resources that don't support GET (e.g., events).
            }
          }

          // Store the live resource for reuse in CEL resolution (avoids redundant reads)
          liveResourcesByKey.set(originalKey, actualResource);

          enhancedResources[originalKey] = {
            metadata: actualResource.metadata || {},
            spec: (actualResource as { spec?: unknown }).spec || {},
            status: (actualResource as { status?: unknown }).status || {},
          } as Enhanced<unknown, unknown>;
        }
      }

      this.logger.debug('Enhanced resources created', {
        instanceName,
        enhancedResourceKeys: Object.keys(enhancedResources),
        enhancedResourcesWithStatus: Object.entries(enhancedResources).map(([key, resource]) => ({
          key,
          hasStatus: !!resource.status && Object.keys(resource.status).length > 0,
          statusKeys: resource.status ? Object.keys(resource.status) : [],
        })),
      });
    }

    // Create a schema proxy for the status builder
    const schemaProxy = {
      spec,
      status: {} as TStatus,
    };

    // Call the status builder to get the computed status
    // Wrap enhanced resources with proxy to enable resource reference magic
    const resourcesProxy = createResourcesProxy(enhancedResources);
    const computedStatus = this.statusBuilder!(
      schemaProxy as SchemaProxy<TSpec, TStatus>,
      resourcesProxy
    );
    let status = computedStatus as TStatus;

    this.logger.debug('Status built using status builder', {
      instanceName,
      statusFields: Object.keys(status),
    });

    // In direct mode, resolve CEL expressions in the status against deployed resources
    if (this.getStrategyMode() === 'direct' && this.factoryOptions.kubeConfig) {
      try {
        const { ReferenceResolver } = await import('../../references/resolver.js');
        const resolver = new ReferenceResolver(this.factoryOptions.kubeConfig, 'direct');

        const deployedResources = deploymentResult?.resources || [];

        this.logger.debug('Available deployed resources for CEL resolution', {
          instanceName,
          resourceCount: deployedResources.length,
          resourceIds: deployedResources.map((r) => r.id),
          resourceNames: deployedResources.map((r) => r.name),
          resourceKinds: deployedResources.map((r) => r.kind),
        });

        // Build the resource key mapping for CEL resolution.
        // REUSE live resources already fetched above instead of re-querying the cluster.
        const resourceKeyMapping = new Map<string, unknown>();

        // Convert instance name to camelCase for pattern matching
        const camelCaseInstanceName = instanceName.replace(/-([a-z])/g, (_, letter) =>
          letter.toUpperCase()
        );

        for (const deployedResource of deployedResources) {
          // Extract the original resource key from __resourceId or the deployment ID pattern
          const manifestResourceId = (deployedResource.manifest as any).__resourceId;
          const resourceIdPattern = new RegExp(`^${camelCaseInstanceName}Resource\\d+(.+)$`);
          const match = deployedResource.id.match(resourceIdPattern);

          let originalKey: string | undefined;
          if (manifestResourceId) {
            originalKey = manifestResourceId;
          } else if (match?.[1]) {
            originalKey = match[1].charAt(0).toLowerCase() + match[1].slice(1);
          }

          if (originalKey) {
            // Reuse live resource from the first query loop if available
            const liveResource = liveResourcesByKey.get(originalKey);
            if (liveResource) {
              resourceKeyMapping.set(originalKey, liveResource);
              this.logger.debug('Reused live resource for CEL mapping', {
                originalKey,
                resourceKind: deployedResource.kind,
                resourceName: deployedResource.name,
              });
            } else if (k8sApi) {
              // Query the cluster directly — the first loop may have missed this resource
              // (e.g., imperative compositions where original resource names are KubernetesRef proxies)
              try {
                const actualResource = await k8sApi.read({
                  apiVersion: deployedResource.manifest.apiVersion,
                  kind: deployedResource.manifest.kind,
                  metadata: {
                    name: deployedResource.name,
                    namespace: deployedResource.namespace || this.namespace || 'default',
                  },
                });
                resourceKeyMapping.set(originalKey, actualResource);
                this.logger.debug('Queried live resource for CEL mapping', {
                  originalKey,
                  resourceKind: deployedResource.kind,
                  resourceName: deployedResource.name,
                });
              } catch (_error) {
                // Fall back to manifest if cluster query fails
                resourceKeyMapping.set(originalKey, deployedResource.manifest);
                this.logger.debug('Fallback to manifest for CEL mapping', {
                  originalKey,
                  reason: 'cluster query failed',
                });
              }
            } else {
              // No K8s client available — use manifest
              resourceKeyMapping.set(originalKey, deployedResource.manifest);
              this.logger.debug('Fallback to manifest for CEL mapping', {
                originalKey,
                reason: 'no k8sApi available',
              });
            }
          }
        }

        this.logger.debug('Resource key mapping created', {
          instanceName,
          mappingSize: resourceKeyMapping.size,
          mappedKeys: Array.from(resourceKeyMapping.keys()),
        });

        const resolutionContext = {
          deployedResources,
          kubeClient: this.factoryOptions.kubeConfig,
          namespace: this.namespace,
          timeout: this.factoryOptions.timeout || 30000,
          resourceKeyMapping,
          schema: { spec, status: {} },
        };

        // Resolve all CEL expressions in the status
        status = (await resolver.resolveReferences(status, resolutionContext)) as TStatus;

        this.logger.debug('Status CEL expressions resolved in direct mode', {
          instanceName,
          statusFields: Object.keys(status),
        });
      } catch (error) {
        this.logger.warn('Failed to resolve CEL expressions in status, using unresolved status', {
          instanceName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return status;
  }

  /**
   * Get the strategy mode - implemented by subclasses
   */
  protected abstract getStrategyMode(): 'direct' | 'kro';

  /**
   * Get API version for Enhanced proxy - can be overridden by subclasses
   */
  protected getApiVersion(): string {
    return 'typekro.io/v1';
  }

  /**
   * Get kind for Enhanced proxy - can be overridden by subclasses
   */
  protected getKind(): string {
    return 'EnhancedResource';
  }
}
