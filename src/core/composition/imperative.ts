/**
 * Imperative Composition Pattern Implementation
 *
 * This module provides the kubernetesComposition function that enables
 * developers to write natural, imperative JavaScript functions while
 * automatically generating the same robust, type-safe ResourceGraphDefinitions
 * as the existing toResourceGraph API.
 */

import { toCamelCase } from '../../utils/string.js';
import {
  getMetadataField,
  getResourceId,
  setMetadataField,
} from '../metadata/index.js';
import {
  buildNestedCompositionAliases,
  extractNestedStatusCel as extractNestedStatusCelFn,
} from './nested-status-cel.js';
import { CompositionDebugger } from '../composition-debugger.js';
import {
  CALLABLE_COMPOSITION_BRAND,
  KUBERNETES_REF_BRAND,
  NESTED_COMPOSITION_BRAND,
} from '../constants/brands.js';
import { CompositionExecutionError, ensureError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { toResourceGraph } from '../serialization/core.js';
import type {
  CallableComposition,
  NestedCompositionResource,
  StatusProxy,
  TypedResourceGraph,
} from '../types/deployment.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import type { Enhanced } from '../types.js';
import type { CompositionContext } from './context.js';
import {
  createCompositionContext,
  getCurrentCompositionContext,
  runInStatusBuilderContext,
  runWithCompositionContext,
} from './context.js';

/**
 * Enable debug mode for composition execution
 * This will log detailed information about resource registration, status building, and performance
 */
const logger = getComponentLogger('imperative-composition');

export function enableCompositionDebugging(): void {
  CompositionDebugger.enableDebugMode();
}

/**
 * Disable debug mode for composition execution
 */
export function disableCompositionDebugging(): void {
  CompositionDebugger.disableDebugMode();
}

/**
 * Get debug logs from composition execution
 * Useful for troubleshooting failed compositions
 */
export function getCompositionDebugLogs(): string[] {
  return CompositionDebugger.getDebugLogs();
}

/**
 * Clear composition debug logs
 */
export function clearCompositionDebugLogs(): void {
  CompositionDebugger.clearDebugLogs();
}

/**
 * Execute a nested composition within a parent composition context
 * This merges the nested composition's resources and closures into the parent context
 */
function executeNestedComposition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  options: SerializationOptions | undefined,
  parentContext: CompositionContext,
  compositionName: string
): TypedResourceGraph<TSpec, TStatus> {
  CompositionDebugger.log('NESTED_COMPOSITION', `Executing nested composition: ${compositionName}`);

  // Create a temporary context for the nested composition with unique identifier
  const uniqueNestedName = `${compositionName}-${++globalCompositionCounter}`;
  const nestedContext = createCompositionContext(uniqueNestedName);

  // Execute the nested composition in its own context
  const nestedResult = runWithCompositionContext(nestedContext, () => {
    return executeCompositionCore(
      definition,
      compositionFn,
      options,
      nestedContext,
      uniqueNestedName,
      undefined // No actual spec available in nested compositions
    );
  });

  // Merge the nested composition's resources and closures into the parent context
  // Use unique identifiers to avoid conflicts across composition boundaries
  const mergedResourceIds: string[] = [];
  const mergedClosureIds: string[] = [];

  for (const [resourceId, resource] of Object.entries(nestedContext.resources)) {
    const uniqueId = generateUniqueResourceId(compositionName, resourceId, parentContext);
    parentContext.addResource(uniqueId, resource);
    mergedResourceIds.push(uniqueId);
  }

  for (const [closureId, closure] of Object.entries(nestedContext.closures)) {
    const uniqueId = generateUniqueClosureId(compositionName, closureId, parentContext);
    parentContext.addClosure(uniqueId, closure);
    mergedClosureIds.push(uniqueId);
  }

  CompositionDebugger.log(
    'NESTED_COMPOSITION',
    `Merged ${mergedResourceIds.length} resources and ${mergedClosureIds.length} closures into parent context`
  );

  // Enhance the result with composition metadata for status access
  const enhancedResult = nestedResult as TypedResourceGraph<TSpec, TStatus> & {
    _compositionMetadata?: {
      name: string;
      mergedResourceIds: string[];
      mergedClosureIds: string[];
    };
  };

  enhancedResult._compositionMetadata = {
    name: compositionName,
    mergedResourceIds,
    mergedClosureIds,
  };

  return enhancedResult;
}

/**
 * Generate a unique resource ID for merged compositions
 */
function generateUniqueResourceId(
  compositionName: string,
  resourceId: string,
  parentContext: CompositionContext
): string {
  let uniqueId = `${compositionName}-${resourceId}`;
  let counter = 1;

  // Ensure uniqueness across all resources in parent context
  while (uniqueId in parentContext.resources) {
    uniqueId = `${compositionName}-${resourceId}-${counter}`;
    counter++;
  }

  return uniqueId;
}

/**
 * Generate a unique closure ID for merged compositions
 */
function generateUniqueClosureId(
  compositionName: string,
  closureId: string,
  parentContext: CompositionContext
): string {
  let uniqueId = `${compositionName}-${closureId}`;
  let counter = 1;

  // Ensure uniqueness across all closures in parent context
  while (uniqueId in parentContext.closures) {
    uniqueId = `${compositionName}-${closureId}-${counter}`;
    counter++;
  }

  return uniqueId;
}

