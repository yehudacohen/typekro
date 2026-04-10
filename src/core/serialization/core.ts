/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */

import { createCompositionContext, getCurrentCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { createDirectResourceFactory } from '../deployment/direct-factory.js';
import { createKroResourceFactory } from '../deployment/kro-factory.js';
import { ensureError, ValidationError } from '../errors.js';
import {
  type ASTAnalysisResult,
  analyzeCompositionBody,
  applyAnalysisToResources,
} from '../expressions/composition/composition-analyzer.js';
import { StatusBuilderAnalyzer } from '../expressions/factory/status-builder-analyzer.js';
import { getComponentLogger } from '../logging/index.js';
import { setResourceId } from '../metadata/index.js';
import { createExternalRefWithoutRegistration, createSchemaProxy } from '../references/index.js';
import { getKindInfo, getSemanticCandidateKinds } from '../resources/factory-registry.js';
import type {
  DeploymentClosure,
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
  TypedResourceGraph,
} from '../types/deployment.js';
import type {
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import type { Enhanced, KroCompatibleType, KubernetesResource } from '../types.js';
import { validateResourceGraphDefinition } from '../validation/cel-validator.js';
import { optimizeStatusMappings } from './cel-optimizer.js';
import { applyTernaryConditionalsToResources } from './kro-post-processing.js';
import { generateKroSchemaFromArktype } from './schema.js';
import { runStatusAnalysisPipeline } from './status-analysis-pipeline.js';
import { serializeResourceGraphToYaml } from './yaml.js';

/**
 * Separate Enhanced<> resources from deployment closures in the builder result
 */
function separateResourcesAndClosures<
  T extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  builderResult: T
): { resources: Record<string, Enhanced<any, any>>; closures: Record<string, DeploymentClosure> } {
  const resources: Record<string, Enhanced<any, any>> = {};
  const closures: Record<string, DeploymentClosure> = {};

  for (const [key, value] of Object.entries(builderResult)) {
    if (typeof value === 'function') {
      // This is a deployment closure
      closures[key] = value as DeploymentClosure;
    } else if (value && typeof value === 'object' && 'kind' in value && 'apiVersion' in value) {
      // This is an Enhanced<> resource
      resources[key] = value as Enhanced<any, any>;
    } else {
      // Unknown type, treat as resource for backward compatibility
      resources[key] = value as Enhanced<any, any>;
    }
  }

  return { resources, closures };
}

/**
 * Create a minimal stub resource object for factory calls that were detected
 * by AST analysis but didn't execute at runtime.
 *
 * This happens when a factory call is inside an if-branch that wasn't taken
 * because the schema proxy's `Symbol.toPrimitive` value didn't match the comparison.
 * The stub contains just enough info for YAML serialization to produce a valid
 * resource entry with includeWhen/forEach directives.
 */
function createStubResource(
  factoryName: string,
  resourceId: string
): Record<string, unknown> | null {
  const kindInfo = getKindInfo(factoryName);
  if (!kindInfo) return null;

  const stub: Record<string, unknown> = {
    apiVersion: kindInfo.apiVersion,
    kind: kindInfo.kind,
    metadata: { name: resourceId, labels: {} },
  };

  // Store resource ID in WeakMap metadata
  setResourceId(stub, resourceId);

  return stub;
}

// =============================================================================
// Re-exported helpers (canonical source: status-analysis-helpers.ts)
// =============================================================================

import {
  analyzeStatusMappingTypes,
  analyzeValueType,
  detectAndPreserveCelExpressions,
  isLikelyStaticObject,
  mergePreservedCelExpressions,
} from './status-analysis-helpers.js';

// =============================================================================
// Internal helpers exported for testing
// =============================================================================

/** @internal Exported for testing only */
export {
  separateResourcesAndClosures,
  createStubResource,
  detectAndPreserveCelExpressions,
  mergePreservedCelExpressions,
  analyzeStatusMappingTypes,
  analyzeValueType,
  isLikelyStaticObject,
  validateResourceGraphName,
  findResourceByKey,
  analyzeAndConvertStatusMappings,
  processCompositionBodyAnalysis,
  reanalyzeStatusForDirectFactory,
  wrapWithResourceGraphProxy,
};

export type { StatusAnalysisResult, CompositionBodyAnalysisResult };

// =============================================================================
// Extracted helper: Resource graph name validation
// =============================================================================

/**
 * Validate a resource graph name and return the Kubernetes-compatible form.
 *
 * @throws {ValidationError} if the name is empty, whitespace-only, not DNS-compliant,
 *   or exceeds the 253-character Kubernetes limit.
 * @returns The validated, lowercase-hyphenated Kubernetes name.
 *
 * @internal Exported for testing only
 */
function validateResourceGraphName(name: string | undefined | null): string {
  if (!name || typeof name !== 'string') {
    throw new ValidationError(
      `Invalid resource graph name: ${JSON.stringify(name)}. Resource graph name must be a non-empty string.`,
      'ResourceGraphDefinition',
      String(name),
      'name',
      ['Provide a non-empty string for the resource graph name']
    );
  }

  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new ValidationError(
      `Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`,
      'ResourceGraphDefinition',
      name,
      'name',
      ['Provide a non-whitespace resource graph name']
    );
  }

  const kubernetesName = trimmedName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
    throw new ValidationError(
      `Invalid resource graph name: "${name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
      'ResourceGraphDefinition',
      name,
      'name',
      [
        'Use lowercase alphanumeric characters and hyphens only',
        'Must start and end with an alphanumeric character',
      ]
    );
  }

  if (kubernetesName.length > 253) {
    throw new ValidationError(
      `Invalid resource graph name: "${name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`,
      'ResourceGraphDefinition',
      name,
      'name',
      ['Shorten the resource graph name to stay under 253 characters']
    );
  }

  return kubernetesName;
}

// =============================================================================
// Extracted helper: Resource key lookup (cross-composition access)
// =============================================================================

