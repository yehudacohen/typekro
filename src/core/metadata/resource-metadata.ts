/**
 * Resource Metadata Store
 *
 * Central WeakMap-based metadata store for resource objects. Replaces the
 * non-enumerable `Object.defineProperty` pattern that was prone to silent
 * data loss during spread, `JSON.parse(JSON.stringify())`, and `structuredClone`.
 *
 * WeakMap is invisible to serialization by design — no data can leak into
 * YAML, JSON, or `Object.keys()` output. Metadata is automatically garbage
 * collected when the resource object is no longer referenced.
 *
 * @module
 * @see ROADMAP.md Phase 2.6
 */

import type { ResourceAspectMetadata } from '../aspects/types.js';
import type { ResourceStatus } from '../types/kubernetes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All metadata fields that can be associated with a resource object.
 *
 * Each field corresponds to a previously non-enumerable property:
 * - `resourceId`         → was `__resourceId`
 * - `readinessEvaluator` → was `readinessEvaluator`
 * - `includeWhen`        → was `includeWhen`
 * - `readyWhen`          → was `readyWhen`
 * - `forEach`            → was `forEach`
 * - `templateOverrides`  → was `__templateOverrides`
 */
export interface ResourceMetadata {
  /** Original resource identifier for cross-resource references */
  resourceId?: string;
  /** Local resource IDs that should resolve to this emitted resource ID. */
  resourceAliases?: string[];
  /** Factory-provided function that evaluates whether a deployed resource is ready */
  readinessEvaluator?: (resource: unknown) => ResourceStatus;
  /** Conditional resource creation CEL expression array */
  includeWhen?: unknown[];
  /** Resource readiness conditions CEL expression array */
  readyWhen?: unknown[];
  /** Collection iteration dimensions for Kro forEach support */
  forEach?: Record<string, string>[];
  /** Ternary CEL expression overrides from AST analysis */
  templateOverrides?: Array<{ propertyPath: string; celExpression: string }>;
  /** Kubernetes scope — 'cluster' for cluster-scoped resources (Namespace, ClusterRole, etc.) */
  scope?: 'namespaced' | 'cluster';
  /**
   * Whether this resource creates a DNS-addressable service in the
   * cluster. When `true`, the dependency resolver will detect implicit
   * dependencies from other resources whose env vars or spec fields
   * reference this resource's `metadata.name` as a hostname.
   *
   * Set automatically by factory functions that create DNS names:
   * `service()`, `deployment()`, `statefulSet()`, and CRD factories
   * like `valkey()`, `cluster()`, `pooler()`.
   */
  dnsAddressable?: boolean;
  /**
   * Deprecated alias for `scopes`. `lifecycle: 'shared'` is equivalent to
   * `scopes: ['shared']`. New code should use `scopes` directly.
   */
  lifecycle?: 'managed' | 'shared';
  /**
   * Deletion scopes this resource belongs to. Used by `factory.deleteInstance`
   * to limit blast radius:
   *
   * - Empty / undefined → resource is "instance-private" and is deleted by
   *   default when its owning instance is torn down.
   * - Non-empty → resource also belongs to these broader lifecycles. On
   *   delete, it is *only* removed if the caller explicitly targets one of
   *   its scopes (via `deleteInstance(name, { scopes: [...] })`).
   *
   * Scope names are free-form strings; common conventions are `'cluster'`
   * for cluster-wide singletons (e.g., operators installed by a bootstrap),
   * `'team:<name>'` for team-shared infra, etc.
   *
   * Also serialized at deploy time into the `typekro.io/scopes` annotation
   * on the live cluster object so that cross-process deletion can recover
   * the scopes without access to the original composition.
   */
  scopes?: string[];
  /**
   * Explicit dependencies for KRO deployment ordering.
   * Each entry declares that this resource should wait for another
   * resource to be ready before KRO creates it. Emitted as template
   * annotations so KRO discovers the dependency edge while building
   * the resource DAG.
   */
  dependsOn?: Array<{ resourceId: string }>;
  /** Internal aspect matching metadata; never serialized. */
  aspects?: ResourceAspectMetadata;
}

