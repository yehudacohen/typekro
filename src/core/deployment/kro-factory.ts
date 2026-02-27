/**
 * KroResourceFactory implementation for Kro deployment mode
 *
 * This factory handles deployment via Kro ResourceGraphDefinitions,
 * using the Kro controller for dependency resolution and resource management.
 */

import * as k8s from '@kubernetes/client-node';
import { compile as compileExpression } from 'angular-expressions';
import { preserveNonEnumerableProperties } from '../../utils/helpers.js';
import {
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_KRO_INSTANCE_TIMEOUT,
  DEFAULT_RGD_TIMEOUT,
} from '../config/defaults.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import {
  CRDInstanceError,
  DeploymentTimeoutError,
  ResourceGraphFactoryError,
  ValidationError,
} from '../errors.js';
import {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  type KubernetesClientConfig,
  type KubernetesClientProvider,
} from '../kubernetes/client-provider.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { createSchemaProxy, DeploymentMode } from '../references/index.js';
// NOTE: alchemy/deployment.js is loaded via dynamic import() at point of use
// to avoid a core/ → alchemy/ static dependency.
// See deployViaAlchemy() and deployRGDViaAlchemy().
// NOTE: kroCustomResource and resourceGraphDefinition are loaded via dynamic
// import() at point of use to avoid a core/ → factories/ static dependency.
// See deployViaAlchemy(), deployRGDViaAlchemy(), and deployWithDirectEngine().
import { getResourceId } from '../resources/id.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';
import { serializeResourceGraphToYaml } from '../serialization/yaml.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';
import type {
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
  FactoryOptions,
  FactoryStatus,
  KroResourceFactory,
  RGDStatus,
} from '../types/deployment.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KubernetesResource,
  RGDManifest,
} from '../types/kubernetes.js';
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
      throw new ValidationError(
        `Invalid resource graph name: ${JSON.stringify(name)}. Resource graph name must be a non-empty string.`,
        'ResourceGraphDefinition',
        String(name),
        'name',
        ['Provide a non-empty string for the resource graph name']
      );
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new ValidationError(
        `Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`,
        'ResourceGraphDefinition',
        name,
        'name',
        ['Provide a non-whitespace resource graph name']
      );
    }

    // Convert to kebab-case and validate result
    const kubernetesName = trimmedName
      .replace(/([a-z])([A-Z])/g, '$1-$2') // Insert dash before capital letters
      .toLowerCase(); // Convert to lowercase

    // Validate Kubernetes naming conventions
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
      throw new ValidationError(
        `Invalid resource graph name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
        'ResourceGraphDefinition',
        name,
        'name',
        [
          'Use lowercase alphanumeric characters and hyphens only',
          'Must start and end with an alphanumeric character',
        ]
      );
    }

    if (kubernetesName.length > 253) {
      throw new ValidationError(
        `Invalid resource graph name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`,
        'ResourceGraphDefinition',
        name,
        'name',
        ['Shorten the resource graph name to stay under 253 characters']
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
      throw new ValidationError(
        `Invalid spec: ${validationResult.message}`,
        this.schemaDefinition.kind,
        this.name,
        undefined,
        ['Check the spec against the schema definition']
      );
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
      // kubernetesApi intentionally omitted - not needed for validation
      namespace: this.namespace,
      deployedResources: new Map(),
      resolveReference: async (ref: KubernetesRef) => {
        throw new ResourceGraphFactoryError(
          `Kro mode does not support dynamic reference resolution. Found reference: ${ref.resourceId}.${ref.fieldPath}`,
          this.name,
          'deployment'
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
        throw new ResourceGraphFactoryError(
          `Failed to validate closure '${closureName}': ${error}`,
          this.name,
          'deployment'
        );
      }
    }

    const allResults: AppliedResource[] = [];

    // Only create deployment context after validation passes
    // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
    const kubeConfig = this.getKubeConfig();
    const deploymentContext: DeploymentContext = {
      kubernetesApi: createBunCompatibleKubernetesObjectApi(kubeConfig),
      kubeConfig: kubeConfig,
      ...(this.alchemyScope && { alchemyScope: this.alchemyScope }),
      namespace: this.namespace,
      deployedResources: new Map(), // Empty for pre-RGD execution
      resolveReference: async (ref: KubernetesRef) => {
        throw new ResourceGraphFactoryError(
          `Kro mode does not support dynamic reference resolution. Found reference: ${ref.resourceId}.${ref.fieldPath}`,
          this.name,
          'deployment'
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
        throw new ResourceGraphFactoryError(
          `Failed to execute closure '${closureName}': ${error instanceof Error ? error.message : String(error)}`,
          this.name,
          'deployment',
          error instanceof Error ? error : undefined
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
    const { kroCustomResource } = await import('../../factories/kro/kro-custom-resource.js');
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

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedCustomResource, deployableResource);

    // Deploy without waiting for readiness - we'll handle that ourselves
    this.logger.info('Deploying Kro instance', { instanceName, rgdName: this.rgdName });
    const _deployedResource = await deploymentEngine.deployResource(deployableResource, {
      mode: 'kro',
      namespace: this.namespace,
      waitForReady: false, // We'll handle Kro-specific readiness ourselves
      timeout: this.factoryOptions.timeout || DEFAULT_DEPLOYMENT_TIMEOUT,
    });
    this.logger.info('Instance deployed, checking readiness', {
      instanceName,
      rgdName: this.rgdName,
    });

    // Handle Kro-specific readiness checking if requested
    if (this.factoryOptions.waitForReady ?? true) {
      await this.waitForKroInstanceReady(
        instanceName,
        this.factoryOptions.timeout || DEFAULT_KRO_INSTANCE_TIMEOUT
      ); // 10 minutes
    }
    this.logger.info('Instance ready, creating enhanced proxy', {
      instanceName,
      rgdName: this.rgdName,
    });

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
      throw new ResourceGraphFactoryError(
        'Alchemy scope is required for alchemy deployment',
        this.name,
        'deployment'
      );
    }

    // Use static registration functions

    // Create deployer instance using DirectDeploymentEngine with KRO mode
    const kroEngine = new DirectDeploymentEngine(
      this.getKubeConfig(),
      undefined,
      undefined,
      DeploymentMode.KRO
    );
    const { KroTypeKroDeployer } = await import('../../alchemy/deployment.js');
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
          id: getResourceId(resource),
          template: resource,
        })),
      },
    };

    // Register RGD type dynamically
    const { resourceGraphDefinition } = await import(
      '../../factories/kro/resource-graph-definition.js'
    );
    const rgdEnhanced = resourceGraphDefinition(rgdManifest);
    const { ensureResourceTypeRegistered, createAlchemyResourceId } = await import(
      '../../alchemy/deployment.js'
    );
    const RGDProvider = ensureResourceTypeRegistered(rgdEnhanced);
    const rgdId = createAlchemyResourceId(rgdEnhanced, this.namespace);

    await RGDProvider(rgdId, {
      resource: rgdEnhanced,
      namespace: this.namespace,
      deployer: deployer,
      options: {
        waitForReady: true,
        timeout: DEFAULT_RGD_TIMEOUT, // RGD should be ready quickly
      },
    });

    // 2. Create instance via alchemy (once per deploy call)
    const instanceName = this.generateInstanceName(spec);
    const crdInstanceManifest = this.createCustomResourceInstance(instanceName, spec);

    // Register CRD instance type dynamically
    // Cast required: crdInstanceManifest is a plain KubernetesResource, but alchemy functions
    // expect Enhanced<unknown, unknown>. They only access kind/metadata.name for type inference.
    const crdAsEnhanced = crdInstanceManifest as unknown as Enhanced<unknown, unknown>;
    const CRDInstanceProvider = ensureResourceTypeRegistered(crdAsEnhanced);
    const instanceId = createAlchemyResourceId(crdAsEnhanced, this.namespace);

    await CRDInstanceProvider(instanceId, {
      resource: crdAsEnhanced,
      namespace: this.namespace,
      deployer: deployer,
      options: {
        waitForReady: this.factoryOptions.waitForReady ?? true,
        timeout: this.factoryOptions.timeout ?? DEFAULT_DEPLOYMENT_TIMEOUT,
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
      throw new CRDInstanceError(
        `Failed to list instances: ${k8sError.message || String(error)}`,
        this.schemaDefinition.apiVersion,
        this.schemaDefinition.kind,
        '*',
        'statusResolution',
        error instanceof Error ? error : new Error(String(error))
      );
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
        throw new CRDInstanceError(
          `Failed to delete instance ${name}: ${k8sError.message || String(error)}`,
          this.schemaDefinition.apiVersion,
          this.schemaDefinition.kind,
          name,
          'deletion',
          error instanceof Error ? error : new Error(String(error))
        );
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
      throw new ResourceGraphFactoryError(
        `Failed to get RGD status: ${k8sError.message || String(error)}`,
        this.name,
        'getInstance',
        error instanceof Error ? error : new Error(String(error))
      );
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
    const { resourceGraphDefinition: rgdFactory } = await import(
      '../../factories/kro/resource-graph-definition.js'
    );
    const enhancedRGD = rgdFactory(rgdWithMetadata);

    // Create a deployable resource with the required 'id' field
    const deployableRGD = {
      ...enhancedRGD,
      id: this.rgdName,
    } as DeployableK8sResource<Enhanced<unknown, unknown>>;

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedRGD, deployableRGD);

    // Debug: Log the RGD being deployed
    this.logger.debug('Deploying RGD', {
      rgdName: this.rgdName,
      rgdManifest: JSON.stringify(rgdWithMetadata, null, 2),
    });

    try {
      // Deploy RGD using DirectDeploymentEngine with readiness checking
      this.logger.info('Deploying RGD via engine', { rgdName: this.rgdName });
      await deploymentEngine.deployResource(deployableRGD, {
        mode: 'direct',
        namespace: this.namespace,
        waitForReady: true,
        timeout: this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
      });
      this.logger.info('RGD deployed, waiting for CRD', { rgdName: this.rgdName });

      // Wait for the CRD to be created by Kro using DirectDeploymentEngine
      await this.waitForCRDReadyWithEngine(deploymentEngine);
      this.logger.info('CRD ready', { rgdName: this.rgdName });
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

      throw new ResourceGraphFactoryError(
        `Failed to deploy RGD using DirectDeploymentEngine: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        'deployment',
        error instanceof Error ? error : undefined
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
      throw new ResourceGraphFactoryError(
        `deploymentEngine.waitForCRDReady is not a function. Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(deploymentEngine)).join(', ')}`,
        this.name,
        'deployment'
      );
    }

    // Use the deployment engine's built-in CRD readiness checking
    // This will wait for the CRD to be created by Kro and become ready
    await deploymentEngine.waitForCRDReady(
      crdName,
      this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT
    );
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
   * Evaluate a static CEL expression that contains only schema references or literal values.
   *
   * Uses `angular-expressions` for safe AST-based evaluation instead of `new Function()` / `eval()`.
   * Spec field references (e.g., `schema.spec.name`, `spec.replicas`) are resolved by passing the
   * spec values as a scope object, eliminating string interpolation injection risks entirely.
   */
  private evaluateStaticCelExpression(celExpression: CelExpression, spec: TSpec): unknown {
    const expression = celExpression.expression;
    const specRecord = spec as Record<string, unknown>;

    // Build a scope expression by stripping schema.spec. or spec. prefixes so that
    // angular-expressions can resolve field references directly from the spec scope.
    let scopeExpression = expression;

    if (expression.includes('schema.spec.')) {
      // Replace schema.spec.fieldName → fieldName (resolved from scope)
      scopeExpression = scopeExpression.replace(/schema\.spec\.(\w+)/g, '$1');
    }

    if (scopeExpression.includes('spec.')) {
      // Replace spec.fieldName → fieldName (resolved from scope)
      scopeExpression = scopeExpression.replace(/\bspec\.(\w+)/g, '$1');
    }

    try {
      const evaluator = compileExpression(scopeExpression);
      const result = evaluator(specRecord) as unknown;
      return result;
    } catch (error) {
      // If evaluation fails, the expression might be an unquoted string like: http://kro-webapp-service
      // In this case, return it as-is (it's already a string value)
      if (!expression.includes('schema.spec.') && !expression.includes('spec.')) {
        this.logger.debug('Static expression evaluation failed, returning as string literal', {
          expression,
          error: (error as Error).message,
        });
        return expression;
      }
      this.logger.warn('Failed to evaluate expression safely', {
        expression: scopeExpression,
        originalExpression: expression,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Check if a value is a CEL expression (using canonical brand symbol)
   */
  private isCelExpression(value: unknown): value is CelExpression {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return (
      CEL_EXPRESSION_BRAND in value &&
      (value as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true &&
      'expression' in value &&
      typeof (value as Record<string, unknown>).expression === 'string'
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
        hydrationLogger.error('Dynamic status hydration failed', error as Error);
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
        // Support both Kro v0.3.x (InstanceSynced) and v0.8.x (Ready) conditions
        const syncedCondition = conditions.find((c) => c.type === 'InstanceSynced');
        const readyCondition = conditions.find((c) => c.type === 'Ready');

        // Check if status has fields beyond the basic Kro fields (conditions, state)
        const statusKeys = Object.keys(status);
        const basicKroFields = ['conditions', 'state'];
        const hasCustomStatusFields = statusKeys.some((key) => !basicKroFields.includes(key));

        const isActive = state === 'ACTIVE';
        const isSynced = syncedCondition?.status === 'True' || readyCondition?.status === 'True';

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
          // CustomObjectsApi returns untyped objects — cast to RGDManifest for type-safe access
          const rgd = rgdResponse as RGDManifest;
          const rgdStatusSchema = rgd.spec?.schema?.status ?? {};
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

        // Check for failure states (Kro v0.8.x uses "ERROR", v0.3.x uses "FAILED")
        if (state === 'FAILED' || state === 'ERROR') {
          const failedCondition = conditions.find((c) => c.status === 'False');
          const errorMessage = failedCondition?.message || 'Unknown error';
          throw new CRDInstanceError(
            `Kro instance deployment failed (state=${state}): ${errorMessage}`,
            this.schemaDefinition.apiVersion,
            this.schemaDefinition.kind,
            instanceName,
            'creation'
          );
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
    throw new DeploymentTimeoutError(
      `Timeout waiting for Kro instance ${instanceName} to be ready after ${elapsed}ms (timeout: ${timeout}ms). This usually means the Kro controller is not running or the RGD deployment failed. Check Kro controller logs: kubectl logs -n kro-system deployment/kro`,
      this.schemaDefinition.kind,
      instanceName,
      timeout,
      'instance-readiness'
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
    const liveInstance = response as { status?: Record<string, unknown> };

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
