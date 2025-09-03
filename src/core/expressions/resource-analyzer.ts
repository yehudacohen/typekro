/**
 * Resource Builder Integration for JavaScript to CEL Expression Conversion
 * 
 * This module provides integration with TypeKro's existing KubernetesRef and magic proxy systems
 * for analyzing resource configurations that contain JavaScript expressions with KubernetesRef objects.
 * 
 * The analyzer detects when resource builders use expressions that depend on other resources
 * and converts them to appropriate CEL expressions based on the factory pattern.
 */

import type { Enhanced } from '../types/kubernetes.js';
import type { KubernetesRef, CelExpression } from '../types/common.js';
import type { SchemaProxy } from '../types/serialization.js';
import { containsKubernetesRefs, isKubernetesRef } from '../../utils/type-guards.js';
import { ConversionError } from '../errors.js';
import { JavaScriptToCelAnalyzer, type AnalysisContext, } from './analyzer.js';
import { SourceMapBuilder } from './source-map.js';

/**
 * Context for analyzing resource configurations
 */
export interface ResourceAnalysisContext extends AnalysisContext {
  /** The resource being analyzed */
  resourceId: string;
  
  /** The resource configuration being analyzed */
  resourceConfig: Record<string, any>;
  
  /** Other resources available for cross-resource references */
  availableResources?: Record<string, Enhanced<any, any>>;
  
  /** Whether to validate resource types during analysis */
  validateResourceTypes?: boolean;
}

/**
 * Result of analyzing a resource configuration
 */
export interface ResourceAnalysisResult {
  /** The original resource configuration */
  originalConfig: Record<string, any>;
  
  /** The processed configuration with CEL expressions */
  processedConfig: Record<string, any>;
  
  /** All KubernetesRef dependencies found in the configuration */
  dependencies: KubernetesRef<any>[];
  
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
 * Resource type validation result
 */
export interface ResourceTypeValidationResult {
  /** The field path that was validated */
  fieldPath: string;
  
  /** The KubernetesRef that was validated */
  reference: KubernetesRef<any>;
  
  /** Whether the type validation passed */
  valid: boolean;
  
  /** Expected type */
  expectedType: string;
  
  /** Actual type (if determinable) */
  actualType?: string;
  
  /** Validation error message */
  error?: string;
}

/**
 * Dependency tracking information for a KubernetesRef
 */
export interface DependencyInfo {
  /** The KubernetesRef object */
  reference: KubernetesRef<any>;
  
  /** The field path where this dependency was found */
  fieldPath: string;
  
  /** The type of dependency */
  dependencyType: 'schema' | 'resource' | 'external';
  
  /** Whether this dependency is required for the resource to function */
  required: boolean;
  
  /** The expected type of the dependency */
  expectedType: string;
  
  /** Additional metadata about the dependency */
  metadata?: {
    /** Whether this dependency affects resource readiness */
    affectsReadiness?: boolean;
    
    /** Whether this dependency is used in conditional logic */
    conditional?: boolean;
    
    /** The expression context where this dependency was found */
    expressionContext?: string;
  };
}

/**
 * Dependency graph for tracking resource relationships
 */
export interface DependencyGraph {
  /** Map of resource ID to its dependencies */
  dependencies: Map<string, DependencyInfo[]>;
  
  /** Map of resource ID to resources that depend on it */
  dependents: Map<string, string[]>;
  
  /** Detected circular dependency chains */
  circularChains: string[][];
  
  /** Topologically sorted resource order (for deployment) */
  deploymentOrder: string[];
}

/**
 * Options for dependency tracking
 */
export interface DependencyTrackingOptions {
  /** Whether to track schema dependencies */
  trackSchemaDependencies?: boolean;
  
  /** Whether to track resource dependencies */
  trackResourceDependencies?: boolean;
  
  /** Whether to track external dependencies */
  trackExternalDependencies?: boolean;
  
  /** Whether to detect circular dependencies */
  detectCircularDependencies?: boolean;
  
  /** Whether to compute deployment order */
  computeDeploymentOrder?: boolean;
  
  /** Maximum depth for dependency traversal */
  maxDepth?: number;
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
    config: Record<string, any>,
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
      typeValidationResults: []
    };
    
