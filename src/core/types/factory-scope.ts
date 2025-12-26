/**
 * Factory Scope Types
 *
 * This module contains types for factory-driven scope resolution.
 * Factories declare their scope capabilities, and resources embed
 * resolved scope information for use throughout the deployment pipeline.
 */

import type { Enhanced } from './kubernetes.js';

/**
 * Factory scope configuration - declared by each factory
 */
export interface FactoryScopeConfig {
  /** The scope capabilities of this factory */
  scope: 'cluster' | 'namespaced' | 'flexible';

  /** Default scope for flexible factories (required if scope is 'flexible') */
  defaultScope?: 'cluster' | 'namespaced';

  /** The Kubernetes resource kind this factory creates */
  kind: string;
}

/**
 * Resolved scope information embedded in resources
 */
export interface EmbeddedScope {
  /** The resolved scope for this specific resource instance */
  scope: 'cluster' | 'namespaced';

  /** The namespace (only present for namespaced resources, undefined for cluster-scoped) */
  namespace: string | undefined;

  /** The original factory scope configuration */
  factoryDeclaredScope: FactoryScopeConfig;
}

/**
 * Enhanced resource with embedded scope information
 */
export interface ScopeAwareResource extends Enhanced<any, any> {
  /** Embedded scope information (internal use) */
  __scope: EmbeddedScope;
}

/**
 * Type guard to check if a resource has embedded scope
 */
export function isScopeAware(resource: any): resource is ScopeAwareResource {
  return resource && typeof resource === 'object' && '__scope' in resource;
}
