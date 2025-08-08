/**
 * KroResourceFactory implementation for Kro deployment mode
 * 
 * This factory handles deployment via Kro ResourceGraphDefinitions,
 * using the Kro controller for dependency resolution and resource management.
 */

import * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';

import type {
  FactoryOptions,
  FactoryStatus,
  KroResourceFactory,
  RGDStatus,
} from '../types/deployment.js';
import type { Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType } from '../types/serialization.js';
import type { SchemaDefinition, SchemaProxy } from '../types/serialization.js';
// Alchemy integration
import type { Scope } from '../types/serialization.js';
import { createSchemaProxy } from '../references/index.js';
import { generateKroSchemaFromArktype } from '../serialization/schema.js';
import { serializeResourceGraphToYaml } from '../serialization/yaml.js';
import { DirectDeploymentEngine } from './engine.js';
import { resourceGraphDefinition } from '../../factories/kro/resource-graph-definition.js';
import { kroCustomResourceDefinition } from '../../factories/kro/kro-crd.js';


/**
 * KroResourceFactory implementation
 * 
 * Handles deployment via Kro ResourceGraphDefinitions. The RGD is deployed once,
 * and then instances are created as custom resources that the Kro controller processes.
 */
export class KroResourceFactoryImpl<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType
> implements KroResourceFactory<TSpec, TStatus> {
  readonly mode = 'kro' as const;
  readonly name: string;
  readonly namespace: string;
  readonly isAlchemyManaged: boolean;
  readonly rgdName: string;
  readonly schema: SchemaProxy<TSpec, TStatus>;

  private readonly resources: Record<string, KubernetesResource>;
  private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
  private readonly statusMappings: any;
  private readonly alchemyScope: Scope | undefined;
  private readonly factoryOptions: FactoryOptions;
  private readonly logger = getComponentLogger('kro-factory');
  private kubeConfig?: k8s.KubeConfig;

  constructor(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    statusMappings: any,
    options: FactoryOptions = {}
  ) {
    this.name = name;
    this.namespace = options.namespace || 'default';
    this.alchemyScope = options.alchemyScope;
    this.isAlchemyManaged = !!options.alchemyScope;
    this.rgdName = this.convertToKubernetesName(name); // Convert to valid Kubernetes resource name
    this.resources = resources;
    this.schemaDefinition = schemaDefinition;
    this.statusMappings = statusMappings;
    this.factoryOptions = options;
    this.schema = createSchemaProxy<TSpec, TStatus>();

    // Don't initialize Kubernetes client in constructor - do it lazily
  }

  /**
   * Convert camelCase resource graph name to valid Kubernetes resource name (kebab-case)
   */
  private convertToKubernetesName(name: string): string {
    // Validate input name
    if (!name || typeof name !== 'string') {
      throw new Error(`Invalid resource graph name: ${JSON.stringify(name)}. Resource graph name must be a non-empty string.`);
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new Error(`Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`);
    }

    // Convert to kebab-case and validate result
    const kubernetesName = trimmedName
      .replace(/([a-z])([A-Z])/g, '$1-$2') // Insert dash before capital letters
      .toLowerCase(); // Convert to lowercase

    // Validate Kubernetes naming conventions
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
      throw new Error(`Invalid resource graph name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`);
    }

    if (kubernetesName.length > 253) {
      throw new Error(`Invalid resource graph name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`);
    }

    return kubernetesName;
  }

  /**
   * Get or create the Kubernetes config
   */
  private getKubeConfig(): k8s.KubeConfig {
    let kubeConfig = this.factoryOptions.kubeConfig || this.kubeConfig;
    if (!kubeConfig) {
      kubeConfig = new k8s.KubeConfig();
      kubeConfig.loadFromDefault();
    }
    return kubeConfig;
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

    if (this.isAlchemyManaged) {
      return this.deployWithAlchemy(spec);
    } else {
      return this.deployDirect(spec);
    }
  }

  /**
   * Deploy directly to Kubernetes
   */
  private async deployDirect(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
    // Ensure RGD is deployed first
    await this.ensureRGDDeployed();

    // Create custom resource instance
    const instanceName = this.generateInstanceName(spec);
    const customResource = this.createCustomResourceInstance(instanceName, spec);

    // Deploy the custom resource using CustomObjectsApi
    const customApi = this.getKubeConfig().makeApiClient(k8s.CustomObjectsApi);

    // Extract API group and version from the custom resource
    const apiVersionParts = customResource.apiVersion.split('/');
    const group: string = apiVersionParts.length > 1 ? (apiVersionParts[0] || 'kro.run') : 'kro.run';
    const version: string = apiVersionParts.length > 1 ? (apiVersionParts[1] || 'v1alpha1') : (apiVersionParts[0] || 'v1alpha1');
    const plural = `${this.schemaDefinition.kind.toLowerCase()}s`; // Simple pluralization

    try {
      await customApi.createNamespacedCustomObject(
        group,
        version,
        this.namespace,
        plural,
        customResource
      );
    } catch (error) {
      const k8sError = error as { statusCode?: number; message?: string };
      if (k8sError.statusCode === 409) {
        // Resource already exists, update it
        await customApi.patchNamespacedCustomObject(
          group,
          version,
          this.namespace,
          plural,
          customResource.metadata.name,
          customResource
        );
      } else {
        throw new Error(`Failed to create custom resource instance: ${k8sError.message || String(error)}`);
      }
    }

    // Wait for the instance to be ready if requested
    if (this.factoryOptions.waitForReady) {
      await this.waitForInstanceReady(instanceName);
    }

    // Create Enhanced proxy for the instance
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

    // Import dynamic registration functions
    const { ensureResourceTypeRegistered, KroTypeKroDeployer, createAlchemyResourceId } = await import('../../alchemy/deployment.js');
    const { KroDeploymentEngine } = await import('../../factories/kro/deployment-engine.js');

    // Create deployer instance
    const kroEngine = new KroDeploymentEngine(this.getKubeConfig());
    const deployer = new KroTypeKroDeployer(kroEngine);

    // 1. Ensure RGD is deployed via alchemy (once per factory)
    const kroSchema = generateKroSchemaFromArktype(this.name, this.schemaDefinition, this.resources, this.statusMappings);
    const rgdManifest = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: {
        name: this.rgdName,
        namespace: this.namespace,
      },
      spec: {
        schema: kroSchema,
        resources: Object.values(this.resources).map(resource => ({
          id: resource.id || resource.metadata?.name || 'unknown',
          template: resource,
        })),
      },
    };

    // Register RGD type dynamically
    const RGDProvider = ensureResourceTypeRegistered(rgdManifest as any);
    const rgdId = createAlchemyResourceId(rgdManifest as any, this.namespace);

    await RGDProvider(rgdId, {
      resource: rgdManifest as any,
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
    const customApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

    try {
      // The schema definition should contain just the version part (e.g., 'v1alpha1')
      // If it somehow contains the full API version, extract just the version part
      const version = this.schemaDefinition.apiVersion.includes('/')
        ? this.schemaDefinition.apiVersion.split('/')[1] || this.schemaDefinition.apiVersion
        : this.schemaDefinition.apiVersion;

      const listResponse = await customApi.listNamespacedCustomObject(
        'kro.run',
        version,
        this.namespace,
        `${this.schemaDefinition.kind.toLowerCase()}s` // Pluralize the kind
      );

      const instances = (listResponse.body as any).items || [];

      return await Promise.all(instances.map(async (instance: any) => {
        return await this.createEnhancedProxy(instance.spec, instance.metadata.name);
      }));
    } catch (error) {
      const k8sError = error as { message?: string; body?: string; statusCode?: number };
      // If the CRD doesn't exist yet or there are no instances, return empty array
      if (
        k8sError.message?.includes('not found') ||
        k8sError.message?.includes('404') ||
        k8sError.body?.includes('not found') ||
        k8sError.body?.includes('404') ||
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
    const k8sApi = k8s.KubernetesObjectApi.makeApiClient(this.getKubeConfig());

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
    const k8sApi = k8s.KubernetesObjectApi.makeApiClient(this.getKubeConfig());

    try {
      const response = await k8sApi.read({
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: {
          name: this.rgdName,
          namespace: this.namespace,
        },
      });

      const rgd = response.body as k8s.KubernetesObject & {
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
        const hasFailedCondition = rgd.status?.conditions?.some(c => c.status === 'False');
        phase = hasFailedCondition ? 'failed' : 'pending';
      }

      return {
        name: this.rgdName,
        phase,
        conditions: rgd.status?.conditions || [],
        observedGeneration: rgd.status?.observedGeneration || 0,
      };
    } catch (error) {
      const k8sError = error as { statusCode?: number; message?: string };
      if (k8sError.statusCode === 404) {
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
${Object.entries(spec as Record<string, any>).map(([key, value]) => `  ${key}: ${typeof value === 'string' ? `"${value}"` : value}`).join('\n')}`;
    } else {
      // Generate RGD YAML
      const kroSchema = generateKroSchemaFromArktype(this.name, this.schemaDefinition, this.resources, this.statusMappings);
      return serializeResourceGraphToYaml(this.rgdName, this.resources, { namespace: this.namespace }, kroSchema);
    }
  }

  /**
   * Ensure the ResourceGraphDefinition is deployed using DirectDeploymentEngine
   */
  private async ensureRGDDeployed(): Promise<void> {
    // Create DirectDeploymentEngine instance
    const deploymentEngine = new DirectDeploymentEngine(this.getKubeConfig());

    // Create the RGD using the same serialization logic as toYaml()
    const kroSchema = generateKroSchemaFromArktype(this.name, this.schemaDefinition, this.resources, this.statusMappings);
    const rgdYaml = serializeResourceGraphToYaml(this.rgdName, this.resources, { namespace: this.namespace }, kroSchema);

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
      }
    };

    // Create Enhanced RGD with readiness evaluator
    const enhancedRGD = resourceGraphDefinition(rgdWithMetadata);

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
      throw new Error(`Failed to deploy RGD using DirectDeploymentEngine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Wait for RGD to be ready using DirectDeploymentEngine
   * This method is now handled by DirectDeploymentEngine.deployResource() with waitForReady: true
   */
  private async waitForRGDReadyWithEngine(deploymentEngine: DirectDeploymentEngine): Promise<void> {
    // Create Enhanced RGD for readiness checking
    const rgdManifest = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: {
        name: this.rgdName,
        namespace: this.namespace,
      },
    };

    const enhancedRGD = resourceGraphDefinition(rgdManifest);

    // Use DirectDeploymentEngine to wait for RGD readiness
    const deployedRGD = {
      id: this.rgdName,
      kind: 'ResourceGraphDefinition',
      name: this.rgdName,
      namespace: this.namespace,
      manifest: enhancedRGD,
      status: 'deployed' as const,
      deployedAt: new Date(),
    };

    // This will use the custom readiness evaluator from resourceGraphDefinition()
    await deploymentEngine.waitForResourceReadiness(deployedRGD, {
      mode: 'direct',
      namespace: this.namespace,
      timeout: this.factoryOptions.timeout || 60000,
    });
  }

  /**
   * Wait for the CRD to be created by Kro using DirectDeploymentEngine
   */
  private async waitForCRDReadyWithEngine(deploymentEngine: DirectDeploymentEngine): Promise<void> {
    const crdName = `${this.schemaDefinition.kind.toLowerCase()}s.kro.run`;
    
    // Create Enhanced CRD for readiness checking
    const crdManifest = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: {
        name: crdName,
        // CRDs are cluster-scoped, so no namespace
      },
    };

    const enhancedCRD = kroCustomResourceDefinition(crdManifest as any);

    // Use DirectDeploymentEngine to wait for CRD readiness
    const deployedCRD = {
      id: crdName,
      kind: 'CustomResourceDefinition',
      name: crdName,
      namespace: '', // CRDs are cluster-scoped
      manifest: enhancedCRD,
      status: 'deployed' as const,
      deployedAt: new Date(),
    };

    // This will use the custom readiness evaluator from kroCustomResourceDefinition()
    await deploymentEngine.waitForResourceReadiness(deployedCRD, {
      mode: 'direct',
      namespace: '', // CRDs are cluster-scoped
      timeout: this.factoryOptions.timeout || 60000,
    });
  }

  /**
   * Wait for instance to be ready
   */
  private async waitForInstanceReady(instanceName: string): Promise<void> {
    const timeout = this.factoryOptions.timeout || 60000;
    const startTime = Date.now();
    const readinessLogger = this.logger.child({ instanceName, rgdName: this.name });

    while (Date.now() - startTime < timeout) {
      try {
        const apiVersion = this.schemaDefinition.apiVersion.includes('/')
          ? this.schemaDefinition.apiVersion
          : `kro.run/${this.schemaDefinition.apiVersion}`;

        const k8sApi = k8s.KubernetesObjectApi.makeApiClient(this.getKubeConfig());
        const response = await k8sApi.read({
          apiVersion,
          kind: this.schemaDefinition.kind,
          metadata: {
            name: instanceName,
            namespace: this.namespace,
          },
        });

        const instance = response.body as k8s.KubernetesObject & {
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

        // Check if instance is ready using Kro's status structure
        const isActive = instance.status?.state === 'ACTIVE';
        const isSynced = instance.status?.conditions?.some(c =>
          c.type === 'InstanceSynced' && c.status === 'True'
        );

        if (isActive && isSynced) {
          return;
        }

        // Only fail if the state is definitively ERROR (not transient failures)
        if (instance.status?.state === 'ERROR') {
          const errorMessage = instance.status?.conditions?.find(c => c.status === 'False')?.message ||
            instance.status?.message ||
            'Unknown error';
          throw new Error(`Instance deployment failed: ${errorMessage}`);
        }

        // Log current status for debugging
        readinessLogger.info('Instance not ready yet', { 
          state: instance.status?.state, 
          synced: isSynced 
        });

        // Check RGD status to see if that's the issue
        try {
          const rgdStatus = await this.getRGDStatus();
          readinessLogger.debug('RGD status check', { phase: rgdStatus.phase });
          if (rgdStatus.phase === 'failed') {
            throw new Error(`RGD failed: ${rgdStatus.conditions?.find(c => c.status === 'False')?.message || 'Unknown error'}`);
          }
        } catch (error) {
          readinessLogger.debug('Could not check RGD status', { error: (error as Error).message });
        }

        // Check for specific reconciliation failures that might resolve
        const failedCondition = instance.status?.conditions?.find(c => c.status === 'False');
        if (failedCondition) {
          readinessLogger.info('Reconciliation issue detected', { 
            reason: failedCondition.reason, 
            message: failedCondition.message 
          });
        }
      } catch (error) {
        const k8sError = error as { statusCode?: number };
        if (k8sError.statusCode !== 404) {
          throw error;
        }
        // Instance not found yet, continue waiting
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`Timeout waiting for instance ${instanceName} to be ready after ${timeout}ms`);
  }

  /**
   * Separate static and dynamic status fields
   */
  private separateStatusFields(): { staticFields: Record<string, any>; dynamicFields: Record<string, any> } {
    if (!this.statusMappings) {
      return { staticFields: {}, dynamicFields: {} };
    }

    // Import the separateStatusFields function
    const { separateStatusFields } = require('../validation/cel-validator.js');
    return separateStatusFields(this.statusMappings);
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
      ? this.schemaDefinition.apiVersion  // Already has group prefix
      : `kro.run/${this.schemaDefinition.apiVersion}`;  // Add kro.run group

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
  private async createEnhancedProxyWithMixedHydration(spec: TSpec, instanceName: string): Promise<Enhanced<TSpec, TStatus>> {
    const hydrationLogger = this.logger.child({ instanceName });
    
    // Separate static and dynamic status fields
    const { staticFields, dynamicFields } = this.separateStatusFields();

    // Start with static fields as the base status
    const status: TStatus = { ...staticFields } as TStatus;

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
        const hydratedDynamicFields = await this.hydrateDynamicStatusFields(instanceName, dynamicFields);
        
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
  private async createEnhancedProxy(spec: TSpec, instanceName: string): Promise<Enhanced<TSpec, TStatus>> {
    return this.createEnhancedProxyWithMixedHydration(spec, instanceName);
  }

  /**
   * Hydrate dynamic status fields by evaluating CEL expressions against live Kro resource data
   */
  private async hydrateDynamicStatusFields(instanceName: string, dynamicFields: Record<string, any>): Promise<Record<string, any>> {
    const dynamicLogger = this.logger.child({ instanceName });
    
    // Get the live custom resource to extract dynamic status fields
    const apiVersion = this.schemaDefinition.apiVersion.includes('/')
      ? this.schemaDefinition.apiVersion
      : `kro.run/${this.schemaDefinition.apiVersion}`;

    const k8sApi = k8s.KubernetesObjectApi.makeApiClient(this.getKubeConfig());
    const response = await k8sApi.read({
      apiVersion,
      kind: this.schemaDefinition.kind,
      metadata: {
        name: instanceName,
        namespace: this.namespace,
      },
    });

    const liveInstance = response.body as any;
    
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
  TStatus extends KroCompatibleType
>(
  name: string,
  resources: Record<string, KubernetesResource>,
  schemaDefinition: SchemaDefinition<TSpec, TStatus>,
  statusMappings: any,
  options: FactoryOptions = {}
): KroResourceFactory<TSpec, TStatus> {
  return new KroResourceFactoryImpl<TSpec, TStatus>(name, resources, schemaDefinition, statusMappings, options);
}