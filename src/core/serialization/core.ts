/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */


import { DependencyResolver } from '../dependencies/index.js';
import { createDirectResourceFactory } from '../deployment/direct-factory.js';
import { createKroResourceFactory } from '../deployment/kro-factory.js';
import { optimizeStatusMappings } from '../evaluation/cel-optimizer.js';
import { getComponentLogger } from '../logging/index.js';
import { createSchemaProxy, externalRef } from '../references/index.js';
import type {
  DeploymentClosure,
  FactoryForMode,
  FactoryOptions,
  ResourceGraph,
  ResourceGraphResource,
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
import { validateResourceGraphDefinition } from '../validation/cel-validator.js';
import { generateKroSchemaFromArktype } from './schema.js';
import { serializeResourceGraphToYaml } from './yaml.js';

/**
 * Separate Enhanced<> resources from deployment closures in the builder result
 */
function separateResourcesAndClosures<
  T extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  builderResult: T
): { resources: Record<string, Enhanced<any, any>>; closures: Record<string, DeploymentClosure> } {
  const resources: Record<string, Enhanced<any, any>> = {};
  const closures: Record<string, DeploymentClosure> = {};

  for (const [key, value] of Object.entries(builderResult)) {
    if (typeof value === 'function') {
      // This is a deployment closure
      closures[key] = value as DeploymentClosure;
    } else if (value && typeof value === 'object' && 'kind' in value && 'apiVersion' in value) {
      // This is an Enhanced<> resource
      resources[key] = value as Enhanced<any, any>;
    } else {
      // Unknown type, treat as resource for backward compatibility
      resources[key] = value as Enhanced<any, any>;
    }
  }

  return { resources, closures };
}

/**
 * Create a ResourceGraph from resources for deployment
 */
