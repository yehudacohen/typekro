/**
 * Shared utilities for factory functions
 *
 * This module contains common utilities and helper functions that are used
 * across all factory modules for creating Kubernetes resources.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { V1EnvVar, V1PodSpec } from '@kubernetes/client-node';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../core/constants/brands.js';
import { TypeKroError } from '../core/errors.js';
import { conditionalExpressionIntegrator } from '../core/expressions/conditional-integration.js';
import { getComponentLogger } from '../core/logging/index.js';
import { ReadinessEvaluatorRegistry } from '../core/readiness/index.js';
import type {
  Enhanced,
  KubernetesResource,
  MagicProxy,
  ReadinessEvaluator,
} from '../core/types.js';
import { validateResourceId } from '../core/validation/cel-validator.js';
import { generateDeterministicResourceId, isKubernetesRef } from '../utils/index';
import { isCelExpression } from '../utils/type-guards.js';

// Check for the debug environment variable
const IS_DEBUG_MODE = process.env.TYPEKRO_DEBUG === 'true';

// Logger for debug mode
const debugLogger = getComponentLogger('factory-proxy');

// =============================================================================
// COMPOSITION CONTEXT INFRASTRUCTURE
// =============================================================================

/**
 * Context for imperative composition pattern
 * Tracks resources and deployment closures created during composition function execution
 */
export interface CompositionContext {
  /** Map of resource ID to Enhanced resource */
  resources: Record<string, Enhanced<any, any>>;
  /** Map of closure ID to deployment closure */
  closures: Record<string, any>; // Using 'any' to avoid circular dependency with DeploymentClosure
  /** Counter for generating unique resource IDs */
  resourceCounter: number;
  /** Counter for generating unique closure IDs */
  closureCounter: number;
  /** Counter for composition instances */
  compositionInstanceCounter: number;
  /** Map of variable names to resource IDs for CEL expression generation */
  variableMappings: Record<string, string>;
  /** Add a resource to the context */
  addResource(id: string, resource: Enhanced<any, any>): void;
  /** Add a deployment closure to the context */
  addClosure(id: string, closure: any): void;
  /** Add a variable to resource ID mapping */
  addVariableMapping(variableName: string, resourceId: string): void;
  /** Generate a unique resource ID */
  generateResourceId(kind: string, name?: string): string;
  /** Generate a unique closure ID */
  generateClosureId(name?: string): string;
}

/**
 * AsyncLocalStorage for composition context
 * Enables context-aware resource registration across async boundaries
 */
const COMPOSITION_CONTEXT = new AsyncLocalStorage<CompositionContext>();

/**
 * AsyncLocalStorage for status builder context.
 *
 * When active, property access on Enhanced resource proxies always returns
 * KubernetesRef objects (instead of eager values), enabling JavaScript-to-CEL
 * conversion in status builder functions.
 *
 * Replaces the previous `(globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__`
 * mutable global flag with a properly scoped, async-safe context.
 */
const STATUS_BUILDER_CONTEXT = new AsyncLocalStorage<boolean>();

/**
 * Check if the current execution is within a status builder context.
 */
export function isInStatusBuilderContext(): boolean {
  return STATUS_BUILDER_CONTEXT.getStore() === true;
}

/**
 * Run a function within a status builder context where Enhanced resource
 * proxies return KubernetesRef objects for all property access.
 */
export function runInStatusBuilderContext<T>(fn: () => T): T {
  return STATUS_BUILDER_CONTEXT.run(true, fn);
}

/**
 * Get the current composition context if one is active
 * @returns The active composition context or undefined if not in composition
 */
export function getCurrentCompositionContext(): CompositionContext | undefined {
  return COMPOSITION_CONTEXT.getStore();
}

/**
 * Run a function with a composition context
 * @param context The composition context to use
 * @param fn The function to run with the context
 * @returns The result of the function
 */
export function runWithCompositionContext<T>(context: CompositionContext, fn: () => T): T {
  return COMPOSITION_CONTEXT.run(context, fn);
}

/**
 * Generic deployment closure registration wrapper
 * Automatically registers any deployment closure with the active composition context
 *
 * @param closureFactory Function that creates the deployment closure
 * @param name Optional name for the closure (used for ID generation)
 * @returns The deployment closure, registered with context if active
 */
export function registerDeploymentClosure<T>(closureFactory: () => T, name?: string): T {
  const context = getCurrentCompositionContext();

  if (context) {
    const closure = closureFactory();
    const closureId = context.generateClosureId(name);
    context.addClosure(closureId, closure);
    return closure;
  }

  // Outside composition context - return closure as-is
  return closureFactory();
}

/**
 * Options for composition context creation
 */
export interface CompositionContextOptions {
  /**
   * When true, duplicate resource IDs get a numeric suffix instead of overwriting.
   * Used during direct-mode re-execution where forEach loops create multiple
   * resources with the same id (e.g., 'regionDep' → 'regionDep', 'regionDep-1', 'regionDep-2').
   */
  deduplicateIds?: boolean;
}

