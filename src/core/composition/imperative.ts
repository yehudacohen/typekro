/**
 * Imperative Composition Pattern Implementation
 *
 * This module provides the kubernetesComposition function that enables
 * developers to write natural, imperative JavaScript functions while
 * automatically generating the same robust, type-safe ResourceGraphDefinitions
 * as the existing toResourceGraph API.
 */

import type { CompositionContext } from '../../factories/shared.js';
import { runWithCompositionContext, createCompositionContext, getCurrentCompositionContext } from '../../factories/shared.js';
import { toResourceGraph } from '../serialization/core.js';
import type {
  KroCompatibleType,
  MagicAssignableShape,
  ResourceGraphDefinition,
  SchemaProxy,
  SerializationOptions,
} from '../types/serialization.js';
import type { TypedResourceGraph } from '../types/deployment.js';
import type { Enhanced } from '../types.js';
import {
  CompositionExecutionError,
  CompositionDebugger,
  UnsupportedPatternDetector
} from '../errors.js';





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
    return executeCompositionCore(definition, compositionFn, options, nestedContext, uniqueNestedName);
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

  CompositionDebugger.log('NESTED_COMPOSITION', 
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
    mergedClosureIds
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
 * Global composition counter for unique identifier generation
 */
let globalCompositionCounter = 0;

/**
 * Core composition execution logic shared between nested and top-level compositions
 */
function executeCompositionCore<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
>(
  definition: ResourceGraphDefinition<TSpec, TStatus>,
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  options: SerializationOptions | undefined,
  context: CompositionContext,
  compositionName: string
): TypedResourceGraph<TSpec, TStatus> {
  const startTime = Date.now();

  try {
    CompositionDebugger.logCompositionStart(compositionName);

    // Override addResource to include debug logging
    const originalAddResource = context.addResource;
    context.addResource = function(id: string, resource: Enhanced<any, any>) {
      originalAddResource.call(this, id, resource);
      
      // Log resource registration for debugging
      const resourceKind = (resource as any)?.kind || 'unknown';
      CompositionDebugger.logResourceRegistration(id, resourceKind, 'factory-function');
    };

    // Execute the composition function once to collect both resources and status
    let capturedStatus: MagicAssignableShape<TStatus> | undefined;

    const resourceBuildStart = Date.now();

    const result = toResourceGraph(
      definition,
      // Resource builder - execute composition to collect resources
      (schema: SchemaProxy<TSpec, TStatus>) => {
        try {
          CompositionDebugger.log('RESOURCE_BUILDING', 'Executing composition function');

          // Execute the composition function to trigger resource registration and capture status
          capturedStatus = compositionFn(schema.spec as TSpec) as MagicAssignableShape<TStatus>;

          const resourceBuildEnd = Date.now();
          CompositionDebugger.logPerformanceMetrics(
            'Resource Building',
            resourceBuildStart,
            resourceBuildEnd,
            { 
              resourceCount: Object.keys(context.resources).length,
              closureCount: Object.keys(context.closures).length
            }
          );

          // Create a combined object that separateResourcesAndClosures can handle
          // Use the resource IDs as keys for resources, and closure IDs as keys for closures
          const combined: Record<string, any> = {};
          
          // Add Enhanced resources
          for (const [id, resource] of Object.entries(context.resources)) {
            combined[id] = resource;
          }
          
          // Add deployment closures
          for (const [id, closure] of Object.entries(context.closures)) {
            combined[id] = closure;
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
      (schema: SchemaProxy<TSpec, TStatus>, _resources: Record<string, Enhanced<any, any>>) => {
        try {
          CompositionDebugger.log('STATUS_BUILDING', 'Processing captured status object');

          // Note: Pattern validation is disabled during normal operation
          // as resource references appear as functions before serialization
          // Pattern validation should be done at a different stage if needed

          CompositionDebugger.logStatusValidation(
            compositionName,
            capturedStatus,
            'success'
          );

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

    const endTime = Date.now();
    const statusFields = capturedStatus ? Object.keys(capturedStatus) : [];

    CompositionDebugger.logCompositionEnd(
      compositionName,
      Object.keys(context.resources).length + Object.keys(context.closures).length,
      statusFields
    );

    CompositionDebugger.logPerformanceMetrics(
      'Total Composition',
      startTime,
      endTime,
      {
        resourceCount: Object.keys(context.resources).length,
        closureCount: Object.keys(context.closures).length,
        statusFieldCount: statusFields.length
      }
    );

    return result;
  } catch (error) {
    const endTime = Date.now();
    CompositionDebugger.logPerformanceMetrics(
      'Failed Composition',
      startTime,
      endTime,
      { error: error instanceof Error ? error.message : String(error) }
    );

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
  compositionFn: (spec: TSpec) => MagicAssignableShape<TStatus>,
  options?: SerializationOptions
): TypedResourceGraph<TSpec, TStatus> {
  const compositionName = definition.name || 'unnamed-composition';

  // Check if we're being called within another composition context
  const parentContext = getCurrentCompositionContext();
  
  if (parentContext) {
    // We're nested within another composition - merge our resources into the parent context
    return executeNestedComposition(definition, compositionFn, options, parentContext, compositionName);
  }

  // Execute the composition immediately and return the TypedResourceGraph
  const uniqueCompositionName = `${compositionName}-${++globalCompositionCounter}`;
  const context = createCompositionContext(uniqueCompositionName);
  return runWithCompositionContext(context, () => {
    return executeCompositionCore(definition, compositionFn, options, context, uniqueCompositionName);
  });
}