/**
 * Find a resource by key name in a resources map.
 *
 * Implements multiple matching strategies for cross-composition magic proxy
 * access (e.g. `composition.database`):
 * 1. Direct match by generated resource ID (exact)
 * 2. Smart pattern matching — name parts + kind-based (fuzzy, logged)
 * 3. Case-insensitive match on resource ID (fuzzy, logged)
 * 4. Partial matching — key parts contained in resource ID (fuzzy, logged)
 *
 * Strategies 2-4 emit a debug-level warning so users can diagnose unexpected
 * cross-composition references. Strategy 1 is the only silent/exact match.
 *
 * @internal Exported for testing only
 */
function findResourceByKey(
  key: string | symbol,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  logger?: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): KubernetesResource | undefined {
  if (typeof key !== 'string') return undefined;

  // Strategy 1: Direct match by generated resource ID (exact — no warning)
  if (resourcesWithKeys[key]) {
    return resourcesWithKeys[key];
  }

  // Strategy 2: Smart pattern matching for common cases
  const keyLower = key.toLowerCase();
  const keyParts = key.split(/[-_]/).map((p) => p.toLowerCase());

  for (const [resourceId, resource] of Object.entries(resourcesWithKeys)) {
    const kind = resource.kind.toLowerCase();
    let name = '';
    if (resource.metadata.name && typeof resource.metadata.name === 'string') {
      name = resource.metadata.name.toLowerCase();
    } else if (resource.metadata.name && typeof resource.metadata.name === 'object') {
      continue;
    }
    const resourceIdLower = resourceId.toLowerCase();

    const nameParts = name.split(/[-_]/).map((p) => p.toLowerCase());
    const hasCommonParts = keyParts.some((keyPart) =>
      nameParts.some((namePart) => keyPart.includes(namePart) || namePart.includes(keyPart))
    );

    if (hasCommonParts) {
      if (
        keyParts.includes(kind) ||
        (keyParts.includes('deployment') && kind === 'deployment') ||
        (keyParts.includes('service') && kind === 'service')
      ) {
        logger?.debug('findResourceByKey: fuzzy match (strategy 2: pattern+kind)', {
          requestedKey: key,
          matchedResourceId: resourceId,
          matchedKind: resource.kind,
        });
        return resource;
      }
    }

    if (keyParts.includes(kind)) {
      const nameInResourceId = nameParts.some((part) => resourceIdLower.includes(part));
      if (nameInResourceId) {
        logger?.debug('findResourceByKey: fuzzy match (strategy 2: kind+name)', {
          requestedKey: key,
          matchedResourceId: resourceId,
          matchedKind: resource.kind,
        });
        return resource;
      }
    }

    // Semantic alias matching — delegated to the central FactoryRegistry.
    // Custom factories can register their own aliases via registerFactory().
    for (const part of keyParts) {
      const candidateKinds = getSemanticCandidateKinds(part);
      if (candidateKinds?.includes(kind)) {
        logger?.debug('findResourceByKey: fuzzy match (strategy 2: semantic pattern)', {
          requestedKey: key,
          matchedResourceId: resourceId,
          matchedKind: resource.kind,
          semanticPattern: part,
        });
        return resource;
      }
    }
  }

  // Strategy 3: Case-insensitive match on generated resource ID
  for (const [resourceKey, resource] of Object.entries(resourcesWithKeys)) {
    if (resourceKey.toLowerCase() === keyLower) {
      logger?.debug('findResourceByKey: fuzzy match (strategy 3: case-insensitive)', {
        requestedKey: key,
        matchedResourceId: resourceKey,
        matchedKind: resource.kind,
      });
      return resource;
    }
  }

  // Strategy 4: Partial matching - find resources that contain key parts in their ID
  for (const [resourceKey, resource] of Object.entries(resourcesWithKeys)) {
    const resourceKeyLower = resourceKey.toLowerCase();
    if (keyParts.some((part) => part.length > 2 && resourceKeyLower.includes(part))) {
      logger?.debug('findResourceByKey: fuzzy match (strategy 4: partial key)', {
        requestedKey: key,
        matchedResourceId: resourceKey,
        matchedKind: resource.kind,
      });
      return resource;
    }
  }

  return undefined;
}

// =============================================================================
// Extracted helper: Status builder analysis and CEL conversion
// =============================================================================

/**
 * Result of analyzing and converting status builder output.
 *
 * @internal Exported for testing only
 */
interface StatusAnalysisResult {
  /** The status mapping values returned by the builder (raw, before conversion). */
  statusMappings: MagicAssignableShape<KroCompatibleType>;
  /** The final analyzed/converted status mappings (CEL expressions resolved). */
  analyzedStatusMappings: Record<string, unknown>;
  /** Field-level analysis of the status mappings. */
  mappingAnalysis: ReturnType<typeof analyzeStatusMappingTypes>;
  /** Whether imperative analysis succeeded and provided CEL expressions. */
  imperativeAnalysisSucceeded: boolean;
  /** Raw Phase B fn.toString results (before merge filtering). */
  phaseBStatusMappings?: Record<string, unknown> | undefined;
}

/**
 * Analyze a status builder function and convert JavaScript expressions to CEL.
 *
 * This encapsulates the full pipeline:
 * 1. Execute the status builder in a context that returns KubernetesRef objects
 * 2. If imperative, try status builder analysis or fall back to imperative analysis
 * 3. If declarative, analyze directly
 * 4. Detect and preserve existing CEL expressions
 * 5. Convert KubernetesRef objects to CEL via CelConversionEngine
 * 6. Log migration opportunities
 *
 * @internal Exported for testing only
 */
function analyzeAndConvertStatusMappings<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): StatusAnalysisResult {
  // Delegate to the decomposed pipeline (Phase 2.9).
  // The pipeline produces the same result shape as the original function.
  return runStatusAnalysisPipeline(
    definition,
    statusBuilder,
    schema,
    resourcesWithKeys,
    serializationLogger
  );
}

// =============================================================================
// Extracted helper: Composition body analysis (AST-based)
// =============================================================================