    try {
      // Deep analyze the configuration object
      result.processedConfig = this.analyzeConfigObject(
        config,
        '',
        context,
        result
      );
      
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
          computeDeploymentOrder: true
        }
      );
      
      // Get circular dependencies from tracker
      result.circularDependencies = this.dependencyTracker.getDependencyGraph().circularChains;
      
      // Validate resource types if requested
      if (context.validateResourceTypes) {
        result.typeValidationResults = this.validateResourceTypes(
          result.dependencies,
          context
        );
      }
      
      // Set overall conversion flag
      result.requiresConversion = result.convertedFields.length > 0;
      
    } catch (error) {
      result.errors.push(new ConversionError(
        `Failed to analyze resource config: ${error instanceof Error ? error.message : String(error)}`,
        JSON.stringify(config),
        'unknown'
      ));
    }
    
    return result;
  }
  
  /**
   * Recursively analyze a configuration object for KubernetesRef objects
   */
  private analyzeConfigObject(
    obj: any,
    fieldPath: string,
    context: ResourceAnalysisContext,
    result: ResourceAnalysisResult
  ): any {
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
        this.analyzeConfigObject(
          item,
          `${fieldPath}[${index}]`,
          context,
          result
        )
      );
    }
    
    // Handle objects
    if (typeof obj === 'object') {
      const processedObj: any = {};
      
      for (const [key, value] of Object.entries(obj)) {
        const currentFieldPath = fieldPath ? `${fieldPath}.${key}` : key;
        processedObj[key] = this.analyzeConfigObject(
          value,
          currentFieldPath,
          context,
          result
        );
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
    ref: KubernetesRef<any>,
    fieldPath: string,
    context: ResourceAnalysisContext,
    result: ResourceAnalysisResult
  ): CelExpression | any {
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
        ...(context.schemaProxy && { schemaProxy: context.schemaProxy })
      };
      
      // Convert the KubernetesRef to CEL
      const celExpression = this.analyzer.convertKubernetesRefToCel(ref, analysisContext);
      
      // Add any additional dependencies found during conversion
      result.dependencies.push(...(analysisContext.dependencies || []));
      
      return celExpression;
      
    } catch (error) {
      const conversionError = new ConversionError(
        `Failed to convert KubernetesRef at ${fieldPath}: ${error instanceof Error ? error.message : String(error)}`,
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
        ...(context.schemaProxy && { schemaProxy: context.schemaProxy })
      };
      
      // Analyze the expression
      const conversionResult = this.analyzer.analyzeExpression(expression, analysisContext);
      
      if (conversionResult.valid && conversionResult.requiresConversion) {
        // Track dependencies and converted fields
        result.dependencies.push(...conversionResult.dependencies);
        result.convertedFields.push(fieldPath);
        result.errors.push(...conversionResult.errors);
        
        return conversionResult.celExpression!;
      }
      
      // No conversion needed or failed - return original
      result.errors.push(...conversionResult.errors);
      return expression;
      
    } catch (error) {
      const conversionError = new ConversionError(
        `Failed to analyze expression at ${fieldPath}: ${error instanceof Error ? error.message : String(error)}`,
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
   * This implements requirement 4.5: resource type validation
   */
  private validateResourceTypes(
    dependencies: KubernetesRef<any>[],
    context: ResourceAnalysisContext
  ): ResourceTypeValidationResult[] {
    const validationContext: ResourceTypeValidationContext = {
      strictTypeChecking: context.validateResourceTypes || false,
      ...(context.availableResources && { availableResources: context.availableResources }),
      ...(context.schemaProxy && { schemaProxy: context.schemaProxy })
    };
    
    return dependencies.map(dep => 
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
    ref: KubernetesRef<any>,
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
  config: Record<string, any>,
  context: Omit<ResourceAnalysisContext, 'resourceId' | 'resourceConfig'>
): ResourceAnalysisResult {
  const analyzer = new ResourceAnalyzer();
  
  const fullContext: ResourceAnalysisContext = {
    ...context,
    resourceId,
    resourceConfig: config
  };
  
  return analyzer.analyzeResourceConfig(resourceId, config, fullContext);
}

/**
 * Analyze resource configurations for factory function integration with KubernetesRef detection
 * This function integrates with existing factory functions to detect and convert
 * JavaScript expressions that contain KubernetesRef objects from the magic proxy system
 */
export function analyzeFactoryResourceConfig<T extends Record<string, any>>(
  resourceId: string,
  config: T,
  availableResources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<any, any>,
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
    ...(schemaProxy && { schemaProxy })
  };
  
  return analyzeResourceConfig(resourceId, config, context);
}

/**
 * Automatic dependency tracker for KubernetesRef objects in expressions
 * This implements requirement 4.2: automatic dependency tracking
 */
export class DependencyTracker {
  private dependencyGraph: DependencyGraph;
  
  constructor() {
    this.dependencyGraph = {
      dependencies: new Map(),
      dependents: new Map(),
      circularChains: [],
      deploymentOrder: []
    };
  }
  
  /**
   * Track dependencies for a resource configuration
   */
  trackDependencies(
    resourceId: string,
    dependencies: KubernetesRef<any>[],
    fieldPaths: string[],
    options: DependencyTrackingOptions = {}
  ): DependencyInfo[] {
    const dependencyInfos: DependencyInfo[] = [];
    
    for (let i = 0; i < dependencies.length; i++) {
      const dep = dependencies[i];
      if (!dep) continue;
      
      const fieldPath = fieldPaths[i] || `unknown[${i}]`;
      
      const dependencyInfo = this.createDependencyInfo(dep, fieldPath, options);
      dependencyInfos.push(dependencyInfo);
      
      // Add to dependency graph
      this.addToDependencyGraph(resourceId, dependencyInfo);
    }
    
    // Update dependency graph computations
    if (options.detectCircularDependencies) {
      this.detectCircularDependencies();
    }
    
    if (options.computeDeploymentOrder) {
      this.computeDeploymentOrder();
    }
    
    return dependencyInfos;
  }
  
  /**
   * Create dependency information for a KubernetesRef
   */
  private createDependencyInfo(
    ref: KubernetesRef<any>,
    fieldPath: string,
    options: DependencyTrackingOptions
  ): DependencyInfo {
    const dependencyType = this.determineDependencyType(ref);
    
    // Skip tracking based on options
    if (dependencyType === 'schema' && options.trackSchemaDependencies === false) {
      return this.createSkippedDependencyInfo(ref, fieldPath, dependencyType);
    }
    
    if (dependencyType === 'resource' && options.trackResourceDependencies === false) {
      return this.createSkippedDependencyInfo(ref, fieldPath, dependencyType);
    }
    
    if (dependencyType === 'external' && options.trackExternalDependencies === false) {
      return this.createSkippedDependencyInfo(ref, fieldPath, dependencyType);
    }
    
    return {
      reference: ref,
      fieldPath,
      dependencyType,
      required: this.isDependencyRequired(ref, fieldPath),
      expectedType: ref._type ? String(ref._type) : 'unknown',
      metadata: {
        affectsReadiness: this.affectsReadiness(ref, fieldPath),
        conditional: this.isConditional(fieldPath),
        expressionContext: this.getExpressionContext(fieldPath)
      }
    };
  }
  
  /**
   * Create a skipped dependency info (for disabled tracking)
   */
  private createSkippedDependencyInfo(
    ref: KubernetesRef<any>,
    fieldPath: string,
    dependencyType: 'schema' | 'resource' | 'external'
  ): DependencyInfo {
    return {
      reference: ref,
      fieldPath,
      dependencyType,
      required: false,
      expectedType: 'skipped',
      metadata: {
        affectsReadiness: false,
        conditional: false,
        expressionContext: 'skipped'
      }
    };
  }
  
  /**
   * Determine the type of dependency
   */
  private determineDependencyType(ref: KubernetesRef<any>): 'schema' | 'resource' | 'external' {
    if (ref.resourceId === '__schema__') {
      return 'schema';
    }
    
    // Check if it's a known resource type
    if (ref.resourceId.match(/^[a-z][a-z0-9-]*$/)) {
      return 'resource';
    }
    
    return 'external';
  }
  
  /**
   * Determine if a dependency is required
   */
  private isDependencyRequired(ref: KubernetesRef<any>, fieldPath: string): boolean {
    // Schema dependencies are generally required
    if (ref.resourceId === '__schema__') {
      return true;
    }
    
    // Dependencies in required fields are required
    if (this.isRequiredField(fieldPath)) {
      return true;
    }
    
    // Dependencies in conditional expressions may not be required
    if (this.isConditional(fieldPath)) {
      return false;
    }
    
    // Default to required for safety
    return true;
  }
  
  /**
   * Check if a field path represents a required field
   */
  private isRequiredField(fieldPath: string): boolean {
    // Common required fields
    const requiredFields = ['name', 'image', 'namespace'];
    
    return requiredFields.some(field => fieldPath.includes(field));
  }
  
  /**
   * Check if a dependency affects resource readiness
   */
  private affectsReadiness(ref: KubernetesRef<any>, fieldPath: string): boolean {
    // Status field dependencies typically affect readiness
    if (ref.fieldPath.startsWith('status.')) {
      return true;
    }
    
    // Dependencies in readiness-related fields
    const readinessFields = ['ready', 'available', 'replicas', 'conditions'];
    
    return readinessFields.some(field => 
      fieldPath.includes(field) || ref.fieldPath.includes(field)
    );
  }
  
  /**
   * Check if a field path is in a conditional context
   */
  private isConditional(fieldPath: string): boolean {
    // Look for conditional patterns in field path
    return fieldPath.includes('?') || 
           fieldPath.includes('||') || 
           fieldPath.includes('&&') ||
           fieldPath.includes('??');
  }
  
  /**
   * Get expression context for a field path
   */
  private getExpressionContext(fieldPath: string): string {
    // Extract the top-level field context
    const parts = fieldPath.split('.');
    if (parts.length > 0 && parts[0]) {
      return parts[0];
    }
    
    return 'unknown';
  }
  
  /**
   * Add dependency info to the dependency graph
   */
  private addToDependencyGraph(resourceId: string, dependencyInfo: DependencyInfo): void {
    // Add to dependencies map
    if (!this.dependencyGraph.dependencies.has(resourceId)) {
      this.dependencyGraph.dependencies.set(resourceId, []);
    }
    this.dependencyGraph.dependencies.get(resourceId)?.push(dependencyInfo);
    
    // Add to dependents map (reverse mapping)
    const dependentResourceId = dependencyInfo.reference.resourceId;
    if (dependentResourceId !== '__schema__') {
      if (!this.dependencyGraph.dependents.has(dependentResourceId)) {
        this.dependencyGraph.dependents.set(dependentResourceId, []);
      }
      
      const dependents = this.dependencyGraph.dependents.get(dependentResourceId)!;
      if (!dependents.includes(resourceId)) {
        dependents.push(resourceId);
      }
    }
  }
  
  /**
   * Detect circular dependencies in the dependency graph
   */
  private detectCircularDependencies(): void {
    this.dependencyGraph.circularChains = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    // Check each resource for cycles
    for (const resourceId of this.dependencyGraph.dependencies.keys()) {
      if (!visited.has(resourceId)) {
        this.detectCyclesFromResource(resourceId, [], visited, recursionStack);
      }
    }
  }
  
  /**
   * Detect cycles starting from a specific resource
   */
  private detectCyclesFromResource(
    resourceId: string,
    path: string[],
    visited: Set<string>,
    recursionStack: Set<string>
  ): void {
    if (recursionStack.has(resourceId)) {
      // Found a cycle
      const cycleStart = path.indexOf(resourceId);
      if (cycleStart >= 0) {
        const cycle = path.slice(cycleStart).concat([resourceId]);
        this.dependencyGraph.circularChains.push(cycle);
      }
      return;
    }
    
    if (visited.has(resourceId)) {
      return;
    }
    
    visited.add(resourceId);
    recursionStack.add(resourceId);
    
    // Follow dependencies
    const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
    for (const dep of dependencies) {
      if (dep.reference.resourceId !== '__schema__') {
        this.detectCyclesFromResource(
          dep.reference.resourceId,
          [...path, resourceId],
          visited,
          recursionStack
        );
      }
    }
    
    recursionStack.delete(resourceId);
  }
  
  /**
   * Compute deployment order using topological sort
   */
  private computeDeploymentOrder(): void {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    
    // Initialize in-degree and adjacency list
    for (const [resourceId, dependencies] of this.dependencyGraph.dependencies) {
      if (!inDegree.has(resourceId)) {
        inDegree.set(resourceId, 0);
      }
      
      if (!adjList.has(resourceId)) {
        adjList.set(resourceId, []);
      }
      
      for (const dep of dependencies) {
        if (dep.reference.resourceId !== '__schema__') {
          const depResourceId = dep.reference.resourceId;
          
          if (!inDegree.has(depResourceId)) {
            inDegree.set(depResourceId, 0);
          }
          
          if (!adjList.has(depResourceId)) {
            adjList.set(depResourceId, []);
          }
          
          // Add edge from dependency to dependent
          adjList.get(depResourceId)?.push(resourceId);
          inDegree.set(resourceId, inDegree.get(resourceId)! + 1);
        }
      }
    }
    
    // Kahn's algorithm for topological sort
    const queue: string[] = [];
    const result: string[] = [];
    
    // Find all resources with no dependencies
    for (const [resourceId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(resourceId);
      }
    }
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);
      
      // Process all dependents
      const dependents = adjList.get(current) || [];
      for (const dependent of dependents) {
        const newDegree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, newDegree);
        
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }
    
    this.dependencyGraph.deploymentOrder = result;
  }
  
  /**
   * Get the current dependency graph
   */
  getDependencyGraph(): DependencyGraph {
    return { ...this.dependencyGraph };
  }
  
  /**
   * Get dependencies for a specific resource
   */
  getDependencies(resourceId: string): DependencyInfo[] {
    return this.dependencyGraph.dependencies.get(resourceId) || [];
  }
  
  /**
   * Get resources that depend on a specific resource
   */
  getDependents(resourceId: string): string[] {
    return this.dependencyGraph.dependents.get(resourceId) || [];
  }
  
  /**
   * Check if there are circular dependencies
   */
  hasCircularDependencies(): boolean {
    return this.dependencyGraph.circularChains.length > 0;
  }
  
  /**
   * Get the deployment order
   */
  getDeploymentOrder(): string[] {
    return [...this.dependencyGraph.deploymentOrder];
  }
  
  /**
   * Reset the dependency graph
   */
  reset(): void {
    this.dependencyGraph = {
      dependencies: new Map(),
      dependents: new Map(),
      circularChains: [],
      deploymentOrder: []
    };
  }
  
  /**
   * Advanced circular dependency detection with detailed chain analysis
   * This provides more sophisticated analysis of KubernetesRef chains
   */
  detectCircularDependencyChains(): CircularDependencyAnalysis {
    const analysis: CircularDependencyAnalysis = {
      hasCircularDependencies: false,
      circularChains: [],
      chainAnalysis: [],
      recommendations: []
    };
    
    // Use Tarjan's strongly connected components algorithm for better cycle detection
    const tarjanResult = this.findStronglyConnectedComponents();
    
    for (const component of tarjanResult.components) {
      if (component.length > 1) {
        // This is a circular dependency
        analysis.hasCircularDependencies = true;
        analysis.circularChains.push(component);
        
        // Analyze the chain
        const chainAnalysis = this.analyzeCircularChain(component);
        analysis.chainAnalysis.push(chainAnalysis);
        
        // Generate recommendations
        const recommendations = this.generateCircularDependencyRecommendations(chainAnalysis);
        analysis.recommendations.push(...recommendations);
      }
    }
    
    return analysis;
  }
  
  /**
   * Find strongly connected components using Tarjan's algorithm
   */
  private findStronglyConnectedComponents(): { components: string[][]; } {
    const index = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let currentIndex = 0;
    
    const strongConnect = (resourceId: string): void => {
      index.set(resourceId, currentIndex);
      lowLink.set(resourceId, currentIndex);
      currentIndex++;
      stack.push(resourceId);
      onStack.add(resourceId);
      
      // Get dependencies for this resource
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      for (const dep of dependencies) {
        const depResourceId = dep.reference.resourceId;
        if (depResourceId === '__schema__') continue; // Skip schema references
        
        if (!index.has(depResourceId)) {
          strongConnect(depResourceId);
          lowLink.set(resourceId, Math.min(lowLink.get(resourceId)!, lowLink.get(depResourceId)!));
        } else if (onStack.has(depResourceId)) {
          lowLink.set(resourceId, Math.min(lowLink.get(resourceId)!, index.get(depResourceId)!));
        }
      }
      
      // If resourceId is a root node, pop the stack and create a component
      if (lowLink.get(resourceId) === index.get(resourceId)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== resourceId);
        
        components.push(component);
      }
    };
    
    // Run algorithm on all unvisited nodes
    for (const resourceId of this.dependencyGraph.dependencies.keys()) {
      if (!index.has(resourceId)) {
        strongConnect(resourceId);
      }
    }
    
    return { components };
  }
  
  /**
   * Analyze a circular dependency chain
   */
  private analyzeCircularChain(chain: string[]): CircularChainAnalysis {
    const analysis: CircularChainAnalysis = {
      chain,
      chainLength: chain.length,
      severity: this.calculateChainSeverity(chain),
      breakPoints: this.findPotentialBreakPoints(chain),
      affectedFields: this.getAffectedFields(chain),
      riskLevel: 'medium'
    };
    
    // Determine risk level
    if (analysis.severity > 0.8 || analysis.chainLength > 5) {
      analysis.riskLevel = 'high';
    } else if (analysis.severity < 0.3 && analysis.chainLength <= 2) {
      analysis.riskLevel = 'low';
    }
    
    return analysis;
  }
  
  /**
   * Calculate the severity of a circular dependency chain
   */
  private calculateChainSeverity(chain: string[]): number {
    let severity = 0;
    let totalDependencies = 0;
    
    for (const resourceId of chain) {
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      totalDependencies += dependencies.length;
      
      // Increase severity for required dependencies
      const requiredDeps = dependencies.filter(dep => dep.required);
      severity += requiredDeps.length * 0.3;
      
      // Increase severity for readiness-affecting dependencies
      const readinessDeps = dependencies.filter(dep => dep.metadata?.affectsReadiness);
      severity += readinessDeps.length * 0.2;
    }
    
    // Normalize by chain length and total dependencies
    return Math.min(severity / (chain.length * Math.max(totalDependencies, 1)), 1);
  }
  
  /**
   * Find potential break points in a circular chain
   */
  private findPotentialBreakPoints(chain: string[]): string[] {
    const breakPoints: string[] = [];
    
    for (const resourceId of chain) {
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      
      // Look for optional dependencies that could be break points
      const optionalDeps = dependencies.filter(dep => !dep.required);
      if (optionalDeps.length > 0) {
        breakPoints.push(resourceId);
      }
      
      // Look for conditional dependencies
      const conditionalDeps = dependencies.filter(dep => dep.metadata?.conditional);
      if (conditionalDeps.length > 0) {
        breakPoints.push(resourceId);
      }
    }
    
    return [...new Set(breakPoints)]; // Remove duplicates
  }
  
  /**
   * Get affected fields for a circular chain
   */
  private getAffectedFields(chain: string[]): string[] {
    const affectedFields: string[] = [];
    
    for (const resourceId of chain) {
      const dependencies = this.dependencyGraph.dependencies.get(resourceId) || [];
      for (const dep of dependencies) {
        if (chain.includes(dep.reference.resourceId)) {
          affectedFields.push(`${resourceId}.${dep.fieldPath}`);
        }
      }
    }
    
    return affectedFields;
  }
  
  /**
   * Generate recommendations for resolving circular dependencies
   */
  private generateCircularDependencyRecommendations(
    chainAnalysis: CircularChainAnalysis
  ): CircularDependencyRecommendation[] {
    const recommendations: CircularDependencyRecommendation[] = [];
    
    // Recommend breaking at optional dependencies
    if (chainAnalysis.breakPoints.length > 0) {
      recommendations.push({
        type: 'break-optional-dependency',
        description: `Consider making dependencies optional at: ${chainAnalysis.breakPoints.join(', ')}`,
        severity: 'medium',
        affectedResources: chainAnalysis.breakPoints,
        implementation: 'Use conditional expressions or default values for these dependencies'
      });
    }
    
    // Recommend refactoring for high-severity chains
    if (chainAnalysis.severity > 0.7) {
      recommendations.push({
        type: 'refactor-architecture',
        description: 'Consider refactoring the resource architecture to eliminate circular dependencies',
        severity: 'high',
        affectedResources: chainAnalysis.chain,
        implementation: 'Extract shared dependencies into separate resources or use event-driven patterns'
      });
    }
    
    // Recommend using external configuration for long chains
    if (chainAnalysis.chainLength > 4) {
      recommendations.push({
        type: 'external-configuration',
        description: 'Consider using external configuration (ConfigMaps, Secrets) to break the dependency chain',
        severity: 'medium',
        affectedResources: chainAnalysis.chain,
        implementation: 'Move configuration values to ConfigMaps and reference them instead of cross-resource dependencies'
      });
    }
    
    return recommendations;
  }
}

