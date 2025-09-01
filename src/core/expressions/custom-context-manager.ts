/**
 * Custom Context Manager for Conditional Expressions
 * 
 * This module provides functionality to define and manage custom CEL expression
 * contexts that can contain KubernetesRef objects, enabling developers to create
 * their own conditional expression types beyond includeWhen and readyWhen.
 */

import { getComponentLogger } from '../logging/index.js';
import type { Enhanced } from '../types/index.js';
import { 
  ConditionalExpressionProcessor,
  type ConditionalExpressionConfig,
  type ConditionalExpressionResult 
} from './conditional-expression-processor.js';
import type { FactoryExpressionContext } from './types.js';
import { 
  ExpressionContextDetector,
  type ContextDetectionResult,
} from './context-detector.js';

const logger = getComponentLogger('custom-context-manager');

/**
 * Configuration for a custom expression context
 */
export interface CustomContextConfig {
  /** Name of the custom context */
  name: string;
  /** Description of what this context is used for */
  description?: string;
  /** Expected return type for expressions in this context */
  expectedReturnType?: 'boolean' | 'string' | 'number' | 'object' | 'any';
  /** Whether expressions in this context support async operations */
  supportsAsync?: boolean;
  /** Validation rules for expressions in this context */
  validationRules?: CustomContextValidationRule[];
  /** CEL generation strategy for this context */
  celStrategy?: 'conditional-check' | 'resource-reference' | 'template-interpolation' | 'custom';
  /** Custom CEL template for this context */
  celTemplate?: string;
  /** Whether to enable debug information for this context */
  enableDebugInfo?: boolean;
}

/**
 * Validation rule for custom context expressions
 */
export interface CustomContextValidationRule {
  /** Rule identifier */
  id: string;
  /** Rule name */
  name: string;
  /** Rule description */
  description: string;
  /** Validation function */
  validate: (expression: any, context: FactoryExpressionContext) => CustomContextValidationResult;
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
}

/**
 * Result of custom context validation
 */
export interface CustomContextValidationResult {
  /** Whether validation passed */
  isValid: boolean;
  /** Validation message */
  message?: string;
  /** Suggestions for fixing validation issues */
  suggestions?: string[];
  /** Additional validation details */
  details?: Record<string, any>;
}

/**
 * Custom expression context definition
 */
export interface CustomExpressionContext {
  /** Context configuration */
  config: CustomContextConfig;
  /** Processor function for expressions in this context */
  processor: (
    expression: any,
    context: FactoryExpressionContext,
    config?: ConditionalExpressionConfig
  ) => ConditionalExpressionResult;
  /** Validator function for expressions in this context */
  validator: (
    expression: any,
    context: FactoryExpressionContext
  ) => CustomContextValidationResult[];
}

/**
 * Result of custom context processing
 */
export interface CustomContextProcessingResult {
  /** Name of the context that was used */
  contextName: string;
  /** Processing result */
  result: ConditionalExpressionResult;
  /** Validation results */
  validationResults: CustomContextValidationResult[];
  /** Performance metrics */
  metrics: {
    processingTimeMs: number;
    validationTimeMs: number;
  };
}

/**
 * Custom Context Manager
 * 
 * Manages custom CEL expression contexts and provides processing capabilities
 * for expressions containing KubernetesRef objects in custom contexts.
 */
export class CustomContextManager {
  private contexts: Map<string, CustomExpressionContext> = new Map();
  private processor: ConditionalExpressionProcessor;
  private contextDetector: ExpressionContextDetector;

  constructor() {
    this.processor = new ConditionalExpressionProcessor();
    this.contextDetector = new ExpressionContextDetector();
    
    // Register built-in contexts
    this.registerBuiltInContexts();
  }

