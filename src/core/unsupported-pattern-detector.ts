/**
 * Utility for detecting and reporting unsupported patterns in compositions
 *
 * Extracted from errors.ts alongside CompositionDebugger to keep errors.ts
 * focused on error class definitions. UnsupportedPatternDetector is a utility
 * class, not an error class, and references CompositionExecutionError.
 */

import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from './constants/brands.js';
import { CompositionExecutionError } from './errors.js';

export class UnsupportedPatternDetector {
  /**
   * Detect unsupported JavaScript patterns in status objects
   */
  static detectUnsupportedStatusPatterns(statusObject: any, fieldPath = ''): string[] {
    const issues: string[] = [];

    if (typeof statusObject !== 'object' || statusObject === null) {
      return issues;
    }

    for (const [key, value] of Object.entries(statusObject)) {
      const currentPath = fieldPath ? `${fieldPath}.${key}` : key;

      // Skip CEL expressions and resource references - these are valid
      if (
        UnsupportedPatternDetector.isCelExpression(value) ||
        UnsupportedPatternDetector.isResourceReference(value)
      ) {
        continue;
      }

      // Check for JavaScript-specific patterns that don't work in CEL
      if (typeof value === 'string') {
        // Template literals with JavaScript expressions (but not CEL templates)
        if (value.includes('${') && !value.startsWith('${') && !value.endsWith('}')) {
          issues.push(`Template literal with JavaScript expressions at '${currentPath}': ${value}`);
        }

        // String concatenation patterns
        if (value.includes(' + ') || value.includes('` + `')) {
          issues.push(`String concatenation at '${currentPath}': ${value}`);
        }
      }

      // Check for function calls (but not CEL expressions or resource references)
      if (typeof value === 'function') {
        issues.push(`Function at '${currentPath}': Functions are not supported in status objects`);
      }

      // Check for complex JavaScript expressions
      if (typeof value === 'object' && value !== null) {
        // Recursively check nested objects
        issues.push(
          ...UnsupportedPatternDetector.detectUnsupportedStatusPatterns(value, currentPath)
        );

        // Check for JavaScript-specific object patterns
        if (Array.isArray(value)) {
          // Check for array methods like .map, .filter, etc.
          const stringified = JSON.stringify(value);
          if (
            stringified.includes('.map(') ||
            stringified.includes('.filter(') ||
            stringified.includes('.reduce(')
          ) {
            issues.push(`Array method calls at '${currentPath}': Use CEL expressions instead`);
          }
        }
      }
    }

    return issues;
  }

  /**
   * Check if a value is a CEL expression (using symbol-based brand)
   */
  private static isCelExpression(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      CEL_EXPRESSION_BRAND in value &&
      (value as Record<symbol, unknown>)[CEL_EXPRESSION_BRAND] === true
    );
  }

  /**
   * Check if a value is a resource reference
   */
  private static isResourceReference(value: unknown): boolean {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return false;
    }

    // Check for KubernetesRef using symbol-based brand (proxy-safe via Reflect.get)
    if (Reflect.get(value, KUBERNETES_REF_BRAND) === true) {
      return true;
    }

    // Check for proxy objects that might be resource references
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.resourceId || obj.fieldPath || obj.__isProxy) {
        return true;
      }
    }

    // Check for function proxies that represent resource references
    if (
      typeof value === 'function' &&
      (value as unknown as Record<string, unknown>).__isResourceProxy
    ) {
      return true;
    }

    return false;
  }

  /**
   * Generate suggestions for fixing unsupported patterns
   */
  static generatePatternSuggestions(pattern: string): string[] {
    const suggestions: string[] = [];

    if (pattern.includes('template literal')) {
      suggestions.push('Use Cel.template() instead of JavaScript template literals');
      suggestions.push(
        'Example: Cel.template("https://%s", hostname) instead of `https://${hostname}`'
      );
    }

    if (pattern.includes('string concatenation')) {
      suggestions.push('Use Cel.expr() for string concatenation');
      suggestions.push('Example: Cel.expr(prefix, " + ", suffix) instead of prefix + suffix');
    }

    if (pattern.includes('function')) {
      suggestions.push('Functions are not supported in status objects');
      suggestions.push('Use CEL expressions or move logic to the composition function');
    }

    if (pattern.includes('array method')) {
      suggestions.push('Use CEL expressions for array operations');
      suggestions.push('Example: Cel.expr(array, ".size()") instead of array.length');
    }

    if (pattern.includes('JavaScript expressions')) {
      suggestions.push('Replace JavaScript expressions with CEL expressions');
      suggestions.push('Use Cel.expr() for complex logic and Cel.template() for string formatting');
    }

    // General suggestions
    suggestions.push('Refer to the CEL documentation for supported operations');
    suggestions.push('Use literal values for simple cases, CEL expressions for complex logic');

    return suggestions;
  }

  /**
   * Create a comprehensive error for unsupported patterns
   */
  static createUnsupportedPatternError(
    compositionName: string,
    statusObject: any
  ): CompositionExecutionError | null {
    const issues = UnsupportedPatternDetector.detectUnsupportedStatusPatterns(statusObject);

    if (issues.length === 0) {
      return null;
    }

    const allSuggestions = new Set<string>();
    issues.forEach((issue) => {
      UnsupportedPatternDetector.generatePatternSuggestions(issue).forEach((suggestion) => {
        allSuggestions.add(suggestion);
      });
    });

    const message = `Unsupported patterns detected in composition '${compositionName}':\n\n${issues.map((issue, i) => `  ${i + 1}. ${issue}`).join('\n')}`;

    return CompositionExecutionError.forUnsupportedPattern(
      compositionName,
      message,
      Array.from(allSuggestions)
    );
  }
}
