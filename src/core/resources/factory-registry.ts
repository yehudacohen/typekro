/**
 * Factory Registry
 *
 * A bare registry where resource factories self-register their metadata at
 * import time. This replaces three hardcoded allowlists:
 *
 * 1. `KNOWN_FACTORY_NAMES` (composition-analyzer.ts)
 *    → `isKnownFactory(name)`
 *
 * 2. `FACTORY_KIND_MAP` (serialization/core.ts)
 *    → `getKindInfo(name)`
 *
 * 3. `semanticPatterns` (serialization/core.ts findResourceByKey)
 *    → `getSemanticCandidateKinds(alias)`
 *
 * This module contains NO built-in entries. Each factory file registers itself
 * by calling `registerFactory()` at module scope. Custom factories become
 * first-class citizens the same way — no core files need editing.
 */

import type { KubernetesResource } from '../types/kubernetes.js';
import { TypeKroError } from '../errors.js';

/** Pure desired-state canonicalizer owned by a resource factory. */
export interface DesiredResourceCanonicalizer {
  /** Stable canonicalizer identity included in semantic-plan provenance. */
  readonly id: string;
  /** Stable canonicalizer revision included in semantic digests. */
  readonly revision: string;
  /**
   * Deterministic, cluster-independent desired-state normalization.
   *
   * This function receives no Kubernetes client or environment context by
   * design. Planning executes it twice in strict mode to detect ambient
   * nondeterminism.
   */
  readonly canonicalize: (resource: KubernetesResource) => KubernetesResource;
}

/** Which side of a desired/live comparison is being canonicalized. */
export type ResourceComparisonSide = 'desired' | 'live';

/** Factory-owned normalization used only while comparing desired and live resources. */
export interface LiveResourceCanonicalizer {
  /** Stable identity included in comparison evidence and diagnostics. */
  readonly id: string;
  /** Stable revision used to distinguish comparison behavior changes. */
  readonly revision: string;
  /**
   * Normalize an API-specific desired or live shape before comparison.
   *
   * Unlike desired canonicalization, this hook does not alter semantic plans or
   * artifact digests. It must still be deterministic and must not mutate its input.
   */
  readonly canonicalize: (
    resource: KubernetesResource,
    side: ResourceComparisonSide
  ) => KubernetesResource;
}

/**
 * Target-specific representation input declared by the factory that created a
 * resource. Planning lowers `inputs` into canonical PlanValue data before it
 * becomes part of a DesiredStatePlan.
 */
export interface FactoryRepresentationRequirement {
  readonly target: 'direct' | 'kro';
  readonly kind: string;
  readonly extension: string;
  readonly version: number;
  readonly inputs: unknown;
}

/** Pure producer for factory-owned representation requirements. */
export interface FactoryRepresentationRequirementProducer {
  readonly id: string;
  readonly revision: string;
  readonly produce: (resource: KubernetesResource) => readonly FactoryRepresentationRequirement[];
}

/** Metadata for a registered factory. */
export interface FactoryRegistration {
  /** The factory function name as it appears in source code (e.g. 'Deployment', 'helmRelease'). */
  readonly factoryName: string;

  /** The Kubernetes kind this factory creates (e.g. 'Deployment', 'HelmRelease'). */
  readonly kind: string;

  /** The Kubernetes apiVersion (e.g. 'apps/v1', 'v1'). */
  readonly apiVersion: string;

  /**
   * Semantic aliases for fuzzy resource key matching.
   * For example, `['database', 'db']` means a composition key named `database`
   * or `db` will match resources of this kind.
   */
  readonly semanticAliases?: readonly string[];

  /** Optional pure desired-state canonicalizer used before semantic digesting. */
  readonly desiredCanonicalizer?: DesiredResourceCanonicalizer;

  /** Optional deterministic API-specific canonicalizer used only for live comparison. */
  readonly liveCanonicalizer?: LiveResourceCanonicalizer;

  /** Optional pure target-representation declarations for resources from this factory. */
  readonly representationRequirements?: FactoryRepresentationRequirementProducer;
}

/**
 * Module-level singleton registry.
 *
 * We deliberately use a plain module-scoped Map rather than a class so that
 * the registry survives across imports without requiring a global/Symbol
 * lookup. There is exactly one registry per process.
 */
const factoriesByName = new Map<string, FactoryRegistration>();
const factoriesByKind = new Map<string, FactoryRegistration[]>();
const factoriesByGvk = new Map<string, FactoryRegistration[]>();
const semanticAliasIndex = new Map<string, string[]>(); // alias → candidate kind[]

