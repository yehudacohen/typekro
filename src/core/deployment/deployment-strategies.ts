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
import type { DirectDeploymentEngine } from './engine.js';
import { ensureResourceTypeRegistered, createAlchemyResourceId } from '../../alchemy/deployment.js';
import { resourceGraphDefinition } from '../../factories/kro/resource-graph-definition.js';
import { kroCustomResource } from '../../factories/kro/kro-custom-resource.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';

import {
  validateSpec,
  createDeploymentOptions,
  generateInstanceName,
  createEnhancedMetadata,
  handleDeploymentError,
  validateAlchemyScope,
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
  ) { }

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
    private deploymentEngine: DirectDeploymentEngine,
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
        throw new Error(`Deployment failed: ${deploymentResult.errors.map((e) => e.error.message).join(', ')}`);
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
    private directEngine: DirectDeploymentEngine,
    private resources: Record<string, any> = {},
    private statusMappings: any = {}
  ) {
    super(factoryName, namespace, schemaDefinition, factoryOptions);
  }

  protected async executeDeployment(spec: TSpec, instanceName: string): Promise<DeploymentResult> {
    try {
      const logger = getComponentLogger('kro-deployment-strategy');

      // Step 1: Deploy ResourceGraphDefinition
      await this.deployResourceGraphDefinition();

      // Step 2: Deploy Custom Resource instance
      const customResourceResult = await this.deployCustomResourceInstance(spec, instanceName);

      logger.debug('Kro two-step deployment completed successfully', {
        factoryName: this.factoryName,
        instanceName,
        namespace: this.namespace
      });

      return {
        status: 'success',
        deploymentId: `kro-${instanceName}-${Date.now()}`,
        resources: [customResourceResult],
        dependencyGraph: {}, // Empty for now since we handle dependencies internally
        duration: 0, // Will be calculated by the base class
        errors: [],
      };
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

  /**
   * Step 1: Deploy ResourceGraphDefinition using DirectDeploymentEngine
   */
  private async deployResourceGraphDefinition(): Promise<void> {
    const logger = getComponentLogger('kro-deployment-strategy');
    const rgdName = this.convertToKubernetesName(this.factoryName);

    // Generate Kro schema from the factory's schema definition and resources
    const kroSchema = generateKroSchemaFromArktype(
      this.factoryName,
      this.schemaDefinition,
      this.resources || {},
      this.statusMappings || {}
    );

    // Create RGD manifest
    const rgdManifest = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: {
        name: rgdName,
        namespace: this.namespace,
      },
      spec: {
        schema: kroSchema,
        resources: Object.values(this.resources || {}).map(resource => ({
          id: resource.id || resource.metadata?.name || 'unknown',
          template: resource,
        })),
      },
    };

    // Wrap with resourceGraphDefinition factory to get Enhanced object with readiness evaluation
    const enhancedRGD = resourceGraphDefinition(rgdManifest);

    // Create deployable resource
    const deployableRGD = {
      ...enhancedRGD,
      id: rgdName,
    };

    // Deploy using DirectDeploymentEngine with KRO mode
    await this.directEngine.deployResource(deployableRGD, {
      mode: 'kro',
      namespace: this.namespace,
      waitForReady: true,
      timeout: this.factoryOptions.timeout || 60000,
    });

    logger.debug('ResourceGraphDefinition deployed successfully', {
      rgdName,
      namespace: this.namespace
    });
  }

  /**
   * Step 2: Deploy Custom Resource instance using DirectDeploymentEngine
   */
  private async deployCustomResourceInstance(spec: TSpec, instanceName: string): Promise<any> {
    const logger = getComponentLogger('kro-deployment-strategy');

    // Create custom resource instance data
    const apiVersion = this.getApiVersion();
    const customResourceData = {
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
      },
      spec,
    };

    // Wrap with kroCustomResource factory to get Enhanced object with readiness evaluation
    const enhancedCustomResource = kroCustomResource({
      apiVersion: customResourceData.apiVersion,
      kind: customResourceData.kind,
      metadata: {
        name: customResourceData.metadata.name,
        namespace: customResourceData.metadata.namespace,
      },
      spec: customResourceData.spec,
    });

    // Create deployable resource
    const deployableCustomResource = {
      ...enhancedCustomResource,
      id: instanceName,
      metadata: {
        ...enhancedCustomResource.metadata,
        name: instanceName,
        namespace: this.namespace,
      },
    };

    // Deploy using DirectDeploymentEngine with KRO mode
    // Don't wait for ready here - we'll handle Kro-specific readiness logic ourselves
    const deployedResource = await this.directEngine.deployResource(deployableCustomResource, {
      mode: 'kro',
      namespace: this.namespace,
      waitForReady: false, // We'll handle readiness ourselves
      timeout: this.factoryOptions.timeout || 300000,
    });

    // Handle Kro-specific readiness checking if requested
    if (this.factoryOptions.waitForReady ?? true) {
      await this.waitForKroResourceReady(instanceName, this.factoryOptions.timeout || 300000);
    }

    logger.debug('Custom Resource instance deployed successfully', {
      instanceName,
      kind: this.schemaDefinition.kind,
      namespace: this.namespace
    });

    return deployedResource;
  }

  /**
   * Convert camelCase factory name to valid Kubernetes resource name (kebab-case)
   */
  private convertToKubernetesName(name: string): string {
    // Validate input name
    if (!name || typeof name !== 'string') {
      throw new Error(`Invalid factory name: ${JSON.stringify(name)}. Factory name must be a non-empty string.`);
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error(`Invalid factory name: Factory name cannot be empty or whitespace-only.`);
    }

    // Convert to kebab-case and validate result
    const kubernetesName = trimmedName
      .replace(/([a-z])([A-Z])/g, '$1-$2') // Insert dash before capital letters
      .toLowerCase(); // Convert to lowercase

    // Validate Kubernetes naming conventions
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
      throw new Error(`Invalid factory name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`);
    }

    if (kubernetesName.length > 253) {
      throw new Error(`Invalid factory name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`);
    }

    return kubernetesName;
  }

  protected getKind(): string {
    return this.schemaDefinition.kind;
  }

  /**
   * Wait for Kro resource to be ready with Kro-specific logic
   */
  private async waitForKroResourceReady(instanceName: string, timeout: number): Promise<void> {
    const logger = getComponentLogger('kro-deployment-strategy');
    const startTime = Date.now();

    logger.debug('Waiting for Kro resource readiness', { instanceName, timeout });

    while (Date.now() - startTime < timeout) {
      try {
        const apiVersion = this.getApiVersion();
        const k8sApi = this.directEngine.getKubernetesApi(); // Use public getter method

        const response = await k8sApi.read({
          apiVersion,
          kind: this.schemaDefinition.kind,
          metadata: {
            name: instanceName,
            namespace: this.namespace,
          },
        });

        const instance = response.body as any;
        const status = instance.status;

        if (!status) {
          logger.debug('No status found yet, continuing to wait', { instanceName });
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        // Kro-specific readiness logic
        const state = status.state;
        const conditions = status.conditions || [];
        const syncedCondition = conditions.find((c: any) => c.type === 'InstanceSynced');

        // Check if status has fields beyond the basic Kro fields (conditions, state)
        const statusKeys = Object.keys(status);
        const basicKroFields = ['conditions', 'state'];
        const hasCustomStatusFields = statusKeys.some(key => !basicKroFields.includes(key));

        const isActive = state === 'ACTIVE';
        const isSynced = syncedCondition?.status === 'True';

        logger.debug('Kro resource status check', {
          instanceName,
          state,
          isActive,
          isSynced,
          hasCustomStatusFields,
          statusKeys
        });

        // Resource is ready when it's active, synced, and has custom status fields populated
        if (isActive && isSynced && hasCustomStatusFields) {
          logger.info('Kro resource is ready', { instanceName });
          return;
        }

        // Check for failure states
        if (state === 'FAILED') {
          const failedCondition = conditions.find((c: any) => c.status === 'False');
          const errorMessage = failedCondition?.message || 'Unknown error';
          throw new Error(`Kro resource deployment failed: ${errorMessage}`);
        }

        logger.debug('Kro resource not ready yet, continuing to wait', {
          instanceName,
          state,
          isSynced,
          hasCustomStatusFields
        });

      } catch (error) {
        const k8sError = error as { statusCode?: number };
        if (k8sError.statusCode !== 404) {
          throw error;
        }
        // Resource not found yet, continue waiting
        logger.debug('Resource not found yet, continuing to wait', { instanceName });
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`Timeout waiting for Kro resource ${instanceName} to be ready after ${timeout}ms`);
  }
}

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

      // Get resource graph from base strategy using createResourceGraphForInstance
      // This provides the individual Kubernetes resources that need to be registered with Alchemy
      const resourceGraph = this.createResourceGraphForInstance(spec, instanceName);

      // No need to create deployer here - it will be created inside the Alchemy resource handler

      // Process each resource in the resource graph individually for Alchemy registration
      const deployedResources = [];
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

      // Continue processing remaining resources when individual resources fail
      for (const resource of resourceGraph.resources) {
        try {
          // Register resource type dynamically (shared across instances)
          const ResourceProvider = ensureResourceTypeRegistered(resource.manifest);

          // Create unique resource ID for this instance
          const resourceId = createAlchemyResourceId(resource.manifest, this.namespace);

          // Deploy individual resource through Alchemy within the scope
          await this.alchemyScope.run(async () => {
            try {
              // Extract serializable kubeConfig options
              let kubeConfigOptions: {
                skipTLSVerify?: boolean;
                server?: string;
                context?: string;
                cluster?: {
                  name: string;
                  server: string;
                  skipTLSVerify?: boolean;
                  caData?: string;
                  caFile?: string;
                };
                user?: {
                  name: string;
                  token?: string;
                  certData?: string;
                  certFile?: string;
                  keyData?: string;
                  keyFile?: string;
                };
              } | undefined ;

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
                  context
                });

                // SECURITY: Prioritize user's explicit skipTLSVerify choice over cluster config
                const userSkipTLS = this.factoryOptions.skipTLSVerify;
                const clusterSkipTLS = cluster?.skipTLSVerify;
                const finalSkipTLS = userSkipTLS === true ? true : (clusterSkipTLS ?? false);
                
                // Log security warning when TLS is disabled
                if (finalSkipTLS) {
                  this.logger.warn('TLS verification disabled - this is insecure and should only be used in development', {
                    component: 'alchemy-deployment-strategy',
                    security: 'tls-disabled',
                    userExplicit: userSkipTLS === true,
                    fromClusterConfig: clusterSkipTLS === true,
                    server: cluster?.server,
                    recommendation: userSkipTLS === true 
                      ? 'Remove skipTLSVerify: true from factory options for production'
                      : 'Update cluster configuration to enable TLS verification'
                  });
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
                    }
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
                    }
                  }),
                };

                this.logger.debug('Extracted kubeconfig options', {
                  kubeConfigOptions: JSON.stringify(kubeConfigOptions, null, 2)
                });
              } else {
                // First try extracting from the base strategy's factory options (common in tests)
                try {
                  if (this.baseStrategy instanceof DirectDeploymentStrategy) {
                    const bs: any = this.baseStrategy as any;
                    const baseFactoryOptions = bs?.factoryOptions as FactoryOptions | undefined;
                    const baseKc = baseFactoryOptions?.kubeConfig as import('@kubernetes/client-node').KubeConfig | undefined;
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
                      context
                    });

                    if (baseKc && cluster) {
                      // SECURITY: Prioritize user's explicit skipTLSVerify choice over cluster config
                      const userSkipTLS = this.factoryOptions.skipTLSVerify;
                      const clusterSkipTLS = cluster.skipTLSVerify;
                      const finalSkipTLS = userSkipTLS === true ? true : (clusterSkipTLS ?? false);
                      
                      // Log security warning when TLS is disabled
                      if (finalSkipTLS) {
                        this.logger.warn('TLS verification disabled - this is insecure and should only be used in development', {
                          component: 'alchemy-deployment-strategy',
                          security: 'tls-disabled',
                          userExplicit: userSkipTLS === true,
                          fromClusterConfig: clusterSkipTLS === true,
                          server: cluster?.server,
                          recommendation: userSkipTLS === true 
                            ? 'Remove skipTLSVerify: true from factory options for production'
                            : 'Update cluster configuration to enable TLS verification'
                        });
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
                          }
                        }),
                      };

                      this.logger.debug('Extracted kubeconfig options (from base strategy)', {
                        kubeConfigOptions: JSON.stringify(kubeConfigOptions, null, 2)
                      });
                    }
                  }
                } catch (e) {
                  this.logger.warn('Failed to extract kubeconfig from base strategy', e as Error);
                }

                // Fallback: extract kubeconfig options from the base strategy's deployment engine
                if (!kubeConfigOptions) {
                  try {
                    const engine = this.getDeploymentEngine() as any;
                    const kc = engine?.kubeClient as import('@kubernetes/client-node').KubeConfig | undefined;
                    const cluster = kc?.getCurrentCluster();
                    const user = kc?.getCurrentUser();
                    const context = kc?.getCurrentContext();

                    this.logger.debug('Extracting kubeconfig options from deployment engine for alchemy', {
                      hasEngine: !!engine,
                      hasKubeClient: !!kc,
                      hasCluster: !!cluster,
                      clusterSkipTLS: cluster?.skipTLSVerify,
                      clusterServer: cluster?.server,
                      hasUser: !!user,
                      context
                    });

                    if (kc && cluster) {
                      // SECURITY: Prioritize user's explicit skipTLSVerify choice over cluster config
                      const userSkipTLS = this.factoryOptions.skipTLSVerify;
                      const clusterSkipTLS = cluster.skipTLSVerify;
                      const finalSkipTLS = userSkipTLS === true ? true : (clusterSkipTLS ?? false);
                      
                      // Log security warning when TLS is disabled
                      if (finalSkipTLS) {
                        this.logger.warn('TLS verification disabled - this is insecure and should only be used in development', {
                          component: 'alchemy-deployment-strategy',
                          security: 'tls-disabled',
                          userExplicit: userSkipTLS === true,
                          fromClusterConfig: clusterSkipTLS === true,
                          server: cluster?.server,
                          recommendation: userSkipTLS === true 
                            ? 'Remove skipTLSVerify: true from factory options for production'
                            : 'Update cluster configuration to enable TLS verification'
                        });
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
                          }
                        }),
                      };

                      this.logger.debug('Extracted kubeconfig options (from engine)', {
                        kubeConfigOptions: JSON.stringify(kubeConfigOptions, null, 2)
                      });
                    }
                  } catch (e) {
                    this.logger.warn('Failed to extract kubeconfig from deployment engine; Alchemy will use default kubeconfig', e as Error);
                  }
                }
              }

              await ResourceProvider(resourceId, {
                resource: resource.manifest,
                namespace: this.namespace,
                deploymentStrategy: 'direct',
                kubeConfigOptions,
                options: {
                  waitForReady: this.factoryOptions.waitForReady ?? true,
                  timeout: this.factoryOptions.timeout ?? 300000,
                },
              });
            } catch (alchemyError) {
              // If Alchemy registration fails, log it but don't fail the deployment
              // since the actual Kubernetes deployment was successful
              this.logger.warn('Alchemy resource registration failed, but Kubernetes deployment succeeded', alchemyError as Error);

              // Re-throw the error so it gets handled by the outer catch block
              throw alchemyError;
            }
          });

          deployedResources.push({
            id: resource.id,
            kind: resource.manifest.kind || 'Unknown',
            name: resource.manifest.metadata?.name || 'unnamed',
            namespace: this.namespace,
            manifest: resource.manifest,
            status: 'deployed' as const,
            deployedAt: new Date(),
            alchemyResourceId: resourceId,
            alchemyResourceType: this.inferAlchemyResourceType(resource.manifest),
          });

          this.logger.debug('Successfully deployed resource through Alchemy', {
            resourceId,
            kind: resource.manifest.kind,
            name: resource.manifest.metadata?.name,
            alchemyResourceType: this.inferAlchemyResourceType(resource.manifest),
          });
        } catch (error) {
          // Include resource kind, name, and Alchemy resource type in error messages
          const resourceKind = resource.manifest.kind || 'Unknown';
          const resourceName = resource.manifest.metadata?.name || 'unnamed';
          const alchemyResourceType = this.inferAlchemyResourceType(resource.manifest);
          const resourceId = resource.id;

          // Create enhanced error with comprehensive resource-specific context
          let enhancedError: Error;
          if (error instanceof Error) {
            // Ensure error messages are actionable for debugging individual resource issues
            // Include resource ID and namespace information to error context
            enhancedError = new Error(
              `Resource deployment failed for ${resourceKind}/${resourceName} (Alchemy type: ${alchemyResourceType}) ` +
              `[Resource ID: ${resourceId}, Namespace: ${this.namespace}]: ${error.message}. ` +
              `Check resource configuration, dependencies, and cluster connectivity.`
            );
            // Only set stack if it exists to avoid TypeScript error
            if (error.stack) {
              enhancedError.stack = error.stack;
            }
          } else {
            enhancedError = new Error(
              `Resource deployment failed for ${resourceKind}/${resourceName} (Alchemy type: ${alchemyResourceType}) ` +
              `[Resource ID: ${resourceId}, Namespace: ${this.namespace}]: ${String(error)}. ` +
              `Check resource configuration, dependencies, and cluster connectivity.`
            );
          }

          // Collect errors from individual resource deployments rather than failing immediately
          const resourceError = {
            resourceId,
            error: enhancedError,
            phase: 'deployment' as const,
            timestamp: new Date(),
            resourceKind,
            resourceName,
            alchemyResourceType,
            namespace: this.namespace,
          };
          errors.push(resourceError);

          // Enhanced logging with comprehensive context for debugging individual resource issues
          this.logger.error('Failed to deploy resource through Alchemy - continuing with remaining resources', enhancedError, {
            resourceId,
            resourceKind,
            resourceName,
            namespace: this.namespace,
            alchemyResourceType,
            instanceName,
            factoryName: this.factoryName,
            remainingResources: resourceGraph.resources.length - resourceGraph.resources.indexOf(resource) - 1,
            totalResources: resourceGraph.resources.length,
            errorType: error instanceof Error ? error.constructor.name : 'Unknown',
            originalErrorMessage: error instanceof Error ? error.message : String(error),
            // Additional context for debugging
            resourceManifest: {
              apiVersion: resource.manifest.apiVersion,
              kind: resource.manifest.kind,
              metadata: {
                name: resource.manifest.metadata?.name,
                namespace: resource.manifest.metadata?.namespace || this.namespace,
                labels: resource.manifest.metadata?.labels,
              },
            },
          });

          // Continue processing remaining resources instead of throwing immediately
        }
      }

      // Create deployment result from individual resource deployments
      return this.createDeploymentResultFromIndividualResources(
        deployedResources,
        instanceName,
        resourceGraph.dependencyGraph,
        startTime,
        errors
      );
    } catch (error) {
      // Use handleDeploymentError with context about which resource failed
      const contextMessage = `Alchemy deployment failed for instance '${instanceName}' in namespace '${this.namespace}' ` +
        `(Factory: ${this.factoryName}, Schema: ${this.schemaDefinition.kind})`;

      // Log comprehensive error context for debugging
      this.logger.error('Alchemy deployment strategy failed', error as Error, {
        instanceName,
        namespace: this.namespace,
        factoryName: this.factoryName,
        schemaKind: this.schemaDefinition.kind,
        schemaApiVersion: this.schemaDefinition.apiVersion,
        alchemyScope: this.alchemyScope?.name || 'unknown',
        errorType: error instanceof Error ? error.constructor.name : 'Unknown',
        originalErrorMessage: error instanceof Error ? (error as Error).message : String(error),
      });

      handleDeploymentError(error, contextMessage);
    }
  }

  /**
   * Create resource graph for individual resource deployment
   */
  private createResourceGraphForInstance(spec: TSpec, _instanceName: string) {
    // Cast base strategy to access internal methods
    if (this.baseStrategy instanceof DirectDeploymentStrategy) {
      // Access the resource resolver from the DirectDeploymentStrategy
      const directStrategy = this.baseStrategy as any;
      if (directStrategy.resourceResolver?.createResourceGraphForInstance) {
        return directStrategy.resourceResolver.createResourceGraphForInstance(spec);
      }
    }

    throw new Error('AlchemyDeploymentStrategy requires a DirectDeploymentStrategy base strategy with resource resolver');
  }

  /**
   * Get DirectDeploymentEngine from base strategy
   */
  private getDeploymentEngine(): DirectDeploymentEngine {
    if (this.baseStrategy instanceof DirectDeploymentStrategy) {
      // Access the deployment engine from the DirectDeploymentStrategy
      const directStrategy = this.baseStrategy as any;
      if (directStrategy.deploymentEngine) {
        return directStrategy.deploymentEngine;
      }
    }

    throw new Error('AlchemyDeploymentStrategy requires a DirectDeploymentStrategy base strategy with deployment engine');
  }

  /**
   * Create deployment result from individual resource deployments
   * Builds a comprehensive DeploymentResult with Alchemy metadata tracking
   */
  private createDeploymentResultFromIndividualResources(
    deployedResources: Array<{
      id: string;
      kind: string;
      name: string;
      namespace: string;
      manifest: any;
      status: 'deployed' | 'ready' | 'failed';
      deployedAt: Date;
      alchemyResourceId: string;
      alchemyResourceType: string;
      error?: Error;
    }>,
    instanceName: string,
    dependencyGraph: any,
    startTime: number,
    errors: Array<{
      resourceId: string;
      error: Error;
      phase: 'deployment';
      timestamp: Date;
      resourceKind: string;
      resourceName: string;
      alchemyResourceType: string;
      namespace: string;
    }>
  ): DeploymentResult {
    const duration = Date.now() - startTime;

    // Determine overall deployment status
    // Set deployment status to 'partial' when some resources succeed and others fail
    let status: 'success' | 'partial' | 'failed';
    if (errors.length === 0) {
      status = 'success';
      this.logger.info('All resources deployed successfully through Alchemy', {
        totalResources: deployedResources.length,
        instanceName,
        duration,
      });
    } else if (deployedResources.length > 0) {
      // Some resources succeeded, some failed - this is a partial deployment
      status = 'partial';
      this.logger.warn('Partial deployment completed - some resources failed', {
        successfulResources: deployedResources.length,
        failedResources: errors.length,
        totalResources: deployedResources.length + errors.length,
        instanceName,
        duration,
      });
    } else {
      // No resources succeeded - complete failure
      status = 'failed';
      this.logger.error('All resources failed to deploy through Alchemy', new Error('All resources failed'), {
        totalErrors: errors.length,
        instanceName,
        duration,
      });
    }

    // Convert deployed resources to DeployedResource format with Alchemy metadata
    const resources = deployedResources.map(resource => {
      const deployedResource: any = {
        id: resource.id,
        kind: resource.kind,
        name: resource.name,
        namespace: resource.namespace,
        manifest: resource.manifest,
        status: resource.status,
        deployedAt: resource.deployedAt,
        alchemyResourceId: resource.alchemyResourceId,
        alchemyResourceType: resource.alchemyResourceType,
      };

      if (resource.error) {
        deployedResource.error = resource.error;
      }

      return deployedResource;
    });

    // Convert errors to DeploymentError format with additional context
    const deploymentErrors = errors.map(error => {
      // Create enhanced deployment error with comprehensive resource context
      const deploymentError: any = {
        resourceId: error.resourceId,
        phase: error.phase as 'validation' | 'deployment' | 'readiness' | 'rollback',
        error: error.error,
        timestamp: error.timestamp,
        // Include resource-specific context for debugging individual resource issues
        resourceKind: error.resourceKind,
        resourceName: error.resourceName,
        alchemyResourceType: error.alchemyResourceType,
        namespace: error.namespace,
      };

      // Add additional debugging context to make error messages actionable
      deploymentError.debugContext = {
        fullResourceIdentifier: `${error.resourceKind}/${error.resourceName}`,
        alchemyResourceType: error.alchemyResourceType,
        resourceId: error.resourceId,
        namespace: error.namespace,
        instanceName,
        factoryName: this.factoryName,
        troubleshootingHints: [
          `Check if ${error.resourceKind} resource configuration is valid`,
          `Verify namespace '${error.namespace}' exists and is accessible`,
          `Ensure Alchemy scope '${this.alchemyScope?.name || 'unknown'}' is properly configured`,
          `Check cluster connectivity and permissions for resource type ${error.alchemyResourceType}`,
        ],
      };

      return deploymentError;
    });

    // Create Alchemy metadata tracking
    const registeredTypes = [...new Set(deployedResources.map(r => r.alchemyResourceType))];
    const resourceIds = deployedResources.map(r => r.alchemyResourceId);
    const resourceIdToType: Record<string, string> = {};
    deployedResources.forEach(r => {
      resourceIdToType[r.alchemyResourceId] = r.alchemyResourceType;
    });

    const alchemyMetadata = {
      scope: this.alchemyScope?.name || 'unknown',
      registeredTypes,
      resourceIds,
      totalResources: deployedResources.length,
      resourceIdToType,
    };

    return {
      deploymentId: `alchemy-${instanceName}-${Date.now()}`,
      resources,
      dependencyGraph,
      duration,
      status,
      errors: deploymentErrors,
      alchemyMetadata,
    };
  }

  /**
   * Infer Alchemy resource type from Kubernetes resource
   * Uses the enhanced inference function with validation
   */
  private inferAlchemyResourceType(resource: any): string {
    try {
      // Import the enhanced inference function
      const { inferAlchemyTypeFromTypeKroResource } = require('../../alchemy/deployment.js');
      return inferAlchemyTypeFromTypeKroResource(resource);
    } catch (error) {
      // Fallback to basic inference if the enhanced function fails
      this.logger.warn('Failed to use enhanced type inference, falling back to basic inference', error as Error);
      return `kubernetes::${resource.kind || 'Unknown'}`;
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
 * Factory function for creating deployment strategies
 */
export function createDeploymentStrategy<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  mode: 'direct' | 'kro',
  factoryName: string,
  namespace: string,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  factoryOptions: FactoryOptions,
  dependencies: {
    deploymentEngine?: DirectDeploymentEngine;
    resourceResolver?: unknown;
    kroEngine?: unknown;
    rgdManager?: unknown;
    resources?: Record<string, any>;
    statusMappings?: any;
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
      if (!dependencies.deploymentEngine) {
        throw new Error('KroDeploymentStrategy requires deploymentEngine');
      }
      return new KroDeploymentStrategy(
        factoryName,
        namespace,
        schemaDefinition,
        factoryOptions,
        dependencies.deploymentEngine,
        dependencies.resources || {},
        dependencies.statusMappings || {}
      );

    default:
      throw new Error(`Unsupported deployment mode: ${mode}`);
  }
}

/**
 * Factory function for wrapping strategies with alchemy
 */
export function wrapStrategyWithAlchemy<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
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