/**
 * Runtime error mapping utilities for CEL expressions
 * Maps runtime CEL evaluation errors back to original JavaScript expressions
 */

import { ConversionError } from '../errors.js';
import type { SourceMapBuilder, SourceMapEntry } from './source-map.js';

/**
 * Information about a CEL runtime error
 */
export interface CelRuntimeError {
  /** The CEL expression that failed */
  celExpression: string;
  /** The runtime error message */
  errorMessage: string;
  /** Error type/category */
  errorType: 'evaluation' | 'type-mismatch' | 'null-reference' | 'field-not-found' | 'syntax' | 'unknown';
  /** Location in the CEL expression where the error occurred */
  celLocation?: {
    position: number;
    length: number;
  };
  /** Additional context about the error */
  context?: {
    resourceId?: string;
    fieldPath?: string;
    expectedType?: string;
    actualType?: string;
    availableFields?: string[];
  };
}

/**
 * Mapped error information linking CEL runtime errors to original JavaScript
 */
export interface MappedRuntimeError {
  /** The original JavaScript expression */
  originalExpression: string;
  /** Source location in the original JavaScript */
  sourceLocation: {
    line: number;
    column: number;
    length: number;
  };
  /** The CEL expression that failed */
  celExpression: string;
  /** The runtime error details */
  runtimeError: CelRuntimeError;
  /** Context where the expression was used */
  context: 'status' | 'resource' | 'condition' | 'readiness';
  /** Suggested fixes for the error */
  suggestions: string[];
  /** Source mapping entry used for the mapping */
  sourceMapping: SourceMapEntry;
}

/**
 * Maps CEL runtime errors back to original JavaScript expressions using source maps
 */
export class CelRuntimeErrorMapper {
  constructor(private sourceMap: SourceMapBuilder) {}

  /**
   * Map a CEL runtime error to the original JavaScript expression
   */
  mapRuntimeError(celError: CelRuntimeError): MappedRuntimeError | null {
    // Find the source mapping for this CEL expression
    const sourceMapping = this.sourceMap.findOriginalExpression(celError.celExpression);
    
    if (!sourceMapping) {
      // No source mapping found - can't map back to original
      return null;
    }

    // Generate suggestions based on the error type and context
    const suggestions = this.generateSuggestions(celError, sourceMapping);

    return {
      originalExpression: sourceMapping.originalExpression,
      sourceLocation: sourceMapping.sourceLocation,
      celExpression: celError.celExpression,
      runtimeError: celError,
      context: sourceMapping.context as 'status' | 'resource' | 'condition' | 'readiness',
      suggestions,
      sourceMapping,
    };
  }

  /**
   * Map multiple CEL runtime errors
   */
  mapMultipleErrors(celErrors: CelRuntimeError[]): MappedRuntimeError[] {
    const mappedErrors: MappedRuntimeError[] = [];
    
    for (const celError of celErrors) {
      const mapped = this.mapRuntimeError(celError);
      if (mapped) {
        mappedErrors.push(mapped);
      }
    }

    return mappedErrors;
  }

  /**
   * Create a user-friendly error message from a mapped runtime error
   */
  createUserFriendlyError(mappedError: MappedRuntimeError): ConversionError {
    const { originalExpression, sourceLocation, runtimeError, context, suggestions } = mappedError;
    
    let message = `Runtime error in ${context} expression:\n`;
    message += `  Original: ${originalExpression}\n`;
    message += `  CEL: ${mappedError.celExpression}\n`;
    message += `  Error: ${runtimeError.errorMessage}`;

    // Add context-specific information
    if (runtimeError.context) {
      if (runtimeError.context.resourceId) {
        message += `\n  Resource: ${runtimeError.context.resourceId}`;
      }
      if (runtimeError.context.fieldPath) {
        message += `\n  Field: ${runtimeError.context.fieldPath}`;
      }
      if (runtimeError.context.expectedType && runtimeError.context.actualType) {
        message += `\n  Expected: ${runtimeError.context.expectedType}`;
        message += `\n  Actual: ${runtimeError.context.actualType}`;
      }
    }

    // Map CEL error type to ConversionError expression type
    const expressionType = CelRuntimeErrorMapper.mapErrorTypeToExpressionType(runtimeError.errorType);
    
    return new ConversionError(
      message,
      originalExpression,
      expressionType,
      sourceLocation,
      {
        analysisContext: context,
        ...(runtimeError.context?.availableFields && {
          availableReferences: runtimeError.context.availableFields
        }),
      },
      suggestions
    );
  }

