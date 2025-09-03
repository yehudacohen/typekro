/**
 * Conditional Expression Validation
 * 
 * This module provides comprehensive validation for conditional expressions
 * containing KubernetesRef objects, ensuring they are well-formed and
 * appropriate for their intended contexts.
 */

import { getComponentLogger } from '../logging/index.js';
import type { Enhanced } from '../types/index.js';
import { isKubernetesRef } from '../../utils/type-guards.js';
import { 
  MagicProxyDetector,
  type MagicProxyDetectionResult 
} from './magic-proxy-detector.js';
import type { FactoryExpressionContext } from './types.js';
import { 
  ExpressionContextDetector,
  type ContextDetectionResult 
} from './context-detector.js';

const logger = getComponentLogger('conditional-validation');

/**
 * Validation severity levels
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * Validation rule configuration
 */
export interface ValidationRule {
  /** Unique identifier for the rule */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what the rule validates */
  description: string;
  /** Severity level */
  severity: ValidationSeverity;
  /** Contexts where this rule applies */
  applicableContexts: string[];
  /** Whether this rule is enabled by default */
  enabled: boolean;
  /** Validation function */
  validate: (
    expression: any,
    context: FactoryExpressionContext,
    detection: MagicProxyDetectionResult
  ) => ValidationResult;
}

/**
 * Result of a single validation rule
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Validation message */
  message?: string;
  /** Suggestions for fixing issues */
  suggestions?: string[];
  /** Additional details */
  details?: Record<string, any>;
  /** Location information if available */
  location?: {
    line?: number;
    column?: number;
    length?: number;
  };
}

/**
 * Comprehensive validation result
 */
export interface ConditionalValidationResult {
  /** Overall validation status */
  isValid: boolean;
  /** Results from individual rules */
  ruleResults: Map<string, ValidationResult>;
  /** All validation messages grouped by severity */
  messages: {
    errors: string[];
    warnings: string[];
    info: string[];
  };
  /** Context detection result */
  contextResult: ContextDetectionResult;
  /** KubernetesRef detection result */
  detectionResult: MagicProxyDetectionResult;
  /** Performance metrics */
  metrics: {
    validationTimeMs: number;
    rulesEvaluated: number;
    referencesValidated: number;
  };
  /** Summary statistics */
  summary: {
    totalRules: number;
    passedRules: number;
    failedRules: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
}

/**
 * Validation configuration
 */
export interface ValidationConfig {
  /** Whether to enable strict validation (fail on warnings) */
  strictMode?: boolean;
  /** Maximum validation time in milliseconds */
  timeoutMs?: number;
  /** Whether to include detailed location information */
  includeLocationInfo?: boolean;
  /** Custom validation rules to add */
  customRules?: ValidationRule[];
  /** Rule IDs to disable */
  disabledRules?: string[];
  /** Whether to validate KubernetesRef objects deeply */
  deepReferenceValidation?: boolean;
}

/**
 * Conditional Expression Validator
 * 
 * Provides comprehensive validation for conditional expressions containing
 * KubernetesRef objects, ensuring they are well-formed and contextually appropriate.
 */
export class ConditionalExpressionValidator {
  private rules: Map<string, ValidationRule> = new Map();
  private magicProxyDetector: MagicProxyDetector;
  private contextDetector: ExpressionContextDetector;

  constructor() {
    this.magicProxyDetector = new MagicProxyDetector();
    this.contextDetector = new ExpressionContextDetector();
    
    // Register built-in validation rules
    this.registerBuiltInRules();
  }

