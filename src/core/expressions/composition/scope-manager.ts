/**
 * Magic Proxy Scope Manager for Composition Contexts
 *
 * Manages nested composition scopes and validates KubernetesRef accessibility
 * within scope hierarchies.
 */

import type { KubernetesRef } from '../../types/common.js';
import type { SchemaProxy } from '../../types/serialization.js';

/**
 * Nested composition scope information
 */
export interface NestedCompositionScope {
  contextId: string;
  resourceIds: Set<string>;
  schemaProxy?: SchemaProxy<any, any> | undefined;
  parentScope?: NestedCompositionScope | undefined;
  childScopes: NestedCompositionScope[];
  depth: number;
  mergedResourceIds?: string[] | undefined;
}

/**
 * Magic proxy scoping manager for composition contexts with nested composition support
 */
export class MagicProxyScopeManager {
  private scopeStack: NestedCompositionScope[] = [];
  private scopeRegistry = new Map<string, NestedCompositionScope>();

  /**
   * Enter a new composition scope
   */
  enterScope(contextId: string, schemaProxy?: SchemaProxy<any, any>): void {
    const parentScope = this.getCurrentScope();
    const depth = parentScope ? parentScope.depth + 1 : 0;

    const newScope: NestedCompositionScope = {
      contextId,
      resourceIds: new Set(),
      schemaProxy,
      parentScope,
      childScopes: [],
      depth,
    };

    // Link to parent scope
    if (parentScope) {
      parentScope.childScopes.push(newScope);
    }

    this.scopeStack.push(newScope);
    this.scopeRegistry.set(contextId, newScope);
  }

  /**
   * Exit the current composition scope
   */
  exitScope(): void {
    const exitingScope = this.scopeStack.pop();
    if (exitingScope) {
      this.scopeRegistry.delete(exitingScope.contextId);
    }
  }

  /**
   * Register a resource in the current scope
   */
  registerResource(resourceId: string): void {
    const currentScope = this.getCurrentScope();
    if (currentScope) {
      currentScope.resourceIds.add(resourceId);
    }
  }

  /**
   * Register merged resources from a nested composition
   */
  registerMergedResources(contextId: string, mergedResourceIds: string[]): void {
    const scope = this.scopeRegistry.get(contextId);
    if (scope) {
      scope.mergedResourceIds = mergedResourceIds;

      // Also register these resources in the current scope for accessibility
      const currentScope = this.getCurrentScope();
      if (currentScope && currentScope !== scope) {
        mergedResourceIds.forEach((id) => currentScope.resourceIds.add(id));
      }
    }
  }

  /**
   * Get the current scope
   */
  getCurrentScope(): NestedCompositionScope | undefined {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  /**
   * Get a scope by context ID
   */
  getScope(contextId: string): NestedCompositionScope | undefined {
    return this.scopeRegistry.get(contextId);
  }

  /**
   * Check if a resource is accessible in the current scope (including parent scopes)
   */
  isResourceAccessible(resourceId: string): boolean {
    const currentScope = this.getCurrentScope();
    if (!currentScope) {
      return false;
    }

    // Check current scope and all parent scopes
    let scope: NestedCompositionScope | undefined = currentScope;
    while (scope) {
      if (scope.resourceIds.has(resourceId)) {
        return true;
      }

      // Check merged resources from nested compositions
      if (scope.mergedResourceIds?.includes(resourceId)) {
        return true;
      }

      scope = scope.parentScope;
    }

    return false;
  }

  /**
   * Check if a resource is in the current scope only
   */
  isResourceInCurrentScope(resourceId: string): boolean {
    const currentScope = this.getCurrentScope();
    return currentScope ? currentScope.resourceIds.has(resourceId) : false;
  }

  /**
   * Get all accessible resources (current scope + parent scopes)
   */
  getAccessibleResources(): string[] {
    const currentScope = this.getCurrentScope();
    if (!currentScope) {
      return [];
    }

    const accessibleResources = new Set<string>();

    // Collect resources from current scope and all parent scopes
    let scope: NestedCompositionScope | undefined = currentScope;
    while (scope) {
      scope.resourceIds.forEach((id) => accessibleResources.add(id));

      // Add merged resources from nested compositions
      if (scope.mergedResourceIds) {
        scope.mergedResourceIds.forEach((id) => accessibleResources.add(id));
      }

      scope = scope.parentScope;
    }

    return Array.from(accessibleResources);
  }

  /**
   * Get resources in the current scope only
   */
  getCurrentScopeResources(): string[] {
    const currentScope = this.getCurrentScope();
    return currentScope ? Array.from(currentScope.resourceIds) : [];
  }

  /**
   * Get the scope hierarchy as a string for debugging
   */
  getScopeHierarchy(): string {
    const currentScope = this.getCurrentScope();
    if (!currentScope) {
      return 'No active scope';
    }

    const hierarchy: string[] = [];
    let scope: NestedCompositionScope | undefined = currentScope;

    while (scope) {
      hierarchy.unshift(
        `${scope.contextId} (depth: ${scope.depth}, resources: ${scope.resourceIds.size})`
      );
      scope = scope.parentScope;
    }

    return hierarchy.join(' -> ');
  }

  /**
   * Validate KubernetesRef scope with nested composition support
   */
  validateKubernetesRefScope(kubernetesRef: KubernetesRef<unknown>): {
    isValid: boolean;
    error?: string;
    scopeInfo?: {
      foundInScope: string;
      scopeDepth: number;
    };
  } {
    const currentScope = this.getCurrentScope();

    if (!currentScope) {
      return { isValid: false, error: 'No active composition scope' };
    }

    // Schema references are always valid
    if (kubernetesRef.resourceId === '__schema__') {
      return { isValid: true };
    }

    // Check accessibility in nested scope hierarchy
    let scope: NestedCompositionScope | undefined = currentScope;
    while (scope) {
      if (scope.resourceIds.has(kubernetesRef.resourceId)) {
        return {
          isValid: true,
          scopeInfo: {
            foundInScope: scope.contextId,
            scopeDepth: scope.depth,
          },
        };
      }

      // Check merged resources from nested compositions
      if (scope.mergedResourceIds?.includes(kubernetesRef.resourceId)) {
        return {
          isValid: true,
          scopeInfo: {
            foundInScope: scope.contextId,
            scopeDepth: scope.depth,
          },
        };
      }

      scope = scope.parentScope;
    }

    return {
      isValid: false,
      error: `Resource '${kubernetesRef.resourceId}' is not accessible in the current composition scope hierarchy`,
    };
  }

  /**
   * Get nested composition statistics
   */
  getNestedCompositionStats(): {
    totalScopes: number;
    maxDepth: number;
    currentDepth: number;
    totalResources: number;
    resourcesByScope: Record<string, number>;
  } {
    const currentScope = this.getCurrentScope();
    const stats = {
      totalScopes: this.scopeRegistry.size,
      maxDepth: 0,
      currentDepth: currentScope?.depth || 0,
      totalResources: 0,
      resourcesByScope: {} as Record<string, number>,
    };

    for (const [contextId, scope] of this.scopeRegistry) {
      stats.maxDepth = Math.max(stats.maxDepth, scope.depth);
      stats.totalResources += scope.resourceIds.size;
      stats.resourcesByScope[contextId] = scope.resourceIds.size;

      if (scope.mergedResourceIds) {
        stats.totalResources += scope.mergedResourceIds.length;
      }
    }

    return stats;
  }
}
