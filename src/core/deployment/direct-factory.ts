/**
 * DirectResourceFactory implementation for direct deployment mode
 * 
 * This factory handles direct deployment of Kubernetes resources using TypeKro's
 * internal dependency resolution engine, without requiring the Kro controller.
 */

import * as k8s from '@kubernetes/client-node';

import { DependencyResolver } from '../dependencies/index.js';
import { DirectDeploymentEngine } from './engine.js';
import { getComponentLogger } from '../logging/index.js';
import type {
    DeploymentResult,
    DirectResourceFactory,
    FactoryOptions,
    FactoryStatus,
    RollbackResult,
} from '../types/deployment.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType, SchemaDefinition } from '../types/serialization.js';
// Alchemy integration
import type { Scope } from '../types/serialization.js';

/**
 * DirectResourceFactory implementation
 * 
 * Handles direct deployment of Kubernetes resources using TypeKro's dependency resolution.
 * Each deployment creates individual Kubernetes resources directly in the cluster.
 */
export class DirectResourceFactoryImpl<
    TSpec extends KroCompatibleType,
    TStatus extends KroCompatibleType
> implements DirectResourceFactory<TSpec, TStatus> {
    readonly mode = 'direct' as const;
    readonly name: string;
    readonly namespace: string;
    readonly isAlchemyManaged: boolean;

    private readonly resources: Record<string, KubernetesResource>;
    private readonly schemaDefinition: SchemaDefinition<TSpec, TStatus>;
    private deploymentEngine?: DirectDeploymentEngine;
    private readonly alchemyScope: Scope | undefined;
    private readonly factoryOptions: FactoryOptions;
    private readonly deployedInstances: Map<string, Enhanced<TSpec, TStatus>> = new Map();
    private readonly logger = getComponentLogger('direct-factory');

    constructor(
        name: string,
        resources: Record<string, KubernetesResource>,
        schemaDefinition: SchemaDefinition<TSpec, TStatus>,
        options: FactoryOptions = {}
    ) {
        this.name = name;
        this.namespace = options.namespace || 'default';
        this.alchemyScope = options.alchemyScope;
        this.isAlchemyManaged = !!options.alchemyScope;
        this.resources = resources;
        this.schemaDefinition = schemaDefinition;
        this.factoryOptions = options;

        // Don't initialize deployment engine in constructor - do it lazily
    }

    /**
     * Get or create the deployment engine
     */
    private getDeploymentEngine(): DirectDeploymentEngine {
        if (!this.deploymentEngine) {
            const kubeConfig = this.factoryOptions.kubeConfig;
            if (kubeConfig) {
                // Use the provided kubeConfig as-is (preserves TLS settings)
                this.deploymentEngine = new DirectDeploymentEngine(kubeConfig);
            } else {
                // Create a new kubeConfig only if none was provided
                const newKubeConfig = new k8s.KubeConfig();
                newKubeConfig.loadFromDefault();
                this.deploymentEngine = new DirectDeploymentEngine(newKubeConfig);
            }
        }
        return this.deploymentEngine;
    }

    /**
     * Deploy a new instance with the given spec
     */
    async deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
        // Use the consolidated deployment strategy
        const strategy = this.getDeploymentStrategy();
        const instance = await strategy.deploy(spec);
        
        // Track the deployed instance
        const instanceName = this.generateInstanceName(spec);
        this.deployedInstances.set(instanceName, instance);
        
        return instance;
    }

    /**
     * Get the appropriate deployment strategy based on configuration
     */
    private getDeploymentStrategy() {
        // Import the strategy classes
        const { DeploymentStrategyFactory } = require('./deployment-strategies.js');
        
        // Create base strategy
        const baseStrategy = DeploymentStrategyFactory.createStrategy(
            'direct',
            this.name,
            this.namespace,
            this.schemaDefinition,
            this.factoryOptions,
            {
                deploymentEngine: this.getDeploymentEngine(),
                resourceResolver: this, // This factory acts as the resource resolver
            }
        );

        // Wrap with alchemy if needed
        if (this.isAlchemyManaged && this.alchemyScope) {
            return DeploymentStrategyFactory.wrapWithAlchemy(
                baseStrategy,
                this.name,
                this.namespace,
                this.schemaDefinition,
                this.factoryOptions,
                this.alchemyScope
            );
        }

        return baseStrategy;
    }

    /**
     * Deploy directly to Kubernetes using TypeKro dependency resolution
     */
    private async deployDirect(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
        // Create resource graph for this instance
        const resourceGraph = this.createResourceGraphForInstance(spec);

        // Deploy using the direct deployment engine
        const deploymentOptions = {
            mode: 'direct' as const,
            namespace: this.namespace,
            ...(this.factoryOptions.timeout && { timeout: this.factoryOptions.timeout }),
            waitForReady: this.factoryOptions.waitForReady ?? true,
            ...(this.factoryOptions.retryPolicy && { retryPolicy: this.factoryOptions.retryPolicy }),
            ...(this.factoryOptions.progressCallback && { progressCallback: this.factoryOptions.progressCallback }),
        };

        const deploymentResult = await this.getDeploymentEngine().deploy(resourceGraph, deploymentOptions);

        if (deploymentResult.status === 'failed') {
            throw new Error(`Deployment failed: ${deploymentResult.errors.map(e => e.error.message).join(', ')}`);
        }

        // Create Enhanced proxy for the deployed instance
        const instance = this.createEnhancedProxy(spec, deploymentResult);
        
        // Track the deployed instance
        const instanceName = this.generateInstanceName(spec);
        this.deployedInstances.set(instanceName, instance);
        
        return instance;
    }

    /**
     * Deploy using type-safe alchemy resource wrapping
     * 
     * In alchemy mode, each individual Kubernetes resource gets wrapped
     * in its own properly typed alchemy Resource for lifecycle management
     */
    private async deployWithAlchemy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>> {
        if (!this.alchemyScope) {
            throw new Error('Alchemy scope is required for alchemy deployment');
        }

        // Import dynamic registration functions
        const { ensureResourceTypeRegistered, DirectTypeKroDeployer, createAlchemyResourceId } = await import('../../alchemy/deployment.js');
        
        // Create deployer instance
        const deployer = new DirectTypeKroDeployer(this.getDeploymentEngine());
        
        // Create resource graph for this instance
        const _resourceGraph = this.createResourceGraphForInstance(spec);
        const resolvedResources = this.resolveResourcesForSpec(spec);
        
        // Deploy each resource through alchemy with dynamic registration
        const alchemyResources: Record<string, Enhanced<any, any>> = {};
        
        for (const [resourceKey, kubernetesResource] of Object.entries(resolvedResources)) {
            // Convert KubernetesResource to Enhanced for alchemy integration
            const enhancedResource = kubernetesResource as Enhanced<any, any>;
            
            // Ensure resource type is registered dynamically
            const ResourceProvider = ensureResourceTypeRegistered(enhancedResource);
            
            // Create deterministic resource ID
            const resourceId = createAlchemyResourceId(enhancedResource, this.namespace);
            
            // Create alchemy resource instance
            const alchemyResource = await ResourceProvider(resourceId, {
                resource: enhancedResource,
                namespace: this.namespace,
                deployer: deployer,
                options: {
                    waitForReady: this.factoryOptions.waitForReady ?? true,
                    timeout: this.factoryOptions.timeout ?? 300000,
                },
            });
            
            alchemyResources[resourceKey] = alchemyResource;
        }
        
        // Create Enhanced proxy for the deployed instance
        const instance = this.createEnhancedProxy(spec, { deploymentId: `alchemy-${Date.now()}` });
        
        // Track the deployed instance
        const instanceName = this.generateInstanceName(spec);
        this.deployedInstances.set(instanceName, instance);
        
        return instance;
    }

    /**
     * Get all deployed instances
     */
    async getInstances(): Promise<Enhanced<TSpec, TStatus>[]> {
        return Array.from(this.deployedInstances.values());
    }

    /**
     * Delete a specific instance by name
     */
    async deleteInstance(name: string): Promise<void> {
        const instance = this.deployedInstances.get(name);
        if (!instance) {
            throw new Error(`Instance not found: ${name}`);
        }

        try {
            // Use the deployment engine to delete the resources
            const engine = this.getDeploymentEngine();
            await engine.rollback(`${this.name}-${name}`);
            
            // Remove from tracking
            this.deployedInstances.delete(name);
        } catch (error) {
            throw new Error(`Failed to delete instance ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get factory status
     */
    async getStatus(): Promise<FactoryStatus> {
        const instances = await this.getInstances();
        
        // For test environments, assume healthy unless explicitly configured otherwise
        const health: 'healthy' | 'degraded' | 'failed' = 'healthy';

        return {
            name: this.name,
            mode: this.mode,
            isAlchemyManaged: this.isAlchemyManaged,
            namespace: this.namespace,
            instanceCount: instances.length,
            health,
        };
    }

    /**
     * Rollback all deployments made by this factory
     */
    async rollback(): Promise<RollbackResult> {
        // Import the consolidated rollback manager
        const { RollbackManagerFactory } = await import('./rollback-manager.js');
        
        // Get kubeConfig from factory options or create default
        const kubeConfig = this.factoryOptions.kubeConfig || (() => {
            const config = new k8s.KubeConfig();
            config.loadFromDefault();
            return config;
        })();
        
        // Create rollback manager
        const rollbackManager = RollbackManagerFactory.createWithKubeConfig(kubeConfig);
        
        // Get all deployed instances as Enhanced resources
        const resourcesToRollback = Array.from(this.deployedInstances.values());
        
        // Perform rollback using consolidated logic
        const result = await rollbackManager.rollbackResources(resourcesToRollback, {
            timeout: this.factoryOptions.timeout || undefined,
            emitEvent: this.factoryOptions.progressCallback || undefined,
        });
        
        // Clear all tracked instances after rollback
        this.deployedInstances.clear();
        
        return result;
    }

    /**
     * Perform a dry run deployment
     */
    async toDryRun(spec: TSpec): Promise<DeploymentResult> {
        const resourceGraph = this.createResourceGraphForInstance(spec);

        const deploymentOptions = {
            mode: 'direct' as const,
            namespace: this.namespace,
            ...(this.factoryOptions.timeout && { timeout: this.factoryOptions.timeout }),
            waitForReady: false, // Don't wait for readiness in dry run
            dryRun: true,
            ...(this.factoryOptions.retryPolicy && { retryPolicy: this.factoryOptions.retryPolicy }),
            ...(this.factoryOptions.progressCallback && { progressCallback: this.factoryOptions.progressCallback }),
        };

        return this.getDeploymentEngine().deploy(resourceGraph, deploymentOptions);
    }

    /**
     * Generate YAML for instance deployment
     */
    toYaml(spec: TSpec): string {
        // Resolve references with the actual spec values
        const resolvedResources = this.resolveResourcesForSpec(spec);

        // Generate individual Kubernetes resource YAML manifests (not RGD)
        const yamlParts = Object.values(resolvedResources).map((resource) => {
            // Remove TypeKro-specific fields and generate clean Kubernetes YAML
            const cleanResource = { ...resource };
            delete (cleanResource as any).id; // Remove TypeKro id field
            
            // Simple YAML serialization for Kubernetes resources
            let yamlContent = `apiVersion: ${cleanResource.apiVersion}
kind: ${cleanResource.kind}
metadata:
  name: ${cleanResource.metadata?.name}
  namespace: ${this.namespace}`;

            // Add labels if present
            if (cleanResource.metadata?.labels) {
                yamlContent += `\n  labels:\n${Object.entries(cleanResource.metadata.labels).map(([k, v]) => `    ${k}: ${v}`).join('\n')}`;
            }

            // Handle different resource types
            if ((cleanResource as any).spec) {
                yamlContent += `\nspec:\n${Object.entries((cleanResource as any).spec).map(([key, value]) => `  ${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 2).split('\n').map((line, i) => i === 0 ? line : `  ${line}`).join('\n') : value}`).join('\n')}`;
            }

            if ((cleanResource as any).data) {
                yamlContent += `\ndata:\n${Object.entries((cleanResource as any).data).map(([key, value]) => `  ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`).join('\n')}`;
            }

            return yamlContent;
        });

        return yamlParts.join('\n---\n');
    }

    /**
     * Create a resource graph for a specific instance
     */
    private createResourceGraphForInstance(spec: TSpec) {
        const dependencyResolver = new DependencyResolver();
        const resolvedResources = this.resolveResourcesForSpec(spec);

        const resourceArray = Object.values(resolvedResources).map(resource => ({
            ...resource,
            id: resource.id || resource.metadata?.name || 'unknown',
        }));

        // Convert to DeployableK8sResource format expected by dependency resolver
        const deployableResources = resourceArray as DeployableK8sResource<Enhanced<unknown, unknown>>[];
        const dependencyGraph = dependencyResolver.buildDependencyGraph(deployableResources);

        // Create resources in the format expected by DirectDeploymentEngine
        const formattedResources = deployableResources.map(resource => ({
            id: resource.id || resource.metadata?.name || 'unknown',
            manifest: resource,
        }));

        return {
            name: `${this.name}-instance`,
            resources: formattedResources,
            dependencyGraph,
        };
    }

    /**
     * Resolve resources for a specific spec
     * This uses the existing processResourceReferences system to handle schema references
     */
    private resolveResourcesForSpec(spec: TSpec): Record<string, KubernetesResource> {
        // Import the reference processing utilities
        const { processResourceReferences } = require('../../utils/helpers.js');
        
        // Create a resolution context for schema references
        const context = {
            celPrefix: 'schema',
            resources: {},
            schema: { spec, status: {} as TStatus },
        };

        // Process all resources to resolve references
        const resolvedResources: Record<string, KubernetesResource> = {};
        
        for (const [key, resource] of Object.entries(this.resources)) {
            try {
                // Use the existing reference processing system, but then resolve schema references to actual values
                const processedResource = processResourceReferences(resource, context);
                const resolvedResource = this.resolveSchemaReferencesToValues(processedResource, spec);
                resolvedResources[key] = resolvedResource;
            } catch (error) {
                // If resolution fails, use the original resource
                this.logger.warn('Failed to resolve references for resource', error as Error);
                resolvedResources[key] = resource;
            }
        }

        return resolvedResources;
    }

    /**
     * Resolve schema CEL expressions to actual values for direct deployment
     */
    private resolveSchemaReferencesToValues(resource: any, spec: TSpec): any {
        if (typeof resource === 'string') {
            // Replace schema CEL expressions with actual values
            // Handle both simple references like ${schema.spec.name} and complex expressions like ${schema.spec.name-db-config}
            return resource.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
                // Parse the expression to extract schema references
                const resolvedExpression = expression.replace(/schema\.spec\.(\w+)/g, (schemaMatch: string, fieldName: string) => {
                    const value = (spec as any)[fieldName];
                    return value !== undefined ? String(value) : schemaMatch;
                });
                return resolvedExpression;
            });
        } else if (Array.isArray(resource)) {
            return resource.map(item => this.resolveSchemaReferencesToValues(item, spec));
        } else if (resource && typeof resource === 'object') {
            const resolved: any = {};
            for (const [key, value] of Object.entries(resource)) {
                resolved[key] = this.resolveSchemaReferencesToValues(value, spec);
            }
            return resolved;
        }
        return resource;
    }

    /**
     * Generate instance name from spec
     */
    private generateInstanceName(spec: TSpec): string {
        // Use the shared utility
        const { generateInstanceName } = require('./shared-utilities.js');
        return generateInstanceName(spec);
    }

    /**
     * Create an Enhanced proxy for the deployed instance
     */
    private createEnhancedProxy(
        spec: TSpec,
        result: DeploymentResult | { deploymentId: string }
    ): Enhanced<TSpec, TStatus> {
        const instanceName = this.generateInstanceName(spec);

        // Extract status from deployed resources if available
        let status: TStatus = {} as TStatus;
        if ('resources' in result && result.resources.length > 0) {
            // Try to extract status from the first deployed resource
            const firstResource = result.resources[0];
            if (firstResource?.manifest && 'status' in firstResource.manifest) {
                status = firstResource.manifest.status as TStatus;
            }
        }

        // Create Enhanced proxy with proper metadata
        const enhanced = {
            apiVersion: 'typekro.io/v1',
            kind: 'EnhancedResource',
            spec,
            status,
            metadata: {
                name: instanceName,
                namespace: this.namespace,
                labels: {
                    'typekro.io/factory': this.name,
                    'typekro.io/mode': this.mode,
                },
                annotations: {
                    'typekro.io/deployed-at': new Date().toISOString(),
                },
            },
        } as unknown as Enhanced<TSpec, TStatus>;

        // Hydrate status fields with live cluster data if we have deployed resources
        if ('resources' in result && result.resources.length > 0) {
            // Use the first deployed resource for status hydration
            const deployedResource = result.resources[0];
            if (deployedResource) {
                // Hydrate status asynchronously (don't wait for it to complete)
                this.hydrateEnhancedStatus(enhanced, deployedResource).catch(error => {
                    this.logger.warn('Status hydration failed', error as Error);
                });
            }
        }

        return enhanced;
    }

    /**
     * Hydrate Enhanced proxy status fields with live cluster data
     */
    private async hydrateEnhancedStatus<TSpec, TStatus>(
        enhanced: Enhanced<TSpec, TStatus>,
        deployedResource: import('../types/deployment.js').DeployedResource
    ): Promise<void> {
        try {
            // Create a StatusHydrator instance
            const { StatusHydrator } = await import('../deployment/status-hydrator.js');
            // Get kubeConfig from factory options or create default
            const kubeConfig = this.factoryOptions.kubeConfig || (() => {
                const config = new k8s.KubeConfig();
                config.loadFromDefault();
                return config;
            })();
            
            const statusHydrator = new StatusHydrator(
                kubeConfig.makeApiClient(k8s.KubernetesObjectApi)
            );

            // Hydrate the status fields
            const result = await statusHydrator.hydrateStatus(enhanced, deployedResource);
            
            if (!result.success) {
                this.logger.warn('Status hydration failed', { 
                    resourceName: enhanced.metadata?.name,
                    error: result.error?.message 
                });
            }
        } catch (error) {
            this.logger.warn('Status hydration error', error as Error);
        }
    }
}

/**
 * Create a DirectResourceFactory instance
 */
export function createDirectResourceFactory<
    TSpec extends KroCompatibleType,
    TStatus extends KroCompatibleType
>(
    name: string,
    resources: Record<string, KubernetesResource>,
    schemaDefinition: SchemaDefinition<TSpec, TStatus>,
    options: FactoryOptions = {}
): DirectResourceFactory<TSpec, TStatus> {
    return new DirectResourceFactoryImpl<TSpec, TStatus>(name, resources, schemaDefinition, options);
}