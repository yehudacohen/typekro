/**
 * Expression Proxy System for JavaScript-to-CEL Conversion
 * 
 * This module provides a proxy system that intercepts JavaScript operations on KubernetesRef objects
 * and creates expression KubernetesRef objects instead of evaluating them immediately.
 * 
 * The key insight is that we need to capture expressions BEFORE they're evaluated,
 * not try to detect KubernetesRef objects after evaluation has already happened.
 */

import { KUBERNETES_REF_BRAND } from '../constants/brands.js';
import type { KubernetesRef } from '../types/index.js';
import { isKubernetesRef } from '../../utils/type-guards.js';

/**
 * Expression KubernetesRef - represents a JavaScript expression that should be converted to CEL
 */
interface ExpressionKubernetesRef<T = any> extends KubernetesRef<T> {
  readonly __expressionType: 'binary' | 'template' | 'conditional' | 'logical' | 'unary';
  readonly __operator?: string;
  readonly __left?: any;
  readonly __right?: any;
  readonly __template?: string;
  readonly __templateParts?: any[];
  readonly __condition?: any;
  readonly __consequent?: any;
  readonly __alternate?: any;
}

/**
 * Create an expression KubernetesRef for binary operations (===, !==, >, <, >=, <=, &&, ||)
 */
function createBinaryExpressionRef<T>(
  operator: string,
  left: any,
  right: any,
  resourceId: string = '__expression__',
  fieldPath: string = `${left.fieldPath || 'unknown'} ${operator} ${right}`
): ExpressionKubernetesRef<T> {
  const expressionRef = (() => {
    throw new Error('Expression KubernetesRef should not be called as a function');
  }) as any;

  Object.defineProperties(expressionRef, {
    [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
    resourceId: { value: resourceId, enumerable: false },
    fieldPath: { value: fieldPath, enumerable: false },
    __expressionType: { value: 'binary', enumerable: false },
    __operator: { value: operator, enumerable: false },
    __left: { value: left, enumerable: false },
    __right: { value: right, enumerable: false }
  });

  return expressionRef as ExpressionKubernetesRef<T>;
}

/**
 * Create an expression KubernetesRef for template literals
 */
function createTemplateExpressionRef<T>(
  template: string,
  parts: any[],
  resourceId: string = '__expression__',
  fieldPath: string = `template(${template})`
): ExpressionKubernetesRef<T> {
  const expressionRef = (() => {
    throw new Error('Expression KubernetesRef should not be called as a function');
  }) as any;

  Object.defineProperties(expressionRef, {
    [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
    resourceId: { value: resourceId, enumerable: false },
    fieldPath: { value: fieldPath, enumerable: false },
    __expressionType: { value: 'template', enumerable: false },
    __template: { value: template, enumerable: false },
    __templateParts: { value: parts, enumerable: false }
  });

  return expressionRef as ExpressionKubernetesRef<T>;
}

/**
 * Create an expression KubernetesRef for conditional expressions (ternary operator)
 */
function createConditionalExpressionRef<T>(
  condition: any,
  consequent: any,
  alternate: any,
  resourceId: string = '__expression__',
  fieldPath: string = `${condition.fieldPath || 'unknown'} ? ${consequent} : ${alternate}`
): ExpressionKubernetesRef<T> {
  const expressionRef = (() => {
    throw new Error('Expression KubernetesRef should not be called as a function');
  }) as any;

  Object.defineProperties(expressionRef, {
    [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
    resourceId: { value: resourceId, enumerable: false },
    fieldPath: { value: fieldPath, enumerable: false },
    __expressionType: { value: 'conditional', enumerable: false },
    __condition: { value: condition, enumerable: false },
    __consequent: { value: consequent, enumerable: false },
    __alternate: { value: alternate, enumerable: false }
  });

  return expressionRef as ExpressionKubernetesRef<T>;
}

/**
 * Enhanced KubernetesRef that supports expression operations
 * 
 * This proxy intercepts operations on KubernetesRef objects and creates
 * expression KubernetesRef objects instead of evaluating them immediately.
 */
function createExpressionProxy<T>(ref: KubernetesRef<T>): KubernetesRef<T> {
  return new Proxy(ref, {
    get(target, prop, receiver) {
      // Handle comparison operations
      if (prop === Symbol.toPrimitive || prop === 'valueOf') {
        return (hint?: string) => {
          if (hint === 'string') {
            return `\${${target.resourceId}.${target.fieldPath}}`;
          }
          // For other hints, return the proxy itself to enable further operations
          return receiver;
        };
      }

      // Handle toString for template literals
      if (prop === 'toString') {
        return () => `\${${target.resourceId}.${target.fieldPath}}`;
      }

      // Return the original property
      return Reflect.get(target, prop, receiver);
    }
  }) as KubernetesRef<T>;
}

/**
 * Expression capture system that overrides global operators
 * 
 * This is a more advanced approach that tries to capture expressions
 * by overriding comparison and logical operators.
 */
export class ExpressionCaptureSystem {
  private capturedExpressions: ExpressionKubernetesRef[] = [];
  private isCapturing = false;

  /**
   * Start capturing expressions
   */
  startCapture(): void {
    this.isCapturing = true;
    this.capturedExpressions = [];
  }

  /**
   * Stop capturing expressions and return captured expressions
   */
  stopCapture(): ExpressionKubernetesRef[] {
    this.isCapturing = false;
    const expressions = [...this.capturedExpressions];
    this.capturedExpressions = [];
    return expressions;
  }

  /**
   * Create a KubernetesRef that captures expressions when used in operations
   */
  createCapturingRef<T>(resourceId: string, fieldPath: string): KubernetesRef<T> {
    
    const ref = (() => {
      throw new Error('KubernetesRef should not be called as a function');
    }) as any;

    Object.defineProperties(ref, {
      [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
      resourceId: { value: resourceId, enumerable: false },
      fieldPath: { value: fieldPath, enumerable: false }
    });

    // Create a proxy that intercepts operations
    return new Proxy(ref, {
      get(target, prop, receiver) {
        // Handle comparison operations by returning functions that create expression refs
        if (prop === Symbol.toPrimitive || prop === 'valueOf') {
          return (hint?: string) => {
            if (hint === 'string') {
              // For template literals, return a string that can be detected
              return `__KUBERNETES_REF_${resourceId}_${fieldPath}__`;
            }
            // For numeric comparisons, return a special object
            return new Proxy({}, {
              get(_, op) {
                if (op === Symbol.toPrimitive) {
                  return () => receiver;
                }
                return receiver;
              }
            });
          };
        }

        if (prop === 'toString') {
          return () => `__KUBERNETES_REF_${resourceId}_${fieldPath}__`;
        }

        // Return the original property
        return Reflect.get(target, prop, receiver);
      }
    }) as KubernetesRef<T>;
  }
}

/**
 * Global expression capture system instance
 */
export const expressionCaptureSystem = new ExpressionCaptureSystem();

/**
 * Utility function to check if a value is an expression KubernetesRef
 */
export function isExpressionKubernetesRef(value: any): value is ExpressionKubernetesRef {
  return isKubernetesRef(value) && '__expressionType' in value;
}

/**
 * Convert an expression KubernetesRef to a CEL expression string
 */
export function expressionRefToCel(expr: ExpressionKubernetesRef): string {
  switch (expr.__expressionType) {
    case 'binary': {
      const left = isKubernetesRef(expr.__left) 
        ? `\${${expr.__left.resourceId}.${expr.__left.fieldPath}}`
        : JSON.stringify(expr.__left);
      const right = isKubernetesRef(expr.__right)
        ? `\${${expr.__right.resourceId}.${expr.__right.fieldPath}}`
        : JSON.stringify(expr.__right);
      
      // Map JavaScript operators to CEL operators
      const celOperator = mapJavaScriptOperatorToCel(expr.__operator || '');
      return `\${${left} ${celOperator} ${right}}`;
    }

    case 'template':
      // Convert template literal to CEL template
      return `\${${expr.__template}}`;

    case 'conditional': {
      const condition = isKubernetesRef(expr.__condition)
        ? `\${${expr.__condition.resourceId}.${expr.__condition.fieldPath}}`
        : JSON.stringify(expr.__condition);
      const consequent = isKubernetesRef(expr.__consequent)
        ? `\${${expr.__consequent.resourceId}.${expr.__consequent.fieldPath}}`
        : JSON.stringify(expr.__consequent);
      const alternate = isKubernetesRef(expr.__alternate)
        ? `\${${expr.__alternate.resourceId}.${expr.__alternate.fieldPath}}`
        : JSON.stringify(expr.__alternate);
      
      return `\${${condition} ? ${consequent} : ${alternate}}`;
    }

    default:
      return `\${${expr.resourceId}.${expr.fieldPath}}`;
  }
}

/**
 * Map JavaScript operators to CEL operators
 */
function mapJavaScriptOperatorToCel(jsOperator: string): string {
  const operatorMap: Record<string, string> = {
    '===': '==',
    '!==': '!=',
    '&&': '&&',
    '||': '||',
    '>': '>',
    '<': '<',
    '>=': '>=',
    '<=': '<=',
    '+': '+',
    '-': '-',
    '*': '*',
    '/': '/',
    '%': '%'
  };

  return operatorMap[jsOperator] || jsOperator;
}

export {
  createBinaryExpressionRef,
  createTemplateExpressionRef,
  createConditionalExpressionRef,
  createExpressionProxy
};
export type { ExpressionKubernetesRef };