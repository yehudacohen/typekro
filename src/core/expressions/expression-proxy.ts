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
import { ConversionError } from '../errors.js';
import type { KubernetesRef } from '../types/index.js';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Function used as proxy target with branded KubernetesRef properties; TypeScript cannot represent this pattern
  const expressionRef = (() => {
    throw new ConversionError(
      'Expression KubernetesRef should not be called as a function',
      fieldPath,
      'binary-operation'
    );
  }) as unknown as Record<symbol | string, unknown>;

  Object.defineProperties(expressionRef, {
    [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
    resourceId: { value: resourceId, enumerable: false },
    fieldPath: { value: fieldPath, enumerable: false },
    __expressionType: { value: 'binary', enumerable: false },
    __operator: { value: operator, enumerable: false },
    __left: { value: left, enumerable: false },
    __right: { value: right, enumerable: false },
  });

  return expressionRef as unknown as ExpressionKubernetesRef<T>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Function used as proxy target with branded KubernetesRef properties
  const expressionRef = (() => {
    throw new ConversionError(
      'Expression KubernetesRef should not be called as a function',
      fieldPath,
      'template-literal'
    );
  }) as unknown as Record<symbol | string, unknown>;

  Object.defineProperties(expressionRef, {
    [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
    resourceId: { value: resourceId, enumerable: false },
    fieldPath: { value: fieldPath, enumerable: false },
    __expressionType: { value: 'template', enumerable: false },
    __template: { value: template, enumerable: false },
    __templateParts: { value: parts, enumerable: false },
  });

  return expressionRef as unknown as ExpressionKubernetesRef<T>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Function used as proxy target with branded KubernetesRef properties
  const expressionRef = (() => {
    throw new ConversionError(
      'Expression KubernetesRef should not be called as a function',
      fieldPath,
      'conditional'
    );
  }) as unknown as Record<symbol | string, unknown>;

  Object.defineProperties(expressionRef, {
    [KUBERNETES_REF_BRAND]: { value: true, enumerable: false },
    resourceId: { value: resourceId, enumerable: false },
    fieldPath: { value: fieldPath, enumerable: false },
    __expressionType: { value: 'conditional', enumerable: false },
    __condition: { value: condition, enumerable: false },
    __consequent: { value: consequent, enumerable: false },
    __alternate: { value: alternate, enumerable: false },
  });

  return expressionRef as unknown as ExpressionKubernetesRef<T>;
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
    },
  }) as KubernetesRef<T>;
}

export {
  createBinaryExpressionRef,
  createTemplateExpressionRef,
  createConditionalExpressionRef,
  createExpressionProxy,
};
export type { ExpressionKubernetesRef };
