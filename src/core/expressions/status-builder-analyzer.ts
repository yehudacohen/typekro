/**
 * Status Builder Analyzer for JavaScript to CEL Expression Conversion
 * 
 * This module provides specialized analysis for status builder functions used in
 * toResourceGraph. It detects KubernetesRef objects from the magic proxy system
 * and converts JavaScript expressions to appropriate CEL expressions for status
 * field population.
 * 
 * Key Features:
 * - Analyzes status builder functions for KubernetesRef detection
 * - Converts return object expressions to CEL for status field mapping
 * - Integrates with magic proxy system (SchemaProxy and ResourcesProxy)
 * - Provides status context-specific CEL generation
 * - Supports both direct and Kro factory patterns
 */

import * as esprima from 'esprima';
import * as estraverse from 'estraverse';
import type { Node as ESTreeNode, ObjectExpression, ReturnStatement } from 'estree';

import type { CelExpression, KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy } from '../types/serialization.js';
import { ConversionError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { containsKubernetesRefs } from '../../utils/type-guards.js';
import { JavaScriptToCelAnalyzer, type AnalysisContext, type CelConversionResult } from './analyzer.js';
import { MagicProxyAnalyzer, } from './magic-proxy-analyzer.js';
import { SourceMapBuilder, type SourceMapEntry } from './source-map.js';
import { 
  EnhancedTypeOptionalityHandler, 
  type OptionalityContext, 
  type OptionalityAnalysisResult,
  type FieldHydrationState
} from './optionality-handler.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';

/**
 * Status builder function type for analysis
 */
export type StatusBuilderFunction<TSpec extends Record<string, any> = any, TStatus = any> = (
  schema: SchemaProxy<TSpec, any>,
  resources: Record<string, Enhanced<any, any>>
) => TStatus;

/**
 * Status field analysis result
 */
export interface StatusFieldAnalysisResult {
  /** Field name in the status object */
  fieldName: string;
  
  /** Original JavaScript expression */
  originalExpression: any;
  
  /** Converted CEL expression */
  celExpression: CelExpression | null;
  
  /** KubernetesRef dependencies detected */
  dependencies: KubernetesRef<any>[];
  
  /** Whether the expression requires conversion */
  requiresConversion: boolean;
  
  /** Whether the expression is valid */
  valid: boolean;
  
  /** Conversion errors */
  errors: ConversionError[];
  
  /** Source mapping entries */
  sourceMap: SourceMapEntry[];
  
  /** Optionality analysis results */
  optionalityAnalysis: OptionalityAnalysisResult[];
  
  /** Type information */
  inferredType: string | undefined;
  
  /** Confidence level of the analysis */
  confidence: number;
}

/**
 * Status builder analysis result
 */
export interface StatusBuilderAnalysisResult {
  /** Analysis results for each status field */
  fieldAnalysis: Map<string, StatusFieldAnalysisResult>;
  
  /** Overall status mappings (field name -> CEL expression) */
  statusMappings: Record<string, CelExpression>;
  
  /** All KubernetesRef dependencies found */
  allDependencies: KubernetesRef<any>[];
  
  /** All resource references */
  resourceReferences: KubernetesRef<any>[];
  
  /** All schema references */
  schemaReferences: KubernetesRef<any>[];
  
  /** Overall source mapping */
  sourceMap: SourceMapEntry[];
  
  /** All errors encountered */
  errors: ConversionError[];
  
  /** Whether the analysis was successful */
  valid: boolean;
  
  /** Original status builder function source */
  originalSource: string;
  
  /** Parsed AST of the status builder */
  ast?: ESTreeNode;
  
  /** Return statement analysis */
  returnStatement?: ReturnStatementAnalysis;
}

/**
 * Return statement analysis
 */
export interface ReturnStatementAnalysis {
  /** The return statement node */
  node: ReturnStatement;
  
  /** Whether it returns an object expression */
  returnsObject: boolean;
  
  /** Properties in the returned object */
  properties: PropertyAnalysis[];
  
  /** Source location information */
  sourceLocation: {
    line: number;
    column: number;
    length: number;
  };
}

/**
 * Property analysis for object expressions
 */
export interface PropertyAnalysis {
  /** Property name */
  name: string;
  
  /** Property value node */
  valueNode: ESTreeNode;
  
  /** Property value as string */
  valueSource: string;
  
  /** Whether the property contains KubernetesRef objects */
  containsKubernetesRefs: boolean;
  
  /** Source location */
  sourceLocation: {
    line: number;
    column: number;
    length: number;
  };
}

/**
 * Status field handling information
 */
export interface StatusFieldHandlingInfo {
  /** The KubernetesRef being handled */
  kubernetesRef: KubernetesRef<any>;
  
  /** Whether this field requires hydration */
  requiresHydration: boolean;
  
  /** Whether this field is optional */
  isOptional: boolean;
  
  /** Handling strategy for this field */
  strategy: StatusHandlingStrategy;
  
  /** Priority for evaluation (lower = higher priority) */
  priority: number;
  
  /** Category of the status field */
  fieldCategory: StatusFieldCategory;
  
  /** Expected availability timing */
  expectedAvailability: FieldAvailabilityEstimate;
}

/**
 * Status handling strategy
 */
export type StatusHandlingStrategy = 
  | 'direct-access'           // Direct field access, no special handling
  | 'null-safety-only'        // Add null-safety checks only
  | 'hydration-required'      // Field requires hydration
  | 'hydration-with-null-safety'; // Field requires hydration and null-safety

/**
 * Status field category
 */
export type StatusFieldCategory = 
  | 'readiness-indicator'     // Fields indicating readiness (ready, available)
  | 'condition-status'        // Kubernetes conditions
  | 'replica-status'          // Replica counts and status
  | 'network-status'          // Network-related status (loadBalancer, ingress)
  | 'lifecycle-status'        // Lifecycle status (phase, state)
  | 'general-status';         // Other status fields

/**
 * Field availability estimate
 */
export type FieldAvailabilityEstimate = 
  | 'immediate'               // Available immediately (metadata, spec)
  | 'delayed'                 // Available after some processing (most status fields)
  | 'very-delayed';           // Available after external resources (loadBalancer)

/**
 * Options for status builder analysis
 */
export interface StatusBuilderAnalysisOptions {
  /** Whether to perform deep analysis */
  deepAnalysis?: boolean;
  
  /** Whether to include source mapping */
  includeSourceMapping?: boolean;
  
  /** Whether to validate resource references */
  validateReferences?: boolean;
  
  /** Whether to perform optionality analysis */
  performOptionalityAnalysis?: boolean;
  
  /** Factory type for CEL generation */
  factoryType?: 'direct' | 'kro';
  
  /** Maximum analysis depth */
  maxDepth?: number;
  
  /** Field hydration states for optionality analysis */
  hydrationStates?: Map<string, FieldHydrationState>;
  
  /** Whether to use conservative null-safety */
  conservativeNullSafety?: boolean;
}

/**
 * Default analysis options
 */
const DEFAULT_ANALYSIS_OPTIONS: Required<StatusBuilderAnalysisOptions> = {
  deepAnalysis: true,
  includeSourceMapping: true,
  validateReferences: true,
  performOptionalityAnalysis: true,
  factoryType: 'kro',
  maxDepth: 10,
  hydrationStates: new Map(),
  conservativeNullSafety: true
};

/**
 * Status Builder Analyzer
 * 
 * Analyzes status builder functions to extract KubernetesRef dependencies
 * and convert JavaScript expressions to CEL for status field population.
 */
export class StatusBuilderAnalyzer {
  private expressionAnalyzer: JavaScriptToCelAnalyzer;
  private magicProxyAnalyzer: MagicProxyAnalyzer;
  private optionalityHandler: EnhancedTypeOptionalityHandler;
  private options: Required<StatusBuilderAnalysisOptions>;
  private logger = getComponentLogger('status-builder-analyzer');

  constructor(
    expressionAnalyzer?: JavaScriptToCelAnalyzer,
    options?: StatusBuilderAnalysisOptions
  ) {
    this.expressionAnalyzer = expressionAnalyzer || new JavaScriptToCelAnalyzer();
    this.magicProxyAnalyzer = new MagicProxyAnalyzer();
    this.optionalityHandler = new EnhancedTypeOptionalityHandler();
    this.options = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  }

  /**
   * Analyze status builder function for toResourceGraph integration
   * 
   * This is the main method that analyzes a status builder function and extracts
   * KubernetesRef dependencies for conversion to CEL expressions.
   */
  analyzeStatusBuilder<TSpec extends Record<string, any>, TStatus>(
    statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<TSpec, any>
  ): StatusBuilderAnalysisResult {
    try {
      this.logger.debug('Analyzing status builder function', {
        resourceCount: Object.keys(resources).length,
        hasSchemaProxy: !!schemaProxy,
        factoryType: this.options.factoryType
      });

      const originalSource = statusBuilder.toString();
      
      // Parse the status builder function
      const ast = this.parseStatusBuilderFunction(originalSource);
      
      // Analyze the return statement
      const returnStatement = this.analyzeReturnStatement(ast);
      
      if (!returnStatement || !returnStatement.returnsObject) {
        throw new ConversionError(
          'Status builder must return an object literal',
          originalSource,
          'function-call'
        );
      }

      // Analyze each property in the returned object
      const fieldAnalysis = new Map<string, StatusFieldAnalysisResult>();
      const statusMappings: Record<string, CelExpression> = {};
      const allDependencies: KubernetesRef<any>[] = [];
      const allSourceMap: SourceMapEntry[] = [];
      const allErrors: ConversionError[] = [];
      
      let overallValid = true;

      for (const property of returnStatement.properties) {
        try {
          const fieldResult = this.analyzeStatusField(
            property,
            resources,
            schemaProxy
          );
          
          fieldAnalysis.set(property.name, fieldResult);
          
          if (fieldResult.valid && fieldResult.celExpression) {
            statusMappings[property.name] = fieldResult.celExpression;
          }
          
          allDependencies.push(...fieldResult.dependencies);
          allSourceMap.push(...fieldResult.sourceMap);
          allErrors.push(...fieldResult.errors);
          
          if (!fieldResult.valid) {
            overallValid = false;
          }
          
        } catch (error) {
          const fieldError = new ConversionError(
            `Failed to analyze status field '${property.name}': ${error instanceof Error ? error.message : String(error)}`,
            property.valueSource,
            'unknown'
          );
          
          allErrors.push(fieldError);
          overallValid = false;
          
          this.logger.error('Failed to analyze status field', error as Error, { 
            fieldName: property.name 
          });
        }
      }

      // Categorize dependencies
      const { resourceReferences, schemaReferences } = this.categorizeDependencies(allDependencies);
      
      this.logger.debug('Status builder analysis complete', {
        fieldCount: returnStatement.properties.length,
        validFields: Object.keys(statusMappings).length,
        totalDependencies: allDependencies.length,
        resourceReferences: resourceReferences.length,
        schemaReferences: schemaReferences.length,
        overallValid
      });

      return {
        fieldAnalysis,
        statusMappings,
        allDependencies,
        resourceReferences,
        schemaReferences,
        sourceMap: allSourceMap,
        errors: allErrors,
        valid: overallValid,
        originalSource,
        ast,
        returnStatement
      };
      
    } catch (error) {
      const analysisError = new ConversionError(
        `Failed to analyze status builder: ${error instanceof Error ? error.message : String(error)}`,
        statusBuilder.toString(),
        'function-call'
      );
      
      this.logger.error('Status builder analysis failed', error as Error);

      return {
        fieldAnalysis: new Map(),
        statusMappings: {},
        allDependencies: [],
        resourceReferences: [],
        schemaReferences: [],
        sourceMap: [],
        errors: [analysisError],
        valid: false,
        originalSource: statusBuilder.toString()
      };
    }
  }

  /**
   * Analyze return object expressions with magic proxy support
   * 
   * This method analyzes the object returned by the status builder function
   * and detects KubernetesRef objects from the magic proxy system.
   */
  analyzeReturnObjectWithMagicProxy(
    returnObject: any,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>
  ): {
    statusMappings: Record<string, CelExpression>;
    dependencies: KubernetesRef<any>[];
    errors: ConversionError[];
  } {
    const statusMappings: Record<string, CelExpression> = {};
    const dependencies: KubernetesRef<any>[] = [];
    const errors: ConversionError[] = [];

    if (!returnObject || typeof returnObject !== 'object') {
      errors.push(new ConversionError(
        'Return object must be a valid object',
        String(returnObject),
        'unknown'
      ));
      return { statusMappings, dependencies, errors };
    }

    for (const [fieldName, fieldValue] of Object.entries(returnObject)) {
      try {
        const fieldResult = this.analyzeReturnObjectField(
          fieldName,
          fieldValue,
          resources,
          schemaProxy
        );
        
        if (fieldResult.celExpression) {
          statusMappings[fieldName] = fieldResult.celExpression;
        }
        
        dependencies.push(...fieldResult.dependencies);
        errors.push(...fieldResult.errors);
        
      } catch (error) {
        errors.push(new ConversionError(
          `Failed to analyze field '${fieldName}': ${error instanceof Error ? error.message : String(error)}`,
          String(fieldValue),
          'unknown'
        ));
      }
    }

    return { statusMappings, dependencies, errors };
  }

  /**
   * Analyze a single field in the return object with comprehensive magic proxy support
   */
  private analyzeReturnObjectField(
    fieldName: string,
    fieldValue: any,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>
  ): {
    celExpression: CelExpression | null;
    dependencies: KubernetesRef<any>[];
    errors: ConversionError[];
    requiresConversion: boolean;
  } {
    try {
      // Create comprehensive analysis context
      const context: OptionalityContext = {
        type: 'status',
        availableReferences: resources,
        ...(schemaProxy && { schemaProxy }),
        factoryType: this.options.factoryType,
        hydrationStates: this.options.hydrationStates,
        conservativeNullSafety: this.options.conservativeNullSafety,
        useKroConditionals: true,
        generateHasChecks: true,
        maxOptionalityDepth: this.options.maxDepth,
        dependencies: []
      };

      // Step 1: Detect if the field value contains KubernetesRef objects
      const containsRefs = containsKubernetesRefs(fieldValue);
      
      if (!containsRefs) {
        // No KubernetesRef objects - return as static value
        return {
          celExpression: this.convertStaticValueToCel(fieldValue),
          dependencies: [],
          errors: [],
          requiresConversion: false
        };
      }

      // Step 2: Analyze KubernetesRef objects for optionality requirements
      const optionalityResults = this.optionalityHandler.analyzeOptionalityRequirements(
        fieldValue,
        context
      );

      // Step 3: Generate CEL expression with appropriate null-safety
      const celResult = this.optionalityHandler.generateNullSafeCelExpression(
        fieldValue,
        optionalityResults,
        context
      );

      // Step 4: Extract dependencies from the analysis
      const dependencies = optionalityResults.map(result => result.kubernetesRef);

      return {
        celExpression: celResult.celExpression,
        dependencies,
        errors: celResult.errors,
        requiresConversion: true
      };
      
    } catch (error) {
      const fieldError = new ConversionError(
        `Failed to analyze return object field '${fieldName}': ${error instanceof Error ? error.message : String(error)}`,
        String(fieldValue),
        'unknown'
      );
      
      return {
        celExpression: null,
        dependencies: [],
        errors: [fieldError],
        requiresConversion: false
      };
    }
  }

  /**
   * Convert static values (no KubernetesRef objects) to CEL expressions
   */
  private convertStaticValueToCel(value: any): CelExpression {
    let celExpression: string;
    let type: string;
    
    if (typeof value === 'string') {
      celExpression = `"${value.replace(/"/g, '\\"')}"`;
      type = 'string';
    } else if (typeof value === 'number') {
      celExpression = String(value);
      type = 'number';
    } else if (typeof value === 'boolean') {
      celExpression = String(value);
      type = 'boolean';
    } else if (value === null) {
      celExpression = 'null';
      type = 'null';
    } else if (value === undefined) {
      celExpression = 'null';
      type = 'null';
    } else if (Array.isArray(value)) {
      const elements = value.map(item => this.convertStaticValueToCel(item).expression);
      celExpression = `[${elements.join(', ')}]`;
      type = 'array';
    } else if (typeof value === 'object') {
      const properties = Object.entries(value).map(([key, val]) => {
        const convertedVal = this.convertStaticValueToCel(val);
        return `"${key}": ${convertedVal.expression}`;
      });
      celExpression = `{${properties.join(', ')}}`;
      type = 'object';
    } else {
      celExpression = String(value);
      type = 'unknown';
    }
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: celExpression,
      type
    } as CelExpression;
  }

  /**
   * Perform deep analysis of nested return object structures
   */
  analyzeNestedReturnObjectStructure(
    returnObject: any,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>,
    depth: number = 0
  ): {
    flattenedMappings: Record<string, CelExpression>;
    nestedDependencies: Map<string, KubernetesRef<any>[]>;
    structureErrors: ConversionError[];
  } {
    const flattenedMappings: Record<string, CelExpression> = {};
    const nestedDependencies = new Map<string, KubernetesRef<any>[]>();
    const structureErrors: ConversionError[] = [];
    
    if (depth > this.options.maxDepth) {
      structureErrors.push(new ConversionError(
        `Maximum analysis depth (${this.options.maxDepth}) exceeded`,
        String(returnObject),
        'unknown'
      ));
      return { flattenedMappings, nestedDependencies, structureErrors };
    }
    
    try {
      this.analyzeObjectStructureRecursively(
        returnObject,
        '',
        flattenedMappings,
        nestedDependencies,
        structureErrors,
        resources,
        schemaProxy,
        depth
      );
    } catch (error) {
      structureErrors.push(new ConversionError(
        `Failed to analyze nested structure: ${error instanceof Error ? error.message : String(error)}`,
        String(returnObject),
        'unknown'
      ));
    }
    
    return { flattenedMappings, nestedDependencies, structureErrors };
  }

  /**
   * Recursively analyze object structure for KubernetesRef objects
   */
  private analyzeObjectStructureRecursively(
    obj: any,
    pathPrefix: string,
    flattenedMappings: Record<string, CelExpression>,
    nestedDependencies: Map<string, KubernetesRef<any>[]>,
    errors: ConversionError[],
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>,
    depth: number = 0
  ): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }
    
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      
      try {
        if (containsKubernetesRefs(value)) {
          // Analyze this field for KubernetesRef objects
          const fieldResult = this.analyzeReturnObjectField(
            fullPath,
            value,
            resources,
            schemaProxy
          );
          
          if (fieldResult.celExpression) {
            flattenedMappings[fullPath] = fieldResult.celExpression;
          }
          
          if (fieldResult.dependencies.length > 0) {
            nestedDependencies.set(fullPath, fieldResult.dependencies);
          }
          
          errors.push(...fieldResult.errors);
          
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          // Recursively analyze nested objects
          this.analyzeObjectStructureRecursively(
            value,
            fullPath,
            flattenedMappings,
            nestedDependencies,
            errors,
            resources,
            schemaProxy,
            depth + 1
          );
        } else {
          // Static value - convert directly
          flattenedMappings[fullPath] = this.convertStaticValueToCel(value);
        }
        
      } catch (error) {
        errors.push(new ConversionError(
          `Failed to analyze nested field '${fullPath}': ${error instanceof Error ? error.message : String(error)}`,
          String(value),
          'unknown'
        ));
      }
    }
  }

  /**
   * Generate status context-specific CEL from KubernetesRef objects
   * 
   * This method generates CEL expressions specifically for status context,
   * taking into account the magic proxy system and field hydration timing.
   */
  generateStatusContextCel(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): CelExpression {
    try {
      return this.generateStatusContextCelWithAdvancedFeatures(kubernetesRef, context);
    } catch (error) {
      this.logger.error('Failed to generate status context CEL', error as Error, {
        resourceId: kubernetesRef.resourceId,
        fieldPath: kubernetesRef.fieldPath
      });
      
      // Return a safe fallback
      return this.generateFallbackStatusCel(kubernetesRef);
    }
  }

  /**
   * Generate advanced status context CEL with full feature support
   */
  private generateStatusContextCelWithAdvancedFeatures(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): CelExpression {
    const isSchemaRef = kubernetesRef.resourceId === '__schema__';
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Build base CEL expression
    let baseCelExpression: string;
    if (isSchemaRef) {
      baseCelExpression = `schema.${fieldPath}`;
    } else {
      baseCelExpression = `resources.${kubernetesRef.resourceId}.${fieldPath}`;
    }
    
    // Determine status-specific handling requirements
    const statusHandlingInfo = this.analyzeStatusFieldHandlingRequirements(kubernetesRef, context);
    
    // Apply status-specific transformations
    const finalExpression = this.applyStatusContextTransformations(
      baseCelExpression,
      statusHandlingInfo,
      context
    );
    
    // Infer the result type based on the field path and context
    const resultType = this.inferStatusFieldType(kubernetesRef, context);
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: finalExpression,
      type: resultType,
      metadata: {
        isStatusContext: true,
        requiresHydration: statusHandlingInfo.requiresHydration,
        isOptional: statusHandlingInfo.isOptional,
        handlingStrategy: statusHandlingInfo.strategy
      }
    } as CelExpression;
  }

  /**
   * Analyze status field handling requirements
   */
  private analyzeStatusFieldHandlingRequirements(
    kubernetesRef: KubernetesRef<any>,
    context: OptionalityContext
  ): StatusFieldHandlingInfo {
    const fieldPath = kubernetesRef.fieldPath || '';
    const isSchemaRef = kubernetesRef.resourceId === '__schema__';
    const isStatusField = fieldPath.startsWith('status.');
    
    // Determine if this field requires hydration
    const requiresHydration = !isSchemaRef && isStatusField;
    
    // Determine if this field is optional in status context
    const isOptional = this.isFieldOptionalInStatusContext(kubernetesRef, context);
    
    // Determine handling strategy
    let strategy: StatusHandlingStrategy;
    if (requiresHydration && isOptional) {
      strategy = 'hydration-with-null-safety';
    } else if (requiresHydration) {
      strategy = 'hydration-required';
    } else if (isOptional) {
      strategy = 'null-safety-only';
    } else {
      strategy = 'direct-access';
    }
    
    // Determine priority for status field evaluation
    const priority = this.calculateStatusFieldPriority(kubernetesRef, context);
    
    return {
      kubernetesRef,
      requiresHydration,
      isOptional,
      strategy,
      priority,
      fieldCategory: this.categorizeStatusField(fieldPath),
      expectedAvailability: this.estimateFieldAvailability(kubernetesRef, context)
    };
  }

  /**
   * Apply status context-specific transformations to CEL expression
   */
  private applyStatusContextTransformations(
    baseCelExpression: string,
    handlingInfo: StatusFieldHandlingInfo,
    context: OptionalityContext
  ): string {
    let transformedExpression = baseCelExpression;
    
    switch (handlingInfo.strategy) {
      case 'hydration-with-null-safety':
        transformedExpression = this.applyHydrationWithNullSafety(
          baseCelExpression,
          handlingInfo,
          context
        );
        break;
        
      case 'hydration-required':
        transformedExpression = this.applyHydrationRequired(
          baseCelExpression,
          handlingInfo,
          context
        );
        break;
        
      case 'null-safety-only':
        transformedExpression = this.applyNullSafetyOnly(
          baseCelExpression,
          handlingInfo,
          context
        );
        break;
        
      case 'direct-access':
        // No transformation needed
        break;
    }
    
    return transformedExpression;
  }

  /**
   * Apply hydration with null-safety transformation
   */
  private applyHydrationWithNullSafety(
    baseCelExpression: string,
    _handlingInfo: StatusFieldHandlingInfo,
    context: OptionalityContext
  ): string {
    if (context.useKroConditionals) {
      // Use Kro's conditional operators
      return baseCelExpression.replace(/\./g, '?.');
    } else if (context.generateHasChecks) {
      // Use has() checks
      const pathParts = baseCelExpression.split('.');
      const hasChecks: string[] = [];
      
      for (let i = 0; i < pathParts.length; i++) {
        const partialPath = pathParts.slice(0, i + 1).join('.');
        hasChecks.push(`has(${partialPath})`);
      }
      
      return `${hasChecks.join(' && ')} && ${baseCelExpression}`;
    }
    
    return baseCelExpression;
  }

  /**
   * Apply hydration required transformation
   */
  private applyHydrationRequired(
    baseCelExpression: string,
    handlingInfo: StatusFieldHandlingInfo,
    _context: OptionalityContext
  ): string {
    // For hydration required fields, we might want to add readiness checks
    if (handlingInfo.fieldCategory === 'readiness-indicator') {
      return `${baseCelExpression} != null && ${baseCelExpression}`;
    }
    
    return baseCelExpression;
  }

  /**
   * Apply null-safety only transformation
   */
  private applyNullSafetyOnly(
    baseCelExpression: string,
    _handlingInfo: StatusFieldHandlingInfo,
    context: OptionalityContext
  ): string {
    if (context.generateHasChecks) {
      return `has(${baseCelExpression}) && ${baseCelExpression}`;
    }
    
    return baseCelExpression;
  }

  /**
   * Check if a field is optional in status context
   */
  private isFieldOptionalInStatusContext(
    kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): boolean {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Status fields are generally optional during hydration
    if (fieldPath.startsWith('status.')) {
      return true;
    }
    
    // Some spec fields might be optional
    const optionalSpecFields = [
      'spec.replicas',
      'spec.resources',
      'spec.nodeSelector',
      'spec.tolerations'
    ];
    
    if (optionalSpecFields.some(field => fieldPath.startsWith(field))) {
      return true;
    }
    
    // Metadata fields like labels and annotations are optional
    const optionalMetadataFields = [
      'metadata.labels',
      'metadata.annotations',
      'metadata.namespace'
    ];
    
    if (optionalMetadataFields.some(field => fieldPath.startsWith(field))) {
      return true;
    }
    
    return false;
  }

  /**
   * Calculate priority for status field evaluation
   */
  private calculateStatusFieldPriority(
    kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): number {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    // Higher priority (lower number) for critical status fields
    if (fieldPath.includes('ready') || fieldPath.includes('available')) {
      return 1;
    }
    
    if (fieldPath.startsWith('status.conditions')) {
      return 2;
    }
    
    if (fieldPath.startsWith('status.')) {
      return 3;
    }
    
    if (fieldPath.startsWith('spec.')) {
      return 4;
    }
    
    if (fieldPath.startsWith('metadata.')) {
      return 5;
    }
    
    return 10; // Default priority
  }

  /**
   * Categorize status field type
   */
  private categorizeStatusField(fieldPath: string): StatusFieldCategory {
    if (fieldPath.includes('ready') || fieldPath.includes('available')) {
      return 'readiness-indicator';
    }
    
    if (fieldPath.includes('conditions')) {
      return 'condition-status';
    }
    
    if (fieldPath.includes('replicas')) {
      return 'replica-status';
    }
    
    if (fieldPath.includes('loadBalancer') || fieldPath.includes('ingress')) {
      return 'network-status';
    }
    
    if (fieldPath.includes('phase') || fieldPath.includes('state')) {
      return 'lifecycle-status';
    }
    
    return 'general-status';
  }

  /**
   * Estimate field availability timing
   */
  private estimateFieldAvailability(
    kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): FieldAvailabilityEstimate {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    if (kubernetesRef.resourceId === '__schema__') {
      return 'immediate';
    }
    
    if (fieldPath.startsWith('metadata.')) {
      return 'immediate';
    }
    
    if (fieldPath.startsWith('spec.')) {
      return 'immediate';
    }
    
    if (fieldPath.includes('ready') || fieldPath.includes('available')) {
      return 'delayed';
    }
    
    if (fieldPath.includes('loadBalancer') || fieldPath.includes('ingress')) {
      return 'very-delayed';
    }
    
    return 'delayed';
  }

  /**
   * Infer the type of a status field
   */
  private inferStatusFieldType(
    kubernetesRef: KubernetesRef<any>,
    _context: OptionalityContext
  ): string {
    const fieldPath = kubernetesRef.fieldPath || '';
    
    if (fieldPath.includes('replicas') || fieldPath.includes('count')) {
      return 'number';
    }
    
    if (fieldPath.includes('ready') || fieldPath.includes('available')) {
      return 'boolean';
    }
    
    if (fieldPath.includes('conditions')) {
      return 'array';
    }
    
    if (fieldPath.includes('phase') || fieldPath.includes('state')) {
      return 'string';
    }
    
    if (fieldPath.includes('ip') || fieldPath.includes('IP')) {
      return 'string';
    }
    
    return 'unknown';
  }

  /**
   * Generate fallback status CEL expression
   */
  private generateFallbackStatusCel(kubernetesRef: KubernetesRef<any>): CelExpression {
    const isSchemaRef = kubernetesRef.resourceId === '__schema__';
    const basePath = isSchemaRef 
      ? `schema.${kubernetesRef.fieldPath}`
      : `resources.${kubernetesRef.resourceId}.${kubernetesRef.fieldPath}`;
    
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: basePath,
      type: 'unknown'
    } as CelExpression;
  }

  /**
   * Parse status builder function to AST
   */
  private parseStatusBuilderFunction(source: string): ESTreeNode {
    try {
      // Parse the function source
      const ast = esprima.parseScript(source, {
        loc: true,
        range: true,
        tolerant: true
      });
      
      return ast;
      
    } catch (error) {
      throw new ConversionError(
        `Failed to parse status builder function: ${error instanceof Error ? error.message : String(error)}`,
        source,
        'javascript'
      );
    }
  }

  /**
   * Analyze the return statement of the status builder
   */
  private analyzeReturnStatement(ast: ESTreeNode): ReturnStatementAnalysis | null {
    let foundReturnStatement: ReturnStatement | null = null;
    
    // Find the return statement
    estraverse.traverse(ast, {
      enter: (node) => {
        if (node.type === 'ReturnStatement') {
          foundReturnStatement = node as ReturnStatement;
          return estraverse.VisitorOption.Break;
        }
        return undefined;
      }
    });
    
    if (!foundReturnStatement) {
      return null;
    }
    
    // Type assertion to help TypeScript understand the type
    const returnStatement = foundReturnStatement as ReturnStatement;
    
    // Check if it returns an object expression
    const returnsObject = returnStatement.argument?.type === 'ObjectExpression';
    
    if (!returnsObject) {
      return {
        node: returnStatement,
        returnsObject: false,
        properties: [],
        sourceLocation: {
          line: returnStatement.loc?.start.line || 0,
          column: returnStatement.loc?.start.column || 0,
          length: 0
        }
      };
    }
    
    // Analyze properties in the object expression
    const objectExpression = returnStatement.argument as ObjectExpression;
    const properties: PropertyAnalysis[] = [];
    
    for (const prop of objectExpression.properties) {
      if (prop.type === 'Property' && prop.key.type === 'Identifier') {
        const propertyAnalysis: PropertyAnalysis = {
          name: prop.key.name,
          valueNode: prop.value,
          valueSource: this.getNodeSource(prop.value),
          containsKubernetesRefs: false, // Will be determined during field analysis
          sourceLocation: {
            line: prop.loc?.start.line || 0,
            column: prop.loc?.start.column || 0,
            length: prop.range ? prop.range[1] - prop.range[0] : 0
          }
        };
        
        properties.push(propertyAnalysis);
      }
    }
    
    return {
      node: returnStatement,
      returnsObject: true,
      properties,
      sourceLocation: {
        line: returnStatement.loc?.start.line || 0,
        column: returnStatement.loc?.start.column || 0,
        length: returnStatement.range ? returnStatement.range[1] - returnStatement.range[0] : 0
      }
    };
  }

  /**
   * Analyze a single status field
   */
  private analyzeStatusField(
    property: PropertyAnalysis,
    resources: Record<string, Enhanced<any, any>>,
    schemaProxy?: SchemaProxy<any, any>
  ): StatusFieldAnalysisResult {
    const fieldName = property.name;
    const originalExpression = property.valueSource;
    
    try {
      // Create analysis context
      const context: AnalysisContext = {
        type: 'status',
        availableReferences: resources,
        ...(schemaProxy && { schemaProxy }),
        factoryType: this.options.factoryType,
        ...(this.options.includeSourceMapping && { sourceMap: new SourceMapBuilder() }),
        dependencies: []
      };

      // Analyze the expression using the main analyzer
      const analysisResult = this.expressionAnalyzer.analyzeExpression(
        originalExpression,
        context
      );
      
      // Perform optionality analysis if enabled
      let optionalityAnalysis: OptionalityAnalysisResult[] = [];
      if (this.options.performOptionalityAnalysis) {
        const optionalityContext: OptionalityContext = {
          ...context,
          hydrationStates: this.options.hydrationStates,
          conservativeNullSafety: this.options.conservativeNullSafety,
          useKroConditionals: true,
          generateHasChecks: true
        };
        
        optionalityAnalysis = this.optionalityHandler.analyzeOptionalityRequirements(
          originalExpression,
          optionalityContext
        );
      }
      
      return {
        fieldName,
        originalExpression,
        celExpression: analysisResult.celExpression,
        dependencies: analysisResult.dependencies,
        requiresConversion: analysisResult.requiresConversion,
        valid: analysisResult.valid,
        errors: analysisResult.errors,
        sourceMap: analysisResult.sourceMap,
        optionalityAnalysis,
        inferredType: analysisResult.inferredType ? String(analysisResult.inferredType) : undefined,
        confidence: this.calculateFieldConfidence(analysisResult, optionalityAnalysis)
      };
      
    } catch (error) {
      const fieldError = new ConversionError(
        `Failed to analyze field '${fieldName}': ${error instanceof Error ? error.message : String(error)}`,
        originalExpression,
        'unknown'
      );
      
      return {
        fieldName,
        originalExpression,
        celExpression: null,
        dependencies: [],
        requiresConversion: false,
        valid: false,
        errors: [fieldError],
        sourceMap: [],
        optionalityAnalysis: [],
        inferredType: undefined,
        confidence: 0
      };
    }
  }

  /**
   * Get source code for an AST node
   */
  private getNodeSource(_node: ESTreeNode): string {
    // This is a simplified implementation
    // In a real implementation, this would extract the actual source text
    return '<expression>';
  }

  /**
   * Calculate confidence level for field analysis
   */
  private calculateFieldConfidence(
    analysisResult: CelConversionResult,
    optionalityAnalysis: OptionalityAnalysisResult[]
  ): number {
    let confidence = 0.8; // Base confidence
    
    if (analysisResult.valid) {
      confidence += 0.1;
    }
    
    if (analysisResult.errors.length === 0) {
      confidence += 0.1;
    }
    
    // Factor in optionality analysis confidence
    if (optionalityAnalysis.length > 0) {
      const avgOptionalityConfidence = optionalityAnalysis.reduce(
        (sum, result) => sum + result.confidence,
        0
      ) / optionalityAnalysis.length;
      
      confidence = (confidence + avgOptionalityConfidence) / 2;
    }
    
    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Categorize dependencies into resource and schema references
   */
  private categorizeDependencies(
    dependencies: KubernetesRef<any>[]
  ): {
    resourceReferences: KubernetesRef<any>[];
    schemaReferences: KubernetesRef<any>[];
  } {
    const resourceReferences: KubernetesRef<any>[] = [];
    const schemaReferences: KubernetesRef<any>[] = [];
    
    for (const dep of dependencies) {
      if (dep.resourceId === '__schema__') {
        schemaReferences.push(dep);
      } else {
        resourceReferences.push(dep);
      }
    }
    
    return { resourceReferences, schemaReferences };
  }
}

