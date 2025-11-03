/**
 * Direct Deployment Strategy
 *
 * This module provides the direct deployment strategy that deploys
 * individual Kubernetes resources directly to the cluster.
 */

import type {
  DeployedResource,
  DeploymentContext,
  DeploymentResult,
  FactoryOptions,
  ResourceGraph,
} from '../../types/deployment.js';
import { ResourceDeploymentError } from '../../types/deployment.js';
import type { KubernetesResource } from '../../types/kubernetes.js';
import type {
  KroCompatibleType,
  SchemaDefinition,
  StatusBuilder,
} from '../../types/serialization.js';
import type { Enhanced } from '../../types/index.js';
import type { DirectDeploymentEngine } from '../engine.js';
import { createDeploymentOptions, handleDeploymentError } from '../shared-utilities.js';
import { BaseDeploymentStrategy } from './base-strategy.js';

/**
 * Direct deployment strategy - deploys individual Kubernetes resources
 */
export class DirectDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    statusBuilder: StatusBuilder<TSpec, TStatus, any> | undefined,
    resourceKeys: Record<string, KubernetesResource> | undefined,
    factoryOptions: FactoryOptions,
    private deploymentEngine: DirectDeploymentEngine,
    public resourceResolver: { 
      createResourceGraphForInstance(spec: TSpec): ResourceGraph;
      getReExecutedStatus?(): TStatus | null;
    } // Resource resolution logic
  ) {
    super(factoryName, namespace, schemaDefinition, statusBuilder, resourceKeys, factoryOptions);
  }

  protected async executeDeployment(spec: TSpec, _instanceName: string): Promise<DeploymentResult> {
    try {
      // Create resource graph for this instance
      const resourceGraph = this.resourceResolver.createResourceGraphForInstance(spec);

      // Create deployment options
      const deploymentOptions = createDeploymentOptions(
        this.factoryOptions,
        this.namespace,
        'direct'
      );

      // Pass closures to deployment engine for level-based execution
      const closures = this.factoryOptions.closures || {};

      // Deploy using the direct deployment engine with closures if available, otherwise use regular deploy
      let deploymentResult: DeploymentResult;
      if (Object.keys(closures).length > 0 && 'deployWithClosures' in this.deploymentEngine) {
        // Type assertion is safe here because we've checked that the method exists
        const engineWithClosures = this.deploymentEngine as DirectDeploymentEngine & {
          deployWithClosures<TSpec>(
            graph: ResourceGraph,
            closures: Record<string, unknown>,
            options: Parameters<DirectDeploymentEngine['deploy']>[1],
            spec: TSpec,
            alchemyScope?: unknown
          ): Promise<DeploymentResult>;
        };
        deploymentResult = await engineWithClosures.deployWithClosures(
          resourceGraph,
          closures,
          deploymentOptions,
          spec,
          this.factoryOptions.alchemyScope
        );
      } else {
        // Fallback to regular deployment for backward compatibility
        deploymentResult = await this.deploymentEngine.deploy(resourceGraph, deploymentOptions);
      }

      if (deploymentResult.status === 'failed') {
        const firstError = deploymentResult.errors[0]?.error;
        const deploymentError = new ResourceDeploymentError(
          'resource-graph',
          'ResourceGraph',
          firstError || new Error('Unknown deployment error')
        );
        // Add additional context from all errors
        if (deploymentResult.errors.length > 1) {
          deploymentError.message += ` (and ${deploymentResult.errors.length - 1} other errors)`;
        }
        throw deploymentError;
      }

      return deploymentResult;
    } catch (error) {
      handleDeploymentError(error, 'Direct deployment failed');
    }
  }

  /**
   * Override Enhanced proxy creation to use re-executed status when available
   */
  protected async createEnhancedProxy(
    spec: TSpec,
    instanceName: string,
    deploymentResult: DeploymentResult
  ): Promise<Enhanced<TSpec, TStatus>> {
    // Check if we have re-executed status from composition re-execution
    const reExecutedStatus = this.resourceResolver.getReExecutedStatus?.();
    
    if (reExecutedStatus) {
      this.logger.debug('Using hybrid status approach (re-executed + base strategy)', {
        instanceName,
        reExecutedStatusFields: Object.keys(reExecutedStatus),
      });

      // Get the base proxy which includes CEL expression resolution
      const baseProxy = await super.createEnhancedProxy(spec, instanceName, deploymentResult);
      
      // Import the CEL expression utility
      const { isCelExpression } = require('../../../utils/type-guards.js');
      
      // Merge re-executed status with base status
      // Priority: resolved spec-based values from re-execution > evaluated CEL expressions from base
      const hybridStatus = { ...baseProxy.status };
      
      for (const [key, value] of Object.entries(reExecutedStatus)) {
        const baseValue = (baseProxy.status as any)[key];
        const reExecutedValue = value;
        
        // If the re-executed value is not a CEL expression, it's a resolved spec-based value - use it
        if (!isCelExpression(reExecutedValue)) {
          (hybridStatus as any)[key] = reExecutedValue;
          this.logger.debug('Using re-executed value for spec-based field', {
            field: key,
            value: reExecutedValue,
            type: typeof reExecutedValue,
          });
        } else {
          // Re-executed value is a CEL expression - let the base strategy handle it
          // The base strategy will have already evaluated it if possible
          (hybridStatus as any)[key] = baseValue;
          this.logger.debug('Using base strategy value for CEL expression field', {
            field: key,
            baseValue,
            baseValueType: typeof baseValue,
            isCelExpression: isCelExpression(baseValue),
          });
        }
      }

      return {
        ...baseProxy,
        status: hybridStatus,
      } as Enhanced<TSpec, TStatus>;
    }

    // Fallback to base implementation if no re-executed status
    return super.createEnhancedProxy(spec, instanceName, deploymentResult);
  }

  /**
   * Create deployment context for closure execution
   */
  public createDeploymentContext(
    deployedResources: Map<string, DeployedResource>,
    _spec: TSpec
  ): DeploymentContext {
    // Get Kubernetes API from deployment engine
    const kubernetesApi = this.deploymentEngine.getKubernetesApi();

    // Create reference resolver function
    const resolveReference = async (ref: unknown): Promise<unknown> => {
      // This would integrate with the existing reference resolution system
      // For now, return a placeholder - this will be enhanced in future tasks
      return ref;
    };

    return {
      kubernetesApi,
      ...(this.factoryOptions.alchemyScope && { alchemyScope: this.factoryOptions.alchemyScope }),
      ...(this.namespace && { namespace: this.namespace }),
      deployedResources,
      resolveReference,
    };
  }

  protected getStrategyMode(): 'direct' | 'kro' {
    return 'direct';
  }
}
