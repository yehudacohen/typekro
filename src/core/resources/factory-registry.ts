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
const semanticAliasIndex = new Map<string, string[]>(); // alias → candidate kind[]

// ---------- Public API ----------

/**
 * Register a factory's metadata. Call this at module scope in your factory
 * file so the registry is populated when the factory is imported.
 *
 * Safe to call multiple times with the same factoryName — subsequent calls
 * overwrite silently (e.g. when a file is re-imported in tests).
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

  // Remove old entry if re-registering (e.g. in tests)
  const old = factoriesByName.get(factoryName);
  if (old) {
    removeFromKindIndex(old);
    removeFromSemanticIndex(old);
  }

  factoriesByName.set(factoryName, registration);

  // Kind index
  const kindEntries = factoriesByKind.get(kind.toLowerCase()) ?? [];
  kindEntries.push(registration);
  factoriesByKind.set(kind.toLowerCase(), kindEntries);

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
  semanticAliasIndex.clear();
}

// ---------- Internal helpers ----------

function removeFromKindIndex(reg: FactoryRegistration): void {
  const kindKey = reg.kind.toLowerCase();
  const entries = factoriesByKind.get(kindKey);
  if (entries) {
    const idx = entries.indexOf(reg);
    if (idx >= 0) entries.splice(idx, 1);
    if (entries.length === 0) factoriesByKind.delete(kindKey);
  }
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