/**
 * Analyze status builder function for toResourceGraph integration with KubernetesRef detection
 * 
 * This is the main integration point for toResourceGraph to analyze status builder functions
 * and detect KubernetesRef objects from the magic proxy system.
 */
export function analyzeStatusBuilderForToResourceGraph<TSpec extends Record<string, any>, TStatus>(
  statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<TSpec, any>,
  factoryType: 'direct' | 'kro' = 'kro'
): {
  statusMappings: Record<string, CelExpression>;
  dependencies: KubernetesRef<any>[];
  hydrationOrder: string[];
  errors: ConversionError[];
  valid: boolean;
  requiresConversion: boolean;
} {
  const options: StatusBuilderAnalysisOptions = {
    deepAnalysis: true,
    includeSourceMapping: true,
    validateReferences: true,
    performOptionalityAnalysis: true,
    factoryType,
    conservativeNullSafety: true
  };
  
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  const result = analyzer.analyzeStatusBuilder(statusBuilder, resources, schemaProxy);
  
  // Calculate hydration order based on dependencies
  const hydrationOrder = calculateStatusFieldHydrationOrder(result.fieldAnalysis);
  
  // Determine if any conversion is required
  const requiresConversion = Array.from(result.fieldAnalysis.values()).some(
    field => field.requiresConversion
  );
  
  return {
    statusMappings: result.statusMappings,
    dependencies: result.allDependencies,
    hydrationOrder,
    errors: result.errors,
    valid: result.valid,
    requiresConversion
  };
}

