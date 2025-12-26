/**
 * Imperative Composition Pattern Implementation
 *
 * This module provides the kubernetesComposition function that enables
 * developers to write natural, imperative JavaScript functions while
 * automatically generating the same robust, type-safe ResourceGraphDefinitions
 * as the existing toResourceGraph API.
 */

import type { CompositionContext } from '../../factories/shared.js';
import {
  createCompositionContext,
  getCurrentCompositionContext,
  runWithCompositionContext,
} from '../../factories/shared.js';
import { CompositionDebugger, CompositionExecutionError } from '../errors.js';
import {
  CALLABLE_COMPOSITION_BRAND,
  KUBERNETES_REF_BRAND,
  NESTED_COMPOSITION_BRAND,
} from '../constants/brands.js';
import { toResourceGraph } from '../serialization/core.js';
import type { TypedResourceGraph, CallableComposition } from '../types/deployment.js';

import type {
  KroCompatibleType,
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import type { Enhanced } from '../types.js';

/**
 * Enable debug mode for composition execution
 * This will log detailed information about resource registration, status building, and performance
 */
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
  compositionFn: (spec: TSpec) => TStatus | MagicAssignableShape<TStatus>,
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
function executeNestedCompositionWithSpec<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => TStatus | MagicAssignableShape<TStatus>,
  options: SerializationOptions | undefined,
  parentContext: CompositionContext,
  spec: TSpec,
  compositionName: string
): any {
  CompositionDebugger.log(
    'NESTED_COMPOSITION',
    `Executing nested composition with spec: ${compositionName}`
  );

  // Create a unique context for this nested composition execution
  const uniqueExecutionName = `${compositionName}-execution-${++globalCompositionCounter}`;
  const executionContext = createCompositionContext(uniqueExecutionName);

  // Execute the composition with the provided spec
  const result = runWithCompositionContext(executionContext, () => {
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
  let baseName = compositionName;
  if (baseName.endsWith('-composition')) {
    baseName = baseName.slice(0, -'-composition'.length);
  }
  const baseId = `${baseName}${instanceNumber}`;

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

  // Create a NestedCompositionResource to return
  // This is what enables: const db = databaseComposition({ name: 'mydb' }); db.spec; db.status.ready
  const nestedCompositionResource = {
    [NESTED_COMPOSITION_BRAND]: true,
    spec,
    status: createStatusProxy<TStatus>(baseId, parentContext, result),
    __compositionId: uniqueExecutionName,
    __resources: result.resources,
  };

  return nestedCompositionResource;
}

/**
 * Create a status proxy for cross-composition references
 * @param compositionName - Name of the composition
 * @param parentContext - Parent composition context (if nested)
 * @param nestedResult - The result of executing the nested composition
 * @param forCompositionProperty - If true, create KubernetesRef proxy for composition.status; if false, create for call result
 */
function createStatusProxy<_TStatus>(
  compositionName: string,
  parentContext: CompositionContext | null,
  nestedResult?: TypedResourceGraph<any, any>,
  forCompositionProperty: boolean = false
): any {
  // For CallableComposition.status property, always return KubernetesRef-based proxy
  // This enables cross-composition references like: const ready = otherComposition.status.ready
  if (forCompositionProperty) {
    const resourceId = compositionName;

    function createRecursiveProxy(basePath: string): any {
      const baseObj: any = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId,
        fieldPath: basePath,
        __nestedComposition: true,
      };

      return new Proxy(baseObj, {
        get(target, prop) {
          if (prop in target) {
            return target[prop];
          }

          if (typeof prop === 'string') {
            const fullPath = basePath ? `${basePath}.${prop}` : prop;
            return createRecursiveProxy(fullPath);
          }

          return undefined;
        },
      });
    }

    return createRecursiveProxy('status');
  }

  // For nested composition call results within a parent context,
  // create a recursive proxy that returns KubernetesRef objects
  // This enables deep property access like nested.status.metadata.name
  if (parentContext) {
    const resourceId = compositionName;

    function createRecursiveProxy(basePath: string): any {
      const baseObj: any = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId,
        fieldPath: basePath,
        __nestedComposition: true,
      };

      return new Proxy(baseObj, {
        get(target, prop) {
          if (prop in target) {
            return target[prop];
          }

          if (typeof prop === 'string') {
            const fullPath = basePath ? `${basePath}.${prop}` : prop;
            return createRecursiveProxy(fullPath);
          }

          return undefined;
        },
      });
    }

    return createRecursiveProxy('status');
  }

  // For top-level composition calls (no parent context),
  // create a proxy that returns KubernetesRef objects
  const resourceId = `${compositionName}-status`;

  function createRecursiveProxy(basePath: string): any {
    const baseObj: any = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId,
      fieldPath: basePath,
      __nestedComposition: true,
    };

    return new Proxy(baseObj, {
      get(target, prop) {
        // Only return the actual KubernetesRef metadata properties
        // Don't intercept other property accesses - let them create nested proxies
        if (
          prop === KUBERNETES_REF_BRAND ||
          prop === 'resourceId' ||
          prop === 'fieldPath' ||
          prop === '__nestedComposition'
        ) {
          return target[prop];
        }

        // For any other string property, create a nested proxy to support deep access like status.metadata.name
        if (typeof prop === 'string') {
          const fullPath = basePath ? `${basePath}.${prop}` : prop;
          return createRecursiveProxy(fullPath);
        }

        return undefined;
      },
    });
  }

  return createRecursiveProxy('');
}

