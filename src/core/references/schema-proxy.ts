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
 * Extract the declared child-field shape from an Arktype JSON node.
 *
 * Returns one of:
 *   - `{ kind: 'object', children: Map<fieldName, childNode> }` for an
 *     object type with `required`/`optional` declarations
 *   - `{ kind: 'map' }` for a `Record<string, V>` style index type
 *     (no enumerable keys known at analysis time — callers use a
 *     sentinel key to satisfy presence checks)
 *   - `undefined` for scalar leaves or unknown/absent schema info
 *
 * **Why this matters:** plain `ownKeys`/`getOwnPropertyDescriptor`
 * enumeration on a schema proxy is otherwise opaque — the proxy
 * target is an empty function, so `{ ...spec.processing }` silently
 * drops every field. Shape-awareness lets spread enumerate the real
 * arktype-declared fields and create lazy sub-proxies for each one.
 */
interface ObjectShape {
  kind: 'object';
  children: Map<string, unknown>;
}
interface MapShape {
  kind: 'map';
}
type SchemaShape = ObjectShape | MapShape | undefined;

function analyzeSchemaShape(schemaNode: unknown): SchemaShape {
  if (!schemaNode || typeof schemaNode !== 'object') return undefined;
  const node = schemaNode as {
    required?: { key: string; value: unknown }[];
    optional?: { key: string; value: unknown }[];
    index?: { signature?: unknown; value?: unknown }[];
    domain?: unknown;
  };
  // Map / Record type — `{ domain: 'object', index: [{ signature: 'string', value: V }] }`.
  // No statically-knowable keys; callers fall back to the sentinel.
  if (node.domain === 'object' && Array.isArray(node.index) && !node.required && !node.optional) {
    return { kind: 'map' };
  }
  const required = Array.isArray(node.required) ? node.required : [];
  const optional = Array.isArray(node.optional) ? node.optional : [];
  if (required.length === 0 && optional.length === 0) return undefined;
  const children = new Map<string, unknown>();
  for (const entry of [...required, ...optional]) {
    if (entry && typeof entry.key === 'string') {
      children.set(entry.key, entry.value);
    }
  }
  return { kind: 'object', children };
}

/**
 * Creates a KubernetesRef object specifically for schema references
 * These are distinguished from external references by using a special resource ID prefix.
 *
 * The optional `schemaNode` is the Arktype JSON subtree for this field. When
 * provided, the proxy reports its declared child fields via `ownKeys` /
 * `getOwnPropertyDescriptor`, making spread (`...spec.processing`) and
 * `Object.keys(spec.processing)` enumerate the real schema fields instead of
 * dropping them. Fields accessed via `get` still work identically — the schema
 * node is threaded through so nested access carries the correct sub-schema.
 */