function gvkKey(apiVersion: string, kind: string): string {
  return `${apiVersion.toLowerCase()}\u0000${kind.toLowerCase()}`;
}

// ---------- Public API ----------

/**
 * Register a factory's metadata. Call this at module scope in your factory
 * file so the registry is populated when the factory is imported.
 *
 * Safe to call multiple times with the same factoryName — ordinary metadata
 * overwrites silently (e.g. when a file is re-imported in tests), while a
 * registered canonicalizer may only be repeated with the same identity and
 * revision. Changing or removing canonical semantics fails loudly.
 *
 * @example
 * ```ts
 * // In your factory file:
 * import { registerFactory } from '../../core/resources/factory-registry.js';
 *
 * registerFactory({
 *   factoryName: 'Deployment',
 *   kind: 'Deployment',
 *   apiVersion: 'apps/v1',
 *   semanticAliases: ['deploy', 'database', 'db'],
 * });
 *
 * export function deployment(config: DeploymentConfig): Enhanced<...> { ... }
 * ```
 */
export function registerFactory(registration: FactoryRegistration): void {
  const { factoryName, kind } = registration;

  const old = factoriesByName.get(factoryName);
  assertCompatibleCanonicalizer(registration, 'desiredCanonicalizer');
  assertCompatibleCanonicalizer(registration, 'liveCanonicalizer');

  // Re-registration remains compatible for ordinary factory metadata. Exact
  // canonicalizer identity/revision registration is idempotent; conflicts for
  // one GVK fail above before any index is mutated.
  if (old) {
    removeFromKindIndex(old);
    removeFromGvkIndex(old);
    removeFromSemanticIndex(old);
  }

  factoriesByName.set(factoryName, registration);

  // Kind index
  const kindEntries = factoriesByKind.get(kind.toLowerCase()) ?? [];
  kindEntries.push(registration);
  factoriesByKind.set(kind.toLowerCase(), kindEntries);

  const key = gvkKey(registration.apiVersion, kind);
  const gvkEntries = factoriesByGvk.get(key) ?? [];
  gvkEntries.push(registration);
  factoriesByGvk.set(key, gvkEntries);

  // Semantic alias index
  if (registration.semanticAliases) {
    for (const alias of registration.semanticAliases) {
      const existing = semanticAliasIndex.get(alias.toLowerCase()) ?? [];
      if (!existing.includes(kind.toLowerCase())) {
        existing.push(kind.toLowerCase());
      }
      semanticAliasIndex.set(alias.toLowerCase(), existing);
    }
  }
}

/**
 * Bulk-register multiple factories at once.
 */
export function registerFactories(registrations: readonly FactoryRegistration[]): void {
  for (const reg of registrations) {
    registerFactory(reg);
  }
}

/**
 * Check whether `name` is a known factory function name.
 * Replaces `KNOWN_FACTORY_NAMES.has(name)`.
 */
export function isKnownFactory(name: string): boolean {
  return factoriesByName.has(name);
}

/**
 * Get the apiVersion + kind for a factory name.
 * Replaces `FACTORY_KIND_MAP[name]`.
 * Returns `undefined` if the factory is not registered.
 */
export function getKindInfo(factoryName: string): { apiVersion: string; kind: string } | undefined {
  const reg = factoriesByName.get(factoryName);
  if (!reg) return undefined;
  return { apiVersion: reg.apiVersion, kind: reg.kind };
}

/**
 * Get candidate Kubernetes kinds for a semantic alias
 * (e.g. 'database' → ['deployment', 'statefulset']).
 * Replaces the hardcoded `semanticPatterns` in `findResourceByKey`.
 * Returns lowercase kind strings, or `undefined` if no alias matches.
 */
export function getSemanticCandidateKinds(alias: string): string[] | undefined {
  const kinds = semanticAliasIndex.get(alias.toLowerCase());
  return kinds && kinds.length > 0 ? kinds : undefined;
}

/**
 * Get the full registration for a factory by name.
 */
export function getFactoryRegistration(factoryName: string): FactoryRegistration | undefined {
  return factoriesByName.get(factoryName);
}

/** Get all registrations that produce a Kubernetes kind. */
export function getFactoryRegistrationsForKind(kind: string): readonly FactoryRegistration[] {
  return [...(factoriesByKind.get(kind.toLowerCase()) ?? [])];
}

