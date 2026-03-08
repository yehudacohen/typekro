/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */

import {
  containsCelExpressions,
  containsKubernetesRefs,
  isCelExpression,
} from '../../utils/type-guards.js';
import { runInStatusBuilderContext } from '../composition/context.js';

import { createDirectResourceFactory } from '../deployment/direct-factory.js';
import { createKroResourceFactory } from '../deployment/kro-factory.js';
import { ensureError, ValidationError } from '../errors.js';
import {
  analyzeCompositionBody,
  applyAnalysisToResources,
  type CompositionAnalysisResult,
} from '../expressions/composition/composition-analyzer.js';
import { analyzeImperativeComposition } from '../expressions/composition/imperative-analyzer.js';
import { CelConversionEngine } from '../expressions/factory/cel-conversion-engine.js';
import { CelToJavaScriptMigrationHelper } from '../expressions/factory/migration-helpers.js';
import {
  analyzeStatusBuilderForToResourceGraph,
  StatusBuilderAnalyzer,
  type StatusBuilderFunction,
} from '../expressions/factory/status-builder-analyzer.js';
import { getComponentLogger } from '../logging/index.js';
import { createExternalRefWithoutRegistration, createSchemaProxy } from '../references/index.js';
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
import { generateKroSchemaFromArktype } from './schema.js';
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
 * Map of factory names to Kubernetes apiVersion/kind for creating stub resources.
 * Used when the AST analyzer detects factory calls that didn't execute at runtime
 * (e.g. inside if-branches that weren't taken due to proxy evaluation).
 */
const FACTORY_KIND_MAP: Record<string, { apiVersion: string; kind: string }> = {
  Deployment: { apiVersion: 'apps/v1', kind: 'Deployment' },
  ConfigMap: { apiVersion: 'v1', kind: 'ConfigMap' },
  Service: { apiVersion: 'v1', kind: 'Service' },
  Ingress: { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress' },
  StatefulSet: { apiVersion: 'apps/v1', kind: 'StatefulSet' },
  DaemonSet: { apiVersion: 'apps/v1', kind: 'DaemonSet' },
  Job: { apiVersion: 'batch/v1', kind: 'Job' },
  CronJob: { apiVersion: 'batch/v1', kind: 'CronJob' },
  Secret: { apiVersion: 'v1', kind: 'Secret' },
  PersistentVolumeClaim: { apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
  ServiceAccount: { apiVersion: 'v1', kind: 'ServiceAccount' },
  Role: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role' },
  RoleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding' },
  ClusterRole: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole' },
  ClusterRoleBinding: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding' },
  Namespace: { apiVersion: 'v1', kind: 'Namespace' },
  HelmRelease: { apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease' },
};

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
  const kindInfo = FACTORY_KIND_MAP[factoryName];
  if (!kindInfo) return null;

  const stub: Record<string, unknown> = {
    apiVersion: kindInfo.apiVersion,
    kind: kindInfo.kind,
    metadata: { name: resourceId, labels: {} },
  };

  // Set __resourceId as non-enumerable
  Object.defineProperty(stub, '__resourceId', {
    value: resourceId,
    enumerable: false,
    configurable: true,
  });

  return stub;
}

/**
 * Detect and preserve existing CEL expressions for backward compatibility
 *
 * This function recursively checks status mappings for existing CEL expressions
 * and preserves them without conversion, ensuring backward compatibility.
 */
function detectAndPreserveCelExpressions(
  statusMappings: any,
  preservedExpressions: Record<string, unknown> = {},
  path: string = ''
): { hasExistingCel: boolean; preservedMappings: Record<string, unknown> } {
  let hasExistingCel = false;
  const preservedMappings = { ...preservedExpressions };

  if (!statusMappings || typeof statusMappings !== 'object') {
    return { hasExistingCel, preservedMappings };
  }

  for (const [key, value] of Object.entries(statusMappings)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (isCelExpression(value)) {
      // Found existing CEL expression - preserve it
      hasExistingCel = true;
      preservedMappings[currentPath] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively check nested objects
      const nestedResult = detectAndPreserveCelExpressions(value, preservedMappings, currentPath);
      hasExistingCel = hasExistingCel || nestedResult.hasExistingCel;
      Object.assign(preservedMappings, nestedResult.preservedMappings);
    }
  }

  return { hasExistingCel, preservedMappings };
}

/**
 * Merge preserved CEL expressions with analyzed mappings
 *
 * This ensures that existing CEL expressions take precedence over
 * newly analyzed JavaScript expressions for backward compatibility.
 */
function mergePreservedCelExpressions(
  analyzedMappings: Record<string, unknown>,
  preservedMappings: Record<string, unknown>
): Record<string, unknown> {
  const mergedMappings = { ...analyzedMappings };

  // Preserved CEL expressions take precedence
  for (const [path, celExpression] of Object.entries(preservedMappings)) {
    // Handle nested paths by setting the value at the correct location
    const pathParts = path.split('.');
    let current: any = mergedMappings;

    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!part) continue;

      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part];
    }

    const finalKey = pathParts[pathParts.length - 1];
    if (finalKey) {
      current[finalKey] = celExpression;
    }
  }

  return mergedMappings;
}

