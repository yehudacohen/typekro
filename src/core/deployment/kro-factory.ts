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
import { CRDInstanceError, ensureError, ResourceGraphFactoryError } from '../errors.js';
import type { KubernetesClientProvider } from '../kubernetes/client-provider.js';
import { createBunCompatibleKubernetesObjectApi } from '../kubernetes/index.js';
import { getComponentLogger } from '../logging/index.js';
import { createSchemaProxy, DeploymentMode } from '../references/index.js';
// Dependency inversion: kroCustomResource, resourceGraphDefinition, and
// alchemy bridge are injected via FactoryOptions providers (Phase 3.5)
// instead of dynamic import() from higher layers.
import { getMetadataField } from '../metadata/index.js';
import { getResourceId } from '../resources/id.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';
import { serializeResourceGraphToYaml } from '../serialization/yaml.js';
import type { CelExpression, KubernetesRef } from '../types/common.js';
import type {
  AlchemyBridge,
  AppliedResource,
  DeploymentClosure,
  DeploymentContext,
  FactoryOptions,
  FactoryStatus,
  KroCustomResourceProvider,
  KroResourceFactory,
  ResourceGraphDefinitionProvider,
  RGDStatus,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  SchemaDefinition,
  SchemaProxy,
  Scope,
} from '../types/serialization.js';
import { KubernetesClientManager } from './client-provider-manager.js';
import { DirectDeploymentEngine } from './engine.js';
import { waitForKroInstanceReady as waitForKroInstanceReadyShared } from './kro-readiness.js';
import {
  convertToKubernetesName,
  generateInstanceName,
  pluralizeKind,
  validateSpec,
} from './shared-utilities.js';

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
  private readonly statusMappings: Record<string, unknown>;
  private readonly alchemyScope: Scope | undefined;
  private readonly logger = getComponentLogger('kro-factory');
  private readonly factoryOptions: FactoryOptions;
  private readonly clientManager: KubernetesClientManager;

  // Dependency-inversion providers (Phase 3.5) — injected via FactoryOptions
  // instead of dynamic import() from factories/ and alchemy/ layers.
  private readonly kroCustomResourceProvider: KroCustomResourceProvider | undefined;
  private readonly rgdProvider: ResourceGraphDefinitionProvider | undefined;
  private readonly alchemyBridge: AlchemyBridge | undefined;

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
    this.rgdName = convertToKubernetesName(name); // Convert to valid Kubernetes resource name
    this.resources = resources;
    this.closures = options.closures || {};
    this.schemaDefinition = schemaDefinition;
    this.statusMappings = statusMappings as Record<string, unknown>;
    this.factoryOptions = options;
    this.clientManager = new KubernetesClientManager(options);
    this.schema = createSchemaProxy<TSpec, TStatus>();

    // Injected providers — fall back to dynamic import() for backward compatibility
    this.kroCustomResourceProvider = options.kroCustomResourceProvider;
    this.rgdProvider = options.rgdProvider;
    this.alchemyBridge = options.alchemyBridge;

    // Validate closures for Kro mode - detect KubernetesRef inputs and raise clear errors
    this.validateClosuresForKroMode();
  }

  /** Extract nested composition status CEL mappings from the raw status object. */
  private getNestedStatusCel(): Record<string, string> | undefined {
    return (this.statusMappings as Record<string, unknown>)?.__nestedStatusCel as
      | Record<string, string>
      | undefined;
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
   * Get or create the Kubernetes client provider (lazy initialization)
   */
  private getClientProvider(): KubernetesClientProvider {
    return this.clientManager.getClientProvider();
  }

  /**
   * Get the Kubernetes config from the centralized provider
   */
  private getKubeConfig(): k8s.KubeConfig {
    return this.clientManager.getKubeConfig();
  }

  /**
   * Get CustomObjectsApi client
   */
  private getCustomObjectsApi(): k8s.CustomObjectsApi {
    return this.clientManager.getCustomObjectsApi();
  }

  /**
   * Deploy a new instance by creating a custom resource
   */
  async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // Validate spec against ArkType schema
    validateSpec(spec, this.schemaDefinition, {
      kind: this.schemaDefinition.kind,
      name: this.name,
    });

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
      } catch (error: unknown) {
        // If validation fails, throw the validation error immediately
        if (
          error instanceof Error &&
          error.message.includes('Kro mode does not support dynamic reference resolution')
        ) {
          throw error;
        }
        // For other errors, wrap them with context
        throw new ResourceGraphFactoryError(
          `Failed to validate closure '${closureName}': ${ensureError(error).message}`,
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
      } catch (error: unknown) {
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
          message: ensureError(error).message,
        });
        throw new ResourceGraphFactoryError(
          `Failed to execute closure '${closureName}': ${ensureError(error).message}`,
          this.name,
          'deployment',
          ensureError(error)
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
    const instanceName = generateInstanceName(spec, this.name);
    const customResourceData = this.createCustomResourceInstance(instanceName, spec);

    // Wrap with kroCustomResource factory to get Enhanced object with readiness evaluation
    const kroCustomResource =
      this.kroCustomResourceProvider ??
      (await import('../../factories/kro/kro-custom-resource.js')).kroCustomResource;
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
    await deploymentEngine.deployResource(deployableResource, {
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
    const deployer = this.alchemyBridge
      ? this.alchemyBridge.createDeployer(kroEngine)
      : new (await import('../../alchemy/deployment.js')).KroTypeKroDeployer(kroEngine);

    // 1. Ensure RGD is deployed via alchemy (once per factory)
    const kroSchema = generateKroSchemaFromArktype(
      this.name,
      this.schemaDefinition,
      this.resources,
      this.statusMappings,
      this.getNestedStatusCel()
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
    const rgdFactory =
      this.rgdProvider ??
      (await import('../../factories/kro/resource-graph-definition.js')).resourceGraphDefinition;
    const rgdEnhanced = rgdFactory(rgdManifest);
    const bridge = this.alchemyBridge ?? (await import('../../alchemy/deployment.js'));
    const RGDProvider = bridge.ensureResourceTypeRegistered(rgdEnhanced);
    const rgdId = bridge.createAlchemyResourceId(rgdEnhanced, this.namespace);

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
    const instanceName = generateInstanceName(spec, this.name);
    const crdInstanceManifest = this.createCustomResourceInstance(instanceName, spec);

    // Register CRD instance type dynamically
    // Cast required: crdInstanceManifest is a plain KubernetesResource, but alchemy functions
    // expect Enhanced<unknown, unknown>. They only access kind/metadata.name for type inference.
    const crdAsEnhanced = crdInstanceManifest as unknown as Enhanced<unknown, unknown>;
    const CRDInstanceProvider = bridge.ensureResourceTypeRegistered(crdAsEnhanced);
    const instanceId = bridge.createAlchemyResourceId(crdAsEnhanced, this.namespace);

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
    } catch (error: unknown) {
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
        ensureError(error)
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
      // Delete the instance. KRO's controller processes kro.run/finalizer,
      // which does graph-based deletion of all child resources.
      await k8sApi.delete({
        apiVersion,
        kind: this.schemaDefinition.kind,
        metadata: {
          name,
          namespace: this.namespace,
        },
      } as k8s.KubernetesObject);

      // Wait for KRO to finish cleanup (finalizer processing).
      // KRO needs the RGD to exist during this phase — the caller must
      // not delete the RGD until deleteInstance completes.
      // Cap at 5 minutes — deletion should be faster than deployment.
      // KRO processes ~15-30s per resource for finalizer cleanup.
      const MAX_DELETION_WAIT = 300000;
      const timeout = Math.min(this.factoryOptions.timeout ?? 120000, MAX_DELETION_WAIT);
      const startTime = Date.now();
      let deleted = false;
      while (Date.now() - startTime < timeout) {
        try {
          await k8sApi.read({
            apiVersion,
            kind: this.schemaDefinition.kind,
            metadata: { name, namespace: this.namespace },
          });
          // Still exists — KRO is processing finalizer
          await new Promise(r => setTimeout(r, 2000));
        } catch (pollError: unknown) {
          const pollK8sError = pollError as { statusCode?: number; code?: number; body?: { code?: number } };
          const errorCode = pollK8sError.statusCode ?? pollK8sError.code ?? pollK8sError.body?.code;
          if (errorCode === 404) {
            deleted = true;
            break;
          }
          // Non-404 error (permissions, server error) — log and retry
          this.logger.debug('Deletion poll error (retrying)', {
            name,
            errorCode,
          });
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!deleted) {
        this.logger.warn('Instance deletion timed out — instance may still exist', {
          name,
          timeout,
          elapsed: Date.now() - startTime,
        });
      }
    } catch (error: unknown) {
      const k8sError = error as { statusCode?: number; code?: number; body?: { code?: number }; message?: string };
      const errorCode = k8sError.statusCode ?? k8sError.code ?? k8sError.body?.code;
      if (errorCode !== 404) {
        throw new CRDInstanceError(
          `Failed to delete instance ${name}: ${k8sError.message || String(error)}`,
          this.schemaDefinition.apiVersion,
          this.schemaDefinition.kind,
          name,
          'deletion',
          ensureError(error)
        );
      }
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
    } catch (error: unknown) {
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
        ensureError(error)
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
      const instanceName = generateInstanceName(spec, this.name);
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
        this.statusMappings,
        this.getNestedStatusCel()
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
      this.statusMappings,
      this.getNestedStatusCel()
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
    const rgdFactory =
      this.rgdProvider ??
      (await import('../../factories/kro/resource-graph-definition.js')).resourceGraphDefinition;
    const enhancedRGD = rgdFactory(rgdWithMetadata);

    // Create a deployable resource with the required 'id' field
    const deployableRGD = {
      ...enhancedRGD,
      id: this.rgdName,
    } as DeployableK8sResource<Enhanced<Record<string, unknown>, Record<string, unknown>>>;

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
    } catch (error: unknown) {
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
      } catch (statusError: unknown) {
        this.logger.error('Could not fetch RGD status for debugging', ensureError(statusError));
      }

      throw new ResourceGraphFactoryError(
        `Failed to deploy RGD using DirectDeploymentEngine: ${ensureError(error).message}`,
        this.name,
        'deployment',
        ensureError(error)
      );
    }
  }

  /**
   * Wait for the CRD to be created by Kro using DirectDeploymentEngine
   */
  private async waitForCRDReadyWithEngine(deploymentEngine: DirectDeploymentEngine): Promise<void> {
    const crdName = `${pluralizeKind(this.schemaDefinition.kind)}.kro.run`;

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
    staticFields: Record<string, unknown>;
    dynamicFields: Record<string, unknown>;
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
    staticFields: Record<string, unknown>,
    spec: TSpec
  ): Promise<Record<string, unknown>> {
    const evaluatedFields: Record<string, unknown> = {};

    for (const [fieldName, fieldValue] of Object.entries(staticFields)) {
      if (this.isCelExpression(fieldValue)) {
        try {
          // Evaluate CEL expressions that contain only schema references
          const evaluatedValue = this.evaluateStaticCelExpression(fieldValue, spec);
          evaluatedFields[fieldName] = evaluatedValue;
        } catch (error: unknown) {
          this.logger.warn('Failed to evaluate static CEL expression', {
            field: fieldName,
            expression: fieldValue.expression,
            error: ensureError(error).message,
          });
          // Fallback to the original value
          evaluatedFields[fieldName] = fieldValue;
        }
      } else if (
        typeof fieldValue === 'string' &&
        fieldValue.includes('__KUBERNETES_REF___schema___')
      ) {
        // Resolve __KUBERNETES_REF_ marker strings from template literal coercion.
        // When the composition function uses template literals like `${spec.name}-suffix`,
        // the proxy's Symbol.toPrimitive produces marker strings at runtime. These need
        // to be resolved to actual spec values at deploy time.
        evaluatedFields[fieldName] = this.resolveSchemaRefMarkers(fieldValue, spec);
      } else if (
        typeof fieldValue === 'string' &&
        fieldValue.startsWith('${') &&
        fieldValue.endsWith('}')
      ) {
        // Evaluate inline CEL expression strings produced by the composition AST analyzer.
        // statusOverrides from analyzeCompositionBody write ternary/conditional expressions
        // as plain strings like "${schema.spec.enabled ? 2 : 1}" into statusMappings.
        // These must be evaluated with actual spec values at deploy time.
        try {
          evaluatedFields[fieldName] = this.evaluateInlineCelString(fieldValue, spec);
        } catch (error: unknown) {
          this.logger.warn('Failed to evaluate inline CEL expression string', {
            field: fieldName,
            expression: fieldValue,
            error: ensureError(error).message,
          });
          evaluatedFields[fieldName] = fieldValue;
        }
      } else if (
        typeof fieldValue === 'object' &&
        fieldValue !== null &&
        !Array.isArray(fieldValue)
      ) {
        // Recursively evaluate nested objects
        evaluatedFields[fieldName] = await this.evaluateStaticFields(
          fieldValue as Record<string, unknown>,
          spec
        );
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
    // Use null-prototype object to prevent prototype chain access (defense-in-depth).
    // angular-expressions has hasOwnProperty guards, but a null-prototype scope
    // eliminates any residual risk from constructor/toString/__proto__ leaking.
    // Object.freeze prevents expression-based mutation of the original spec data.
    const specRecord = Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, spec)
    );

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
    } catch (error: unknown) {
      // If evaluation fails, the expression might be an unquoted string like: http://kro-webapp-service
      // In this case, return it as-is (it's already a string value)
      if (!expression.includes('schema.spec.') && !expression.includes('spec.')) {
        this.logger.debug('Static expression evaluation failed, returning as string literal', {
          expression,
          error: ensureError(error).message,
        });
        return expression;
      }
      this.logger.warn('Failed to evaluate expression safely', {
        expression: scopeExpression,
        originalExpression: expression,
        error: ensureError(error).message,
      });
      throw error;
    }
  }

  /**
   * Resolve `__KUBERNETES_REF___schema___<fieldPath>__` markers in a string.
   *
   * When a composition function uses template literals like `` `${spec.name}-suffix` ``,
   * the magic proxy's Symbol.toPrimitive returns a marker string at composition time.
   * At deploy time we replace each marker with the actual spec value.
   */
  private resolveSchemaRefMarkers(value: string, spec: TSpec): unknown {
    const resolved = value.replace(
      /__KUBERNETES_REF___schema___([a-zA-Z0-9.$]+)__/g,
      (_match, fieldPath: string) => {
        // fieldPath is e.g. "spec.name" or "spec.nested.field"
        const parts = fieldPath.replace(/^spec\./, '').split('.');
        let current: unknown = spec;
        for (const part of parts) {
          if (current != null && typeof current === 'object') {
            current = (current as Record<string, unknown>)[part];
          } else {
            this.logger.warn('Could not resolve schema ref marker', {
              marker: _match,
              fieldPath,
              failedAt: part,
            });
            return _match; // Keep marker if unresolvable
          }
        }
        return String(current ?? '');
      }
    );
    return resolved;
  }

  /**
   * Evaluate an inline CEL expression string like `"${schema.spec.enabled ? 2 : 1}"`.
   *
   * The composition body AST analyzer produces these for ternary expressions in
   * status return values (statusOverrides). They are plain strings wrapping a CEL
   * expression that must be evaluated with the real spec values.
   */
  private evaluateInlineCelString(celString: string, spec: TSpec): unknown {
    // Strip the wrapping ${ ... }
    const innerExpression = celString.slice(2, -1);

    // Build scope expression: strip schema.spec. / spec. prefixes
    let scopeExpression = innerExpression;
    if (scopeExpression.includes('schema.spec.')) {
      scopeExpression = scopeExpression.replace(/schema\.spec\.(\w+)/g, '$1');
    }
    if (scopeExpression.includes('spec.')) {
      scopeExpression = scopeExpression.replace(/\bspec\.(\w+)/g, '$1');
    }

    // Resolve any __KUBERNETES_REF_ markers that may be embedded in the expression
    // (e.g. from template literals inside ternary branches)
    if (scopeExpression.includes('__KUBERNETES_REF___schema___')) {
      scopeExpression = scopeExpression.replace(
        /__KUBERNETES_REF___schema___([a-zA-Z0-9.$]+)__/g,
        (_match, fieldPath: string) => {
          const parts = fieldPath.replace(/^spec\./, '').split('.');
          return parts.join('.');
        }
      );
    }

    // Convert CEL single-quoted string literals to double-quoted for angular-expressions
    // Match single-quoted strings that are NOT inside backticks
    scopeExpression = scopeExpression.replace(/'([^'\\]*)'/g, '"$1"');

    const specRecord = Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, spec)
    );
    const evaluator = compileExpression(scopeExpression);
    return evaluator(specRecord) as unknown;
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
      // Type cast: constructing a partial Enhanced proxy — only metadata.name and spec
      // are accessed by callers at this call site. TypeScript cannot verify structural
      // completeness; callers are responsible for only accessing these fields.
    } as unknown as Enhanced<TSpec, TStatus>;

    // Hydrate dynamic status fields if enabled and there are dynamic fields
    if (this.factoryOptions.hydrateStatus !== false && Object.keys(dynamicFields).length > 0) {
      try {
        const hydratedDynamicFields = await this.hydrateDynamicStatusFields(
          instanceName,
          dynamicFields
        );

        // Merge evaluated static fields with dynamic fields from KRO.
        // Use evaluatedStaticFields (resolved markers) not raw staticFields.
        const mergedStatus = {
          ...evaluatedStaticFields,
          ...hydratedDynamicFields, // Dynamic fields from Kro override
        };

        // Update the status using object assignment to avoid type issues
        Object.assign(enhancedProxy.status, mergedStatus);
      } catch (error: unknown) {
        hydrationLogger.error('Dynamic status hydration failed', ensureError(error));
        // Continue with static fields only if dynamic hydration fails
      }
    }

    // Post-process: re-execute the composition with live cluster data to fill
    // in status fields that neither static evaluation nor KRO could provide.
    if (this.factoryOptions.compositionFn) {
      try {
        const liveStatus = await this.reExecuteWithLiveStatus(spec);
        if (liveStatus) {
          for (const [key, value] of Object.entries(liveStatus)) {
            if (key.startsWith('__')) continue;
            const current = (enhancedProxy.status as Record<string, unknown>)[key];
            if (current === undefined || current === null || current === '') {
              (enhancedProxy.status as Record<string, unknown>)[key] = value;
            }
          }
        }
      } catch (error: unknown) {
        hydrationLogger.warn('Live status re-execution failed (non-fatal)', {
          error: ensureError(error).message,
        });
      }
    }

    return enhancedProxy;
  }

  /**
   * Re-execute the composition function with live cluster data to hydrate
   * status fields that KRO couldn't compute.
   */
  private async reExecuteWithLiveStatus(spec: TSpec): Promise<TStatus | null> {
    const compositionFn = this.factoryOptions.compositionFn;
    if (!compositionFn) return null;

    const { createCompositionContext, runWithCompositionContext } = await import(
      '../composition/context.js'
    );
    const { synthesizeNestedCompositionStatus } = await import(
      './nested-composition-status.js'
    );

    // Build a live status map from deployed resources
    const liveStatusMap = new Map<string, Record<string, unknown>>();
    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    for (const [resourceId, resource] of Object.entries(this.resources)) {
      try {
        const name =
          typeof resource.metadata?.name === 'string'
            ? resource.metadata.name
            : resourceId;
        const ns =
          typeof resource.metadata?.namespace === 'string'
            ? resource.metadata.namespace
            : this.namespace;

        const isClusterScoped = getMetadataField(resource, 'scope') === 'cluster';
        const live = await k8sApi.read({
          apiVersion: resource.apiVersion || '',
          kind: resource.kind || '',
          metadata: { name, ...(isClusterScoped ? {} : { namespace: ns }) },
        });

        if (live && typeof live === 'object' && 'status' in live) {
          liveStatusMap.set(
            resourceId,
            (live as Record<string, unknown>).status as Record<string, unknown>
          );
        }
      } catch {
        // Resource may not exist or may not have status
      }
    }

    // Probe to discover nested composition IDs
    const probeContext = createCompositionContext('kro-re-execution-probe', {
      deduplicateIds: true,
    });
    probeContext.liveStatusMap = liveStatusMap;
    runWithCompositionContext(probeContext, () => compositionFn(spec));

    // Synthesize nested composition status
    const enrichedMap = synthesizeNestedCompositionStatus(
      probeContext.resources,
      liveStatusMap,
      this.logger,
      probeContext.nestedCompositionIds
    );

    // Real execution with live status
    const reExecutionContext = createCompositionContext('kro-re-execution', {
      deduplicateIds: true,
    });
    reExecutionContext.liveStatusMap = enrichedMap;

    const result = runWithCompositionContext(reExecutionContext, () =>
      compositionFn(spec)
    );
    return result as TStatus;
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
   * Wait for Kro instance to be ready with Kro-specific logic.
   * Delegates to the shared `waitForKroInstanceReady` in `kro-readiness.ts`.
   */
  private async waitForKroInstanceReady(instanceName: string, timeout: number): Promise<void> {
    const apiVersion = this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion
      : `kro.run/${this.schemaDefinition.apiVersion}`;

    const kubeConfig = this.getKubeConfig();
    const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);

    return waitForKroInstanceReadyShared({
      instanceName,
      timeout,
      k8sApi,
      customObjectsApi: this.getCustomObjectsApi(),
      namespace: this.namespace,
      apiVersion,
      kind: this.schemaDefinition.kind,
      rgdName: this.name,
      factoryContext: this.name,
    });
  }

  /**
   * Hydrate dynamic status fields by evaluating CEL expressions against live Kro resource data
   */
  private async hydrateDynamicStatusFields(
    instanceName: string,
    dynamicFields: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
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
    const hydratedFields: Record<string, unknown> = {};

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
  statusMappings: Record<string, unknown>,
  options: FactoryOptions = {}
): KroResourceFactory<TSpec, TStatus> {
  return new KroResourceFactoryImpl<TSpec, TStatus>(
    name,
    resources,
    schemaDefinition,
    statusMappings as MagicAssignableShape<TStatus>,
    options
  );
}
