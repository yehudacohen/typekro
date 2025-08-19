/**
 * Alchemy Deployment Strategy
 *
 * This module provides the alchemy deployment strategy that wraps deployments
 * in alchemy resources with individual resource registration.
 */

import { getComponentLogger } from '../../logging/index.js';
import { DependencyGraph } from '../../dependencies/graph.js';
import type { DeploymentResult, FactoryOptions, ResourceGraph } from '../../types/deployment.js';
import type { KroCompatibleType, SchemaDefinition } from '../../types/serialization.js';
import type { KubernetesResource } from '../../types/kubernetes.js';
import type { Scope } from '../../types/serialization.js';
import { BaseDeploymentStrategy, type DeploymentStrategy } from './base-strategy.js';
import { DirectDeploymentStrategy } from './direct-strategy.js';
import { validateAlchemyScope } from '../shared-utilities.js';
import { ensureReadinessEvaluator } from '../../../utils/helpers.js';

/**
 * Alchemy deployment strategy - wraps deployments in alchemy resources with individual resource registration
 *
 * This strategy implements individual resource registration for Direct mode Alchemy integration.
 * Unlike Kro mode which registers RGDs and instances, Direct mode registers each individual
 * Kubernetes resource (Deployment, Service, ConfigMap, etc.) as separate Alchemy resource types.
 *
 * ## Resource Registration Pattern
 *
 * **Direct Mode (this strategy):**
 * - Each individual Kubernetes resource gets its own Alchemy resource type registration
 * - Resource types are named using the pattern `kubernetes::{Kind}` (e.g., `kubernetes::Deployment`)
 * - Each instance of each resource gets a separate Alchemy resource registered
 * - Example: A webapp with Deployment + Service creates 2 Alchemy resource types and 2 resource instances
 *
 * **Kro Mode (for comparison):**
 * - Each RGD gets one Alchemy resource type registered (`kro::ResourceGraphDefinition`)
 * - Each instance of each RGD gets a separate Alchemy resource registered (`kro::{Kind}`)
 * - Example: A webapp RGD creates 1 RGD type + 1 instance type = 2 Alchemy resources total
 *
 * ## Error Handling
 *
 * The strategy implements robust error handling for individual resource failures:
 * - Continues processing remaining resources when individual resources fail
 * - Collects all errors and includes them in the final DeploymentResult
 * - Sets deployment status to 'partial' when some resources succeed and others fail
 * - Provides resource-specific error context including kind, name, namespace, and Alchemy resource type
 *
 * ## Integration with DirectTypeKroDeployer
 *
 * This strategy integrates with DirectTypeKroDeployer for actual resource deployment:
 * - Extracts DirectDeploymentEngine from the base DirectDeploymentStrategy
 * - Creates DirectTypeKroDeployer instance for individual resource deployments
 * - Passes deployer to each Alchemy resource provider for deployment execution
 *
 * @template TSpec - The specification type for the resource
 * @template TStatus - The status type for the resource
 */
