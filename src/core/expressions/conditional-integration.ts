/**
 * Conditional Expression Integration for Factory Functions
 * 
 * This module provides integration points for conditional expressions like
 * includeWhen and readyWhen in factory functions, enabling automatic
 * KubernetesRef detection and CEL conversion.
 */

import { getComponentLogger } from '../logging/index.js';
import type { Enhanced, } from '../types/index.js';
import { 
  ConditionalExpressionProcessor,
  type ConditionalExpressionConfig,
  type ConditionalExpressionResult 
} from './conditional-expression-processor.js';
import type { FactoryExpressionContext } from './types.js';
import { getCurrentCompositionContext } from '../../factories/shared.js';

const logger = getComponentLogger('conditional-integration');

/**
 * Configuration for conditional expression integration
 */
export interface ConditionalIntegrationConfig extends ConditionalExpressionConfig {
  /** Whether to automatically process conditional expressions */
  autoProcess?: boolean;
  /** Whether to validate conditional expressions */
  validateExpressions?: boolean;
}

/**
 * Conditional expression properties that can be added to Enhanced resources
 */
export interface ConditionalExpressionProperties {
  /** Condition for including this resource in deployment */
  includeWhen?: any;
  /** Condition for considering this resource ready */
  readyWhen?: any;
  /** Custom conditional expressions */
  conditionals?: Record<string, any>;
}

/**
 * Enhanced resource with conditional expression support
 */
export type EnhancedWithConditionals<TSpec, TStatus> = Enhanced<TSpec, TStatus> & ConditionalExpressionProperties & {
  /** Set includeWhen condition */
  withIncludeWhen(condition: any): EnhancedWithConditionals<TSpec, TStatus>;
  /** Set readyWhen condition */
  withReadyWhen(condition: any): EnhancedWithConditionals<TSpec, TStatus>;
  /** Add custom conditional expression */
  withConditional(name: string, condition: any): EnhancedWithConditionals<TSpec, TStatus>;
};

/**
 * Result of conditional expression integration
 */
export interface ConditionalIntegrationResult {
  /** Whether any conditional expressions were processed */
  hasConditionals: boolean;
  /** Processing results for each conditional expression */
  results: {
    includeWhen?: ConditionalExpressionResult;
    readyWhen?: ConditionalExpressionResult;
    conditionals?: Record<string, ConditionalExpressionResult>;
  };
  /** Total processing time */
  totalProcessingTimeMs: number;
  /** Any integration warnings */
  warnings: string[];
}

/**
 * Conditional Expression Integrator
 * 
 * Integrates conditional expression processing with factory functions
 * and Enhanced resources.
 */
export class ConditionalExpressionIntegrator {
  private processor: ConditionalExpressionProcessor;

  constructor() {
    this.processor = new ConditionalExpressionProcessor();
  }

