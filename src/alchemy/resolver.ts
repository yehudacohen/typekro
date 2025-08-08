/**
 * Alchemy-aware Reference Resolver
 * 
 * This module provides utilities for handling alchemy promises in resource references
 * and provides deferred resolution capabilities for mixed dependency scenarios.
 */

// Phase 4 alchemy integration
import type * as k8s from '@kubernetes/client-node';
import type { ResolutionContext } from '../core/types/deployment.js';
import type { KubernetesResource } from '../core/types/kubernetes.js';
import { generateDeterministicResourceId } from '../utils/helpers.js';

// Define alchemy-compatible types based on the actual alchemy domain model
// These represent the interface that alchemy resources should implement

/**
 * Alchemy resource interface - represents a resource managed by alchemy
 */
export interface AlchemyResource {
  readonly __alchemyResource: true;
  readonly id: string;
  readonly type: string;
  readonly fqn?: string;
  deploy(): Promise<unknown>;
  cleanup?(): Promise<void>;
}

/**
 * Alchemy promise interface - represents a pending alchemy resource
 */
export interface AlchemyPromise extends Promise<unknown> {
  readonly __alchemyPromise: true;
  readonly resourceId: string;
  readonly resourceType: string;
}

// Alchemy resource symbols for identification
const ALCHEMY_PROMISE_SYMBOL = Symbol.for('alchemy::promise');
const RESOURCE_ID_SYMBOL = Symbol.for('alchemy::resourceId');
const RESOURCE_TYPE_SYMBOL = Symbol.for('alchemy::resourceType');
const RESOURCE_FQN_SYMBOL = Symbol.for('alchemy::resourceFQN');

/**
 * Check if a value is an alchemy resource
 */
export function isAlchemyResource(value: unknown): value is AlchemyResource {
  return Boolean(
    value &&
    typeof value === 'object' &&
    '__alchemyResource' in value &&
    (value as AlchemyResource).__alchemyResource === true
  );
}

/**
 * Check if a value is an alchemy promise/resource
 */
export function isAlchemyPromise(value: unknown): value is AlchemyPromise {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (
      // Check for explicit alchemy promise marker
      ('__alchemyPromise' in value && (value as AlchemyPromise).__alchemyPromise === true) ||
      // Check for promise-like interface with alchemy symbols
      ('then' in value &&
        typeof (value as any).then === 'function' &&
        (ALCHEMY_PROMISE_SYMBOL in value ||
          RESOURCE_ID_SYMBOL in value ||
          RESOURCE_TYPE_SYMBOL in value ||
          RESOURCE_FQN_SYMBOL in value))
    )
  );
}

/**
 * Extended resolution context that can handle alchemy promises
 */
export interface AlchemyResolutionContext extends ResolutionContext {
  /**
   * Whether to preserve alchemy promises during resolution
   * When true, alchemy promises are left unresolved for later processing
   */
  deferAlchemyResolution?: boolean;

  /**
   * Map of alchemy resource IDs to their resolved values
   * Used for caching resolved alchemy resources
   */
  alchemyResourceCache?: Map<string, unknown>;
}

/**
 * Resolve references with alchemy promise awareness
 * 
 * @param obj - Object containing references to resolve
 * @param context - Resolution context with alchemy options
 * @returns Resolved object with alchemy promises handled according to context
 */
export async function resolveReferencesWithAlchemy<T>(obj: T, context: AlchemyResolutionContext): Promise<T> {
  if (context.deferAlchemyResolution) {
    // Preserve alchemy promises, only resolve TypeKro references
    return resolveTypeKroReferencesOnly(obj, context);
  } else {
    // Resolve all references including alchemy promises
    return resolveAllReferences(obj, context);
  }
}

/**
 * Resolve only TypeKro references, preserving alchemy promises
 * 
 * This is used when building resource graphs that will be processed by alchemy,
 * where alchemy promises should be preserved for later resolution within the
 * alchemy provider context.
 */
export async function resolveTypeKroReferencesOnly<T>(obj: T, context: AlchemyResolutionContext): Promise<T> {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Preserve alchemy promises
  if (isAlchemyPromise(obj)) {
    return obj;
  }

  // For TypeKro references, we would need to use the actual ReferenceResolver
  // For now, just return the object as-is since this is a simplified implementation
  // In a full implementation, this would use the ReferenceResolver

  // Recursively process arrays and objects
  if (Array.isArray(obj)) {
    const objArray = obj as unknown[];
    const resolved = await Promise.all(
      objArray.map(item => resolveTypeKroReferencesOnly(item, context))
    );
    return resolved as T;
  }

  if (typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = await resolveTypeKroReferencesOnly(value, context);
    }
    return resolved as T;
  }

  return obj;
}