  /**
   * Validate a conditional expression
   * 
   * @param expression - Expression to validate
   * @param context - Factory context
   * @param config - Validation configuration
   * @returns Comprehensive validation result
   */
  validateExpression(
    expression: any,
    context: FactoryExpressionContext,
    config: ValidationConfig = {}
  ): ConditionalValidationResult {
    const startTime = performance.now();
    
    logger.debug('Starting conditional expression validation', {
      factoryType: context.factoryType,
      expressionType: typeof expression,
      strictMode: config.strictMode
    });

    // Detect KubernetesRef objects
    const detectionResult = this.magicProxyDetector.detectKubernetesRefs(expression, {
      maxDepth: 10,
      includeDetailedPaths: true,
      analyzeReferenceSources: true
    });

    // Detect expression context
    const contextResult = this.contextDetector.detectContext(expression, {
      factoryType: context.factoryType,
      ...(context.availableResources && { availableResources: context.availableResources as Record<string, Enhanced<any, any>> }),
      ...(context.schemaProxy && { schemaProxy: context.schemaProxy })
    });

    // Initialize result
    const result: ConditionalValidationResult = {
      isValid: true,
      ruleResults: new Map(),
      messages: { errors: [], warnings: [], info: [] },
      contextResult,
      detectionResult,
      metrics: {
        validationTimeMs: 0,
        rulesEvaluated: 0,
        referencesValidated: detectionResult.references.length
      },
      summary: {
        totalRules: 0,
        passedRules: 0,
        failedRules: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0
      }
    };

    // Get applicable rules
    const applicableRules = this.getApplicableRules(contextResult.context, config);
    result.summary.totalRules = applicableRules.length;

    // Validate with each applicable rule
    for (const rule of applicableRules) {
      try {
        const ruleResult = rule.validate(expression, context, detectionResult);
        result.ruleResults.set(rule.id, ruleResult);
        result.metrics.rulesEvaluated++;

        if (ruleResult.valid) {
          result.summary.passedRules++;
        } else {
          result.summary.failedRules++;
          
          // Add message to appropriate severity category
          const message = `${rule.name}: ${ruleResult.message || 'Validation failed'}`;
          switch (rule.severity) {
            case 'error':
              result.messages.errors.push(message);
              result.summary.errorCount++;
              result.isValid = false;
              break;
            case 'warning':
              result.messages.warnings.push(message);
              result.summary.warningCount++;
              if (config.strictMode) {
                result.isValid = false;
              }
              break;
            case 'info':
              result.messages.info.push(message);
              result.summary.infoCount++;
              break;
          }
        }
      } catch (error) {
        logger.warn('Validation rule failed with error', {
          ruleId: rule.id,
          error: error instanceof Error ? error.message : String(error)
        });
        
        result.ruleResults.set(rule.id, {
          valid: false,
          message: `Rule execution failed: ${error}`,
          details: { error: String(error) }
        });
        
        result.summary.failedRules++;
        result.messages.errors.push(`${rule.name}: Rule execution failed`);
        result.summary.errorCount++;
        result.isValid = false;
      }
    }

    result.metrics.validationTimeMs = performance.now() - startTime;

    logger.debug('Conditional expression validation completed', {
      isValid: result.isValid,
      totalRules: result.summary.totalRules,
      errorCount: result.summary.errorCount,
      warningCount: result.summary.warningCount,
      validationTimeMs: result.metrics.validationTimeMs
    });

    return result;
  }

  /**
   * Register a custom validation rule
   * 
   * @param rule - Validation rule to register
   */
  registerRule(rule: ValidationRule): void {
    this.rules.set(rule.id, rule);
    
    logger.debug('Validation rule registered', {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity
    });
  }

  /**
   * Unregister a validation rule
   * 
   * @param ruleId - ID of the rule to unregister
   * @returns Whether the rule was successfully unregistered
   */
  unregisterRule(ruleId: string): boolean {
    const existed = this.rules.has(ruleId);
    this.rules.delete(ruleId);
    
    if (existed) {
      logger.debug('Validation rule unregistered', { ruleId });
    }
    
    return existed;
  }

  /**
   * Get all registered validation rules
   * 
   * @returns Array of validation rules
   */
  getRules(): ValidationRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get applicable rules for a specific context
   */
  private getApplicableRules(
    context: string,
    config: ValidationConfig
  ): ValidationRule[] {
    const rules = Array.from(this.rules.values());
    
    return rules.filter(rule => {
      // Check if rule is enabled
      if (!rule.enabled) return false;
      
      // Check if rule is disabled in config
      if (config.disabledRules?.includes(rule.id)) return false;
      
      // Check if rule applies to this context
      if (rule.applicableContexts.length > 0 && 
          !rule.applicableContexts.includes(context) &&
          !rule.applicableContexts.includes('*')) {
        return false;
      }
      
      return true;
    });
  }