  /**
   * Add conditional expression support to an Enhanced resource
   * 
   * @param resource - Enhanced resource to augment
   * @param config - Integration configuration
   * @returns Enhanced resource with conditional expression support
   */
  addConditionalSupport<TSpec, TStatus>(
    resource: Enhanced<TSpec, TStatus>,
    config: ConditionalIntegrationConfig = {}
  ): EnhancedWithConditionals<TSpec, TStatus> {
    const enhanced = resource as EnhancedWithConditionals<TSpec, TStatus>;

    // Add conditional expression properties
    Object.defineProperty(enhanced, 'includeWhen', {
      value: undefined,
      writable: true,
      enumerable: false, // Don't serialize by default
      configurable: true
    });

    Object.defineProperty(enhanced, 'readyWhen', {
      value: undefined,
      writable: true,
      enumerable: false, // Don't serialize by default
      configurable: true
    });

    Object.defineProperty(enhanced, 'conditionals', {
      value: {},
      writable: true,
      enumerable: false, // Don't serialize by default
      configurable: true
    });

    // Add fluent builder methods
    Object.defineProperty(enhanced, 'withIncludeWhen', {
      value: (condition: any): EnhancedWithConditionals<TSpec, TStatus> => {
        const context = (enhanced as any).createFactoryContext();
        
        if (config.autoProcess) {
          const result = this.processor.processIncludeWhenExpression(condition, context, config);
          enhanced.includeWhen = result.expression;
          
          if (result.validationErrors.length > 0) {
            logger.warn('includeWhen validation warnings', {
              resourceId: (enhanced as any).__resourceId,
              errors: result.validationErrors
            });
          }
        } else {
          enhanced.includeWhen = condition;
        }
        
        return enhanced;
      },
      enumerable: false,
      configurable: true
    });

    Object.defineProperty(enhanced, 'withReadyWhen', {
      value: (condition: any): EnhancedWithConditionals<TSpec, TStatus> => {
        const context = (enhanced as any).createFactoryContext();
        
        if (config.autoProcess) {
          const result = this.processor.processReadyWhenExpression(condition, context, config);
          enhanced.readyWhen = result.expression;
          
          if (result.validationErrors.length > 0) {
            logger.warn('readyWhen validation warnings', {
              resourceId: (enhanced as any).__resourceId,
              errors: result.validationErrors
            });
          }
        } else {
          enhanced.readyWhen = condition;
        }
        
        return enhanced;
      },
      enumerable: false,
      configurable: true
    });

    Object.defineProperty(enhanced, 'withConditional', {
      value: (name: string, condition: any): EnhancedWithConditionals<TSpec, TStatus> => {
        const context = (enhanced as any).createFactoryContext();
        
        if (config.autoProcess) {
          const result = this.processor.processCustomConditionalExpression(condition, context, config);
          if (!enhanced.conditionals) {
            enhanced.conditionals = {};
          }
          enhanced.conditionals[name] = result.expression;
          
          if (result.validationErrors.length > 0) {
            logger.warn('Custom conditional validation warnings', {
              resourceId: (enhanced as any).__resourceId,
              conditionalName: name,
              errors: result.validationErrors
            });
          }
        } else {
          if (!enhanced.conditionals) {
            enhanced.conditionals = {};
          }
          enhanced.conditionals[name] = condition;
        }
        
        return enhanced;
      },
      enumerable: false,
      configurable: true
    });

    // Add helper method to create factory context
    Object.defineProperty(enhanced, 'createFactoryContext', {
      value: (): FactoryExpressionContext => {
        const compositionContext = getCurrentCompositionContext();
        return {
          factoryType: 'kro', // Default to Kro, can be overridden
          factoryName: (enhanced as any).kind || 'unknown',
          analysisEnabled: true,
          availableResources: compositionContext?.resources || {},
          schemaProxy: undefined, // Will be set by toResourceGraph if available
          resourceId: (enhanced as any).__resourceId || 'unknown'
        };
      },
      enumerable: false,
      configurable: true
    });

    return enhanced;
  }

  /**
   * Process all conditional expressions on an Enhanced resource
   * 
   * @param resource - Enhanced resource with conditional expressions
   * @param context - Factory context
   * @param config - Integration configuration
   * @returns Processing results
   */
  processResourceConditionals<TSpec, TStatus>(
    resource: EnhancedWithConditionals<TSpec, TStatus>,
    context: FactoryExpressionContext,
    config: ConditionalIntegrationConfig = {}
  ): ConditionalIntegrationResult {
    const startTime = performance.now();
    const results: ConditionalIntegrationResult['results'] = {};
    const warnings: string[] = [];
    let hasConditionals = false;

    logger.debug('Processing resource conditional expressions', {
      resourceId: context.resourceId,
      factoryType: context.factoryType
    });

    // Process includeWhen expression
    if (resource.includeWhen !== undefined) {
      hasConditionals = true;
      results.includeWhen = this.processor.processIncludeWhenExpression(
        resource.includeWhen,
        context,
        config
      );
      
      if (results.includeWhen.validationErrors.length > 0) {
        warnings.push(...results.includeWhen.validationErrors.map(err => `includeWhen: ${err}`));
      }
      
      // Update the resource with processed expression
      resource.includeWhen = results.includeWhen.expression;
    }

    // Process readyWhen expression
    if (resource.readyWhen !== undefined) {
      hasConditionals = true;
      results.readyWhen = this.processor.processReadyWhenExpression(
        resource.readyWhen,
        context,
        config
      );
      
      if (results.readyWhen.validationErrors.length > 0) {
        warnings.push(...results.readyWhen.validationErrors.map(err => `readyWhen: ${err}`));
      }
      
      // Update the resource with processed expression
      resource.readyWhen = results.readyWhen.expression;
    }

    // Process custom conditional expressions
    if (resource.conditionals && Object.keys(resource.conditionals).length > 0) {
      hasConditionals = true;
      results.conditionals = {};
      
      for (const [name, condition] of Object.entries(resource.conditionals)) {
        results.conditionals[name] = this.processor.processCustomConditionalExpression(
          condition,
          context,
          config
        );
        
        if (results.conditionals[name].validationErrors.length > 0) {
          warnings.push(...results.conditionals[name].validationErrors.map(err => `${name}: ${err}`));
        }
        
        // Update the resource with processed expression
        resource.conditionals[name] = results.conditionals[name].expression;
      }
    }

    const totalProcessingTimeMs = performance.now() - startTime;

    logger.debug('Resource conditional expressions processing completed', {
      resourceId: context.resourceId,
      hasConditionals,
      totalProcessingTimeMs,
      warningsCount: warnings.length
    });

    return {
      hasConditionals,
      results,
      totalProcessingTimeMs,
      warnings
    };
  }

