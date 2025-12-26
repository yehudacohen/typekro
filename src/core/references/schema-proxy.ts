/**
 * Schema Proxy Factory for Kro Factory Pattern
 *
 * This module provides functionality to create schema proxies that return
 * KubernetesRef objects for field access, specifically marked as schema references.
 */

import { KUBERNETES_REF_BRAND } from '../constants/brands.js';
import type { KroCompatibleType, KubernetesRef, SchemaMagicProxy, SchemaProxy } from '../types.js';

/**
 * Creates a KubernetesRef object specifically for schema references
 * These are distinguished from external references by using a special resource ID prefix
 */
function createSchemaRefFactory<T = unknown>(fieldPath: string): T {
  const proxyTarget = () => {
    // Empty function used as proxy target
  };
  Object.defineProperty(proxyTarget, KUBERNETES_REF_BRAND, { value: true, enumerable: false });
  Object.defineProperty(proxyTarget, 'resourceId', { value: '__schema__', enumerable: false });
  Object.defineProperty(proxyTarget, 'fieldPath', { value: fieldPath, enumerable: false });

  return new Proxy(proxyTarget, {
    get(target, prop) {
      // Check for our defined properties first
      if (prop === KUBERNETES_REF_BRAND || prop === 'resourceId' || prop === 'fieldPath') {
        return target[prop as keyof typeof target];
      }

      // Handle toString specially to return a detectable string for template literals
      if (prop === 'toString') {
        return () => `__KUBERNETES_REF___schema___${fieldPath}__`;
      }

      // Handle valueOf specially to return a detectable string for template literals
      if (prop === 'valueOf') {
        return () => `__KUBERNETES_REF___schema___${fieldPath}__`;
      }

      // Handle Symbol.toPrimitive for template literal coercion
      if (prop === Symbol.toPrimitive) {
        return () => `__KUBERNETES_REF___schema___${fieldPath}__`;
      }

      // Preserve essential function properties
      if (
        prop === 'call' ||
        prop === 'apply' ||
        prop === 'bind'
      ) {
        return target[prop as keyof typeof target];
      }

      // For any other property, create a new nested reference
      return createSchemaRefFactory(`${fieldPath}.${String(prop)}`);
    },
  }) as unknown as T;
}

/**
 * Creates a MagicProxy for a specific schema section (spec or status)
 * that returns KubernetesRef objects for any accessed property
 */
function createSchemaMagicProxy<T extends object>(basePath: string): SchemaMagicProxy<T> {
  // Create an empty target object that will serve as the proxy base
  const target = {} as T;

  return new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') {
        return obj[prop as keyof T];
      }

      // Always return a schema reference for any string property access
      return createSchemaRefFactory(`${basePath}.${prop}`);
    },
  }) as SchemaMagicProxy<T>;
}

/**
 * Creates a schema proxy that provides type-safe access to spec and status fields
 *
 * @returns SchemaProxy with spec and status MagicProxy objects
 *
 * @example
 * ```typescript
 * interface MySpec { name: string; replicas: number; }
 * interface MyStatus { ready: boolean; url: string; }
 *
 * const schema = createSchemaProxy<MySpec, MyStatus>();
 *
 * // These return KubernetesRef objects with schema marking
 * const nameRef = schema.spec.name; // KubernetesRef with fieldPath: "spec.name"
 * const readyRef = schema.status.ready; // KubernetesRef with fieldPath: "status.ready"
 * ```
 */
export function createSchemaProxy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(): SchemaProxy<TSpec, TStatus> {
  return {
    spec: createSchemaMagicProxy<TSpec>('spec'),
    status: createSchemaMagicProxy<TStatus>('status'),
  };
}

/**
 * Utility function to check if a KubernetesRef is a schema reference
 *
 * @param ref - The KubernetesRef to check
 * @returns true if the reference is a schema reference, false otherwise
 */
export function isSchemaReference(ref: KubernetesRef<unknown>): boolean {
  return ref.resourceId === '__schema__';
}

/**
 * Create a magic proxy for resources in StatusBuilder
 * This allows accessing resource.status.field as KubernetesRef objects while preserving types
 */
export function createResourcesProxy<TResources extends Record<string, any>>(
  resources: TResources
): TResources {
  const proxiedResources: any = {};

  for (const [resourceKey, resource] of Object.entries(resources)) {
    // Create a proxy that preserves the Enhanced resource structure
    // but converts field access to resource references instead of schema references
    proxiedResources[resourceKey] = new Proxy(resource, {
      get(target, prop: string) {
        if (prop === 'metadata') {
          return resource.metadata;
        }
        if (prop === 'kind') {
          return resource.kind;
        }
        if (prop === 'apiVersion') {
          return resource.apiVersion;
        }
        if (prop === 'spec' || prop === 'status') {
          // Return a proxy that converts the MagicProxy field access to resource references
          return createResourceMagicProxy(resourceKey, prop, target[prop]);
        }
        // For all other properties, return the original value
        return target[prop];
      },
    });
  }

  return proxiedResources as TResources;
}

/**
 * Create a magic proxy that converts Enhanced MagicProxy field access to resource references
 * Uses recursive proxy creation similar to createSchemaRefFactory for deep nesting support
 */
function createResourceMagicProxy(resourceId: string, fieldType: string, _originalProxy: any): any {
  return createResourceRefFactory(resourceId, fieldType);
}

/**
 * Creates a KubernetesRef object for resource references with recursive nesting support
 * Similar to createSchemaRefFactory but for resource references instead of schema references
 */
function createResourceRefFactory<T = unknown>(resourceId: string, fieldPath: string): T {
  const proxyTarget = () => {
    // Empty function used as proxy target
  };
  Object.defineProperty(proxyTarget, KUBERNETES_REF_BRAND, { value: true, enumerable: false });
  Object.defineProperty(proxyTarget, 'resourceId', { value: resourceId, enumerable: false });
  Object.defineProperty(proxyTarget, 'fieldPath', { value: fieldPath, enumerable: false });

  return new Proxy(proxyTarget, {
    get(target, prop) {
      // Check for our defined properties first
      if (prop === KUBERNETES_REF_BRAND || prop === 'resourceId' || prop === 'fieldPath') {
        return target[prop as keyof typeof target];
      }

      // Handle toString specially to return a detectable string for template literals
      if (prop === 'toString') {
        return () => `__KUBERNETES_REF_${resourceId}_${fieldPath}__`;
      }

      // Handle valueOf specially to return a detectable string for template literals
      if (prop === 'valueOf') {
        return () => `__KUBERNETES_REF_${resourceId}_${fieldPath}__`;
      }

      // Handle Symbol.toPrimitive for template literal coercion
      if (prop === Symbol.toPrimitive) {
        return () => `__KUBERNETES_REF_${resourceId}_${fieldPath}__`;
      }

      // Preserve essential function properties
      if (
        prop === 'call' ||
        prop === 'apply' ||
        prop === 'bind'
      ) {
        return target[prop as keyof typeof target];
      }

      // For any other property, create a new nested reference
      return createResourceRefFactory(resourceId, `${fieldPath}.${String(prop)}`);
    },
  }) as unknown as T;
}
