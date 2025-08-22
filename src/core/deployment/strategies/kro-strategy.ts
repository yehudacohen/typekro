/**
 * Kro Deployment Strategy
 *
 * This module provides the Kro deployment strategy that deploys
 * via ResourceGraphDefinitions using the Kro controller.
 */

import { kroCustomResource } from '../../../factories/kro/kro-custom-resource.js';
import { resourceGraphDefinition } from '../../../factories/kro/resource-graph-definition.js';
import { DependencyGraph } from '../../dependencies/graph.js';
import { getComponentLogger } from '../../logging/index.js';
import { generateKroSchemaFromArktype } from '../../serialization/schema.js';
import type { DeploymentResult, FactoryOptions } from '../../types/deployment.js';
import type { KubernetesResource } from '../../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../../types/serialization.js';
import type { DirectDeploymentEngine } from '../engine.js';
import { handleDeploymentError } from '../shared-utilities.js';
import { BaseDeploymentStrategy } from './base-strategy.js';

/**
 * Kro deployment strategy - deploys via ResourceGraphDefinitions
 */
export class KroDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    private directEngine: DirectDeploymentEngine,
    private resources: Record<string, KubernetesResource> = {},
    private statusMappings: Record<string, unknown> = {}
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
        namespace: this.namespace,
      });

      return {
        status: 'success',
        deploymentId: `kro-${instanceName}-${Date.now()}`,
        resources: customResourceResult.resources, // Extract the resources array from the DeploymentResult
        dependencyGraph: new DependencyGraph(), // Empty graph since Kro handles dependencies internally
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

  protected getKind(): string {
    return this.schemaDefinition.kind;
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
        resources: Object.values(this.resources || {}).map((resource) => ({
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
      namespace: this.namespace,
    });
  }

  /**
   * Step 2: Deploy Custom Resource instance using DirectDeploymentEngine
   */
  private async deployCustomResourceInstance(
    spec: TSpec,
    instanceName: string
  ): Promise<DeploymentResult> {
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
      namespace: this.namespace,
    });

    return {
      deploymentId: `kro-${instanceName}-${Date.now()}`,
      resources: [deployedResource],
      dependencyGraph: new DependencyGraph(),
      duration: 0,
      status: 'success',
      errors: [],
    };
  }

  /**
   * Convert camelCase factory name to valid Kubernetes resource name (kebab-case)
   */
  private convertToKubernetesName(name: string): string {
    // Validate input name
    if (!name || typeof name !== 'string') {
      throw new Error(
        `Invalid factory name: ${JSON.stringify(name)}. Factory name must be a non-empty string.`
      );
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
      throw new Error(
        `Invalid factory name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`
      );
    }

    if (kubernetesName.length > 253) {
      throw new Error(
        `Invalid factory name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`
      );
    }

    return kubernetesName;
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

        const instance = response.body as KubernetesResource & {
          status?: {
            state?: string;
            conditions?: Array<{ type: string; status: string; message?: string }>;
          };
        };
        const status = instance.status;

        if (!status) {
          logger.debug('No status found yet, continuing to wait', { instanceName });
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        // Kro-specific readiness logic
        const state = status.state;
        const conditions = status.conditions || [];
        const syncedCondition = conditions.find(
          (c: { type: string; status: string; message?: string }) => c.type === 'InstanceSynced'
        );

        // Check if status has fields beyond the basic Kro fields (conditions, state)
        const statusKeys = Object.keys(status);
        const basicKroFields = ['conditions', 'state'];
        const hasCustomStatusFields = statusKeys.some((key) => !basicKroFields.includes(key));

        const isActive = state === 'ACTIVE';
        const isSynced = syncedCondition?.status === 'True';

        logger.debug('Kro resource status check', {
          instanceName,
          state,
          isActive,
          isSynced,
          hasCustomStatusFields,
          statusKeys,
        });

        // Resource is ready when it's active, synced, and has custom status fields populated
        if (isActive && isSynced && hasCustomStatusFields) {
          logger.info('Kro resource is ready', { instanceName });
          return;
        }

        // Check for failure states
        if (state === 'FAILED') {
          const failedCondition = conditions.find(
            (c: { type: string; status: string; message?: string }) => c.status === 'False'
          );
          const errorMessage = failedCondition?.message || 'Unknown error';
          throw new Error(`Kro resource deployment failed: ${errorMessage}`);
        }

        logger.debug('Kro resource not ready yet, continuing to wait', {
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
        // Resource not found yet, continue waiting
        logger.debug('Resource not found yet, continuing to wait', { instanceName });
      }

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(
      `Timeout waiting for Kro resource ${instanceName} to be ready after ${timeout}ms`
    );
  }
}
