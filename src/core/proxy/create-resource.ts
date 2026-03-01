/**
 * Core Proxy Engine & createResource Factory
 *
 * This module implements the magic proxy system that enables TypeScript-native
 * Kubernetes resource composition.  It is the **single source of truth** for:
 *
 * - `createRefFactory` — KubernetesRef proxy builder
 * - `createPropertyProxy` — spec/status property proxy
 * - `createGenericProxyResource` — top-level Enhanced proxy
 * - `createResource` — the public factory function
 *
 * The module lives in `core/` because it is foundational infrastructure used
 * by both `core/references/external-refs.ts` and every factory in
 * `factories/`.  `factories/shared.ts` re-exports `createResource` for
 * backward compatibility.
 */

import { getCurrentCompositionContext, isInStatusBuilderContext } from '../composition/context.js';
import { isDebugMode } from '../config/index.js';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { conditionalExpressionIntegrator } from '../expressions/conditional/conditional-integration.js';
import { getComponentLogger } from '../logging/index.js';
import { ReadinessEvaluatorRegistry } from '../readiness/index.js';
import { generateDeterministicResourceId } from '../resources/id.js';
import type { Enhanced, KubernetesResource, MagicProxy, ReadinessEvaluator } from '../types.js';
import { validateResourceId } from '../validation/cel-validator.js';

// Check for the debug environment variable
const IS_DEBUG_MODE = isDebugMode();

/**
 * Deep clone a value, stripping functions (which are non-serializable proxies).
 * Used by toJSON handlers on proxy objects to produce clean JSON output.
 */
function deepCloneValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value);
  if (value instanceof RegExp) return new RegExp(value);
  if (Array.isArray(value)) {
    return value.map((item) => deepCloneValue(item));
  }
  const cloned: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    if (typeof (value as Record<string, unknown>)[k] !== 'function') {
      cloned[k] = deepCloneValue((value as Record<string, unknown>)[k]);
    }
  }
  return cloned;
}

// Logger for debug mode
const debugLogger = getComponentLogger('factory-proxy');

// =============================================================================
// PROXY ENGINE
// =============================================================================

function createRefFactory(resourceId: string, basePath: string): unknown {
  const proxyTarget = () => {
    // Empty function used as proxy target
  };
  Object.defineProperty(proxyTarget, KUBERNETES_REF_BRAND, { value: true });
  Object.defineProperty(proxyTarget, 'resourceId', { value: resourceId });
  Object.defineProperty(proxyTarget, 'fieldPath', { value: basePath });

  // Make the proxy compatible with string, number, and boolean types
  Object.defineProperty(proxyTarget, 'valueOf', {
    value: () => basePath,
    enumerable: false,
  });
  Object.defineProperty(proxyTarget, 'toString', {
    value: () => basePath,
    enumerable: false,
  });

  return new Proxy(proxyTarget, {
    get(target, prop) {
      // Check for our defined properties first
      if (prop === KUBERNETES_REF_BRAND || prop === 'resourceId' || prop === 'fieldPath') {
        return target[prop as keyof typeof target];
      }

      // Check for other properties that exist on the target
      if (prop in target) return target[prop as keyof typeof target];

      // .orValue(defaultValue) — returns a CelExpression with orValue helper
      // Used for externalRef optional field access with default values
      if (prop === 'orValue') {
        return (defaultValue: unknown) => {
          const celExpr =
            typeof defaultValue === 'string'
              ? `${basePath}.orValue("${defaultValue}")`
              : `${basePath}.orValue(${String(defaultValue)})`;
          return {
            [CEL_EXPRESSION_BRAND]: true,
            expression: celExpr,
            _type: undefined,
          };
        };
      }

      const propStr = String(prop);

      // $ prefix — Kro optional access (.?field)
      if (propStr.startsWith('$')) {
        const actualField = propStr.substring(1);
        return createRefFactory(resourceId, `${basePath}.?${actualField}`);
      }

      // For unknown properties, create nested references
      return createRefFactory(resourceId, `${basePath}.${propStr}`);
    },
    // Proxy-based KubernetesRef factory: returns a dynamically-typed proxy
  }) as unknown;
}

