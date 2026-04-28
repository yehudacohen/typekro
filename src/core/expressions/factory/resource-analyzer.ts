/**
 * Resource Builder Integration for JavaScript to CEL Expression Conversion
 *
 * This module provides integration with TypeKro's existing KubernetesRef and magic proxy systems
 * for analyzing resource configurations that contain JavaScript expressions with KubernetesRef objects.
 *
 * The analyzer detects when resource builders use expressions that depend on other resources
 * and converts them to appropriate CEL expressions based on the factory pattern.
 */

import { containsKubernetesRefs, isKubernetesRef } from '../../../utils/type-guards.js';
import { ConversionError, ensureError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import type { SchemaProxy } from '../../types/serialization.js';
import { type AnalysisContext, JavaScriptToCelAnalyzer } from '../analysis/analyzer.js';
import { SourceMapBuilder } from '../analysis/source-map.js';
import {
  type CircularDependencyAnalysis,
  type DependencyGraph,
  type DependencyInfo,
  DependencyTracker,
} from './dependency-tracker.js';
import {
  type ResourceTypeInfo,
  type ResourceTypeValidationContext,
  type ResourceTypeValidationResult,
  ResourceTypeValidator,
  type SchemaValidator,
} from './resource-type-validator.js';

// Re-export all types from extracted modules for backward compatibility
export type {
  CircularChainAnalysis,
  CircularDependencyAnalysis,
  CircularDependencyRecommendation,
  DependencyGraph,
  DependencyInfo,
  DependencyTrackingOptions,
} from './dependency-tracker.js';
export type {
  FieldPathValidationResult,
  ResourceTypeInfo,
  ResourceTypeValidationContext,
  ResourceTypeValidationResult,
  SchemaFieldValidationResult,
  SchemaValidator,
  TypeCompatibilityValidationResult,
} from './resource-type-validator.js';

/**
 * Context for analyzing resource configurations
 */
export interface ResourceAnalysisContext extends AnalysisContext {
  /** The resource being analyzed */
  resourceId: string;

  /** The resource configuration being analyzed */
  resourceConfig: Record<string, unknown>;

  /** Other resources available for cross-resource references */
  availableResources?: Record<string, Enhanced<unknown, unknown>>;

  /** Whether to validate resource types during analysis */
  validateResourceTypes?: boolean;
}

/**
 * Result of analyzing a resource configuration
 */
export interface ResourceAnalysisResult {
  /** The original resource configuration */
  originalConfig: Record<string, unknown>;

  /** The processed configuration with CEL expressions */
  processedConfig: Record<string, unknown>;

  /** All KubernetesRef dependencies found in the configuration */
  dependencies: KubernetesRef<unknown>[];

  /** Fields that required conversion */
  convertedFields: string[];

  /** Analysis errors encountered */
  errors: ConversionError[];

  /** Whether any conversion was needed */
  requiresConversion: boolean;

  /** Circular dependency chains detected */
  circularDependencies: string[][];

  /** Resource type validation results */
  typeValidationResults: ResourceTypeValidationResult[];
}

/**
 * Analyzes resource configurations for JavaScript expressions containing KubernetesRef objects
 */
export class ResourceAnalyzer {
  private analyzer: JavaScriptToCelAnalyzer;
  private dependencyTracker: DependencyTracker;
  private typeValidator: ResourceTypeValidator;

  constructor() {
    this.analyzer = new JavaScriptToCelAnalyzer();
    this.dependencyTracker = new DependencyTracker();
    this.typeValidator = new ResourceTypeValidator();
  }

  /**
   * Analyze a resource configuration for KubernetesRef-dependent expressions
   * This is the main entry point for resource builder integration
   */
  analyzeResourceConfig(
    resourceId: string,
    config: Record<string, unknown>,
    context: ResourceAnalysisContext
  ): ResourceAnalysisResult {
    const result: ResourceAnalysisResult = {
      originalConfig: config,
      processedConfig: {},
      dependencies: [],
      convertedFields: [],
      errors: [],
      requiresConversion: false,
      circularDependencies: [],
      typeValidationResults: [],
    };

    try {
      // Deep analyze the configuration object
      result.processedConfig = this.analyzeConfigObject(config, '', context, result) as Record<string, unknown>;

      // Track dependencies automatically
      const _dependencyInfos = this.dependencyTracker.trackDependencies(
        resourceId,
        result.dependencies,
        result.convertedFields,
        {
          trackSchemaDependencies: true,
          trackResourceDependencies: true,
          trackExternalDependencies: true,
          detectCircularDependencies: true,
          computeDeploymentOrder: true,
        }
      );

      // Get circular dependencies from tracker
      result.circularDependencies = this.dependencyTracker.getDependencyGraph().circularChains;

      // Validate resource types if requested
      if (context.validateResourceTypes) {
        result.typeValidationResults = this.validateResourceTypes(result.dependencies, context);
      }

      // Set overall conversion flag
      result.requiresConversion = result.convertedFields.length > 0;
    } catch (error: unknown) {
      result.errors.push(
        new ConversionError(
          `Failed to analyze resource config: ${ensureError(error).message}`,
          JSON.stringify(config),
          'unknown'
        )
      );
    }

    return result;
  }

  /**
   * Recursively analyze a configuration object for KubernetesRef objects
   */
  private analyzeConfigObject(
    obj: unknown,
    fieldPath: string,
    context: ResourceAnalysisContext,
    result: ResourceAnalysisResult
  ): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // Check if this value contains KubernetesRef objects
    if (!containsKubernetesRefs(obj)) {
      // No KubernetesRef objects - return as-is for performance
      return obj;
    }

    // Handle direct KubernetesRef objects
    if (isKubernetesRef(obj)) {
      return this.convertKubernetesRefInConfig(obj, fieldPath, context, result);
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map((item, index) =>
        this.analyzeConfigObject(item, `${fieldPath}[${index}]`, context, result)
      );
    }

    // Handle objects
    if (typeof obj === 'object') {
      const processedObj: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(obj)) {
        const currentFieldPath = fieldPath ? `${fieldPath}.${key}` : key;
        processedObj[key] = this.analyzeConfigObject(value, currentFieldPath, context, result);
      }

      return processedObj;
    }

    // Handle primitive values that might be expressions
    if (typeof obj === 'string' && this.looksLikeExpression(obj)) {
      return this.analyzeStringExpression(obj, fieldPath, context, result);
    }

    return obj;
  }

  /**
   * Convert a KubernetesRef object in a resource configuration
   */
  private convertKubernetesRefInConfig(
    ref: KubernetesRef<unknown>,
    fieldPath: string,
    context: ResourceAnalysisContext,
    result: ResourceAnalysisResult
  ): CelExpression | unknown {
    try {
      // Track this dependency
      result.dependencies.push(ref);
      result.convertedFields.push(fieldPath);

      // Create analysis context for this KubernetesRef
      const analysisContext: AnalysisContext = {
        type: 'resource',
        availableReferences: context.availableResources || {},
        factoryType: context.factoryType,
        sourceMap: new SourceMapBuilder(),
        dependencies: [],
        ...(context.schemaProxy && { schemaProxy: context.schemaProxy }),
      };

      // Convert the KubernetesRef to CEL
      const celExpression = this.analyzer.convertKubernetesRefToCel(ref, analysisContext);

      // Add any additional dependencies found during conversion
      result.dependencies.push(...(analysisContext.dependencies || []));

      return celExpression;
    } catch (error: unknown) {
      const conversionError = new ConversionError(
        `Failed to convert KubernetesRef at ${fieldPath}: ${ensureError(error).message}`,
        `${ref.resourceId}.${ref.fieldPath}`,
        'member-access'
      );

      result.errors.push(conversionError);

      // Return the original ref on error
      return ref;
    }
  }

  /**
   * Analyze string expressions that might contain KubernetesRef objects
   */
  private analyzeStringExpression(
    expression: string,
    fieldPath: string,
    context: ResourceAnalysisContext,
    result: ResourceAnalysisResult
  ): string | CelExpression {
    try {
      // Create analysis context
      const analysisContext: AnalysisContext = {
        type: 'resource',
        availableReferences: context.availableResources || {},
        factoryType: context.factoryType,
        sourceMap: new SourceMapBuilder(),
        dependencies: [],
        sourceText: expression,
        ...(context.schemaProxy && { schemaProxy: context.schemaProxy }),
      };

      // Analyze the expression
      const conversionResult = this.analyzer.analyzeExpression(expression, analysisContext);

      if (conversionResult.valid && conversionResult.requiresConversion) {
        // Track dependencies and converted fields
        result.dependencies.push(...conversionResult.dependencies);
        result.convertedFields.push(fieldPath);
        result.errors.push(...conversionResult.errors);

        // celExpression is non-null when valid && requiresConversion
        return conversionResult.celExpression ?? expression;
      }

      // No conversion needed or failed - return original
      result.errors.push(...conversionResult.errors);
      return expression;
    } catch (error: unknown) {
      const conversionError = new ConversionError(
        `Failed to analyze expression at ${fieldPath}: ${ensureError(error).message}`,
        expression,
        'javascript'
      );

      result.errors.push(conversionError);
      return expression;
    }
  }

  /**
   * Check if a string looks like a JavaScript expression
   */
  private looksLikeExpression(str: string): boolean {
    // Look for common expression patterns
    return (
      str.includes('${') || // Template literals
      str.includes('?.') || // Optional chaining
      str.includes('||') || // Logical OR
      str.includes('&&') || // Logical AND
      str.includes('??') || // Nullish coalescing
      /\w+\.\w+/.test(str) // Property access
    );
  }

  /**
   * Validate resource types for KubernetesRef objects
   */
  private validateResourceTypes(
    dependencies: KubernetesRef<unknown>[],
    context: ResourceAnalysisContext
  ): ResourceTypeValidationResult[] {
    const validationContext: ResourceTypeValidationContext = {
      strictTypeChecking: context.validateResourceTypes || false,
      ...(context.availableResources && { availableResources: context.availableResources }),
      ...(context.schemaProxy && { schemaProxy: context.schemaProxy }),
    };

    return dependencies.map((dep) =>
      this.typeValidator.validateKubernetesRef(dep, validationContext)
    );
  }

  /**
   * Get dependency information for a resource
   */
  getDependencyInfo(resourceId: string): DependencyInfo[] {
    return this.dependencyTracker.getDependencies(resourceId);
  }

  /**
   * Get the full dependency graph
   */
  getDependencyGraph(): DependencyGraph {
    return this.dependencyTracker.getDependencyGraph();
  }

  /**
   * Get resources that depend on a specific resource
   */
  getDependents(resourceId: string): string[] {
    return this.dependencyTracker.getDependents(resourceId);
  }

  /**
   * Check if there are circular dependencies
   */
  hasCircularDependencies(): boolean {
    return this.dependencyTracker.hasCircularDependencies();
  }

  /**
   * Get the recommended deployment order
   */
  getDeploymentOrder(): string[] {
    return this.dependencyTracker.getDeploymentOrder();
  }

  /**
   * Perform advanced circular dependency analysis
   * This provides detailed analysis and recommendations for resolving circular dependencies
   */
  analyzeCircularDependencies(): CircularDependencyAnalysis {
    return this.dependencyTracker.detectCircularDependencyChains();
  }

  /**
   * Get the resource type validator
   */
  getTypeValidator(): ResourceTypeValidator {
    return this.typeValidator;
  }

  /**
   * Register a custom schema validator
   */
  registerSchemaValidator(schemaType: string, validator: SchemaValidator): void {
    this.typeValidator.registerSchemaValidator(schemaType, validator);
  }

  /**
   * Register a custom resource type
   */
  registerResourceType(name: string, typeInfo: ResourceTypeInfo): void {
    this.typeValidator.registerResourceType(name, typeInfo);
  }

  /**
   * Validate a single KubernetesRef for type correctness
   */
  validateKubernetesRef(
    ref: KubernetesRef<unknown>,
    context: ResourceTypeValidationContext
  ): ResourceTypeValidationResult {
    return this.typeValidator.validateKubernetesRef(ref, context);
  }
}