/** Keys of ResourceMetadata that are valid metadata field names */
export type ResourceMetadataKey = keyof ResourceMetadata;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The single global WeakMap that holds all resource metadata.
 *
 * Using `WeakRef`-compatible keys means metadata is garbage-collected
 * when the resource object is no longer reachable.
 */
const store = new WeakMap<WeakKey, ResourceMetadata>();

// ---------------------------------------------------------------------------
// Core accessors
// ---------------------------------------------------------------------------

/**
 * Get the full metadata record for a resource, or `undefined` if none is set.
 */
export function getResourceMetadata(resource: WeakKey): ResourceMetadata | undefined {
  return store.get(resource);
}

/**
 * Get a single metadata field for a resource.
 */
export function getMetadataField<K extends ResourceMetadataKey>(
  resource: WeakKey,
  key: K
): ResourceMetadata[K] | undefined {
  return store.get(resource)?.[key];
}

/**
 * Set (merge) metadata fields on a resource. Creates the metadata record if
 * it doesn't exist yet; otherwise merges the new fields into the existing record.
 *
 * @returns The merged metadata record.
 */
export function setResourceMetadata(
  resource: WeakKey,
  metadata: Partial<ResourceMetadata>
): ResourceMetadata {
  const existing = store.get(resource) ?? {};
  const merged = { ...existing, ...metadata };
  store.set(resource, merged);
  return merged;
}

/**
 * Set a single metadata field on a resource.
 */
export function setMetadataField<K extends ResourceMetadataKey>(
  resource: WeakKey,
  key: K,
  value: ResourceMetadata[K]
): void {
  const existing = store.get(resource) ?? {};
  existing[key] = value;
  store.set(resource, existing);
}

/**
 * Legacy non-enumerable property names that may still exist on objects
 * during the migration period. These are checked and migrated to the
 * WeakMap store when encountered.
 */
const LEGACY_NONENUM_PROPS = [
  'readinessEvaluator',
  '__resourceId',
  'includeWhen',
  'readyWhen',
  'forEach',
  '__templateOverrides',
] as const;

/** Map legacy property names to their ResourceMetadata field names */
const LEGACY_TO_METADATA: Record<string, ResourceMetadataKey> = {
  readinessEvaluator: 'readinessEvaluator',
  __resourceId: 'resourceId',
  includeWhen: 'includeWhen',
  readyWhen: 'readyWhen',
  forEach: 'forEach',
  __templateOverrides: 'templateOverrides',
};

/**
 * Copy ALL metadata from one resource to another. This replaces the old
 * `preserveNonEnumerableProperties` helper for resource-to-resource copies
 * (e.g., after a `{...spread}` operation).
 *
 * Also migrates any legacy non-enumerable properties found on the source
 * into the WeakMap store on the target.
 *
 * @returns `true` if metadata was copied, `false` if source had no metadata
 *          and no legacy properties were found.
 */
export function copyResourceMetadata(source: WeakKey, target: WeakKey): boolean {
  let copied = false;

  // Copy existing WeakMap metadata
  const metadata = store.get(source);
  if (metadata) {
    store.set(target, { ...metadata });
    copied = true;
  }

  // Also migrate legacy non-enumerable properties from source to target's WeakMap
  if (typeof source === 'object' && source !== null) {
    for (const prop of LEGACY_NONENUM_PROPS) {
      const desc = Object.getOwnPropertyDescriptor(source, prop);
      if (desc && desc.value !== undefined) {
        // Validate type before storing: readinessEvaluator must be a function
        if (prop === 'readinessEvaluator' && typeof desc.value !== 'function') continue;

        const metaKey = LEGACY_TO_METADATA[prop];
        if (metaKey) {
          setMetadataField(target, metaKey, desc.value);
          copied = true;
        }
      }
    }
  }

  return copied;
}

/**
 * Check if a resource has any metadata at all.
 */
export function hasResourceMetadata(resource: WeakKey): boolean {
  return store.has(resource);
}

/**
 * Delete all metadata for a resource. Rarely needed since WeakMap handles
 * garbage collection automatically, but useful in tests.
 */
export function clearResourceMetadata(resource: WeakKey): boolean {
  return store.delete(resource);
}