function createSchemaRefFactory<T = unknown>(fieldPath: string, schemaNode?: unknown): T {
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

  // Analyze the arktype JSON shape once so ownKeys/getOwnPropertyDescriptor
  // can report real declared fields and produce matching sub-proxies.
  const shape = analyzeSchemaShape(schemaNode);

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

      // For any other property, create a new nested reference. Thread the
      // child's arktype JSON node through so nested access carries its
      // own shape — `spec.processing.eventKey` gets the `string` schema
      // and will be a scalar leaf; `spec.processing` gets the object
      // schema with `required`/`optional` children.
      const childNode =
        shape?.kind === 'object' ? shape.children.get(String(prop)) : undefined;
      return createSchemaRefFactory(`${fieldPath}.${String(prop)}`, childNode);
    },

    // `ownKeys` determines what spread (`{ ...spec.X }`) and
    // `Object.keys(spec.X)` see. Three cases:
    //
    //   1. Object shape — return the declared field names from the
    //      arktype JSON. Spread now preserves the real fields instead
    //      of producing an empty object.
    //   2. Map shape (`Record<string, V>`) — return a sentinel key so
    //      `Object.keys(spec.secrets).length > 0` evaluates to `true`
    //      during schema-proxy analysis. Without this, a conditional
    //      `if (hasItems)` branch gets skipped and produces an
    //      incomplete stub resource in the RGD.
    //   3. Unknown shape (no schemaNode threaded through, or a scalar
    //      leaf) — fall back to the sentinel for backward compat with
    //      code paths that haven't been updated to pass schema info.
    //
    // In all cases we must also return the non-configurable own
    // properties defined on the target (`resourceId`, `fieldPath`,
    // and the brand symbol), otherwise the Proxy invariant that
    // `ownKeys` must include all non-configurable target keys is
    // violated and Node throws a TypeError.
    ownKeys(target) {
      // The proxy target is a function, so `Reflect.ownKeys` returns its
      // built-in own keys (`length`, `name`, `prototype`) plus our
      // `defineProperty`'d brand/resourceId/fieldPath. We MUST include
      // every non-configurable target key to satisfy the Proxy
      // invariant, but we also MUST NOT report any duplicates —
      // the Proxy spec throws a TypeError otherwise.
      //
      // Dedupe by building a Set: start with the target keys, then add
      // the schema-declared child field names (or the sentinel for
      // map/unknown shapes). Schema fields that collide with built-in
      // function keys like `name` are silently dropped from the
      // enumeration — accessing them still works via the `get` trap
      // because the target's own `name` (the function's built-in)
      // wins in `get` lookups only when the property exists on the
      // target AND the proxy's `get` trap doesn't intercept it, but
      // our `get` trap intercepts every string key and returns a
      // schema ref. So the invariant-driven dedup is safe.
      const keys = new Set<string | symbol>(Reflect.ownKeys(target));
      if (shape?.kind === 'object') {
        for (const childKey of shape.children.keys()) keys.add(childKey);
      } else {
        // Sentinel key for map/unknown shapes so `Object.keys(spec.X).length > 0`
        // evaluates to true. This is a **reserved property name** — user specs
        // must not declare a field literally named `__typekroSchemaKey`.
        keys.add('__typekroSchemaKey');
      }
      return [...keys];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (shape?.kind === 'object' && typeof prop === 'string' && shape.children.has(prop)) {
        return {
          value: createSchemaRefFactory(
            `${fieldPath}.${prop}`,
            shape.children.get(prop)
          ),
          writable: false,
          enumerable: true,
          configurable: true,
        };
      }
      if (prop === '__typekroSchemaKey') {
        return {
          value: createSchemaRefFactory(`${fieldPath}.__typekroSchemaKey`),
          writable: false,
          enumerable: true,
          configurable: true,
        };
      }
      // Fall through to the target for everything else so the
      // `ownKeys` invariant for non-configurable properties holds.
      return Reflect.getOwnPropertyDescriptor(target, prop);
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
 * that returns KubernetesRef objects for any accessed property.
 *
 * The optional `schemaNode` is the top-level Arktype JSON node for this
 * section. When provided, it enables shape-aware enumeration — spread
 * (`{ ...schema.spec }`) and `Object.keys(schema.spec)` return the
 * declared field names instead of an empty object.
 */
function createSchemaMagicProxy<T extends object>(
  basePath: string,
  schemaNode?: unknown
): SchemaMagicProxy<T> {
  // Create an empty target object that will serve as the proxy base
  const target = {} as T;

  const shape = analyzeSchemaShape(schemaNode);

  return new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') {
        return obj[prop as keyof T];
      }

      // Always return a schema reference for any string property access.
      // Thread the child's JSON node through when the shape is known so
      // nested access carries the right sub-schema all the way down.
      const childNode =
        shape?.kind === 'object' ? shape.children.get(prop) : undefined;
      return createSchemaRefFactory(`${basePath}.${prop}`, childNode);
    },
    ownKeys() {
      if (shape?.kind === 'object') {
        return [...shape.children.keys()];
      }
      // Unknown or map-typed root — leave the proxy opaque. The root
      // is never spread in practice (`...schema.spec` is nonsensical),
      // so returning an empty list is the safe default.
      return [];
    },
    getOwnPropertyDescriptor(_obj, prop) {
      if (
        shape?.kind === 'object' &&
        typeof prop === 'string' &&
        shape.children.has(prop)
      ) {
        return {
          value: createSchemaRefFactory(
            `${basePath}.${prop}`,
            shape.children.get(prop)
          ),
          writable: false,
          enumerable: true,
          configurable: true,
        };
      }
      return undefined;
    },
  }) as SchemaMagicProxy<T>;
}

/**
 * Creates a schema proxy that provides type-safe access to spec and status fields.
 *
 * The optional `specJson` / `statusJson` parameters are the Arktype JSON
 * representations of the spec and status schemas. When passed, the
 * returned proxy is **shape-aware**: spread (`{ ...schema.spec }`)
 * enumerates the declared fields, `Object.keys` returns them, and
 * `getOwnPropertyDescriptor` yields lazy sub-proxies for each. Without
 * the JSON the proxy still works for plain property access but spread
 * produces an empty object — matching the old opaque behavior for
 * backward compat with callers that don't yet thread the schema.
 *
 * @param specJson - Optional Arktype JSON node for the spec schema
 * @param statusJson - Optional Arktype JSON node for the status schema
 *
 * @example
 * ```typescript
 * const schema = createSchemaProxy<MySpec, MyStatus>(
 *   mySpecType.json,
 *   myStatusType.json
 * );
 * const nameRef = schema.spec.name; // KubernetesRef with fieldPath: "spec.name"
 * const readyRef = schema.status.ready; // KubernetesRef with fieldPath: "status.ready"
 * ```
 */
export function createSchemaProxy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(specJson?: unknown, statusJson?: unknown): SchemaProxy<TSpec, TStatus> {
  return {
    spec: createSchemaMagicProxy<TSpec>('spec', specJson),
    status: createSchemaMagicProxy<TStatus>('status', statusJson),
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
export function createResourcesProxy<TResources extends Record<string, unknown>>(
  resources: TResources
): TResources {
  const proxiedResources: Record<string, unknown> = {};

  for (const [resourceKey, resource] of Object.entries(resources)) {
    const resourceRecord = resource as {
      metadata?: unknown;
      kind?: unknown;
      apiVersion?: unknown;
    } & Record<string, unknown>;
    // Create a proxy that preserves the Enhanced resource structure
    // but converts field access to resource references instead of schema references
    proxiedResources[resourceKey] = new Proxy(resourceRecord, {
      get(target, prop: string) {
        if (prop === 'metadata') {
          return resourceRecord.metadata;
        }
        if (prop === 'kind') {
          return resourceRecord.kind;
        }
        if (prop === 'apiVersion') {
          return resourceRecord.apiVersion;
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