  /**
   * Extract conditional expressions from a resource for serialization
   * 
   * @param resource - Enhanced resource with conditional expressions
   * @returns Conditional expressions ready for serialization
   */
  extractConditionalsForSerialization<TSpec, TStatus>(
    resource: EnhancedWithConditionals<TSpec, TStatus>
  ): Record<string, any> {
    const conditionals: Record<string, any> = {};

    if (resource.includeWhen !== undefined) {
      conditionals.includeWhen = resource.includeWhen;
    }

    if (resource.readyWhen !== undefined) {
      conditionals.readyWhen = resource.readyWhen;
    }

    if (resource.conditionals && Object.keys(resource.conditionals).length > 0) {
      Object.assign(conditionals, resource.conditionals);
    }

    return conditionals;
  }

  /**
   * Validate that conditional expressions are appropriate for the factory type
   * 
   * @param resource - Enhanced resource with conditional expressions
   * @param factoryType - Target factory type
   * @returns Validation results
   */
  validateConditionalsForFactory<TSpec, TStatus>(
    resource: EnhancedWithConditionals<TSpec, TStatus>,
    factoryType: 'direct' | 'kro'
  ): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Direct factory limitations
    if (factoryType === 'direct') {
      if (resource.includeWhen !== undefined) {
        warnings.push('includeWhen expressions have limited support in direct factory mode');
      }
      
      if (resource.readyWhen !== undefined) {
        warnings.push('readyWhen expressions have limited support in direct factory mode');
      }
    }

    // Kro factory requirements
    if (factoryType === 'kro') {
      // All conditional expressions should be convertible to CEL
      if (resource.includeWhen !== undefined && typeof resource.includeWhen === 'function') {
        errors.push('includeWhen expressions cannot be functions in Kro factory mode');
      }
      
      if (resource.readyWhen !== undefined && typeof resource.readyWhen === 'function') {
        errors.push('readyWhen expressions cannot be functions in Kro factory mode');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}

/**
 * Global conditional expression integrator instance
 */
export const conditionalExpressionIntegrator = new ConditionalExpressionIntegrator();

/**
 * Utility function to add conditional support to an Enhanced resource
 * 
 * @param resource - Enhanced resource to augment
 * @param config - Integration configuration
 * @returns Enhanced resource with conditional expression support
 */
export function withConditionalSupport<TSpec, TStatus>(
  resource: Enhanced<TSpec, TStatus>,
  config?: ConditionalIntegrationConfig
): EnhancedWithConditionals<TSpec, TStatus> {
  return conditionalExpressionIntegrator.addConditionalSupport(resource, config);
}

/**
 * Utility function to process conditional expressions on a resource
 * 
 * @param resource - Enhanced resource with conditional expressions
 * @param context - Factory context
 * @param config - Integration configuration
 * @returns Processing results
 */
export function processResourceConditionals<TSpec, TStatus>(
  resource: EnhancedWithConditionals<TSpec, TStatus>,
  context: FactoryExpressionContext,
  config?: ConditionalIntegrationConfig
): ConditionalIntegrationResult {
  return conditionalExpressionIntegrator.processResourceConditionals(resource, context, config);
}

/**
 * Utility function to extract conditionals for serialization
 * 
 * @param resource - Enhanced resource with conditional expressions
 * @returns Conditional expressions ready for serialization
 */
export function extractConditionalsForSerialization<TSpec, TStatus>(
  resource: EnhancedWithConditionals<TSpec, TStatus>
): Record<string, any> {
  return conditionalExpressionIntegrator.extractConditionalsForSerialization(resource);
}