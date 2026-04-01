/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */

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
import { applyOmitWrappers, applyTernaryConditionalsToResources } from './kro-post-processing.js';
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
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): CompositionBodyAnalysisResult {
  let compositionAnalysis: ASTAnalysisResult | null = null;
  const analysisState = { appliedToResources: false, ternaryAndOmitApplied: false };

  const originalCompositionFnForAnalysis = (statusMappings as Record<string, unknown>)
    ?.__originalCompositionFn as ((...args: unknown[]) => unknown) | undefined;

  if (originalCompositionFnForAnalysis) {
    try {
      const resourceIds = new Set(Object.keys(resourcesWithKeys));
      compositionAnalysis = analyzeCompositionBody(originalCompositionFnForAnalysis, resourceIds);

      // Create stub resources for factory calls that weren't registered at runtime
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
    serializationLogger
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
      // Extract nested composition status CEL mappings attached by executeCompositionCore.
      // These are on the raw statusMappings (capturedStatus from the composition function),
      // not on the optimizedStatusMappings (which is a processed copy).
      const nestedStatusCel: Record<string, string> =
        (statusMappings as Record<string, unknown>).__nestedStatusCel as Record<string, string> ?? {};

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

      // Apply ternary conditionals and omit wrappers (once only — guard
      // prevents double-processing if toYaml() is called multiple times).
      if (!analysisState.ternaryAndOmitApplied) {
        analysisState.ternaryAndOmitApplied = true;

        const ternaryConditionals = (kroSchema as unknown as Record<string, unknown>).__ternaryConditionals as
          Array<{ proxySection: string; falsyValue: string; conditionField: string }> | undefined;
        if (ternaryConditionals?.length) {
          applyTernaryConditionalsToResources(resourcesWithKeys, ternaryConditionals);
        }
      }

      let yaml = serializeResourceGraphToYaml(definition.name, resourcesWithKeys, options, kroSchema);

      const omitFields = (kroSchema as unknown as Record<string, unknown>).__omitFields as string[] | undefined;
      if (omitFields?.length) {
        yaml = applyOmitWrappers(yaml, omitFields);
      }

      return yaml;
    },
  };

  // 8. Wrap with cross-composition magic proxy
  return wrapWithResourceGraphProxy(
    baseResourceGraph as TypedResourceGraph<TSpec, TStatus>,
    resourcesWithKeys,
    serializationLogger
  );
}
