/**
 * Readiness Integration for Conditional Expressions
 * 
 * This module provides integration between readyWhen expressions containing
 * KubernetesRef objects and TypeKro's readiness evaluation system.
 */

import { getComponentLogger } from '../logging/index.js';
import type { Enhanced, ReadinessEvaluator, ResourceStatus, KubernetesRef } from '../types/index.js';
import { 
  ConditionalExpressionProcessor,
  type ConditionalExpressionConfig,
  type ConditionalExpressionResult 
} from './conditional-expression-processor.js';
import type { FactoryExpressionContext } from './types.js';
import { getCurrentCompositionContext } from '../../factories/shared.js';
import { isKubernetesRef } from '../../utils/type-guards.js';

const logger = getComponentLogger('readiness-integration');

/**
 * Configuration for readiness integration
 */
export interface ReadinessIntegrationConfig extends ConditionalExpressionConfig {
  /** Whether to enable fallback to default readiness evaluator */
  enableFallback?: boolean;
  /** Timeout for readiness evaluation in milliseconds */
  timeoutMs?: number;
  /** Whether to cache readiness evaluation results */
  enableCaching?: boolean;
}

/**
 * Result of readiness integration
 */
export interface ReadinessIntegrationResult {
  /** Whether readyWhen expression was processed */
  wasProcessed: boolean;
  /** Generated readiness evaluator */
  evaluator?: ReadinessEvaluator;
  /** Processing result from conditional expression processor */
  processingResult?: ConditionalExpressionResult;
  /** Integration warnings */
  warnings: string[];
  /** Performance metrics */
  metrics: {
    integrationTimeMs: number;
    expressionsProcessed: number;
  };
}

/**
 * Readiness Integrator
 * 
 * Integrates readyWhen expressions with TypeKro's readiness evaluation system,
 * converting expressions containing KubernetesRef objects to readiness evaluators.
 */
export class ReadinessIntegrator {
  private processor: ConditionalExpressionProcessor;

  constructor() {
    this.processor = new ConditionalExpressionProcessor();
  }

  /**
   * Create a readiness evaluator from a readyWhen expression
   * 
   * @param readyWhenExpression - The readyWhen expression to convert
   * @param context - Factory context
   * @param config - Integration configuration
   * @returns Readiness integration result
   */
  createReadinessEvaluator(
    readyWhenExpression: any,
    context: FactoryExpressionContext,
    config: ReadinessIntegrationConfig = {}
  ): ReadinessIntegrationResult {
    const startTime = performance.now();
    
    logger.debug('Creating readiness evaluator from readyWhen expression', {
      factoryType: context.factoryType,
      factoryName: context.factoryName,
      expressionType: typeof readyWhenExpression
    });

    const result: ReadinessIntegrationResult = {
      wasProcessed: false,
      warnings: [],
      metrics: {
        integrationTimeMs: 0,
        expressionsProcessed: 0
      }
    };

    try {
      // Process the readyWhen expression
      const processingResult = this.processor.processReadyWhenExpression(
        readyWhenExpression,
        context,
        config
      );

      result.processingResult = processingResult;
      result.metrics.expressionsProcessed = 1;

      // Create readiness evaluator based on processing result
      result.evaluator = this.createEvaluatorFromProcessedExpression(
        processingResult,
        context,
        config
      );
      result.wasProcessed = processingResult.wasProcessed;

      // Add validation warnings
      if (processingResult.validationErrors.length > 0) {
        result.warnings.push(...processingResult.validationErrors);
      }

      result.metrics.integrationTimeMs = performance.now() - startTime;

      logger.debug('Readiness evaluator creation completed', {
        wasProcessed: result.wasProcessed,
        warningsCount: result.warnings.length,
        integrationTimeMs: result.metrics.integrationTimeMs
      });

      return result;

    } catch (error) {
      logger.error('Error creating readiness evaluator', error as Error, {
        factoryType: context.factoryType
      });

      result.warnings.push(`Failed to create readiness evaluator: ${error}`);
      result.metrics.integrationTimeMs = performance.now() - startTime;

      // Create fallback evaluator if enabled
      if (config.enableFallback) {
        result.evaluator = this.createFallbackEvaluator(readyWhenExpression);
        result.warnings.push('Using fallback readiness evaluator');
      }

      return result;
    }
  }