/**
 * Convenience function for analyzing resource configurations
 * This is the main entry point for resource builder integration
 */
export function analyzeResourceConfig(
  resourceId: string,
  config: Record<string, unknown>,
  context: Omit<ResourceAnalysisContext, 'resourceId' | 'resourceConfig'>
): ResourceAnalysisResult {
  const analyzer = new ResourceAnalyzer();

  const fullContext: ResourceAnalysisContext = {
    ...context,
    resourceId,
    resourceConfig: config,
  };

  return analyzer.analyzeResourceConfig(resourceId, config, fullContext);
}

/**
 * Analyze resource configurations for factory function integration with KubernetesRef detection
 * This function integrates with existing factory functions to detect and convert
 * JavaScript expressions that contain KubernetesRef objects from the magic proxy system
 */
export function analyzeFactoryResourceConfig<T extends Record<string, unknown>>(
  resourceId: string,
  config: T,
  availableResources: Record<string, Enhanced<unknown, unknown>>,
  schemaProxy?: SchemaProxy<Record<string, unknown>, Record<string, unknown>>,
  factoryType: 'direct' | 'kro' = 'kro'
): ResourceAnalysisResult {
  const context: ResourceAnalysisContext = {
    type: 'resource',
    resourceId,
    resourceConfig: config,
    availableReferences: availableResources,
    availableResources,
    factoryType,
    validateResourceTypes: true,
    sourceMap: new SourceMapBuilder(),
    ...(schemaProxy && { schemaProxy }),
  };

  return analyzeResourceConfig(resourceId, config, context);
}