/**
 * Result of analyzing the composition function body for control flow patterns.
 *
 * @internal Exported for testing only
 */
interface CompositionBodyAnalysisResult {
  /** The analysis result from the composition body analyzer, or null if unavailable. */
  compositionAnalysis: ASTAnalysisResult | null;
  /**
   * Mutable flag tracking whether `applyAnalysisToResources` has been called.
   * Wrapped in an object so Biome doesn't hoist it to `const`.
   */
  analysisState: { appliedToResources: boolean; ternaryAndOmitApplied: boolean };
}

/**
 * Analyze the composition function body for control flow patterns
 * (if-statements -> includeWhen, for-of loops -> forEach, ternary -> template overrides,
 * collection aggregates -> status overrides).
 *
 * This MUST run before validation because:
 * 1. Stub resources need to exist before resource ID validation
 * 2. Status overrides (e.g. .map().join()) need to replace raw marker strings
 *    before CEL expression validation
 *
 * @internal Exported for testing only
 */
function processCompositionBodyAnalysis(
  statusMappings: Record<string, unknown> | MagicAssignableShape<KroCompatibleType>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  analyzedStatusMappings: Record<string, unknown>,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>,
  schemaDefinition?: { spec: { json?: unknown } }
): CompositionBodyAnalysisResult {
  let compositionAnalysis: ASTAnalysisResult | null = null;
  const analysisState = { appliedToResources: false, ternaryAndOmitApplied: false };

  const originalCompositionFnForAnalysis = (statusMappings as Record<string, unknown>)
    ?.__originalCompositionFn as ((...args: unknown[]) => unknown) | undefined;

  if (originalCompositionFnForAnalysis) {
    try {
      const resourceIds = new Set(Object.keys(resourcesWithKeys));
      const specJson = (schemaDefinition?.spec as { json?: unknown } | undefined)?.json as
        | { optional?: { key: string }[] }
        | undefined;
      const optionalFieldNames = specJson
        ? new Set((specJson.optional ?? []).map((p) => p.key))
        : undefined;
      compositionAnalysis = analyzeCompositionBody(
        originalCompositionFnForAnalysis,
        resourceIds,
        optionalFieldNames
      );

      // Differential execution to capture untaken-branch resources.
      //
      // When a composition uses plain JS control flow (`if (!spec.optional) { ... }`),
      // the truthy proxy pass takes the OPPOSITE branch because `!proxy === false`,
      // which means the resource inside the branch is never registered at runtime.
      // We re-execute the composition with optional fields set to `undefined`
      // (where `!undefined === true` triggers those branches) in an ISOLATED
      // composition context and merge any resources captured there into the main
      // resource map. The AST analyzer has already recorded the correct
      // `includeWhen` for each such resource, and `applyAnalysisToResources`
      // (called later during toYaml()) attaches that metadata — so the final
      // RGD emits the resource with a CEL `has()` / `!has()` conditional
      // derived from the composition's native `if`/`else` statements.
      //
      // Prerequisites: we need the schema definition to know which fields
      // are optional (so we set them to undefined) and which are required
      // (so we set them to a sentinel that prevents the composition from
      // dereferencing undefined). Both runs use the same composition
      // function, so resource IDs and factory calls are deterministic.
      //
      // SKIP when this composition is being executed as a nested call
      // (`context.isNestedCall === true`). The inner composition's own
      // definition-time pass already captured its hybrid-branch analysis
      // with the INNER schema proxy. Re-running that hybrid capture here —
      // against the fresh inner schema proxy that `captureHybridRunResources`
      // creates — would emit differential CEL conditionals that reference
      // inner-schema fields (e.g., `has(schema.spec.secretKeyRef)`) which
      // don't exist in the outer RGD. The outer composition is the
      // authority on branch conditions for its own calls; the inner's
      // branch shape is driven by what the outer passed in.
      const currentCtx = getCurrentCompositionContext();
      const skipHybridCapture = currentCtx?.isNestedCall === true;
      if (
        !skipHybridCapture &&
        schemaDefinition &&
        (compositionAnalysis.unregisteredFactories.length > 0 ||
          collectOverridableOptionalFields(schemaDefinition, compositionAnalysis).size > 0)
      ) {
        const { captured, overriddenFields } = captureHybridRunResources(
          originalCompositionFnForAnalysis,
          schemaDefinition,
          compositionAnalysis
        );

        // (a) Merge resources that exist ONLY in the hybrid run — these
        // come from branches the proxy run didn't take (e.g., `if (!spec.x)`).
        // The AST analyzer has already attached the appropriate includeWhen.
        for (const [id, resource] of Object.entries(captured)) {
          if (!resourceIds.has(id)) {
            resourcesWithKeys[id] = resource as Enhanced<unknown, unknown>;
            resourceIds.add(id);
            serializationLogger.debug('Captured resource from untaken branch', {
              resourceId: id,
            });
          }
        }

        // (b) For resources that exist in BOTH runs, walk them in parallel
        // and detect field-level differences. Each differing leaf becomes
        // a CEL `has(...) ? <proxy value> : <hybrid value>` conditional
        // applied in place on the proxy-run resource. This covers the
        // "ternary inside a custom factory's internal transformation" case
        // where the AST analyzer can't see the final template path, since
        // the comparison works on the emitted resource structure directly.
        //
        // MUTATION SAFETY: this step replaces LEAF values (strings, numbers,
        // KubernetesRef proxies) inside the proxy-run resources with CEL
        // conditional strings. It runs after status analysis has captured
        // its own references (so status builders see the pre-mutation state)
        // and before YAML serialization (so the mutated state is what gets
        // emitted). The tree structure is preserved; only leaves change.
        // `processCompositionBodyAnalysis` is called exactly once per
        // `toResourceGraph` invocation, and the walk itself is idempotent
        // (a second pass finds `leafEquals` true for every leaf and no-ops),
        // so multiple `toYaml()` calls on the resulting TypedResourceGraph
        // all see a consistent final state.
        if (overriddenFields.size > 0) {
          for (const id of Object.keys(resourcesWithKeys)) {
            const proxyRes = resourcesWithKeys[id] as unknown as Record<string, unknown>;
            const hybridRes = captured[id] as unknown as Record<string, unknown> | undefined;
            if (proxyRes && hybridRes) {
              applyDifferentialFieldConditionals(proxyRes, hybridRes, overriddenFields);
            }
          }
        }
      }

      // Create stub resources for factory calls that STILL weren't registered
      // (e.g., branches the differential run also didn't take because they
      // required a different condition to be truthy).
      for (const unregistered of compositionAnalysis.unregisteredFactories) {
        if (!resourceIds.has(unregistered.resourceId)) {
          const stub = createStubResource(unregistered.factoryName, unregistered.resourceId);
          if (stub) {
            resourcesWithKeys[unregistered.resourceId] = stub as Enhanced<unknown, unknown>;
            resourceIds.add(unregistered.resourceId);
            serializationLogger.debug('Created stub resource for unregistered factory', {
              resourceId: unregistered.resourceId,
              factoryName: unregistered.factoryName,
            });
          }
        }
      }

      // Apply status overrides before validation
      if (compositionAnalysis.statusOverrides.length > 0) {
        for (const override of compositionAnalysis.statusOverrides) {
          analyzedStatusMappings[override.propertyPath] = override.celExpression;
          serializationLogger.debug('Applied status override before validation', {
            propertyPath: override.propertyPath,
            celExpression: override.celExpression,
          });
        }
      }
    } catch (analysisError: unknown) {
      serializationLogger.debug(
        'Composition body analysis failed (non-fatal), proceeding without control flow detection',
        { error: ensureError(analysisError).message }
      );
    }
  }

  return { compositionAnalysis, analysisState };
}