/**
 * Create a new composition context with default implementations
 * @param name Optional name for the composition (used in ID generation)
 * @param contextOptions Options controlling context behavior
 * @returns A new composition context
 */
export function createCompositionContext(
  name?: string,
  contextOptions?: CompositionContextOptions
): CompositionContext {
  const idCounts: Record<string, number> = {};

  return {
    resources: {},
    closures: {},
    resourceCounter: 0,
    closureCounter: 0,
    compositionInstanceCounter: 0,
    variableMappings: {},
    addResource(id: string, resource: Enhanced<any, any>) {
      if (contextOptions?.deduplicateIds && id in this.resources) {
        // Append numeric suffix to make the key unique
        idCounts[id] = (idCounts[id] ?? 0) + 1;
        const count = idCounts[id];
        this.resources[`${id}-${count}`] = resource;
      } else {
        this.resources[id] = resource;
      }
    },
    addClosure(id: string, closure: any) {
      this.closures[id] = closure;
    },
    addVariableMapping(variableName: string, resourceId: string) {
      this.variableMappings[variableName] = resourceId;
    },
    generateResourceId(kind: string, resourceName?: string) {
      return resourceName || `${kind.toLowerCase()}-${++this.resourceCounter}`;
    },
    generateClosureId(closureName?: string) {
      const prefix = name ? `${name}-` : '';
      return closureName ? `${prefix}${closureName}` : `${prefix}closure-${++this.closureCounter}`;
    },
  };
}

// =============================================================================
// PROXY ENGINE & BASE FACTORY
// =============================================================================

