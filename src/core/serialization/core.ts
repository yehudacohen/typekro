/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */


import { DependencyResolver } from '../dependencies/index.js';
import { createDirectResourceFactory } from '../deployment/direct-factory.js';
import { createKroResourceFactory } from '../deployment/kro-factory.js';
import { getComponentLogger } from '../logging/index.js';
import { createSchemaProxy } from '../references/index.js';
import type {
  FactoryForMode,
  FactoryOptions,
  ResourceGraphResource,
  ResourceGraph,
  TypedResourceGraph,
} from '../types/deployment.js';
import type {
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KroCompatibleType,
  KubernetesResource,
} from '../types.js';
import { generateKroSchemaFromArktype } from './schema.js';
import { serializeResourceGraphToYaml } from './yaml.js';
import { validateResourceGraphDefinition } from '../validation/cel-validator.js';
import { evaluateStatusMappings } from '../evaluation/cel-evaluator.js';

/**
 * Create a ResourceGraph from resources for deployment
 */
function _createResourceGraph(name: string, resources: Record<string, KubernetesResource>): ResourceGraph {
  const dependencyResolver = new DependencyResolver();
  const resourceArray = Object.values(resources).map(resource => ({
    ...resource,
    id: resource.id || resource.metadata?.name || 'unknown',
  }));

  // Type assertion needed because we're converting KubernetesResource to DeployableK8sResource
  // This is safe because the deployment engine handles the conversion internally
  const deployableResources = resourceArray as DeployableK8sResource<Enhanced<unknown, unknown>>[];
  const dependencyGraph = dependencyResolver.buildDependencyGraph(deployableResources);

  // Convert to ResourceGraphResource format
  const resourceGraphResources: ResourceGraphResource[] = deployableResources.map(resource => ({
    id: resource.id,
    manifest: resource,
  }));

  return {
    name,
    resources: resourceGraphResources,
    dependencyGraph,
  };
}

// =============================================================================
// NEW FACTORY PATTERN API
// =============================================================================

/**
 * Create a new typed resource graph with factory pattern support
 * This is the new API with definition-first parameter and separate builder functions
 */
export function toResourceGraph<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  // This new generic captures the exact shape of your resources
  TResources extends Record<string, Enhanced<any, any>>
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  // The resourceBuilder is now defined as returning that specific shape
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  // The statusBuilder is now defined as ACCEPTING that specific shape
  statusBuilder: (schema: SchemaProxy<TSpec, TStatus>, resources: TResources) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus> {
  // The implementation in createTypedResourceGraph must also be updated to match this signature.
  return createTypedResourceGraph(definition, resourceBuilder, statusBuilder, options);
}

/**
 * Create a typed resource graph implementation
 */
function createTypedResourceGraph<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any>>
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  statusBuilder: (schema: SchemaProxy<TSpec, TStatus>, resources: TResources) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus> {
  const serializationLogger = getComponentLogger('resource-graph-serialization').child({ 
    name: definition.name 
  });
  
  // Validate resource graph name early
  if (!definition.name || typeof definition.name !== 'string') {
    throw new Error(`Invalid resource graph name: ${JSON.stringify(definition.name)}. Resource graph name must be a non-empty string.`);
  }

  const trimmedName = definition.name.trim();
  if (trimmedName.length === 0) {
    throw new Error(`Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`);
  }

  // Validate that the name will convert to a valid Kubernetes resource name
  const kubernetesName = trimmedName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();

  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
    throw new Error(`Invalid resource graph name: "${definition.name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`);
  }

  if (kubernetesName.length > 253) {
    throw new Error(`Invalid resource graph name: "${definition.name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`);
  }

  // Apply default apiVersion if not specified
  // Note: This should be just the version part (e.g., 'v1alpha1'), not the full API version
  // The full API version (kro.run/v1alpha1) is constructed when creating instances
  const schemaDefinition: SchemaDefinition<TSpec, TStatus> = {
    apiVersion: definition.apiVersion || 'v1alpha1',
    kind: definition.kind,
    spec: definition.spec,
    status: definition.status,
  };
  
  const schema = createSchemaProxy<TSpec, TStatus>();
  const resourcesWithKeys = resourceBuilder(schema);
  
  // Pass Enhanced resources directly to StatusBuilder - they already have proper MagicProxy types
  const statusMappings = statusBuilder(schema, resourcesWithKeys);
  
  // Validate resource IDs and CEL expressions
  const validation = validateResourceGraphDefinition(resourcesWithKeys, statusMappings);
  if (!validation.isValid) {
    const errorMessages = validation.errors.map(err => `${err.field}: ${err.error}`).join('\n');
    throw new Error(`ResourceGraphDefinition validation failed:\n${errorMessages}`);
  }
  
  // Log warnings if any
  if (validation.warnings.length > 0) {
    serializationLogger.warn('ResourceGraphDefinition validation warnings', {
      warnings: validation.warnings.map(w => ({
        field: w.field,
        error: w.error,
        suggestion: w.suggestion
      }))
    });
  }
  
  // Evaluate and optimize CEL expressions
  const evaluationContext = { resources: resourcesWithKeys, schema };
  const { mappings: optimizedStatusMappings, optimizations } = evaluateStatusMappings(statusMappings, evaluationContext);
  
  // Log optimizations if any
  if (optimizations.length > 0) {
    serializationLogger.info('CEL expression optimizations applied', { optimizations });
  }

  // schemaDefinition is already created above with default apiVersion handling

  return {
    name: definition.name,
    resources: Object.values(resourcesWithKeys),
    schema,

    async factory<TMode extends 'kro' | 'direct'>(
      mode: TMode,
      factoryOptions?: FactoryOptions
    ): Promise<FactoryForMode<TMode, TSpec, TStatus>> {
      if (mode === 'direct') {
        const directFactory = createDirectResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          factoryOptions || {}
        );
        return directFactory as FactoryForMode<TMode, TSpec, TStatus>;
      } else if (mode === 'kro') {
        const kroFactory = createKroResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          statusMappings,
          factoryOptions || {}
        );
        return kroFactory as FactoryForMode<TMode, TSpec, TStatus>;
      } else {
        throw new Error(`Unsupported factory mode: ${mode}`);
      }
    },

    toYaml(): string {
      // Generate ResourceGraphDefinition YAML with user-defined status mappings
      const kroSchema = generateKroSchemaFromArktype(definition.name, schemaDefinition, resourcesWithKeys, optimizedStatusMappings);
      return serializeResourceGraphToYaml(definition.name, resourcesWithKeys, options, kroSchema);
    },
  };
}
