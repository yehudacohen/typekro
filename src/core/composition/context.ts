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
import type { SingletonDefinitionRecord } from '../types/deployment.js';
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
  /**
   * Live status data from deployed resources, keyed by resource ID.
   * When set, the proxy system returns real status values instead of
   * KubernetesRef objects. Used during post-deployment re-execution
   * so status comparisons (e.g., `readyInstances >= 1`) evaluate correctly.
   */
  liveStatusMap?: Map<string, Record<string, unknown>>;
  /**
   * Set of known nested composition base IDs.
   * Populated during composition execution when nested compositions are created.
   * Used by synthesizeNestedCompositionStatus to identify virtual parent IDs
   * without relying on string-pattern heuristics.
   */
  nestedCompositionIds?: Set<string>;
  /**
   * Map of nested composition baseId → its `compositionFn` reference.
   *
   * Populated alongside `nestedCompositionIds` whenever a nested composition
   * is registered. Used by `arktypeToKroSchema` to source-parse each inner
   * composition for `?? <literal>` defaults via `extractNullishDefaults`,
   * and merge those defaults into the outer schema's specFields. Without
   * this, the outer schema would emit `${schema.spec.X.Y}` references for
   * fields that the inner declares with a JS default but the outer never
   * exposes — and KRO would reject the RGD because the field isn't in
   * the outer schema.
   *
   * Entries propagate up across nesting levels: an inner composition's
   * own nested fns are copied into its parent's map at merge time so
   * default-extraction at the outermost level can see all nesting depths.
   */
  // biome-ignore lint/suspicious/noExplicitAny: composition fns have arbitrary spec/status types
  nestedCompositionFns?: Map<string, (...args: any[]) => unknown>;
  /** Map of nested composition baseId -> returned status snapshot. */
  nestedStatusSnapshots?: Map<string, Record<string, unknown>>;
  /** Singleton definitions collected while executing the composition. */
  singletonDefinitions?: Map<string, SingletonDefinitionRecord>;
  /** True when this context is a direct-mode re-execution. */
  isReExecution?: boolean | undefined;
  /**
   * True when this context was created to execute a composition AS A NESTED
   * CALL with a concrete spec from the caller (as opposed to the composition's
   * own definition-time pass with a schema proxy). Used by
   * `processCompositionBodyAnalysis` to skip hybrid-branch re-capture — the
   * outer composition is the authority on branch conditions, and re-running
   * the inner composition with a fresh inner schema proxy would produce
   * differential conditionals referencing inner-schema fields that don't
   * exist in the outer RGD.
   */
  isNestedCall?: boolean | undefined;
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
  /**
   * When true, this context is a direct-mode re-execution with real spec
   * values. Nested compositions should skip their definition-time proxy
   * pass (which generates CEL) and only run the spec-driven execution.
   */
  isReExecution?: boolean;
  /**
   * When true, this context was created to execute a composition as a
   * nested call with a concrete spec from the caller. Signals to
   * `processCompositionBodyAnalysis` that hybrid-branch re-capture should
   * be skipped — see {@link CompositionContext.isNestedCall}.
   */
  isNestedCall?: boolean;
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
    nestedStatusSnapshots: new Map(),
    singletonDefinitions: new Map(),
    isReExecution: contextOptions?.isReExecution,
    isNestedCall: contextOptions?.isNestedCall,
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
    addClosure(id: string, closure: DeploymentClosure) {
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