/**
 * Collect the top-level optional spec fields that should be overridden
 * when running the composition for differential branch/field capture.
 *
 * We only override fields that the AST analyzer observed being TESTED
 * in a condition — `if (spec.x)`, `spec.x ? a : b`, or similar.
 * Overriding fields that the composition only READS unconditionally
 * (e.g., `spec.server.secret_key` inside a ConfigMap's stringData) is
 * counterproductive: it would replace those proxy references with
 * `undefined` in the hybrid run, producing incorrect captured
 * resources.
 *
 * The tested fields are extracted from the AST analyzer's recorded
 * `includeWhen` expressions (which, after the `conditionToCel` fix,
 * wrap bare truthiness checks with `has(...)`) by scanning for
 * `schema.spec.<field>` paths.
 */
function collectOverridableOptionalFields(
  schemaDefinition: { spec: { json?: unknown } },
  analysis: ASTAnalysisResult
): Set<string> {
  const specJson = schemaDefinition.spec.json as
    | { optional?: { key: string }[] }
    | undefined;
  if (!specJson) return new Set();
  const optionalFields = new Set((specJson.optional ?? []).map((p) => p.key));

  const testedFields = new Set<string>();
  // Pull field names from every includeWhen condition the AST analyzer
  // attached to a resource (including resources that were never
  // runtime-registered because their branch wasn't taken).
  for (const entry of analysis.resources.values()) {
    for (const cond of entry.includeWhen) {
      const matches = cond.expression.matchAll(/schema\.spec\.([A-Za-z_$][\w$]*)/g);
      for (const m of matches) {
        const field = m[1];
        if (field && optionalFields.has(field)) {
          testedFields.add(field);
        }
      }
    }
  }
  return testedFields;
}

/**
 * Re-execute the composition function in an isolated composition context
 * with a HYBRID schema spec — the original schema proxy for most fields
 * (so `spec.name`, `spec.server.secret_key`, etc. still produce
 * `KubernetesRef` proxy values that serialize into CEL references) but
 * with specific top-level optional fields overridden to `undefined` so
 * that `if (!spec.x)`, `if (spec.x === undefined)`, and similar
 * field-presence tests take the opposite branch from the proxy run.
 *
 * Used by {@link processCompositionBodyAnalysis} to capture BOTH:
 *   (a) resources registered inside branches that the main proxy run
 *       skipped because `!proxy === false`
 *   (b) resources that exist in both runs but with field-level
 *       differences caused by ternary/fallback logic that depends on
 *       the overridden fields — used for differential CEL conditional
 *       emission by {@link applyDifferentialFieldConditionals}
 *
 * The branches run with real proxy values for every field EXCEPT the
 * overridden ones, so the captured resources contain the correct CEL
 * references just like the proxy-run resources.
 *
 * Composition functions with external side effects will fire those
 * effects a second time during this re-execution — see integration-skill
 * rule #30 for the full contract.
 */
