/**
 * MagicAssignable Type Integration for JavaScript to CEL Expression Conversion
 * 
 * This module provides type-aware expression analysis for MagicAssignable and MagicAssignableShape types.
 * It detects when expressions contain KubernetesRef objects from TypeKro's magic proxy system and
 * converts them to appropriate CEL expressions while preserving type safety.
 * 
 * Key Features:
 * - Detects KubernetesRef objects in MagicAssignable values
 * - Recursively analyzes MagicAssignableShape objects
 * - Performance optimization for static values (no KubernetesRef objects)
 * - Type-aware expression analysis with proper error handling
 */

import { containsKubernetesRefs, isKubernetesRef } from '../../utils/type-guards.js';
import type { CelExpression, KubernetesRef, MagicAssignable } from '../types/common.js';
import type { MagicAssignableShape } from '../types/serialization.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { ConversionError } from '../errors.js';
import { JavaScriptToCelAnalyzer, type AnalysisContext, type CelConversionResult } from './analyzer.js';
import { SourceMapBuilder, type SourceMapEntry } from './source-map.js';

/**
 * Result of analyzing a MagicAssignable value
 */
export interface ProcessedMagicAssignable<T> {
  /** Original value passed to the analyzer */
  originalValue: MagicAssignable<T>;
  
  /** Processed value - either the original value or a CEL expression */
  processedValue: T | CelExpression<T>;
  
  /** KubernetesRef dependencies detected in the value */
  dependencies: KubernetesRef<any>[];
  
  /** Conversion errors encountered during analysis */
  errors: ConversionError[];
  
  /** Whether the value actually required conversion (contained KubernetesRef objects) */
  requiresConversion: boolean;
  
  /** Source mapping entries for debugging */
  sourceMap: SourceMapEntry[];
  
  /** Whether the analysis was successful */
  valid: boolean;
}

/**
 * Result of analyzing a MagicAssignableShape object
 */
export interface ProcessedMagicAssignableShape<T> {
  /** Original shape object passed to the analyzer */
  originalShape: MagicAssignableShape<T>;
  
  /** Processed shape with converted expressions */
  processedShape: T;
  
  /** All KubernetesRef dependencies detected across all fields */
  dependencies: KubernetesRef<any>[];
  
  /** All conversion errors encountered during analysis */
  errors: ConversionError[];
  
  /** Whether any field in the shape required conversion */
  requiresConversion: boolean;
  
  /** Source mapping entries for all processed fields */
  sourceMap: SourceMapEntry[];
  
  /** Whether the overall analysis was successful */
  valid: boolean;
  
  /** Field-level analysis results for detailed inspection */
  fieldResults: Record<string, ProcessedMagicAssignable<any>>;
}

/**
 * Options for MagicAssignable analysis
 */
export interface MagicAssignableAnalysisOptions {
  /** Whether to perform deep analysis of nested objects */
  deepAnalysis?: boolean;
  
  /** Whether to validate types during analysis */
  validateTypes?: boolean;
  
  /** Whether to optimize static values (skip analysis if no KubernetesRef objects) */
  optimizeStaticValues?: boolean;
  
  /** Maximum depth for recursive analysis */
  maxDepth?: number;
  
  /** Whether to include source mapping */
  includeSourceMapping?: boolean;
}

/**
 * Default options for MagicAssignable analysis
 */
const DEFAULT_ANALYSIS_OPTIONS: Required<MagicAssignableAnalysisOptions> = {
  deepAnalysis: true,
  validateTypes: true,
  optimizeStaticValues: true,
  maxDepth: 10,
  includeSourceMapping: true
};

/**
 * MagicAssignable analyzer for type-aware expression analysis with KubernetesRef detection
 */
export class MagicAssignableAnalyzer {
  private expressionAnalyzer: JavaScriptToCelAnalyzer;
  private options: Required<MagicAssignableAnalysisOptions>;

  constructor(
    expressionAnalyzer?: JavaScriptToCelAnalyzer,
    options?: MagicAssignableAnalysisOptions
  ) {
    this.expressionAnalyzer = expressionAnalyzer || new JavaScriptToCelAnalyzer();
    this.options = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  }

  /**
   * Analyze a MagicAssignable value for KubernetesRef objects and convert to CEL if needed
   */
  analyzeMagicAssignable<T>(
    value: MagicAssignable<T>,
    context: AnalysisContext
  ): ProcessedMagicAssignable<T> {
    try {
      // Performance optimization: check for static values first
      if (this.options.optimizeStaticValues && this.isStaticValue(value)) {
        return this.createStaticResult(value);
      }

      // Check if the value contains KubernetesRef objects
      if (!this.containsKubernetesRefs(value)) {
        // No KubernetesRef objects found - return as-is (no conversion needed)
        return this.createStaticResult(value);
      }

      // Value contains KubernetesRef objects - needs conversion
      const conversionResult = this.convertMagicAssignableValue(value, context);
      
      return {
        originalValue: value,
        processedValue: conversionResult.valid ? (conversionResult.celExpression! as CelExpression<T>) : (value as T),
        dependencies: conversionResult.dependencies,
        errors: conversionResult.errors,
        requiresConversion: conversionResult.requiresConversion,
        sourceMap: conversionResult.sourceMap,
        valid: conversionResult.valid
      };
    } catch (error) {
      const conversionError = new ConversionError(
        `Failed to analyze MagicAssignable value: ${error instanceof Error ? error.message : String(error)}`,
        String(value),
        'magic-assignable'
      );

      return {
        originalValue: value,
        processedValue: value as T,
        dependencies: [],
        errors: [conversionError],
        requiresConversion: false,
        sourceMap: [],
        valid: false
      };
    }
  }