/**
 * Comprehensive analysis of status mappings to categorize different types of expressions
 *
 * This function provides detailed analysis of status mappings to determine:
 * - Which fields contain KubernetesRef objects (need conversion)
 * - Which fields are existing CEL expressions (preserve as-is)
 * - Which fields are static values (no conversion needed)
 * - Which fields are complex expressions that might need analysis
 */
function analyzeStatusMappingTypes(
  statusMappings: any,
  path: string = ''
): {
  kubernetesRefFields: string[];
  celExpressionFields: string[];
  staticValueFields: string[];
  complexExpressionFields: string[];
  analysisDetails: Record<
    string,
    {
      type: 'kubernetesRef' | 'celExpression' | 'staticValue' | 'complexExpression';
      value: any;
      requiresConversion: boolean;
      confidence: number;
    }
  >;
} {
  const kubernetesRefFields: string[] = [];
  const celExpressionFields: string[] = [];
  const staticValueFields: string[] = [];
  const complexExpressionFields: string[] = [];
  const analysisDetails: Record<
    string,
    {
      type: 'kubernetesRef' | 'celExpression' | 'staticValue' | 'complexExpression';
      value: any;
      requiresConversion: boolean;
      confidence: number;
    }
  > = {};

  if (!statusMappings || typeof statusMappings !== 'object') {
    return {
      kubernetesRefFields,
      celExpressionFields,
      staticValueFields,
      complexExpressionFields,
      analysisDetails,
    };
  }

  for (const [key, value] of Object.entries(statusMappings)) {
    const currentPath = path ? `${path}.${key}` : key;

    // Analyze the value type and requirements
    const analysis = analyzeValueType(value);
    analysisDetails[currentPath] = analysis;

    switch (analysis.type) {
      case 'kubernetesRef':
        kubernetesRefFields.push(currentPath);
        break;
      case 'celExpression':
        celExpressionFields.push(currentPath);
        break;
      case 'staticValue':
        staticValueFields.push(currentPath);
        break;
      case 'complexExpression':
        complexExpressionFields.push(currentPath);
        break;
    }

    // Recursively analyze nested objects
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !isCelExpression(value) &&
      !containsKubernetesRefs(value)
    ) {
      const nestedAnalysis = analyzeStatusMappingTypes(value, currentPath);
      kubernetesRefFields.push(...nestedAnalysis.kubernetesRefFields);
      celExpressionFields.push(...nestedAnalysis.celExpressionFields);
      staticValueFields.push(...nestedAnalysis.staticValueFields);
      complexExpressionFields.push(...nestedAnalysis.complexExpressionFields);
      Object.assign(analysisDetails, nestedAnalysis.analysisDetails);
    }
  }

  return {
    kubernetesRefFields,
    celExpressionFields,
    staticValueFields,
    complexExpressionFields,
    analysisDetails,
  };
}

/**
 * Analyze a single value to determine its type and conversion requirements
 */