  /**
   * Register a custom expression context
   * 
   * @param contextConfig - Configuration for the custom context
   * @returns The registered custom context
   */
  registerCustomContext(contextConfig: CustomContextConfig): CustomExpressionContext {
    logger.debug('Registering custom expression context', {
      contextName: contextConfig.name,
      expectedReturnType: contextConfig.expectedReturnType
    });

    const customContext: CustomExpressionContext = {
      config: contextConfig,
      processor: this.createCustomProcessor(contextConfig),
      validator: this.createCustomValidator(contextConfig)
    };

    this.contexts.set(contextConfig.name, customContext);

    logger.info('Custom expression context registered', {
      contextName: contextConfig.name,
      totalContexts: this.contexts.size
    });

    return customContext;
  }

  /**
   * Unregister a custom expression context
   * 
   * @param contextName - Name of the context to unregister
   * @returns Whether the context was successfully unregistered
   */
  unregisterCustomContext(contextName: string): boolean {
    const existed = this.contexts.has(contextName);
    this.contexts.delete(contextName);

    if (existed) {
      logger.info('Custom expression context unregistered', {
        contextName,
        remainingContexts: this.contexts.size
      });
    }

    return existed;
  }

  /**
   * Get a registered custom context
   * 
   * @param contextName - Name of the context to retrieve
   * @returns The custom context or undefined if not found
   */
  getCustomContext(contextName: string): CustomExpressionContext | undefined {
    return this.contexts.get(contextName);
  }

  /**
   * List all registered custom contexts
   * 
   * @returns Array of context names
   */
  listCustomContexts(): string[] {
    return Array.from(this.contexts.keys());
  }

  /**
   * Process an expression in a custom context
   * 
   * @param contextName - Name of the custom context
   * @param expression - Expression to process
   * @param factoryContext - Factory context
   * @param config - Processing configuration
   * @returns Processing result
   */
  processInCustomContext(
    contextName: string,
    expression: any,
    factoryContext: FactoryExpressionContext,
    config: ConditionalExpressionConfig = {}
  ): CustomContextProcessingResult {
    const startTime = performance.now();
    
    logger.debug('Processing expression in custom context', {
      contextName,
      factoryType: factoryContext.factoryType,
      expressionType: typeof expression
    });

    const customContext = this.contexts.get(contextName);
    if (!customContext) {
      throw new Error(`Custom context '${contextName}' not found`);
    }

    // Validate the expression
    const validationStartTime = performance.now();
    const validationResults = customContext.validator(expression, factoryContext);
    const validationTimeMs = performance.now() - validationStartTime;

    // Check for validation errors
    const hasErrors = validationResults.some(result => !result.isValid && 
      customContext.config.validationRules?.find(rule => rule.severity === 'error'));

    if (hasErrors && config.strictValidation) {
      const errorMessages = validationResults
        .filter(result => !result.isValid)
        .map(result => result.message)
        .join(', ');
      
      throw new Error(`Validation failed for custom context '${contextName}': ${errorMessages}`);
    }

    // Process the expression
    const result = customContext.processor(expression, factoryContext, config);

    const processingTimeMs = performance.now() - startTime;

    logger.debug('Custom context processing completed', {
      contextName,
      wasProcessed: result.wasProcessed,
      validationResults: validationResults.length,
      processingTimeMs
    });

    return {
      contextName,
      result,
      validationResults,
      metrics: {
        processingTimeMs,
        validationTimeMs
      }
    };
  }