function createPropertyProxy<T extends object>(
  resourceId: string,
  basePath: string,
  target: T
): MagicProxy<T> {
  if (IS_DEBUG_MODE) {
    debugLogger.debug('Proxy created', { resourceId, basePath });
  }

  return new Proxy(target, {
    /**
     * Trap for Object.keys, JSON.stringify, etc.
     */
    ownKeys(obj) {
      return Reflect.ownKeys(obj);
    },
    /**
     * Required for Object.keys() to work correctly with ownKeys trap
     */
    getOwnPropertyDescriptor(obj, prop) {
      return Reflect.getOwnPropertyDescriptor(obj, prop);
    },
    get: (obj, prop) => {
      // Handle toJSON specially to ensure proper serialization
      if (prop === 'toJSON') {
        return () => {
          const result: Record<string, unknown> = {};
          for (const key of Object.keys(obj)) {
            result[key] = deepCloneValue((obj as Record<string, unknown>)[key]);
          }
          return result;
        };
      }

      // 1. Immediately handle non-string properties.
      if (typeof prop !== 'string') {
        return obj[prop as keyof T];
      }

      // 2. Check if the user is explicitly requesting a reference with the '$' prefix.
      if (prop.startsWith('$')) {
        const actualProp = prop.substring(1);
        return createRefFactory(resourceId, `${basePath}.?${actualProp}`);
      }

      // 3. For any other access, default to "eager value" or "implicit ref for unknown" logic.
      if (isInStatusBuilderContext() && (basePath === 'status' || basePath === 'spec')) {
        return createRefFactory(resourceId, `${basePath}.${String(prop)}`);
      }

      if (prop in obj) {
        return obj[prop as keyof T];
      } else {
        return createRefFactory(resourceId, `${basePath}.${String(prop)}`);
      }
    },
    set: (obj, prop, value) => {
      if (IS_DEBUG_MODE) {
        debugLogger.debug('Proxy property set', { basePath, prop: String(prop), value });
      }
      return Reflect.set(obj, prop, value);
    },
  }) as MagicProxy<T>;
}