function captureHybridRunResources(
  compositionFn: (...args: unknown[]) => unknown,
  schemaDefinition: { spec: { json?: unknown } },
  analysis: ASTAnalysisResult
): {
  captured: Record<string, Enhanced<any, any>>;
  overriddenFields: Set<string>;
} {
  try {
    const overriddenFields = collectOverridableOptionalFields(schemaDefinition, analysis);
    if (overriddenFields.size === 0) return { captured: {}, overriddenFields };

    // Build the hybrid spec: the real schema proxy (so all other field
    // accesses produce KubernetesRef values) wrapped in a Proxy that
    // intercepts the overridden keys and returns `undefined`. Accessing
    // an overridden key's sub-property (e.g., `spec.secretKeyRef.name`)
    // will throw — but that's exactly the code path the override is
    // meant to skip, so the thrown access lives inside the `else`
    // branch that this run intentionally does not execute.
    const realSchema = createSchemaProxy<KroCompatibleType, KroCompatibleType>();
    const hybridSpec = new Proxy(realSchema.spec as object, {
      get(target, prop: string | symbol, receiver) {
        if (typeof prop === 'string' && overriddenFields.has(prop)) {
          return undefined;
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop: string | symbol) {
        if (typeof prop === 'string' && overriddenFields.has(prop)) {
          return false;
        }
        return Reflect.has(target, prop);
      },
    });

    const tempCtx = createCompositionContext('hybrid-capture');
    runWithCompositionContext(tempCtx, () => {
      compositionFn(hybridSpec);
    });
    return {
      captured: tempCtx.resources as Record<string, Enhanced<any, any>>,
      overriddenFields,
    };
  } catch {
    // Best-effort: compositions that throw when running with a hybrid spec
    // degrade gracefully — stub resources still cover the missing factories
    // and the proxy-run resources are used as-is.
    return { captured: {}, overriddenFields: new Set() };
  }
}

/**
 * Walk `proxyRes` and `hybridRes` in parallel and replace any leaf value
 * in `proxyRes` that differs from the corresponding leaf in `hybridRes`
 * with a CEL `has(...) ? <proxy value> : <hybrid value>` conditional.
 *
 * This is how differential field-level branch detection works: when a
 * composition writes `spec.x ? foo(spec.y) : bar()` at a deep nested
 * location inside a custom factory's emitted resource, the proxy run
 * produces one leaf and the hybrid run (with `spec.x` overridden to
 * `undefined`) produces the other. Comparing the two resource trees
 * field-by-field surfaces the divergence and lets us emit the correct
 * KRO CEL conditional without needing to thread AST information through
 * the factory's internal transformations.
 *
 * Assumptions and caveats:
 *   - Both resources come from the same factory call with the same
 *     resource ID, so their structures are shape-compatible.
 *   - The `overriddenFields` set drives the `has(...)` check — with a
 *     single overridden field we can emit a direct `has(schema.spec.X)`
 *     test. With multiple fields, we use the first one that appears in
 *     either leaf value; this is a heuristic, but in practice
 *     compositions rarely have multiple optional fields driving the
 *     same leaf.
 *   - Marker strings (`__KUBERNETES_REF__...__`) and CEL expressions
 *     are converted to their dollar-wrapped forms before embedding in
 *     the conditional.
 */
function applyDifferentialFieldConditionals(
  proxyRes: Record<string, unknown>,
  hybridRes: Record<string, unknown>,
  overriddenFields: Set<string>
): void {
  walkAndConditionalize(proxyRes, hybridRes, overriddenFields);
}

function walkAndConditionalize(
  proxy: unknown,
  hybrid: unknown,
  overriddenFields: Set<string>
): unknown {
  if (Array.isArray(proxy) && Array.isArray(hybrid)) {
    const maxLen = Math.max(proxy.length, hybrid.length);
    for (let i = 0; i < maxLen; i++) {
      const p = proxy[i];
      const h = hybrid[i];
      if (i >= proxy.length) {
        // New element added by hybrid run — copy it over.
        proxy.push(h);
        continue;
      }
      if (i >= hybrid.length) {
        // Element removed in hybrid — leave the proxy value as-is.
        continue;
      }
      if (isLeafValue(p) && isLeafValue(h)) {
        if (!leafEquals(p, h)) {
          proxy[i] = buildCelConditional(p, h, overriddenFields);
        }
      } else {
        walkAndConditionalize(p, h, overriddenFields);
      }
    }
    return proxy;
  }

  if (isPlainObject(proxy) && isPlainObject(hybrid)) {
    const keys = new Set([...Object.keys(proxy), ...Object.keys(hybrid)]);
    for (const key of keys) {
      const p = (proxy as Record<string, unknown>)[key];
      const h = (hybrid as Record<string, unknown>)[key];
      if (!(key in (hybrid as Record<string, unknown>))) {
        continue; // Proxy has it, hybrid doesn't — keep proxy value
      }
      if (!(key in (proxy as Record<string, unknown>))) {
        (proxy as Record<string, unknown>)[key] = h;
        continue;
      }
      if (isLeafValue(p) && isLeafValue(h)) {
        if (!leafEquals(p, h)) {
          (proxy as Record<string, unknown>)[key] = buildCelConditional(
            p,
            h,
            overriddenFields
          );
        }
      } else {
        walkAndConditionalize(p, h, overriddenFields);
      }
    }
    return proxy;
  }

  return proxy;
}

function isLeafValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    // KubernetesRef proxies register as functions (typeof fn is 'function')
    typeof v === 'function'
  );
}

