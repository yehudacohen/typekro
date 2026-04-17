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
import {
  getMetadataField,
  getResourceId as getMetadataResourceId,
  getReadinessEvaluator,
  setMetadataField,
  setReadinessEvaluator,
  setResourceId,
} from '../metadata/index.js';
import { ReadinessEvaluatorRegistry } from '../readiness/index.js';
import { isKnownFactory, registerFactory } from '../resources/factory-registry.js';
import { generateDeterministicResourceId } from '../resources/id.js';
import type { Enhanced, KubernetesResource, MagicProxy, ReadinessEvaluator } from '../types.js';
import { validateResourceId } from '../validation/cel-validator.js';
import { detectStatusFieldTypo } from './known-status-fields.js';

// Check for the debug environment variable
const IS_DEBUG_MODE = isDebugMode();

// Track which kinds have been auto-registered to avoid redundant registry lookups.
const autoRegisteredKinds = new Set<string>();

// ---------------------------------------------------------------------------
// Data-driven proxy root-field configuration (Phase 3.4)
// ---------------------------------------------------------------------------
// Each entry describes how a root-level Kubernetes resource field should be
// handled by the Enhanced proxy's `get` trap.  Adding support for a new
// root-level field is a single entry here instead of a new if-branch.
//
// `proxyMode`:
//   - 'property'     — wrap value (defaulting to `defaultValue`) with
//                       `createPropertyProxy` so nested field accesses produce
//                       KubernetesRef chains.
//   - 'value-or-ref' — return the raw value if defined; otherwise return a
//                       KubernetesRef via `createRefFactory`.  Used for scalar
//                       fields that may be references in composition context.
// ---------------------------------------------------------------------------

interface ProxyFieldConfig {
  readonly proxyMode: 'property' | 'value-or-ref';
  /** Fallback when the target field is nullish.  Ignored for 'value-or-ref'. */
  readonly defaultValue?: unknown;
}

const PROXY_ROOT_FIELDS = new Map<string, ProxyFieldConfig>([
  ['data', { proxyMode: 'property', defaultValue: {} }],
  ['stringData', { proxyMode: 'property', defaultValue: {} }],
  ['rules', { proxyMode: 'property', defaultValue: [] }],
  ['roleRef', { proxyMode: 'property', defaultValue: {} }],
  ['subjects', { proxyMode: 'property', defaultValue: [] }],
  ['provisioner', { proxyMode: 'value-or-ref' }],
  ['parameters', { proxyMode: 'property', defaultValue: {} }],
  ['subsets', { proxyMode: 'property', defaultValue: [] }],
]);

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

  // Marker string for serialization and dependency detection.
  // Same format as schema-proxy.ts: __KUBERNETES_REF_{resourceId}_{fieldPath}__
  const markerString = `__KUBERNETES_REF_${resourceId}_${basePath}__`;

  return new Proxy(proxyTarget, {
    get(target, prop) {
      // Check for our defined properties first
      if (prop === KUBERNETES_REF_BRAND || prop === 'resourceId' || prop === 'fieldPath') {
        return target[prop as keyof typeof target];
      }

      // Handle type-coercion hooks. Matches schema-proxy.ts pattern.
      //
      // Symbol.toPrimitive receives a hint: "string" for template literals,
      // "number" for arithmetic/comparison, "default" for == and +.
      // For string coercion: return the marker string so template literals
      //   produce detectable `__KUBERNETES_REF_...__` markers.
      // For numeric coercion: return NaN so comparisons like `ref >= 1`
      //   produce `false` (not `true`). This ensures the status analysis
      //   pipeline's Phase B (fn.toString AST parsing) activates to generate
      //   proper CEL expressions from the JavaScript source code.
      if (prop === 'toString') {
        return () => markerString;
      }
      if (prop === 'valueOf') {
        return () => markerString;
      }
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => hint === 'string' ? markerString : NaN;
      }

      // toMarkerString() — explicit access to the marker string
      if (prop === 'toMarkerString') {
        return () => markerString;
      }

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

      // Only create nested refs for string properties
      if (typeof prop === 'string') {
        // $ prefix — Kro optional access (.?field)
        if (prop.startsWith('$')) {
          const actualField = prop.substring(1);
          return createRefFactory(resourceId, `${basePath}.?${actualField}`);
        }

        // For unknown string properties, create nested references
        return createRefFactory(resourceId, `${basePath}.${prop}`);
      }

      // Other symbols — return from target if present, otherwise undefined
      return target[prop as keyof typeof target];
    },
    // Proxy-based KubernetesRef factory: returns a dynamically-typed proxy
  }) as unknown;
}

