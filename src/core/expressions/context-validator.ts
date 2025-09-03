/**
 * Context-Appropriate Expression Validation with Magic Proxy Integration
 * 
 * This module provides validation for JavaScript expressions containing KubernetesRef objects
 * to ensure they are appropriate for their usage context and work correctly with the magic proxy system.
 */

import type { KubernetesRef } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';
import type { SchemaProxy, } from '../types/serialization.js';
import { isKubernetesRef, } from '../../utils/type-guards.js';
import type { 
  ExpressionContext, 
} from './context-detector.js';

/**
 * Validation severity levels
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * Context validation rule
 */
export interface ContextValidationRule {
  /** Rule identifier */
  id: string;
  
  /** Rule name */
  name: string;
  
  /** Rule description */
  description: string;
  
  /** Contexts where this rule applies */
  applicableContexts: ExpressionContext[];
  
  /** Severity of violations */
  severity: ValidationSeverity;
  
  /** Validation function */
  validate: (
    expression: any,
    kubernetesRefs: KubernetesRef<any>[],
    context: ExpressionContext,
    config: ContextValidationConfig
  ) => ContextValidationRuleResult;
}

/**
 * Validation result for a single rule
 */
export interface ContextValidationRuleResult {
  /** Whether the validation passed */
  valid: boolean;
  
  /** Validation message */
  message: string;
  
  /** Suggested fixes */
  suggestions?: string[];
  
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Context validation configuration
 */
export interface ContextValidationConfig {
  /** Available resources for validation */
  availableResources?: Record<string, Enhanced<any, any>>;
  
  /** Schema proxy for schema field validation */
  schemaProxy?: SchemaProxy<any, any>;
  
  /** Factory type being used */
  factoryType?: 'direct' | 'kro';
  
  /** Whether to perform strict validation */
  strictMode?: boolean;
  
  /** Whether to validate magic proxy integration */
  validateMagicProxy?: boolean;
  
  /** Custom validation rules */
  customRules?: ContextValidationRule[];
  
  /** Rules to skip */
  skipRules?: string[];
}

/**
 * Complete validation report
 */
export interface ContextValidationReport {
  /** Overall validation status */
  valid: boolean;
  
  /** Expression that was validated */
  expression: any;
  
  /** Context that was validated */
  context: ExpressionContext;
  
  /** KubernetesRef objects found */
  kubernetesRefs: KubernetesRef<any>[];
  
  /** Validation results by rule */
  ruleResults: Map<string, ContextValidationRuleResult>;
  
  /** Errors found */
  errors: ValidationIssue[];
  
  /** Warnings found */
  warnings: ValidationIssue[];
  
  /** Info messages */
  info: ValidationIssue[];
  
  /** Overall confidence score (0-1) */
  confidence: number;
  
  /** Suggested improvements */
  suggestions: string[];
}

/**
 * Validation issue
 */
export interface ValidationIssue {
  /** Rule that generated this issue */
  ruleId: string;
  
  /** Issue severity */
  severity: ValidationSeverity;
  
  /** Issue message */
  message: string;
  
  /** Suggested fixes */
  suggestions: string[];
  
  /** Location information if available */
  location?: {
    line?: number;
    column?: number;
    length?: number;
  };
}

/**
 * Context-aware expression validator
 */
export class ContextExpressionValidator {
  private rules: Map<string, ContextValidationRule> = new Map();
  
  constructor() {
    this.initializeDefaultRules();
  }
  
  /**
   * Validate an expression for context appropriateness
   */
  validateExpression(
    expression: any,
    context: ExpressionContext,
    config: ContextValidationConfig = {}
  ): ContextValidationReport {
    const kubernetesRefs = this.extractKubernetesRefs(expression);
    const ruleResults = new Map<string, ContextValidationRuleResult>();
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    const info: ValidationIssue[] = [];
    const suggestions: string[] = [];
    
    // Get applicable rules for this context
    const applicableRules = this.getApplicableRules(context, config);
    
    // Run each applicable rule
    for (const rule of applicableRules) {
      if (config.skipRules?.includes(rule.id)) {
        continue;
      }
      
      try {
        const result = rule.validate(expression, kubernetesRefs, context, config);
        ruleResults.set(rule.id, result);
        
        if (!result.valid) {
          const issue: ValidationIssue = {
            ruleId: rule.id,
            severity: rule.severity,
            message: result.message,
            suggestions: result.suggestions || []
          };
          
          switch (rule.severity) {
            case 'error':
              errors.push(issue);
              break;
            case 'warning':
              warnings.push(issue);
              break;
            case 'info':
              info.push(issue);
              break;
          }
          
          if (result.suggestions) {
            suggestions.push(...result.suggestions);
          }
        }
      } catch (error) {
        // Rule execution failed
        const issue: ValidationIssue = {
          ruleId: rule.id,
          severity: 'error',
          message: `Rule execution failed: ${error instanceof Error ? error.message : String(error)}`,
          suggestions: [`Check the ${rule.name} rule implementation`]
        };
        errors.push(issue);
      }
    }
    
    // Calculate overall validation status and confidence
    const valid = errors.length === 0;
    const confidence = this.calculateConfidence(ruleResults, errors, warnings);
    
    return {
      valid,
      expression,
      context,
      kubernetesRefs,
      ruleResults,
      errors,
      warnings,
      info,
      confidence,
      suggestions: [...new Set(suggestions)] // Remove duplicates
    };
  }
  