function leafEquals(a: unknown, b: unknown): boolean {
  // For KubernetesRef proxies, compare their string coercions (marker tokens).
  if (typeof a === 'function' || typeof b === 'function') {
    return String(a) === String(b);
  }
  return a === b;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build a CEL conditional string from two diverging leaf values.
 *
 * Both values may be concrete primitives, marker strings (from template
 * literals containing proxy references), or KubernetesRef proxies. The
 * returned string is a KRO mixed-template value like
 * `${has(schema.spec.X) ? <proxy repr> : <hybrid repr>}` that later
 * serialization phases treat as a final CEL expression.
 */
function buildCelConditional(
  proxyValue: unknown,
  hybridValue: unknown,
  overriddenFields: Set<string>
): string {
  const field = pickConditionField(proxyValue, hybridValue, overriddenFields);
  const proxyRepr = celValueRepr(proxyValue);
  const hybridRepr = celValueRepr(hybridValue);
  return `\${has(schema.spec.${field}) ? ${proxyRepr} : ${hybridRepr}}`;
}

/**
 * Pick the "controlling" optional field for a diverging leaf. If exactly
 * one overridden field's marker appears in either value, use that. If
 * neither appears explicitly, default to the first field in the set —
 * this covers the common case of a single overridden field driving the
 * whole divergence.
 */
function pickConditionField(
  proxyValue: unknown,
  hybridValue: unknown,
  overriddenFields: Set<string>
): string {
  const proxyStr = String(proxyValue);
  const hybridStr = String(hybridValue);
  for (const field of overriddenFields) {
    const marker = `__KUBERNETES_REF___schema___spec.${field}`;
    if (proxyStr.includes(marker) || hybridStr.includes(marker)) {
      return field;
    }
  }
  // Fallback: first overridden field (iteration order = insertion order).
  // Single-field overrides are the common case so this is usually correct;
  // the explicit-marker check above handles the multi-field case. When the
  // fallback fires, the emitted CEL may pick the wrong `has()` condition
  // for compositions with multiple optional fields driving the same leaf —
  // log it at debug level so the case is diagnosable if anyone reports
  // incorrect CEL output.
  const fallback = overriddenFields.values().next().value ?? '';
  getComponentLogger('serialization').debug(
    'pickConditionField fallback: no marker matched, using first overridden field',
    {
      fallbackField: fallback,
      overriddenFields: Array.from(overriddenFields),
      proxyValuePreview: proxyStr.slice(0, 120),
      hybridValuePreview: hybridStr.slice(0, 120),
    }
  );
  return fallback;
}

/**
 * Convert a leaf value into its CEL expression representation.
 *
 * - Marker strings become `schema.spec.X` paths (bare, no `${}`)
 * - KubernetesRef proxies become their inner CEL path
 * - String literals become double-quoted CEL string literals (with
 *   embedded markers converted to string() concatenations so the
 *   result is valid CEL, not just a raw string)
 * - Numbers and booleans are emitted verbatim
 */
/**
 * Escape a string literal for safe embedding inside a CEL string.
 * Handles backslash, double-quote, newline, carriage return, and tab.
 * Must be used everywhere we embed literal text in CEL output.
 */
function escapeCelLiteral(literal: string): string {
  return literal
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function celValueRepr(value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') {
    // KubernetesRef proxy — toString yields the marker token which we
    // convert to a bare CEL path via the marker → CEL rules.
    return markerStringToCelBare(String(value));
  }
  if (typeof value === 'string') {
    if (value.includes('__KUBERNETES_REF_')) {
      return markerStringToCelExpr(value);
    }
    // Plain string literal — escape for CEL embedding
    return `"${escapeCelLiteral(value)}"`;
  }
  return '""';
}

/**
 * Convert a single-marker string (the whole string is one marker) to
 * its bare CEL path form: `schema.spec.X` or `resources.X.field`.
 */
function markerStringToCelBare(str: string): string {
  const m = str.match(/^__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__$/);
  if (!m) return markerStringToCelExpr(str);
  const [, resourceId, fieldPath] = m;
  return resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
}

/**
 * Convert a mixed string containing literal text and markers to a CEL
 * concatenation expression using `string()` wrappers, suitable for
 * embedding inside a CEL ternary.
 */
function markerStringToCelExpr(str: string): string {
  // Fast path: whole string is a single marker
  const singleMatch = str.match(/^__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__$/);
  if (singleMatch) {
    const [, resourceId, fieldPath] = singleMatch;
    return resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
  }

  // Slow path: interleave literal text and markers via CEL string concatenation
  const parts: string[] = [];
  let lastIndex = 0;
  const pattern = /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g;
  let m: RegExpExecArray | null = pattern.exec(str);
  while (m !== null) {
    if (m.index > lastIndex) {
      const literal = str.slice(lastIndex, m.index);
      parts.push(`"${escapeCelLiteral(literal)}"`);
    }
    const resourceId = m[1]!;
    const fieldPath = m[2]!;
    const celPath =
      resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
    parts.push(`string(${celPath})`);
    lastIndex = m.index + m[0].length;
    m = pattern.exec(str);
  }
  if (lastIndex < str.length) {
    const literal = str.slice(lastIndex);
    parts.push(`"${escapeCelLiteral(literal)}"`);
  }
  return parts.length === 1 ? parts[0]! : parts.join(' + ');
}

// =============================================================================
// Extracted helper: Direct factory status re-analysis
// =============================================================================

/**
 * Re-analyze status mappings specifically for the direct factory pattern.
 *
 * When the factory mode is `'direct'`, the status mappings may need different
 * treatment than the Kro pattern (which is the default analysis target).
 *
 * @internal Exported for testing only
 */
function reanalyzeStatusForDirectFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  analysisResults: {
    hasKubernetesRefs: boolean;
    statusMappings: MagicAssignableShape<KroCompatibleType>;
  },
  analyzedStatusMappings: Record<string, unknown>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  schema: SchemaProxy<TSpec, TStatus>,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): Record<string, unknown> {
  if (!analysisResults.hasKubernetesRefs) {
    return analyzedStatusMappings;
  }

  try {
    serializationLogger.debug('Re-analyzing status mappings for direct factory pattern');
    const directStatusAnalyzer = new StatusBuilderAnalyzer(undefined, {
      factoryType: 'direct',
      performOptionalityAnalysis: true,
      includeSourceMapping: true,
    });
    const directAnalysisResult = directStatusAnalyzer.analyzeReturnObjectWithMagicProxy(
      analysisResults.statusMappings,
      resourcesWithKeys,
      schema
    );

    if (directAnalysisResult.errors.length === 0) {
      const { preservedMappings: directPreservedMappings } = detectAndPreserveCelExpressions(
        analysisResults.statusMappings as Record<string, unknown>
      );
      const result = mergePreservedCelExpressions(
        directAnalysisResult.statusMappings,
        directPreservedMappings
      );
      serializationLogger.debug('Successfully re-analyzed status mappings for direct factory');
      return result;
    }
  } catch (error: unknown) {
    serializationLogger.error(
      'Failed to re-analyze status mappings for direct factory, using default analysis',
      ensureError(error)
    );
  }

  return analyzedStatusMappings;
}

// =============================================================================
// Extracted helper: Cross-composition magic proxy
// =============================================================================

/**
 * Wrap a base resource graph object with a Proxy that enables cross-composition
 * resource access (e.g. `composition.database`).
 *
 * The Proxy intercepts property access for unknown keys and delegates to
 * `findResourceByKey` to locate matching resources, then creates an external
 * ref for them.
 *
 * @internal Exported for testing only
 */