  /**
   * Register built-in validation rules
   */
  private registerBuiltInRules(): void {
    // Rule: KubernetesRef objects should be well-formed
    this.registerRule({
      id: 'well-formed-kubernetes-ref',
      name: 'Well-formed KubernetesRef',
      description: 'KubernetesRef objects should have valid resourceId and fieldPath',
      severity: 'error',
      applicableContexts: ['*'],
      enabled: true,
      validate: (_expression, _context, detection) => {
        for (const refInfo of detection.references) {
          const ref = refInfo.ref;
          
          if (!ref.resourceId || typeof ref.resourceId !== 'string') {
            return {
              valid: false,
              message: 'KubernetesRef must have a valid resourceId',
              details: { ref, path: refInfo.path }
            };
          }
          
          if (!ref.fieldPath || typeof ref.fieldPath !== 'string') {
            return {
              valid: false,
              message: 'KubernetesRef must have a valid fieldPath',
              details: { ref, path: refInfo.path }
            };
          }
          
          // Validate field path format
          if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*|\[\d+\])*$/.test(ref.fieldPath)) {
            return {
              valid: false,
              message: 'KubernetesRef fieldPath has invalid format',
              suggestions: ['Use dot notation for nested fields', 'Use bracket notation for array access'],
              details: { fieldPath: ref.fieldPath, path: refInfo.path }
            };
          }
        }
        
        return { valid: true };
      }
    });

    // Rule: Conditional expressions should evaluate to boolean
    this.registerRule({
      id: 'conditional-boolean-result',
      name: 'Conditional Boolean Result',
      description: 'Conditional expressions should evaluate to boolean values',
      severity: 'warning',
      applicableContexts: ['*'], // Apply to all contexts
      enabled: true,
      validate: (expression, _context, _detection) => {
        // Check for boolean literals
        if (typeof expression === 'boolean') {
          return { valid: true };
        }
        
        // Check for boolean-like string expressions
        if (typeof expression === 'string') {
          const hasBooleanOperators = /[><=!]=?|&&|\|\||true|false|ready|available|enabled|disabled/i.test(expression);
          if (hasBooleanOperators) {
            return { valid: true };
          }
        }
        
        // Check for KubernetesRef that might resolve to boolean
        if (isKubernetesRef(expression)) {
          // Allow KubernetesRef objects - they might resolve to boolean values
          return { valid: true };
        }
        
        return {
          valid: false,
          message: 'Conditional expressions should evaluate to boolean values',
          suggestions: [
            'Add comparison operators (>, <, ==, !=)',
            'Add logical operators (&&, ||)',
            'Use boolean literals (true, false)'
          ]
        };
      }
    });

    // Rule: Resource references should exist in context
    this.registerRule({
      id: 'resource-reference-exists',
      name: 'Resource Reference Exists',
      description: 'Referenced resources should exist in the current context',
      severity: 'warning',
      applicableContexts: ['*'],
      enabled: true,
      validate: (_expression, context, detection) => {
        const availableResources = context.availableResources || {};
        
        for (const refInfo of detection.references) {
          const ref = refInfo.ref;
          
          // Skip schema references
          if (ref.resourceId === '__schema__') continue;
          
          // Check if resource exists in context
          if (!(ref.resourceId in availableResources)) {
            return {
              valid: false,
              message: `Referenced resource '${ref.resourceId}' not found in current context`,
              suggestions: [
                'Check resource name spelling',
                'Ensure resource is created before referencing',
                'Verify resource is in the same composition context'
              ],
              details: { resourceId: ref.resourceId, path: refInfo.path }
            };
          }
        }
        
        return { valid: true };
      }
    });