/**
 * Global composition counter for unique identifier generation
 */
let globalCompositionCounter = 0;

/**
 * Creates a hybrid spec object that provides actual values for JavaScript logic
 * while still generating CEL expressions when needed for serialization
 */
function _createHybridSpec<TSpec extends KroCompatibleType>(
  actualSpec: TSpec,
  schemaProxy: TSpec
): TSpec {
  // For primitive values, return the actual value directly
  if (typeof actualSpec !== 'object' || actualSpec === null) {
    return actualSpec;
  }

  // Create a proxy that intelligently returns actual values or proxy values
  // based on the context of access
  return new Proxy(actualSpec, {
    get(target, prop) {
      const actualValue = target[prop as keyof TSpec];
      const proxyValue = schemaProxy[prop as keyof TSpec];

      // For nested objects, create hybrid recursively
      if (
        typeof actualValue === 'object' &&
        actualValue !== null &&
        typeof proxyValue === 'object'
      ) {
        return _createHybridSpec(actualValue as any, proxyValue);
      }

      // Return actual values for JavaScript operations
      // The serialization system will analyze the original composition function
      // and generate CEL expressions from the schema proxy separately
      return actualValue;
    },
  }) as TSpec;
}

/**
 * Core composition execution logic shared between nested and top-level compositions
 */
