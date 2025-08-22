/**
 * Base Deployment Strategy
 *
 * This module provides the abstract base class for deployment strategies
 * with common template method pattern implementation.
 */

import type { DeploymentResult, FactoryOptions } from '../../types/deployment.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../../types/serialization.js';
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
  constructor(
    protected factoryName: string,
    protected namespace: string,
    protected schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    protected factoryOptions: FactoryOptions
  ) {}

  /**
   * Template method for deployment - defines the common flow
   */
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // Step 1: Validate spec (common to all strategies)
    validateSpec(spec, this.schemaDefinition);

    // Step 2: Generate instance name (common to all strategies)
    const instanceName = generateInstanceName(spec);

    // Step 3: Execute strategy-specific deployment
    const deploymentResult = await this.executeDeployment(spec, instanceName);

    // Step 4: Create Enhanced proxy (common to all strategies)
    return this.createEnhancedProxy(spec, instanceName, deploymentResult);
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
  protected createEnhancedProxy(
    spec: TSpec,
    instanceName: string,
    deploymentResult: DeploymentResult
  ): Enhanced<TSpec, TStatus> {
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

    // Extract status from deployment result if available
    let status: TStatus = {} as TStatus;
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