  /**
   * Analyze a MagicAssignableShape object for KubernetesRef objects and convert fields to CEL if needed
   */
  analyzeMagicAssignableShape<T extends Record<string, any>>(
    shape: MagicAssignableShape<T>,
    context: AnalysisContext
  ): ProcessedMagicAssignableShape<T> {
    try {
      // Performance optimization: check if the entire shape is static first
      if (this.options.optimizeStaticValues && !this.containsKubernetesRefs(shape)) {
        // Still need to populate fieldResults for static values
        const fieldResults: Record<string, ProcessedMagicAssignable<any>> = {};
        for (const [key, value] of Object.entries(shape)) {
          fieldResults[key] = {
            originalValue: value,
            processedValue: value,
            dependencies: [],
            errors: [],
            requiresConversion: false,
            sourceMap: [],
            valid: true
          };
        }
        
        return {
          originalShape: shape,
          processedShape: shape as T, // Static shapes are returned as-is
          dependencies: [],
          errors: [],
          requiresConversion: false,
          sourceMap: [],
          valid: true,
          fieldResults
        };
      }

      const processedShape: any = {};
      const allDependencies: KubernetesRef<any>[] = [];
      const allErrors: ConversionError[] = [];
      const allSourceMap: SourceMapEntry[] = [];
      const fieldResults: Record<string, ProcessedMagicAssignable<any>> = {};
      
      let requiresConversion = false;
      let overallValid = true;

      // Analyze each field in the shape
      for (const [key, value] of Object.entries(shape)) {
        try {
          // Create field-specific context
          const fieldContext: AnalysisContext = {
            ...context,
            ...(this.options.includeSourceMapping ? { sourceMap: new SourceMapBuilder() } : {})
          };

          // Check if this is a nested object that needs shape analysis
          if (this.isNestedObject(value)) {
            // Recursively analyze nested shape
            const nestedResult = this.analyzeMagicAssignableShape(value, fieldContext);
            
            // Create a field result from the nested result
            const fieldResult: ProcessedMagicAssignable<any> = {
              originalValue: value,
              processedValue: nestedResult.processedShape,
              dependencies: nestedResult.dependencies,
              errors: nestedResult.errors,
              requiresConversion: nestedResult.requiresConversion,
              sourceMap: nestedResult.sourceMap,
              valid: nestedResult.valid
            };
            
            fieldResults[key] = fieldResult;
            processedShape[key] = nestedResult.processedShape;
            
            // Accumulate nested results
            allDependencies.push(...nestedResult.dependencies);
            allErrors.push(...nestedResult.errors);
            allSourceMap.push(...nestedResult.sourceMap);
            
            requiresConversion = requiresConversion || nestedResult.requiresConversion;
            overallValid = overallValid && nestedResult.valid;
          } else {
            // Analyze the field value as a single MagicAssignable
            const fieldResult = this.analyzeMagicAssignable(value, fieldContext);
            
            // Store field result for detailed inspection
            fieldResults[key] = fieldResult;
            
            // Use the processed value in the result shape
            processedShape[key] = fieldResult.processedValue;
            
            // Accumulate results
            allDependencies.push(...fieldResult.dependencies);
            allErrors.push(...fieldResult.errors);
            allSourceMap.push(...fieldResult.sourceMap);
            
            // Update flags
            requiresConversion = requiresConversion || fieldResult.requiresConversion;
            overallValid = overallValid && fieldResult.valid;
          }
          
        } catch (error) {
          const fieldError = new ConversionError(
            `Failed to analyze field '${key}': ${error instanceof Error ? error.message : String(error)}`,
            String(value),
            'magic-assignable-shape'
          );
          
          allErrors.push(fieldError);
          processedShape[key] = value; // Keep original value on error
          fieldResults[key] = {
            originalValue: value,
            processedValue: value,
            dependencies: [],
            errors: [fieldError],
            requiresConversion: false,
            sourceMap: [],
            valid: false
          };
          overallValid = false;
        }
      }

      return {
        originalShape: shape,
        processedShape: processedShape as T,
        dependencies: allDependencies,
        errors: allErrors,
        requiresConversion,
        sourceMap: allSourceMap,
        valid: overallValid,
        fieldResults
      };
    } catch (error) {
      const shapeError = new ConversionError(
        `Failed to analyze MagicAssignableShape: ${error instanceof Error ? error.message : String(error)}`,
        '[circular or complex object]',
        'magic-assignable-shape'
      );

      return {
        originalShape: shape,
        processedShape: shape as T,
        dependencies: [],
        errors: [shapeError],
        requiresConversion: false,
        sourceMap: [],
        valid: false,
        fieldResults: {}
      };
    }
  }