  /**
   * Auto-detect and process expression in the most appropriate custom context
   * 
   * @param expression - Expression to process
   * @param factoryContext - Factory context
   * @param config - Processing configuration
   * @returns Processing result or null if no suitable context found
   */
  autoProcessInCustomContext(
    expression: any,
    factoryContext: FactoryExpressionContext,
    config: ConditionalExpressionConfig = {}
  ): CustomContextProcessingResult | null {
    logger.debug('Auto-detecting custom context for expression', {
      factoryType: factoryContext.factoryType,
      expressionType: typeof expression
    });

    // Try to detect context using the context detector
    const detectionResult = this.contextDetector.detectContext(expression, {
      factoryType: factoryContext.factoryType,
      ...(factoryContext.availableResources && { availableResources: factoryContext.availableResources as Record<string, Enhanced<any, any>> }),
      ...(factoryContext.schemaProxy && { schemaProxy: factoryContext.schemaProxy })
    });

    // Look for a custom context that matches the detected context
    for (const [contextName, customContext] of this.contexts.entries()) {
      if (this.isContextMatch(detectionResult, customContext)) {
        try {
          return this.processInCustomContext(contextName, expression, factoryContext, config);
        } catch (error) {
          logger.warn('Failed to process in detected custom context', {
            contextName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    logger.debug('No suitable custom context found for auto-processing');
    return null;
  }

  /**
   * Create a custom processor for a context configuration
   */
  private createCustomProcessor(
    contextConfig: CustomContextConfig
  ): (expression: any, context: FactoryExpressionContext, config?: ConditionalExpressionConfig) => ConditionalExpressionResult {
    return (expression: any, context: FactoryExpressionContext, config: ConditionalExpressionConfig = {}) => {
      // Use the conditional expression processor with custom context
      return this.processor.processCustomConditionalExpression(expression, context, {
        ...config,
        includeDebugInfo: config.includeDebugInfo ?? contextConfig.enableDebugInfo ?? false
      });
    };
  }

  /**
   * Create a custom validator for a context configuration
   */
  private createCustomValidator(
    contextConfig: CustomContextConfig
  ): (expression: any, context: FactoryExpressionContext) => CustomContextValidationResult[] {
    return (expression: any, context: FactoryExpressionContext) => {
      const results: CustomContextValidationResult[] = [];

      // Apply custom validation rules
      if (contextConfig.validationRules) {
        for (const rule of contextConfig.validationRules) {
          try {
            const result = rule.validate(expression, context);
            results.push(result);
          } catch (error) {
            results.push({
              isValid: false,
              message: `Validation rule '${rule.name}' failed: ${error}`,
              details: { ruleId: rule.id, error: String(error) }
            });
          }
        }
      }

      // Apply default validation based on expected return type
      if (contextConfig.expectedReturnType) {
        const typeValidation = this.validateExpectedReturnType(expression, contextConfig.expectedReturnType);
        results.push(typeValidation);
      }

      return results;
    };
  }

  /**
   * Validate expression against expected return type
   */
  private validateExpectedReturnType(
    expression: any,
    expectedType: string
  ): CustomContextValidationResult {
    // This is a simplified validation - in a real implementation,
    // we would need more sophisticated type analysis
    
    switch (expectedType) {
      case 'boolean':
        if (typeof expression === 'boolean') {
          return { isValid: true };
        }
        if (typeof expression === 'string' && /[><=!]=?|&&|\|\||true|false/.test(expression)) {
          return { isValid: true };
        }
        return {
          isValid: false,
          message: `Expression should evaluate to boolean, but appears to be ${typeof expression}`,
          suggestions: ['Use comparison operators (>, <, ==, !=)', 'Use logical operators (&&, ||)', 'Use boolean literals (true, false)']
        };
      
      case 'string':
        if (typeof expression === 'string') {
          return { isValid: true };
        }
        return {
          isValid: false,
          message: `Expression should evaluate to string, but appears to be ${typeof expression}`,
          suggestions: ['Use string literals', 'Use template literals', 'Use string concatenation']
        };
      
      case 'number':
        if (typeof expression === 'number') {
          return { isValid: true };
        }
        if (typeof expression === 'string' && /^\d+(\.\d+)?$/.test(expression)) {
          return { isValid: true };
        }
        return {
          isValid: false,
          message: `Expression should evaluate to number, but appears to be ${typeof expression}`,
          suggestions: ['Use numeric literals', 'Use arithmetic operations']
        };
      
      default:
        return { isValid: true }; // Accept any type for 'object' or 'any'
    }
  }

  /**
   * Check if a detection result matches a custom context
   */
  private isContextMatch(
    detectionResult: ContextDetectionResult,
    _customContext: CustomExpressionContext
  ): boolean {
    // Simple matching based on context name
    // In a more sophisticated implementation, this could use more complex matching logic
    return detectionResult.context === 'conditional' || 
           detectionResult.context === 'unknown';
  }

  /**
   * Register built-in contexts
   */
  private registerBuiltInContexts(): void {
    // Register includeWhen context
    this.registerCustomContext({
      name: 'includeWhen',
      description: 'Conditional resource inclusion',
      expectedReturnType: 'boolean',
      supportsAsync: false,
      celStrategy: 'conditional-check',
      validationRules: [
        {
          id: 'boolean-result',
          name: 'Boolean Result',
          description: 'includeWhen expressions should evaluate to boolean',
          severity: 'warning',
          validate: (expression: any) => {
            if (typeof expression === 'boolean') {
              return { isValid: true };
            }
            if (typeof expression === 'string' && /[><=!]=?|&&|\|\||true|false/.test(expression)) {
              return { isValid: true };
            }
            return {
              isValid: false,
              message: 'includeWhen expressions should evaluate to boolean values',
              suggestions: ['Add comparison operators', 'Use boolean literals']
            };
          }
        }
      ]
    });

    // Register readyWhen context
    this.registerCustomContext({
      name: 'readyWhen',
      description: 'Resource readiness conditions',
      expectedReturnType: 'boolean',
      supportsAsync: false,
      celStrategy: 'conditional-check',
      validationRules: [
        {
          id: 'boolean-result',
          name: 'Boolean Result',
          description: 'readyWhen expressions should evaluate to boolean',
          severity: 'warning',
          validate: (expression: any) => {
            if (typeof expression === 'boolean') {
              return { isValid: true };
            }
            if (typeof expression === 'string' && /[><=!]=?|&&|\|\||ready|available/.test(expression.toLowerCase())) {
              return { isValid: true };
            }
            return {
              isValid: false,
              message: 'readyWhen expressions should evaluate to boolean values',
              suggestions: ['Add comparison operators', 'Use readiness-related terms']
            };
          }
        },
        {
          id: 'status-reference',
          name: 'Status Reference',
          description: 'readyWhen expressions should typically reference status fields',
          severity: 'info',
          validate: (expression: any, _context: FactoryExpressionContext) => {
            // This is a simplified check - in reality, we'd analyze the expression for status references
            const expressionString = String(expression);
            if (expressionString.includes('status')) {
              return { isValid: true };
            }
            return {
              isValid: false,
              message: 'readyWhen expressions typically reference resource status fields',
              suggestions: ['Reference .status fields', 'Use resource readiness indicators']
            };
          }
        }
      ]
    });

    logger.info('Built-in custom contexts registered', {
      contexts: ['includeWhen', 'readyWhen']
    });
  }
}

/**
 * Global custom context manager instance
 */
export const customContextManager = new CustomContextManager();

/**
 * Utility function to register a custom context
 * 
 * @param contextConfig - Configuration for the custom context
 * @returns The registered custom context
 */
export function registerCustomContext(contextConfig: CustomContextConfig): CustomExpressionContext {
  return customContextManager.registerCustomContext(contextConfig);
}

/**
 * Utility function to process expression in custom context
 * 
 * @param contextName - Name of the custom context
 * @param expression - Expression to process
 * @param factoryContext - Factory context
 * @param config - Processing configuration
 * @returns Processing result
 */
export function processInCustomContext(
  contextName: string,
  expression: any,
  factoryContext: FactoryExpressionContext,
  config?: ConditionalExpressionConfig
): CustomContextProcessingResult {
  return customContextManager.processInCustomContext(contextName, expression, factoryContext, config);
}

/**
 * Utility function to auto-process expression in custom context
 * 
 * @param expression - Expression to process
 * @param factoryContext - Factory context
 * @param config - Processing configuration
 * @returns Processing result or null if no suitable context found
 */
export function autoProcessInCustomContext(
  expression: any,
  factoryContext: FactoryExpressionContext,
  config?: ConditionalExpressionConfig
): CustomContextProcessingResult | null {
  return customContextManager.autoProcessInCustomContext(expression, factoryContext, config);
}