  /**
   * Add a custom validation rule
   */
  addRule(rule: ContextValidationRule): void {
    this.rules.set(rule.id, rule);
  }
  
  /**
   * Remove a validation rule
   */
  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }
  
  /**
   * Get all available rules
   */
  getRules(): ContextValidationRule[] {
    return Array.from(this.rules.values());
  }
  
  /**
   * Initialize default validation rules
   */
  private initializeDefaultRules(): void {
    // Rule: Status builder should reference status fields
    this.addRule({
      id: 'status-builder-references',
      name: 'Status Builder References',
      description: 'Status builders should primarily reference status fields from resources',
      applicableContexts: ['status-builder'],
      severity: 'warning',
      validate: (_expression, kubernetesRefs, _context, _config) => {
        const statusRefs = kubernetesRefs.filter(ref => 
          ref.fieldPath.includes('status') || ref.resourceId === '__schema__'
        );
        
        if (statusRefs.length === 0 && kubernetesRefs.length > 0) {
          return {
            valid: false,
            message: 'Status builders should typically reference status fields or schema',
            suggestions: [
              'Consider referencing resource.status.* fields',
              'Use schema.* references for input values'
            ]
          };
        }
        
        return { valid: true, message: 'Status references are appropriate' };
      }
    });
    
    // Rule: Resource builder should reference spec fields or schema
    this.addRule({
      id: 'resource-builder-references',
      name: 'Resource Builder References',
      description: 'Resource builders should reference spec fields or schema values',
      applicableContexts: ['resource-builder'],
      severity: 'warning',
      validate: (_expression, kubernetesRefs, _context, _config) => {
        const inappropriateRefs = kubernetesRefs.filter(ref => 
          ref.resourceId !== '__schema__' && 
          !ref.fieldPath.includes('spec') && 
          !ref.fieldPath.includes('metadata')
        );
        
        if (inappropriateRefs.length > 0) {
          return {
            valid: false,
            message: `Resource builders should avoid referencing status fields: ${inappropriateRefs.map(r => `${r.resourceId}.${r.fieldPath}`).join(', ')}`,
            suggestions: [
              'Use schema.* references for configuration values',
              'Reference other resources\' spec fields if needed',
              'Consider if this should be in a status builder instead'
            ]
          };
        }
        
        return { valid: true, message: 'Resource references are appropriate' };
      }
    });
    
    // Rule: Conditional expressions should be boolean-evaluable
    this.addRule({
      id: 'conditional-boolean-result',
      name: 'Conditional Boolean Result',
      description: 'Conditional expressions should evaluate to boolean values',
      applicableContexts: ['conditional', 'readiness'],
      severity: 'error',
      validate: (expression, kubernetesRefs, _context, _config) => {
        // Check if the expression structure suggests boolean evaluation
        const expressionString = String(expression);
        
        const hasBooleanOperators = /[><=!]=?|&&|\|\||!/.test(expressionString);
        const hasBooleanKeywords = /ready|available|enabled|disabled|true|false/i.test(expressionString);
        const referencesReadyFields = kubernetesRefs.some(ref => 
          ref.fieldPath.includes('ready') || 
          ref.fieldPath.includes('available') ||
          ref.fieldPath.includes('conditions')
        );
        
        if (!hasBooleanOperators && !hasBooleanKeywords && !referencesReadyFields) {
          return {
            valid: false,
            message: 'Conditional expressions should evaluate to boolean values',
            suggestions: [
              'Add comparison operators (>, <, ==, !=)',
              'Reference boolean fields like .ready or .available',
              'Use logical operators (&&, ||, !)',
              'Check conditions array with .find() or .some()'
            ]
          };
        }
        
        return { valid: true, message: 'Expression appears to evaluate to boolean' };
      }
    });
    
    // Rule: Resource references should exist
    this.addRule({
      id: 'resource-existence',
      name: 'Resource Existence',
      description: 'Referenced resources should exist in the available resources',
      applicableContexts: ['status-builder', 'resource-builder', 'conditional', 'readiness'],
      severity: 'error',
      validate: (_expression, kubernetesRefs, _context, config) => {
        if (!config.availableResources) {
          return { valid: true, message: 'No resource validation available' };
        }
        
        const missingResources = kubernetesRefs
          .filter(ref => ref.resourceId !== '__schema__')
          .filter(ref => !config.availableResources?.[ref.resourceId]);
        
        if (missingResources.length > 0) {
          const missing = missingResources.map(r => r.resourceId);
          const available = Object.keys(config.availableResources);
          
          return {
            valid: false,
            message: `Referenced resources do not exist: ${missing.join(', ')}`,
            suggestions: [
              `Available resources: ${available.join(', ')}`,
              'Check resource names for typos',
              'Ensure resources are defined before being referenced'
            ]
          };
        }
        
        return { valid: true, message: 'All referenced resources exist' };
      }
    });
    
    // Rule: Magic proxy integration validation
    this.addRule({
      id: 'magic-proxy-integration',
      name: 'Magic Proxy Integration',
      description: 'Expressions should work correctly with the magic proxy system',
      applicableContexts: ['status-builder', 'resource-builder', 'conditional', 'readiness', 'template-literal'],
      severity: 'warning',
      validate: (expression, _kubernetesRefs, _context, config) => {
        if (!config.validateMagicProxy) {
          return { valid: true, message: 'Magic proxy validation disabled' };
        }
        
        // Check for potential magic proxy issues
        const issues: string[] = [];
        
        // Check for direct property access that might not work with proxies
        const expressionString = String(expression);
        if (expressionString.includes('.hasOwnProperty') || 
            expressionString.includes('Object.keys') ||
            expressionString.includes('Object.values')) {
          issues.push('Direct object introspection may not work with magic proxies');
        }
        
        // Check for async operations that might not work
        if (expressionString.includes('await') || expressionString.includes('Promise')) {
          issues.push('Async operations are not supported in expression contexts');
        }
        
        // Check for function calls that might not be available
        if (expressionString.includes('console.') || expressionString.includes('window.')) {
          issues.push('Global object access is not available in expression contexts');
        }
        
        // Check for other problematic patterns
        if (expressionString.includes('document.') || expressionString.includes('localStorage.')) {
          issues.push('Browser APIs are not available in expression contexts');
        }
        
        if (issues.length > 0) {
          return {
            valid: false,
            message: `Magic proxy integration issues: ${issues.join(', ')}`,
            suggestions: [
              'Use only property access and basic operators',
              'Avoid object introspection methods',
              'Use synchronous operations only',
              'Stick to KubernetesRef field access patterns'
            ]
          };
        }
        
        return { valid: true, message: 'Expression is compatible with magic proxy system' };
      }
    });
    
    // Rule: Factory type compatibility
    this.addRule({
      id: 'factory-type-compatibility',
      name: 'Factory Type Compatibility',
      description: 'Expressions should be compatible with the target factory type',
      applicableContexts: ['status-builder', 'resource-builder', 'conditional', 'readiness'],
      severity: 'warning',
      validate: (expression, kubernetesRefs, _context, config) => {
        if (!config.factoryType) {
          return { valid: true, message: 'No factory type specified' };
        }
        
        const expressionString = String(expression);
        const issues: string[] = [];
        
        if (config.factoryType === 'kro') {
          // Kro factory limitations
          if (expressionString.includes('Math.') || expressionString.includes('Date.')) {
            issues.push('Complex JavaScript APIs may not be available in Kro CEL environment');
          }
          
          if (expressionString.includes('JSON.')) {
            issues.push('JSON operations should use CEL equivalents in Kro environment');
          }
        } else if (config.factoryType === 'direct') {
          // Direct factory considerations
          if (kubernetesRefs.some(ref => ref.fieldPath.includes('status'))) {
            issues.push('Direct factory may not have access to runtime status fields');
          }
        }
        
        if (issues.length > 0) {
          return {
            valid: false,
            message: `Factory type compatibility issues: ${issues.join(', ')}`,
            suggestions: [
              config.factoryType === 'kro' 
                ? 'Use CEL-compatible operations only'
                : 'Consider using Kro factory for status field access',
              'Check the factory type documentation for supported operations'
            ]
          };
        }
        
        return { valid: true, message: `Expression is compatible with ${config.factoryType} factory` };
      }
    });
    
    // Rule: Template literal structure validation
    this.addRule({
      id: 'template-literal-structure',
      name: 'Template Literal Structure',
      description: 'Template literals should have proper structure for CEL conversion',
      applicableContexts: ['template-literal'],
      severity: 'error',
      validate: (expression, _kubernetesRefs, _context, _config) => {
        const expressionString = String(expression);
        
        // Check for template literal patterns
        if (!expressionString.includes('${') || !expressionString.includes('}')) {
          return {
            valid: false,
            message: 'Template literal context but no interpolation found',
            suggestions: [
              'Use ${expression} syntax for interpolations',
              'Ensure template literal has proper structure'
            ]
          };
        }
        
        // Check for nested template literals (not supported)
        const interpolationCount = (expressionString.match(/\$\{/g) || []).length;
        const closingCount = (expressionString.match(/\}/g) || []).length;
        
        if (interpolationCount !== closingCount) {
          return {
            valid: false,
            message: 'Unbalanced template literal interpolations',
            suggestions: [
              'Ensure each ${} interpolation is properly closed',
              'Check for nested template literals (not supported)'
            ]
          };
        }
        
        return { valid: true, message: 'Template literal structure is valid' };
      }
    });
  }
  