  /**
   * Check if a value is static (contains no KubernetesRef objects)
   * This is a performance optimization to avoid unnecessary analysis
   */
  private isStaticValue(value: any): boolean {
    // Null and undefined are static
    if (value === null || value === undefined) {
      return true;
    }

    // Primitive types are static
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return true;
    }

    // Functions are not static (they might contain references)
    if (typeof value === 'function') {
      return false;
    }

    // Check for KubernetesRef objects
    if (isKubernetesRef(value)) {
      return false;
    }

    // For objects and arrays, we need to check recursively
    // But for performance, we'll use the containsKubernetesRefs utility
    return !this.containsKubernetesRefs(value);
  }

  /**
   * Check if a value contains KubernetesRef objects (recursively)
   */
  private containsKubernetesRefs(value: any): boolean {
    return containsKubernetesRefs(value);
  }

  /**
   * Check if a value is a nested object that should be analyzed as a shape
   */
  private isNestedObject(value: any): boolean {
    // Must be an object
    if (!value || typeof value !== 'object') {
      return false;
    }

    // Must not be an array
    if (Array.isArray(value)) {
      return false;
    }

    // Must not be a KubernetesRef
    if (isKubernetesRef(value)) {
      return false;
    }

    // Must not be a CelExpression
    if (value[CEL_EXPRESSION_BRAND]) {
      return false;
    }

    // Must not be a function
    if (typeof value === 'function') {
      return false;
    }

    // Must be a plain object with string keys
    return Object.keys(value).length > 0;
  }

  /**
   * Create a result for static values that don't need conversion
   */
  private createStaticResult<T>(value: MagicAssignable<T>): ProcessedMagicAssignable<T> {
    return {
      originalValue: value,
      processedValue: value as T, // Static values are returned as-is
      dependencies: [],
      errors: [],
      requiresConversion: false,
      sourceMap: [],
      valid: true
    };
  }

  /**
   * Convert a MagicAssignable value that contains KubernetesRef objects
   */
  private convertMagicAssignableValue<T>(
    value: MagicAssignable<T>,
    context: AnalysisContext
  ): CelConversionResult {
    // Direct KubernetesRef object
    if (isKubernetesRef(value)) {
      return this.expressionAnalyzer.analyzeExpressionWithRefs(value, context);
    }

    // String expression that might contain KubernetesRef interpolations
    if (typeof value === 'string') {
      return this.expressionAnalyzer.analyzeExpressionWithRefs(value, context);
    }

    // Function expression
    if (typeof value === 'function') {
      return this.expressionAnalyzer.analyzeExpressionWithRefs(value, context);
    }

    // Array containing KubernetesRef objects - process each element
    if (Array.isArray(value)) {
      return this.convertArrayValue(value, context);
    }

    // Complex object containing KubernetesRef objects
    return this.expressionAnalyzer.analyzeExpressionWithRefs(value, context);
  }

  /**
   * Convert an array that contains KubernetesRef objects
   */
  private convertArrayValue(
    array: any[],
    context: AnalysisContext
  ): CelConversionResult {
    const processedArray: any[] = [];
    const allDependencies: KubernetesRef<any>[] = [];
    const allErrors: ConversionError[] = [];
    let hasConversions = false;

    for (let i = 0; i < array.length; i++) {
      const element = array[i];
      
      if (this.containsKubernetesRefs(element)) {
        // Element needs conversion
        const elementResult = this.convertMagicAssignableValue(element, context);
        
        if (elementResult.valid && elementResult.celExpression) {
          processedArray[i] = elementResult.celExpression;
          hasConversions = true;
        } else {
          processedArray[i] = element; // Keep original if conversion failed
        }
        
        allDependencies.push(...elementResult.dependencies);
        allErrors.push(...elementResult.errors);
      } else {
        // Static element - keep as-is
        processedArray[i] = element;
      }
    }

    return {
      valid: allErrors.length === 0,
      celExpression: hasConversions ? processedArray as any : array as any,
      dependencies: allDependencies,
      errors: allErrors,
      warnings: [],
      sourceMap: [],
      requiresConversion: hasConversions
    };
  }
}

/**
 * Convenience function to analyze a MagicAssignable value
 */
export function analyzeMagicAssignable<T>(
  value: MagicAssignable<T>,
  context: AnalysisContext,
  options?: MagicAssignableAnalysisOptions
): ProcessedMagicAssignable<T> {
  const analyzer = new MagicAssignableAnalyzer(undefined, options);
  return analyzer.analyzeMagicAssignable(value, context);
}

/**
 * Convenience function to analyze a MagicAssignableShape object
 */
export function analyzeMagicAssignableShape<T extends Record<string, any>>(
  shape: MagicAssignableShape<T>,
  context: AnalysisContext,
  options?: MagicAssignableAnalysisOptions
): ProcessedMagicAssignableShape<T> {
  const analyzer = new MagicAssignableAnalyzer(undefined, options);
  return analyzer.analyzeMagicAssignableShape(shape, context);
}