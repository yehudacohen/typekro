/**
 * Composition Context Infrastructure
 *
 * This module owns the AsyncLocalStorage singletons that track the active
 * composition and status-builder contexts. It was extracted from
 * `src/factories/shared.ts` to fix an architectural inversion where
 * `src/core/` depended on `src/factories/` for foundational infrastructure.
 *
 * **Singleton guarantee:** The AsyncLocalStorage instances are module-scoped
 * constants. Every consumer (core and factories alike) must import from this
 * single canonical location to avoid accidental duplication.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeploymentClosure } from '../types/deployment.js';
import type { Enhanced } from '../types.js';

// =============================================================================
// COMPOSITION CONTEXT TYPES
// =============================================================================

/**
 * Context for imperative composition pattern.
 * Tracks resources and deployment closures created during composition function execution.
 */
export interface CompositionContext {
  /** Map of resource ID to Enhanced resource */
  resources: Record<string, Enhanced<any, any>>;
  /** Map of closure ID to deployment closure */
  closures: Record<string, DeploymentClosure>;
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
  addClosure(id: string, closure: DeploymentClosure): void;
  /** Add a variable to resource ID mapping */
  addVariableMapping(variableName: string, resourceId: string): void;
  /** Generate a unique resource ID */
  generateResourceId(kind: string, name?: string): string;
  /** Generate a unique closure ID */
  generateClosureId(name?: string): string;
}

/**
 * Options for composition context creation.
 */
export interface CompositionContextOptions {
  /**
   * When true, duplicate resource IDs get a numeric suffix instead of overwriting.
   * Used during direct-mode re-execution where forEach loops create multiple
   * resources with the same id (e.g., 'regionDep' → 'regionDep', 'regionDep-1', 'regionDep-2').
   */
  deduplicateIds?: boolean;
}

// =============================================================================
// ASYNC-LOCAL-STORAGE SINGLETONS
// =============================================================================

/**
 * AsyncLocalStorage for composition context.
 * Enables context-aware resource registration across async boundaries.
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

// =============================================================================
// PUBLIC API
// =============================================================================

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
 * Get the current composition context if one is active.
 * @returns The active composition context or undefined if not in composition
 */
export function getCurrentCompositionContext(): CompositionContext | undefined {
  return COMPOSITION_CONTEXT.getStore();
}

/**
 * Run a function with a composition context.
 * @param context The composition context to use
 * @param fn The function to run with the context
 * @returns The result of the function
 */
export function runWithCompositionContext<T>(context: CompositionContext, fn: () => T): T {
  return COMPOSITION_CONTEXT.run(context, fn);
}

/**
 * Generic deployment closure registration wrapper.
 * Automatically registers any deployment closure with the active composition context.
 *
 * @param closureFactory Function that creates the deployment closure
 * @param name Optional name for the closure (used for ID generation)
 * @returns The deployment closure, registered with context if active
 */
export function registerDeploymentClosure<T extends DeploymentClosure>(
  closureFactory: () => T,
  name?: string
): T {
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
 * Create a new composition context with default implementations.
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