  /**
   * Extract KubernetesRef objects from expression
   */
  private extractKubernetesRefs(expression: any): KubernetesRef<any>[] {
    const refs: KubernetesRef<any>[] = [];
    
    if (isKubernetesRef(expression)) {
      refs.push(expression);
    } else if (typeof expression === 'object' && expression !== null) {
      this.recursivelyExtractRefs(expression, refs);
    }
    
    return refs;
  }
  
  /**
   * Recursively extract KubernetesRef objects
   */
  private recursivelyExtractRefs(value: any, refs: KubernetesRef<any>[]): void {
    if (isKubernetesRef(value)) {
      refs.push(value);
      return;
    }
    
    if (Array.isArray(value)) {
      for (const item of value) {
        this.recursivelyExtractRefs(item, refs);
      }
    } else if (value && typeof value === 'object') {
      for (const prop of Object.values(value)) {
        this.recursivelyExtractRefs(prop, refs);
      }
    }
  }
  
  /**
   * Get applicable rules for a context
   */
  private getApplicableRules(
    context: ExpressionContext,
    config: ContextValidationConfig
  ): ContextValidationRule[] {
    const rules = Array.from(this.rules.values());
    const applicableRules = rules.filter(rule => 
      rule.applicableContexts.includes(context)
    );
    
    // Add custom rules if provided
    if (config.customRules) {
      applicableRules.push(...config.customRules.filter(rule =>
        rule.applicableContexts.includes(context)
      ));
    }
    
    return applicableRules;
  }
  
