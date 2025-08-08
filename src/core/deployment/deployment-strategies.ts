/**
 * Deployment Strategies
 * 
 * This module provides a strategy pattern for different deployment modes,
 * consolidating the common deployment orchestration logic.
 */

import { getComponentLogger } from '../logging/index.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { DeploymentResult, FactoryOptions } from '../types/deployment.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';
import type { Scope } from '../types/serialization.js';
import {
  validateSpec,
  createDeploymentOptions,
  generateInstanceName,
  createEnhancedMetadata,
  handleDeploymentError,
  validateAlchemyScope,
  createAlchemyDeploymentOptions,
} from './shared-utilities.js';

/**
 * Base deployment strategy interface
 */
export interface DeploymentStrategy<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType> {
  deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>>;
}

/**
 * Abstract base class for deployment strategies
 */
export abstract class BaseDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType
> implements DeploymentStrategy<TSpec, TStatus> {
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
  ): Promise<DeploymentResult | any>;

  /**
   * Create Enhanced proxy - common logic with strategy-specific customization
   */
  protected createEnhancedProxy(
    spec: TSpec,
    instanceName: string,
    deploymentResult: any
  ): Enhanced<TSpec, TStatus> {
    const metadata = createEnhancedMetadata(
      instanceName,
      this.namespace,
      this.factoryName,
      this.getStrategyMode()
    );

    // Extract status from deployment result if available
    let status: TStatus = {} as TStatus;
    if (deploymentResult && 'resources' in deploymentResult && deploymentResult.resources.length > 0) {
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

/**
 * Direct deployment strategy - deploys individual Kubernetes resources
 */
export class DirectDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    private deploymentEngine: any, // DirectDeploymentEngine
    private resourceResolver: any   // Resource resolution logic
  ) {
    super(factoryName, namespace, schemaDefinition, factoryOptions);
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

      // Deploy using the direct deployment engine
      const deploymentResult = await this.deploymentEngine.deploy(resourceGraph, deploymentOptions);

      if (deploymentResult.status === 'failed') {
        throw new Error(`Deployment failed: ${deploymentResult.errors.map((e: any) => e.error.message).join(', ')}`);
      }

      return deploymentResult;
    } catch (error) {
      handleDeploymentError(error, 'Direct deployment failed');
    }
  }

  protected getStrategyMode(): 'direct' | 'kro' {
    return 'direct';
  }
}

/**
 * Kro deployment strategy - deploys via ResourceGraphDefinitions
 */
export class KroDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    private kroEngine: any,        // KroDeploymentEngine
    private rgdManager: any        // RGD management logic
  ) {
    super(factoryName, namespace, schemaDefinition, factoryOptions);
  }

  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<any> {
    try {
      // Ensure RGD is deployed first
      await this.rgdManager.ensureRGDDeployed();

      // Create custom resource instance
      const customResource = this.rgdManager.createCustomResourceInstance(instanceName, spec);

      // Deploy the custom resource
      const deploymentResult = await this.kroEngine.deployResource(customResource, {
        namespace: this.namespace,
        waitForReady: this.factoryOptions.waitForReady ?? true,
        timeout: this.factoryOptions.timeout ?? 300000,
      });

      return deploymentResult;
    } catch (error) {
      handleDeploymentError(error, 'Kro deployment failed');
    }
  }

  protected getStrategyMode(): 'direct' | 'kro' {
    return 'kro';
  }

  protected getApiVersion(): string {
    // For Kro instances, use the schema definition API version
    return this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion
      : `kro.run/${this.schemaDefinition.apiVersion}`;
  }

  protected getKind(): string {
    return this.schemaDefinition.kind;
  }
}

/**
 * Alchemy deployment strategy - wraps deployments in alchemy resources
 */
export class AlchemyDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType
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

  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<any> {
    try {
      // Validate alchemy scope
      validateAlchemyScope(this.alchemyScope, 'Alchemy deployment');

      // Import dynamic registration functions
      const { ensureResourceTypeRegistered, createAlchemyResourceId } = await import('../../alchemy/deployment.js');

      // Create alchemy deployment options
      const _alchemyOptions = createAlchemyDeploymentOptions(this.factoryOptions, this.namespace);

      // TODO: Implement alchemy deployment using imported functions
      this.logger.info('Alchemy deployment not yet implemented', { 
        ensureResourceTypeRegistered: !!ensureResourceTypeRegistered, 
        createAlchemyResourceId: !!createAlchemyResourceId 
      });

      // Execute base strategy deployment through alchemy
      // This is where we would integrate with the alchemy resource system
      // For now, delegate to the base strategy
      return await this.baseStrategy.deploy(spec);
    } catch (error) {
      handleDeploymentError(error, 'Alchemy deployment failed');
    }
  }

  protected getStrategyMode(): 'direct' | 'kro' {
    // Alchemy wraps other strategies, so delegate to base strategy
    if (this.baseStrategy instanceof DirectDeploymentStrategy) {
      return 'direct';
    } else if (this.baseStrategy instanceof KroDeploymentStrategy) {
      return 'kro';
    }
    return 'direct'; // fallback
  }
}

/**
 * Factory for creating deployment strategies
 */
export class DeploymentStrategyFactory {
  static createStrategy<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
    mode: 'direct' | 'kro',
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    dependencies: {
      deploymentEngine?: any;
      resourceResolver?: any;
      kroEngine?: any;
      rgdManager?: any;
    }
  ): DeploymentStrategy<TSpec, TStatus> {
    switch (mode) {
      case 'direct':
        if (!dependencies.deploymentEngine || !dependencies.resourceResolver) {
          throw new Error('DirectDeploymentStrategy requires deploymentEngine and resourceResolver');
        }
        return new DirectDeploymentStrategy(
          factoryName,
          namespace,
          schemaDefinition,
          factoryOptions,
          dependencies.deploymentEngine,
          dependencies.resourceResolver
        );

      case 'kro':
        if (!dependencies.kroEngine || !dependencies.rgdManager) {
          throw new Error('KroDeploymentStrategy requires kroEngine and rgdManager');
        }
        return new KroDeploymentStrategy(
          factoryName,
          namespace,
          schemaDefinition,
          factoryOptions,
          dependencies.kroEngine,
          dependencies.rgdManager
        );

      default:
        throw new Error(`Unsupported deployment mode: ${mode}`);
    }
  }

  static wrapWithAlchemy<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
    baseStrategy: DeploymentStrategy<TSpec, TStatus>,
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    alchemyScope: Scope
  ): DeploymentStrategy<TSpec, TStatus> {
    return new AlchemyDeploymentStrategy(
      factoryName,
      namespace,
      schemaDefinition,
      factoryOptions,
      alchemyScope,
      baseStrategy
    );
  }
}