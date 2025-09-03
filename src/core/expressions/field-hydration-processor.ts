/**
 * Field Hydration Integration for JavaScript to CEL Expression Conversion
 * 
 * This module provides integration between the JavaScript to CEL expression conversion system
 * and TypeKro's field hydration strategy. It processes status expressions containing KubernetesRef
 * objects and tracks dependencies to ensure proper hydration ordering.
 * 
 * Key Features:
 * - Uses AST parsing to analyze status builder functions
 * - Processes status builder expressions with KubernetesRef dependency tracking
 * - Extracts dependencies from KubernetesRef objects in expressions
 * - Integrates with existing field hydration strategy for proper ordering
 * - Handles both direct and Kro factory patterns
 * - Provides dependency analysis for status field population
 */

import * as esprima from 'esprima';
import * as estraverse from 'estraverse';
import type { Node as ESTreeNode, ObjectExpression, ReturnStatement, Property, } from 'estree';

import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import { ConversionError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { isKubernetesRef, } from '../../utils/type-guards.js';
import { DependencyResolver } from '../dependencies/index.js';
import type { DeploymentPlan } from '../dependencies/resolver.js';
import { JavaScriptToCelAnalyzer, type AnalysisContext, type CelConversionResult } from './analyzer.js';
import { MagicProxyAnalyzer, } from './magic-proxy-analyzer.js';
import { SourceMapBuilder, type SourceMapEntry } from './source-map.js';

/**
 * Status builder function type for analysis
 */
export type StatusBuilderFunction<TSpec extends Record<string, any> = any, TStatus = any> = (
  schema: SchemaProxy<TSpec, any>,
  resources: Record<string, Enhanced<any, any>>
) => TStatus;

/**
 * Resource reference for dependency tracking
 */
export interface ResourceReference {
  /** Resource ID being referenced */
  resourceId: string;
  
  /** Type of reference (resource or schema) */
  type: 'resource' | 'schema';
  
  /** Field path being accessed */
  fieldPath?: string;
  
  /** Whether this reference is optional (uses optional chaining) */
  optional?: boolean;
}

/**
 * Field hydration strategy interface
 */
export interface FieldHydrationStrategy {
  /**
   * Calculate the order in which status fields should be hydrated based on dependencies
   */
  calculateHydrationOrder(dependencies: Map<string, ResourceReference[]>): string[];
  
  /**
   * Determine if a field can be hydrated in parallel with others
   */
  canHydrateInParallel(fieldName: string, dependencies: ResourceReference[]): boolean;
  
  /**
   * Get the priority of a field for hydration ordering
   */
  getFieldPriority(fieldName: string, dependencies: ResourceReference[]): number;
}

/**
 * Default field hydration strategy implementation
 */
export class DefaultFieldHydrationStrategy implements FieldHydrationStrategy {

  calculateHydrationOrder(dependencies: Map<string, ResourceReference[]>): string[] {
    // Create a simple dependency graph for status fields
    const fieldDependencies = new Map<string, Set<string>>();
    const allFields = Array.from(dependencies.keys());
    
    // Initialize empty dependencies for all fields
    for (const fieldName of allFields) {
      fieldDependencies.set(fieldName, new Set<string>());
    }
    
    // For now, use a simple approach: fields with fewer dependencies come first
    // This avoids the complex field-to-field dependency logic that was causing circular dependencies
    // In a real implementation, this would need more sophisticated dependency analysis
    
    // Sort fields by dependency complexity (simpler dependencies first)
    const sortedFields = allFields.sort((a, b) => {
      const aDeps = dependencies.get(a) || [];
      const bDeps = dependencies.get(b) || [];
      
      // Schema-only dependencies come first
      const aSchemaOnly = aDeps.every(dep => dep.type === 'schema');
      const bSchemaOnly = bDeps.every(dep => dep.type === 'schema');
      
      if (aSchemaOnly && !bSchemaOnly) return -1;
      if (!aSchemaOnly && bSchemaOnly) return 1;
      
      // Then sort by number of dependencies
      return aDeps.length - bDeps.length;
    });
    
    return sortedFields;
  }

  canHydrateInParallel(_fieldName: string, dependencies: ResourceReference[]): boolean {
    // Fields with no dependencies can be hydrated in parallel
    if (dependencies.length === 0) {
      return true;
    }
    
    // Fields that only depend on schema can be hydrated in parallel
    return dependencies.every(dep => dep.type === 'schema');
  }

  getFieldPriority(_fieldName: string, dependencies: ResourceReference[]): number {
    // Higher priority (lower number) for fields with fewer dependencies
    let priority = dependencies.length;
    
    // Schema-only dependencies get higher priority
    if (dependencies.every(dep => dep.type === 'schema')) {
      priority -= 10;
    }
    
    // Optional dependencies get lower priority
    if (dependencies.some(dep => dep.optional)) {
      priority += 5;
    }
    
    return Math.max(0, priority);
  }
}

/**
 * Result of processing status expressions
 */
export interface ProcessedStatusBuilder {
  /** Processed status field mappings with CEL expressions */
  statusMappings: Record<string, CelExpression>;
  
  /** Recommended hydration order for status fields */
  hydrationOrder: string[];
  
  /** Dependencies for each status field */
  dependencies: Map<string, ResourceReference[]>;
  
  /** Source mapping entries for debugging */
  sourceMap: SourceMapEntry[];
  
  /** Processing errors encountered */
  errors: ConversionError[];
  
  /** Whether processing was successful */
  valid: boolean;
  
  /** Analysis results for each field */
  fieldAnalysis: Map<string, CelConversionResult>;
  
  /** Resource references found across all fields */
  allResourceReferences: ResourceReference[];
  
  /** Schema references found across all fields */
  allSchemaReferences: ResourceReference[];
}

/**
 * Options for field hydration expression processing
 */
export interface FieldHydrationProcessingOptions {
  /** Field hydration strategy to use */
  hydrationStrategy?: FieldHydrationStrategy;
  
  /** Whether to perform deep analysis of expressions */
  deepAnalysis?: boolean;
  
  /** Whether to validate resource references */
  validateReferences?: boolean;
  
  /** Whether to include source mapping */
  includeSourceMapping?: boolean;
  
  /** Maximum depth for expression analysis */
  maxAnalysisDepth?: number;
  
  /** Factory type for CEL generation strategy */
  factoryType?: 'direct' | 'kro';
}

/**
 * Default processing options
 */
const DEFAULT_PROCESSING_OPTIONS: Required<FieldHydrationProcessingOptions> = {
  hydrationStrategy: new DefaultFieldHydrationStrategy(),
  deepAnalysis: true,
  validateReferences: true,
  includeSourceMapping: true,
  maxAnalysisDepth: 10,
  factoryType: 'kro'
};

/**
 * Field Hydration Expression Processor
 * 
 * Processes status builder functions to extract KubernetesRef dependencies
 * and integrate with TypeKro's field hydration strategy.
 */
export class FieldHydrationExpressionProcessor {
  private expressionAnalyzer: JavaScriptToCelAnalyzer;
  private magicProxyAnalyzer: MagicProxyAnalyzer;
  private dependencyResolver: DependencyResolver;
  private options: Required<FieldHydrationProcessingOptions>;
  private logger = getComponentLogger('field-hydration-processor');

  constructor(
    expressionAnalyzer?: JavaScriptToCelAnalyzer,
    options?: FieldHydrationProcessingOptions
  ) {
    this.expressionAnalyzer = expressionAnalyzer || new JavaScriptToCelAnalyzer();
    this.magicProxyAnalyzer = new MagicProxyAnalyzer();
    this.dependencyResolver = new DependencyResolver();
    this.options = { ...DEFAULT_PROCESSING_OPTIONS, ...options };
  }

  /**
   * Process status expressions with KubernetesRef dependency tracking
   * 
   * This is the main method that analyzes a status builder function and extracts
   * dependencies for proper field hydration ordering.
   */
  processStatusExpressions<TSpec extends Record<string, any>, TStatus>(
    statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<TSpec, any>
  ): ProcessedStatusBuilder {
    try {
      this.logger.debug('Processing status expressions', {
        resourceCount: Object.keys(resources).length,
        hasSchemaProxy: !!schemaProxy
      });

      // Parse the status builder function to extract field expressions using AST
      const fieldExpressions = this.extractFieldExpressions(statusBuilder, resources, schemaProxy);

      
      // Process each field expression
      const statusMappings: Record<string, CelExpression> = {};
      const fieldDependencies = new Map<string, ResourceReference[]>();
      const fieldAnalysis = new Map<string, CelConversionResult>();
      const allSourceMap: SourceMapEntry[] = [];
      const allErrors: ConversionError[] = [];
      
      let overallValid = true;

      for (const [fieldName, expressionSource] of Object.entries(fieldExpressions)) {
        try {
          // Create analysis context for this field
          const context: AnalysisContext = {
            type: 'status',
            availableReferences: resources,
            ...(schemaProxy && { schemaProxy: schemaProxy as SchemaProxy<any, any> }),
            factoryType: this.options.factoryType,
            ...(this.options.includeSourceMapping && { sourceMap: new SourceMapBuilder() }),
            dependencies: []
          };

          // Analyze the expression for KubernetesRef objects
          const analysisResult = this.analyzeFieldExpression(expressionSource, context);
          
          // Store analysis result
          fieldAnalysis.set(fieldName, analysisResult);
          
          if (analysisResult.valid && analysisResult.celExpression) {
            statusMappings[fieldName] = analysisResult.celExpression;
          }
          
          // Extract dependencies from the analysis
          const dependencies = this.extractDependenciesFromAnalysis(analysisResult);
          fieldDependencies.set(fieldName, dependencies);
          
          // Accumulate source mapping and errors
          allSourceMap.push(...analysisResult.sourceMap);
          allErrors.push(...analysisResult.errors);
          
          if (!analysisResult.valid) {
            overallValid = false;
          }
          
          this.logger.debug('Processed field expression', {
            fieldName,
            valid: analysisResult.valid,
            dependencyCount: dependencies.length,
            requiresConversion: analysisResult.requiresConversion
          });
          
        } catch (error) {
          const fieldError = new ConversionError(
            `Failed to process field '${fieldName}': ${error instanceof Error ? error.message : String(error)}`,
            expressionSource,
            'unknown'
          );
          
          allErrors.push(fieldError);
          fieldDependencies.set(fieldName, []);
          overallValid = false;
          
          this.logger.error('Failed to process field expression', error as Error, { fieldName });
        }
      }

      // Calculate hydration order using the configured strategy
      const hydrationOrder = this.options.hydrationStrategy.calculateHydrationOrder(fieldDependencies);
      
      // Extract all resource and schema references
      const { allResourceReferences, allSchemaReferences } = this.categorizeAllReferences(fieldDependencies);
      
      this.logger.debug('Status expression processing complete', {
        fieldCount: Object.keys(fieldExpressions).length,
        validFields: Object.keys(statusMappings).length,
        totalDependencies: allResourceReferences.length + allSchemaReferences.length,
        hydrationOrder: hydrationOrder.length,
        overallValid
      });

      return {
        statusMappings,
        hydrationOrder,
        dependencies: fieldDependencies,
        sourceMap: allSourceMap,
        errors: allErrors,
        valid: overallValid,
        fieldAnalysis,
        allResourceReferences,
        allSchemaReferences
      };
      
    } catch (error) {
      const processingError = new ConversionError(
        `Failed to process status expressions: ${error instanceof Error ? error.message : String(error)}`,
        statusBuilder.toString(),
        'function-call'
      );
      
      this.logger.error('Status expression processing failed', error as Error);

      return {
        statusMappings: {},
        hydrationOrder: [],
        dependencies: new Map(),
        sourceMap: [],
        errors: [processingError],
        valid: false,
        fieldAnalysis: new Map(),
        allResourceReferences: [],
        allSchemaReferences: []
      };
    }
  }

  /**
   * Extract dependencies from KubernetesRef objects in expressions
   * 
   * This method analyzes the KubernetesRef objects found in expressions and
   * converts them to ResourceReference objects for dependency tracking.
   */
  extractDependenciesFromKubernetesRefs(
    kubernetesRefs: KubernetesRef<any>[]
  ): ResourceReference[] {
    const dependencies: ResourceReference[] = [];
    
    for (const ref of kubernetesRefs) {
      const dependency: ResourceReference = {
        resourceId: ref.resourceId,
        type: ref.resourceId === '__schema__' ? 'schema' : 'resource',
        fieldPath: ref.fieldPath,
        optional: false // Will be determined by expression analysis
      };
      
      dependencies.push(dependency);
    }
    
    return dependencies;
  }

  /**
   * Integrate with existing field hydration strategy
   * 
   * This method provides integration points with TypeKro's existing field hydration
   * system by providing dependency information and hydration ordering.
   */
  integrateWithFieldHydrationStrategy(
    processedStatus: ProcessedStatusBuilder,
    existingStrategy?: FieldHydrationStrategy
  ): {
    enhancedStrategy: FieldHydrationStrategy;
    hydrationPlan: DeploymentPlan;
    parallelizableFields: string[][];
  } {
    const strategy = existingStrategy || this.options.hydrationStrategy;
    
    // Create enhanced strategy that incorporates expression dependencies
    const enhancedStrategy: FieldHydrationStrategy = {
      calculateHydrationOrder: (dependencies) => {
        // Merge with processed dependencies
        const mergedDependencies = new Map(dependencies);
        for (const [field, deps] of processedStatus.dependencies) {
          const existing = mergedDependencies.get(field) || [];
          mergedDependencies.set(field, [...existing, ...deps]);
        }
        
        return strategy.calculateHydrationOrder(mergedDependencies);
      },
      
      canHydrateInParallel: (fieldName, dependencies) => {
        const processedDeps = processedStatus.dependencies.get(fieldName) || [];
        const allDeps = [...dependencies, ...processedDeps];
        return strategy.canHydrateInParallel(fieldName, allDeps);
      },
      
      getFieldPriority: (fieldName, dependencies) => {
        const processedDeps = processedStatus.dependencies.get(fieldName) || [];
        const allDeps = [...dependencies, ...processedDeps];
        return strategy.getFieldPriority(fieldName, allDeps);
      }
    };
    
    // Create hydration plan similar to deployment plan
    const hydrationOrder = enhancedStrategy.calculateHydrationOrder(processedStatus.dependencies);
    const levels: string[][] = [];
    const processed = new Set<string>();
    
    // Group fields by hydration level (similar to deployment levels)
    while (processed.size < hydrationOrder.length) {
      const currentLevel: string[] = [];
      
      for (const fieldName of hydrationOrder) {
        if (processed.has(fieldName)) {
          continue;
        }
        
        const fieldDeps = processedStatus.dependencies.get(fieldName) || [];
        const resourceDeps = fieldDeps.filter(dep => dep.type === 'resource').map(dep => dep.resourceId);
        const allResourceDepsProcessed = resourceDeps.every(depId => 
          Array.from(processed).some(processedField => {
            const processedDeps = processedStatus.dependencies.get(processedField) || [];
            return processedDeps.some(dep => dep.resourceId === depId);
          })
        );
        
        if (allResourceDepsProcessed || fieldDeps.every(dep => dep.type === 'schema')) {
          currentLevel.push(fieldName);
        }
      }
      
      if (currentLevel.length === 0 && processed.size < hydrationOrder.length) {
        // Add remaining fields to avoid infinite loop
        const remaining = hydrationOrder.filter(field => !processed.has(field));
        currentLevel.push(...remaining);
      }
      
      if (currentLevel.length > 0) {
        levels.push(currentLevel);
        currentLevel.forEach(field => processed.add(field));
      } else {
        break;
      }
    }
    
    const hydrationPlan: DeploymentPlan = {
      levels,
      totalResources: hydrationOrder.length,
      maxParallelism: Math.max(...levels.map(level => level.length))
    };
    
    return {
      enhancedStrategy,
      hydrationPlan,
      parallelizableFields: levels
    };
  }

  /**
   * Strip TypeScript syntax that esprima cannot parse
   */
  private stripTypeScriptSyntax(functionSource: string): string {
    // Remove non-null assertion operators (!)
    let cleaned = functionSource.replace(/(\w+)!/g, '$1');
    
    // Remove type annotations in parameters (: Type)
    cleaned = cleaned.replace(/:\s*typeof\s+\w+/g, '');
    cleaned = cleaned.replace(/:\s*any/g, '');
    
    // Handle optional chaining with array access like ?.[0] -> [0]
    // Remove the dot before the bracket to avoid syntax like "ingress.[0]"
    cleaned = cleaned.replace(/\?\.\[/g, '[');
    
    // Handle optional chaining - convert to regular property access for parsing
    // This is a simplified approach that works for basic cases
    cleaned = cleaned.replace(/\?\./g, '.');
    
    return cleaned;
  }

  /**
   * Extract field expressions from a status builder function using AST parsing
   */
  private extractFieldExpressions(
    statusBuilder: StatusBuilderFunction,
    resources?: Record<string, Enhanced<any, any>>,
    schemaProxy?: any
  ): Record<string, string> {
    try {
      // Get the function source code
      let functionSource = statusBuilder.toString();
      
      // Strip TypeScript syntax that esprima can't handle
      functionSource = this.stripTypeScriptSyntax(functionSource);
      
      this.logger.debug('Parsing status builder function', {
        functionLength: functionSource.length
      });

      // Parse the function to AST
      const ast = esprima.parseScript(functionSource, {
        loc: true,
        range: true,
      });

      // Find the return statement or arrow function body in the function
      const returnStatement = this.findReturnStatement(ast);
      if (!returnStatement) {
        this.logger.warn('No return statement found in status builder function');
        return {};
      }

      // Extract field expressions from the return object
      const fieldExpressions = this.extractFieldExpressionsFromReturnStatement(
        returnStatement,
        functionSource
      );

      this.logger.debug('Extracted field expressions from AST', {
        fieldCount: Object.keys(fieldExpressions).length,
        fields: Object.keys(fieldExpressions)
      });

      return fieldExpressions;
      
    } catch (error) {
      this.logger.error('Failed to parse status builder function', error as Error);
      
      // Fallback: try to execute the function to get field names
      try {
        const mockResources = this.createMockResources(resources || {});
        const mockSchema = schemaProxy || {} as any;
        const result = statusBuilder(mockSchema, mockResources);
        
        if (result && typeof result === 'object') {
          const fieldExpressions: Record<string, string> = {};
          for (const key of Object.keys(result)) {
            fieldExpressions[key] = `/* Could not parse expression for field ${key} */`;
          }
          return fieldExpressions;
        }
      } catch (fallbackError) {
        this.logger.error('Fallback field extraction also failed', fallbackError as Error);
      }
      
      return {};
    }
  }

  /**
   * Find the return statement or arrow function body in a function AST
   */
  private findReturnStatement(ast: ESTreeNode): ReturnStatement | { type: 'ArrowFunctionBody'; argument: any } | null {
    let returnStatement: ReturnStatement | { type: 'ArrowFunctionBody'; argument: any } | null = null;

    estraverse.traverse(ast, {
      enter(node) {
        if (node.type === 'ReturnStatement') {
          returnStatement = node as ReturnStatement;
          return estraverse.VisitorOption.Break;
        } else if (node.type === 'ArrowFunctionExpression') {
          // Handle arrow function with expression body (no explicit return)
          const arrowFunc = node as any;
          if (arrowFunc.body && arrowFunc.body.type !== 'BlockStatement') {
            // This is an expression body, treat it as the return value
            returnStatement = {
              type: 'ArrowFunctionBody',
              argument: arrowFunc.body
            };
            return estraverse.VisitorOption.Break;
          }
        }
        return undefined; // Continue traversal
      }
    });

    return returnStatement;
  }

  /**
   * Extract field expressions from a return statement or arrow function body
   */
  private extractFieldExpressionsFromReturnStatement(
    returnStatement: ReturnStatement | { type: 'ArrowFunctionBody'; argument: any },
    sourceCode: string
  ): Record<string, string> {
    const fieldExpressions: Record<string, string> = {};

    // Get the argument (expression being returned)
    let argument: any;
    if (returnStatement.type === 'ArrowFunctionBody') {
      argument = returnStatement.argument;
    } else {
      argument = (returnStatement as ReturnStatement).argument;
    }

    if (!argument) {
      return fieldExpressions;
    }

    // Handle object expression in return statement or arrow function body
    if (argument.type === 'ObjectExpression') {
      const objectExpression = argument as ObjectExpression;
      
      for (const property of objectExpression.properties) {
        if (property.type === 'Property' && !property.computed) {
          const prop = property as Property;
          
          // Get the field name
          let fieldName: string;
          if (prop.key.type === 'Identifier') {
            fieldName = prop.key.name;
          } else if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') {
            fieldName = prop.key.value;
          } else {
            continue; // Skip complex keys
          }

          // Extract the expression source code
          if (prop.value.range) {
            const [start, end] = prop.value.range;
            const expressionSource = sourceCode.slice(start, end);
            fieldExpressions[fieldName] = expressionSource;
          } else {
            // Fallback: use a placeholder
            fieldExpressions[fieldName] = `/* Expression for ${fieldName} */`;
          }
        }
      }
    }

    return fieldExpressions;
  }

  /**
   * Create mock resources for fallback field extraction
   */
  private createMockResources(resources: Record<string, Enhanced<any, any>>): Record<string, any> {
    const mockResources: Record<string, any> = {};
    
    for (const [resourceName, _resource] of Object.entries(resources)) {
      // Create a simple mock that returns truthy values for any property access
      mockResources[resourceName] = new Proxy({}, {
        get: () => new Proxy({}, {
          get: () => new Proxy({}, {
            get: () => 1 // Return a truthy value for comparisons
          })
        })
      });
    }
    
    return mockResources;
  }

  /**
   * Analyze a single field expression for KubernetesRef objects
   */
  private analyzeFieldExpression(expressionSource: string, context: AnalysisContext): CelConversionResult {
    try {
      // Use the JavaScript to CEL analyzer to properly analyze the expression
      const analysisResult = this.expressionAnalyzer.analyzeExpression(expressionSource, context);
      
      this.logger.debug('Analyzed field expression', {
        expression: expressionSource.substring(0, 100),
        valid: analysisResult.valid,
        requiresConversion: analysisResult.requiresConversion,
        dependencyCount: analysisResult.dependencies.length
      });

      return analysisResult;
      
    } catch (error) {
      this.logger.error('Failed to analyze field expression', error as Error, {
        expression: expressionSource.substring(0, 100)
      });

      const conversionError = new ConversionError(
        `Failed to analyze expression: ${error instanceof Error ? error.message : String(error)}`,
        expressionSource,
        'javascript'
      );

      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [conversionError],
        warnings: [],
        requiresConversion: false
      };
    }
  }

  /**
   * Extract KubernetesRef objects from a value (recursively)
   */
  private extractKubernetesRefsFromValue(value: any): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    if (isKubernetesRef(value)) {
      refs.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        refs.push(...this.extractKubernetesRefsFromValue(item));
      }
    } else if (value && typeof value === 'object') {
      for (const key in value) {
        if (Object.hasOwn(value, key)) {
          refs.push(...this.extractKubernetesRefsFromValue(value[key]));
        }
      }
    }
    
    return refs;
  }

  /**
   * Extract dependencies from analysis result
   */
  private extractDependenciesFromAnalysis(analysisResult: CelConversionResult): ResourceReference[] {
    return this.extractDependenciesFromKubernetesRefs(analysisResult.dependencies);
  }

  /**
   * Categorize all references into resource and schema references
   */
  private categorizeAllReferences(
    fieldDependencies: Map<string, ResourceReference[]>
  ): {
    allResourceReferences: ResourceReference[];
    allSchemaReferences: ResourceReference[];
  } {
    const allResourceReferences: ResourceReference[] = [];
    const allSchemaReferences: ResourceReference[] = [];
    const seenReferences = new Set<string>();
    
    for (const dependencies of fieldDependencies.values()) {
      for (const dep of dependencies) {
        const key = `${dep.type}:${dep.resourceId}:${dep.fieldPath || ''}`;
        
        if (!seenReferences.has(key)) {
          seenReferences.add(key);
          
          if (dep.type === 'resource') {
            allResourceReferences.push(dep);
          } else {
            allSchemaReferences.push(dep);
          }
        }
      }
    }
    
    return { allResourceReferences, allSchemaReferences };
  }
}

/**
 * Convenience function to process status expressions
 */
export function processStatusExpressions<TSpec extends Record<string, any>, TStatus>(
  statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<TSpec, any>,
  options?: FieldHydrationProcessingOptions
): ProcessedStatusBuilder {
  const processor = new FieldHydrationExpressionProcessor(undefined, options);
  return processor.processStatusExpressions(statusBuilder, resources, schemaProxy);
}

/**
 * Convenience function to extract dependencies from KubernetesRef objects
 */
export function extractDependenciesFromKubernetesRefs(
  kubernetesRefs: KubernetesRef<any>[]
): ResourceReference[] {
  const processor = new FieldHydrationExpressionProcessor();
  return processor.extractDependenciesFromKubernetesRefs(kubernetesRefs);
}