function wrapWithResourceGraphProxy<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  baseResourceGraph: TypedResourceGraph<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  logger?: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): TypedResourceGraph<TSpec, TStatus> {
  return new Proxy(baseResourceGraph, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      const matchingResource = findResourceByKey(prop, resourcesWithKeys, logger);
      if (matchingResource?.metadata.name) {
        return createExternalRefWithoutRegistration(
          matchingResource.apiVersion,
          matchingResource.kind,
          matchingResource.metadata.name,
          matchingResource.metadata.namespace
        );
      }

      return undefined;
    },

    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }

      const matchingResource = findResourceByKey(prop, resourcesWithKeys, logger);
      if (matchingResource) {
        return {
          configurable: true,
          enumerable: false,
          value: undefined,
        };
      }

      return undefined;
    },
  }) as TypedResourceGraph<TSpec, TStatus>;
}

// =============================================================================
// NEW FACTORY PATTERN API
// =============================================================================
/**
 * Create a typed ResourceGraphDefinition (RGD) from a declarative definition,
 * a resource builder, and a status builder.
 *
 * This is the primary API for defining Kubernetes compositions in TypeKro.
 * The returned object contains the serialized YAML for the RGD and can be
 * deployed via `deploy()` in both Direct and Kro modes.
 *
 * @typeParam TSpec - The arktype schema for the custom resource's spec
 * @typeParam TStatus - The arktype schema for the custom resource's status
 * @typeParam TResources - The shape of resources returned by the resource builder
 *
 * @param definition - The RGD metadata: name, apiVersion, kind, spec schema, status schema
 * @param resourceBuilder - Function receiving a schema proxy, returns Kubernetes resources
 * @param statusBuilder - Function receiving schema proxy + resources, returns status shape
 * @param options - Optional serialization options (e.g., custom CEL prefix)
 * @returns A `TypedResourceGraph` containing the serialized RGD and deploy/toYaml methods
 *
 * @example
 * ```typescript
 * const webapp = toResourceGraph(
 *   {
 *     name: 'webapp',
 *     apiVersion: 'apps.example.com/v1alpha1',
 *     kind: 'WebApp',
 *     spec: type({ name: 'string', replicas: 'number' }),
 *     status: type({ ready: 'boolean', url: 'string' }),
 *   },
 *   (schema) => ({
 *     deploy: Deployment({ name: schema.spec.name, replicas: schema.spec.replicas }),
 *     svc: Service({ name: schema.spec.name }),
 *   }),
 *   (schema, resources) => ({
 *     ready: Cel.expr<boolean>(resources.deploy.status.readyReplicas, ' > 0'),
 *     url: Cel.template('https://%s', schema.spec.name),
 *   }),
 * );
 * ```
 */
export function toResourceGraph<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  // This new generic captures the exact shape of your resources - can be Enhanced<> resources or DeploymentClosures
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  // The resourceBuilder is now defined as returning that specific shape
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  // The statusBuilder is now defined as ACCEPTING that specific shape
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus> {
  // The implementation in createTypedResourceGraph must also be updated to match this signature.
  return createTypedResourceGraph(definition, resourceBuilder, statusBuilder, options);
}

/**
 * Create a typed resource graph implementation.
 *
 * Orchestrates the full pipeline:
 * 1. Validate definition name
 * 2. Execute resource builder to get Enhanced<> resources and closures
 * 3. Analyze status builder and convert JS expressions to CEL
 * 4. Analyze composition body for control flow (includeWhen/forEach)
 * 5. Validate and optimize CEL expressions
 * 6. Build the TypedResourceGraph result object
 * 7. Wrap with cross-composition magic proxy
 */
