/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */

import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_MARKER_SOURCE } from '../../shared/brands.js';
import type { ToYamlOptions } from '../aspects/types.js';
import {
  createCompositionContext,
  getCurrentCompositionContext,
  runInStatusBuilderContext,
  runWithCompositionContext,
} from '../composition/context.js';
import { createDirectResourceFactory } from '../deployment/direct-factory.js';
import { createKroResourceFactory } from '../deployment/kro-factory.js';
import { ensureError, ValidationError } from '../errors.js';
import {
  type ASTAnalysisResult,
  analyzeCompositionBody,
  applyAnalysisToResources,
} from '../expressions/composition/composition-analyzer.js';
import { remapResourceStatusReferences } from '../expressions/composition/composition-analyzer-helpers.js';
import { StatusBuilderAnalyzer } from '../expressions/factory/status-builder-analyzer.js';
import { getComponentLogger } from '../logging/index.js';
import { getMetadataField, setResourceId } from '../metadata/index.js';
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
  SerializationContext,
  SerializationOptions,
} from '../types/serialization.js';
import type { Enhanced, KroCompatibleType, KubernetesResource } from '../types.js';
import { validateResourceGraphDefinition } from '../validation/cel-validator.js';
import { optimizeStatusMappings } from './cel-optimizer.js';
import { finalizeCelForKro } from './cel-references.js';
import { applyTernaryConditionalsToResources } from './kro-post-processing.js';
import { generateKroSchemaFromArktype } from './schema.js';
import { runStatusAnalysisPipeline } from './status-analysis-pipeline.js';
import { serializeResourceGraphToYaml } from './yaml.js';

function isToYamlOptions(value: unknown): value is ToYamlOptions {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'aspects')) {
    return false;
  }
  const aspects = (value as { aspects?: unknown }).aspects;
  if (!Array.isArray(aspects)) return false;
  // Empty arrays remain render options for the established `toYaml({ aspects: [] })`
  // API only when `aspects` is the whole object. Non-empty arrays must contain
  // aspect descriptors so CRD specs with unrelated `aspects` arrays are not
  // accidentally interpreted as render options.
  if (aspects.length === 0) return Object.keys(value).length === 1;
  return aspects.every(
    (entry) =>
      typeof entry === 'object' && entry !== null && (entry as { kind?: unknown }).kind === 'aspect'
  );
}

/**
 * Separate Enhanced<> resources from deployment closures in the builder result
 */
function separateResourcesAndClosures<
  T extends Record<string, Enhanced<unknown, unknown> | DeploymentClosure>,