    // Rule: Field paths should be reasonable
    this.registerRule({
      id: 'reasonable-field-paths',
      name: 'Reasonable Field Paths',
      description: 'Field paths should follow common Kubernetes patterns',
      severity: 'info',
      applicableContexts: ['*'],
      enabled: true,
      validate: (_expression, _context, detection) => {
        for (const refInfo of detection.references) {
          const ref = refInfo.ref;
          const fieldPath = ref.fieldPath;
          
          // Check for overly deep nesting
          const depth = fieldPath.split('.').length;
          if (depth > 6) {
            return {
              valid: false,
              message: `Field path '${fieldPath}' is very deeply nested (${depth} levels)`,
              suggestions: ['Consider using intermediate references', 'Verify the field path is correct'],
              details: { fieldPath, depth, path: refInfo.path }
            };
          }
          
          // Check for common typos in Kubernetes field names
          const commonFields = ['metadata', 'spec', 'status', 'data', 'stringData'];
          const pathParts = fieldPath.split('.');
          
          for (const part of pathParts) {
            if (part.includes('[') && part.includes(']')) continue; // Skip array access
            
            // Check for common typos
            const similarFields = commonFields.filter(field => 
              this.levenshteinDistance(part.toLowerCase(), field.toLowerCase()) === 1
            );
            
            if (similarFields.length > 0) {
              return {
                valid: false,
                message: `Field '${part}' might be a typo, did you mean '${similarFields[0]}'?`,
                suggestions: [`Use '${similarFields[0]}' instead of '${part}'`],
                details: { fieldPath, suspiciousPart: part, suggestions: similarFields }
              };
            }
          }
        }
        
        return { valid: true };
      }
    });

    // Rule: readyWhen expressions should reference status fields
    this.registerRule({
      id: 'ready-when-status-reference',
      name: 'ReadyWhen Status Reference',
      description: 'readyWhen expressions should typically reference status fields',
      severity: 'info',
      applicableContexts: ['*'], // Apply to all contexts, but only validate when there are references
      enabled: true,
      validate: (_expression, _context, detection) => {
        if (detection.references.length === 0) {
          return { valid: true }; // No references to validate
        }
        
        const hasStatusReferences = detection.references.some(refInfo => 
          refInfo.ref.fieldPath.includes('status')
        );
        
        if (!hasStatusReferences) {
          return {
            valid: false,
            message: 'readyWhen expressions typically reference resource status fields',
            suggestions: [
              'Reference .status fields for resource readiness',
              'Use status.conditions for detailed readiness checks',
              'Consider status.readyReplicas, status.phase, etc.'
            ]
          };
        }
        
        return { valid: true };
      }
    });

    // Rule: Circular reference detection
    this.registerRule({
      id: 'no-circular-references',
      name: 'No Circular References',
      description: 'Expressions should not create circular dependencies',
      severity: 'error',
      applicableContexts: ['*'],
      enabled: true,
      validate: (_expression, context, detection) => {
        const currentResourceId = context.resourceId;
        
        // Check if any reference points back to the current resource
        for (const refInfo of detection.references) {
          const ref = refInfo.ref;
          
          if (ref.resourceId === currentResourceId) {
            return {
              valid: false,
              message: `Circular reference detected: resource '${currentResourceId}' references itself`,
              suggestions: [
                'Remove self-references',
                'Use different resource for the reference',
                'Consider using schema references instead'
              ],
              details: { resourceId: currentResourceId, fieldPath: ref.fieldPath }
            };
          }
        }
        
        return { valid: true };
      }
    });

    logger.info('Built-in validation rules registered', {
      ruleCount: this.rules.size
    });
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(0));
    
    for (let i = 0; i <= str1.length; i++) matrix[0]![i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j]![0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j]![i] = Math.min(
          matrix[j]?.[i - 1]! + 1,     // deletion
          matrix[j - 1]?.[i]! + 1,     // insertion
          matrix[j - 1]?.[i - 1]! + indicator // substitution
        );
      }
    }
    
    return matrix[str2.length]?.[str1.length]!;
  }
}

/**
 * Global conditional expression validator instance
 */
export const conditionalExpressionValidator = new ConditionalExpressionValidator();

/**
 * Utility function to validate a conditional expression
 * 
 * @param expression - Expression to validate
 * @param context - Factory context
 * @param config - Validation configuration
 * @returns Validation result
 */
export function validateConditionalExpression(
  expression: any,
  context: FactoryExpressionContext,
  config?: ValidationConfig
): ConditionalValidationResult {
  return conditionalExpressionValidator.validateExpression(expression, context, config);
}

/**
 * Utility function to register a custom validation rule
 * 
 * @param rule - Validation rule to register
 */
export function registerValidationRule(rule: ValidationRule): void {
  conditionalExpressionValidator.registerRule(rule);
}

/**
 * Utility function to get all validation rules
 * 
 * @returns Array of validation rules
 */
export function getValidationRules(): ValidationRule[] {
  return conditionalExpressionValidator.getRules();
}