// ---------------------------------------------------------------------------
// Convenience: resourceId
// ---------------------------------------------------------------------------

/** Get the resource ID (previously `__resourceId`). */
export function getResourceId(resource: WeakKey): string | undefined {
  // Check WeakMap store first
  const fromStore = store.get(resource)?.resourceId;
  if (fromStore) return fromStore;

  // Fallback: check for legacy `__resourceId` property on the object itself.
  // This handles plain objects that haven't been migrated to WeakMap metadata,
  // or objects created externally with `__resourceId` set as a property.
  // IMPORTANT: Use Object.getOwnPropertyDescriptor to avoid triggering proxy get traps,
  // which would cause infinite recursion when called from within a proxy get handler.
  if (typeof resource === 'object' && resource !== null) {
    const desc = Object.getOwnPropertyDescriptor(resource, '__resourceId');
    if (desc && typeof desc.value === 'string') return desc.value;
  }

  return undefined;
}

/** Set the resource ID (previously `__resourceId`). */
export function setResourceId(resource: WeakKey, id: string): void {
  setMetadataField(resource, 'resourceId', id);
}

// ---------------------------------------------------------------------------
// Convenience: readinessEvaluator
// ---------------------------------------------------------------------------

/** Get the readiness evaluator function. */
export function getReadinessEvaluator(
  resource: WeakKey
): ((resource: unknown) => ResourceStatus) | undefined {
  // Check WeakMap store first
  const fromStore = store.get(resource)?.readinessEvaluator;
  if (fromStore) return fromStore;

  // Fallback: check for legacy `readinessEvaluator` property on the object itself.
  // This handles plain objects with readinessEvaluator set via Object.defineProperty
  // that haven't been migrated to WeakMap metadata.
  // IMPORTANT: Use Object.getOwnPropertyDescriptor to avoid triggering proxy get traps,
  // which would cause infinite recursion when called from within a proxy get handler.
  if (typeof resource === 'object' && resource !== null) {
    const desc = Object.getOwnPropertyDescriptor(resource, 'readinessEvaluator');
    if (desc && typeof desc.value === 'function')
      return desc.value as (resource: unknown) => ResourceStatus;
  }

  return undefined;
}

/** Set the readiness evaluator function. */
export function setReadinessEvaluator(
  resource: WeakKey,
  evaluator: (resource: unknown) => ResourceStatus
): void {
  setMetadataField(resource, 'readinessEvaluator', evaluator);
}

// ---------------------------------------------------------------------------
// Convenience: conditional metadata
// ---------------------------------------------------------------------------

/** Get the includeWhen conditions. */
export function getIncludeWhen(resource: WeakKey): unknown[] | undefined {
  return store.get(resource)?.includeWhen;
}

/** Set (replace) the includeWhen conditions. */
export function setIncludeWhen(resource: WeakKey, conditions: unknown[]): void {
  setMetadataField(resource, 'includeWhen', conditions);
}

/** Get the readyWhen conditions. */
export function getReadyWhen(resource: WeakKey): unknown[] | undefined {
  return store.get(resource)?.readyWhen;
}

/** Set (replace) the readyWhen conditions. */
export function setReadyWhen(resource: WeakKey, conditions: unknown[]): void {
  setMetadataField(resource, 'readyWhen', conditions);
}

/** Get the forEach dimensions. */
export function getForEach(resource: WeakKey): Record<string, string>[] | undefined {
  return store.get(resource)?.forEach;
}

/** Set (replace) the forEach dimensions. */
export function setForEach(resource: WeakKey, dimensions: Record<string, string>[]): void {
  setMetadataField(resource, 'forEach', dimensions);
}

/** Get the template overrides. */
export function getTemplateOverrides(
  resource: WeakKey
): Array<{ propertyPath: string; celExpression: string }> | undefined {
  return store.get(resource)?.templateOverrides;
}

/** Set (replace) the template overrides. */
export function setTemplateOverrides(
  resource: WeakKey,
  overrides: Array<{ propertyPath: string; celExpression: string }>
): void {
  setMetadataField(resource, 'templateOverrides', overrides);
}
