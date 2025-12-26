/**
 * KroResourceFactory implementation for Kro deployment mode
 *
 * This factory handles deployment via Kro ResourceGraphDefinitions,
 * using the Kro controller for dependency resolution and resource management.
 */

import * as k8s from '@kubernetes/client-node';
import {
  createAlchemyResourceId,
  ensureResourceTypeRegistered,
  KroTypeKroDeployer,
} from '../../alchemy/deployment.js';

import { kroCustomResource } from '../../factories/kro/kro-custom-resource.js';
import { resourceGraphDefinition } from '../../factories/kro/resource-graph-definition.js';
import {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  type KubernetesClientConfig,
  type KubernetesClientProvider,
} from '../kubernetes/client-provider.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { createSchemaProxy, DeploymentMode } from '../references/index.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';
import { serializeResourceGraphToYaml } from '../serialization/yaml.js';
import type { KubernetesRef, CelExpression } from '../types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
  FactoryOptions,
  FactoryStatus,
  KroResourceFactory,
  RGDStatus,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
// Alchemy integration
import type {
  KroCompatibleType,
  MagicAssignableShape,
  SchemaDefinition,
  SchemaProxy,
  Scope,
} from '../types/serialization.js';
import { DirectDeploymentEngine } from './engine.js';

/**
 * KroResourceFactory implementation
 *
 * Handles deployment via Kro ResourceGraphDefinitions. The RGD is deployed once,
 * and then instances are created as custom resources that the Kro controller processes.
 */
export class KroResourceFactoryImpl<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> implements KroResourceFactory<TSpec, TStatus>
{
  readonly mode = 'kro' as const;
  readonly name: string;
  readonly namespace: string;
  readonly isAlchemyManaged: boolean;
  readonly rgdName: string;
  readonly schema: SchemaProxy<TSpec, TStatus>;

  private readonly resources: Record<string, KubernetesResource>;
  private readonly closures: Record<string, DeploymentClosure>;
  private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
  private readonly statusMappings: any;
  private readonly alchemyScope: Scope | undefined;
  private readonly logger = getComponentLogger('kro-factory');
  private readonly factoryOptions: FactoryOptions;
  private clientProvider?: KubernetesClientProvider;
  private customObjectsApi?: k8s.CustomObjectsApi;

  constructor(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    statusMappings: MagicAssignableShape<TStatus>,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.alchemyScope = options.alchemyScope;
    this.isAlchemyManaged = !!options.alchemyScope;
    this.rgdName = this.convertToKubernetesName(name); // Convert to valid Kubernetes resource name
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.statusMappings = statusMappings;
    this.factoryOptions = options;
    this.schema = createSchemaProxy<TSpec, TStatus>();

    // Validate closures for Kro mode - detect KubernetesRef inputs and raise clear errors
    this.validateClosuresForKroMode();

    // Don't initialize client provider in constructor - do it lazily when needed
    // This allows tests to create factories without requiring a kubeconfig
  }

  /**
   * Validate closures for Kro mode compatibility
   * Kro mode only supports static values - no dynamic references (KubernetesRef)
   */
  private validateClosuresForKroMode(): void {
    if (Object.keys(this.closures).length === 0) {
      return; // No closures to validate
    }

    // For Kro mode, we need to validate that closures don't contain dynamic references
    // This is a static analysis - we can't execute the closures to check their arguments
    // Instead, we'll validate when closures are executed during deployment
    this.logger.debug('Kro factory initialized with closures', {
      closureCount: Object.keys(this.closures).length,
      closureNames: Object.keys(this.closures),
    });
  }

  /**
   * Convert camelCase resource graph name to valid Kubernetes resource name (kebab-case)
   */
  private convertToKubernetesName(name: string): string {
    // Validate input name
    if (!name || typeof name !== 'string') {
      throw new Error(
        `Invalid resource graph name: ${JSON.stringify(name)}. Resource graph name must be a non-empty string.`
      );
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error(
        `Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`
      );
    }

    // Convert to kebab-case and validate result
    const kubernetesName = trimmedName
      .replace(/([a-z])([A-Z])/g, '$1-$2') // Insert dash before capital letters
      .toLowerCase(); // Convert to lowercase

    // Validate Kubernetes naming conventions
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
      throw new Error(
        `Invalid resource graph name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`
      );
    }

    if (kubernetesName.length > 253) {
      throw new Error(
        `Invalid resource graph name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`
      );
    }

