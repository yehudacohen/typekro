/**
 * Factory Pattern Handler for JavaScript to CEL Expression Conversion
 * 
 * This module provides different expression handling strategies based on the factory pattern:
 * - DirectFactoryExpressionHandler: For direct deployment evaluation
 * - KroFactoryExpressionHandler: For CEL conversion and Kro deployment
 * 
 * The factory pattern determines how expressions containing KubernetesRef objects
 * are processed and converted.
 */

import type { CelExpression, KubernetesRef } from '../types/common.js';
import { ConversionError } from '../errors.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import type { AnalysisContext, CelConversionResult } from './analyzer.js';

/**
 * Factory pattern types supported by TypeKro
 */
export type FactoryPatternType = 'direct' | 'kro';

/**
 * Base interface for factory expression handlers
 */
export interface FactoryExpressionHandler {
  /**
   * Handle expressions containing KubernetesRef objects
   */
  handleExpression(
    expression: any,
    context: AnalysisContext
  ): CelConversionResult;
  
  /**
   * Convert a KubernetesRef to appropriate format for this factory pattern
   */
  convertKubernetesRef(
    ref: KubernetesRef<any>,
    context: AnalysisContext
  ): CelExpression;
  
  /**
   * Get the factory pattern type
   */
  getPatternType(): FactoryPatternType;
}

/**
 * Expression handler for direct deployment pattern
 * 
 * In direct deployment, expressions are evaluated at deployment time
 * by resolving KubernetesRef objects to actual values from deployed resources.
 */
export class DirectFactoryExpressionHandler implements FactoryExpressionHandler {
  
  getPatternType(): FactoryPatternType {
    return 'direct';
  }
  
  handleExpression(
    expression: any,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // For direct deployment, we still need to generate CEL expressions
      // but they will be evaluated by the direct deployment engine
      // rather than by the Kro controller
      
      if (typeof expression === 'string') {
        // Handle string expressions that may contain KubernetesRef references
        return this.handleStringExpression(expression, context);
      }
      
      if (this.isKubernetesRef(expression)) {
        // Direct KubernetesRef object
        const celExpression = this.convertKubernetesRef(expression, context);
        return {
          valid: true,
          celExpression,
          dependencies: [expression],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: true
        };
      }
      
      // For other types, check if they contain KubernetesRef objects
      const dependencies = this.extractKubernetesRefs(expression);
      if (dependencies.length === 0) {
        // No KubernetesRef objects - no conversion needed
        return {
          valid: true,
          celExpression: null,
          dependencies: [],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: false
        };
      }
      
      // Complex expression with KubernetesRef objects
      return this.handleComplexExpression(expression, dependencies, context);
      
    } catch (error) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [new ConversionError(
          `Direct factory expression handling failed: ${error instanceof Error ? error.message : String(error)}`,
          String(expression),
          'javascript'
        )],
        warnings: [],
        requiresConversion: true
      };
    }
  }
  
  convertKubernetesRef(
    ref: KubernetesRef<any>,
    _context: AnalysisContext
  ): CelExpression {
    // For direct deployment, generate CEL expressions that will be
    // resolved by the direct deployment engine
    if (ref.resourceId === '__schema__') {
      // Schema references
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `schema.${ref.fieldPath}`,
        _type: ref._type
      } as CelExpression;
    } else {
      // Resource references
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `resources.${ref.resourceId}.${ref.fieldPath}`,
        _type: ref._type
      } as CelExpression;
    }
  }
  
  private handleStringExpression(
    expression: string,
    _context: AnalysisContext
  ): CelConversionResult {
    // For direct deployment, string expressions are typically
    // JavaScript expressions that need to be converted to CEL
    // This would integrate with the main analyzer
    
    // For now, return a placeholder result
    return {
      valid: true,
      celExpression: {
        [CEL_EXPRESSION_BRAND]: true,
        expression: expression,
        _type: undefined
      } as CelExpression,
      dependencies: [],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: true
    };
  }
  
  private handleComplexExpression(
    _expression: any,
    dependencies: KubernetesRef<any>[],
    _context: AnalysisContext
  ): CelConversionResult {
    // Handle complex expressions containing KubernetesRef objects
    // This would involve analyzing the structure and converting appropriately
    
    return {
      valid: true,
      celExpression: {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `/* Complex expression with ${dependencies.length} dependencies */`,
        _type: undefined
      } as CelExpression,
      dependencies,
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: true
    };
  }
  
  private isKubernetesRef(value: any): value is KubernetesRef<any> {
    return value && typeof value === 'object' && 
           typeof value.resourceId === 'string' && 
           typeof value.fieldPath === 'string';
  }
  
  private extractKubernetesRefs(value: any): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    if (this.isKubernetesRef(value)) {
      refs.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        refs.push(...this.extractKubernetesRefs(item));
      }
    } else if (value && typeof value === 'object') {
      for (const key in value) {
        if (Object.hasOwn(value, key)) {
          refs.push(...this.extractKubernetesRefs(value[key]));
        }
      }
    }
    
    return refs;
  }
}

/**
 * Expression handler for Kro deployment pattern
 * 
 * In Kro deployment, expressions are converted to CEL and evaluated
 * by the Kro controller at runtime.
 */