function createPropertyProxy<T extends object>(
  resourceId: string,
  basePath: string,
  target: T,
  kind?: string
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
      // In status builder context, return KubernetesRef for CEL generation — UNLESS
      // we have live status data available (post-deployment re-execution), in which
      // case we fall through to return real values for status comparisons.
      if (isInStatusBuilderContext() && (basePath === 'status' || basePath === 'spec')) {
        // In SBC with live status data, fall through to return real values for
        // status comparisons (e.g., `readyInstances >= 1`).
        const hasLiveStatus = basePath === 'status' && getCurrentCompositionContext()?.liveStatusMap;
        if (!hasLiveStatus) {
          return createRefFactory(resourceId, `${basePath}.${String(prop)}`);
        }
      }

      if (prop in obj) {
        return obj[prop as keyof T];
      } else {
        // Check if there's live status data available from post-deployment re-execution.
        // This allows status comparisons (e.g., `readyInstances >= 1`) to evaluate
        // correctly against real cluster data instead of returning KubernetesRef proxies.
        if (basePath === 'status') {
          const ctx = getCurrentCompositionContext();
          if (ctx?.liveStatusMap) {
            const liveStatus = ctx.liveStatusMap.get(resourceId);
            if (liveStatus && Object.hasOwn(liveStatus, prop as string)) {
              return liveStatus[prop];
            }
          }
        }

        // Runtime typo detection for status field access (Phase 2.12).
        // Only fires in debug mode, for known K8s kinds, when accessing status fields.
        if (IS_DEBUG_MODE && basePath === 'status' && kind) {
          const suggestion = detectStatusFieldTypo(kind, prop);
          if (suggestion) {
            debugLogger.warn(
              `Possible typo: '${prop}' accessed on ${kind} status but not found in known fields. Did you mean '${suggestion}'?`,
              { resourceId, kind, accessedField: prop, suggestedField: suggestion }
            );
          }
        }
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
  setResourceId(resource, resourceId);

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
              result[key] = deepCloneValue(Reflect.get(target, key));
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
          statusProxy = createPropertyProxy(resourceId, 'status', status, target.kind);
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
      // Serve metadata from WeakMap store (backward compatibility for .readinessEvaluator / .__resourceId)
      // Check both proxy (receiver) and target since metadata may be set on either
      if (prop === 'readinessEvaluator') {
        return getReadinessEvaluator(receiver) ?? getReadinessEvaluator(target);
      }
      if (prop === '__resourceId') {
        return getMetadataResourceId(receiver) ?? getMetadataResourceId(target);
      }
      // Handle common Kubernetes resource fields as magic proxies (data-driven).
      // See PROXY_ROOT_FIELDS above for the full registry.
      if (typeof prop === 'string') {
        const fieldConfig = PROXY_ROOT_FIELDS.get(prop);
        if (fieldConfig && prop in target) {
          if (fieldConfig.proxyMode === 'property') {
            const value = Reflect.get(target, prop) ?? fieldConfig.defaultValue;
            // All property-mode fields are objects (Record/Array), safe to cast
            return createPropertyProxy(resourceId, prop, value as Record<string, unknown>);
          }
          // 'value-or-ref': return raw value when defined, otherwise a reference
          const value = Reflect.get(target, prop);
          if (value !== undefined) {
            return value;
          }
          return createRefFactory(resourceId, prop);
        }
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
  /**
   * Whether this resource creates a DNS-addressable service in the
   * cluster (e.g., a Service, StatefulSet headless service, or a CRD
   * that creates Services during reconciliation). When `true`, the
   * dependency resolver detects implicit dependencies from other
   * resources whose env vars reference this resource's `metadata.name`
   * as a hostname.
   *
   * **Currently set by:** `service()`, `cluster()` (CNPG), `pooler()`,
   * `valkey()`. **Not set by:** `deployment()`, `statefulSet()` (these
   * don't create DNS names — only the Service fronting them does).
   * New factory functions that create DNS-addressable resources must
   * set this flag or implicit dependency detection will miss them.
   */
  dnsAddressable?: boolean;
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

  // Auto-register the factory in the central FactoryRegistry the first time
  // we see a given kind, but ONLY if the factory doesn't already have an
  // explicit registration (which may include semantic aliases that we must
  // not overwrite).
  if (!autoRegisteredKinds.has(resource.kind)) {
    autoRegisteredKinds.add(resource.kind);
    if (!isKnownFactory(resource.kind)) {
      registerFactory({
        factoryName: resource.kind,
        kind: resource.kind,
        apiVersion: resource.apiVersion,
      });
    }
  }

  const enhanced = createGenericProxyResource(resourceId, resource);

  // Also store metadata for the PROXY itself (not just the target).
  // This is critical because downstream code (e.g. getResourceId, getReadinessEvaluator)
  // receives the proxy but the WeakMap entry was set on the target at line 194.
  // Without this, WeakMap lookups on the proxy return undefined.
  setResourceId(enhanced, resourceId);

  // Store resource scope for readiness polling (cluster-scoped resources skip namespace)
  if (options?.scope) {
    setMetadataField(enhanced, 'scope', options.scope);
  }

  // Mark DNS-addressable resources so the dependency resolver can detect
  // implicit service-name dependencies from env vars and connection strings.
  if (options?.dnsAddressable) {
    setMetadataField(enhanced, 'dnsAddressable', true);
  }

  // Auto-register with composition context if active (but not for external references)
  const context = getCurrentCompositionContext();
  if (context && !resource.__externalRef) {
    context.addResource(resourceId, enhanced);
  }

  // Add fluent builder method for readiness evaluator
  Object.defineProperty(enhanced, 'withReadinessEvaluator', {
    // biome-ignore lint/suspicious/noExplicitAny: resources may register evaluators for diverse typed Kubernetes objects.
    value: function (evaluator: ReadinessEvaluator<any>): Enhanced<TSpec, TStatus> {
      // Register in global registry by KIND
      ReadinessEvaluatorRegistry.getInstance().registerForKind(
        this.kind,
        evaluator,
        'factory-defined'
      );

      // Attach to individual resource instance via WeakMap
      setReadinessEvaluator(this, evaluator);

      return this as Enhanced<TSpec, TStatus>;
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // Add dependsOn method for explicit KRO dependency ordering
  Object.defineProperty(enhanced, 'dependsOn', {
    value: function (
      dependency: unknown,
      condition?: string | { expression: string }
    ): Enhanced<TSpec, TStatus> {
      if (condition !== undefined) {
        throw new TypeKroError(
          'Conditional dependsOn() is not supported. TypeKro can only serialize unconditional dependency edges.',
          'UNSUPPORTED_DEPENDENCY_CONDITION',
          { dependencyType: typeof dependency }
        );
      }

      // Extract resource ID from the dependency
      let depId: string | undefined;
      if (
        typeof dependency === 'object' &&
        dependency !== null &&
        (dependency as { kind?: unknown }).kind === 'singleton-reference'
      ) {
        throw new TypeKroError(
          'Enhanced.dependsOn() does not accept singleton reference handles. ' +
            'Depend on a real resource or the owning singleton definition instead.',
          'INVALID_DEPENDENCY_TARGET',
          { dependencyType: 'singleton-reference' }
        );
      }
      // Enhanced resource — read ID from metadata
      depId = getMetadataResourceId(dependency as Record<string, unknown>);
      // NestedCompositionResource — read __compositionId.
      // NOTE: __compositionId is the execution name (e.g., "inngest-execution-3"),
      // NOT a KRO graph resource ID. When used as a dependsOn target, the
      // readyWhen CEL expression will reference this ID which may not match
      // any resource in the KRO graph. For nested compositions, use
      // nestedCompositionResource.dependsOn() instead — it resolves to the
      // actual leaf merged resource ID in the parent context.
      if (!depId && typeof dependency === 'object' && dependency !== null) {
        depId = (dependency as Record<string, unknown>).__compositionId as string | undefined;
        if (depId) {
          debugLogger.warn('dependsOn: resolved via __compositionId — this may not match a KRO graph resource. Prefer calling dependsOn on the nested composition resource directly.', {
            compositionId: depId,
          });
        }
      }
      if (!depId) {
        debugLogger.warn('dependsOn: could not resolve resource ID from dependency', {
          dependencyType: typeof dependency,
        });
        return this as Enhanced<TSpec, TStatus>;
      }

      // Accumulate dependencies
      const existing = getMetadataField(this, 'dependsOn') as
        | Array<{ resourceId: string }>
        | undefined;
      const deps = existing ?? [];
      deps.push({ resourceId: depId });
      setMetadataField(this, 'dependsOn', deps);

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
