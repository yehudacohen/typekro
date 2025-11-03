/**
 * Base Deployment Strategy
 *
 * This module provides the abstract base class for deployment strategies
 * with common template method pattern implementation.
 */

import * as k8s from '@kubernetes/client-node';
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

    // Add deployment status to metadata for factory-level error handling
    if (deploymentResult?.status) {
      metadata.annotations = metadata.annotations || {};
      metadata.annotations['typekro.io/deployment-status'] = deploymentResult.status;

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
      try {
        // Create enhanced resources for the status builder using original resource keys
        const enhancedResources: Record<string, Enhanced<unknown, unknown>> = {};

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

          // Map original resource keys to deployed resources by matching kind and name
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

              try {
                // Query the cluster for the actual resource with current status
                const resourceRef: k8s.KubernetesObject = {
                  apiVersion: deployedResource.manifest.apiVersion,
                  kind: deployedResource.manifest.kind,
                  metadata: {
                    name: deployedResource.manifest.metadata?.name,
                    namespace:
                      deployedResource.manifest.metadata?.namespace || this.namespace || 'default',
                  } as k8s.V1ObjectMeta,
                };

                const k8sApi = this.factoryOptions.kubeConfig?.makeApiClient(
                  k8s.KubernetesObjectApi
                );
                if (k8sApi && resourceRef.metadata) {
                  const response = await k8sApi.read({
                    metadata: {
                      name: resourceRef.metadata.name,
                      namespace: resourceRef.metadata.namespace || this.namespace,
                    },
                  } as { metadata: { name: string; namespace: string } });
                  actualResource = response.body as KubernetesResource<unknown, unknown>;
                }
              } catch (_error) {
                // Ignore CEL evaluation errors during status hydration
              }

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
            enhancedResourcesWithStatus: Object.entries(enhancedResources).map(
              ([key, resource]) => ({
                key,
                hasStatus: !!resource.status && Object.keys(resource.status).length > 0,
                statusKeys: resource.status ? Object.keys(resource.status) : [],
              })
            ),
          });
        }

        // Create a schema proxy for the status builder
        const schemaProxy = {
          spec,
          status: {} as TStatus, // Empty status for the schema proxy
        };

        // Call the status builder to get the computed status
        // Wrap enhanced resources with proxy to enable resource reference magic
        const resourcesProxy = createResourcesProxy(enhancedResources);
        const computedStatus = this.statusBuilder(
          schemaProxy as SchemaProxy<TSpec, TStatus>,
          resourcesProxy
        );
        status = computedStatus as TStatus;

        this.logger.debug('Status built using status builder', {
          instanceName,
          statusFields: Object.keys(status),
        });

        // In direct mode, resolve CEL expressions in the status against deployed resources
        if (this.getStrategyMode() === 'direct' && this.factoryOptions.kubeConfig) {
          try {
            const { ReferenceResolver } = await import('../../references/resolver.js');
            const resolver = new ReferenceResolver(this.factoryOptions.kubeConfig, 'direct');

            // Create resolution context with deployed resources
            const deployedResources = deploymentResult?.resources || [];

            this.logger.debug('Available deployed resources for CEL resolution', {
              instanceName,
              hasDeploymentResult: !!deploymentResult,
              resourceCount: deployedResources.length,
              resourceIds: deployedResources.map((r) => r.id),
              resourceNames: deployedResources.map((r) => r.name),
              resourceKinds: deployedResources.map((r) => r.kind),
            });

            // Create a mapping from original resource keys to deployed resources
            // The deployed resource IDs follow the pattern: {camelCaseInstanceName}Resource{index}{PascalCaseOriginalKey}
            // We need to extract the original key and map it back
            const resourceKeyMapping = new Map<string, unknown>();

            // Convert instance name to camelCase for pattern matching
            const camelCaseInstanceName = instanceName.replace(/-([a-z])/g, (_, letter) =>
              letter.toUpperCase()
            );

            // Query the actual resources from the cluster to get their current status
            const k8sApi = this.factoryOptions.kubeConfig?.makeApiClient(
              require('@kubernetes/client-node').KubernetesObjectApi
            );

            for (const deployedResource of deployedResources) {
              // Extract the original resource key from the deployed resource ID
              // Pattern: {camelCaseInstanceName}Resource{index}{PascalCaseOriginalKey} -> originalKey
              const resourceIdPattern = new RegExp(`^${camelCaseInstanceName}Resource\\d+(.+)$`);
              const match = deployedResource.id.match(resourceIdPattern);

              this.logger.debug('Processing deployed resource for CEL mapping', {
                instanceName,
                camelCaseInstanceName,
                deployedResourceId: deployedResource.id,
                resourceIdPattern: resourceIdPattern.source,
                match: match,
                matchedGroup: match?.[1],
              });

              if (match?.[1]) {
                // Convert from PascalCase to camelCase (e.g., "Webapp" -> "webapp")
                const originalKey = match[1].charAt(0).toLowerCase() + match[1].slice(1);

                this.logger.debug('Extracted original key from resource ID', {
                  instanceName,
                  deployedResourceId: deployedResource.id,
                  extractedKey: originalKey,
                });

                try {
                  // Query the actual resource from the cluster to get its current status
                  const resourceRef = {
                    apiVersion: deployedResource.manifest.apiVersion,
                    kind: deployedResource.manifest.kind,
                    metadata: {
                      name: deployedResource.name,
                      namespace: deployedResource.namespace,
                    },
                  };

                  const response = await (
                    k8sApi as { read?: (ref: unknown) => Promise<{ body: unknown }> }
                  )?.read?.(resourceRef);
                  const actualResource = response?.body;

                  if (actualResource) {
                    resourceKeyMapping.set(originalKey, actualResource);
                    this.logger.debug('Mapped resource key with cluster status', {
                      instanceName,
                      originalKey,
                      resourceKind: deployedResource.kind,
                      resourceName: deployedResource.name,
                      hasStatus: !!(actualResource as { status?: unknown }).status,
                      statusKeys: (actualResource as { status?: unknown }).status
                        ? Object.keys((actualResource as { status?: unknown }).status as object)
                        : [],
                    });
                  } else {
                    // Fallback to manifest if cluster query fails
                    resourceKeyMapping.set(originalKey, deployedResource.manifest);
                    this.logger.debug('Fallback to manifest for resource key', {
                      originalKey,
                      reason: 'cluster query returned no resource',
                    });
                  }
                } catch (error) {
                  // Fallback to manifest if cluster query fails
                  resourceKeyMapping.set(originalKey, deployedResource.manifest);
                  this.logger.debug('Fallback to manifest for resource key', {
                    originalKey,
                    reason: 'cluster query failed',
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              } else {
                this.logger.debug('Failed to match resource ID pattern', {
                  deployedResourceId: deployedResource.id,
                  pattern: `^${camelCaseInstanceName}Resource\\d+(.+)$`,
                  camelCaseInstanceName,
                });
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
            this.logger.warn(
              'Failed to resolve CEL expressions in status, using unresolved status',
              {
                instanceName,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          'Failed to build status using status builder, falling back to resource extraction',
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