export class KroFactoryExpressionHandler implements FactoryExpressionHandler {
  
  getPatternType(): FactoryPatternType {
    return 'kro';
  }
  
  handleExpression(
    expression: any,
    context: AnalysisContext
  ): CelConversionResult {
    try {
      // For Kro deployment, we need to generate CEL expressions
      // that will be evaluated by the Kro controller
      
      if (typeof expression === 'string') {
        // Handle string expressions that may contain KubernetesRef references
        return this.handleStringExpression(expression, context);
      }
      
      if (this.isKubernetesRef(expression)) {
        // Direct KubernetesRef object
        const celExpression = this.convertKubernetesRef(expression, context);
        return {
          valid: true,
          celExpression,
          dependencies: [expression],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: true
        };
      }
      
      // For other types, check if they contain KubernetesRef objects
      const dependencies = this.extractKubernetesRefs(expression);
      if (dependencies.length === 0) {
        // No KubernetesRef objects - no conversion needed
        return {
          valid: true,
          celExpression: null,
          dependencies: [],
          sourceMap: [],
          errors: [],
          warnings: [],
          requiresConversion: false
        };
      }
      
      // Complex expression with KubernetesRef objects
      return this.handleComplexExpression(expression, dependencies, context);
      
    } catch (error) {
      return {
        valid: false,
        celExpression: null,
        dependencies: [],
        sourceMap: [],
        errors: [new ConversionError(
          `Kro factory expression handling failed: ${error instanceof Error ? error.message : String(error)}`,
          String(expression),
          'javascript'
        )],
        warnings: [],
        requiresConversion: true
      };
    }
  }
  
  convertKubernetesRef(
    ref: KubernetesRef<any>,
    _context: AnalysisContext
  ): CelExpression {
    // For Kro deployment, generate CEL expressions that will be
    // evaluated by the Kro controller
    if (ref.resourceId === '__schema__') {
      // Schema references
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `schema.${ref.fieldPath}`,
        _type: ref._type
      } as CelExpression;
    } else {
      // Resource references
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `resources.${ref.resourceId}.${ref.fieldPath}`,
        _type: ref._type
      } as CelExpression;
    }
  }
  
  private handleStringExpression(
    expression: string,
    _context: AnalysisContext
  ): CelConversionResult {
    // For Kro deployment, string expressions need to be converted
    // to CEL expressions that the Kro controller can evaluate
    
    // For now, return a placeholder result
    return {
      valid: true,
      celExpression: {
        [CEL_EXPRESSION_BRAND]: true,
        expression: expression,
        _type: undefined
      } as CelExpression,
      dependencies: [],
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: true
    };
  }
  
  private handleComplexExpression(
    _expression: any,
    dependencies: KubernetesRef<any>[],
    _context: AnalysisContext
  ): CelConversionResult {
    // Handle complex expressions containing KubernetesRef objects
    // For Kro deployment, these need to be converted to CEL expressions
    
    return {
      valid: true,
      celExpression: {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `/* Complex Kro expression with ${dependencies.length} dependencies */`,
        _type: undefined
      } as CelExpression,
      dependencies,
      sourceMap: [],
      errors: [],
      warnings: [],
      requiresConversion: true
    };
  }
  
  private isKubernetesRef(value: any): value is KubernetesRef<any> {
    return value && typeof value === 'object' && 
           typeof value.resourceId === 'string' && 
           typeof value.fieldPath === 'string';
  }
  
  private extractKubernetesRefs(value: any): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    if (this.isKubernetesRef(value)) {
      refs.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        refs.push(...this.extractKubernetesRefs(item));
      }
    } else if (value && typeof value === 'object') {
      for (const key in value) {
        if (Object.hasOwn(value, key)) {
          refs.push(...this.extractKubernetesRefs(value[key]));
        }
      }
    }
    
    return refs;
  }
}

/**
 * Factory for creating appropriate expression handlers based on factory pattern
 */
export class FactoryPatternHandlerFactory {
  
  /**
   * Create an expression handler for the specified factory pattern
   */
  static createHandler(patternType: FactoryPatternType): FactoryExpressionHandler {
    switch (patternType) {
      case 'direct':
        return new DirectFactoryExpressionHandler();
      case 'kro':
        return new KroFactoryExpressionHandler();
      default:
        throw new Error(`Unsupported factory pattern type: ${patternType}`);
    }
  }
  
  /**
   * Detect factory pattern from context
   */
  static detectFactoryPattern(context: AnalysisContext): FactoryPatternType {
    return context.factoryType;
  }
  
  /**
   * Create handler based on analysis context
   */
  static createHandlerFromContext(context: AnalysisContext): FactoryExpressionHandler {
    const patternType = FactoryPatternHandlerFactory.detectFactoryPattern(context);
    return FactoryPatternHandlerFactory.createHandler(patternType);
  }
}

/**
 * Main factory pattern integration point
 * 
 * This function provides the main integration point for factory pattern
 * aware expression handling.
 */
export function handleExpressionWithFactoryPattern(
  expression: any,
  context: AnalysisContext
): CelConversionResult {
  const handler = FactoryPatternHandlerFactory.createHandlerFromContext(context);
  return handler.handleExpression(expression, context);
}