/**
 * Calculate hydration order for status fields based on their dependencies
 */
function calculateStatusFieldHydrationOrder(
  fieldAnalysis: Map<string, StatusFieldAnalysisResult>
): string[] {
  const fieldDependencies = new Map<string, Set<string>>();
  const allFields = Array.from(fieldAnalysis.keys());
  
  // Build field-to-field dependencies
  for (const [fieldName, analysis] of fieldAnalysis) {
    const fieldDeps = new Set<string>();
    
    // For each KubernetesRef dependency, find other fields that might provide that data
    for (const dep of analysis.dependencies) {
      if (dep.resourceId !== '__schema__') {
        // Find fields that reference the same resource
        for (const [otherField, otherAnalysis] of fieldAnalysis) {
          if (otherField !== fieldName) {
            const hasMatchingResource = otherAnalysis.dependencies.some(
              otherDep => otherDep.resourceId === dep.resourceId
            );
            if (hasMatchingResource) {
              fieldDeps.add(otherField);
            }
          }
        }
      }
    }
    
    fieldDependencies.set(fieldName, fieldDeps);
  }
  
  // Perform topological sort
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];
  
  const visit = (field: string): void => {
    if (visiting.has(field)) {
      // Circular dependency - add to result anyway
      return;
    }
    
    if (visited.has(field)) {
      return;
    }
    
    visiting.add(field);
    
    const deps = fieldDependencies.get(field) || new Set();
    for (const dep of deps) {
      visit(dep);
    }
    
    visiting.delete(field);
    visited.add(field);
    result.push(field);
  };
  
  for (const field of allFields) {
    visit(field);
  }
  
  return result;
}