/**
 * Detailed analysis of circular dependencies
 */
export interface CircularDependencyAnalysis {
  /** Whether circular dependencies were found */
  hasCircularDependencies: boolean;
  
  /** List of circular dependency chains */
  circularChains: string[][];
  
  /** Detailed analysis of each chain */
  chainAnalysis: CircularChainAnalysis[];
  
  /** Recommendations for resolving circular dependencies */
  recommendations: CircularDependencyRecommendation[];
}

/**
 * Analysis of a single circular dependency chain
 */
export interface CircularChainAnalysis {
  /** The resources in the circular chain */
  chain: string[];
  
  /** Length of the chain */
  chainLength: number;
  
  /** Severity score (0-1, higher is more severe) */
  severity: number;
  
  /** Potential break points in the chain */
  breakPoints: string[];
  
  /** Fields affected by the circular dependency */
  affectedFields: string[];
  
  /** Risk level assessment */
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * Recommendation for resolving circular dependencies
 */
export interface CircularDependencyRecommendation {
  /** Type of recommendation */
  type: 'break-optional-dependency' | 'refactor-architecture' | 'external-configuration' | 'conditional-logic';
  
  /** Human-readable description */
  description: string;
  
  /** Severity of the issue this addresses */
  severity: 'low' | 'medium' | 'high';
  