>(
  builderResult: T
): {
  resources: Record<string, Enhanced<unknown, unknown>>;
  closures: Record<string, DeploymentClosure>;
} {
  const resources: Record<string, Enhanced<unknown, unknown>> = {};
  const closures: Record<string, DeploymentClosure> = {};

  for (const [key, value] of Object.entries(builderResult)) {
    if (typeof value === 'function') {
      // This is a deployment closure
      closures[key] = value as DeploymentClosure;
    } else if (value && typeof value === 'object' && 'kind' in value && 'apiVersion' in value) {
      // This is an Enhanced<> resource
      resources[key] = value as Enhanced<unknown, unknown>;
    } else {
      // Unknown type, treat as resource for backward compatibility
      resources[key] = value as Enhanced<unknown, unknown>;
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
  resourcesWithKeys: Record<string, Enhanced<unknown, unknown>>,
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
  TResources extends Record<string, Enhanced<unknown, unknown> | DeploymentClosure>,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<unknown, unknown>>,
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
  resourcesWithKeys: Record<string, Enhanced<unknown, unknown>>,
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
      const specJson = (schemaDefinition?.spec as { json?: unknown } | undefined)?.json;
      const optionalFieldNames = specJson ? collectOptionalSpecPaths(specJson) : undefined;
      const nestedStatusDescriptor = Object.getOwnPropertyDescriptor(
        statusMappings,
        '__nestedStatusCel'
      );
      const nestedStatusCel = nestedStatusDescriptor?.value as Record<string, string> | undefined;
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
      // ── Resource-status ternary compilation (Phases 3+4) ────────────
      //
      // When the AST detects ternaries conditioned on resource status
      // fields (e.g., `cache.status.ready ? 'redis' : 'memory'`), proxy
      // JS evaluation does not necessarily match CEL truth evaluation.
      // To emit the CEL conditional, re-execute explicit true and false
      // branches using `liveStatusMap`, then diff those branch outputs.
      //
      // To avoid false positives (other fields changing due to the status
      // flip), direct factory calls diff only `callSiteResourceId`; nested
      // composition call arguments diff only resources registered under known
      // nested composition base IDs.
      const resourceStatusTernaries = compositionAnalysis.resourceStatusTernaries;

      // Deduplicate by call site and condition. Conditionalization is scoped to
      // one callSiteResourceId, so two resources using the same status condition
      // must both be processed.
      const seenConditions = new Set<string>();
      const uniqueTernaries = resourceStatusTernaries.filter((t) => {
        const key = `${t.callSiteResourceId}:${t.variableName}:${t.conditionExpression ?? t.statusField}`;
        if (seenConditions.has(key)) return false;
        seenConditions.add(key);
        return true;
      });

      // Process EACH resource-status ternary independently to avoid
      // cross-contamination: flip ONE condition → run → diff → apply.
      // Multiple ternaries on the same resource get independent conditionals.
      for (const ternary of uniqueTernaries) {
        const resId =
          compositionAnalysis.variableToResourceId.get(ternary.variableName) ??
          ternary.variableName;
        if (!resourceIds.has(resId)) continue;

        const conditionCel = ternary.conditionExpression
          ? remapResourceStatusReferences(
              ternary.conditionExpression,
              new Map(compositionAnalysis.variableToResourceId).set(ternary.variableName, resId)
            )
          : `${resId}.status.${ternary.statusField}`;

        const trueCtx = runResourceStatusBranch(
          originalCompositionFnForAnalysis,
          schemaDefinition,
          compositionAnalysis,
          ternary,
          true
        );
        const falseCtx = runResourceStatusBranch(
          originalCompositionFnForAnalysis,
          schemaDefinition,
          compositionAnalysis,
          ternary,
          false
        );

        // Diff ONLY the targeted resource(s)
        const targetIds =
          ternary.callSiteResourceId && ternary.callSiteResourceId !== '__non_factory_call__'
            ? [ternary.callSiteResourceId]
            : getNestedResourceStatusTargetIds(trueCtx.resources, trueCtx.nestedCompositionIds);

        for (const id of targetIds) {
          const targetRes = resourcesWithKeys[id] as unknown as Record<string, unknown> | undefined;
          const trueRes = trueCtx.resources[id] as unknown as Record<string, unknown> | undefined;
          const falseRes = falseCtx.resources[id] as unknown as Record<string, unknown> | undefined;
          if (targetRes && trueRes && falseRes) {
            applyResourceStatusBranchDiff(
              targetRes,
              trueRes,
              falseRes,
              conditionCel,
              nestedStatusCel,
              resourceIds
            );
          }
        }

        serializationLogger.debug('Resource-status branch runs applied', {
          conditionCel,
          targetIds,
        });
      }

      const currentCtx = getCurrentCompositionContext();
      const skipHybridCapture = currentCtx?.isNestedCall === true;
      if (
        !skipHybridCapture &&
        schemaDefinition &&
        (compositionAnalysis.unregisteredFactories.length > 0 ||
          collectOverridableOptionalFields(schemaDefinition, compositionAnalysis).size > 0)
      ) {
        const { captured, overriddenFields, overrideConditions } = captureHybridRunResources(
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
          const baselineResources = Object.fromEntries(
            Object.entries(resourcesWithKeys).map(([id, resource]) => [
              id,
              cloneResourceTree(resource as unknown as Record<string, unknown>),
            ])
          ) as Record<string, Record<string, unknown>>;

          const differentialFields = collectDifferentialOptionalFields(compositionAnalysis);
          const fieldsToDiff = Array.from(differentialFields).filter((field) =>
            overriddenFields.has(field)
          );

          for (const field of fieldsToDiff) {
            const singleFieldSet = new Set([field]);
            const { captured: fieldCaptured } = captureHybridRunResources(
              originalCompositionFnForAnalysis,
              schemaDefinition,
              compositionAnalysis,
              singleFieldSet
            );
            const fieldConditions = new Map<string, string>();
            const explicitCondition = overrideConditions.get(field);
            if (explicitCondition) {
              fieldConditions.set(field, explicitCondition);
            }

            for (const id of Object.keys(resourcesWithKeys)) {
              const proxyRes = resourcesWithKeys[id] as unknown as Record<string, unknown>;
              const baselineRes = baselineResources[id];
              const hybridRes = fieldCaptured[id] as unknown as Record<string, unknown> | undefined;
              if (proxyRes && baselineRes && hybridRes) {
                applyDifferentialFieldConditionals(
                  proxyRes,
                  baselineRes,
                  hybridRes,
                  singleFieldSet,
                  fieldConditions,
                  nestedStatusCel,
                  resourceIds
                );
              }
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
  const specJson = schemaDefinition.spec.json;
  if (!specJson) return new Set();

  const differentialFields = collectDifferentialOptionalFields(analysis);
  return new Set(
    Array.from(collectOptionalSpecPaths(specJson)).filter((field) => differentialFields.has(field))
  );
}

function collectOptionalSpecPaths(schemaJson: unknown, prefix = ''): Set<string> {
  const paths = new Set<string>();
  if (!schemaJson || typeof schemaJson !== 'object') return paths;

  const node = schemaJson as {
    optional?: Array<{ key?: string; value?: unknown }>;
    required?: Array<{ key?: string; value?: unknown }>;
  };

  for (const entry of node.optional ?? []) {
    if (!entry.key) continue;
    const path = prefix ? `${prefix}.${entry.key}` : entry.key;
    paths.add(path);
    for (const childPath of collectOptionalSpecPaths(entry.value, path)) {
      paths.add(childPath);
    }
  }

  for (const entry of node.required ?? []) {
    if (!entry.key) continue;
    const path = prefix ? `${prefix}.${entry.key}` : entry.key;
    for (const childPath of collectOptionalSpecPaths(entry.value, path)) {
      paths.add(childPath);
    }
  }

  return paths;
}

function collectDifferentialOptionalFields(analysis: ASTAnalysisResult): Set<string> {
  const fields = new Set<string>(analysis.hybridOverrideConditions.keys());

  for (const field of analysis.differentialConditionFields) {
    fields.add(field);
  }

  for (const controlFlow of analysis.resources.values()) {
    for (const condition of controlFlow.includeWhen) {
      const expression = condition.expression;
      const matches = expression.matchAll(/schema\.spec\.([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g);
      for (const match of matches) {
        const field = match[1];
        if (field) {
          fields.add(field);
        }
      }
    }
  }

  return fields;
}

function collectHybridOverrideValues(analysis: ASTAnalysisResult): Map<string, unknown> {
  const overrideValues = new Map<string, unknown>();

  for (const [field, expression] of analysis.hybridOverrideConditions.entries()) {
    const match = expression.match(/^schema\.spec\.([a-zA-Z0-9_.]+)\s*!=\s*false$/);
    const path = match?.[1];
    if (!path || path !== field || overrideValues.has(field)) continue;
    overrideValues.set(field, false);
  }

  return overrideValues;
}

function collectHybridOverrideConditions(analysis: ASTAnalysisResult): Map<string, string> {
  return new Map(analysis.hybridOverrideConditions);
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
  schemaDefinition: { spec: { json?: unknown }; status?: { json?: unknown } },
  analysis: ASTAnalysisResult,
  fieldsToOverride?: Set<string>
): {
  captured: Record<string, Enhanced<unknown, unknown>>;
  overriddenFields: Set<string>;
  overrideConditions: Map<string, string>;
} {
  try {
    const allOverriddenFields = collectOverridableOptionalFields(schemaDefinition, analysis);
    const overriddenFields = fieldsToOverride
      ? new Set(Array.from(allOverriddenFields).filter((field) => fieldsToOverride.has(field)))
      : allOverriddenFields;
    if (overriddenFields.size === 0) {
      return { captured: {}, overriddenFields, overrideConditions: new Map() };
    }
    const overrideValues = new Map(
      Array.from(collectHybridOverrideValues(analysis)).filter(([field]) =>
        overriddenFields.has(field)
      )
    );
    const overrideConditions = new Map(
      Array.from(collectHybridOverrideConditions(analysis)).filter(([field]) =>
        overriddenFields.has(field)
      )
    );

    // Build the hybrid spec: the real schema proxy (so all other field
    // accesses produce KubernetesRef values) wrapped in a Proxy that
    // intercepts the overridden keys and returns `undefined`. Accessing
    // an overridden key's sub-property (e.g., `spec.secretKeyRef.name`)
    // will throw — but that's exactly the code path the override is
    // meant to skip, so the thrown access lives inside the `else`
    // branch that this run intentionally does not execute.
    const realSchema = createSchemaProxy<KroCompatibleType, KroCompatibleType>(
      (schemaDefinition.spec as { json?: unknown } | undefined)?.json,
      (schemaDefinition.status as { json?: unknown } | undefined)?.json
    );
    const hybridSpec = createHybridSpecProxy(
      realSchema.spec as Record<string, unknown>,
      overriddenFields,
      overrideValues
    );

    const tempCtx = createCompositionContext('hybrid-capture');
    runWithCompositionContext(tempCtx, () => {
      compositionFn(hybridSpec);
    });
    return {
      captured: tempCtx.resources as Record<string, Enhanced<unknown, unknown>>,
      overriddenFields,
      overrideConditions,
    };
  } catch {
    // Best-effort: compositions that throw when running with a hybrid spec
    // degrade gracefully — stub resources still cover the missing factories
    // and the proxy-run resources are used as-is.
    return { captured: {}, overriddenFields: new Set(), overrideConditions: new Map() };
  }
}

function createHybridSpecProxy(
  target: Record<string, unknown>,
  overriddenFields: Set<string>,
  overrideValues: Map<string, unknown>,
  pathPrefix = ''
): Record<string, unknown> {
  return new Proxy(target, {
    get(proxyTarget, prop: string | symbol, receiver) {
      if (typeof prop !== 'string') {
        return Reflect.get(proxyTarget, prop, receiver);
      }

      const path = pathPrefix ? `${pathPrefix}.${prop}` : prop;
      if (overriddenFields.has(path)) {
        return overrideValues.has(path) ? overrideValues.get(path) : undefined;
      }

      const hasNestedOverride = Array.from(overriddenFields).some((field) =>
        field.startsWith(`${path}.`)
      );
      const value = Reflect.get(proxyTarget, prop, receiver);
      if (
        hasNestedOverride &&
        value &&
        (typeof value === 'object' || typeof value === 'function')
      ) {
        return createHybridSpecProxy(
          value as Record<string, unknown>,
          overriddenFields,
          overrideValues,
          path
        );
      }

      return value;
    },
    has(proxyTarget, prop: string | symbol) {
      if (typeof prop !== 'string') {
        return Reflect.has(proxyTarget, prop);
      }

      const path = pathPrefix ? `${pathPrefix}.${prop}` : prop;
      if (overriddenFields.has(path)) {
        return overrideValues.has(path);
      }

      return Reflect.has(proxyTarget, prop);
    },
  }) as Record<string, unknown>;
}

function cloneResourceTree<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneResourceTree(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, cloneResourceTree(entryValue)])
    ) as T;
  }
  return value;
}

function structuralEquals(a: unknown, b: unknown): boolean {
  if (isLeafValue(a) || isLeafValue(b)) {
    return leafEquals(a, b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => structuralEquals(item, b[index]));
  }
  if (isWalkableRecord(a) && isWalkableRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (
        !structuralEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
      ) {
        return false;
      }
    }
    return true;
  }
  return a === b;
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
  currentRes: Record<string, unknown>,
  baselineRes: Record<string, unknown>,
  hybridRes: Record<string, unknown>,
  overriddenFields: Set<string>,
  overrideConditions: Map<string, string>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): void {
  walkAndConditionalize(
    currentRes,
    baselineRes,
    hybridRes,
    overriddenFields,
    overrideConditions,
    nestedStatusCel,
    resourceIds
  );
}

function walkAndConditionalize(
  current: unknown,
  baseline: unknown,
  hybrid: unknown,
  overriddenFields: Set<string>,
  overrideConditions: Map<string, string>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): unknown {
  if (Array.isArray(current) && Array.isArray(baseline) && Array.isArray(hybrid)) {
    if (baseline.length !== hybrid.length) {
      return structuralEquals(current, baseline)
        ? buildCelConditional(
            baseline,
            hybrid,
            overriddenFields,
            overrideConditions,
            nestedStatusCel,
            resourceIds
          )
        : current;
    }

    const maxLen = Math.max(current.length, hybrid.length);
    for (let i = 0; i < maxLen; i++) {
      const c = current[i];
      const b = baseline[i];
      const h = hybrid[i];
      if (i >= current.length) {
        // New element added by hybrid run — copy it over.
        current.push(h);
        continue;
      }
      if (i >= hybrid.length) {
        // Element removed in hybrid — leave the proxy value as-is.
        continue;
      }
      if (isLeafValue(b) && isLeafValue(h)) {
        if (!leafEquals(b, h) && leafEquals(c, b)) {
          current[i] = buildCelConditional(
            b,
            h,
            overriddenFields,
            overrideConditions,
            nestedStatusCel,
            resourceIds
          );
        }
      } else {
        const conditionalized = walkAndConditionalize(
          c,
          b,
          h,
          overriddenFields,
          overrideConditions,
          nestedStatusCel,
          resourceIds
        );
        if (conditionalized !== c) {
          current[i] = conditionalized;
        }
      }
    }
    return current;
  }

  if (isWalkableRecord(current) && isWalkableRecord(baseline) && isWalkableRecord(hybrid)) {
    const keys = new Set([
      ...Object.keys(current),
      ...Object.keys(baseline),
      ...Object.keys(hybrid),
    ]);
    for (const key of keys) {
      const c = (current as Record<string, unknown>)[key];
      const b = (baseline as Record<string, unknown>)[key];
      const h = (hybrid as Record<string, unknown>)[key];
      if (!(key in (hybrid as Record<string, unknown>))) {
        continue;
      }
      if (!(key in (current as Record<string, unknown>))) {
        (current as Record<string, unknown>)[key] = h;
        continue;
      }
      if (isLeafValue(b) && isLeafValue(h)) {
        if (!leafEquals(b, h) && leafEquals(c, b)) {
          (current as Record<string, unknown>)[key] = buildCelConditional(
            b,
            h,
            overriddenFields,
            overrideConditions,
            nestedStatusCel,
            resourceIds
          );
        }
      } else {
        const conditionalized = walkAndConditionalize(
          c,
          b,
          h,
          overriddenFields,
          overrideConditions,
          nestedStatusCel,
          resourceIds
        );
        if (conditionalized !== c) {
          (current as Record<string, unknown>)[key] = conditionalized;
        }
      }
    }
    return current;
  }

  return current;
}

function isLeafValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    isCelExpressionLike(v) ||
    // KubernetesRef proxies register as functions (typeof fn is 'function')
    typeof v === 'function'
  );
}

function runResourceStatusBranch(
  compositionFn: (spec: KroCompatibleType) => unknown,
  schemaDefinition: { spec: { json?: unknown } } | undefined,
  analysis: ASTAnalysisResult,
  ternary: ASTAnalysisResult['resourceStatusTernaries'][number],
  desiredConditionValue: boolean
) {
  const branchCtx = createCompositionContext('resource-status-branch', {
    isReExecution: true,
  });
  branchCtx.liveStatusMap = createResourceStatusBranchMap(analysis, ternary, desiredConditionValue);

  const branchSchema = createSchemaProxy<KroCompatibleType, KroCompatibleType>(
    (schemaDefinition?.spec as { json?: unknown } | undefined)?.json,
    (schemaDefinition as { status?: { json?: unknown } } | undefined)?.status?.json
  );
  const specOverrides = createSpecConditionOverrideMap(
    ternary.conditionExpression,
    desiredConditionValue
  );
  const branchSpec =
    specOverrides.size > 0
      ? createSpecOverrideProxy(branchSchema.spec as Record<string, unknown>, specOverrides)
      : branchSchema.spec;

  runWithCompositionContext(branchCtx, () => {
    runInStatusBuilderContext(() => {
      compositionFn(branchSpec as KroCompatibleType);
    });
  });

  return branchCtx;
}

function createResourceStatusBranchMap(
  analysis: ASTAnalysisResult,
  ternary: ASTAnalysisResult['resourceStatusTernaries'][number],
  desiredConditionValue: boolean
): Map<string, Record<string, unknown>> {
  const conditionExpression =
    ternary.conditionExpression ?? `${ternary.variableName}.status.${ternary.statusField}`;
  const statusRefs = collectStatusRefs(conditionExpression);
  if (statusRefs.length === 0) {
    statusRefs.push({ variableName: ternary.variableName, statusField: ternary.statusField });
  }

  const statusMap = new Map<string, Record<string, unknown>>();
  for (const statusRef of statusRefs) {
    const resourceId =
      analysis.variableToResourceId.get(statusRef.variableName) ?? statusRef.variableName;
    const existing = statusMap.get(resourceId) ?? {};
    setNestedBranchStatusValue(
      existing,
      statusRef.statusField,
      getBranchStatusValue(
        conditionExpression,
        `${statusRef.variableName}.status.${statusRef.statusField}`,
        desiredConditionValue
      )
    );
    statusMap.set(resourceId, existing);
  }

  return statusMap;
}

function setNestedBranchStatusValue(
  target: Record<string, unknown>,
  statusField: string,
  value: unknown
): void {
  const parts = statusField.split('.').filter(Boolean);
  if (parts.length === 0) return;

  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const next = cursor[part];
    if (!isPlainObject(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (leaf) {
    cursor[leaf] = value;
  }
}

function collectStatusRefs(
  conditionExpression: string
): Array<{ variableName: string; statusField: string }> {
  const refs: Array<{ variableName: string; statusField: string }> = [];
  const seen = new Set<string>();
  const statusRefPattern =
    /\b([A-Za-z_$][\w$]*)\.status\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

  for (const match of conditionExpression.matchAll(statusRefPattern)) {
    const variableName = match[1];
    const statusField = match[2];
    if (!variableName || !statusField) continue;

    const key = `${variableName}:${statusField}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ variableName, statusField });
  }

  return refs;
}

function createSpecConditionOverrideMap(
  conditionExpression: string | undefined,
  desiredConditionValue: boolean
): Map<string, unknown> {
  const overrides = new Map<string, unknown>();
  if (!conditionExpression) return overrides;

  const specRefPattern = /\b(?:schema\.)?spec\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  for (const match of conditionExpression.matchAll(specRefPattern)) {
    const specPath = match[1];
    const fullRef = match[0];
    if (!specPath || !fullRef || overrides.has(specPath)) continue;
    overrides.set(
      specPath,
      getBranchStatusValue(conditionExpression, fullRef, desiredConditionValue)
    );
  }

  return overrides;
}

function createSpecOverrideProxy(
  target: Record<string, unknown>,
  overrides: Map<string, unknown>,
  path: string[] = []
): Record<string, unknown> {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(obj, prop, receiver);

      const fullPath = [...path, prop].join('.');
      if (overrides.has(fullPath)) return overrides.get(fullPath);

      const hasNestedOverride = [...overrides.keys()].some((key) => key.startsWith(`${fullPath}.`));
      const value = Reflect.get(obj, prop, receiver);
      if (
        hasNestedOverride &&
        value &&
        (typeof value === 'object' || typeof value === 'function')
      ) {
        return createSpecOverrideProxy(value as Record<string, unknown>, overrides, [
          ...path,
          prop,
        ]);
      }
      return value;
    },
    ownKeys: (obj) => Reflect.ownKeys(obj),
    getOwnPropertyDescriptor: (obj, prop) => Reflect.getOwnPropertyDescriptor(obj, prop),
  });
}

function getBranchStatusValue(
  conditionExpression: string,
  statusRefExpression: string,
  desiredConditionValue: boolean
): unknown {
  const escapedRef = statusRefExpression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const comparison = conditionExpression.match(
    new RegExp(`${escapedRef}\\s*(>=|>|<=|<|==|!=)\\s*(-?\\d+(?:\\.\\d+)?)`)
  );
  if (comparison?.[1] && comparison[2] !== undefined) {
    const operator = comparison[1];
    const numberValue = Number(comparison[2]);
    if (operator === '>=') return desiredConditionValue ? numberValue : numberValue - 1;
    if (operator === '>') return desiredConditionValue ? numberValue + 1 : numberValue;
    if (operator === '<=') return desiredConditionValue ? numberValue : numberValue + 1;
    if (operator === '<') return desiredConditionValue ? numberValue - 1 : numberValue;
    if (operator === '==') return desiredConditionValue ? numberValue : numberValue + 1;
    if (operator === '!=') return desiredConditionValue ? numberValue + 1 : numberValue;
  }

  const stringComparison = conditionExpression.match(
    new RegExp(`${escapedRef}\\s*(==|!=)\\s*(['"])(.*?)\\2`)
  );
  if (stringComparison?.[1] && stringComparison[3] !== undefined) {
    const operator = stringComparison[1];
    const stringValue = stringComparison[3];
    if (operator === '==')
      return desiredConditionValue ? stringValue : `__typekro_not_${stringValue}`;
    if (operator === '!=')
      return desiredConditionValue ? `__typekro_not_${stringValue}` : stringValue;
  }

  const booleanComparison = conditionExpression.match(
    new RegExp(`${escapedRef}\\s*(==|!=)\\s*(true|false)`)
  );
  if (booleanComparison?.[1] && booleanComparison[2] !== undefined) {
    const operator = booleanComparison[1];
    const booleanValue = booleanComparison[2] === 'true';
    if (operator === '==') return desiredConditionValue ? booleanValue : !booleanValue;
    if (operator === '!=') return desiredConditionValue ? !booleanValue : booleanValue;
  }

  const negatedRef = new RegExp(`!\\s*${escapedRef}(?![A-Za-z0-9_$.])`).test(conditionExpression);
  return negatedRef ? !desiredConditionValue : desiredConditionValue;
}

function applyResourceStatusBranchDiff(
  targetRes: Record<string, unknown>,
  trueRes: Record<string, unknown>,
  falseRes: Record<string, unknown>,
  conditionCel: string,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): void {
  for (const key of new Set([...Object.keys(trueRes), ...Object.keys(falseRes)])) {
    if (key === '__resourceId' || key === 'id' || key.startsWith('__')) continue;

    const tv = trueRes[key];
    const fv = falseRes[key];

    if (tv === undefined && fv !== undefined) {
      const falseRepr = celValueRepr(fv, nestedStatusCel, resourceIds);
      targetRes[key] = `\${${conditionCel} ? omit() : ${falseRepr}}`;
      continue;
    }

    if (fv === undefined && tv !== undefined) {
      const trueRepr = celValueRepr(tv, nestedStatusCel, resourceIds);
      targetRes[key] = `\${${conditionCel} ? ${trueRepr} : omit()}`;
      continue;
    }

    if (tv === undefined || fv === undefined) continue;

    if (isCelExpressionLike(tv) || isCelExpressionLike(fv)) {
      if (!leafEquals(tv, fv)) {
        const trueRepr = celValueRepr(tv, nestedStatusCel, resourceIds);
        const falseRepr = celValueRepr(fv, nestedStatusCel, resourceIds);
        targetRes[key] = `\${${conditionCel} ? ${trueRepr} : ${falseRepr}}`;
      }
      continue;
    }

    const targetValue = targetRes[key];
    if (isPlainObject(tv) && isPlainObject(fv)) {
      if (!isPlainObject(targetValue)) targetRes[key] = {};
      applyResourceStatusBranchDiff(
        targetRes[key] as Record<string, unknown>,
        tv,
        fv,
        conditionCel,
        nestedStatusCel,
        resourceIds
      );
    } else if (Array.isArray(tv) && Array.isArray(fv) && tv.length === fv.length) {
      if (!Array.isArray(targetValue)) targetRes[key] = [...tv];
      const targetArray = targetRes[key] as unknown[];
      for (let i = 0; i < tv.length; i++) {
        if (isPlainObject(tv[i]) && isPlainObject(fv[i])) {
          if (!isPlainObject(targetArray[i])) targetArray[i] = {};
          applyResourceStatusBranchDiff(
            targetArray[i] as Record<string, unknown>,
            tv[i] as Record<string, unknown>,
            fv[i] as Record<string, unknown>,
            conditionCel,
            nestedStatusCel,
            resourceIds
          );
        } else if (!leafEquals(tv[i], fv[i])) {
          const trueRepr = celValueRepr(tv[i], nestedStatusCel, resourceIds);
          const falseRepr = celValueRepr(fv[i], nestedStatusCel, resourceIds);
          targetArray[i] = `\${${conditionCel} ? ${trueRepr} : ${falseRepr}}`;
        }
      }
    } else if (Array.isArray(tv) && Array.isArray(fv) && tv.length !== fv.length) {
      const trueRepr = celValueRepr(tv, nestedStatusCel, resourceIds);
      const falseRepr = celValueRepr(fv, nestedStatusCel, resourceIds);
      targetRes[key] = `\${${conditionCel} ? ${trueRepr} : ${falseRepr}}`;
    } else if (!leafEquals(tv, fv)) {
      const trueRepr = celValueRepr(tv, nestedStatusCel, resourceIds);
      const falseRepr = celValueRepr(fv, nestedStatusCel, resourceIds);
      targetRes[key] = `\${${conditionCel} ? ${trueRepr} : ${falseRepr}}`;
    }
  }
}

function leafEquals(a: unknown, b: unknown): boolean {
  // For KubernetesRef proxies, compare their string coercions (marker tokens).
  if (typeof a === 'function' || typeof b === 'function') {
    return String(a) === String(b);
  }
  return a === b;
}

function getNestedResourceStatusTargetIds(
  resources: Record<string, Enhanced<unknown, unknown>>,
  nestedCompositionIds: Set<string> | undefined
): string[] {
  if (!nestedCompositionIds || nestedCompositionIds.size === 0) return [];

  return Object.entries(resources)
    .filter(([resourceId, resource]) =>
      [...nestedCompositionIds].some((nestedId) =>
        isNestedCompositionChild(resourceId, resource, nestedId)
      )
    )
    .map(([resourceId]) => resourceId);
}

function isNestedCompositionChild(
  resourceId: string,
  resource: Enhanced<unknown, unknown>,
  nestedId: string
): boolean {
  if (resourceId === nestedId) return true;

  const boundaryChar = resourceId[nestedId.length];
  if (
    resourceId.startsWith(nestedId) &&
    boundaryChar !== undefined &&
    /[A-Z_-]/.test(boundaryChar)
  ) {
    return true;
  }

  const aliases = getMetadataField(resource, 'resourceAliases') as string[] | undefined;
  return (
    aliases?.some((alias) => {
      if (alias === nestedId) return true;

      const aliasBoundaryChar = alias[nestedId.length];
      return (
        alias.startsWith(nestedId) &&
        aliasBoundaryChar !== undefined &&
        /[A-Z_-]/.test(aliasBoundaryChar)
      );
    }) ?? false
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isCelExpressionLike(v);
}

function isWalkableRecord(v: unknown): v is Record<string, unknown> {
  if (isPlainObject(v)) {
    return true;
  }

  return typeof v === 'function' && Object.keys(v as object).length > 0;
}

/** Duck-type check for CelExpression objects — avoids importing from cel.ts (cycle risk). */
function isCelExpressionLike(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  // Plain Cel.expr() objects carry the symbol brand; template expressions also
  // carry `__isTemplate`. Support both shapes without importing cel.ts.
  return (
    'expression' in v &&
    typeof (v as Record<string, unknown>).expression === 'string' &&
    ((v as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true || '__isTemplate' in v)
  );
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
  overriddenFields: Set<string>,
  overrideConditions: Map<string, string>,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): string {
  const field = pickConditionField(proxyValue, hybridValue, overriddenFields);
  const proxyRepr = celValueRepr(proxyValue, nestedStatusCel, resourceIds);
  const hybridRepr = celValueRepr(hybridValue, nestedStatusCel, resourceIds);

  const explicitCondition = overrideConditions.get(field);
  if (explicitCondition) {
    return `\${${explicitCondition} ? ${proxyRepr} : ${hybridRepr}}`;
  }

  // Chain has() guards when the proxy value references a sub-field deeper
  // than the controlling optional field. A single has(schema.spec.X) is
  // insufficient when the value accesses X.Y — the user may provide X: {}
  // without Y, and KRO would fail with "no such key: Y".
  const guardField = `schema.spec.${field}`;
  let guard = `has(${guardField})`;

  // Extract the full schema path from the proxy repr to check depth.
  // proxyRepr may be a bare path like `schema.spec.cnpgOperator.version`
  // or wrapped in string() like `string(schema.spec.cnpgOperator.version)`.
  // Chain has() guards for ALL intermediate levels between the controlling
  // field and the leaf. For `cnpgOperator.monitoring.enabled`, we need:
  //   has(cnpgOperator) && has(cnpgOperator.monitoring) && has(cnpgOperator.monitoring.enabled)
  const schemaPathMatch = proxyRepr.match(/schema\.spec\.([a-zA-Z0-9_.]+)/);
  if (schemaPathMatch) {
    const fullRefPath = schemaPathMatch[1]?.replace(/\.+$/, '');
    if (!fullRefPath) return `\${has(${guardField}) ? ${proxyRepr} : ${hybridRepr}}`;
    const fullPath = `schema.spec.${fullRefPath}`;
    if (fullPath !== guardField && fullPath.startsWith(`${guardField}.`)) {
      const guardSegments = field.split('.').length;
      const leafSegments = fullRefPath.split('.');
      const guards = [`has(${guardField})`];
      for (let j = guardSegments + 1; j <= leafSegments.length; j++) {
        const intermediatePath = `schema.spec.${leafSegments.slice(0, j).join('.')}`;
        guards.push(`has(${intermediatePath})`);
      }
      guard = guards.join(' && ');
    }
  }

  return `\${${guard} ? ${proxyRepr} : ${hybridRepr}}`;
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
// Re-export from shared utility for local use. This was previously an
// inline copy; the canonical implementation lives in utils/cel-escape.ts.
import { escapeCelString as escapeCelLiteral } from '../../utils/cel-escape.js';

function celValueRepr(
  value: unknown,
  nestedStatusCel?: Record<string, string>,
  resourceIds?: ReadonlySet<string>
): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // CelExpression object — use the expression string directly.
  if (isCelExpressionLike(value)) {
    return unwrapKroExpression(
      finalizeCelForKro(
        (value as { expression: string }).expression,
        nestedStatusCel,
        createBranchCelContext(nestedStatusCel, resourceIds)
      )
    );
  }
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
  if (Array.isArray(value)) {
    return `[${value.map((item) => celValueRepr(item, nestedStatusCel, resourceIds)).join(', ')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .map(
        ([key, entryValue]) =>
          `"${escapeCelLiteral(key)}": ${celValueRepr(entryValue, nestedStatusCel, resourceIds)}`
      )
      .join(', ')}}`;
  }
  return '""';
}

function createBranchCelContext(
  nestedStatusCel: Record<string, string> | undefined,
  resourceIds: ReadonlySet<string> | undefined
): SerializationContext | undefined {
  if (!nestedStatusCel && !resourceIds) return undefined;
  return {
    celPrefix: '',
    resourceIdStrategy: 'deterministic',
    ...(nestedStatusCel ? { nestedStatusCel } : {}),
    ...(resourceIds ? { resourceIds } : {}),
  };
}

function unwrapKroExpression(value: string): string {
  if (value.startsWith('${') && value.endsWith('}') && value.indexOf('${', 2) === -1) {
    return value.slice(2, -1);
  }
  return value;
}

/**
 * Convert a single-marker string (the whole string is one marker) to
 * its bare CEL path form: `schema.spec.X` or `resources.X.field`.
 */
function markerStringToCelBare(str: string): string {
  const m = str.match(new RegExp(`^${KUBERNETES_REF_MARKER_SOURCE}$`));
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
  const markerSource = KUBERNETES_REF_MARKER_SOURCE;
  // Fast path: whole string is a single marker
  const singleMatch = str.match(new RegExp(`^${markerSource}$`));
  if (singleMatch) {
    const [, resourceId, fieldPath] = singleMatch;
    return resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
  }

  // Slow path: interleave literal text and markers via CEL string concatenation
  const parts: string[] = [];
  let lastIndex = 0;
  const pattern = new RegExp(markerSource, 'g');
  let m: RegExpExecArray | null = pattern.exec(str);
  while (m !== null) {
    if (m.index > lastIndex) {
      const literal = str.slice(lastIndex, m.index);
      parts.push(`"${escapeCelLiteral(literal)}"`);
    }
    const resourceId = m[1];
    const fieldPath = m[2];
    if (!resourceId || !fieldPath) {
      m = pattern.exec(str);
      continue;
    }
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
  const [firstPart] = parts;
  return parts.length === 1 && firstPart !== undefined ? firstPart : parts.join(' + ');
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
  resourcesWithKeys: Record<string, Enhanced<unknown, unknown>>,
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
  resourcesWithKeys: Record<string, Enhanced<unknown, unknown>>,
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
  TResources extends Record<string, Enhanced<unknown, unknown> | DeploymentClosure>,
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
  TResources extends Record<string, Enhanced<unknown, unknown> | DeploymentClosure>,
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
    ...(definition.group && { group: definition.group }),
    spec: definition.spec,
    status: definition.status,
  };

  // Pass the Arktype JSON so the proxy is shape-aware — spread
  // (`{ ...spec.X }`) and `Object.keys(spec.X)` enumerate declared
  // fields instead of returning an opaque empty object.
  const schema = createSchemaProxy<TSpec, TStatus>(
    (definition.spec as { json?: unknown } | undefined)?.json,
    (definition.status as { json?: unknown } | undefined)?.json
  );
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
  for (const metadataKey of [
    '__originalCompositionFn',
    '__nestedCompositionFns',
    '__nestedCompositionDefinitions',
    '__nestedCompositionResources',
    '__nestedCompositionSpecMappings',
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(statusMappings, metadataKey);
    if (descriptor) {
      Object.defineProperty(optimizedStatusMappings, metadataKey, descriptor);
    }
  }

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
            ...((
              this as {
                _singletonDefinitions?: import('../types/deployment.js').SingletonDefinitionRecord[];
              }
            )._singletonDefinitions
              ? {
                  singletonDefinitions: (
                    this as {
                      _singletonDefinitions?: import('../types/deployment.js').SingletonDefinitionRecord[];
                    }
                  )._singletonDefinitions,
                }
              : {}),
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
            compositionAnalysis,
            ...((
              this as {
                _singletonDefinitions?: import('../types/deployment.js').SingletonDefinitionRecord[];
              }
            )._singletonDefinitions
              ? {
                  singletonDefinitions: (
                    this as {
                      _singletonDefinitions?: import('../types/deployment.js').SingletonDefinitionRecord[];
                    }
                  )._singletonDefinitions,
                }
              : {}),
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

    toYaml(specOrOptions?: TSpec | ToYamlOptions): string {
      if (specOrOptions !== undefined) {
        if (isToYamlOptions(specOrOptions)) {
          const factory = this.factory('kro', specOrOptions) as KroResourceFactory<TSpec, TStatus>;
          return factory.toYaml();
        }
        return this.factory('kro').toYaml(specOrOptions as TSpec);
      }

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
      const nestedStatusDescriptor = Object.getOwnPropertyDescriptor(
        statusMappings,
        '__nestedStatusCel'
      );
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
          applyTernaryConditionalsToResources(
            resourcesWithKeys,
            kroSchema.__ternaryConditionals,
            kroSchema.__nestedStatusCel
          );
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