/**
 * Resolve all references including alchemy promises
 * 
 * This is used within alchemy provider contexts where all references
 * should be fully resolved to their final values.
 */
export async function resolveAllReferences<T>(obj: T, context: AlchemyResolutionContext): Promise<T> {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Resolve alchemy promises
  if (isAlchemyPromise(obj)) {
    return resolveAlchemyPromise(obj, context) as Promise<T>;
  }

  // For TypeKro references, we would use the ReferenceResolver here
  // For now, just handle arrays and objects recursively

  // Recursively process arrays and objects
  if (Array.isArray(obj)) {
    const objArray = obj as unknown[];
    const resolved = await Promise.all(
      objArray.map(item => resolveAllReferences(item, context))
    );
    return resolved as T;
  }

  if (typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = await resolveAllReferences(value, context);
    }
    return resolved as T;
  }

  return obj;
}

/**
 * Resolve an alchemy promise to its final value
 */
export async function resolveAlchemyPromise(promise: AlchemyPromise, context: AlchemyResolutionContext): Promise<unknown> {
  // Check cache first
  const resourceId = getAlchemyResourceId(promise);
  if (context.alchemyResourceCache?.has(resourceId)) {
    return context.alchemyResourceCache.get(resourceId);
  }

  try {
    // Await the alchemy promise to get the resolved resource
    const resolvedResource = await promise;

    // Cache the resolved value
    if (!context.alchemyResourceCache) {
      context.alchemyResourceCache = new Map();
    }
    context.alchemyResourceCache.set(resourceId, resolvedResource);

    return resolvedResource;
  } catch (error) {
    throw new Error(`Failed to resolve alchemy resource ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get a deterministic identifier for an alchemy resource
 */
function getAlchemyResourceId(resource: AlchemyPromise | AlchemyResource): string {
  // Try to get the resource ID from alchemy symbols
  if (RESOURCE_ID_SYMBOL in resource) {
    return (resource as any)[RESOURCE_ID_SYMBOL];
  }

  if (RESOURCE_FQN_SYMBOL in resource) {
    return (resource as any)[RESOURCE_FQN_SYMBOL];
  }

  // For alchemy promises, try to get the resourceId property
  if ('resourceId' in resource && typeof resource.resourceId === 'string') {
    return resource.resourceId;
  }

  // Try to extract kind and name from the resource for deterministic ID
  const kind = RESOURCE_TYPE_SYMBOL in resource ? (resource as any)[RESOURCE_TYPE_SYMBOL] : 
               ('resourceType' in resource && typeof resource.resourceType === 'string') ? resource.resourceType : 'Resource';

  // Try to get name from resource metadata or properties
  let name = 'unknown';
  if (resource && typeof resource === 'object') {
    const resourceObj = resource as { 
      metadata?: { name?: string }; 
      name?: string; 
      id?: string; 
    };
    if (resourceObj.metadata?.name) {
      name = resourceObj.metadata.name;
    } else if (resourceObj.name) {
      name = resourceObj.name;
    } else if (resourceObj.id) {
      name = resourceObj.id;
    }
  }

  // Use the same deterministic ID generation as TypeKro resources
  try {
    return generateDeterministicResourceId(kind, name);
  } catch (_error) {
    // Fallback to a simple deterministic approach if generation fails
    const cleanKind = kind.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
    const cleanName = name.toLowerCase().replace(/[^a-zA-Z0-9]/g, '');
    return `${cleanKind}-${cleanName}`;
  }
}

/**
 * Build a resource graph with deferred alchemy resolution
 * 
 * This creates a resource graph where alchemy promises are preserved,
 * allowing them to be resolved later within the alchemy provider context.
 */
export async function buildResourceGraphWithDeferredResolution(
  resources: Record<string, unknown>,
  context: AlchemyResolutionContext
): Promise<Record<string, unknown>> {
  const deferredContext: AlchemyResolutionContext = {
    ...context,
    deferAlchemyResolution: true,
  };

  const resolvedResources: Record<string, unknown> = {};

  for (const [key, resource] of Object.entries(resources)) {
    resolvedResources[key] = await resolveReferencesWithAlchemy(resource, deferredContext);
  }

  return resolvedResources;
}

/**
 * Resolve all references within an alchemy provider context
 * 
 * This fully resolves all references including alchemy promises,
 * typically used within alchemy resource providers.
 */
export async function resolveAllReferencesInAlchemyContext(
  resources: Record<string, unknown>,
  context: AlchemyResolutionContext
): Promise<Record<string, unknown>> {
  const fullResolutionContext: AlchemyResolutionContext = {
    ...context,
    deferAlchemyResolution: false,
  };

  const resolvedResources: Record<string, unknown> = {};

  for (const [key, resource] of Object.entries(resources)) {
    resolvedResources[key] = await resolveReferencesWithAlchemy(resource, fullResolutionContext);
  }

  return resolvedResources;
}

/**
 * Check if an object contains any alchemy promises
 */
export function containsAlchemyPromises(obj: unknown): boolean {
  if (obj === null || obj === undefined) {
    return false;
  }

  if (isAlchemyPromise(obj)) {
    return true;
  }

  if (Array.isArray(obj)) {
    const objArray = obj as unknown[];
    return objArray.some(item => containsAlchemyPromises(item));
  }

  if (typeof obj === 'object') {
    return Object.values(obj).some(value => containsAlchemyPromises(value));
  }

  return false;
}

/**
 * Extract all alchemy promises from an object
 */
export function extractAlchemyPromises(obj: unknown): AlchemyPromise[] {
  const promises: AlchemyPromise[] = [];

  const extract = (value: unknown) => {
    if (value === null || value === undefined) {
      return;
    }

    if (isAlchemyPromise(value)) {
      promises.push(value);
      return;
    }

    if (Array.isArray(value)) {
      const valueArray = value as unknown[];
      valueArray.forEach(extract);
      return;
    }

    if (typeof value === 'object') {
      Object.values(value).forEach(extract);
    }
  };

  extract(obj);
  return promises;
}

/**
 * Create an alchemy-aware reference resolver context
 */
export function createAlchemyReferenceResolver(): AlchemyResolutionContext {
  return {
    deployedResources: [],
    kubeClient: {} as k8s.KubeConfig, // Would be properly initialized in real usage
    deferAlchemyResolution: false,
    alchemyResourceCache: new Map(),
  };
}

/**
 * Utility function to check if a resource graph contains mixed dependencies
 * (both alchemy promises and TypeKro references)
 */
export function hasMixedDependencies(resources: Record<string, unknown>): boolean {
  let hasAlchemyPromises = false;
  let hasTypeKroReferences = false;

  for (const resource of Object.values(resources)) {
    if (containsAlchemyPromises(resource)) {
      hasAlchemyPromises = true;
    }

    // Check for TypeKro references (simplified check)
    const hasTypeKroRefs = JSON.stringify(resource).includes('"__brand":"KubernetesRef"') ||
      JSON.stringify(resource).includes('"__brand":"CelExpression"');
    if (hasTypeKroRefs) {
      hasTypeKroReferences = true;
    }
  }

  return hasAlchemyPromises && hasTypeKroReferences;
}

/**
 * Create a deterministic alchemy resource configuration from a Kubernetes resource
 * This ensures alchemy resources have consistent IDs and types that match the Kubernetes resource
 */
export function createAlchemyResourceConfig(
  kubernetesResource: KubernetesResource,
  resourceId?: string
): {
  id: string;
  type: string;
  config: KubernetesResource;
} {
  const kind = kubernetesResource.kind || 'Resource';
  const name = kubernetesResource.metadata?.name || 'unnamed';

  // Use provided resourceId or generate deterministic one
  const id = resourceId || generateDeterministicResourceId(kind, name);

  // Type should match the Kubernetes kind for consistency
  const type = kind;

  return {
    id,
    type,
    config: kubernetesResource,
  };
}

/**
 * Create multiple alchemy resource configurations from a resource graph
 * This ensures all resources in a graph have consistent, deterministic IDs
 */
export function createAlchemyResourceConfigs(
  resources: Record<string, KubernetesResource>
): Record<string, {
  id: string;
  type: string;
  config: KubernetesResource;
}> {
  const configs: Record<string, {
    id: string;
    type: string;
    config: KubernetesResource;
  }> = {};

  for (const [resourceKey, kubernetesResource] of Object.entries(resources)) {
    // Use the resource key as the base for ID generation if no explicit ID
    const kind = kubernetesResource.kind || 'Resource';
    const name = kubernetesResource.metadata?.name || resourceKey;

    configs[resourceKey] = createAlchemyResourceConfig(kubernetesResource,
      generateDeterministicResourceId(kind, name)
    );
  }

  return configs;
}