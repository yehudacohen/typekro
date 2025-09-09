/**
 * Shared utilities for factory functions
 *
 * This module contains common utilities and helper functions that are used
 * across all factory modules for creating Kubernetes resources.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { V1EnvVar, V1PodSpec } from '@kubernetes/client-node';
import { KUBERNETES_REF_BRAND } from '../core/constants/brands.js';
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
import { 
  conditionalExpressionIntegrator,
} from '../core/expressions/conditional-integration.js';

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
  /** Add a resource to the context */
  addResource(id: string, resource: Enhanced<any, any>): void;
  /** Add a deployment closure to the context */
  addClosure(id: string, closure: any): void;
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
 * Create a new composition context with default implementations
 * @param name Optional name for the composition (used in ID generation)
 * @returns A new composition context
 */
export function createCompositionContext(name?: string): CompositionContext {
  return {
    resources: {},
    closures: {},
    resourceCounter: 0,
    closureCounter: 0,
    addResource(id: string, resource: Enhanced<any, any>) {
      this.resources[id] = resource;
    },
    addClosure(id: string, closure: any) {
      this.closures[id] = closure;
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
      
      // For unknown properties, create nested references
      return createRefFactory(resourceId, `${basePath}.${String(prop)}`);
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
    get: (obj, prop) => {
      // Handle toJSON specially to ensure proper serialization
      if (prop === 'toJSON') {
        return () => {
          const result: Record<string, any> = {};
          for (const key of Object.keys(obj)) {
            result[key] = (obj as any)[key];
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
        // Return the KubernetesRef for the underlying property.
        return createRefFactory(resourceId, `${basePath}.${actualProp}`);
      }

      // 3. For any other access, default to the "eager value" or "implicit ref for unknown" logic.
      // IMPORTANT: For JavaScript-to-CEL conversion to work, we need to check if we're in
      // a status builder context where ALL property access should return KubernetesRef objects
      const isStatusBuilderContext = (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__;
      
      if (isStatusBuilderContext && (basePath === 'status' || basePath === 'spec')) {
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
          // Create a plain object with all enumerable properties
          const result: Record<string, any> = {};
          const targetObj = target as Record<string, any>;
          for (const key of Object.keys(target)) {
            if (
              key !== '__resourceId' &&
              key !== 'withReadinessEvaluator' &&
              key !== 'readinessEvaluator'
            ) {
              result[key] = targetObj[key];
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
        const data = (target as any).data ?? {};
        return createPropertyProxy(resourceId, 'data', data);
      }
      if (prop === 'stringData' && 'stringData' in target) {
        const stringData = (target as any).stringData ?? {};
        return createPropertyProxy(resourceId, 'stringData', stringData);
      }
      if (prop === 'rules' && 'rules' in target) {
        const rules = (target as any).rules ?? [];
        return createPropertyProxy(resourceId, 'rules', rules);
      }
      if (prop === 'roleRef' && 'roleRef' in target) {
        const roleRef = (target as any).roleRef ?? {};
        return createPropertyProxy(resourceId, 'roleRef', roleRef);
      }
      if (prop === 'subjects' && 'subjects' in target) {
        const subjects = (target as any).subjects ?? [];
        return createPropertyProxy(resourceId, 'subjects', subjects);
      }
      if (prop === 'provisioner' && 'provisioner' in target) {
        const provisioner = (target as any).provisioner;
        if (provisioner !== undefined) {
          return provisioner; // Return the actual string value
        }
        return createRefFactory(resourceId, 'provisioner'); // Create reference if not set
      }
      if (prop === 'parameters' && 'parameters' in target) {
        const parameters = (target as any).parameters ?? {};
        return createPropertyProxy(resourceId, 'parameters', parameters);
      }
      if (prop === 'subsets' && 'subsets' in target) {
        const subsets = (target as any).subsets ?? [];
        return createPropertyProxy(resourceId, 'subsets', subsets);
      }
      if (typeof prop === 'string' && prop.startsWith('$')) {
        return createRefFactory(resourceId, prop.substring(1));
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
 * Default readiness evaluator for resources that don't have custom logic
 */
function createDefaultReadinessEvaluator(kind: string): ReadinessEvaluator {
  return (liveResource: any) => {
    try {
      // For resources that are immediately ready when they exist
      const immediatelyReadyKinds = [
        'ConfigMap',
        'Secret',
        'Role',
        'ClusterRole',
        'RoleBinding',
        'ClusterRoleBinding',
        'ServiceAccount',
        'StorageClass',
        'NetworkPolicy',
        'LimitRange',
        'CSIDriver',
        'CSINode',
        'IngressClass',
        'RuntimeClass',
        'Lease',
        'ComponentStatus',
      ];

      if (immediatelyReadyKinds.includes(kind)) {
        return {
          ready: true,
          message: `${kind} is ready when it exists`,
        };
      }

      // For resources with status conditions, check for common readiness patterns
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: `${kind} status not available yet`,
        };
      }

      // Check for common readiness conditions
      if (status.conditions && Array.isArray(status.conditions)) {
        const readyCondition = status.conditions.find((c: any) => c.type === 'Ready');
        if (readyCondition) {
          return {
            ready: readyCondition.status === 'True',
            reason: readyCondition.reason,
            message: readyCondition.message || `${kind} readiness: ${readyCondition.status}`,
          };
        }

        const availableCondition = status.conditions.find((c: any) => c.type === 'Available');
        if (availableCondition) {
          return {
            ready: availableCondition.status === 'True',
            reason: availableCondition.reason,
            message:
              availableCondition.message || `${kind} availability: ${availableCondition.status}`,
          };
        }
      }

      // For resources with phase, check if it's active/bound/running
      if (status.phase) {
        const readyPhases = ['Active', 'Bound', 'Running', 'Succeeded'];
        const ready = readyPhases.includes(status.phase);
        return {
          ready,
          reason: ready ? 'PhaseReady' : 'PhaseNotReady',
          message: `${kind} phase: ${status.phase}`,
        };
      }

      // Default: assume ready if status exists
      return {
        ready: true,
        message: `${kind} has status, assuming ready`,
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating ${kind} readiness: ${error}`,
      };
    }
  };
}

export function createResource<TSpec extends object, TStatus extends object>(
  resource: KubernetesResource<TSpec, TStatus>
): Enhanced<TSpec, TStatus> {
  let resourceId: string;

  // Check for id field on the resource itself
  if ((resource as any).id) {
    resourceId = (resource as any).id;

    // Validate that the ID follows camelCase convention
    const validation = validateResourceId(resourceId);
    if (!validation.isValid) {
      throw new Error(`Invalid resource ID: ${validation.error}`);
    }

    // Remove the id field from the resource to prevent it from being sent to Kubernetes
    const { id: _id, ...cleanResource } = resource as any;
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
  if (context && !(resource as any).__externalRef) {
    context.addResource(resourceId, enhanced);
  }

  // Always provide a readiness evaluator for factory-created resources
  const defaultEvaluator = createDefaultReadinessEvaluator(resource.kind);
  Object.defineProperty(enhanced, 'readinessEvaluator', {
    value: defaultEvaluator,
    enumerable: false, // Prevents serialization - key requirement
    configurable: true, // Allow withReadinessEvaluator to override
    writable: false, // Cannot be overwritten directly
  });

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
    validateExpressions: true
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
