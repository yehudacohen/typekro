import { getInnerCelPath, isCelExpression, isKubernetesRef } from '../../utils/index';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import type { CelExpression, RefOrValue, SerializationContext } from '../types.js';

function expr<T = unknown>(...parts: RefOrValue<unknown>[]): CelExpression<T> & T;
function expr<T = unknown>(
  context: SerializationContext,
  ...parts: RefOrValue<unknown>[]
): CelExpression<T> & T;
function expr<T = unknown>(
  contextOrFirstPart: SerializationContext | RefOrValue<unknown>,
  ...parts: RefOrValue<unknown>[]
): CelExpression<T> & T {
  let _context: SerializationContext | undefined;
  let actualParts: RefOrValue<unknown>[];

  // Check if first argument is a context object
  if (
    contextOrFirstPart &&
    typeof contextOrFirstPart === 'object' &&
    'celPrefix' in contextOrFirstPart
  ) {
    _context = contextOrFirstPart as SerializationContext;
    actualParts = parts;
  } else {
    actualParts = [contextOrFirstPart as RefOrValue<unknown>, ...parts];
  }

  const celParts = actualParts.map((part) => {
    if (isKubernetesRef(part)) {
      // Use inner reference without ${} wrapper for building expressions
      return getInnerCelPath(part);
    }

    if (isCelExpression(part)) {
      return part.expression;
    }

    if (typeof part === 'string') {
      return part;
    }

    if (typeof part === 'number' || typeof part === 'boolean') {
      return String(part);
    }

    // For other types, convert to string
    return String(part);
  });

  const expression = celParts.join('');

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
  } as CelExpression<T> & T;
}

/**
 * Convenience method for joining parts with automatic spacing.
 * Useful for building readable CEL expressions.
 */
function join<T = unknown>(...parts: RefOrValue<unknown>[]): CelExpression<T> & T;
function join<T = unknown>(
  context: SerializationContext,
  ...parts: RefOrValue<unknown>[]
): CelExpression<T> & T;
function join<T = unknown>(
  contextOrFirstPart: SerializationContext | RefOrValue<unknown>,
  ...parts: RefOrValue<unknown>[]
): CelExpression<T> {
  let context: SerializationContext | undefined;
  let actualParts: RefOrValue<unknown>[];

  // Check if first argument is a context object
  if (
    contextOrFirstPart &&
    typeof contextOrFirstPart === 'object' &&
    'celPrefix' in contextOrFirstPart
  ) {
    context = contextOrFirstPart as SerializationContext;
    actualParts = parts;
  } else {
    actualParts = [contextOrFirstPart as RefOrValue<unknown>, ...parts];
  }

  // Add spaces between parts for readability
  const spacedParts: RefOrValue<unknown>[] = [];
  for (let i = 0; i < actualParts.length; i++) {
    spacedParts.push(actualParts[i]);
    if (i < actualParts.length - 1) {
      spacedParts.push(' ');
    }
  }

  // Pass the generic type <T> to the expr call
  return context ? expr<T>(context, ...spacedParts) : expr<T>(...spacedParts);
}

// Common CEL value types
type CelValue = string | number | boolean | null | undefined;

/**
 * Creates a conditional CEL expression: condition ? trueValue : falseValue
 */
function conditional<T = unknown>(
  condition: RefOrValue<CelValue>,
  trueValue: RefOrValue<CelValue>,
  falseValue: RefOrValue<CelValue>
): CelExpression<T> & T;
function conditional<T = unknown>(
  context: SerializationContext,
  condition: RefOrValue<CelValue>,
  trueValue: RefOrValue<CelValue>,
  falseValue: RefOrValue<CelValue>
): CelExpression<T> & T;
function conditional<T = unknown>(
  contextOrCondition: SerializationContext | RefOrValue<CelValue>,
  conditionOrTrueValue: RefOrValue<CelValue>,
  trueValueOrFalseValue: RefOrValue<CelValue>,
  falseValue?: RefOrValue<CelValue>
): CelExpression<T> {
  if (falseValue !== undefined) {
    // Context overload: Pass the generic type <T> to the expr call
    const context = contextOrCondition as SerializationContext;
    return expr<T>(context, conditionOrTrueValue, ' ? ', trueValueOrFalseValue, ' : ', falseValue);
  } else {
    // No context overload: Pass the generic type <T> to the expr call
    return expr<T>(contextOrCondition, ' ? ', conditionOrTrueValue, ' : ', trueValueOrFalseValue);
  }
}

