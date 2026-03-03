/**
 * Core serialization functionality for TypeKro
 *
 * This module provides the main serialization functions to convert
 * TypeScript resource definitions to Kro ResourceGraphDefinition YAML manifests.
 */

import { containsKubernetesRefs, isCelExpression } from '../../utils/type-guards.js';
import { runInStatusBuilderContext } from '../composition/context.js';
import { DependencyResolver } from '../dependencies/index.js';
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
import { getResourceId } from '../resources/id.js';
import type {
  DeploymentClosure,
  DeploymentResourceGraph,
  FactoryForMode,
  FactoryOptions,
  ResourceGraphResource,
  TypedResourceGraph,
} from '../types/deployment.js';
import type {
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import type {
  DeployableK8sResource,
  Enhanced,
  KroCompatibleType,
  KubernetesResource,
} from '../types.js';
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
  HelmRelease: { apiVersion: 'helm.toolkit.fluxcd.io/v2beta1', kind: 'HelmRelease' },
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
  preservedExpressions: Record<string, any> = {},
  path: string = ''
): { hasExistingCel: boolean; preservedMappings: Record<string, any> } {
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
 * Check if a value contains any CelExpression objects
 */
function containsCelExpressions(value: unknown): boolean {
  if (isCelExpression(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsCelExpressions(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some((val) => containsCelExpressions(val));
  }

  return false;
}

/**
 * Merge preserved CEL expressions with analyzed mappings
 *
 * This ensures that existing CEL expressions take precedence over
 * newly analyzed JavaScript expressions for backward compatibility.
 */
function mergePreservedCelExpressions(
  analyzedMappings: Record<string, any>,
  preservedMappings: Record<string, any>
): Record<string, any> {
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
  const analysisDetails: Record<string, any> = {};

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

/**
 * Create a ResourceGraph from resources for deployment
 */
function _createResourceGraph(
  name: string,
  resources: Record<string, KubernetesResource>
): DeploymentResourceGraph {
  const dependencyResolver = new DependencyResolver();

  // Deduplicate resources by reference (same resource may have multiple keys)
  // This happens when resources are returned in status with variable names that differ from IDs
  const uniqueResourcesSet = new Set(Object.values(resources));

  const resourceArray = Array.from(uniqueResourcesSet).map((resource) => ({
    ...resource,
    id: getResourceId(resource),
  }));

  // Type assertion needed because we're converting KubernetesResource to DeployableK8sResource
  // This is safe because the deployment engine handles the conversion internally
  const deployableResources = resourceArray as DeployableK8sResource<Enhanced<unknown, unknown>>[];
  const dependencyGraph = dependencyResolver.buildDependencyGraph(deployableResources);

  // Convert to ResourceGraphResource format
  const resourceGraphResources: ResourceGraphResource[] = deployableResources.map((resource) => ({
    id: resource.id,
    manifest: resource,
  }));

  return {
    name,
    resources: resourceGraphResources,
    dependencyGraph,
  };
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
 * Create a typed resource graph implementation
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

  // Validate resource graph name early
  if (!definition.name || typeof definition.name !== 'string') {
    throw new ValidationError(
      `Invalid resource graph name: ${JSON.stringify(definition.name)}. Resource graph name must be a non-empty string.`,
      'ResourceGraphDefinition',
      String(definition.name),
      'name',
      ['Provide a non-empty string for the resource graph name']
    );
  }

  const trimmedName = definition.name.trim();
  if (trimmedName.length === 0) {
    throw new ValidationError(
      `Invalid resource graph name: Resource graph name cannot be empty or whitespace-only.`,
      'ResourceGraphDefinition',
      definition.name,
      'name',
      ['Provide a non-whitespace resource graph name']
    );
  }

  // Validate that the name will convert to a valid Kubernetes resource name
  const kubernetesName = trimmedName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(kubernetesName)) {
    throw new ValidationError(
      `Invalid resource graph name: "${definition.name}" converts to "${kubernetesName}" which is not a valid Kubernetes resource name. Names must consist of lowercase alphanumeric characters or '-', and must start and end with an alphanumeric character.`,
      'ResourceGraphDefinition',
      definition.name,
      'name',
      [
        'Use lowercase alphanumeric characters and hyphens only',
        'Must start and end with an alphanumeric character',
      ]
    );
  }

  if (kubernetesName.length > 253) {
    throw new ValidationError(
      `Invalid resource graph name: "${definition.name}" converts to "${kubernetesName}" which exceeds the 253 character limit for Kubernetes resource names.`,
      'ResourceGraphDefinition',
      definition.name,
      'name',
      ['Shorten the resource graph name to stay under 253 characters']
    );
  }

  // Apply default apiVersion if not specified
  // Note: This should be just the version part (e.g., 'v1alpha1'), not the full API version
  // The full API version (kro.run/v1alpha1) is constructed when creating instances
  const schemaDefinition: SchemaDefinition<TSpec, TStatus> = {
    apiVersion: definition.apiVersion || 'v1alpha1',
    kind: definition.kind,
    spec: definition.spec,
    status: definition.status,
  };

  const schema = createSchemaProxy<TSpec, TStatus>();
  const builderResult = resourceBuilder(schema);

  // Separate Enhanced<> resources from deployment closures
  const { resources: resourcesWithKeys, closures } = separateResourcesAndClosures(builderResult);

  // NEW: Analyze status builder for JavaScript expressions with KubernetesRef detection
  let statusMappings: MagicAssignableShape<TStatus>;
  let analyzedStatusMappings: Record<string, any> = {};
  let mappingAnalysis: ReturnType<typeof analyzeStatusMappingTypes>;
  let imperativeAnalysisSucceeded = false;

  try {
    // Execute the status builder in a context where Enhanced resource proxies
    // return KubernetesRef objects, enabling JavaScript-to-CEL conversion.
    statusMappings = runInStatusBuilderContext(() =>
      statusBuilder(schema, resourcesWithKeys as TResources)
    );

    // Check if this is from an imperative composition with original expressions
    // __originalCompositionFn is injected at runtime by imperative.ts (not part of the status schema)
    const originalCompositionFn = (statusMappings as Record<string, unknown>)
      .__originalCompositionFn as ((...args: unknown[]) => unknown) | undefined;

    // Debug logging removed for cleaner output

    if (originalCompositionFn) {
      serializationLogger.debug(
        'Detected imperative composition, checking for existing KubernetesRef objects'
      );

      // First, check if the status object already contains KubernetesRef objects or CelExpression objects
      // If so, we can use those directly instead of parsing the JavaScript source code
      let hasKubernetesRefs = containsKubernetesRefs(statusMappings);
      let hasCelExpressions = containsCelExpressions(statusMappings);
      const needsPreAnalysis =
        (statusMappings as Record<string, unknown>).__needsPreAnalysis === true;

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

        // Use the status builder analyzer to process the existing KubernetesRef objects
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
            analyzedStatusMappings = statusMappings;
            serializationLogger.debug('No conversion required, using original status mappings');
          }
        } catch (statusAnalysisError) {
          serializationLogger.debug(
            'Status builder analysis failed, falling back to imperative analysis',
            {
              error: ensureError(statusAnalysisError).message,
            }
          );
          // Fall back to imperative analysis
          hasKubernetesRefs = false;
          hasCelExpressions = false;
        }
      }

      if (!hasKubernetesRefs && !hasCelExpressions) {
        serializationLogger.debug(
          'No KubernetesRef objects or CelExpression objects found, analyzing original composition function'
        );

        // For imperative compositions, we need to analyze the original composition function
        // to detect JavaScript expressions that should be converted to CEL

        try {
          const imperativeAnalysis = analyzeImperativeComposition(
            originalCompositionFn,
            resourcesWithKeys as Record<string, Enhanced<any, any>>,
            { factoryType: 'kro' }
          );

          serializationLogger.debug('Imperative analysis result', {
            statusFieldCount: Object.keys(imperativeAnalysis.statusMappings).length,
            hasJavaScriptExpressions: imperativeAnalysis.hasJavaScriptExpressions,
            errorCount: imperativeAnalysis.errors.length,
          });

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
            analyzedStatusMappings = statusMappings;
            serializationLogger.debug(
              'No JavaScript expressions found, using original status mappings'
            );
          }
        } catch (imperativeAnalysisError) {
          serializationLogger.debug(
            'Imperative composition analysis failed, using executed status mappings',
            {
              error: ensureError(imperativeAnalysisError).message,
            }
          );
          analyzedStatusMappings = statusMappings;
        }
      }
    } else {
      // Regular status builder - try to analyze it directly
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
          analyzedStatusMappings = statusBuilderAnalysis.statusMappings;
          serializationLogger.debug('Using analyzed status mappings with CEL expressions', {
            fieldCount: Object.keys(analyzedStatusMappings).length,
          });
        } else {
          analyzedStatusMappings = statusMappings;
        }
      } catch (analysisError) {
        serializationLogger.debug(
          'Status builder analysis failed, using executed status mappings',
          {
            error: ensureError(analysisError).message,
          }
        );
        analyzedStatusMappings = statusMappings;
      }
    }

    // COMPREHENSIVE ANALYSIS: Analyze the final status mappings
    mappingAnalysis = analyzeStatusMappingTypes(analyzedStatusMappings);

    serializationLogger.debug('Final mapping analysis result', {
      kubernetesRefFields: mappingAnalysis.kubernetesRefFields.length,
      celExpressionFields: mappingAnalysis.celExpressionFields.length,
      staticValueFields: mappingAnalysis.staticValueFields.length,
      complexExpressionFields: mappingAnalysis.complexExpressionFields.length,
    });

    serializationLogger.debug('Status mapping analysis complete', {
      kubernetesRefFields: mappingAnalysis.kubernetesRefFields.length,
      celExpressionFields: mappingAnalysis.celExpressionFields.length,
      staticValueFields: mappingAnalysis.staticValueFields.length,
      complexExpressionFields: mappingAnalysis.complexExpressionFields.length,
    });

    // BACKWARD COMPATIBILITY: Detect and preserve existing CEL expressions
    const { hasExistingCel, preservedMappings } = detectAndPreserveCelExpressions(statusMappings);

    if (hasExistingCel) {
      serializationLogger.debug(
        'Found existing CEL expressions, preserving for backward compatibility',
        {
          preservedCount: Object.keys(preservedMappings).length,
        }
      );

      // MIGRATION HELPER: Provide migration suggestions for existing CEL expressions
      try {
        const migrationHelper = new CelToJavaScriptMigrationHelper();
        const migrationAnalysis = migrationHelper.analyzeMigrationOpportunities(statusMappings);

        if (migrationAnalysis.migrationFeasibility.migratableExpressions > 0) {
          serializationLogger.info('Migration opportunities detected for CEL expressions', {
            totalExpressions: migrationAnalysis.migrationFeasibility.totalExpressions,
            migratableExpressions: migrationAnalysis.migrationFeasibility.migratableExpressions,
            overallConfidence: Math.round(
              migrationAnalysis.migrationFeasibility.overallConfidence * 100
            ),
          });

          // Log migration suggestions for high-confidence migrations
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
      } catch (migrationError) {
        serializationLogger.error(
          'Failed to analyze migration opportunities',
          ensureError(migrationError)
        );
      }
    }

    // The issue is that JavaScript expressions are evaluated before we can analyze them
    // We need to re-execute the status builder with a special proxy that intercepts expressions
    // and converts them to CEL expressions before evaluation

    // For now, let's use a simpler approach: detect KubernetesRef objects in the raw status mappings
    // and convert them directly to CEL expressions
    const celConversionEngine = new CelConversionEngine();

    // Convert the status mappings to CEL expressions for Kro factories
    const convertedStatusMappings: Record<string, any> = {};
    let hasConversions = false;

    for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
      // Check if this field contains KubernetesRef objects
      if (containsKubernetesRefs(fieldValue)) {
        // Convert to CEL expression
        const conversionResult = celConversionEngine.convertValue(
          fieldValue,
          { factoryType: 'kro', factoryName: definition.name, analysisEnabled: true },
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
        // Keep static values as-is
        convertedStatusMappings[fieldName] = fieldValue;
      }
    }

    if (hasConversions) {
      // Only overwrite if imperative analysis hasn't already provided CEL expressions
      if (!imperativeAnalysisSucceeded) {
        // Merge converted CEL expressions with preserved ones (preserved take precedence)
        analyzedStatusMappings = mergePreservedCelExpressions(
          convertedStatusMappings,
          preservedMappings
        );
      }
      serializationLogger.debug('Successfully converted JavaScript expressions to CEL', {
        convertedFields: Object.keys(convertedStatusMappings).filter(
          (key) => convertedStatusMappings[key] !== (statusMappings as Record<string, unknown>)[key]
        ).length,
        preservedFields: Object.keys(preservedMappings).length,
        staticFields: mappingAnalysis.staticValueFields.length,
      });
    } else {
      // No KubernetesRef objects found, but may have existing CEL expressions or static values
      if (hasExistingCel) {
        // Only overwrite if imperative analysis hasn't already provided CEL expressions
        if (!imperativeAnalysisSucceeded) {
          // Merge original mappings with preserved CEL expressions
          analyzedStatusMappings = mergePreservedCelExpressions(statusMappings, preservedMappings);
        }
        serializationLogger.debug('Preserved existing CEL expressions without conversion', {
          preservedFields: Object.keys(preservedMappings).length,
          staticFields: mappingAnalysis.staticValueFields.length,
          complexFields: mappingAnalysis.complexExpressionFields.length,
        });
      } else {
        // No KubernetesRef objects or CEL expressions, use status mappings as-is
        if (!imperativeAnalysisSucceeded) {
          analyzedStatusMappings = statusMappings;
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
    }
  } catch (error) {
    serializationLogger.error('Failed to analyze status builder', ensureError(error));
    // Fallback to executing status builder normally
    statusMappings = runInStatusBuilderContext(() =>
      statusBuilder(schema, resourcesWithKeys as TResources)
    );
    analyzedStatusMappings = statusMappings;
    // Create empty analysis for fallback
    mappingAnalysis = {
      kubernetesRefFields: [],
      celExpressionFields: [],
      staticValueFields: [],
      complexExpressionFields: [],
      analysisDetails: {},
    };
  }

  // Kro v0.8.x: Analyze composition function body for control flow patterns
  // (if-statements → includeWhen, for-of loops → forEach, ternary → template overrides,
  //  collection aggregates → status overrides)
  // This MUST run before validation because:
  // 1. Stub resources need to exist before resource ID validation
  // 2. Status overrides (e.g. .map().join()) need to replace raw marker strings
  //    before CEL expression validation
  let compositionAnalysis: CompositionAnalysisResult | null = null;
  // Mutable flag: track whether applyAnalysisToResources has been called.
  // Wrapped in an object so Biome doesn't hoist it to `const`.
  const analysisState = { appliedToResources: false };
  const originalCompositionFnForAnalysis = (statusMappings as Record<string, unknown>)
    ?.__originalCompositionFn as ((...args: unknown[]) => unknown) | undefined;

  if (originalCompositionFnForAnalysis) {
    try {
      const resourceIds = new Set(Object.keys(resourcesWithKeys));
      compositionAnalysis = analyzeCompositionBody(originalCompositionFnForAnalysis, resourceIds);

      // Create stub resources for factory calls that weren't registered at runtime
      // (e.g., inside if-branches where the condition evaluated to false because
      // the schema proxy's value didn't match the comparison literal)
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

      // Apply status overrides to analyzedStatusMappings BEFORE validation.
      // These are collection aggregates (e.g. workers.map(w => w.metadata.name).join(', '))
      // and ternary expressions in the return statement that evaluated to literals at runtime
      // but should be CEL expressions in the Kro output.
      // Without this, the validator sees raw marker strings and rejects lambda variables
      // (like 'w') as non-existent resource references.
      if (compositionAnalysis.statusOverrides.length > 0) {
        for (const override of compositionAnalysis.statusOverrides) {
          analyzedStatusMappings[override.propertyPath] = override.celExpression;
          serializationLogger.debug('Applied status override before validation', {
            propertyPath: override.propertyPath,
            celExpression: override.celExpression,
          });
        }
      }
    } catch (analysisError) {
      serializationLogger.debug(
        'Composition body analysis failed (non-fatal), proceeding without control flow detection',
        { error: ensureError(analysisError).message }
      );
    }
  }

  // Validate resource IDs and CEL expressions
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

  // Log warnings if any
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

  // Log optimizations if any
  if (optimizations.length > 0) {
    serializationLogger.info('CEL expression optimizations applied', { optimizations });
  }

  // schemaDefinition is already created above with default apiVersion handling

  /**
   * Find a resource by key name in the resources map
   * This enables cross-composition magic proxy access like composition.database
   */
  function findResourceByKey(key: string | symbol): KubernetesResource | undefined {
    if (typeof key !== 'string') return undefined;

    // Strategy 1: Direct match by generated resource ID
    if (resourcesWithKeys[key]) {
      return resourcesWithKeys[key];
    }

    // Strategy 2: Smart pattern matching for common cases
    const keyLower = key.toLowerCase();
    const keyParts = key.split(/[-_]/).map((p) => p.toLowerCase()); // Split on hyphens and underscores

    for (const [resourceId, resource] of Object.entries(resourcesWithKeys)) {
      const kind = resource.kind.toLowerCase();
      // Handle case where metadata.name might be a KubernetesRef object
      let name = '';
      if (resource.metadata.name && typeof resource.metadata.name === 'string') {
        name = resource.metadata.name.toLowerCase();
      } else if (resource.metadata.name && typeof resource.metadata.name === 'object') {
        // Skip resources with unresolved references for now
        continue;
      }
      const resourceIdLower = resourceId.toLowerCase();

      // Pattern 1: Key parts match resource name parts
      // e.g., 'my-deployment' matches 'test-deployment' if 'deployment' appears in both
      const nameParts = name.split(/[-_]/).map((p) => p.toLowerCase());
      const hasCommonParts = keyParts.some((keyPart) =>
        nameParts.some((namePart) => keyPart.includes(namePart) || namePart.includes(keyPart))
      );

      if (hasCommonParts) {
        // Also check if the kinds match logically
        if (
          keyParts.includes(kind) ||
          (keyParts.includes('deployment') && kind === 'deployment') ||
          (keyParts.includes('service') && kind === 'service')
        ) {
          return resource;
        }
      }

      // Pattern 2: Key contains kind and resource ID contains resource name parts
      if (keyParts.includes(kind)) {
        const nameInResourceId = nameParts.some((part) => resourceIdLower.includes(part));
        if (nameInResourceId) {
          return resource;
        }
      }

      // Pattern 3: Common semantic patterns
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
          return resource;
        }
      }
    }

    // Strategy 3: Case-insensitive match on generated resource ID
    for (const [resourceKey, resource] of Object.entries(resourcesWithKeys)) {
      if (resourceKey.toLowerCase() === keyLower) {
        return resource;
      }
    }

    // Strategy 4: Partial matching - find resources that contain key parts in their ID
    for (const [resourceKey, resource] of Object.entries(resourcesWithKeys)) {
      const resourceKeyLower = resourceKey.toLowerCase();
      if (keyParts.some((part) => part.length > 2 && resourceKeyLower.includes(part))) {
        return resource;
      }
    }

    return undefined;
  }

  // Create a composition function that can re-execute with actual spec values.
  // This enables the direct factory to re-run the resource builder with real values
  // so that conditional branches (ternaries, if-statements, spread conditionals)
  // evaluate correctly — e.g., `schema.spec.enableRedis ? { redis: ... } : {}`
  // will actually skip the redis resource when enableRedis is false.
  const declarativeCompositionFn = (spec: TSpec): MagicAssignableShape<TStatus> => {
    // Create a plain schema object with actual values (not a magic proxy).
    // This means conditional checks like `schema.spec.enableRedis` will see
    // the real boolean value instead of a truthy KubernetesRef proxy.
    const actualSchema = { spec, status: {} } as SchemaProxy<TSpec, TStatus>;
    const resources = resourceBuilder(actualSchema);
    return statusBuilder(actualSchema, resources);
  };

  // Create the base TypedResourceGraph object
  // Deduplicate resources by reference (same resource may have multiple keys)
  // This happens when resources are returned in status with variable names that differ from IDs
  const uniqueResourcesSet = new Set(Object.values(resourcesWithKeys));

  const baseResourceGraph = {
    name: definition.name,
    resources: Array.from(uniqueResourcesSet),
    schema,
    // Store closures for access during factory creation
    closures,
    // Store composition function for re-execution with actual values (direct factory)
    _compositionFn: declarativeCompositionFn,
    _definition: definition,
    // Store analysis results for factory-specific processing
    _analysisResults: {
      mappingAnalysis,
      hasKubernetesRefs: mappingAnalysis.kubernetesRefFields.length > 0,
      statusMappings,
      analyzedStatusMappings,
    },

    factory<TMode extends 'kro' | 'direct'>(
      mode: TMode,
      factoryOptions?: FactoryOptions
    ): FactoryForMode<TMode, TSpec, TStatus> {
      if (mode === 'direct') {
        // For direct factory, we need to re-analyze status mappings with direct factory context
        let directStatusMappings = analyzedStatusMappings;

        if (this._analysisResults.hasKubernetesRefs) {
          try {
            serializationLogger.debug('Re-analyzing status mappings for direct factory pattern');
            const directStatusAnalyzer = new StatusBuilderAnalyzer(undefined, {
              factoryType: 'direct',
              performOptionalityAnalysis: true,
              includeSourceMapping: true,
            });
            const directAnalysisResult = directStatusAnalyzer.analyzeReturnObjectWithMagicProxy(
              this._analysisResults.statusMappings,
              resourcesWithKeys,
              schema
            );

            if (directAnalysisResult.errors.length === 0) {
              // Merge with preserved CEL expressions
              const { preservedMappings: directPreservedMappings } =
                detectAndPreserveCelExpressions(this._analysisResults.statusMappings);
              directStatusMappings = mergePreservedCelExpressions(
                directAnalysisResult.statusMappings,
                directPreservedMappings
              );
              serializationLogger.debug(
                'Successfully re-analyzed status mappings for direct factory'
              );
            }
          } catch (error) {
            serializationLogger.error(
              'Failed to re-analyze status mappings for direct factory, using default analysis',
              ensureError(error)
            );
          }
        }

        const directFactory = createDirectResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          statusBuilder,
          {
            ...factoryOptions,
            closures,
            // Pass the factory-specific status mappings
            statusMappings: directStatusMappings,
            // Pass composition function for re-execution with actual values
            // Use closure-captured variables directly instead of (this as any) to maintain type safety
            compositionFn: declarativeCompositionFn,
            compositionDefinition: definition,
          }
        );
        return directFactory as FactoryForMode<TMode, TSpec, TStatus>;
      } else if (mode === 'kro') {
        // For Kro factory, use the already analyzed status mappings (which default to Kro pattern)
        const kroFactory = createKroResourceFactory<TSpec, TStatus>(
          definition.name,
          resourcesWithKeys,
          schemaDefinition,
          analyzedStatusMappings,
          {
            ...factoryOptions,
            closures,
            // Indicate this is for Kro factory pattern
            factoryType: 'kro',
          }
        );
        return kroFactory as FactoryForMode<TMode, TSpec, TStatus>;
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
      // Kro v0.8.x: Use the pre-computed composition body analysis.
      // The analysis was run in createTypedResourceGraph() BEFORE validation
      // so that stub resources and status overrides are available for validation.
      // Here we apply resource directives (includeWhen, forEach, readyWhen)
      // and template overrides to the resources before YAML serialization.
      // Guard: only apply once even if toYaml() is called multiple times.
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

      // Generate ResourceGraphDefinition YAML with user-defined status mappings
      const kroSchema = generateKroSchemaFromArktype(
        definition.name,
        schemaDefinition,
        resourcesWithKeys,
        optimizedStatusMappings
      );

      // Kro v0.8.x: set custom API group on schema if provided
      if (definition.group) {
        kroSchema.group = definition.group;
      }

      // Inject status overrides directly into the schema status section.
      // These are ternary expressions that evaluated to literals at runtime
      // but should be CEL conditionals in the Kro YAML output.
      // We inject here (not into optimizedStatusMappings) because the
      // separateStatusFields classifier treats schema-only CEL as "static"
      // and filters it out.
      // Convert double quotes to single quotes in CEL string literals to avoid
      // js-yaml double-quote escaping issues (quotingType: '"' causes inner
      // double quotes to be backslash-escaped, breaking the CEL expression).
      const statusOverrides = compositionAnalysis?.statusOverrides ?? [];
      if (statusOverrides.length > 0) {
        if (!kroSchema.status) {
          kroSchema.status = {};
        }
        for (const override of statusOverrides) {
          // Convert "..." to '...' in CEL string literals for YAML compatibility
          const yamlSafe = override.celExpression.replace(/"([^"\\]*)"/g, "'$1'");
          kroSchema.status[override.propertyPath] = yamlSafe;
        }
      }

      return serializeResourceGraphToYaml(definition.name, resourcesWithKeys, options, kroSchema);
    },
  };

  // Wrap with cross-composition magic proxy for resource access
  return new Proxy(baseResourceGraph, {
    get(target, prop, receiver) {
      // Handle existing properties normally
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      // For unknown properties, check if it's a resource key and create external ref
      const matchingResource = findResourceByKey(prop);
      if (matchingResource?.metadata.name) {
        return createExternalRefWithoutRegistration(
          matchingResource.apiVersion,
          matchingResource.kind,
          matchingResource.metadata.name,
          matchingResource.metadata.namespace
        );
      }

      // Return undefined for non-existent properties (standard JavaScript behavior)
      return undefined;
    },

    // Ensure proper enumeration of properties
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    // Ensure proper property descriptor handling
    getOwnPropertyDescriptor(target, prop) {
      // For existing properties, return normal descriptor
      if (prop in target) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }

      // For resource properties, indicate they exist but are not enumerable
      const matchingResource = findResourceByKey(prop);
      if (matchingResource) {
        return {
          configurable: true,
          enumerable: false, // Don't enumerate resource properties in for..in loops
          value: undefined, // Value will be computed by get trap
        };
      }

      return undefined;
    },
  }) as TypedResourceGraph<TSpec, TStatus>;
}