function createTypedResourceGraph<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  resourceBuilder: (schema: SchemaProxy<TSpec, TStatus>) => TResources,
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus> {
  const serializationLogger = getComponentLogger('resource-graph-serialization').child({
    name: definition.name,
  });

  // 1. Validate name
  validateResourceGraphName(definition.name);

  // 2. Build schema definition and execute resource builder
  const schemaDefinition: SchemaDefinition<TSpec, TStatus> = {
    apiVersion: definition.apiVersion || 'v1alpha1',
    kind: definition.kind,
    spec: definition.spec,
    status: definition.status,
  };

  const schema = createSchemaProxy<TSpec, TStatus>();
  const builderResult = resourceBuilder(schema);
  const { resources: resourcesWithKeys, closures } = separateResourcesAndClosures(builderResult);

  // 3. Analyze status builder and convert JS expressions to CEL
  const { statusMappings, analyzedStatusMappings, mappingAnalysis, phaseBStatusMappings } =
    analyzeAndConvertStatusMappings(
      definition,
      statusBuilder,
      schema,
      resourcesWithKeys,
      serializationLogger
    );

  // 4. Analyze composition body for control flow patterns (must run before validation)
  const { compositionAnalysis, analysisState } = processCompositionBodyAnalysis(
    statusMappings,
    resourcesWithKeys,
    analyzedStatusMappings,
    serializationLogger,
    schemaDefinition as unknown as { spec: { json?: unknown } }
  );

  // 5. Validate resource IDs and CEL expressions
  const validation = validateResourceGraphDefinition(resourcesWithKeys, analyzedStatusMappings);
  if (!validation.isValid) {
    const errorMessages = validation.errors.map((err) => `${err.field}: ${err.error}`).join('\n');
    throw new ValidationError(
      `ResourceGraphDefinition validation failed:\n${errorMessages}`,
      'ResourceGraphDefinition',
      definition.name,
      undefined,
      ['Fix the validation errors listed above']
    );
  }

  if (validation.warnings.length > 0) {
    serializationLogger.warn('ResourceGraphDefinition validation warnings', {
      warnings: validation.warnings.map((w) => ({
        field: w.field,
        error: w.error,
        suggestion: w.suggestion,
      })),
    });
  }

  // Evaluate and optimize CEL expressions
  const evaluationContext = { resources: resourcesWithKeys, schema };
  const { mappings: optimizedStatusMappings, optimizations } = optimizeStatusMappings(
    analyzedStatusMappings,
    evaluationContext
  );

  if (optimizations.length > 0) {
    serializationLogger.info('CEL expression optimizations applied', { optimizations });
  }

  // 6. Build the composition re-execution function for direct factory
  const declarativeCompositionFn = (spec: TSpec): MagicAssignableShape<TStatus> => {
    const actualSchema = { spec, status: {} } as SchemaProxy<TSpec, TStatus>;
    const resources = resourceBuilder(actualSchema);
    return statusBuilder(actualSchema, resources);
  };

  // 7. Assemble the TypedResourceGraph result object
  const uniqueResourcesSet = new Set(Object.values(resourcesWithKeys));

  const baseResourceGraph = {
    name: definition.name,
    resources: Array.from(uniqueResourcesSet),
    schema,
    closures,
    _compositionFn: declarativeCompositionFn,
    _definition: definition,
    _analysisResults: {
      mappingAnalysis,
      hasKubernetesRefs: mappingAnalysis.kubernetesRefFields.length > 0,
      statusMappings,
      analyzedStatusMappings,
      phaseBStatusMappings,
    },

    factory(
      mode: 'kro' | 'direct',
      factoryOptions?: PublicFactoryOptions
    ): KroResourceFactory<TSpec, TStatus> | DirectResourceFactory<TSpec, TStatus> {
      if (mode === 'direct') {
        const directStatusMappings = reanalyzeStatusForDirectFactory(
          this._analysisResults,
          analyzedStatusMappings,
          resourcesWithKeys,
          schema,
          serializationLogger
        );

        return createDirectResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          statusBuilder,
          {
            ...factoryOptions,
            closures,
            statusMappings: directStatusMappings,
            compositionFn: declarativeCompositionFn,
            compositionDefinition: definition,
          }
        );
      } else if (mode === 'kro') {
        return createKroResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          analyzedStatusMappings,
          {
            ...factoryOptions,
            closures,
            factoryType: 'kro',
            compositionFn: declarativeCompositionFn,
          }
        );
      } else {
        throw new ValidationError(
          `Unsupported factory mode: ${mode}`,
          'ResourceGraphDefinition',
          definition.name,
          'mode',
          ['Use "kro" or "direct" as the factory mode']
        );
      }
    },

    toYaml(): string {
      // Apply composition body analysis results (guard: only once)
      if (compositionAnalysis && !analysisState.appliedToResources) {
        analysisState.appliedToResources = true;
        if (
          compositionAnalysis.resources.size > 0 ||
          compositionAnalysis.templateOverrides.size > 0
        ) {
          applyAnalysisToResources(resourcesWithKeys, compositionAnalysis);
          serializationLogger.debug('Applied composition body analysis', {
            analyzedResources: compositionAnalysis.resources.size,
            templateOverrides: compositionAnalysis.templateOverrides.size,
            errors: compositionAnalysis.errors.length,
          });
        }
      }

      // Collect nested composition status CEL mappings from the composition context.
      // These enable inlining the inner composition's real CEL expressions instead
      // of referencing virtual nested composition IDs.
      // Extract nested composition status CEL mappings attached by
      // executeCompositionCore via Reflect.set. Must use
      // Object.getOwnPropertyDescriptor to bypass the Enhanced proxy's
      // get handler which would return a KubernetesRef instead of the
      // actual Record<string, string>.
      const nestedStatusDescriptor = Object.getOwnPropertyDescriptor(statusMappings, '__nestedStatusCel');
      const nestedStatusCel: Record<string, string> =
        (nestedStatusDescriptor?.value as Record<string, string>) ?? {};

      serializationLogger.debug('Nested status CEL extraction', {
        hasNestedStatusCel: Object.keys(nestedStatusCel).length > 0,
        keys: Object.keys(nestedStatusCel),
        statusMappingsHasField: '__nestedStatusCel' in (statusMappings as Record<string, unknown>),
      });

      const kroSchema = generateKroSchemaFromArktype(
        definition.name,
        schemaDefinition,
        resourcesWithKeys,
        optimizedStatusMappings,
        Object.keys(nestedStatusCel).length > 0 ? nestedStatusCel : undefined
      );

      if (definition.group) {
        kroSchema.group = definition.group;
      }

      // Attach nested status CEL mappings to the schema as a non-enumerable
      // property (same pattern as __ternaryConditionals, __omitFields).
      // Non-enumerable so it doesn't appear in the YAML output, but
      // accessible via KroSimpleSchemaWithMetadata for the YAML serializer
      // to resolve virtual composition IDs in resource templates.
      if (Object.keys(nestedStatusCel).length > 0) {
        Object.defineProperty(kroSchema, '__nestedStatusCel', {
          value: nestedStatusCel,
          enumerable: false,
        });
      }

      // Inject status overrides into schema status section.
      // Convert "..." to '...' in CEL string literals for YAML compatibility.
      const statusOverrides = compositionAnalysis?.statusOverrides ?? [];
      if (statusOverrides.length > 0) {
        if (!kroSchema.status) {
          kroSchema.status = {};
        }
        for (const override of statusOverrides) {
          const yamlSafe = override.celExpression.replace(/"([^"\\]*)"/g, "'$1'");
          kroSchema.status[override.propertyPath] = yamlSafe;
        }
      }

      // Apply ternary conditionals (once only — guard prevents
      // double-processing if toYaml() is called multiple times).
      // Note: omit() wrapping for optional fields is no longer a
      // post-processing step — it's applied inline during ref-to-CEL
      // conversion via `SerializationContext.omitFields`, which reads
      // from `kroSchema.__omitFields` inside `serializeResourceGraphToYaml`.
      if (!analysisState.ternaryAndOmitApplied) {
        analysisState.ternaryAndOmitApplied = true;

        if (kroSchema.__ternaryConditionals?.length) {
          applyTernaryConditionalsToResources(resourcesWithKeys, kroSchema.__ternaryConditionals);
        }
      }

      return serializeResourceGraphToYaml(definition.name, resourcesWithKeys, options, kroSchema);
    },
  };

  // 8. Wrap with cross-composition magic proxy
  return wrapWithResourceGraphProxy(
    baseResourceGraph as TypedResourceGraph<TSpec, TStatus>,
    resourcesWithKeys,
    serializationLogger
  );
}