  /**
   * Calculate confidence score based on validation results
   */
  private calculateConfidence(
    ruleResults: Map<string, ContextValidationRuleResult>,
    errors: ValidationIssue[],
    warnings: ValidationIssue[]
  ): number {
    const totalRules = ruleResults.size;
    if (totalRules === 0) return 0.5; // No rules ran
    
    const passedRules = Array.from(ruleResults.values()).filter(r => r.valid).length;
    const baseConfidence = passedRules / totalRules;
    
    // Reduce confidence based on errors and warnings
    const errorPenalty = errors.length * 0.2;
    const warningPenalty = warnings.length * 0.1;
    
    return Math.max(0, Math.min(1, baseConfidence - errorPenalty - warningPenalty));
  }
}

/**
 * Validation utilities
 */
export class ContextValidationUtils {
  
  /**
   * Create a validation report summary
   */
  static createSummary(report: ContextValidationReport): string {
    const { valid, errors, warnings, info, confidence } = report;
    
    let summary = `Validation ${valid ? 'PASSED' : 'FAILED'} (confidence: ${(confidence * 100).toFixed(1)}%)`;
    
    if (errors.length > 0) {
      summary += `\n  Errors: ${errors.length}`;
    }
    
    if (warnings.length > 0) {
      summary += `\n  Warnings: ${warnings.length}`;
    }
    
    if (info.length > 0) {
      summary += `\n  Info: ${info.length}`;
    }
    
    return summary;
  }
  
  /**
   * Format validation issues for display
   */
  static formatIssues(issues: ValidationIssue[]): string[] {
    return issues.map(issue => {
      let formatted = `[${issue.severity.toUpperCase()}] ${issue.message}`;
      
      if (issue.suggestions.length > 0) {
        formatted += `\n  Suggestions: ${issue.suggestions.join(', ')}`;
      }
      
      return formatted;
    });
  }
  
  /**
   * Check if a validation report indicates the expression is safe to use
   */
  static isSafeToUse(report: ContextValidationReport): boolean {
    return report.valid && report.confidence > 0.7;
  }
  
  /**
   * Get the most critical issues from a validation report
   */
  static getCriticalIssues(report: ContextValidationReport): ValidationIssue[] {
    return [...report.errors, ...report.warnings.filter(w => 
      w.message.includes('compatibility') || 
      w.message.includes('magic proxy')
    )];
  }
}

/**
 * Default context validator instance
 */
export const contextValidator = new ContextExpressionValidator();