  /** Resources affected by this recommendation */
  affectedResources: string[];
  
  /** Implementation guidance */
  implementation: string;
}

/**
 * Comprehensive resource type validator for KubernetesRef objects
 * This implements requirement 4.5: resource type validation
 */
export class ResourceTypeValidator {
  private knownResourceTypes: Map<string, ResourceTypeInfo>;
  private schemaValidators: Map<string, SchemaValidator>;
  
  constructor() {
    this.knownResourceTypes = new Map();
    this.schemaValidators = new Map();
    this.initializeKnownTypes();
  }
  
  /**
   * Validate a KubernetesRef for type correctness
   */
  validateKubernetesRef(
    ref: KubernetesRef<any>,
    context: ResourceTypeValidationContext
  ): ResourceTypeValidationResult {
    const result: ResourceTypeValidationResult = {
      fieldPath: `${ref.resourceId}.${ref.fieldPath}`,
      reference: ref,
      valid: true,
      expectedType: ref._type ? String(ref._type) : 'unknown'
    };
    
    try {
      if (ref.resourceId === '__schema__') {
        return this.validateSchemaRef(ref, context, result);
      } else {
        return this.validateResourceRef(ref, context, result);
      }
    } catch (error) {
      result.valid = false;
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }
  
  /**
   * Validate a schema reference
   */
  private validateSchemaRef(
    ref: KubernetesRef<any>,
    context: ResourceTypeValidationContext,
    result: ResourceTypeValidationResult
  ): ResourceTypeValidationResult {
    if (!context.schemaProxy) {
      result.valid = false;
      result.error = 'Schema proxy not available for validation';
      return result;
    }
    
    // Validate field path structure
    const pathValidation = this.validateSchemaFieldPath(ref.fieldPath);
    if (!pathValidation.valid) {
      result.valid = false;
      result.error = pathValidation.error || 'Validation failed';
      return result;
    }
    
    // Validate against schema if available
    const schemaValidator = this.schemaValidators.get(context.schemaType || 'default');
    if (schemaValidator) {
      const schemaValidation = schemaValidator.validateField(ref.fieldPath, ref._type);
      if (!schemaValidation.valid) {
        result.valid = false;
        result.error = schemaValidation.error || 'Schema validation failed';
        result.actualType = schemaValidation.actualType || 'unknown';
      }
    }
    
    return result;
  }
  
  /**
   * Validate a resource reference
   */
  private validateResourceRef(
    ref: KubernetesRef<any>,
    context: ResourceTypeValidationContext,
    result: ResourceTypeValidationResult
  ): ResourceTypeValidationResult {
    // Check if resource exists
    const resource = context.availableResources?.[ref.resourceId];
    if (!resource) {
      result.valid = false;
      result.error = `Resource '${ref.resourceId}' not found`;
      return result;
    }
    
    // Validate field path structure
    const pathValidation = this.validateResourceFieldPath(ref.fieldPath, resource);
    if (!pathValidation.valid) {
      result.valid = false;
      result.error = pathValidation.error || 'Path validation failed';
      result.actualType = pathValidation.actualType || 'unknown';
      return result;
    }
    
    // Validate type compatibility
    const typeValidation = this.validateTypeCompatibility(ref, resource);
    if (!typeValidation.valid) {
      result.valid = false;
      result.error = typeValidation.error || 'Type validation failed';
      result.actualType = typeValidation.actualType || 'unknown';
    }
    
    return result;
  }
  
  /**
   * Validate schema field path structure
   */
  private validateSchemaFieldPath(fieldPath: string): FieldPathValidationResult {
    const parts = fieldPath.split('.');
    
    if (parts.length < 2) {
      return {
        valid: false,
        error: 'Schema field path must have at least 2 parts (e.g., spec.name)'
      };
    }
    
    const rootField = parts[0];
    if (rootField !== 'spec' && rootField !== 'status') {
      return {
        valid: false,
        error: `Schema field path must start with 'spec' or 'status', got '${rootField}'`
      };
    }
    
    return { valid: true };
  }
  
  /**
   * Validate resource field path structure
   */
  private validateResourceFieldPath(
    fieldPath: string,
    resource: Enhanced<any, any>
  ): FieldPathValidationResult {
    const parts = fieldPath.split('.');
    
    if (parts.length === 0) {
      return {
        valid: false,
        error: 'Field path cannot be empty'
      };
    }
    
    const rootField = parts[0];
    const validRootFields = ['metadata', 'spec', 'status'];
    
    if (!rootField || !validRootFields.includes(rootField)) {
      return {
        valid: false,
        error: `Invalid root field '${rootField || 'undefined'}'. Must be one of: ${validRootFields.join(', ')}`
      };
    }
    
    // Validate specific field patterns
    const patternValidation = this.validateFieldPattern(fieldPath);
    if (!patternValidation.valid) {
      return patternValidation;
    }
    
    // Try to infer actual type from resource
    const actualType = this.inferFieldType(fieldPath, resource);
    
    return {
      valid: true,
      actualType: actualType || 'unknown'
    };
  }
  
  /**
   * Validate field patterns against known Kubernetes patterns
   */
  private validateFieldPattern(fieldPath: string): FieldPathValidationResult {
    // Known valid patterns
    const validPatterns = [
      // Metadata fields
      { pattern: /^metadata\.(name|namespace|uid|resourceVersion|generation)$/, type: 'string' },
      { pattern: /^metadata\.labels\..+$/, type: 'string' },
      { pattern: /^metadata\.annotations\..+$/, type: 'string' },
      
      // Common spec fields
      { pattern: /^spec\.replicas$/, type: 'number' },
      { pattern: /^spec\.selector\.matchLabels\..+$/, type: 'string' },
      
      // Common status fields
      { pattern: /^status\.ready$/, type: 'boolean' },
      { pattern: /^status\.(replicas|readyReplicas|availableReplicas|unavailableReplicas)$/, type: 'number' },
      { pattern: /^status\.conditions\[\d+\]\.(type|status|reason|message)$/, type: 'string' },
      { pattern: /^status\.conditions\[\d+\]\.lastTransitionTime$/, type: 'string' },
      { pattern: /^status\.loadBalancer\.ingress\[\d+\]\.(ip|hostname)$/, type: 'string' },
      { pattern: /^status\.(podIP|hostIP)$/, type: 'string' },
      { pattern: /^status\.phase$/, type: 'string' },
      
      // Generic patterns
      { pattern: /^spec\./, type: 'unknown' },
      { pattern: /^status\./, type: 'unknown' }
    ];
    
    const matchingPattern = validPatterns.find(p => p.pattern.test(fieldPath));
    
    if (!matchingPattern) {
      return {
        valid: false,
        error: `Field path '${fieldPath}' does not match any known Kubernetes field patterns`
      };
    }
    
    return {
      valid: true,
      actualType: matchingPattern.type
    };
  }
  
  /**
   * Validate type compatibility between expected and actual types
   */
  private validateTypeCompatibility(
    ref: KubernetesRef<any>,
    resource: Enhanced<any, any>
  ): TypeCompatibilityValidationResult {
    if (!ref._type) {
      // No expected type specified, assume compatible
      return { valid: true };
    }
    
    const expectedType = String(ref._type);
    const actualType = this.inferFieldType(ref.fieldPath, resource);
    
    if (!actualType || actualType === 'unknown') {
      // Cannot determine actual type, assume compatible
      return { valid: true };
    }
    
    // Check type compatibility
    const compatible = this.areTypesCompatible(expectedType, actualType);
    
    if (!compatible) {
      return {
        valid: false,
        error: `Type mismatch: expected '${expectedType}' but field has type '${actualType}'`,
        actualType
      };
    }
    
    return { valid: true, actualType };
  }
  
  /**
   * Check if two types are compatible
   */
  private areTypesCompatible(expectedType: string, actualType: string): boolean {
    // Exact match
    if (expectedType === actualType) {
      return true;
    }
    
    // Compatible type mappings
    const compatibleTypes: Record<string, string[]> = {
      'string': ['string', 'unknown'],
      'number': ['number', 'integer', 'float', 'unknown'],
      'boolean': ['boolean', 'unknown'],
      'object': ['object', 'unknown'],
      'array': ['array', 'unknown'],
      'unknown': ['string', 'number', 'boolean', 'object', 'array', 'unknown']
    };
    
    const compatibleWithExpected = compatibleTypes[expectedType] || [];
    return compatibleWithExpected.includes(actualType);
  }
  
  /**
   * Infer the type of a field from a resource
   */
  private inferFieldType(fieldPath: string, _resource: Enhanced<any, any>): string | undefined {
    // Try to infer type from field path patterns
    if (fieldPath.includes('replicas') || fieldPath.includes('generation') || fieldPath.includes('port')) {
      return 'number';
    }
    
    if (fieldPath.includes('ready') || fieldPath.includes('enabled')) {
      return 'boolean';
    }
    
    if (fieldPath.includes('name') || fieldPath.includes('namespace') || fieldPath.includes('ip') || fieldPath.includes('phase')) {
      return 'string';
    }
    
    if (fieldPath.includes('labels') || fieldPath.includes('annotations') || fieldPath.includes('selector')) {
      return 'object';
    }
    
    if (fieldPath.includes('conditions') || fieldPath.includes('ingress')) {
      return 'array';
    }
    
    return 'unknown';
  }
  
  /**
   * Initialize known resource types
   */
  private initializeKnownTypes(): void {
    // Common Kubernetes resource types
    this.knownResourceTypes.set('Deployment', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      commonFields: {
        'metadata.name': 'string',
        'metadata.namespace': 'string',
        'spec.replicas': 'number',
        'status.readyReplicas': 'number',
        'status.availableReplicas': 'number'
      }
    });
    
    this.knownResourceTypes.set('Service', {
      apiVersion: 'v1',
      kind: 'Service',
      commonFields: {
        'metadata.name': 'string',
        'metadata.namespace': 'string',
        'spec.type': 'string',
        'spec.ports': 'array',
        'status.loadBalancer.ingress': 'array'
      }
    });
    
    this.knownResourceTypes.set('Pod', {
      apiVersion: 'v1',
      kind: 'Pod',
      commonFields: {
        'metadata.name': 'string',
        'metadata.namespace': 'string',
        'status.phase': 'string',
        'status.podIP': 'string',
        'status.hostIP': 'string'
      }
    });
  }
  