    return kubernetesName;
  }

  /**
   * Get or create the Kubernetes client provider (lazy initialization)
   */
  private getClientProvider(): KubernetesClientProvider {
    if (!this.clientProvider) {
      this.clientProvider = this.createClientProvider(this.factoryOptions);
    }
    return this.clientProvider;
  }

  /**
   * Create and configure the Kubernetes client provider
   */
  private createClientProvider(options: FactoryOptions): KubernetesClientProvider {
    // If a pre-configured kubeConfig is provided, use it directly
    if (options.kubeConfig) {
      this.logger.debug('Using pre-configured KubeConfig from factory options');
      return createKubernetesClientProviderWithKubeConfig(options.kubeConfig);
    }

    // Create client provider with configuration from factory options
    const clientConfig: KubernetesClientConfig = {
      ...(options.skipTLSVerify !== undefined && { skipTLSVerify: options.skipTLSVerify }),
      // Add other configuration options as needed
    };

    this.logger.debug('Creating new KubernetesClientProvider with configuration', {
      skipTLSVerify: clientConfig.skipTLSVerify,
    });

    return createKubernetesClientProvider(clientConfig);
  }

  /**
   * Get the Kubernetes config from the centralized provider
   */
  private getKubeConfig(): k8s.KubeConfig {
    const clientProvider = this.getClientProvider();
    return clientProvider.getKubeConfig();
  }

  /**
   * Get CustomObjectsApi client
   */
  private getCustomObjectsApi(): k8s.CustomObjectsApi {
    if (!this.customObjectsApi) {
      const clientProvider = this.getClientProvider();
      this.customObjectsApi = clientProvider.getCustomObjectsApi();
    }
    return this.customObjectsApi;
  }

  /**
   * Deploy a new instance by creating a custom resource
   */
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // Validate spec against ArkType schema
    const validationResult = this.schemaDefinition.spec(spec);
    if (validationResult instanceof Error) {
      throw new Error(`Invalid spec: ${validationResult.message}`);
    }

    // Execute closures before RGD creation (Kro mode requirement)
    await this.executeClosuresBeforeRGD(spec);

    if (this.isAlchemyManaged) {
      return this.deployWithAlchemy(spec);
    } else {
      return this.deployDirect(spec);
    }
  }

  /**
   * Execute closures before RGD creation (Kro mode requirement)
   * Closures must execute before ResourceGraphDefinition is created
   */
  private async executeClosuresBeforeRGD(_spec: TSpec): Promise<AppliedResource[]> {
    if (Object.keys(this.closures).length === 0) {
      return []; // No closures to execute
    }

    this.logger.info('Executing closures before RGD creation', {
      closureCount: Object.keys(this.closures).length,
    });

    // First, validate all closures before creating any API clients
    // The closures returned by the resource builder are deployment closures that expect a DeploymentContext
    // We need to execute them with a mock context to trigger validation
    const mockDeploymentContext: DeploymentContext = {
      kubernetesApi: null as any, // Not needed for validation
      namespace: this.namespace,
      deployedResources: new Map(),
      resolveReference: async (ref: KubernetesRef) => {
        throw new Error(
          `Kro mode does not support dynamic reference resolution. Found reference: ${ref.resourceId}.${ref.fieldPath}`
        );
      },
    };

    for (const [closureName, closure] of Object.entries(this.closures)) {
      try {
        // Execute the deployment closure with mock context to trigger validation
        await closure(mockDeploymentContext);
      } catch (error) {
        // If validation fails, throw the validation error immediately
        if (
          error instanceof Error &&
          error.message.includes('Kro mode does not support dynamic reference resolution')
        ) {
          throw error;
        }
        // For other errors, wrap them with context
        throw new Error(`Failed to validate closure '${closureName}': ${error}`);
      }
    }

    const allResults: AppliedResource[] = [];

    // Only create deployment context after validation passes
    // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
    const kubeConfig = this.getKubeConfig();
    const deploymentContext: DeploymentContext = {
      kubernetesApi: createBunCompatibleKubernetesObjectApi(kubeConfig),
      ...(this.alchemyScope && { alchemyScope: this.alchemyScope }),
      namespace: this.namespace,
      deployedResources: new Map(), // Empty for pre-RGD execution
      resolveReference: async (ref: KubernetesRef) => {
        throw new Error(
          `Kro mode does not support dynamic reference resolution. Found reference: ${ref.resourceId}.${ref.fieldPath}`
        );
      },
    };

    // Execute closures sequentially to maintain order
    for (const [closureName, closure] of Object.entries(this.closures)) {
      try {
        this.logger.debug('Executing closure', { name: closureName });

        // Note: We can't validate closure arguments here because we don't have access to them
        // The validation happens inside the closure when it processes its config
        // This is a limitation of the closure pattern, but the error messages will be clear

        const results = await closure(deploymentContext);
        allResults.push(...results);

        this.logger.info('Closure executed successfully', {
          name: closureName,
          resourceCount: results.length,
        });
      } catch (error) {
        // Check if this is a KubernetesRef validation error and enhance it
        if (error instanceof Error && error.message.includes('KubernetesRef')) {
          this.logger.error(
            'Closure validation failed - dynamic references not supported in Kro mode',
            {
              name: closureName,
              message: error.message,
            }
          );
          throw error; // Re-throw with original detailed message
        }

        this.logger.error('Closure execution failed', {
          name: closureName,
          message: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Failed to execute closure '${closureName}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.logger.info('All closures executed successfully', {
      totalResources: allResults.length,
    });

    return allResults;
  }

  /**
   * Deploy directly to Kubernetes using DirectDeploymentEngine
   */
  private async deployDirect(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // Ensure RGD is deployed first
    await this.ensureRGDDeployed();

    // Create DirectDeploymentEngine with KRO mode for CEL string conversion
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );

    // Create custom resource instance
    const instanceName = this.generateInstanceName(spec);
    const customResourceData = this.createCustomResourceInstance(instanceName, spec);

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

    // Deploy using DirectDeploymentEngine with built-in waitForReady logic
    const deployableResource: DeployableK8sResource<typeof enhancedCustomResource> = {
      ...enhancedCustomResource,
      id: instanceName,
      metadata: {
        ...enhancedCustomResource.metadata,
        name: instanceName,
        namespace: this.namespace,
      },
      spec: customResourceData.spec, // Use spec directly from customResourceData to ensure it's preserved
    } as DeployableK8sResource<typeof enhancedCustomResource>;

    // Preserve the readiness evaluator (non-enumerable property)
    const readinessEvaluator = (enhancedCustomResource as any).readinessEvaluator;
    if (readinessEvaluator) {
      Object.defineProperty(deployableResource, 'readinessEvaluator', {
        value: readinessEvaluator,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }

    // Deploy without waiting for readiness - we'll handle that ourselves
    const _deployedResource = await deploymentEngine.deployResource(deployableResource, {
      mode: 'kro',
      namespace: this.namespace,
      waitForReady: false, // We'll handle Kro-specific readiness ourselves
      timeout: this.factoryOptions.timeout || 300000,
    });

    // Handle Kro-specific readiness checking if requested
    if (this.factoryOptions.waitForReady ?? true) {
      await this.waitForKroInstanceReady(instanceName, this.factoryOptions.timeout || 600000); // 10 minutes
    }

    // Create Enhanced proxy for the deployed instance
    return await this.createEnhancedProxy(spec, instanceName);
  }

  /**
   * Deploy using type-safe alchemy resource wrapping
   *
   * In alchemy mode, the RGD gets one typed alchemy Resource and each instance gets another
   */
  private async deployWithAlchemy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    if (!this.alchemyScope) {
      throw new Error('Alchemy scope is required for alchemy deployment');
    }

    // Use static registration functions

    // Create deployer instance using DirectDeploymentEngine with KRO mode
    const kroEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );
    const deployer = new KroTypeKroDeployer(kroEngine);

    // 1. Ensure RGD is deployed via alchemy (once per factory)
    const kroSchema = generateKroSchemaFromArktype(
      this.name,
      this.schemaDefinition,
      this.resources,
      this.statusMappings
    );
    const rgdManifest = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: {
        name: this.rgdName,
        namespace: this.namespace,
      },
      spec: {
        schema: kroSchema,
        resources: Object.values(this.resources).map((resource) => ({
          id: resource.id || resource.metadata?.name || 'unknown',
          template: resource,
        })),
      },
    };

    // Register RGD type dynamically
    const rgdEnhanced = resourceGraphDefinition(rgdManifest);
    const RGDProvider = ensureResourceTypeRegistered(rgdEnhanced);
    const rgdId = createAlchemyResourceId(rgdEnhanced, this.namespace);

    await RGDProvider(rgdId, {
      resource: rgdEnhanced,
      namespace: this.namespace,
      deployer: deployer,
      options: {
        waitForReady: true,
        timeout: 60000, // RGD should be ready quickly
      },
    });

    // 2. Create instance via alchemy (once per deploy call)
    const instanceName = this.generateInstanceName(spec);
    const crdInstanceManifest = this.createCustomResourceInstance(instanceName, spec);

    // Register CRD instance type dynamically
    const CRDInstanceProvider = ensureResourceTypeRegistered(crdInstanceManifest as any);
    const instanceId = createAlchemyResourceId(crdInstanceManifest as any, this.namespace);

    await CRDInstanceProvider(instanceId, {
      resource: crdInstanceManifest as any,
      namespace: this.namespace,
      deployer: deployer,
      options: {
        waitForReady: this.factoryOptions.waitForReady ?? true,
        timeout: this.factoryOptions.timeout ?? 300000,
      },
    });

    // Create Enhanced proxy for the deployed instance
    return await this.createEnhancedProxy(spec, instanceName);
  }

  /**
   * Get all deployed instances
   */
  async getInstances(): Promise<Enhanced<TSpec, TStatus>[]> {
    const kubeConfig = this.getKubeConfig();
    // Use Bun-compatible API client to ensure proper TLS handling
    const { createBunCompatibleCustomObjectsApi } = await import('../kubernetes/bun-api-client.js');
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    try {
      // The schema definition should contain just the version part (e.g., 'v1alpha1')
      // If it somehow contains the full API version, extract just the version part
      const version = this.schemaDefinition.apiVersion.includes('/')
        ? this.schemaDefinition.apiVersion.split('/')[1] || this.schemaDefinition.apiVersion
        : this.schemaDefinition.apiVersion;

      // In the new API, methods take request objects and return objects directly
      const listResponse = await customApi.listNamespacedCustomObject({
        group: 'kro.run',
        version,
        namespace: this.namespace,
        plural: `${this.schemaDefinition.kind.toLowerCase()}s`, // Pluralize the kind
      });

      // Custom object list response structure
      interface CustomObjectListResponse {
        items?: Array<{
          spec?: TSpec;
          metadata?: { name?: string };
        }>;
      }
      const listResult = listResponse as CustomObjectListResponse;
      const instances = listResult.items || [];

      return await Promise.all(
        instances.map(async (instance) => {
          return await this.createEnhancedProxy(
            instance.spec as TSpec,
            instance.metadata?.name || 'unknown'
          );
        })
      );
    } catch (error) {
      const k8sError = error as { message?: string; body?: string | object; statusCode?: number };
      // If the CRD doesn't exist yet or there are no instances, return empty array
      const bodyString =
        typeof k8sError.body === 'string' ? k8sError.body : JSON.stringify(k8sError.body || '');

      if (
        k8sError.message?.includes('not found') ||
        k8sError.message?.includes('404') ||
        bodyString.includes('not found') ||
        bodyString.includes('404') ||
        k8sError.statusCode === 404 ||
        String(error).includes('404') ||
        String(error).includes('not found')
      ) {
        return [];
      }
      throw new Error(`Failed to list instances: ${k8sError.message || String(error)}`);
    }
  }

  /**
   * Delete a specific instance by name
   */
  async deleteInstance(name: string): Promise<void> {
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    const apiVersion = this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion
      : `kro.run/${this.schemaDefinition.apiVersion}`;

    try {
      await k8sApi.delete({
        apiVersion,
        kind: this.schemaDefinition.kind,
        metadata: {
          name,
          namespace: this.namespace,
        },
      } as k8s.KubernetesObject);
    } catch (error) {
      const k8sError = error as { statusCode?: number; message?: string };
      if (k8sError.statusCode !== 404) {
        throw new Error(`Failed to delete instance ${name}: ${k8sError.message || String(error)}`);
      }
      // Instance already deleted, ignore 404
    }
  }

  /**
   * Get factory status
   */
  async getStatus(): Promise<FactoryStatus> {
    const instances = await this.getInstances();
    const rgdStatus = await this.getRGDStatus();

    return {
      name: this.name,
      mode: this.mode,
      isAlchemyManaged: this.isAlchemyManaged,
      namespace: this.namespace,
      instanceCount: instances.length,
      health: rgdStatus.phase === 'ready' ? 'healthy' : 'degraded',
    };
  }

  /**
   * Get ResourceGraphDefinition status
   */
  async getRGDStatus(): Promise<RGDStatus> {
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    try {
      // In the new API, methods return objects directly (no .body wrapper)
      const response = await k8sApi.read({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: {
          name: this.rgdName,
          namespace: this.namespace,
        },
      });

      const rgd = response as k8s.KubernetesObject & {
        status?: {
          state?: string;
          conditions?: Array<{
            type: string;
            status: string;
            reason?: string;
            message?: string;
          }>;
          observedGeneration?: number;
        };
      };

      // Map Kro's state to our phase enum
      let phase: 'pending' | 'ready' | 'failed' = 'pending';
      if (rgd.status?.state === 'Active') {
        phase = 'ready';
      } else if (rgd.status?.state === 'Inactive') {
        // Check if it's failed or just pending
        const hasFailedCondition = rgd.status?.conditions?.some((c) => c.status === 'False');
        phase = hasFailedCondition ? 'failed' : 'pending';
      }

      return {
        name: this.rgdName,
        phase,
        conditions: rgd.status?.conditions || [],
        observedGeneration: rgd.status?.observedGeneration || 0,
      };
    } catch (error) {
      const k8sError = error as { statusCode?: number; message?: string; body?: string | object };
      // Check for 404 in multiple ways since different API clients report it differently
      const bodyString =
        typeof k8sError.body === 'string' ? k8sError.body : JSON.stringify(k8sError.body || '');
      const is404 =
        k8sError.statusCode === 404 ||
        k8sError.message?.includes('404') ||
        k8sError.message?.includes('not found') ||
        k8sError.message?.includes('NotFound') ||
        bodyString.includes('"code":404') ||
        bodyString.includes('"reason":"NotFound"') ||
        String(error).includes('404') ||
        String(error).includes('not found');

      if (is404) {
        return {
          name: this.rgdName,
          phase: 'pending',
          conditions: [],
        };
      }
      throw new Error(`Failed to get RGD status: ${k8sError.message || String(error)}`);
    }
  }

  /**
   * Generate RGD YAML (no arguments)
   */
  toYaml(): string;
  /**
   * Generate CRD instance YAML (with spec)
   */
  toYaml(spec: TSpec): string;
  /**
   * Implementation of overloaded toYaml method
   */
  toYaml(spec?: TSpec): string {
    if (spec) {
      // Generate CRD instance YAML
      const instanceName = this.generateInstanceName(spec);
      const customResource = this.createCustomResourceInstance(instanceName, spec);

      return `apiVersion: ${customResource.apiVersion}
kind: ${customResource.kind}
metadata:
  name: ${customResource.metadata.name}
  namespace: ${customResource.metadata.namespace}
spec:
${Object.entries(spec as Record<string, any>)
  .map(([key, value]) => `  ${key}: ${typeof value === 'string' ? `"${value}"` : value}`)
  .join('\n')}`;
    } else {
      // Generate RGD YAML
      const kroSchema = generateKroSchemaFromArktype(
        this.name,
        this.schemaDefinition,
        this.resources,
        this.statusMappings
      );
      return serializeResourceGraphToYaml(
        this.rgdName,
        this.resources,
        { namespace: this.namespace },
        kroSchema
      );
    }
  }

  /**
   * Ensure the ResourceGraphDefinition is deployed using DirectDeploymentEngine
   */
  private async ensureRGDDeployed(): Promise<void> {
    // Create DirectDeploymentEngine instance with KRO mode for CEL string generation
    const deploymentEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );

    // Create the RGD using the same serialization logic as toYaml()
    const kroSchema = generateKroSchemaFromArktype(
      this.name,
      this.schemaDefinition,
      this.resources,
      this.statusMappings
    );
    const rgdYaml = serializeResourceGraphToYaml(
      this.rgdName,
      this.resources,
      { namespace: this.namespace },
      kroSchema
    );

    // Parse the YAML to get the RGD object
    const rgdManifests = k8s.loadAllYaml(rgdYaml);
    const rgdManifest = rgdManifests[0] as k8s.KubernetesObject;

    // Ensure the RGD has the required properties for deployment
    const rgdWithMetadata = {
      ...rgdManifest,
      metadata: {
        ...rgdManifest.metadata,
        name: this.rgdName,
        namespace: this.namespace,
      },
    };

    // Create Enhanced RGD with readiness evaluator
    const enhancedRGD = resourceGraphDefinition(rgdWithMetadata);

    // Debug: Log the RGD being deployed
    this.logger.debug('Deploying RGD', {
      rgdName: this.rgdName,
      rgdManifest: JSON.stringify(rgdWithMetadata, null, 2),
    });

    try {
      // Deploy RGD using DirectDeploymentEngine with readiness checking
      await deploymentEngine.deployResource(enhancedRGD as any, {
        mode: 'direct',
        namespace: this.namespace,
        waitForReady: true,
        timeout: this.factoryOptions.timeout || 60000,
      });

      // Wait for the CRD to be created by Kro using DirectDeploymentEngine
      await this.waitForCRDReadyWithEngine(deploymentEngine);
    } catch (error) {
      // Debug: Check the actual RGD status when it fails
      try {
        const kubeConfig = this.getKubeConfig();
        const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
        // In the new API, methods return objects directly (no .body wrapper)
        const rgdStatus = await k8sApi.read({
          apiVersion: 'kro.run/v1alpha1',
          kind: 'ResourceGraphDefinition',
          metadata: { name: this.rgdName, namespace: this.namespace },
        });
        // RGD status structure
        interface RGDStatusResponse {
          status?: {
            conditions?: Array<{ type?: string; status?: string; message?: string }>;
            [key: string]: unknown;
          };
        }
        const rgdResult = rgdStatus as RGDStatusResponse;
        this.logger.error('RGD deployment failed, current status:', undefined, {
          rgdName: this.rgdName,
          status: rgdResult.status,
          conditions: rgdResult.status?.conditions,
        });
      } catch (statusError) {
        this.logger.error('Could not fetch RGD status for debugging', statusError as Error);
      }

      throw new Error(
        `Failed to deploy RGD using DirectDeploymentEngine: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Pluralize a Kubernetes Kind name following Kubernetes CRD naming conventions
   * This matches the pluralization rules used by Kubernetes for CRD names
   */
  private pluralizeKind(kind: string): string {
    const lowerKind = kind.toLowerCase();

    // Handle common English pluralization rules that Kubernetes follows
    if (
      lowerKind.endsWith('s') ||
      lowerKind.endsWith('sh') ||
      lowerKind.endsWith('ch') ||
      lowerKind.endsWith('x') ||
      lowerKind.endsWith('z')
    ) {
      return `${lowerKind}es`;
    } else if (lowerKind.endsWith('o')) {
      return `${lowerKind}es`;
    } else if (
      lowerKind.endsWith('y') &&
      lowerKind.length > 1 &&
      !'aeiou'.includes(lowerKind[lowerKind.length - 2] || '')
    ) {
      return `${lowerKind.slice(0, -1)}ies`;
    } else if (lowerKind.endsWith('f')) {
      return `${lowerKind.slice(0, -1)}ves`;
    } else if (lowerKind.endsWith('fe')) {
      return `${lowerKind.slice(0, -2)}ves`;
    } else {
      return `${lowerKind}s`;
    }
  }

  /**
   * Wait for the CRD to be created by Kro using DirectDeploymentEngine
   */
  private async waitForCRDReadyWithEngine(deploymentEngine: DirectDeploymentEngine): Promise<void> {
    const crdName = `${this.pluralizeKind(this.schemaDefinition.kind)}.kro.run`;

    // Debug: Check if the method exists
    if (typeof deploymentEngine.waitForCRDReady !== 'function') {
      throw new Error(
        `deploymentEngine.waitForCRDReady is not a function. Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(deploymentEngine)).join(', ')}`
      );
    }

    // Use the deployment engine's built-in CRD readiness checking
    // This will wait for the CRD to be created by Kro and become ready
    await deploymentEngine.waitForCRDReady(crdName, this.factoryOptions.timeout || 60000);
  }

  /**
   * Separate static and dynamic status fields
   */
  private async separateStatusFields(): Promise<{
    staticFields: Record<string, any>;
    dynamicFields: Record<string, any>;
  }> {
    if (!this.statusMappings) {
      return { staticFields: {}, dynamicFields: {} };
    }

    // Use dynamic import to avoid circular dependencies
    const { separateStatusFields } = await import('../validation/cel-validator.js');
    return separateStatusFields(this.statusMappings);
  }

  /**
   * Evaluate static CEL expressions with actual spec values
   */
  private async evaluateStaticFields(
    staticFields: Record<string, any>,
    spec: TSpec
  ): Promise<Record<string, any>> {
    const evaluatedFields: Record<string, any> = {};

    for (const [fieldName, fieldValue] of Object.entries(staticFields)) {
      if (this.isCelExpression(fieldValue)) {
        try {
          // Evaluate CEL expressions that contain only schema references
          const evaluatedValue = this.evaluateStaticCelExpression(fieldValue, spec);
          evaluatedFields[fieldName] = evaluatedValue;
        } catch (error) {
          this.logger.warn('Failed to evaluate static CEL expression', {
            field: fieldName,
            expression: fieldValue.expression,
            error: (error as Error).message,
          });
          // Fallback to the original value
          evaluatedFields[fieldName] = fieldValue;
        }
      } else if (
        typeof fieldValue === 'object' &&
        fieldValue !== null &&
        !Array.isArray(fieldValue)
      ) {
        // Recursively evaluate nested objects
        evaluatedFields[fieldName] = await this.evaluateStaticFields(fieldValue, spec);
      } else {
        // Keep non-CEL values as-is
        evaluatedFields[fieldName] = fieldValue;
      }
    }

    return evaluatedFields;
  }

  /**
   * Evaluate a static CEL expression that contains only schema references or literal values
   */
  private evaluateStaticCelExpression(celExpression: CelExpression, spec: TSpec): unknown {
    const expression = celExpression.expression;

    // Handle expressions that reference schema.spec fields FIRST (before checking just spec.)
    if (expression.includes('schema.spec.')) {
      // Replace schema.spec.fieldName with actual spec values
      let evaluatedExpression = expression;

      // Find all schema.spec.fieldName patterns and replace them with actual values
      const schemaRefPattern = /schema\.spec\.(\w+)/g;
      const specRecord = spec as Record<string, unknown>;
      evaluatedExpression = evaluatedExpression.replace(
        schemaRefPattern,
        (originalMatch: string, fieldName: string) => {
          const fieldValue = specRecord[fieldName];

          if (fieldValue !== undefined) {
            // Return the properly formatted value for JavaScript evaluation
            if (typeof fieldValue === 'string') {
              return `"${fieldValue}"`; // Wrap strings in quotes
            } else if (typeof fieldValue === 'boolean') {
              return String(fieldValue); // true/false as-is
            } else if (typeof fieldValue === 'number') {
              return String(fieldValue); // Numbers as-is
            } else {
              return JSON.stringify(fieldValue); // Other types as JSON
            }
          }

          // If field value is undefined, keep the original reference
          return originalMatch;
        }
      );

      // Now evaluate the expression with actual values
      try {
        // Use Function constructor for safer evaluation than eval
        const result = new Function(`return ${evaluatedExpression}`)();
        return result;
      } catch (error) {
        this.logger.warn('Failed to evaluate schema expression with Function constructor', {
          expression: evaluatedExpression,
          originalExpression: expression,
          error: (error as Error).message,
        });
        throw error;
      }
    }

    // Handle expressions that reference spec fields (not schema.spec, just spec)
    if (expression.includes('spec.')) {
      // Replace spec.fieldName with actual spec values
      let evaluatedExpression = expression;

      // Find all spec.fieldName patterns (not schema.spec) and replace them with actual values
      const specRefPattern = /\bspec\.(\w+)/g;
      const specRecord = spec as Record<string, unknown>;
      evaluatedExpression = evaluatedExpression.replace(
        specRefPattern,
        (match: string, fieldName: string) => {
          const fieldValue = specRecord[fieldName];

          if (fieldValue !== undefined) {
            // Return the properly formatted value for JavaScript evaluation
            if (typeof fieldValue === 'string') {
              return `"${fieldValue}"`; // Wrap strings in quotes
            } else if (typeof fieldValue === 'boolean') {
              return String(fieldValue); // true/false as-is
            } else if (typeof fieldValue === 'number') {
              return String(fieldValue); // Numbers as-is
            } else {
              return JSON.stringify(fieldValue); // Other types as JSON
            }
          }

          // If field value is undefined, keep the original reference
          return match;
        }
      );

      // Now evaluate the expression with actual values
      try {
        // Use Function constructor for safer evaluation than eval
        // This creates a new function that returns the result of the expression
        const result = new Function(`return ${evaluatedExpression}`)();
        return result;
      } catch (error) {
        this.logger.warn('Failed to evaluate expression with Function constructor', {
          expression: evaluatedExpression,
          originalExpression: expression,
          error: (error as Error).message,
        });
        throw error;
      }
    }

    // Handle static literal expressions (no schema or spec references)
    // These are expressions like "running", 'http://example.com', true, 123, etc.
    // Try to evaluate them directly as JavaScript expressions
    try {
      const result = new Function(`return ${expression}`)();
      return result;
    } catch (error) {
      // If evaluation fails, the expression might be an unquoted string like: http://kro-webapp-service
      // In this case, return it as-is (it's already a string value)
      this.logger.debug('Static expression evaluation failed, returning as string literal', {
        expression,
        error: (error as Error).message,
      });
      return expression;
    }
  }

  /**
   * Check if a value is a CEL expression
   */
  private isCelExpression(value: unknown): value is CelExpression {
    return (
      value !== null &&
      typeof value === 'object' &&
      (value as Record<symbol, unknown>)[Symbol.for('TypeKro.CelExpression')] === true &&
      typeof (value as { expression?: unknown }).expression === 'string'
    );
  }

  /**
   * Generate instance name from spec
   */
  private generateInstanceName(spec: TSpec): string {
    // Try to extract name from spec - check common name fields
    if (typeof spec === 'object' && spec !== null) {
      const specObj = spec as Record<string, unknown>;

      // Check for common name fields in order of preference
      for (const nameField of ['name', 'appName', 'serviceName', 'resourceName']) {
        if (nameField in specObj && specObj[nameField]) {
          return String(specObj[nameField]);
        }
      }
    }

    // Generate a unique name
    return `${this.name}-${Date.now()}`;
  }

  /**
   * Create custom resource instance
   */
  private createCustomResourceInstance(instanceName: string, spec: TSpec) {
    // The schema definition contains just the version part (e.g., 'v1alpha1')
    // We need to construct the full API version for the instance (e.g., 'kro.run/v1alpha1')
    const apiVersion = this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion // Already has group prefix
      : `kro.run/${this.schemaDefinition.apiVersion}`; // Add kro.run group

    return {
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
      },
      spec,
    };
  }

  /**
   * Create an Enhanced proxy for the instance with mixed static/dynamic hydration
   */
  private async createEnhancedProxyWithMixedHydration(
    spec: TSpec,
    instanceName: string
  ): Promise<Enhanced<TSpec, TStatus>> {
    const hydrationLogger = this.logger.child({ instanceName });

    // Separate static and dynamic status fields
    const { staticFields, dynamicFields } = await this.separateStatusFields();

    // Evaluate static CEL expressions with actual spec values
    const evaluatedStaticFields = await this.evaluateStaticFields(staticFields, spec);

    // Start with evaluated static fields as the base status
    const status: TStatus = { ...evaluatedStaticFields } as TStatus;

    // Create the initial Enhanced proxy
    // The Enhanced proxy should represent the actual instance, which uses the full API version
    const instanceApiVersion = this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion
      : `kro.run/${this.schemaDefinition.apiVersion}`;

    const enhancedProxy = {
      apiVersion: instanceApiVersion,
      kind: this.schemaDefinition.kind,
      spec,
      status,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
        labels: {
          'typekro.io/factory': this.name,
          'typekro.io/mode': this.mode,
          'typekro.io/rgd': this.rgdName,
        },
        annotations: {
          'typekro.io/deployed-at': new Date().toISOString(),
          'typekro.io/api-version': instanceApiVersion,
          'typekro.io/kind': this.schemaDefinition.kind,
        },
      },
    } as unknown as Enhanced<TSpec, TStatus>;

    // Hydrate dynamic status fields if enabled and there are dynamic fields
    if (this.factoryOptions.hydrateStatus !== false && Object.keys(dynamicFields).length > 0) {
      try {
        const hydratedDynamicFields = await this.hydrateDynamicStatusFields(
          instanceName,
          dynamicFields
        );

        // Merge dynamic fields with static fields
        // Dynamic fields from Kro take precedence over static fields with same names
        const mergedStatus = {
          ...staticFields, // Static fields first
          ...hydratedDynamicFields, // Dynamic fields from Kro override
        };

        // Update the status using object assignment to avoid type issues
        Object.assign(enhancedProxy.status, mergedStatus);
      } catch (error) {
        hydrationLogger.warn('Dynamic status hydration failed', error as Error);
        // Continue with static fields only if dynamic hydration fails
      }
    }

    return enhancedProxy;
  }

  /**
   * Create an Enhanced proxy for the instance (backward compatibility method)
   */
  private async createEnhancedProxy(
    spec: TSpec,
    instanceName: string
  ): Promise<Enhanced<TSpec, TStatus>> {
    return this.createEnhancedProxyWithMixedHydration(spec, instanceName);
  }

  /**
   * Wait for Kro instance to be ready with Kro-specific logic
   */
  private async waitForKroInstanceReady(instanceName: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    const readinessLogger = this.logger.child({ instanceName, rgdName: this.name });

    while (Date.now() - startTime < timeout) {
      try {
        const apiVersion = this.schemaDefinition.apiVersion.includes('/')
          ? this.schemaDefinition.apiVersion
          : `kro.run/${this.schemaDefinition.apiVersion}`;

        const kubeConfig = this.getKubeConfig();
        const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
        const response = await k8sApi.read({
          apiVersion,
          kind: this.schemaDefinition.kind,
          metadata: {
            name: instanceName,
            namespace: this.namespace,
          },
        });

        // In the new API, methods return objects directly (no .body wrapper)
        const instance = response as k8s.KubernetesObject & {
          status?: {
            state?: string;
            phase?: string;
            ready?: boolean;
            message?: string;
            conditions?: Array<{
              type: string;
              status: string;
              reason?: string;
              message?: string;
            }>;
          };
        };

        // Kro-specific readiness logic
        const status = instance.status;
        if (!status) {
          readinessLogger.debug('No status found yet, continuing to wait', { instanceName });
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        const state = status.state;
        const conditions = status.conditions || [];
        const syncedCondition = conditions.find((c) => c.type === 'InstanceSynced');

        // Check if status has fields beyond the basic Kro fields (conditions, state)
        const statusKeys = Object.keys(status);
        const basicKroFields = ['conditions', 'state'];
        const hasCustomStatusFields = statusKeys.some((key) => !basicKroFields.includes(key));

        const isActive = state === 'ACTIVE';
        const isSynced = syncedCondition?.status === 'True';

        // Check what status fields are expected by looking at the ResourceGraphDefinition
        let expectedCustomStatusFields = false;
        try {
          // In the new API, methods take request objects and return objects directly
          const rgdResponse = await this.getCustomObjectsApi().getClusterCustomObject({
            group: 'kro.run',
            version: 'v1alpha1',
            plural: 'resourcegraphdefinitions',
            name: this.name,
          });
          const rgd = rgdResponse as any;
          const rgdStatusSchema = rgd.spec?.schema?.status || {};
          const rgdStatusKeys = Object.keys(rgdStatusSchema);
          expectedCustomStatusFields = rgdStatusKeys.length > 0;

          readinessLogger.debug('ResourceGraphDefinition status schema check', {
            rgdName: this.name,
            rgdStatusKeys,
            expectedCustomStatusFields,
          });
        } catch (error) {
          readinessLogger.warn('Could not fetch ResourceGraphDefinition for status schema check', {
            rgdName: this.name,
            error: error instanceof Error ? error.message : String(error),
          });
          // If we can't fetch the RGD, be permissive: if instance is ACTIVE and synced, consider it ready
          expectedCustomStatusFields = false;
        }

        readinessLogger.debug('Kro instance status check', {
          instanceName,
          state,
          isActive,
          isSynced,
          hasCustomStatusFields,
          expectedCustomStatusFields,
          statusKeys,
        });

        // Resource is ready when it's active, synced, and either:
        // 1. Has the expected custom status fields populated, OR
        // 2. No custom status fields are expected (empty status schema in RGD)
        const isReady =
          isActive && isSynced && (hasCustomStatusFields || !expectedCustomStatusFields);

        if (isReady) {
          readinessLogger.info('Kro instance is ready', {
            instanceName,
            hasCustomStatusFields,
            expectedCustomStatusFields,
          });
          return;
        }

        // Check for failure states
        if (state === 'FAILED') {
          const failedCondition = conditions.find((c) => c.status === 'False');
          const errorMessage = failedCondition?.message || 'Unknown error';
          throw new Error(`Kro instance deployment failed: ${errorMessage}`);
        }

        readinessLogger.debug('Kro instance not ready yet, continuing to wait', {
          instanceName,
          state,
          isSynced,
          hasCustomStatusFields,
        });
      } catch (error) {
        const k8sError = error as { statusCode?: number };
        if (k8sError.statusCode !== 404) {
          throw error;
        }
        // Instance not found yet, continue waiting
        readinessLogger.debug('Instance not found yet, continuing to wait', { instanceName });
      }

      // Wait before checking again - use shorter intervals for faster response
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const elapsed = Date.now() - startTime;
    throw new Error(
      `Timeout waiting for Kro instance ${instanceName} to be ready after ${elapsed}ms (timeout: ${timeout}ms). This usually means the Kro controller is not running or the RGD deployment failed. Check Kro controller logs: kubectl logs -n kro-system deployment/kro`
    );
  }

  /**
   * Hydrate dynamic status fields by evaluating CEL expressions against live Kro resource data
   */
  private async hydrateDynamicStatusFields(
    instanceName: string,
    dynamicFields: Record<string, any>
  ): Promise<Record<string, any>> {
    const dynamicLogger = this.logger.child({ instanceName });

    // Get the live custom resource to extract dynamic status fields
    const apiVersion = this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion
      : `kro.run/${this.schemaDefinition.apiVersion}`;

    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
    const response = await k8sApi.read({
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
      },
    });

    // In the new API, methods return objects directly (no .body wrapper)
    const liveInstance = response as any;

    if (!liveInstance.status) {
      dynamicLogger.warn('No status found in live instance, returning empty dynamic fields');
      return {};
    }

    // For now, return the live instance status directly
    // In a full implementation, this would evaluate CEL expressions in dynamicFields
    // against the live Kro resource data and return the evaluated results

    // Extract only the fields that were marked as dynamic
    const hydratedFields: Record<string, any> = {};

    for (const [fieldName, _fieldValue] of Object.entries(dynamicFields)) {
      if (liveInstance.status[fieldName] !== undefined) {
        hydratedFields[fieldName] = liveInstance.status[fieldName];
      }
    }
    return hydratedFields;
  }
}

/**
 * Create a KroResourceFactory instance
 */
export function createKroResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  name: string,
  resources: Record<string, KubernetesResource>,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  statusMappings: any,
  options: FactoryOptions = {}
): KroResourceFactory<TSpec, TStatus> {
  return new KroResourceFactoryImpl<TSpec, TStatus>(
    name,
    resources,
    schemaDefinition,
    statusMappings,
    options
  );
}