/**
 * Creates a CEL expression for mathematical operations
 */
function math<T = unknown>(
  operation: string,
  ...operands: RefOrValue<CelValue>[]
): CelExpression<T> & T;
function math<T = unknown>(
  context: SerializationContext,
  operation: string,
  ...operands: RefOrValue<CelValue>[]
): CelExpression<T> & T;
function math<T = unknown>(
  contextOrOperation: SerializationContext | string,
  operationOrFirstOperand?: string | RefOrValue<CelValue>,
  ...operands: RefOrValue<CelValue>[]
): CelExpression<T> & T {
  let context: SerializationContext | undefined;
  let operation: string;
  let actualOperands: RefOrValue<CelValue>[];

  if (typeof contextOrOperation === 'string') {
    // No context overload
    operation = contextOrOperation;
    actualOperands = operationOrFirstOperand ? [operationOrFirstOperand, ...operands] : operands;
  } else {
    // Context overload
    context = contextOrOperation;
    operation = operationOrFirstOperand as string;
    actualOperands = operands;
  }

  const operandStrings = actualOperands.map((op) => {
    if (isKubernetesRef(op)) {
      return getInnerCelPath(op);
    }
    if (isCelExpression(op)) {
      return op.expression;
    }
    return String(op);
  });

  const result = context
    ? expr(context, `${operation}(${operandStrings.join(', ')})`)
    : expr(`${operation}(${operandStrings.join(', ')})`);
  return result as unknown as CelExpression<T> & T;
}

/**
 * Creates a mixed string template that combines literal strings with CEL expressions
 *
 * This function creates YAML strings with embedded CEL expressions.
 *
 * Examples:
 * - template('http://%s', schema.spec.name) -> "http://${schema.spec.name}"
 * - template('%s-%s', prefix, suffix) -> "${prefix}-${suffix}"
 */
function template(
  templateString: string,
  ...values: RefOrValue<CelValue>[]
): CelExpression<string> & string;
function template(
  context: SerializationContext,
  templateString: string,
  ...values: RefOrValue<CelValue>[]
): CelExpression<string> & string;
function template(
  contextOrTemplateString: SerializationContext | string,
  templateStringOrFirstValue?: string | RefOrValue<CelValue>,
  ...values: RefOrValue<CelValue>[]
): CelExpression<string> & string {
  let _context: SerializationContext | undefined;
  let templateString: string;
  let actualValues: RefOrValue<CelValue>[];

  if (typeof contextOrTemplateString === 'string') {
    // No context overload
    templateString = contextOrTemplateString;
    actualValues = templateStringOrFirstValue ? [templateStringOrFirstValue, ...values] : values;
  } else {
    // Context overload
    _context = contextOrTemplateString;
    templateString = templateStringOrFirstValue as string;
    actualValues = values;
  }

  let result = templateString;
  let valueIndex = 0;

  // Replace %s placeholders with ${...} CEL expressions
  result = result.replace(/%s/g, () => {
    if (valueIndex < actualValues.length) {
      const value = actualValues[valueIndex++];
      if (isKubernetesRef(value)) {
        // For KubernetesRef, create a ${...} placeholder
        return `\${${getInnerCelPath(value)}}`;
      }
      if (isCelExpression(value)) {
        // For CEL expressions, wrap in ${...}
        return `\${${value.expression}}`;
      }
      // For literal values, just insert them directly
      return String(value);
    }
    return '%s';
  });

  // Mark this as a special template expression that should not be wrapped in ${...}
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: result,
    __isTemplate: true, // Special flag to indicate this is a mixed template
  } as unknown as CelExpression<string> & string;
}

/**
 * Creates a CEL string concatenation expression using the + operator
 *
 * This function automatically quotes string literals and joins all parts with +
 *
 * Examples:
 * - concat('http://', serviceName) -> "http://" + serviceName
 * - concat(prefix, '-', suffix) -> prefix + "-" + suffix
 */