function analyzeValueType(value: any): {
  type: 'kubernetesRef' | 'celExpression' | 'staticValue' | 'complexExpression';
  value: any;
  requiresConversion: boolean;
  confidence: number;
} {
  // Check for existing CEL expressions first (highest priority)
  if (isCelExpression(value)) {
    return {
      type: 'celExpression',
      value,
      requiresConversion: false,
      confidence: 1.0,
    };
  }

  // Check for KubernetesRef objects (need conversion)
  if (containsKubernetesRefs(value)) {
    return {
      type: 'kubernetesRef',
      value,
      requiresConversion: true,
      confidence: 1.0,
    };
  }

  // Check for primitive static values
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return {
      type: 'staticValue',
      value,
      requiresConversion: false,
      confidence: 1.0,
    };
  }

  // Check for arrays of static values
  if (Array.isArray(value)) {
    const hasKubernetesRefs = value.some((item) => containsKubernetesRefs(item));
    const hasCelExpressions = value.some((item) => isCelExpression(item));

    if (hasKubernetesRefs) {
      return {
        type: 'kubernetesRef',
        value,
        requiresConversion: true,
        confidence: 0.9,
      };
    } else if (hasCelExpressions) {
      return {
        type: 'celExpression',
        value,
        requiresConversion: false,
        confidence: 0.9,
      };
    } else {
      return {
        type: 'staticValue',
        value,
        requiresConversion: false,
        confidence: 0.8,
      };
    }
  }

  // Check for plain objects (might be complex expressions or static data)
  if (value && typeof value === 'object') {
    const hasKubernetesRefs = containsKubernetesRefs(value);
    const hasCelExpressions = Object.values(value).some((v) => isCelExpression(v));

    if (hasKubernetesRefs) {
      return {
        type: 'kubernetesRef',
        value,
        requiresConversion: true,
        confidence: 0.8,
      };
    } else if (hasCelExpressions) {
      return {
        type: 'celExpression',
        value,
        requiresConversion: false,
        confidence: 0.8,
      };
    } else {
      // Could be static data or complex expression - analyze further
      const isLikelyStatic = isLikelyStaticObject(value);
      if (isLikelyStatic) {
        return {
          type: 'staticValue',
          value,
          requiresConversion: false,
          confidence: 0.7,
        };
      } else {
        return {
          type: 'complexExpression',
          value,
          requiresConversion: false, // Conservative - don't convert unless we're sure
          confidence: 0.5,
        };
      }
    }
  }

  // Unknown type - treat as complex expression
  return {
    type: 'complexExpression',
    value,
    requiresConversion: false,
    confidence: 0.3,
  };
}

/**
 * Determine if an object is likely to be static data rather than an expression
 */