  /**
   * Add readyWhen support to an Enhanced resource
   * 
   * @param resource - Enhanced resource to augment
   * @param config - Integration configuration
   * @returns Enhanced resource with readyWhen support
   */
  addReadyWhenSupport<TSpec, TStatus>(
    resource: Enhanced<TSpec, TStatus>,
    config: ReadinessIntegrationConfig = {}
  ): Enhanced<TSpec, TStatus> & { withReadyWhen(expression: any): Enhanced<TSpec, TStatus> } {
    const enhanced = resource as Enhanced<TSpec, TStatus> & { 
      withReadyWhen(expression: any): Enhanced<TSpec, TStatus>;
      __readyWhenExpression?: any;
    };

    // Add readyWhen property
    Object.defineProperty(enhanced, '__readyWhenExpression', {
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true
    });

    // Add fluent builder method
    Object.defineProperty(enhanced, 'withReadyWhen', {
      value: (expression: any): Enhanced<TSpec, TStatus> => {
        (enhanced as any).__readyWhenExpression = expression;
        
        // Create factory context
        const context = (enhanced as any).createFactoryContext();
        
        // Create readiness evaluator from expression
        const integrationResult = this.createReadinessEvaluator(expression, context, config);
        
        if (integrationResult.evaluator) {
          // Use the generated evaluator
          return enhanced.withReadinessEvaluator(integrationResult.evaluator);
        } else {
          // Log warning and return without readiness evaluator
          logger.warn('Failed to create readiness evaluator from readyWhen expression', {
            resourceId: (enhanced as any).__resourceId,
            warnings: integrationResult.warnings
          });
          return enhanced;
        }
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
          resourceId: (enhanced as any).__resourceId || 'unknown',
          availableResources: compositionContext?.resources || {},
          schemaProxy: undefined // Will be set by toResourceGraph if available
        };
      },
      enumerable: false,
      configurable: true
    });