  /**
   * Parse a CEL runtime error from various error formats
   */
  static parseCelRuntimeError(
    celExpression: string,
    error: Error | string | any
  ): CelRuntimeError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Determine error type from the message
    const errorType = CelRuntimeErrorMapper.categorizeError(errorMessage);
    
    // Extract context information from the error
    const context = CelRuntimeErrorMapper.extractErrorContext(errorMessage, celExpression);
    
    // Try to find the location in the CEL expression where the error occurred
    const celLocation = CelRuntimeErrorMapper.findErrorLocation(errorMessage, celExpression);

    const result: CelRuntimeError = {
      celExpression,
      errorMessage,
      errorType,
    };
    
    if (celLocation) {
      result.celLocation = celLocation;
    }
    
    if (context) {
      result.context = context;
    }
    
    return result;
  }

  /**
   * Map CEL error type to ConversionError expression type
   */
  private static mapErrorTypeToExpressionType(
    errorType: CelRuntimeError['errorType']
  ): 'javascript' | 'template-literal' | 'function-call' | 'member-access' | 'binary-operation' | 'conditional' | 'optional-chaining' | 'nullish-coalescing' | 'unknown' {
    switch (errorType) {
      case 'field-not-found':
        return 'member-access';
      case 'type-mismatch':
        return 'binary-operation';
      case 'evaluation':
        return 'function-call';
      case 'syntax':
        return 'javascript';
      case 'null-reference':
        return 'member-access';
      default:
        return 'unknown';
    }
  }

  /**
   * Categorize the error type based on the error message
   */
  private static categorizeError(errorMessage: string): CelRuntimeError['errorType'] {
    const message = errorMessage.toLowerCase();
    
    if (message.includes('null') || message.includes('undefined')) {
      return 'null-reference';
    }
    if (message.includes('type') || message.includes('expected')) {
      return 'type-mismatch';
    }
    if (message.includes('field') || message.includes('property') || message.includes('not found')) {
      return 'field-not-found';
    }
    if (message.includes('syntax') || message.includes('parse')) {
      return 'syntax';
    }
    if (message.includes('evaluation') || message.includes('runtime')) {
      return 'evaluation';
    }
    
    return 'unknown';
  }

  /**
   * Extract context information from the error message
   */
  private static extractErrorContext(
    errorMessage: string, 
    celExpression: string
  ): CelRuntimeError['context'] {
    const context: CelRuntimeError['context'] = {};
    
    // Extract resource ID from CEL expression
    const resourceMatch = celExpression.match(/resources\.(\w+)\./);
    if (resourceMatch?.[1]) {
      context.resourceId = resourceMatch[1];
    }
    
    // Extract field path from CEL expression
    const fieldMatch = celExpression.match(/\.([a-zA-Z0-9_.]+)$/);
    if (fieldMatch?.[1]) {
      context.fieldPath = fieldMatch[1];
    }
    
    // Extract type information from error message
    const typeMatch = errorMessage.match(/expected (\w+), got (\w+)/i);
    if (typeMatch?.[1] && typeMatch[2]) {
      context.expectedType = typeMatch[1];
      context.actualType = typeMatch[2];
    }
    
    return context;
  }

  /**
   * Find the location in the CEL expression where the error occurred
   */
  private static findErrorLocation(
    errorMessage: string, 
    celExpression: string
  ): CelRuntimeError['celLocation'] | undefined {
    // Try to extract position information from error message
    const positionMatch = errorMessage.match(/at position (\d+)/i);
    if (positionMatch?.[1]) {
      const position = parseInt(positionMatch[1], 10);
      return {
        position,
        length: 1, // Default length
      };
    }
    
    // Try to find the problematic part in the expression
    const fieldMatch = errorMessage.match(/field '(\w+)'/i);
    if (fieldMatch?.[1]) {
      const fieldName = fieldMatch[1];
      const position = celExpression.indexOf(fieldName);
      if (position >= 0) {
        return {
          position,
          length: fieldName.length,
        };
      }
    }
    
    return undefined;
  }

  /**
   * Generate suggestions for fixing the error
   */
  private generateSuggestions(
    celError: CelRuntimeError, 
    sourceMapping: SourceMapEntry
  ): string[] {
    const suggestions: string[] = [];
    
    switch (celError.errorType) {
      case 'null-reference':
        suggestions.push('Use optional chaining (?.) to handle potentially null values');
        suggestions.push('Add a null check before accessing the field');
        suggestions.push('Provide a default value using the || operator');
        if (celError.context?.resourceId) {
          suggestions.push(`Ensure the '${celError.context.resourceId}' resource is deployed and ready`);
        }
        break;
        
      case 'field-not-found':
        suggestions.push('Check that the field name is spelled correctly');
        suggestions.push('Verify that the field exists in the resource schema');
        if (celError.context?.availableFields?.length) {
          suggestions.push(`Available fields: ${celError.context.availableFields.join(', ')}`);
        }
        if (celError.context?.resourceId) {
          suggestions.push(`Check the status of the '${celError.context.resourceId}' resource`);
        }
        break;
        
      case 'type-mismatch':
        if (celError.context?.expectedType && celError.context?.actualType) {
          suggestions.push(`Convert the value from ${celError.context.actualType} to ${celError.context.expectedType}`);
        }
        suggestions.push('Check that the field contains the expected data type');
        suggestions.push('Add type checking or conversion in your expression');
        break;
        
      case 'evaluation':
        suggestions.push('Check that all referenced resources are available');
        suggestions.push('Verify that the expression logic is correct');
        suggestions.push('Consider simplifying the expression');
        break;
        
      case 'syntax':
        suggestions.push('Check the CEL expression syntax');
        suggestions.push('Verify that all operators and functions are valid');
        suggestions.push('Consider using simpler JavaScript expressions');
        break;
        
      default:
        suggestions.push('Check the CEL expression and referenced resources');
        suggestions.push('Verify that all dependencies are available');
        suggestions.push('Consider using optional chaining for potentially missing fields');
    }
    
    // Add context-specific suggestions
    if (sourceMapping.context === 'status') {
      suggestions.push('Status expressions are evaluated after resource deployment');
      suggestions.push('Ensure all referenced resources are included in your resource graph');
    } else if (sourceMapping.context === 'resource') {
      suggestions.push('Resource expressions are evaluated during resource creation');
      suggestions.push('Only reference schema fields or other resources in the same graph');
    }
    
    return suggestions;
  }

  /**
   * Create a comprehensive error report for debugging
   */
  createErrorReport(mappedErrors: MappedRuntimeError[]): string {
    if (mappedErrors.length === 0) {
      return 'No runtime errors to report.';
    }

    const report = [
      '=== CEL Runtime Error Report ===',
      `Generated: ${new Date().toISOString()}`,
      `Total Errors: ${mappedErrors.length}`,
      '',
    ];

    mappedErrors.forEach((error, index) => {
      report.push(`## Error ${index + 1}: ${error.runtimeError.errorType}`);
      report.push('');
      report.push(`**Original Expression**: \`${error.originalExpression}\``);
      report.push(`**CEL Expression**: \`${error.celExpression}\``);
      report.push(`**Context**: ${error.context}`);
      report.push(`**Location**: Line ${error.sourceLocation.line}, Column ${error.sourceLocation.column}`);
      report.push(`**Error Message**: ${error.runtimeError.errorMessage}`);
      
      if (error.runtimeError.context?.resourceId) {
        report.push(`**Resource**: ${error.runtimeError.context.resourceId}`);
      }
      
      if (error.runtimeError.context?.fieldPath) {
        report.push(`**Field**: ${error.runtimeError.context.fieldPath}`);
      }
      
      if (error.suggestions.length > 0) {
        report.push('');
        report.push('**Suggestions**:');
        error.suggestions.forEach(suggestion => {
          report.push(`- ${suggestion}`);
        });
      }
      
      report.push('');
    });

    return report.join('\n');
  }

  /**
   * Get statistics about runtime errors
   */
  getErrorStatistics(mappedErrors: MappedRuntimeError[]): {
    totalErrors: number;
    errorsByType: Record<string, number>;
    errorsByContext: Record<string, number>;
    mostCommonErrors: Array<{ type: string; count: number }>;
  } {
    const errorsByType: Record<string, number> = {};
    const errorsByContext: Record<string, number> = {};

    mappedErrors.forEach(error => {
      const type = error.runtimeError.errorType;
      const context = error.context;
      
      errorsByType[type] = (errorsByType[type] || 0) + 1;
      errorsByContext[context] = (errorsByContext[context] || 0) + 1;
    });

    const mostCommonErrors = Object.entries(errorsByType)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalErrors: mappedErrors.length,
      errorsByType,
      errorsByContext,
      mostCommonErrors,
    };
  }
}