function concat(...parts: RefOrValue<CelValue>[]): CelExpression<string> & string;
function concat(
  context: SerializationContext,
  ...parts: RefOrValue<CelValue>[]
): CelExpression<string> & string;
function concat(
  contextOrFirstPart: SerializationContext | RefOrValue<CelValue>,
  ...parts: RefOrValue<CelValue>[]
): CelExpression<string> & string {
  let _context: SerializationContext | undefined;
  let actualParts: RefOrValue<CelValue>[];

  // Check if first argument is a context object
  if (
    contextOrFirstPart &&
    typeof contextOrFirstPart === 'object' &&
    'celPrefix' in contextOrFirstPart
  ) {
    _context = contextOrFirstPart as SerializationContext;
    actualParts = parts;
  } else {
    actualParts = [contextOrFirstPart as RefOrValue<CelValue>, ...parts];
  }

  const celParts = actualParts.map((part) => {
    if (isKubernetesRef(part)) {
      return getInnerCelPath(part);
    }

    if (isCelExpression(part)) {
      return part.expression;
    }

    if (typeof part === 'string') {
      // Quote string literals for CEL
      return `"${part}"`;
    }

    if (typeof part === 'number' || typeof part === 'boolean') {
      return String(part);
    }

    // For other types, convert to string and quote
    return `"${String(part)}"`;
  });

  const expression = celParts.join(' + ');

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
  } as CelExpression<string> & string;
}

/**
 * Template literal tag function for creating CEL expressions from template literals
 * This allows natural template literal syntax while preserving KubernetesRef objects
 * 
 * @example
 * ```typescript
 * const url = cel`https://${schema.spec.hostname}/api`;
 * // Creates a CelExpression that will be serialized as: "https://" + schema.spec.hostname + "/api"
 * ```
 */
function cel<T = string>(
  strings: TemplateStringsArray,
  ...values: RefOrValue<unknown>[]
): CelExpression<T> & T {
  const parts: string[] = [];
  
  for (let i = 0; i < strings.length; i++) {
    // Add the string literal part
    if (strings[i]) {
      parts.push(`"${strings[i]?.replace(/"/g, '\\"')}"`);
    }
    
    // Add the interpolated value if it exists
    if (i < values.length) {
      const value = values[i];
      
      if (isKubernetesRef(value)) {
        // Convert KubernetesRef to CEL path
        if (value.resourceId === '__schema__') {
          parts.push(`schema.${value.fieldPath}`);
        } else {
          parts.push(`${value.resourceId}.${value.fieldPath}`);
        }
      } else if (isCelExpression(value)) {
        parts.push(value.expression);
      } else if (typeof value === 'string') {
        parts.push(`"${value.replace(/"/g, '\\"')}"`);
      } else {
        parts.push(String(value));
      }
    }
  }
  
  const expression = parts.join(' + ');

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: 'string' as any,
  } as CelExpression<T> & T;
}

/**
 * CEL utility functions
 */
export const Cel = {
  expr,
  join,
  conditional,
  math,
  template,
  concat,
  cel,

  // Common CEL functions as utilities
  min: (...values: RefOrValue<CelValue>[]) => math<number>('min', ...values),
  max: (...values: RefOrValue<CelValue>[]) => math<number>('max', ...values),
  size: (collection: RefOrValue<CelValue>) => math<number>('size', collection),
  string: (value: RefOrValue<CelValue>) =>
    math<string>('string', value) as CelExpression<string> & string,
  int: (value: RefOrValue<CelValue>) => math<number>('int', value),
  double: (value: RefOrValue<CelValue>) => math<number>('double', value),

  // Context-aware versions
  withContext: (context: SerializationContext) => ({
    expr: (...parts: RefOrValue<CelValue>[]) => expr(context, ...parts),
    join: (...parts: RefOrValue<CelValue>[]) => join(context, ...parts),
    conditional: (
      condition: RefOrValue<CelValue>,
      trueValue: RefOrValue<CelValue>,
      falseValue: RefOrValue<CelValue>
    ) => conditional(context, condition, trueValue, falseValue),
    math: (operation: string, ...operands: RefOrValue<CelValue>[]) =>
      math(context, operation, ...operands),
    template: (templateString: string, ...values: RefOrValue<CelValue>[]) =>
      template(context, templateString, ...values),
    concat: (...parts: RefOrValue<CelValue>[]) => concat(context, ...parts),

    min: (...values: RefOrValue<CelValue>[]) => math<number>(context, 'min', ...values),
    max: (...values: RefOrValue<CelValue>[]) => math<number>(context, 'max', ...values),
    size: (collection: RefOrValue<CelValue>) => math<number>(context, 'size', collection),
    string: (value: RefOrValue<CelValue>) =>
      math<string>(context, 'string', value) as CelExpression<string> & string,
    int: (value: RefOrValue<CelValue>) => math<number>(context, 'int', value),
    double: (value: RefOrValue<CelValue>) => math<number>(context, 'double', value),
  }),
};

// Export cel as a standalone function for template literal usage
export { cel };