    return enhanced;
  }

  /**
   * Create readiness evaluator from processed expression
   */
  private createEvaluatorFromProcessedExpression(
    processingResult: ConditionalExpressionResult,
    context: FactoryExpressionContext,
    config: ReadinessIntegrationConfig
  ): ReadinessEvaluator {
    const processedExpression = processingResult.expression;
    const originalExpression = processingResult.original;

    return (liveResource: any): ResourceStatus => {
      try {
        // If the expression wasn't actually processed (no KubernetesRef objects),
        // use the original expression
        if (!processingResult.wasProcessed) {
          return this.evaluateRawExpression(originalExpression, liveResource, config);
        }

        // If the original expression was a KubernetesRef, evaluate it directly
        // regardless of factory type (for testing purposes)
        if (isKubernetesRef(originalExpression)) {
          return this.evaluateKubernetesRefExpression(originalExpression, liveResource, config);
        }

        // For direct factory, evaluate the expression directly
        if (context.factoryType === 'direct') {
          return this.evaluateDirectExpression(processedExpression, liveResource, config);
        }

        // For Kro factory, check if it's a CEL expression
        if (processedExpression && typeof processedExpression === 'object' && processedExpression.expression) {
          return this.evaluateKroExpression(processedExpression, liveResource, config);
        }

        // Fallback to raw expression evaluation
        return this.evaluateRawExpression(processedExpression, liveResource, config);

      } catch (error) {
        logger.error('Error evaluating readyWhen expression', error as Error, {
          resourceKind: liveResource?.kind
        });

        return {
          ready: false,
          reason: 'EvaluationError',
          message: `Failed to evaluate readyWhen expression: ${error}`,
          details: { originalExpression: processingResult.original }
        };
      }
    };
  }

  /**
   * Create fallback readiness evaluator
   */
  private createFallbackEvaluator(expression: any): ReadinessEvaluator {
    return (liveResource: any): ResourceStatus => {
      // Simple fallback: check if resource exists and has no error conditions
      if (!liveResource) {
        return {
          ready: false,
          reason: 'ResourceNotFound',
          message: 'Resource not found'
        };
      }

      // Check for common error conditions
      const conditions = liveResource.status?.conditions || [];
      const errorCondition = conditions.find((c: any) => 
        c.type === 'Failed' && c.status === 'True'
      );

      if (errorCondition) {
        return {
          ready: false,
          reason: 'ResourceFailed',
          message: errorCondition.message || 'Resource has failed condition'
        };
      }

      // Default to ready if no obvious errors
      return {
        ready: true,
        reason: 'FallbackEvaluator',
        message: 'Using fallback readiness evaluation',
        details: { originalExpression: expression }
      };
    };
  }

  /**
   * Evaluate raw expression (no processing needed)
   */
  private evaluateRawExpression(
    expression: any,
    liveResource: any,
    config: ReadinessIntegrationConfig
  ): ResourceStatus {
    // Handle simple boolean values
    if (typeof expression === 'boolean') {
      return {
        ready: expression,
        reason: expression ? 'ExpressionTrue' : 'ExpressionFalse',
        message: `Static readyWhen expression evaluated to ${expression}`
      };
    }

    // Handle KubernetesRef objects
    if (isKubernetesRef(expression)) {
      return this.evaluateKubernetesRefExpression(expression, liveResource, config);
    }

    // Handle function expressions
    if (typeof expression === 'function') {
      const result = expression(liveResource);
      return typeof result === 'boolean' 
        ? { ready: result, reason: result ? 'FunctionTrue' : 'FunctionFalse' }
        : result;
    }

    // Default: assume expression is truthy/falsy
    const ready = Boolean(expression);
    return {
      ready,
      reason: ready ? 'ExpressionTruthy' : 'ExpressionFalsy',
      message: `readyWhen expression evaluated to ${ready}`
    };
  }

  /**
   * Evaluate expression directly (for direct factory)
   */
  private evaluateDirectExpression(
    expression: any,
    liveResource: any,
    config: ReadinessIntegrationConfig
  ): ResourceStatus {
    // In direct factory mode, KubernetesRef objects should be resolved to actual values
    // This is a simplified implementation - in reality, the direct factory would
    // resolve all references before calling the evaluator
    
    if (typeof expression === 'boolean') {
      return {
        ready: expression,
        reason: expression ? 'DirectTrue' : 'DirectFalse',
        message: `Direct evaluation result: ${expression}`
      };
    }

    // Handle KubernetesRef objects in direct mode
    if (isKubernetesRef(expression)) {
      return this.evaluateKubernetesRefExpression(expression, liveResource, config);
    }

    // For other types, try to evaluate as truthy/falsy
    const ready = Boolean(expression);
    return {
      ready,
      reason: ready ? 'DirectTruthy' : 'DirectFalsy',
      message: `Direct evaluation result: ${ready}`
    };
  }

  /**
   * Evaluate Kro CEL expression (placeholder implementation)
   */
  private evaluateKroExpression(
    expression: any,
    _liveResource: any,
    _config: ReadinessIntegrationConfig
  ): ResourceStatus {
    // In Kro factory mode, CEL expressions would be evaluated by the Kro controller
    // This is a placeholder implementation for testing purposes
    
    if (expression && typeof expression === 'object' && expression.expression) {
      // This is a CEL expression - in reality, it would be evaluated by Kro
      return {
        ready: false,
        reason: 'CelExpressionPending',
        message: `CEL expression pending evaluation: ${expression.expression}`,
        details: { celExpression: expression.expression }
      };
    }

    // Fallback evaluation
    const ready = Boolean(expression);
    return {
      ready,
      reason: ready ? 'KroTruthy' : 'KroFalsy',
      message: `Kro evaluation result: ${ready}`
    };
  }

  /**
   * Evaluate KubernetesRef expression
   */
  private evaluateKubernetesRefExpression(
    ref: KubernetesRef<any>,
    liveResource: any,
    _config: ReadinessIntegrationConfig
  ): ResourceStatus {
    try {
      // Extract field value from live resource
      const fieldPath = ref.fieldPath;
      const value = this.extractFieldValue(liveResource, fieldPath);

      if (value === undefined || value === null) {
        return {
          ready: false,
          reason: 'FieldNotFound',
          message: `Field ${fieldPath} not found or null`,
          details: { fieldPath, resourceId: ref.resourceId }
        };
      }

      // Evaluate field value as boolean
      const ready = Boolean(value);
      return {
        ready,
        reason: ready ? 'FieldTruthy' : 'FieldFalsy',
        message: `Field ${fieldPath} evaluated to ${ready}`,
        details: { fieldPath, value, resourceId: ref.resourceId }
      };

    } catch (error) {
      return {
        ready: false,
        reason: 'FieldEvaluationError',
        message: `Failed to evaluate field ${ref.fieldPath}: ${error}`,
        details: { fieldPath: ref.fieldPath, resourceId: ref.resourceId }
      };
    }
  }

  /**
   * Extract field value from object using dot notation path
   */
  private extractFieldValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }

      // Handle array access
      if (part.includes('[') && part.includes(']')) {
        const [fieldName, indexPart] = part.split('[');
        if (!indexPart) {
          return undefined;
        }
        const index = parseInt(indexPart.replace(']', ''), 10);
        
        if (!fieldName) {
          return undefined;
        }
        
        current = current[fieldName];
        if (Array.isArray(current) && !Number.isNaN(index)) {
          current = current[index];
        } else {
          return undefined;
        }
      } else {
        current = current[part];
      }
    }

    return current;
  }
}

/**
 * Global readiness integrator instance
 */
export const readinessIntegrator = new ReadinessIntegrator();

/**
 * Utility function to create readiness evaluator from readyWhen expression
 * 
 * @param readyWhenExpression - The readyWhen expression to convert
 * @param context - Factory context
 * @param config - Integration configuration
 * @returns Readiness integration result
 */
export function createReadinessEvaluator(
  readyWhenExpression: any,
  context: FactoryExpressionContext,
  config?: ReadinessIntegrationConfig
): ReadinessIntegrationResult {
  return readinessIntegrator.createReadinessEvaluator(readyWhenExpression, context, config);
}

/**
 * Utility function to add readyWhen support to an Enhanced resource
 * 
 * @param resource - Enhanced resource to augment
 * @param config - Integration configuration
 * @returns Enhanced resource with readyWhen support
 */
export function withReadyWhenSupport<TSpec, TStatus>(
  resource: Enhanced<TSpec, TStatus>,
  config?: ReadinessIntegrationConfig
): Enhanced<TSpec, TStatus> & { withReadyWhen(expression: any): Enhanced<TSpec, TStatus> } {
  return readinessIntegrator.addReadyWhenSupport(resource, config);
}