/**
 * Utility functions for working with CEL runtime errors
 */
export class CelRuntimeErrorUtils {
  /**
   * Check if an error is likely a CEL runtime error
   */
  static isCelRuntimeError(error: any): boolean {
    if (!error) return false;
    
    const message = error.message || String(error);
    const celIndicators = [
      'cel',
      'expression',
      'evaluation',
      'resources.',
      'schema.',
      'field not found',
      'type mismatch'
    ];
    
    return celIndicators.some(indicator => 
      message.toLowerCase().includes(indicator)
    );
  }

  /**
   * Extract CEL expression from error context
   */
  static extractCelExpressionFromError(error: any): string | null {
    if (!error) return null;
    
    const message = error.message || String(error);
    
    // Try to find CEL expression in error message
    const celMatch = message.match(/expression[:\s]+['"`]([^'"`]+)['"`]/i);
    if (celMatch) {
      return celMatch[1];
    }
    
    // Try to find ${...} patterns
    const templateMatch = message.match(/\$\{([^}]+)\}/);
    if (templateMatch) {
      return templateMatch[1];
    }
    
    return null;
  }

  /**
   * Create a standardized error message format
   */
  static formatErrorMessage(
    originalExpression: string,
    celExpression: string,
    errorMessage: string,
    context: string,
    suggestions: string[]
  ): string {
    let formatted = `JavaScript to CEL Runtime Error in ${context}:\n`;
    formatted += `  Original: ${originalExpression}\n`;
    formatted += `  CEL: ${celExpression}\n`;
    formatted += `  Error: ${errorMessage}`;
    
    if (suggestions.length > 0) {
      formatted += '\n\nSuggestions:\n';
      suggestions.forEach((suggestion, index) => {
        formatted += `  ${index + 1}. ${suggestion}\n`;
      });
    }
    
    return formatted;
  }

  /**
   * Check if two runtime errors are similar (same root cause)
   */
  static areErrorsSimilar(error1: CelRuntimeError, error2: CelRuntimeError): boolean {
    // Same error type and similar expressions
    if (error1.errorType !== error2.errorType) {
      return false;
    }
    
    // Same resource context
    if (error1.context?.resourceId !== error2.context?.resourceId) {
      return false;
    }
    
    // Similar error messages (allowing for minor variations)
    const message1 = error1.errorMessage.toLowerCase().replace(/['"]/g, '');
    const message2 = error2.errorMessage.toLowerCase().replace(/['"]/g, '');
    
    return message1.includes(message2) || message2.includes(message1);
  }

  /**
   * Group similar errors together
   */
  static groupSimilarErrors(errors: CelRuntimeError[]): CelRuntimeError[][] {
    const groups: CelRuntimeError[][] = [];
    const processed = new Set<number>();
    
    for (let i = 0; i < errors.length; i++) {
      if (processed.has(i) || !errors[i]) continue;
      
      const group = [errors[i]];
      processed.add(i);
      
      for (let j = i + 1; j < errors.length; j++) {
        if (processed.has(j) || !errors[j]) continue;
        
        if (errors[i] && errors[j] && CelRuntimeErrorUtils.areErrorsSimilar(errors[i]!, errors[j]!)) {
          group.push(errors[j]!);
          processed.add(j);
        }
      }
      
      groups.push(group.filter(Boolean) as CelRuntimeError[]);
    }
    
    return groups;
  }
}