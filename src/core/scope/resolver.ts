/**
 * Scope Resolution Logic
 *
 * This module provides functions for resolving resource scopes based on
 * factory declarations and deployment context.
 */

import type { FactoryScopeConfig, EmbeddedScope } from '../types/factory-scope.js';

/**
 * Resolve the scope for a resource based on factory config and deployment context
 */
export function resolveScope(factoryConfig: FactoryScopeConfig, namespace?: string): EmbeddedScope {
  let resolvedScope: 'cluster' | 'namespaced';

  switch (factoryConfig.scope) {
    case 'cluster':
      resolvedScope = 'cluster';
      break;
    case 'namespaced':
      resolvedScope = 'namespaced';
      break;
    case 'flexible':
      // For flexible factories, use namespace presence to determine scope
      resolvedScope = namespace ? 'namespaced' : 'cluster';
      break;
    default:
      throw new Error(`Invalid factory scope: ${factoryConfig.scope}`);
  }

  return {
    scope: resolvedScope,
    namespace: resolvedScope === 'namespaced' ? namespace : undefined,
    factoryDeclaredScope: factoryConfig,
  };
}

/**
 * Create a connection key for event monitoring based on embedded scope
 */
export function createConnectionKey(embeddedScope: EmbeddedScope): string {
  const { scope, namespace, factoryDeclaredScope } = embeddedScope;

  if (scope === 'cluster') {
    return `${factoryDeclaredScope.kind}`;
  } else {
    // namespaced - always include namespace
    return `${factoryDeclaredScope.kind}/${namespace}`;
  }
}