function executeCompositionCore<TSpec extends KroCompatibleType, TStatus extends KroCompatibleType>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => TStatus | MagicAssignableShape<TStatus>,
  options: SerializationOptions | undefined,
  context: CompositionContext,
  compositionName: string,
  actualSpec?: TSpec
): TypedResourceGraph<TSpec, TStatus> {
  const startTime = Date.now();

  // Declare capturedStatus here so it's accessible to both resource and status builders
  let capturedStatus: TStatus | MagicAssignableShape<TStatus> | undefined;

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

    const _resourceBuildStart = Date.now();

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

          // Execute the composition function in a special context that preserves KubernetesRef objects
          // This allows JavaScript expressions to be converted to CEL during serialization
          (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__ = true;

          try {
            // Use the actual spec directly when provided, otherwise use schema spec
            const specToUse = actualSpec || (schema.spec as TSpec);
            capturedStatus = compositionFn(specToUse) as MagicAssignableShape<TStatus>;

            // Store the original composition function for later analysis
            // This allows the serialization system to analyze the original JavaScript expressions
            (capturedStatus as any).__originalCompositionFn = compositionFn;
            (capturedStatus as any).__originalSchema = schema.spec;

            // Debug logging removed for cleaner output
          } finally {
            // Always clean up the global flag
            delete (globalThis as any).__TYPEKRO_STATUS_BUILDER_CONTEXT__;
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

          // Add deployment closures (cast them as Enhanced resources for compatibility)
          for (const [id, closure] of Object.entries(context.closures)) {
            combined[id] = closure as Enhanced<unknown, unknown>;
          }

          return combined;
        } catch (error) {
          throw CompositionExecutionError.withResourceContext(
            `Failed to execute composition function: ${error instanceof Error ? error.message : String(error)}`,
            compositionName,
            'resource-creation',
            'composition-function',
            'composition',
            'kubernetesComposition',
            error instanceof Error ? error : undefined
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
            throw new Error('Status was not captured during resource building phase');
          }
          return capturedStatus;
        } catch (error) {
          if (error instanceof CompositionExecutionError) {
            throw error;
          }

          throw CompositionExecutionError.forStatusBuilding(
            compositionName,
            'status-object',
            'MagicAssignableShape<TStatus>',
            capturedStatus,
            error instanceof Error ? error : undefined
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
    } catch (error) {
      // If we can't add properties to the result object, log a warning but continue
      console.warn('Could not store composition function for re-execution:', error);
    }

    return result;
  } catch (error) {
    const endTime = Date.now();
    CompositionDebugger.logPerformanceMetrics('Failed Composition', startTime, endTime, {
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof CompositionExecutionError) {
      throw error;
    }

    throw new CompositionExecutionError(
      `Composition execution failed: ${error instanceof Error ? error.message : String(error)}`,
      compositionName,
      'context-setup',
      undefined,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Create an imperative composition that automatically captures resources
 * and returns status objects using MagicAssignableShape
 *
 * @param definition - The resource graph definition with schemas
 * @param compositionFn - Synchronous function that takes spec and returns MagicAssignableShape<TStatus>
 * @param options - Optional serialization options
 * @returns TypedResourceGraph directly (not a factory)
 */
export function kubernetesComposition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => TStatus | MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): CallableComposition<TSpec, TStatus> {
  const compositionName = definition.name || 'unnamed-composition';

  // Check if we're being called within another composition context
  const parentContext = getCurrentCompositionContext();

  if (parentContext) {
    // We're nested within another composition - merge our resources into the parent context
    // and return a CallableComposition that can be called with a spec
    const nestedResult = executeNestedComposition(
      definition,
      compositionFn,
      options,
      parentContext,
      compositionName
    );

    // Create a callable composition that can be invoked with a spec
    const callableComposition = ((spec: TSpec) => {
      // When called with a spec, execute the nested composition with that spec
      return executeNestedCompositionWithSpec(
        definition,
        compositionFn,
        options,
        parentContext,
        spec,
        compositionName
      );
    }) as CallableComposition<TSpec, TStatus>;

    // Copy properties from the TypedResourceGraph to the callable composition
    // Preserve original property descriptors to maintain non-writable metadata properties
    // Use getOwnPropertyNames to include non-enumerable properties like _compositionFn
    for (const key of Object.getOwnPropertyNames(nestedResult)) {
      const descriptor = Object.getOwnPropertyDescriptor(nestedResult, key);
      if (descriptor) {
        Object.defineProperty(callableComposition, key, descriptor);
      }
    }

    // Add the status proxy for cross-composition references
    // Use forCompositionProperty=true to get KubernetesRef-based proxy
    Object.defineProperty(callableComposition, 'status', {
      value: createStatusProxy<TStatus>(compositionName, parentContext, nestedResult, true),
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
      value: function () {
        const obj: any = {};
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
      [NESTED_COMPOSITION_BRAND]: true,
      spec,
      status: createStatusProxy<TStatus>(compositionName, null as any, callResult),
      __compositionId: callCompositionName,
      __resources: callResult.resources,
    };
  }) as any; // Type assertion to avoid complex typing

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
    value: function () {
      const obj: any = {};
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