function isLikelyStaticObject(obj: any): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }

  // Check if all values are primitive types
  const values = Object.values(obj);
  const allPrimitive = values.every(
    (value) =>
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
  );

  if (allPrimitive) {
    return true;
  }

  // Check for common static object patterns
  const keys = Object.keys(obj);
  const hasCommonStaticKeys = keys.some((key) =>
    ['name', 'id', 'type', 'kind', 'version', 'label', 'tag'].includes(key.toLowerCase())
  );

  return hasCommonStaticKeys && values.length <= 10; // Reasonable size for static config
}

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
  FACTORY_KIND_MAP,
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

    const semanticPatterns: Record<string, string[]> = {
      database: ['deployment', 'statefulset'],
      db: ['deployment', 'statefulset'],
      cache: ['deployment', 'statefulset'],
      redis: ['deployment', 'statefulset'],
      service: ['service'],
      svc: ['service'],
      ingress: ['ingress'],
      configmap: ['configmap'],
      secret: ['secret'],
    };

    for (const [pattern, kinds] of Object.entries(semanticPatterns)) {
      if (keyParts.includes(pattern) && kinds.includes(kind)) {
        logger?.debug('findResourceByKey: fuzzy match (strategy 2: semantic pattern)', {
          requestedKey: key,
          matchedResourceId: resourceId,
          matchedKind: resource.kind,
          semanticPattern: pattern,
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
  let statusMappings: MagicAssignableShape<TStatus>;
  let analyzedStatusMappings: Record<string, unknown> = {};
  let mappingAnalysis: ReturnType<typeof analyzeStatusMappingTypes>;
  let imperativeAnalysisSucceeded = false;

  try {
    statusMappings = runInStatusBuilderContext(() =>
      statusBuilder(schema, resourcesWithKeys as TResources)
    );

    const originalCompositionFn = (statusMappings as Record<string, unknown>)
      .__originalCompositionFn as ((...args: unknown[]) => unknown) | undefined;

    if (originalCompositionFn) {
      const imperativeResult = analyzeImperativeStatusMappings(
        definition,
        statusBuilder,
        schema,
        resourcesWithKeys,
        statusMappings,
        originalCompositionFn,
        serializationLogger
      );
      analyzedStatusMappings = imperativeResult.analyzedStatusMappings;
      imperativeAnalysisSucceeded = imperativeResult.imperativeAnalysisSucceeded;
    } else {
      analyzedStatusMappings = analyzeDeclarativeStatusMappings(
        statusBuilder,
        schema,
        resourcesWithKeys,
        statusMappings,
        serializationLogger
      );
    }

    // Comprehensive analysis of the final status mappings
    mappingAnalysis = analyzeStatusMappingTypes(analyzedStatusMappings);

    serializationLogger.debug('Status mapping analysis complete', {
      kubernetesRefFields: mappingAnalysis.kubernetesRefFields.length,
      celExpressionFields: mappingAnalysis.celExpressionFields.length,
      staticValueFields: mappingAnalysis.staticValueFields.length,
      complexExpressionFields: mappingAnalysis.complexExpressionFields.length,
    });

    // Backward compatibility: detect and preserve existing CEL expressions
    const { hasExistingCel, preservedMappings } = detectAndPreserveCelExpressions(statusMappings);

    if (hasExistingCel) {
      logMigrationOpportunities(statusMappings, preservedMappings, serializationLogger);
    }

    // Convert KubernetesRef objects to CEL expressions
    const conversionResult = convertKubernetesRefsToCel(
      definition.name,
      statusMappings,
      serializationLogger
    );

    // Merge converted and preserved mappings
    if (conversionResult.hasConversions) {
      if (!imperativeAnalysisSucceeded) {
        analyzedStatusMappings = mergePreservedCelExpressions(
          conversionResult.convertedStatusMappings,
          preservedMappings
        );
      }
      serializationLogger.debug('Successfully converted JavaScript expressions to CEL', {
        convertedFields: Object.keys(conversionResult.convertedStatusMappings).filter(
          (key) =>
            conversionResult.convertedStatusMappings[key] !==
            (statusMappings as Record<string, unknown>)[key]
        ).length,
        preservedFields: Object.keys(preservedMappings).length,
        staticFields: mappingAnalysis.staticValueFields.length,
      });
    } else if (hasExistingCel) {
      if (!imperativeAnalysisSucceeded) {
        analyzedStatusMappings = mergePreservedCelExpressions(
          statusMappings as Record<string, unknown>,
          preservedMappings
        );
      }
      serializationLogger.debug('Preserved existing CEL expressions without conversion', {
        preservedFields: Object.keys(preservedMappings).length,
        staticFields: mappingAnalysis.staticValueFields.length,
        complexFields: mappingAnalysis.complexExpressionFields.length,
      });
    } else {
      if (!imperativeAnalysisSucceeded) {
        analyzedStatusMappings = statusMappings as Record<string, unknown>;
      }
      serializationLogger.debug(
        'Status builder contains only static values and complex expressions',
        {
          staticFields: mappingAnalysis.staticValueFields.length,
          complexFields: mappingAnalysis.complexExpressionFields.length,
          totalFields: Object.keys(mappingAnalysis.analysisDetails).length,
        }
      );
    }
  } catch (error: unknown) {
    serializationLogger.error('Failed to analyze status builder', ensureError(error));
    statusMappings = runInStatusBuilderContext(() =>
      statusBuilder(schema, resourcesWithKeys as TResources)
    );
    analyzedStatusMappings = statusMappings as Record<string, unknown>;
    mappingAnalysis = {
      kubernetesRefFields: [],
      celExpressionFields: [],
      staticValueFields: [],
      complexExpressionFields: [],
      analysisDetails: {},
    };
  }

  return {
    statusMappings: statusMappings!,
    analyzedStatusMappings,
    mappingAnalysis: mappingAnalysis!,
    imperativeAnalysisSucceeded,
  };
}

/**
 * Analyze status mappings from an imperative composition (has __originalCompositionFn).
 *
 * @internal
 */
function analyzeImperativeStatusMappings<
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
  statusMappings: MagicAssignableShape<TStatus>,
  originalCompositionFn: (...args: unknown[]) => unknown,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): { analyzedStatusMappings: Record<string, unknown>; imperativeAnalysisSucceeded: boolean } {
  let analyzedStatusMappings: Record<string, unknown> = {};
  let imperativeAnalysisSucceeded = false;

  serializationLogger.debug(
    'Detected imperative composition, checking for existing KubernetesRef objects'
  );

  let hasKubernetesRefs = containsKubernetesRefs(statusMappings);
  let hasCelExpressions = containsCelExpressions(statusMappings);
  const needsPreAnalysis = (statusMappings as Record<string, unknown>).__needsPreAnalysis === true;

  serializationLogger.debug('Imperative composition analysis', {
    hasKubernetesRefs,
    hasCelExpressions,
    needsPreAnalysis,
    statusMappings: JSON.stringify(statusMappings, null, 2),
  });

  if (hasKubernetesRefs || hasCelExpressions || needsPreAnalysis) {
    serializationLogger.debug(
      'Status object already contains KubernetesRef objects or CelExpression objects, using direct analysis'
    );

    try {
      const statusBuilderAnalysis = analyzeStatusBuilderForToResourceGraph(
        statusBuilder as StatusBuilderFunction<TSpec, MagicAssignableShape<TStatus>>,
        resourcesWithKeys as Record<string, Enhanced<any, any>>,
        schema,
        'kro'
      );

      if (statusBuilderAnalysis.requiresConversion) {
        analyzedStatusMappings = statusBuilderAnalysis.statusMappings;
        imperativeAnalysisSucceeded = true;
        serializationLogger.debug('Using status builder analysis for imperative composition', {
          fieldCount: Object.keys(analyzedStatusMappings).length,
        });
      } else {
        analyzedStatusMappings = statusMappings as Record<string, unknown>;
        serializationLogger.debug('No conversion required, using original status mappings');
      }
    } catch (statusAnalysisError: unknown) {
      serializationLogger.debug(
        'Status builder analysis failed, falling back to imperative analysis',
        {
          error: ensureError(statusAnalysisError).message,
        }
      );
      hasKubernetesRefs = false;
      hasCelExpressions = false;
    }
  }

  if (!hasKubernetesRefs && !hasCelExpressions) {
    serializationLogger.debug(
      'No KubernetesRef objects or CelExpression objects found, analyzing original composition function'
    );

    try {
      const imperativeAnalysis = analyzeImperativeComposition(
        originalCompositionFn,
        resourcesWithKeys as Record<string, Enhanced<any, any>>,
        { factoryType: 'kro' }
      );

      serializationLogger.debug('Imperative composition analysis complete', {
        statusFieldCount: Object.keys(imperativeAnalysis.statusMappings).length,
        hasJavaScriptExpressions: imperativeAnalysis.hasJavaScriptExpressions,
      });

      if (imperativeAnalysis.hasJavaScriptExpressions) {
        analyzedStatusMappings = imperativeAnalysis.statusMappings;
        imperativeAnalysisSucceeded = true;
        serializationLogger.debug(
          'Using analyzed imperative composition mappings with CEL expressions',
          {
            fieldCount: Object.keys(analyzedStatusMappings).length,
          }
        );
      } else {
        analyzedStatusMappings = statusMappings as Record<string, unknown>;
        serializationLogger.debug(
          'No JavaScript expressions found, using original status mappings'
        );
      }
    } catch (imperativeAnalysisError: unknown) {
      serializationLogger.debug(
        'Imperative composition analysis failed, using executed status mappings',
        {
          error: ensureError(imperativeAnalysisError).message,
        }
      );
      analyzedStatusMappings = statusMappings as Record<string, unknown>;
    }
  }

  return { analyzedStatusMappings, imperativeAnalysisSucceeded };
}

/**
 * Analyze status mappings from a regular (declarative) status builder.
 *
 * @internal
 */
function analyzeDeclarativeStatusMappings<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
  TResources extends Record<string, Enhanced<any, any> | DeploymentClosure>,
>(
  statusBuilder: (
    schema: SchemaProxy<TSpec, TStatus>,
    resources: TResources
  ) => MagicAssignableShape<TStatus>,
  schema: SchemaProxy<TSpec, TStatus>,
  resourcesWithKeys: Record<string, Enhanced<any, any>>,
  statusMappings: MagicAssignableShape<TStatus>,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): Record<string, unknown> {
  try {
    const statusBuilderAnalysis = analyzeStatusBuilderForToResourceGraph(
      statusBuilder as StatusBuilderFunction<TSpec, MagicAssignableShape<TStatus>>,
      resourcesWithKeys as Record<string, Enhanced<any, any>>,
      schema,
      'kro'
    );

    serializationLogger.debug('Status builder analysis complete', {
      statusFieldCount: Object.keys(statusBuilderAnalysis.statusMappings).length,
      dependencyCount: statusBuilderAnalysis.dependencies.length,
      hasJavaScriptExpressions: statusBuilderAnalysis.dependencies.length > 0,
    });

    if (statusBuilderAnalysis.dependencies.length > 0) {
      serializationLogger.debug('Using analyzed status mappings with CEL expressions', {
        fieldCount: Object.keys(statusBuilderAnalysis.statusMappings).length,
      });
      return statusBuilderAnalysis.statusMappings;
    }

    return statusMappings as Record<string, unknown>;
  } catch (analysisError: unknown) {
    serializationLogger.debug('Status builder analysis failed, using executed status mappings', {
      error: ensureError(analysisError).message,
    });
    return statusMappings as Record<string, unknown>;
  }
}

/**
 * Convert KubernetesRef objects in status mappings to CEL expressions.
 *
 * @internal
 */
function convertKubernetesRefsToCel(
  definitionName: string,
  statusMappings: Record<string, unknown> | MagicAssignableShape<KroCompatibleType>,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): { convertedStatusMappings: Record<string, unknown>; hasConversions: boolean } {
  const celConversionEngine = new CelConversionEngine();
  const convertedStatusMappings: Record<string, unknown> = {};
  let hasConversions = false;

  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    if (containsKubernetesRefs(fieldValue)) {
      const conversionResult = celConversionEngine.convertValue(
        fieldValue,
        { factoryType: 'kro', factoryName: definitionName, analysisEnabled: true },
        { factoryType: 'kro', preserveStatic: false }
      );

      if (conversionResult.wasConverted) {
        convertedStatusMappings[fieldName] = conversionResult.converted;
        hasConversions = true;
        serializationLogger.debug('Converted field to CEL expression', {
          fieldName,
          strategy: conversionResult.strategy,
          referencesConverted: conversionResult.metrics.referencesConverted,
        });
      } else {
        convertedStatusMappings[fieldName] = fieldValue;
      }
    } else {
      convertedStatusMappings[fieldName] = fieldValue;
    }
  }

  return { convertedStatusMappings, hasConversions };
}

/**
 * Log migration opportunities for existing CEL expressions.
 *
 * @internal
 */
function logMigrationOpportunities(
  statusMappings: Record<string, unknown> | MagicAssignableShape<KroCompatibleType>,
  preservedMappings: Record<string, unknown>,
  serializationLogger: ReturnType<ReturnType<typeof getComponentLogger>['child']>
): void {
  serializationLogger.debug(
    'Found existing CEL expressions, preserving for backward compatibility',
    {
      preservedCount: Object.keys(preservedMappings).length,
    }
  );

  try {
    const migrationHelper = new CelToJavaScriptMigrationHelper();
    const migrationAnalysis = migrationHelper.analyzeMigrationOpportunities(
      statusMappings as Record<string, unknown>
    );

    if (migrationAnalysis.migrationFeasibility.migratableExpressions > 0) {
      serializationLogger.info('Migration opportunities detected for CEL expressions', {
        totalExpressions: migrationAnalysis.migrationFeasibility.totalExpressions,
        migratableExpressions: migrationAnalysis.migrationFeasibility.migratableExpressions,
        overallConfidence: Math.round(
          migrationAnalysis.migrationFeasibility.overallConfidence * 100
        ),
      });

      const highConfidenceSuggestions = migrationAnalysis.suggestions.filter(
        (s) => s.confidence >= 0.8 && s.isSafe
      );
      if (highConfidenceSuggestions.length > 0) {
        serializationLogger.info('High-confidence migration suggestions available', {
          suggestions: highConfidenceSuggestions.map((s) => ({
            original: s.originalCel,
            suggested: s.suggestedJavaScript,
            confidence: Math.round(s.confidence * 100),
          })),
        });
      }
    }
  } catch (migrationError: unknown) {
    serializationLogger.error(
      'Failed to analyze migration opportunities',
      ensureError(migrationError)
    );
  }
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
  compositionAnalysis: CompositionAnalysisResult | null;
  /**
   * Mutable flag tracking whether `applyAnalysisToResources` has been called.
   * Wrapped in an object so Biome doesn't hoist it to `const`.
   */
  analysisState: { appliedToResources: boolean };
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
  let compositionAnalysis: CompositionAnalysisResult | null = null;
  const analysisState = { appliedToResources: false };

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
        analysisResults.statusMappings
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
  const { statusMappings, analyzedStatusMappings, mappingAnalysis } =
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

      const kroSchema = generateKroSchemaFromArktype(
        definition.name,
        schemaDefinition,
        resourcesWithKeys,
        optimizedStatusMappings
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