/**
 * Execute a nested composition with a specific spec (when called as a function)
 */

/**
 * Narrow result type for the re-execution lightweight path. Only the
 * fields that executeNestedCompositionWithSpec actually consumes are
 * required — this ensures compile-time failures if new required fields
 * are added to TypedResourceGraph that we'd silently miss.
 */
interface ReExecutionResult<TStatus> {
  resources: Record<string, Enhanced<unknown, unknown>>;
  status: MagicAssignableShape<TStatus> | undefined;
}

function executeNestedCompositionWithSpec<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  options: SerializationOptions | undefined,
  parentContext: CompositionContext,
  spec: TSpec,
  compositionName: string
): NestedCompositionResource<TSpec, TStatus> {
  CompositionDebugger.log(
    'NESTED_COMPOSITION',
    `Executing nested composition with spec: ${compositionName}`
  );

  // Create a unique context for this nested composition execution.
  //
  // - `isReExecution` propagates from the parent so deeply nested
  //   compositions (3+ levels) also skip the KRO analysis pass during
  //   direct-mode re-execution.
  // - `isNestedCall` is always set on this context because, by
  //   definition, we're executing the inner composition with a concrete
  //   spec from the caller. `processCompositionBodyAnalysis` reads this
  //   flag to skip the hybrid-branch re-capture — the inner's branch
  //   analysis was already done at its own definition time, and re-running
  //   it with a fresh inner schema proxy would leak inner-schema refs
  //   into the merged resource templates.
  const uniqueExecutionName = `${compositionName}-execution-${++globalCompositionCounter}`;
  const executionContext = createCompositionContext(uniqueExecutionName, {
    ...(parentContext.isReExecution ? { isReExecution: true } : {}),
    isNestedCall: true,
  });

  // Execute the composition with the provided spec.
  //
  // During re-execution (direct-mode deploy), skip the full
  // toResourceGraph/KRO-analysis pipeline. Just run the composition
  // function directly with real values and capture the resources it
  // registers — no proxy, no CEL generation, no status builder context.
  const isReExec = parentContext.isReExecution;
  const result = runWithCompositionContext(executionContext, () => {
    if (isReExec) {
      // Lightweight path: run composition fn directly, capture resources.
      // Returns a ReExecutionResult — a narrow type with only the fields
      // that executeNestedCompositionWithSpec actually reads (.resources
      // for merging, .status for the NestedCompositionResource return).
      const status = compositionFn(spec);
      return {
        resources: executionContext.resources,
        status,
      } as ReExecutionResult<TStatus> as unknown as TypedResourceGraph<TSpec, TStatus>;
    }
    return executeCompositionCore(
      definition,
      compositionFn,
      options,
      executionContext,
      uniqueExecutionName,
      spec // Pass the actual spec
    );
  });

  // Get the instance number for this composition call
  const instanceNumber = ++parentContext.compositionInstanceCounter;

  // For composition names ending with '-composition', use the base name for resource IDs
  // This enables variable name mapping like worker1, worker2, etc.
  // The base name is converted to camelCase to produce valid CEL identifiers
  // (hyphens are not valid in CEL, e.g., 'inngest-bootstrap1' would be parsed
  // as 'inngest' minus 'bootstrap1').
  let baseName = compositionName;
  if (baseName.endsWith('-composition')) {
    baseName = baseName.slice(0, -'-composition'.length);
  }
  baseName = toCamelCase(baseName);
  const baseId = `${baseName}${instanceNumber}`;

  // Validate: nested composition IDs must not contain hyphens because
  // synthesizeNestedCompositionStatus uses hyphen-delimited segment
  // splitting to identify parent/child relationships.
  if (baseId.includes('-')) {
    throw new Error(
      `Nested composition ID "${baseId}" contains hyphens. ` +
      `toCamelCase should have removed them from "${compositionName}".`
    );
  }

  // Register this nested composition ID so synthesizeNestedCompositionStatus
  // can identify virtual parents without relying on digit-heuristics.
  if (!parentContext.nestedCompositionIds) {
    parentContext.nestedCompositionIds = new Set();
  }
  parentContext.nestedCompositionIds.add(baseId);

  // Register the inner composition's compositionFn so the outer's schema
  // generation can source-parse it for `?? <literal>` defaults and
  // auto-mirror them into the outer schema. This unblocks the common
  // pattern where an inner reads `spec.X?.Y ?? default` and the outer
  // doesn't explicitly expose Y in its schema — in KRO mode the proxy is
  // truthy so `??` never fires, leaving a CEL ref to a field the outer
  // schema doesn't declare. With the inner's default mirrored into the
  // outer schema, KRO resolves the ref via the default at apply time.
  if (!parentContext.nestedCompositionFns) {
    parentContext.nestedCompositionFns = new Map();
  }
  parentContext.nestedCompositionFns.set(baseId, compositionFn);

  // Determine if this composition has a single resource
  const resourceCount = Object.keys(executionContext.resources).length;

  // Merge the executed composition's resources into the parent context
  for (const [resourceId, resource] of Object.entries(executionContext.resources)) {
    // For single-resource compositions, use baseId as the resource ID
    // For multi-resource compositions, use baseId-resourceId
    const uniqueId = resourceCount === 1 ? baseId : `${baseId}-${resourceId}`;
    parentContext.addResource(uniqueId, resource);
  }

  for (const [closureId, closure] of Object.entries(executionContext.closures)) {
    const uniqueId = generateUniqueClosureId(compositionName, closureId, parentContext);
    parentContext.addClosure(uniqueId, closure);
  }

  CompositionDebugger.log(
    'NESTED_COMPOSITION',
    `Executed nested composition ${compositionName} with ${Object.keys(executionContext.resources).length} resources and ${Object.keys(executionContext.closures).length} closures`
  );

  // Preserve the inner composition's analyzed status CEL expressions so the
  // outer composition's serializer can inline them when it encounters a
  // reference like `inngestBootstrap1.status.ready`. There are two sources
  // we need to propagate up:
  //
  // 1. The inner composition's own direct analysis (its `analyzedStatusMappings`
  //    — Phase A + Phase B). These give the outer access to the inner's
  //    top-level status fields.
  // 2. The inner composition's own accumulated `__nestedStatus:*` entries
  //    (from further-nested compositions it called). Without this
  //    propagation, the outer can't resolve references like `inngest.status.ready`
  //    that appear inside the inner's status expressions — the resolution
  //    target lives in the inner's variableMappings but never makes it to
  //    the outer's. This is what enables 3+ level nesting.
  const innerAnalysis = (result as unknown as Record<string, unknown>)._analysisResults as
    { analyzedStatusMappings?: Record<string, unknown>; phaseBStatusMappings?: Record<string, unknown> } | undefined;

  const innerStatusSource = innerAnalysis?.analyzedStatusMappings;
  const innerPhaseBFallback = innerAnalysis?.phaseBStatusMappings;
  if (innerStatusSource) {
    extractNestedStatusCelFn(innerStatusSource, {
      baseId,
      innerResourceIds: Object.keys(executionContext.resources),
      registerMapping: (key, value) => parentContext.addVariableMapping(key, value),
    }, '', innerPhaseBFallback);
  }

  // Propagate the inner composition's deeper nested-status entries up to
  // the parent. The inner accumulated these in its own variableMappings
  // when it processed its own nested composition calls (further-nested
  // compositions).
  //
  // Each propagated entry's baseId is unique across the composition tree
  // because `globalCompositionCounter` is monotonic, so there's no key
  // collision between *different* deeply-nested compositions. The guard
  // below — `!(key in parentContext.variableMappings)` — protects a
  // different case: the direct extraction pass that ran a few lines
  // above may have already produced an entry for the same key after
  // running it through `remapVariableNames` against this composition's
  // immediate inner resource set. That direct-pass entry is more
  // specific (its variable names are remapped to the inner's resources),
  // so we don't want to overwrite it with the verbatim-propagated entry.
  for (const [key, value] of Object.entries(executionContext.variableMappings)) {
    if (key.startsWith('__nestedStatus:')) {
      if (!(key in parentContext.variableMappings)) {
        parentContext.addVariableMapping(key, value);
      }
    }
  }

  // Propagate the inner composition's own nested-composition fn map upward.
  // This enables the outermost `arktypeToKroSchema` call to source-parse
  // every composition in the tree (not just immediate children) for
  // `?? <literal>` defaults and auto-mirror them into the top-level schema.
  if (executionContext.nestedCompositionFns) {
    for (const [innerBaseId, innerFn] of executionContext.nestedCompositionFns) {
      if (!parentContext.nestedCompositionFns!.has(innerBaseId)) {
        parentContext.nestedCompositionFns!.set(innerBaseId, innerFn);
      }
    }
  }

  // Create a NestedCompositionResource to return.
  // During re-execution (direct-mode deploy), return the REAL status
  // values from the inner composition — not a KubernetesRef proxy.
  // The proxy is needed for KRO analysis (to generate CEL expressions
  // for cross-composition references), but in direct mode the outer
  // composition needs actual strings to wire into env vars, etc.
  // dependsOn is added via Object.defineProperty below — use Omit + cast
  // to satisfy TypeScript while preserving the runtime defineProperty pattern.
  const nestedCompositionResource = {
    [NESTED_COMPOSITION_BRAND]: true as const,
    spec,
    status: isReExec
      ? (result as unknown as { status?: TStatus }).status ?? ({} as TStatus)
      : createStatusProxy<TStatus>(baseId, parentContext, result),
    __compositionId: uniqueExecutionName,
    __resources: result.resources,
  } as NestedCompositionResource<TSpec, TStatus>;

  // Add dependsOn method so compositions can express ordering dependencies.
  // When called, it attaches the dependency to the LAST resource registered
  // by this inner composition (the "leaf" that gates overall readiness),
  // not all merged resources.
  Object.defineProperty(nestedCompositionResource, 'dependsOn', {
    value: function (dependency: unknown, condition?: string) {
      // Find the last resource registered by this inner composition
      const innerResourceIds = Object.keys(executionContext.resources);
      const lastInnerResourceId = innerResourceIds[innerResourceIds.length - 1];
      if (!lastInnerResourceId) return nestedCompositionResource;

      // The merged ID in the parent context
      const resourceCount = innerResourceIds.length;
      const mergedId = resourceCount === 1 ? baseId : `${baseId}-${lastInnerResourceId}`;

      // Find the merged resource in the parent context
      const mergedResource = parentContext.resources[mergedId];
      if (!mergedResource) return nestedCompositionResource;

      // Extract dependency resource ID
      let depId: string | undefined;
      depId = getResourceId(dependency as Record<string, unknown>);
      if (!depId && typeof dependency === 'object' && dependency !== null) {
        depId = (dependency as Record<string, unknown>).__compositionId as string | undefined;
      }
      if (!depId) return nestedCompositionResource;

      // Attach dependsOn to the leaf resource
      const existing = getMetadataField(mergedResource, 'dependsOn') as
        | Array<{ resourceId: string; condition?: string }>
        | undefined;
      const deps = existing ?? [];
      deps.push({ resourceId: depId, ...(condition !== undefined && { condition }) });
      setMetadataField(mergedResource, 'dependsOn', deps);

      return nestedCompositionResource;
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return nestedCompositionResource;
}

/**
 * KubernetesRef metadata property names used by the proxy allowlist strategy.
 * When `useAllowlist` is true, only these properties are returned from the
 * proxy target — all other string accesses create nested proxies.
 */
const KUBERNETES_REF_PROXY_PROPS = new Set([
  KUBERNETES_REF_BRAND,
  'resourceId',
  'fieldPath',
  '__nestedComposition',
]);

/**
 * Target shape for {@link createKubernetesRefProxy} — the small object the
 * `Proxy` wraps. Carries the KubernetesRef brand and the
 * `__nestedComposition` flag so consumers (cel-references serializer,
 * cel-validator transitive classifier) can detect a nested composition
 * status reference uniformly.
 *
 * The index signature is intentional — dynamic property access through
 * the Proxy's get-trap needs to be allowed at compile time. The runtime
 * behavior is fully controlled by the Proxy handler in
 * {@link createKubernetesRefProxy}; the underlying target object only
 * ever exposes the four named fields above.
 *
 * **`valueOf` and `===` interaction.** The proxy returns the marker
 * string from `toString`/`valueOf`, so loose-equality (`==`) comparisons
 * with strings work via the abstract equality spec's ToPrimitive
 * coercion. Strict-equality (`===`) with numbers always returns false
 * because the proxy is an object, not a number — that's expected, since
 * these proxies are not meant for arithmetic. Composition authors should
 * use `Cel.expr<number>(ref, ' >= 1')` or similar for numeric
 * comparisons in CEL output.
 */
interface NestedRefProxyTarget {
  [KUBERNETES_REF_BRAND]: true;
  resourceId: string;
  fieldPath: string;
  __nestedComposition: true;
  [key: string]: unknown;
}

/**
 * Create a recursive proxy that returns `KubernetesRef` objects for
 * arbitrarily deep property access on a nested composition's status.
 *
 * Used by {@link createStatusProxy}: `<nestedComp>.status.X` produces a
 * chain of these proxies rooted at the nested composition's virtual
 * baseId. The proxies carry the `__nestedComposition` marker so
 * downstream serialization knows to resolve them via `nestedStatusCel`.
 *
 * **String coercion** is implemented via `Symbol.toPrimitive`, `toString`,
 * and `valueOf`, producing the canonical marker token
 * `__KUBERNETES_REF_<resourceId>_<fieldPath>__` (matching `createRefFactory`
 * and `createSchemaRefFactory`). This keeps the proxy usable in template
 * literals (`` `${nested.status.foo}-bar` ``) — the template literal
 * machinery sees a string with a marker, and the later transitive
 * resolver in `cel-references.ts` substitutes the nested expression in.
 *
 * Two property-resolution strategies are supported:
 * - `useAllowlist: false` (default) — uses `prop in target` to decide
 *   whether to return the target value or create a nested proxy.
 * - `useAllowlist: true` — only the four KubernetesRef metadata properties
 *   (`KUBERNETES_REF_BRAND`, `resourceId`, `fieldPath`, `__nestedComposition`)
 *   are returned from the target; everything else creates a nested proxy.
 *
 * @param resourceId  - The resource identifier embedded in every ref
 * @param basePath    - The initial field path (e.g. `'status'` or `''`)
 * @param useAllowlist - When true, use an explicit allowlist instead of `prop in target`
 */
function createKubernetesRefProxy(
  resourceId: string,
  basePath: string,
  useAllowlist = false
): NestedRefProxyTarget {
  const baseObj: NestedRefProxyTarget = {
    [KUBERNETES_REF_BRAND]: true,
    resourceId,
    fieldPath: basePath,
    __nestedComposition: true,
  };

  // Canonical marker form — matches `createRefFactory` and `createSchemaRefFactory`
  // so that downstream serialization code (processResourceReferences,
  // convertKubernetesRefMarkersTocel, resolveNestedCompositionRefs) can
  // recognize and substitute these proxies uniformly.
  const markerString = `__KUBERNETES_REF_${resourceId}_${basePath}__`;

  return new Proxy(baseObj, {
    get(target, prop) {
      // String-coercion hooks — same pattern as the other ref factories.
      // `toString`/`valueOf` produce the marker string; `Symbol.toPrimitive`
      // returns the marker for 'string' hints and NaN for numeric hints
      // (so comparisons like `ref >= 1` evaluate to `false` in Phase A,
      // triggering Phase B fn.toString analysis).
      if (prop === 'toString' || prop === 'valueOf') {
        return () => markerString;
      }
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => (hint === 'string' ? markerString : NaN);
      }

      // Determine whether to return the target property directly
      const isKnownProp = useAllowlist
        ? typeof prop === 'string' && KUBERNETES_REF_PROXY_PROPS.has(prop)
        : prop in target;

      if (isKnownProp) {
        return target[prop as keyof NestedRefProxyTarget];
      }

      // For any other string property, check live status data first,
      // then fall back to creating a nested proxy.
      if (typeof prop === 'string') {
        // When live status data is available (post-deployment re-execution),
        // return real values so status comparisons evaluate correctly.
        if (basePath === 'status') {
          const ctx = getCurrentCompositionContext();
          const liveStatus = ctx?.liveStatusMap?.get(resourceId);
          if (liveStatus && Object.hasOwn(liveStatus, prop)) {
            return liveStatus[prop];
          }
        }

        const fullPath = basePath ? `${basePath}.${prop}` : prop;
        return createKubernetesRefProxy(resourceId, fullPath, useAllowlist);
      }

      return undefined;
    },
  });
}

/**
 * Create a status proxy for cross-composition references
 * @param compositionName - Name of the composition
 * @param parentContext - Parent composition context (if nested)
 * @param nestedResult - The result of executing the nested composition
 * @param forCompositionProperty - If true, create KubernetesRef proxy for composition.status; if false, create for call result
 */
function createStatusProxy<TStatus>(
  compositionName: string,
  parentContext: CompositionContext | null,
  _nestedResult?: TypedResourceGraph<KroCompatibleType, KroCompatibleType>,
  forCompositionProperty: boolean = false
): StatusProxy<TStatus> {
  // For CallableComposition.status property or nested composition results
  // within a parent context, create a KubernetesRef proxy using the
  // composition name as resource ID and 'status' as the base path.
  // Cast is intentional: the proxy creates KubernetesRef shapes at runtime,
  // but exposes TStatus to the compiler for type-safe property access.
  if (forCompositionProperty || parentContext) {
    return createKubernetesRefProxy(compositionName, 'status') as StatusProxy<TStatus>;
  }

  // For top-level composition calls (no parent context), use the strict
  // allowlist strategy so only KubernetesRef metadata properties are
  // returned directly from the target, and start from an empty base path.
  return createKubernetesRefProxy(
    `${compositionName}-status`,
    '',
    /* useAllowlist */ true
  ) as StatusProxy<TStatus>;
}

/**
 * Global composition counter for unique identifier generation
 */
let globalCompositionCounter = 0;

/**
 * Core composition execution logic shared between nested and top-level compositions
 */
function executeCompositionCore<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  options: SerializationOptions | undefined,
  context: CompositionContext,
  compositionName: string,
  actualSpec?: TSpec
): TypedResourceGraph<TSpec, TStatus> {
  const startTime = Date.now();

  // Declare capturedStatus here so it's accessible to both resource and status builders
  let capturedStatus: MagicAssignableShape<TStatus> | undefined;

  try {
    CompositionDebugger.logCompositionStart(compositionName);

    // Override addResource to include debug logging
    const originalAddResource = context.addResource;
    context.addResource = function (id: string, resource: Enhanced<unknown, unknown>) {
      originalAddResource.call(this, id, resource);

      // Log resource registration for debugging
      const resourceKind = (resource as { kind?: string })?.kind || 'unknown';
      CompositionDebugger.logResourceRegistration(id, resourceKind, 'factory-function');
    };

    const result = toResourceGraph(
      definition,
      // Resource builder - execute composition to collect resources
      (schema: SchemaProxy<TSpec, TStatus>) => {
        try {
          CompositionDebugger.log('RESOURCE_BUILDING', 'Executing composition function');

          // Override addResource to include debug logging
          const originalAddResource = context.addResource;
          context.addResource = function (id: string, resource: Enhanced<unknown, unknown>) {
            originalAddResource.call(this, id, resource);

            // Log resource registration for debugging
            const resourceKind = (resource as { kind?: string })?.kind || 'unknown';
            CompositionDebugger.logResourceRegistration(id, resourceKind, 'factory-function');
          };

          const resourceBuildStart = Date.now();

          // When `actualSpec` is provided, this is a re-execution with real
          // values (direct-mode deploy). Run the composition function WITHOUT
          // the status builder context so ternaries and conditionals evaluate
          // as plain JavaScript — no KubernetesRef proxies, no CEL generation.
          //
          // When `actualSpec` is absent, this is the initial KRO analysis
          // pass. Run in status builder context so Enhanced resource proxies
          // return KubernetesRef objects, enabling JS-to-CEL conversion.
          const specToUse = actualSpec || (schema.spec as TSpec);
          capturedStatus = actualSpec
            ? compositionFn(specToUse)
            : runInStatusBuilderContext(() => compositionFn(specToUse));

          // Store the original composition function for later analysis
          // This allows the serialization system to analyze the original JavaScript expressions
          Reflect.set(capturedStatus, '__originalCompositionFn', compositionFn);
          Reflect.set(capturedStatus, '__originalSchema', schema.spec);

          // Attach nested composition status CEL mappings from the context.
          // These are populated by inner compositions' executeNestedCompositionWithSpec.
          //
          // We also source-parse this composition function to find variable
          // assignments to nested-composition calls (e.g.,
          // `const stack = webAppWithProcessing(...)`) and add alias entries
          // mapping the variable name to the nested composition's baseId.
          // This lets the transitive resolver in `cel-references.ts` resolve
          // references like `stack.status.ready` that Phase B AST analysis
          // captures verbatim from the source — the variable name has no
          // structural relationship to the baseId, but the alias bridges
          // that gap.
          const nestedStatusMappings: Record<string, string> = {};
          for (const [key, value] of Object.entries(context.variableMappings)) {
            if (key.startsWith('__nestedStatus:')) {
              nestedStatusMappings[key] = value;
            }
          }
          if (Object.keys(nestedStatusMappings).length > 0) {
            const aliases = buildNestedCompositionAliases(
              compositionFn.toString(),
              context.nestedCompositionIds,
              nestedStatusMappings
            );
            for (const [aliasKey, aliasValue] of Object.entries(aliases)) {
              nestedStatusMappings[aliasKey] = aliasValue;
              // Also push to context.variableMappings so they propagate up
              // to outer compositions when this composition is itself nested.
              context.addVariableMapping(aliasKey, aliasValue);
            }
            Reflect.set(capturedStatus, '__nestedStatusCel', nestedStatusMappings);
          }

          // Attach the nested-composition-fn map so `arktypeToKroSchema` can
          // source-parse every nested composition in the tree for
          // `?? <literal>` defaults and auto-mirror them into this outer
          // schema. See CompositionContext.nestedCompositionFns for the
          // full rationale.
          if (context.nestedCompositionFns && context.nestedCompositionFns.size > 0) {
            Reflect.set(capturedStatus, '__nestedCompositionFns', context.nestedCompositionFns);
          }

          const resourceBuildEnd = Date.now();
          CompositionDebugger.logPerformanceMetrics(
            'Resource Building',
            resourceBuildStart,
            resourceBuildEnd,
            {
              resourceCount: Object.keys(context.resources).length,
              closureCount: Object.keys(context.closures).length,
            }
          );

          // Create a combined object that separateResourcesAndClosures can handle
          // Use the resource IDs as keys for resources, and closure IDs as keys for closures
          const combined: Record<string, Enhanced<unknown, unknown>> = {};

          // Add Enhanced resources
          for (const [id, resource] of Object.entries(context.resources)) {
            combined[id] = resource;
          }

          // Type cast: closures and Enhanced resources share the same map for sequential
          // processing. Closures are functions but are stored under Enhanced<> type here;
          // code that reads this map uses duck-typing to distinguish them at runtime.
          for (const [id, closure] of Object.entries(context.closures)) {
            combined[id] = closure as unknown as Enhanced<unknown, unknown>;
          }

          return combined;
        } catch (error: unknown) {
          throw CompositionExecutionError.withResourceContext(
            `Failed to execute composition function: ${ensureError(error).message}`,
            compositionName,
            'resource-creation',
            'composition-function',
            'composition',
            'kubernetesComposition',
            ensureError(error)
          );
        }
      },
      // Status builder - return the captured status
      (
        _schema: SchemaProxy<TSpec, TStatus>,
        _resources: Record<string, Enhanced<unknown, unknown>>
      ) => {
        try {
          CompositionDebugger.log('STATUS_BUILDING', 'Processing captured status object');

          // Note: Pattern validation is disabled during normal operation
          // as resource references appear as functions before serialization
          // Pattern validation should be done at a different stage if needed

          CompositionDebugger.logStatusValidation(compositionName, capturedStatus, 'success');

          // Return the status captured during resource building
          // This avoids double execution and ensures resources are available
          if (!capturedStatus) {
            throw new CompositionExecutionError(
              'Status was not captured during resource building phase',
              compositionName,
              'status-building'
            );
          }
          return capturedStatus;
        } catch (error: unknown) {
          if (error instanceof CompositionExecutionError) {
            throw error;
          }

          throw CompositionExecutionError.forStatusBuilding(
            compositionName,
            'status-object',
            'MagicAssignableShape<TStatus>',
            capturedStatus,
            ensureError(error)
          );
        }
      },
      options
    );

    // For executed compositions (when called with a spec), replace the schema status with the executed status values
    if (actualSpec !== undefined && capturedStatus) {
      Object.defineProperty(result, 'status', {
        value: capturedStatus,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    const endTime = Date.now();
    const statusFields = capturedStatus ? Object.keys(capturedStatus) : [];

    CompositionDebugger.logCompositionEnd(
      compositionName,
      Object.keys(context.resources).length + Object.keys(context.closures).length,
      statusFields
    );

    CompositionDebugger.logPerformanceMetrics('Total Composition', startTime, endTime, {
      resourceCount: Object.keys(context.resources).length,
      closureCount: Object.keys(context.closures).length,
      statusFieldCount: statusFields.length,
    });

    // Store the composition function for potential re-execution with actual values
    // Use Object.defineProperty to avoid readonly property issues
    try {
      Object.defineProperty(result, '_compositionFn', {
        value: compositionFn,
        writable: false,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(result, '_definition', {
        value: definition,
        writable: false,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(result, '_options', {
        value: options || {},
        writable: false,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(result, '_context', {
        value: context,
        writable: false,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(result, '_compositionName', {
        value: compositionName,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    } catch (error: unknown) {
      // If we can't add properties to the result object, log a warning but continue
      logger.warn('Could not store composition function for re-execution', {
        error: String(error),
      });
    }

    return result;
  } catch (error: unknown) {
    const endTime = Date.now();
    CompositionDebugger.logPerformanceMetrics('Failed Composition', startTime, endTime, {
      error: ensureError(error).message,
    });

    if (error instanceof CompositionExecutionError) {
      throw error;
    }

    throw new CompositionExecutionError(
      `Composition execution failed: ${ensureError(error).message}`,
      compositionName,
      'context-setup',
      undefined,
      ensureError(error)
    );
  }
}

/**
 * Create an imperative Kubernetes composition using natural TypeScript.
 *
 * Unlike {@link toResourceGraph} which uses separate resource/status builders,
 * `kubernetesComposition` lets you write a single function that creates resources
 * inline. Resources are automatically captured via the magic proxy system.
 * The returned callable composition can be deployed directly or nested inside
 * other compositions.
 *
 * @typeParam TSpec - The arktype schema for the custom resource's spec
 * @typeParam TStatus - The arktype schema for the custom resource's status
 *
 * @param definition - The RGD metadata: name, apiVersion, kind, spec/status schemas
 * @param compositionFn - Imperative function receiving the spec, creates resources
 *   inline, and returns a status shape. Resources created with factory functions
 *   (e.g., `Deployment()`, `Service()`) are automatically registered.
 * @param options - Optional serialization options
 * @returns A `CallableComposition` that can be deployed or nested inside other compositions
 *
 * @example
 * ```typescript
 * const webapp = kubernetesComposition(
 *   {
 *     name: 'webapp',
 *     apiVersion: 'apps.example.com/v1alpha1',
 *     kind: 'WebApp',
 *     spec: type({ name: 'string', replicas: 'number' }),
 *     status: type({ ready: 'boolean' }),
 *   },
 *   (spec) => {
 *     const deploy = Deployment({ name: spec.name, replicas: spec.replicas });
 *     const svc = Service({ name: spec.name });
 *     return {
 *       ready: Cel.expr<boolean>(deploy.status.readyReplicas, ' > 0'),
 *     };
 *   },
 * );
 * ```
 */
export function kubernetesComposition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): CallableComposition<TSpec, TStatus> {
  const compositionName = definition.name || 'unnamed-composition';

  // Check if we're being called within another composition context
  const parentContext = getCurrentCompositionContext();

  if (parentContext) {
    // We're nested within another composition - merge our resources into the parent context
    // and return a CallableComposition that can be called with a spec.
    //
    // Skip the definition-time proxy pass during re-execution — it
    // generates CEL expressions that pollute resource names in direct
    // mode. The spec-driven pass (via the callable below) is the only
    // one that matters during re-execution.
    const nestedResult = parentContext.isReExecution
      ? undefined
      : executeNestedComposition(
          definition,
          compositionFn,
          options,
          parentContext,
          compositionName
        );

    // Create a callable composition that can be invoked with a spec.
    // Use the CURRENT composition context at call time (not the captured
    // `parentContext` from definition time) so re-execution correctly
    // detects `isReExecution` and returns real status values.
    const callableComposition = ((spec: TSpec) => {
      const currentContext = getCurrentCompositionContext() ?? parentContext;
      return executeNestedCompositionWithSpec(
        definition,
        compositionFn,
        options,
        currentContext,
        spec,
        compositionName
      );
    }) as CallableComposition<TSpec, TStatus>;

    // Copy properties from the TypedResourceGraph to the callable composition.
    //
    // INVARIANT: During re-execution, nestedResult is undefined (definition
    // pass skipped) and the callable has no graph properties (.resources,
    // ._compositionFn, etc.). This is safe because during re-execution
    // the callable is always INVOKED (not just read) — the outer
    // composition function calls webAppWithProcessing({...}) which
    // executes the callable and returns a NestedCompositionResource with
    // real status values. No code path reads graph properties off the
    // callable itself during re-execution.
    if (nestedResult) {
      for (const key of Object.getOwnPropertyNames(nestedResult)) {
        const descriptor = Object.getOwnPropertyDescriptor(nestedResult, key);
        if (descriptor) {
          Object.defineProperty(callableComposition, key, descriptor);
        }
      }
    }

    // Add the status proxy for cross-composition references.
    // During re-execution, nestedResult is undefined (definition pass
    // skipped). The static .status on the callable is not used in that
    // case — callers invoke the callable which returns a
    // NestedCompositionResource with real status values. The proxy
    // here is only relevant for the KRO analysis pass where the
    // callable's .status is read for graph serialization.
    Object.defineProperty(callableComposition, 'status', {
      value: nestedResult
        ? createStatusProxy<TStatus>(compositionName, parentContext, nestedResult, true)
        : {},  // Re-execution: unused — status comes from the callable's return value
      enumerable: true,
      configurable: false,
      writable: false,
    });

    // Add the callable composition brand
    Object.defineProperty(callableComposition, CALLABLE_COMPOSITION_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    // Add toJSON to make the composition serializable
    // Only include enumerable properties, not metadata like _compositionFn
    Object.defineProperty(callableComposition, 'toJSON', {
      value: function (this: Record<string, unknown>) {
        const obj: Record<string, unknown> = {};
        for (const key of Object.keys(this)) {
          obj[key] = this[key];
        }
        return obj;
      },
      enumerable: false,
      configurable: false,
      writable: false,
    });

    return callableComposition;
  }

  // Execute the composition immediately and return a CallableComposition
  const uniqueCompositionName = `${compositionName}-${++globalCompositionCounter}`;
  const context = createCompositionContext(uniqueCompositionName);
  const result = runWithCompositionContext(context, () => {
    return executeCompositionCore(
      definition,
      compositionFn,
      options,
      context,
      uniqueCompositionName,
      undefined // No actual spec available during initial composition creation
    );
  });

  // Create a callable composition that can be invoked with a spec
  const callableComposition = ((spec: TSpec) => {
    // Check if we're being called inside another composition context
    const currentParentContext = getCurrentCompositionContext();

    if (currentParentContext) {
      // We're being called inside another composition - merge resources into parent
      // This ensures nested composition resources appear in parent YAML
      return executeNestedCompositionWithSpec(
        definition,
        compositionFn,
        options,
        currentParentContext,
        spec,
        compositionName
      );
    }

    // Top-level call (no parent context) - execute in isolation
    const callCompositionName = `${compositionName}-call-${++globalCompositionCounter}`;
    const callContext = createCompositionContext(callCompositionName);
    const callResult = runWithCompositionContext(callContext, () => {
      return executeCompositionCore(
        definition,
        compositionFn,
        options,
        callContext,
        callCompositionName,
        spec
      );
    });

    // Return a NestedCompositionResource
    // Use compositionName (not callCompositionName) for status resourceId
    // This ensures ${nested-service.status.ready} instead of ${nested-service-call-18-status.ready}
    return {
      [NESTED_COMPOSITION_BRAND]: true as const,
      spec,
      status: createStatusProxy<TStatus>(compositionName, null, callResult),
      __compositionId: callCompositionName,
      __resources: callResult.resources,
    } as NestedCompositionResource<TSpec, TStatus>;
  }) as unknown as CallableComposition<TSpec, TStatus>; // Double cast needed: function shape doesn't overlap with CallableComposition

  // Create a set to track explicitly deleted properties
  const deletedProperties = new Set<string | symbol>();

  // Wrap the callable composition in a Proxy to preserve magic proxy behavior from result
  // This enables resource access like: composition.deployment
  const proxiedCallableComposition = new Proxy(callableComposition, {
    get(target, prop, receiver) {
      // If the property was explicitly deleted, return undefined
      if (deletedProperties.has(prop)) {
        return undefined;
      }

      // If the property exists on the function itself, return it
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      // Delegate to the result's Proxy for unknown properties (resource access)
      // The result is already a Proxy from toResourceGraph with magic resource access
      return Reflect.get(result, prop, result);
    },

    // Handle property deletion to ensure deleted properties stay deleted
    deleteProperty(target, prop) {
      // Track that this property was deleted
      deletedProperties.add(prop);
      return Reflect.deleteProperty(target, prop);
    },

    // Ensure property enumeration includes both function properties and result properties
    ownKeys(target) {
      const targetKeys = Reflect.ownKeys(target);
      const resultKeys = Reflect.ownKeys(result);
      // Filter out deleted properties
      return [...new Set([...targetKeys, ...resultKeys])].filter(
        (key) => !deletedProperties.has(key)
      );
    },

    // Ensure proper property descriptor handling
    getOwnPropertyDescriptor(target, prop) {
      // If the property was explicitly deleted, return undefined
      if (deletedProperties.has(prop)) {
        return undefined;
      }

      // Check function properties first
      const targetDesc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (targetDesc) {
        return targetDesc;
      }

      // Fall back to result properties
      return Reflect.getOwnPropertyDescriptor(result, prop);
    },
  });

  // Copy properties from the TypedResourceGraph to the function
  // Preserve original property descriptors to maintain non-writable metadata properties
  // Use getOwnPropertyNames to include non-enumerable properties like _compositionFn
  for (const key of Object.getOwnPropertyNames(result)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor) {
      Object.defineProperty(callableComposition, key, descriptor);
    }
  }

  // Add the status proxy for cross-composition references
  // Use forCompositionProperty=true to get KubernetesRef-based proxy
  Object.defineProperty(callableComposition, 'status', {
    value: createStatusProxy<TStatus>(compositionName, null, result, true),
    enumerable: true,
    configurable: false,
    writable: false,
  });

  // Add the callable composition brand
  Object.defineProperty(callableComposition, CALLABLE_COMPOSITION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // Add toJSON to make the composition serializable
  // Only include enumerable properties, not metadata like _compositionFn
  Object.defineProperty(callableComposition, 'toJSON', {
    value: function (this: Record<string, unknown>) {
      const obj: Record<string, unknown> = {};
      for (const key of Object.keys(this)) {
        obj[key] = this[key];
      }
      return obj;
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return proxiedCallableComposition;
}