export class AlchemyDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  private logger = getComponentLogger('alchemy-deployment-strategy');

  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    private alchemyScope: Scope,
    private baseStrategy: DeploymentStrategy<TSpec, TStatus>
  ) {
    super(factoryName, namespace, schemaDefinition, factoryOptions);
  }

  /**
   * Execute deployment with individual resource registration for Alchemy integration
   *
   * This method implements the core logic for Direct mode Alchemy integration:
   *
   * ## Process Overview
   * 1. **Validation**: Validates the Alchemy scope is available and properly configured
   * 2. **Resource Graph Creation**: Gets the resource graph from the base strategy using createResourceGraphForInstance
   * 3. **Deployer Setup**: Creates DirectTypeKroDeployer instance using DirectDeploymentEngine from base strategy
   * 4. **Individual Registration**: Processes each resource in the resource graph individually for Alchemy registration
   * 5. **Error Collection**: Continues processing remaining resources when individual resources fail
   * 6. **Result Creation**: Creates comprehensive DeploymentResult with individual resource tracking
   *
   * ## Individual Resource Processing
   *
   * For each resource in the resource graph:
   * - **Type Inference**: Infers Alchemy resource type from Kubernetes kind (e.g., `kubernetes::Deployment`)
   * - **Type Registration**: Calls ensureResourceTypeRegistered to register the resource type (shared across instances)
   * - **ID Generation**: Creates unique resource ID using createAlchemyResourceId with namespace and resource info
   * - **Deployment**: Deploys the resource through Alchemy using the resource provider and DirectTypeKroDeployer
   * - **Tracking**: Tracks deployed resource with Alchemy metadata (resource ID, type, etc.)
   *
   * ## Error Handling Strategy
   *
   * The method implements robust error handling:
   * - **Continue on Failure**: Individual resource failures don't stop processing of remaining resources
   * - **Error Collection**: All errors are collected with detailed context about which resource failed
   * - **Resource Context**: Error messages include resource kind, name, namespace, and Alchemy resource type
   * - **Partial Status**: Deployment status is set to 'partial' when some resources succeed and others fail
   *
   * ## Resource Type Naming
   *
   * Resource types follow consistent naming patterns:
   * - **Kubernetes Resources**: `kubernetes::{Kind}` (e.g., `kubernetes::Deployment`, `kubernetes::Service`)
   * - **Shared Types**: Multiple instances of the same resource type share the same Alchemy resource type registration
   * - **Unique IDs**: Each resource instance gets a unique Alchemy resource ID for individual tracking
   *
   * @param spec - The resource specification to deploy
   * @param instanceName - The name of this specific instance
   * @returns Promise<DeploymentResult> - Comprehensive deployment result with individual resource tracking
   * @throws Error - If Alchemy scope validation fails or critical deployment errors occur
   */
  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<DeploymentResult> {
    try {
      // Validate alchemy scope is available and properly configured
      validateAlchemyScope(this.alchemyScope, 'Alchemy deployment');

      // Use static imports for registration functions
      const { ensureResourceTypeRegistered, createAlchemyResourceId } = await import(
        '../../../alchemy/deployment.js'
      );

      // Get resource graph from base strategy using createResourceGraphForInstance
      // This provides the individual Kubernetes resources that need to be registered with Alchemy
      this.logger.info('About to create resource graph for instance', {
        instanceName,
        hasBaseStrategy: !!this.baseStrategy,
        baseStrategyType: this.baseStrategy?.constructor?.name,
      });

      const resourceGraph = this.createResourceGraphForInstance(spec, instanceName);

      this.logger.info('Resource graph created', {
        resourceCount: resourceGraph.resources.length,
        graphName: resourceGraph.name,
      });

      // No need to create deployer here - it will be created inside the Alchemy resource handler

      // Process each resource in the resource graph individually for Alchemy registration
      const deployedResources: Array<{
        id: string;
        kind: string;
        name: string;
        namespace: string;
        manifest: KubernetesResource;
        status: 'deployed' | 'ready' | 'failed';
        deployedAt: Date;
        alchemyResourceId: string;
        alchemyResourceType: string;
        error?: Error;
      }> = [];
      const errors: Array<{
        resourceId: string;
        error: Error;
        phase: 'deployment';
        timestamp: Date;
        resourceKind: string;
        resourceName: string;
        alchemyResourceType: string;
        namespace: string;
      }> = [];
      const startTime = Date.now();

      this.logger.info('Processing resource graph for alchemy deployment', {
        resourceCount: resourceGraph.resources.length,
        resourceIds: resourceGraph.resources.map((r) => r.id),
        resourceKinds: resourceGraph.resources.map((r) => r.manifest.kind),
      });

      // Continue processing remaining resources when individual resources fail
      for (const resource of resourceGraph.resources) {
        try {
          this.logger.info('Processing resource for alchemy deployment', {
            resourceId: resource.id,
            resourceKind: resource.manifest.kind,
            resourceName: resource.manifest.metadata?.name,
            hasReadinessEvaluator: 'readinessEvaluator' in resource.manifest,
          });

          const resourceWithEvaluator = ensureReadinessEvaluator(resource.manifest);

          // Register resource type dynamically (shared across instances)
          const ResourceProvider = ensureResourceTypeRegistered(resourceWithEvaluator);

          // Create unique resource ID for this instance
          const resourceId = createAlchemyResourceId(resourceWithEvaluator, this.namespace);

          // Deploy individual resource through Alchemy within the scope
          await this.alchemyScope.run(async () => {
            try {
              // Extract serializable kubeConfig options
              const kubeConfigOptions = this.extractKubeConfigOptions();

              // Create the resource through Alchemy
              const _alchemyResource = await ResourceProvider(resourceId, {
                resource: resourceWithEvaluator,
                namespace: this.namespace,
                deploymentStrategy: 'direct' as const,
                kubeConfigOptions,
                options: {
                  waitForReady: this.factoryOptions.waitForReady ?? true,
                  timeout: this.factoryOptions.timeout ?? 300000,
                },
              });

              // Track the deployed resource
              deployedResources.push({
                id: resource.id,
                kind: resource.manifest.kind || 'Unknown',
                name: resource.manifest.metadata?.name || 'unnamed',
                namespace: this.namespace,
                manifest: resource.manifest,
                status: 'deployed' as const,
                deployedAt: new Date(),
                alchemyResourceId: resourceId,
                alchemyResourceType: ResourceProvider.name || 'unknown',
              });

              this.logger.debug('Successfully deployed resource through Alchemy', {
                resourceKind: resource.manifest.kind,
                resourceName: resource.manifest.metadata?.name,
                alchemyResourceId: resourceId,
                alchemyResourceType: ResourceProvider.name,
              });
            } catch (deployError) {
              const error = deployError as Error;
              this.logger.error('Failed to deploy individual resource through Alchemy', error, {
                resourceKind: resource.manifest.kind,
                resourceName: resource.manifest.metadata?.name,
                resourceId: resource.id,
                namespace: this.namespace,
              });

              // Collect error but continue processing other resources
              errors.push({
                resourceId: resource.id,
                error,
                phase: 'deployment',
                timestamp: new Date(),
                resourceKind: resource.manifest.kind || 'Unknown',
                resourceName: resource.manifest.metadata?.name || 'unnamed',
                alchemyResourceType: ResourceProvider.name || 'unknown',
                namespace: this.namespace,
              });
            }
          });
        } catch (registrationError) {
          const error = registrationError as Error;
          this.logger.error('Failed to register resource type with Alchemy', error, {
            resourceKind: resource.manifest.kind,
            resourceName: resource.manifest.metadata?.name,
            resourceId: resource.id,
          });

          // Collect error but continue processing other resources
          errors.push({
            resourceId: resource.id,
            error,
            phase: 'deployment',
            timestamp: new Date(),
            resourceKind: resource.manifest.kind || 'Unknown',
            resourceName: resource.manifest.metadata?.name || 'unnamed',
            alchemyResourceType: 'registration-failed',
            namespace: this.namespace,
          });
        }
      }

      // Create comprehensive deployment result
      const duration = Date.now() - startTime;
      const hasErrors = errors.length > 0;
      const hasSuccesses = deployedResources.length > 0;

      let status: 'success' | 'failed' | 'partial';
      if (hasSuccesses && !hasErrors) {
        status = 'success';
      } else if (!hasSuccesses && hasErrors) {
        status = 'failed';
      } else {
        status = 'partial';
      }

      this.logger.info('Alchemy deployment completed', {
        status,
        successfulResources: deployedResources.length,
        failedResources: errors.length,
        totalResources: resourceGraph.resources.length,
        duration,
      });

      return {
        status,
        deploymentId: `alchemy-${instanceName}-${Date.now()}`,
        resources: deployedResources,
        dependencyGraph: resourceGraph.dependencyGraph,
        duration,
        errors: errors.map((e) => ({
          resourceId: e.resourceId,
          error: e.error,
          phase: e.phase,
          timestamp: e.timestamp,
        })),
      };
    } catch (error) {
      this.logger.error('Alchemy deployment strategy failed', error as Error);
      throw error;
    }
  }

  protected getStrategyMode(): 'direct' | 'kro' {
    return 'direct'; // Alchemy strategy uses direct mode for individual resource registration
  }

  /**
   * Create resource graph for instance using base strategy logic
   */
  private createResourceGraphForInstance(spec: TSpec, instanceName: string): ResourceGraph {
    // Delegate to the base strategy's resource resolution logic
    if (this.baseStrategy instanceof DirectDeploymentStrategy) {
      const baseStrategy = this.baseStrategy as DirectDeploymentStrategy<TSpec, TStatus>;
      if (
        baseStrategy.resourceResolver &&
        typeof baseStrategy.resourceResolver.createResourceGraphForInstance === 'function'
      ) {
        this.logger.info('Calling createResourceGraphForInstance on resource resolver', {
          hasResourceResolver: !!baseStrategy.resourceResolver,
          resolverType: baseStrategy.resourceResolver.constructor?.name,
        });

        const resourceGraph = baseStrategy.resourceResolver.createResourceGraphForInstance(spec);
        this.logger.info('Created resource graph from base strategy', {
          resourceCount: resourceGraph.resources.length,
          resourceIds: resourceGraph.resources.map((r) => r.id),
          resourceKinds: resourceGraph.resources.map((r) => r.manifest?.kind),
        });
        return resourceGraph;
      } else {
        this.logger.warn(
          'Base strategy does not have resourceResolver or createResourceGraphForInstance method',
          {
            hasResourceResolver: !!baseStrategy.resourceResolver,
            resolverType: baseStrategy.resourceResolver?.constructor?.name,
            hasMethod: baseStrategy.resourceResolver
              ? typeof baseStrategy.resourceResolver.createResourceGraphForInstance
              : 'no resolver',
          }
        );
      }
    } else {
      this.logger.warn('Base strategy is not DirectDeploymentStrategy', {
        baseStrategyType: this.baseStrategy?.constructor?.name,
      });
    }

    // Fallback implementation - this should not happen in normal operation
    this.logger.error(
      'Falling back to empty resource graph - this indicates a configuration issue'
    );
    return {
      name: instanceName,
      resources: [],
      dependencyGraph: new DependencyGraph(),
    };
  }

  /**
   * Extract serializable kubeConfig options from factory options
   */
  private extractKubeConfigOptions(): Record<string, unknown> {
    let kubeConfigOptions: Record<string, unknown> = {};

    if (this.factoryOptions.kubeConfig) {
      const kc = this.factoryOptions.kubeConfig;
      const cluster = kc.getCurrentCluster();
      const user = kc.getCurrentUser();
      const context = kc.getCurrentContext();

      this.logger.debug('Extracting kubeconfig options for alchemy', {
        hasCluster: !!cluster,
        clusterSkipTLS: cluster?.skipTLSVerify,
        clusterServer: cluster?.server,
        hasUser: !!user,
        context,
      });

      // SECURITY: Prioritize user's explicit skipTLSVerify choice over cluster config
      const userSkipTLS = this.factoryOptions.skipTLSVerify;
      const clusterSkipTLS = cluster?.skipTLSVerify;
      const finalSkipTLS = userSkipTLS === true ? true : (clusterSkipTLS ?? false);

      // Log security warning when TLS is disabled
      if (finalSkipTLS) {
        this.logger.warn(
          'TLS verification disabled - this is insecure and should only be used in development',
          {
            component: 'alchemy-deployment-strategy',
            security: 'tls-disabled',
            userExplicit: userSkipTLS === true,
            fromClusterConfig: clusterSkipTLS === true,
            server: cluster?.server,
            recommendation:
              userSkipTLS === true
                ? 'Remove skipTLSVerify: true from factory options for production'
                : 'Update cluster configuration to enable TLS verification',
          }
        );
      }

      kubeConfigOptions = {
        skipTLSVerify: finalSkipTLS,
        ...(cluster?.server && { server: cluster.server }),
        ...(context && { context }),
        // Include complete cluster configuration
        ...(cluster && {
          cluster: {
            name: cluster.name,
            server: cluster.server,
            skipTLSVerify: finalSkipTLS,
            ...(cluster.caData && { caData: cluster.caData }),
            ...(cluster.caFile && { caFile: cluster.caFile }),
          },
        }),
        // Include complete user configuration
        ...(user && {
          user: {
            name: user.name,
            ...(user.token && { token: user.token }),
            ...(user.certData && { certData: user.certData }),
            ...(user.certFile && { certFile: user.certFile }),
            ...(user.keyData && { keyData: user.keyData }),
            ...(user.keyFile && { keyFile: user.keyFile }),
          },
        }),
      };

      this.logger.debug('Extracted kubeconfig options', {
        kubeConfigOptions: JSON.stringify(kubeConfigOptions, null, 2),
      });
    } else {
      // Try extracting from the base strategy's factory options (common in tests)
      try {
        if (this.baseStrategy instanceof DirectDeploymentStrategy) {
          const bs = this.baseStrategy as DirectDeploymentStrategy<TSpec, TStatus> & {
            factoryOptions?: FactoryOptions;
          };
          const baseFactoryOptions = bs?.factoryOptions as FactoryOptions | undefined;
          const baseKc = baseFactoryOptions?.kubeConfig as
            | import('@kubernetes/client-node').KubeConfig
            | undefined;
          const cluster = baseKc?.getCurrentCluster();
          const user = baseKc?.getCurrentUser();
          const context = baseKc?.getCurrentContext();

          this.logger.debug('Extracting kubeconfig options from base strategy for alchemy', {
            hasBaseFactoryOptions: !!baseFactoryOptions,
            hasBaseKubeConfig: !!baseKc,
            hasCluster: !!cluster,
            clusterSkipTLS: cluster?.skipTLSVerify,
            clusterServer: cluster?.server,
            hasUser: !!user,
            context,
          });

          if (baseKc && cluster) {
            // SECURITY: Prioritize user's explicit skipTLSVerify choice over cluster config
            const userSkipTLS = this.factoryOptions.skipTLSVerify;
            const clusterSkipTLS = cluster.skipTLSVerify;
            const finalSkipTLS = userSkipTLS === true ? true : (clusterSkipTLS ?? false);

            // Log security warning when TLS is disabled
            if (finalSkipTLS) {
              this.logger.warn(
                'TLS verification disabled - this is insecure and should only be used in development',
                {
                  component: 'alchemy-deployment-strategy',
                  security: 'tls-disabled',
                  userExplicit: userSkipTLS === true,
                  fromClusterConfig: clusterSkipTLS === true,
                  server: cluster?.server,
                  recommendation:
                    userSkipTLS === true
                      ? 'Remove skipTLSVerify: true from factory options for production'
                      : 'Update cluster configuration to enable TLS verification',
                }
              );
            }

            kubeConfigOptions = {
              skipTLSVerify: finalSkipTLS,
              ...(cluster.server && { server: cluster.server }),
              ...(context && { context }),
              cluster: {
                name: cluster.name,
                server: cluster.server,
                skipTLSVerify: finalSkipTLS,
                ...(cluster.caData && { caData: cluster.caData }),
                ...(cluster.caFile && { caFile: cluster.caFile }),
              },
              ...(user && {
                user: {
                  name: user.name,
                  ...(user.token && { token: user.token }),
                  ...(user.certData && { certData: user.certData }),
                  ...(user.certFile && { certFile: user.certFile }),
                  ...(user.keyData && { keyData: user.keyData }),
                  ...(user.keyFile && { keyFile: user.keyFile }),
                },
              }),
            };

            this.logger.debug('Extracted kubeconfig options from base strategy', {
              kubeConfigOptions: JSON.stringify(kubeConfigOptions, null, 2),
            });
          }
        }
      } catch (extractionError) {
        this.logger.debug('Could not extract kubeconfig from base strategy, using default', {
          error: (extractionError as Error).message,
        });
      }
    }

    return kubeConfigOptions;
  }
}