function _createResourceGraph(
  name: string,
  resources: Record<string, KubernetesResource>
): ResourceGraph {
  const dependencyResolver = new DependencyResolver();
  const resourceArray = Object.values(resources).map((resource) => ({
    ...resource,
    id: resource.id || resource.metadata?.name || 'unknown',
  }));

  // Type assertion needed because we're converting KubernetesResource to DeployableK8sResource
  // This is safe because the deployment engine handles the conversion internally
  const deployableResources = resourceArray as DeployableK8sResource<Enhanced<unknown, unknown>>[];
  const dependencyGraph = dependencyResolver.buildDependencyGraph(deployableResources);

  // Convert to ResourceGraphResource format
  const resourceGraphResources: ResourceGraphResource[] = deployableResources.map((resource) => ({
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
  // This new generic captures the exact shape of your resources - can be Enhanced<> resources or DeploymentClosures
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  // The resourceBuilder is now defined as returning that specific shape
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  // The statusBuilder is now defined as ACCEPTING that specific shape
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
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
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus> {
  const serializationLogger = getComponentLogger('resource-graph-serialization').child({
    name: definition.name,
  });

  // Validate resource graph name early
  if (!definition.name || typeof definition.name !== 'string') {
    throw new Error(
      `Invalid resource graph name: ${JSON.stringify(definition.name)}. Resource graph name must be a non-empty string.`
    );
  }

  const trimmedName = definition.name.trim();
  if (trimmedName.length === 0) {
    throw new Error(
      `Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`
    );
  }

  // Validate that the name will convert to a valid Kubernetes resource name
  const kubernetesName = trimmedName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
    throw new Error(
      `Invalid resource graph name: "${definition.name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`
    );
  }

  if (kubernetesName.length > 253) {
    throw new Error(
      `Invalid resource graph name: "${definition.name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`
    );
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
  const builderResult = resourceBuilder(schema);

  // Separate Enhanced<> resources from deployment closures
  const { resources: resourcesWithKeys, closures } = separateResourcesAndClosures(builderResult);

  // Pass Enhanced resources directly to StatusBuilder - they already have proper MagicProxy types
  const statusMappings = statusBuilder(schema, resourcesWithKeys as TResources);

  // Validate resource IDs and CEL expressions
  const validation = validateResourceGraphDefinition(resourcesWithKeys, statusMappings);
  if (!validation.isValid) {
    const errorMessages = validation.errors.map((err) => `${err.field}: ${err.error}`).join('\n');
    throw new Error(`ResourceGraphDefinition validation failed:\n${errorMessages}`);
  }

  // Log warnings if any
  if (validation.warnings.length > 0) {
    serializationLogger.warn('ResourceGraphDefinition validation warnings', {
      warnings: validation.warnings.map((w) => ({
        field: w.field,
        error: w.error,
        suggestion: w.suggestion,
      })),
    });
  }

  // Evaluate and optimize CEL expressions
  const evaluationContext = { resources: resourcesWithKeys, schema };
  const { mappings: optimizedStatusMappings, optimizations } = optimizeStatusMappings(
    statusMappings,
    evaluationContext
  );

  // Log optimizations if any
  if (optimizations.length > 0) {
    serializationLogger.info('CEL expression optimizations applied', { optimizations });
  }

  // schemaDefinition is already created above with default apiVersion handling

  /**
   * Find a resource by key name in the resources map
   * This enables cross-composition magic proxy access like composition.database
   */
  function findResourceByKey(key: string | symbol): KubernetesResource | undefined {
    if (typeof key !== 'string') return undefined;

    // Strategy 1: Direct match by generated resource ID
    if (resourcesWithKeys[key]) {
      return resourcesWithKeys[key];
    }

    // Strategy 2: Smart pattern matching for common cases
    const keyLower = key.toLowerCase();
    const keyParts = key.split(/[-_]/).map((p) => p.toLowerCase()); // Split on hyphens and underscores

    for (const [resourceId, resource] of Object.entries(resourcesWithKeys)) {
      const kind = resource.kind.toLowerCase();
      const name = resource.metadata.name?.toLowerCase() || '';
      const resourceIdLower = resourceId.toLowerCase();

      // Pattern 1: Key parts match resource name parts
      // e.g., 'my-deployment' matches 'test-deployment' if 'deployment' appears in both
      const nameParts = name.split(/[-_]/).map((p) => p.toLowerCase());
      const hasCommonParts = keyParts.some((keyPart) =>
        nameParts.some((namePart) => keyPart.includes(namePart) || namePart.includes(keyPart))
      );

      if (hasCommonParts) {
        // Also check if the kinds match logically
        if (
          keyParts.includes(kind) ||
          (keyParts.includes('deployment') && kind === 'deployment') ||
          (keyParts.includes('service') && kind === 'service')
        ) {
          return resource;
        }
      }

      // Pattern 2: Key contains kind and resource ID contains resource name parts
      if (keyParts.includes(kind)) {
        const nameInResourceId = nameParts.some((part) => resourceIdLower.includes(part));
        if (nameInResourceId) {
          return resource;
        }
      }

      // Pattern 3: Common semantic patterns
      const semanticPatterns: Record<string, string[]> = {
        database: ['deployment', 'statefulset'],
        db: ['deployment', 'statefulset'],
        cache: ['deployment', 'statefulset'],
        redis: ['deployment', 'statefulset'],
        service: ['service'],
        svc: ['service'],
        ingress: ['ingress'],
        configmap: ['configmap'],
        secret: ['secret'],
      };

      for (const [pattern, kinds] of Object.entries(semanticPatterns)) {
        if (keyParts.includes(pattern) && kinds.includes(kind)) {
          return resource;
        }
      }
    }

    // Strategy 3: Case-insensitive match on generated resource ID
    for (const [resourceKey, resource] of Object.entries(resourcesWithKeys)) {
      if (resourceKey.toLowerCase() === keyLower) {
        return resource;
      }
    }

    // Strategy 4: Partial matching - find resources that contain key parts in their ID
    for (const [resourceKey, resource] of Object.entries(resourcesWithKeys)) {
      const resourceKeyLower = resourceKey.toLowerCase();
      if (keyParts.some((part) => part.length > 2 && resourceKeyLower.includes(part))) {
        return resource;
      }
    }

    return undefined;
  }

  // Create the base TypedResourceGraph object
  const baseResourceGraph = {
    name: definition.name,
    resources: Object.values(resourcesWithKeys),
    schema,
    // Store closures for access during factory creation
    closures,

    factory<TMode extends 'kro' | 'direct'>(
      mode: TMode,
      factoryOptions?: FactoryOptions
    ): FactoryForMode<TMode, TSpec, TStatus> {
      if (mode === 'direct') {
        const directFactory = createDirectResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          statusBuilder,
          { ...factoryOptions, closures } // Pass closures to factory
        );
        return directFactory as FactoryForMode<TMode, TSpec, TStatus>;
      } else if (mode === 'kro') {
        const kroFactory = createKroResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          statusMappings,
          { ...factoryOptions, closures } // Pass closures to Kro factory for validation and execution
        );
        return kroFactory as FactoryForMode<TMode, TSpec, TStatus>;
      } else {
        throw new Error(`Unsupported factory mode: ${mode}`);
      }
    },

    toYaml(): string {
      // Generate ResourceGraphDefinition YAML with user-defined status mappings
      const kroSchema = generateKroSchemaFromArktype(
        definition.name,
        schemaDefinition,
        resourcesWithKeys,
        optimizedStatusMappings
      );
      return serializeResourceGraphToYaml(definition.name, resourcesWithKeys, options, kroSchema);
    },
  };

  // Wrap with cross-composition magic proxy for resource access
  return new Proxy(baseResourceGraph, {
    get(target, prop, receiver) {
      // Handle existing properties normally
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      // For unknown properties, check if it's a resource key and create external ref
      const matchingResource = findResourceByKey(prop);
      if (matchingResource && matchingResource.metadata.name) {
        return externalRef(
          matchingResource.apiVersion,
          matchingResource.kind,
          matchingResource.metadata.name,
          matchingResource.metadata.namespace
        );
      }

      // Return undefined for non-existent properties (standard JavaScript behavior)
      return undefined;
    },

    // Ensure proper enumeration of properties
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    // Ensure proper property descriptor handling
    getOwnPropertyDescriptor(target, prop) {
      // For existing properties, return normal descriptor
      if (prop in target) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }

      // For resource properties, indicate they exist but are not enumerable
      const matchingResource = findResourceByKey(prop);
      if (matchingResource) {
        return {
          configurable: true,
          enumerable: false, // Don't enumerate resource properties in for..in loops
          value: undefined, // Value will be computed by get trap
        };
      }

      return undefined;
    },
  }) as TypedResourceGraph<TSpec, TStatus>;
}