/**
 * Convenience function to analyze status builder functions
 */
export function analyzeStatusBuilder<TSpec extends Record<string, any>, TStatus>(
  statusBuilder: StatusBuilderFunction<TSpec, TStatus>,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<TSpec, any>,
  options?: StatusBuilderAnalysisOptions
): StatusBuilderAnalysisResult {
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  return analyzer.analyzeStatusBuilder(statusBuilder, resources, schemaProxy);
}

/**
 * Convenience function to analyze return objects with magic proxy support
 */
export function analyzeReturnObjectWithMagicProxy(
  returnObject: any,
  resources: Record<string, Enhanced<any, any>>,
  schemaProxy?: SchemaProxy<any, any>,
  options?: StatusBuilderAnalysisOptions
): {
  statusMappings: Record<string, CelExpression>;
  dependencies: KubernetesRef<any>[];
  errors: ConversionError[];
} {
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  return analyzer.analyzeReturnObjectWithMagicProxy(returnObject, resources, schemaProxy);
}

/**
 * Convenience function to generate status context-specific CEL
 */
export function generateStatusContextCel(
  kubernetesRef: KubernetesRef<any>,
  context: OptionalityContext,
  options?: StatusBuilderAnalysisOptions
): CelExpression {
  const analyzer = new StatusBuilderAnalyzer(undefined, options);
  return analyzer.generateStatusContextCel(kubernetesRef, context);
}