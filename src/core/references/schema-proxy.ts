/**
 * Schema Proxy Factory for Kro Factory Pattern
 *
 * This module provides functionality to create schema proxies that return
 * KubernetesRef objects for field access, specifically marked as schema references.
 */

import { KUBERNETES_REF_BRAND } from '../constants/brands.js';
import type { KroCompatibleType, KubernetesRef, SchemaMagicProxy, SchemaProxy } from '../types.js';

/** Callback type for array iteration methods (map, forEach, filter, some, every) on schema proxies. */
type ArrayIterationCallback = (element: unknown, index: number, array: unknown[]) => unknown;

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

  // Create a single "element" proxy for iteration support.
  // When the schema ref is used as an iterable (for-of) or array-like (.map(), .filter(), etc.),
  // we yield a single element proxy. This causes factory calls inside loops to execute once,
  // registering the resource. The AST analyzer later detects the loop and attaches forEach.
  //
  // SENTINEL: We use `$item` (not `__element__`) because the ref marker regex
  // /__KUBERNETES_REF_{id}_{fieldPath}__/ uses [a-zA-Z0-9.] for fieldPath, and
  // underscores in `__element__` would break the delimiter detection.
  // `$item` uses `$` which is included in [a-zA-Z0-9.$] after we update the regex.
  const createElement = (): unknown => createSchemaRefFactory(`${fieldPath}.$item`);

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

      // Handle Symbol.toPrimitive — marker string for string coercion (template
      // literals), NaN for numeric coercion (comparisons like `ref >= 1`).
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => hint === 'string' ? `__KUBERNETES_REF___schema___${fieldPath}__` : NaN;
      }

      // Support for-of iteration: yield a single element proxy so loop bodies execute once
      if (prop === Symbol.iterator) {
        return function* () {
          yield createElement();
        };
      }

      // Array iteration methods: .map(), .forEach(), .filter(), .some(), .every()
      // Execute the callback once with a dummy element proxy so factory calls register.
      if (prop === 'map') {
        return (callback: ArrayIterationCallback) => {
          const elem = createElement();
          const result = callback(elem, 0, [elem]);
          return [result];
        };
      }
      if (prop === 'forEach') {
        return (callback: ArrayIterationCallback) => {
          callback(createElement(), 0, [createElement()]);
        };
      }
      if (prop === 'filter') {
        return (callback: ArrayIterationCallback) => {
          const elem = createElement();
          // Execute the predicate but always return the array with the element.
          // The predicate's return value is only used for AST analysis.
          callback(elem, 0, [elem]);
          // Return a proxy that also supports chaining (.filter().map())
          return createSchemaArrayProxy(fieldPath, callback);
        };
      }
      if (prop === 'some' || prop === 'every') {
        return (callback: ArrayIterationCallback) => {
          const elem = createElement();
          return callback(elem, 0, [elem]);
        };
      }

      // .length — return 1 (single element for iteration)
      if (prop === 'length') {
        return 1;
      }

      // Preserve essential function properties
      if (prop === 'call' || prop === 'apply' || prop === 'bind') {
        return target[prop as keyof typeof target];
      }

      // For any other property, create a new nested reference
      return createSchemaRefFactory(`${fieldPath}.${String(prop)}`);
    },
  }) as unknown as T;
}

/**
 * Creates a proxy for the result of .filter() calls on schema array refs.
 * This allows chaining like `spec.workers.filter(...).map(...)`.
 */
function createSchemaArrayProxy(
  baseFieldPath: string,
  _filterCallback: ArrayIterationCallback
): unknown[] {
  // Use $item sentinel (same as the primary array proxy) so that the marker regex
  // and YAML serializer's $item substitution work correctly for chained calls.
  const createElement = (): unknown => createSchemaRefFactory(`${baseFieldPath}.$item`);
  const arr = [createElement()];

  return new Proxy(arr, {
    get(target, prop) {
      if (prop === 'map') {
        return (callback: ArrayIterationCallback) => {
          const elem = createElement();
          const result = callback(elem, 0, arr);
          return [result];
        };
      }
      if (prop === 'forEach') {
        return (callback: ArrayIterationCallback) => {
          callback(createElement(), 0, arr);
        };
      }
      if (prop === 'length') {
        return 1;
      }
      if (prop === Symbol.iterator) {
        return function* () {
          yield createElement();
        };
      }
      // Default: delegate to the actual array
      return Reflect.get(target, prop);
    },
  });
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
          return createResourceMagicProxy(resourceKey, prop);
        }
        // For all other properties, return the original value
        return target[prop];
      },
    });
  }

  return proxiedResources as TResources;
}

/**
 * Create a magic proxy that converts Enhanced MagicProxy field access to resource references.
 * Delegates to createResourceRefFactory for deep nesting support.
 */
function createResourceMagicProxy(resourceId: string, fieldType: string): unknown {
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

      // Handle Symbol.toPrimitive — marker string for string coercion, NaN for numeric.
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => hint === 'string' ? `__KUBERNETES_REF_${resourceId}_${fieldPath}__` : NaN;
      }

      // Preserve essential function properties
      if (prop === 'call' || prop === 'apply' || prop === 'bind') {
        return target[prop as keyof typeof target];
      }

      // For any other property, create a new nested reference
      return createResourceRefFactory(resourceId, `${fieldPath}.${String(prop)}`);
    },
  }) as unknown as T;
}