  /**
   * Register a custom schema validator
   */
  registerSchemaValidator(schemaType: string, validator: SchemaValidator): void {
    this.schemaValidators.set(schemaType, validator);
  }
  
  /**
   * Register a custom resource type
   */
  registerResourceType(name: string, typeInfo: ResourceTypeInfo): void {
    this.knownResourceTypes.set(name, typeInfo);
  }
}

/**
 * Context for resource type validation
 */
export interface ResourceTypeValidationContext {
  /** Available resources for validation */
  availableResources?: Record<string, Enhanced<any, any>> | undefined;
  
  /** Schema proxy for schema validation */
  schemaProxy?: SchemaProxy<any, any> | undefined;
  
  /** Type of schema being validated */
  schemaType?: string;
  
  /** Whether to perform strict type checking */
  strictTypeChecking?: boolean;
}

/**
 * Information about a resource type
 */
export interface ResourceTypeInfo {
  /** API version of the resource */
  apiVersion: string;
  
  /** Kind of the resource */
  kind: string;
  
  /** Common fields and their types */
  commonFields: Record<string, string>;
}

/**
 * Schema validator interface
 */
export interface SchemaValidator {
  /** Validate a field in the schema */
  validateField(fieldPath: string, expectedType?: any): SchemaFieldValidationResult;
}

/**
 * Result of schema field validation
 */
export interface SchemaFieldValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  
  /** Error message if validation failed */
  error?: string;
  
  /** Actual type of the field */
  actualType?: string;
}

/**
 * Result of field path validation
 */
export interface FieldPathValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  
  /** Error message if validation failed */
  error?: string;
  
  /** Actual type of the field */
  actualType?: string | undefined;
}

/**
 * Result of type compatibility validation
 */
export interface TypeCompatibilityValidationResult {
  /** Whether the types are compatible */
  valid: boolean;
  
  /** Error message if validation failed */
  error?: string;
  
  /** Actual type found */
  actualType?: string;
}