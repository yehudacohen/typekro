/**
 * Kro Deployment Strategy
 *
 * This module provides the Kro deployment strategy that deploys
 * via ResourceGraphDefinitions using the Kro controller.
 */

import type * as k8s from '@kubernetes/client-node';
// NOTE: kroCustomResource and resourceGraphDefinition are loaded via dynamic import()
// at point of use to avoid a core/ → factories/ static dependency.
// This matches the pattern in kro-factory.ts.
import { preserveNonEnumerableProperties } from '../../../utils/helpers.js';
import {
  DEFAULT_DEPLOYMENT_TIMEOUT,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_RGD_TIMEOUT,
} from '../../config/defaults.js';
import { DependencyGraph } from '../../dependencies/graph.js';
import { getCustomObjectsApi } from '../../kubernetes/client-provider.js';
import { getComponentLogger } from '../../logging/index.js';
import { getResourceId } from '../../resources/id.js';
import { generateKroSchemaFromArktype } from '../../serialization/schema.js';
import type { DeploymentResult, FactoryOptions } from '../../types/deployment.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KubernetesResource,
  WithKroStatusFields,
} from '../../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../../types/serialization.js';
import type { DirectDeploymentEngine } from '../engine.js';
import { waitForKroInstanceReady } from '../kro-readiness.js';
import { convertToKubernetesName, handleDeploymentError } from '../shared-utilities.js';
import { BaseDeploymentStrategy } from './base-strategy.js';

/**
 * Kro deployment strategy - deploys via ResourceGraphDefinitions
 */
export class KroDeploymentStrategy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends BaseDeploymentStrategy<TSpec, TStatus> {
  private injectedCustomObjectsApi: k8s.CustomObjectsApi | undefined;
  private resolvedCustomObjectsApi: k8s.CustomObjectsApi | undefined;

  /**
   * @param customObjectsApi - Injected CustomObjectsApi client. When not provided,
   *   falls back to the singleton `getCustomObjectsApi()` from client-provider.
   *   Prefer passing this parameter to avoid global singleton coupling.
   */
  constructor(
    factoryName: string,
    namespace: string,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    factoryOptions: FactoryOptions,
    private directEngine: DirectDeploymentEngine,
    private resources: Record<string, KubernetesResource> = {},
    private statusMappings: Record<string, unknown> = {},
    customObjectsApi?: k8s.CustomObjectsApi
  ) {
    super(factoryName, namespace, schemaDefinition, undefined, resources, factoryOptions);
    this.injectedCustomObjectsApi = customObjectsApi;
  }

  /**
   * Get CustomObjectsApi client (lazy, cached).
   * Uses injected client if available, otherwise falls back to singleton.
   */
  private getCustomObjectsApi(): k8s.CustomObjectsApi {
    if (!this.resolvedCustomObjectsApi) {
      this.resolvedCustomObjectsApi = this.injectedCustomObjectsApi ?? getCustomObjectsApi();
    }
    return this.resolvedCustomObjectsApi;
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
    } catch (error: unknown) {
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
    const rgdName = convertToKubernetesName(this.factoryName);

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
          id: getResourceId(resource),
          template: resource,
        })),
      },
    };

    // Wrap with resourceGraphDefinition factory to get Enhanced object with readiness evaluation
    // Dynamic import avoids core/ → factories/ static dependency
    const { resourceGraphDefinition } = await import(
      '../../../factories/kro/resource-graph-definition.js'
    );
    const enhancedRGD = resourceGraphDefinition(rgdManifest);

    // Create deployable resource
    const deployableRGD = {
      ...enhancedRGD,
      id: rgdName,
    };

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedRGD, deployableRGD);

    // Deploy using DirectDeploymentEngine with KRO mode
    await this.directEngine.deployResource(deployableRGD, {
      mode: 'kro',
      namespace: this.namespace,
      waitForReady: true,
      timeout: this.factoryOptions.timeout || DEFAULT_RGD_TIMEOUT,
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
    // Dynamic import avoids core/ → factories/ static dependency
    const { kroCustomResource } = await import('../../../factories/kro/kro-custom-resource.js');
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
    } as DeployableK8sResource<Enhanced<TSpec, WithKroStatusFields<object>>>;

    // Preserve non-enumerable properties (readinessEvaluator, __resourceId) lost during spread
    preserveNonEnumerableProperties(enhancedCustomResource, deployableCustomResource);

    // Deploy using DirectDeploymentEngine with KRO mode
    // Don't wait for ready here - we'll handle Kro-specific readiness logic ourselves
    const deployedResource = await this.directEngine.deployResource(deployableCustomResource, {
      mode: 'kro',
      namespace: this.namespace,
      waitForReady: false, // We'll handle readiness ourselves
      timeout: this.factoryOptions.timeout || DEFAULT_DEPLOYMENT_TIMEOUT,
    });

    // Handle Kro-specific readiness checking if requested
    if (this.factoryOptions.waitForReady ?? true) {
      await this.waitForKroResourceReady(
        instanceName,
        this.factoryOptions.timeout || DEFAULT_DEPLOYMENT_TIMEOUT
      );
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
   * Wait for Kro resource to be ready with Kro-specific logic.
   * Delegates to the shared `waitForKroInstanceReady` in `kro-readiness.ts`.
   */
  private async waitForKroResourceReady(instanceName: string, timeout: number): Promise<void> {
    const apiVersion = this.getApiVersion();
    const k8sApi = this.directEngine.getKubernetesApi();
    const rgdName = convertToKubernetesName(this.factoryName);

    return waitForKroInstanceReady({
      instanceName,
      timeout,
      k8sApi,
      customObjectsApi: this.getCustomObjectsApi(),
      namespace: this.namespace,
      apiVersion,
      kind: this.schemaDefinition.kind,
      rgdName,
      pollInterval: DEFAULT_POLL_INTERVAL,
    });
  }
}