function createGenericProxyResource<TSpec extends object, TStatus extends object>(
  resourceId: string,
  resource: KubernetesResource<TSpec, TStatus>
): Enhanced<TSpec, TStatus> {
  Object.defineProperty(resource, '__resourceId', {
    value: resourceId,
    enumerable: false,
    configurable: true,
  });

  // Cache proxies to ensure the same proxy is returned each time
  let specProxy: MagicProxy<TSpec> | undefined;
  let statusProxy: MagicProxy<TStatus> | undefined;

  return new Proxy(resource, {
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    get(target, prop, receiver) {
      // Handle toJSON specially to ensure proper serialization
      if (prop === 'toJSON') {
        return () => {
          // Clone and filter out internal fields
          const result: Record<string, unknown> = {};
          for (const key of Object.keys(target)) {
            if (
              key !== '__resourceId' &&
              key !== 'withReadinessEvaluator' &&
              key !== 'readinessEvaluator' &&
              key !== 'id'
            ) {
              result[key] = deepCloneValue((target as unknown as Record<string, unknown>)[key]);
            }
          }
          return result;
        };
      }
      if (prop === 'spec') {
        if (!specProxy) {
          const spec = target.spec ?? ({} as TSpec);
          specProxy = createPropertyProxy(resourceId, 'spec', spec);
        }
        return specProxy;
      }
      if (prop === 'status') {
        if (!statusProxy) {
          const status = target.status ?? ({} as TStatus);
          statusProxy = createPropertyProxy(resourceId, 'status', status);
        }
        return statusProxy;
      }
      if (prop === 'metadata') {
        const metadata = target.metadata || {};
        const metadataProxy = createPropertyProxy(resourceId, 'metadata', metadata);

        if (metadata && typeof metadata === 'object') {
          for (const [key, value] of Object.entries(metadata)) {
            if (!Object.hasOwn(metadataProxy, key)) {
              Object.defineProperty(metadataProxy, key, {
                value: value,
                enumerable: true,
                configurable: true,
                writable: true,
              });
            }
          }
        }

        return metadataProxy;
      }
      if (prop === 'id') {
        return resourceId;
      }
      // Handle common Kubernetes resource fields as magic proxies
      if (prop === 'data' && 'data' in target) {
        const data = target.data ?? {};
        return createPropertyProxy(resourceId, 'data', data);
      }
      if (prop === 'stringData' && 'stringData' in target) {
        const stringData = target.stringData ?? {};
        return createPropertyProxy(resourceId, 'stringData', stringData);
      }
      if (prop === 'rules' && 'rules' in target) {
        const rules = target.rules ?? [];
        return createPropertyProxy(resourceId, 'rules', rules);
      }
      if (prop === 'roleRef' && 'roleRef' in target) {
        const roleRef = target.roleRef ?? {};
        return createPropertyProxy(resourceId, 'roleRef', roleRef);
      }
      if (prop === 'subjects' && 'subjects' in target) {
        const subjects = target.subjects ?? [];
        return createPropertyProxy(resourceId, 'subjects', subjects);
      }
      if (prop === 'provisioner' && 'provisioner' in target) {
        const provisioner = target.provisioner;
        if (provisioner !== undefined) {
          return provisioner;
        }
        return createRefFactory(resourceId, 'provisioner');
      }
      if (prop === 'parameters' && 'parameters' in target) {
        const parameters = target.parameters ?? {};
        return createPropertyProxy(resourceId, 'parameters', parameters);
      }
      if (prop === 'subsets' && 'subsets' in target) {
        const subsets = target.subsets ?? [];
        return createPropertyProxy(resourceId, 'subsets', subsets);
      }
      if (typeof prop === 'string' && prop.startsWith('$')) {
        return createRefFactory(resourceId, prop.substring(1));
      }

      // For external refs, unknown properties should return reference proxies
      if (
        typeof prop === 'string' &&
        '__externalRef' in target &&
        !(prop in target) &&
        !prop.startsWith('__')
      ) {
        return createRefFactory(resourceId, prop);
      }

      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  }) as Enhanced<TSpec, TStatus>;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Options for createResource function
 */
export interface CreateResourceOptions {
  /**
   * Kubernetes scope of the resource
   * - 'namespaced': Resource must exist within a namespace
   * - 'cluster': Resource is cluster-scoped and cannot have a namespace
   */
  scope?: 'namespaced' | 'cluster';
}

/**
 * Create an Enhanced proxy resource from a plain Kubernetes resource definition.
 *
 * This is the foundational factory function used by all TypeKro factories.
 * It wraps a resource in the magic proxy system that enables:
 * - Automatic KubernetesRef generation for spec/status property access
 * - Deterministic resource ID generation for Kro
 * - Composition context registration
 * - Readiness evaluator attachment
 *
 * @example
 * ```typescript
 * const deploy = createResource<V1DeploymentSpec, V1DeploymentStatus>({
 *   apiVersion: 'apps/v1',
 *   kind: 'Deployment',
 *   metadata: { name: 'my-app' },
 *   spec: { replicas: 3, ... },
 * });
 * ```
 */
export function createResource<TSpec extends object, TStatus extends object>(
  resource: KubernetesResource<TSpec, TStatus>,
  options?: CreateResourceOptions
): Enhanced<TSpec, TStatus> {
  // Validate namespace scope rules
  if (options?.scope) {
    const hasNamespace = !!resource.metadata?.namespace;

    if (options.scope === 'cluster' && hasNamespace) {
      throw new TypeKroError(
        `${resource.kind} is cluster-scoped and cannot have a namespace. ` +
          `Remove the 'namespace' field from metadata.`,
        'INVALID_RESOURCE_SCOPE',
        { kind: resource.kind, namespace: resource.metadata?.namespace }
      );
    }

    if (options.scope === 'namespaced' && !hasNamespace) {
      debugLogger.warn(
        `${resource.kind} is namespaced but no namespace specified. Kubernetes will use 'default'.`,
        {
          kind: resource.kind,
          name: resource.metadata?.name,
        }
      );
    }
  }

  let resourceId: string;

  // Check for id field on the resource itself
  if (resource.id) {
    resourceId = resource.id;

    // Validate that the ID follows camelCase convention
    const validation = validateResourceId(resourceId);
    if (!validation.isValid) {
      throw new TypeKroError(`Invalid resource ID: ${validation.error}`, 'INVALID_RESOURCE_ID', {
        resourceId,
        error: validation.error,
      });
    }

    // Remove the id field from the resource to prevent it from being sent to Kubernetes
    const { id: _id, ...cleanResource } = resource;
    resource = cleanResource;
  } else {
    // Use deterministic ID generation by default
    const name = resource.metadata?.name || resource.kind.toLowerCase();
    const namespace = resource.metadata?.namespace;
    resourceId = generateDeterministicResourceId(resource.kind, name, namespace);
  }

  const enhanced = createGenericProxyResource(resourceId, resource);

  // Auto-register with composition context if active (but not for external references)
  const context = getCurrentCompositionContext();
  if (context && !resource.__externalRef) {
    context.addResource(resourceId, enhanced);
  }

  // Add fluent builder method for readiness evaluator
  Object.defineProperty(enhanced, 'withReadinessEvaluator', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts evaluators typed for any K8s resource
    value: function (evaluator: ReadinessEvaluator<any>): Enhanced<TSpec, TStatus> {
      // Register in global registry by KIND
      ReadinessEvaluatorRegistry.getInstance().registerForKind(
        this.kind,
        evaluator,
        'factory-defined'
      );

      // Attach to individual resource instance
      Object.defineProperty(this, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,
        configurable: true,
        writable: false,
      });

      return this as Enhanced<TSpec, TStatus>;
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // Add conditional expression support
  const enhancedWithConditionals = conditionalExpressionIntegrator.addConditionalSupport(enhanced, {
    autoProcess: false,
    validateExpressions: true,
  });

  return enhancedWithConditionals as Enhanced<TSpec, TStatus>;
}
