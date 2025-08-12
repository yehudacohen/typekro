/**
 * Shared utilities for factory functions
 *
 * This module contains common utilities and helper functions that are used
 * across all factory modules for creating Kubernetes resources.
 */

import type { V1EnvVar, V1PodSpec } from '@kubernetes/client-node';
import { getComponentLogger } from '../core/logging/index.js';
import { KUBERNETES_REF_BRAND } from '../core/constants/brands.js';
import { isCelExpression } from '../utils/type-guards.js';
import type { Enhanced, EnhancedBuilder, KubernetesResource, MagicProxy, ReadinessEvaluator } from '../core/types.js';
import { generateDeterministicResourceId, isKubernetesRef } from '../utils/index.js';
import { validateResourceId } from '../core/validation/cel-validator.js';

// Check for the debug environment variable
const IS_DEBUG_MODE = process.env.TYPEKRO_DEBUG === 'true';

// Logger for debug mode
const debugLogger = getComponentLogger('factory-proxy');

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
      if (prop in target) return target[prop as keyof typeof target];
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
            if (key !== '__resourceId' && key !== 'withReadinessEvaluator' && key !== 'readinessEvaluator') {
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
                writable: true
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

export function createResource<TSpec extends object, TStatus extends object>(
  resource: KubernetesResource<TSpec, TStatus>
): EnhancedBuilder<TSpec, TStatus> {
  let resourceId: string;

  // Check for id field on the resource itself
  if ((resource as any).id) {
    resourceId = (resource as any).id;

    // Validate that the ID follows camelCase convention
    const validation = validateResourceId(resourceId);
    if (!validation.isValid) {
      throw new Error(`Invalid resource ID: ${validation.error}`);
    }
  } else {
    // Use deterministic ID generation by default
    const name = resource.metadata?.name || resource.kind.toLowerCase();
    const namespace = resource.metadata?.namespace;
    resourceId = generateDeterministicResourceId(resource.kind, name, namespace);
  }

  const enhanced = createGenericProxyResource(resourceId, resource);

  // Add fluent builder method for readiness evaluator with serialization protection
  Object.defineProperty(enhanced, 'withReadinessEvaluator', {
    value: function (evaluator: ReadinessEvaluator): Enhanced<TSpec, TStatus> {
      // Use Object.defineProperty with enumerable: false to prevent serialization
      Object.defineProperty(this, 'readinessEvaluator', {
        value: evaluator,
        enumerable: false,    // Prevents serialization - key requirement
        configurable: false,  // Cannot be modified after creation
        writable: false       // Cannot be overwritten
      });

      return this as Enhanced<TSpec, TStatus>;
    },
    enumerable: false,    // Prevents withReadinessEvaluator from being serialized
    configurable: false,  // Cannot be modified
    writable: false       // Cannot be overwritten
  });

  return enhanced as EnhancedBuilder<TSpec, TStatus>;
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