/** Get all registrations for an exact Kubernetes apiVersion/kind pair. */
export function getFactoryRegistrationsForGVK(
  apiVersion: string,
  kind: string
): readonly FactoryRegistration[] {
  return [...(factoriesByGvk.get(gvkKey(apiVersion, kind)) ?? [])];
}

/**
 * Get all registered factory names. Useful for diagnostics.
 */
export function getRegisteredFactoryNames(): string[] {
  return [...factoriesByName.keys()];
}

/**
 * Get the total number of registered factories.
 */
export function getRegisteredFactoryCount(): number {
  return factoriesByName.size;
}

/**
 * Clear the registry. Only used in tests.
 */
export function clearFactoryRegistry(): void {
  factoriesByName.clear();
  factoriesByKind.clear();
  factoriesByGvk.clear();
  semanticAliasIndex.clear();
}

// ---------- Internal helpers ----------

function assertCompatibleCanonicalizer(
  registration: FactoryRegistration,
  field: 'desiredCanonicalizer' | 'liveCanonicalizer'
): void {
  const incoming = registration[field];
  const previous = factoriesByName.get(registration.factoryName)?.[field];
  if (
    previous &&
    (!incoming || previous.id !== incoming.id || previous.revision !== incoming.revision)
  ) {
    throwCanonicalizerConflict(registration, field, registration.factoryName, previous, incoming);
  }
  if (!incoming) return;

  const conflicting = (
    factoriesByGvk.get(gvkKey(registration.apiVersion, registration.kind)) ?? []
  ).find((candidate) => {
    const existing = candidate[field];
    return (
      candidate.factoryName !== registration.factoryName &&
      existing !== undefined &&
      (existing.id !== incoming.id || existing.revision !== incoming.revision)
    );
  });
  const existing = conflicting?.[field];
  if (!conflicting || !existing) return;

  throwCanonicalizerConflict(registration, field, conflicting.factoryName, existing, incoming);
}

function throwCanonicalizerConflict(
  registration: FactoryRegistration,
  field: 'desiredCanonicalizer' | 'liveCanonicalizer',
  existingFactory: string,
  existing: DesiredResourceCanonicalizer | LiveResourceCanonicalizer,
  incoming: DesiredResourceCanonicalizer | LiveResourceCanonicalizer | undefined
): never {
  const stage = field === 'desiredCanonicalizer' ? 'desired' : 'live-comparison';
  throw new TypeKroError(
    `Conflicting ${stage} canonicalizers are registered for ${registration.apiVersion}/${registration.kind}: ` +
      `${existing.id}@${existing.revision} and ${incoming ? `${incoming.id}@${incoming.revision}` : 'none'}.`,
    field === 'desiredCanonicalizer'
      ? 'FACTORY_CANONICALIZER_CONFLICT'
      : 'FACTORY_LIVE_CANONICALIZER_CONFLICT',
    {
      apiVersion: registration.apiVersion,
      kind: registration.kind,
      existingFactory,
      incomingFactory: registration.factoryName,
      existingCanonicalizer: existing.id,
      incomingCanonicalizer: incoming?.id,
      stage,
    }
  );
}

function removeFromKindIndex(reg: FactoryRegistration): void {
  const kindKey = reg.kind.toLowerCase();
  const entries = factoriesByKind.get(kindKey);
  if (entries) {
    const idx = entries.indexOf(reg);
    if (idx >= 0) entries.splice(idx, 1);
    if (entries.length === 0) factoriesByKind.delete(kindKey);
  }
}

function removeFromGvkIndex(reg: FactoryRegistration): void {
  const key = gvkKey(reg.apiVersion, reg.kind);
  const entries = factoriesByGvk.get(key);
  if (!entries) return;
  const index = entries.indexOf(reg);
  if (index >= 0) entries.splice(index, 1);
  if (entries.length === 0) factoriesByGvk.delete(key);
}

function removeFromSemanticIndex(reg: FactoryRegistration): void {
  if (!reg.semanticAliases) return;
  for (const alias of reg.semanticAliases) {
    const aliasKey = alias.toLowerCase();
    const kinds = semanticAliasIndex.get(aliasKey);
    if (kinds) {
      const idx = kinds.indexOf(reg.kind.toLowerCase());
      if (idx >= 0) kinds.splice(idx, 1);
      if (kinds.length === 0) semanticAliasIndex.delete(aliasKey);
    }
  }
}