function createRefFactory(resourceId: string, basePath: string): any {
  const proxyTarget = () => {
    // Empty function used as proxy target
  };
  Object.defineProperty(proxyTarget, KUBERNETES_REF_BRAND, { value: true });
  Object.defineProperty(proxyTarget, 'resourceId', { value: resourceId });
  Object.defineProperty(proxyTarget, 'fieldPath', { value: basePath });

  // Make the proxy compatible with string, number, and boolean types
  Object.defineProperty(proxyTarget, 'valueOf', {
    value: () => basePath, // Return a string representation
    enumerable: false,
  });
  Object.defineProperty(proxyTarget, 'toString', {
    value: () => basePath, // Return a string representation
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
      // `config.data?.$region` → field path uses `.?region` instead of `.region`
      if (propStr.startsWith('$')) {
        const actualField = propStr.substring(1);
        return createRefFactory(resourceId, `${basePath}.?${actualField}`);
      }

      // For unknown properties, create nested references
      return createRefFactory(resourceId, `${basePath}.${propStr}`);
    },
  }) as any; // Force TypeScript to see this as compatible with any type
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
     * This is crucial for making the proxy serializable. It ensures that
     * when something tries to get the keys of the proxy, it gets the keys
     * of the underlying target object.
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
          // Deep clone with array preservation
          const deepClone = (value: any): any => {
            if (value === null || value === undefined) return value;
            if (typeof value !== 'object') return value;
            if (value instanceof Date) return new Date(value);
            if (value instanceof RegExp) return new RegExp(value);
            if (Array.isArray(value)) {
              return value.map((item) => deepClone(item));
            }
            const cloned: Record<string, any> = {};
            for (const k of Object.keys(value)) {
              if (typeof value[k] !== 'function') {
                cloned[k] = deepClone(value[k]);
              }
            }
            return cloned;
          };

          const result: Record<string, any> = {};
          for (const key of Object.keys(obj)) {
            result[key] = deepClone((obj as Record<string, unknown>)[key]);
          }
          return result;
        };
      }

      // 1. Immediately handle non-string properties.
      if (typeof prop !== 'string') {
        return obj[prop as keyof T];
      }

      // 2. Check if the user is explicitly requesting a reference with the '$' prefix.
      //    $ prefix produces Kro optional access: .?field instead of .field
      if (prop.startsWith('$')) {
        const actualProp = prop.substring(1);
        return createRefFactory(resourceId, `${basePath}.?${actualProp}`);
      }

      // 3. For any other access, default to the "eager value" or "implicit ref for unknown" logic.
      // IMPORTANT: For JavaScript-to-CEL conversion to work, we need to check if we're in
      // a status builder context where ALL property access should return KubernetesRef objects
      if (isInStatusBuilderContext() && (basePath === 'status' || basePath === 'spec')) {
        // In status builder context, ALWAYS return KubernetesRef objects for spec/status fields
        // This allows expressions like `resources.deployment.status.readyReplicas > 0` to work
        return createRefFactory(resourceId, `${basePath}.${String(prop)}`);
      }

      if (prop in obj) {
        // If it's a known property, return its value.
        return obj[prop as keyof T];
      } else {
        // If it's an unknown property (like from a schema), create the reference implicitly.
        return createRefFactory(resourceId, `${basePath}.${String(prop)}`);
      }
    },
    set: (obj, prop, value) => {
      if (IS_DEBUG_MODE) {
        debugLogger.debug('Proxy property set', { basePath, prop: String(prop), value });
      }
      // Transparently accept KubernetesRef and CelExpression objects
      // The serialization system will handle converting them to CEL expressions
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
    /**
     * Trap for Object.keys, JSON.stringify, etc.
     * This is crucial for making the proxy serializable. It ensures that
     * when something tries to get the keys of the proxy, it gets the keys
     * of the underlying resource object.
     */
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    get(target, prop, receiver) {
      // Handle toJSON specially to ensure proper serialization
      if (prop === 'toJSON') {
        return () => {
          // Deep clone with array preservation
          // Cannot use structuredClone because it can't clone functions (readinessEvaluator)
          const deepClone = (obj: any): any => {
            if (obj === null || obj === undefined) return obj;
            if (typeof obj !== 'object') return obj;
            if (obj instanceof Date) return new Date(obj);
            if (obj instanceof RegExp) return new RegExp(obj);
            if (Array.isArray(obj)) {
              return obj.map((item) => deepClone(item));
            }
            const result: Record<string, any> = {};
            for (const key of Object.keys(obj)) {
              if (typeof obj[key] !== 'function') {
                result[key] = deepClone(obj[key]);
              }
            }
            return result;
          };

          // Clone and filter out internal fields that should not be sent to Kubernetes
          const result: Record<string, any> = {};
          for (const key of Object.keys(target)) {
            if (
              key !== '__resourceId' &&
              key !== 'withReadinessEvaluator' &&
              key !== 'readinessEvaluator' &&
              key !== 'id' // Filter out id field - it's for TypeKro internal use only
            ) {
              result[key] = deepClone((target as unknown as Record<string, unknown>)[key]);
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
        // For metadata, we need to ensure it's serializable while still providing proxy functionality
        const metadata = target.metadata || {};
        const metadataProxy = createPropertyProxy(resourceId, 'metadata', metadata);

        // Add enumerable properties to make it JSON serializable
        // This ensures that JSON.stringify can access the metadata fields
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
        return resourceId; // Return the resource ID directly
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
          return provisioner; // Return the actual string value
        }
        return createRefFactory(resourceId, 'provisioner'); // Create reference if not set
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
      // since the resource shape is unstructured (we don't know its fields).
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
      // Transparently accept KubernetesRef and CelExpression objects
      // The serialization system will handle converting them to CEL expressions
      return Reflect.set(target, prop, value, receiver);
    },
  }) as Enhanced<TSpec, TStatus>;
}

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

  // Auto-register with composition context if active (but not for external references —
  // those are registered explicitly by the externalRef() function when called from user code)
  const context = getCurrentCompositionContext();
  if (context && !resource.__externalRef) {
    context.addResource(resourceId, enhanced);
  }

  // NOTE: No default readiness evaluator is assigned here. Each factory must
  // explicitly call .withReadinessEvaluator() to provide one. Resources without
  // an evaluator will cause ensureReadinessEvaluator() to throw at deploy time.

  // Add fluent builder method for readiness evaluator with serialization protection
  Object.defineProperty(enhanced, 'withReadinessEvaluator', {
    value: function (evaluator: ReadinessEvaluator): Enhanced<TSpec, TStatus> {
      // Register in global registry by KIND when factory defines evaluator
      ReadinessEvaluatorRegistry.getInstance().registerForKind(
        this.kind,
        evaluator,
        'factory-defined'
      );

      // Still attach to individual resource instance (existing behavior)
      Object.defineProperty(this, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false, // Prevents serialization - key requirement
        configurable: true, // Allow reconfiguration for withReadinessEvaluator
        writable: false, // Cannot be overwritten directly
      });

      return this as Enhanced<TSpec, TStatus>;
    },
    enumerable: false, // Prevents withReadinessEvaluator from being serialized
    configurable: false, // Cannot be modified
    writable: false, // Cannot be overwritten
  });

  // Add conditional expression support
  const enhancedWithConditionals = conditionalExpressionIntegrator.addConditionalSupport(enhanced, {
    autoProcess: false, // Don't auto-process until we know the factory type
    validateExpressions: true,
  });

  return enhancedWithConditionals as Enhanced<TSpec, TStatus>;
}

export function processPodSpec(podSpec?: V1PodSpec): V1PodSpec | undefined {
  if (!podSpec?.containers) return podSpec;
  podSpec.containers = podSpec.containers.map((container) => {
    if (!container.env) return container;
    const processedEnv: V1EnvVar[] = container.env.map((envVar) => {
      if (isKubernetesRef(envVar.value)) {
        return { name: envVar.name, value: envVar.value as any };
      }
      // Check if it's a CelExpression - preserve it as-is
      if (isCelExpression(envVar.value)) {
        return { name: envVar.name, value: envVar.value as any };
      }
      if (envVar.value !== undefined) {
        return { name: envVar.name, value: String(envVar.value) };
      }
      return envVar;
    });
    return { ...container, env: processedEnv };
  });
  return podSpec;
}
