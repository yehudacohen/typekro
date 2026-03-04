import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { getInnerCelPath } from '../serialization/cel-references.js';
import type { CelExpression, RefOrValue, SerializationContext } from '../types.js';

const logger = getComponentLogger('cel');

/**
 * Escape a string for safe embedding in a CEL string literal.
 * Prevents CEL injection by escaping backslashes first, then double quotes.
 */
function escapeCelString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Patterns that indicate raw JavaScript operators were used instead of CEL operators.
 * Note: && and || are valid CEL operators, so only === and !== are flagged. */
const SUSPICIOUS_JS_PATTERNS = [/===/, /!==/];

/**
 * Regex matching string parts that look like CEL operators but lack a leading space.
 * Matches strings starting with >, <, ==, !=, >=, <=, &&, ||, +, -, *, / followed
 * by a space character. The trailing space distinguishes operator-like strings
 * (e.g., `'> 0'` meant as `' > 0'`) from string suffixes (e.g., `'-db'`).
 * Does NOT match strings starting with a space (correct usage) or
 * method-call-style strings like '.exists(...)'.
 */
const MISSING_LEADING_SPACE = /^(?:>=|<=|==|!=|&&|\|\||[><!+\-*/]) /;

/**
 * Validates inputs to Cel.expr() and warns about suspicious patterns.
 * @throws {TypeKroError} if inputs are null, undefined, or empty strings
 */
function validateExprParts(parts: RefOrValue<unknown>[]): void {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === null || part === undefined) {
      throw new TypeKroError(
        `Cel.expr() received ${part === null ? 'null' : 'undefined'} at argument index ${i}. ` +
          'All parts must be valid values (string, number, boolean, KubernetesRef, or CelExpression).',
        'CEL_INVALID_INPUT'
      );
    }

    if (typeof part === 'string') {
      if (part.length === 0) {
        throw new TypeKroError(
          `Cel.expr() received an empty string at argument index ${i}. ` +
            'Use a non-empty CEL expression or literal value.',
          'CEL_INVALID_INPUT'
        );
      }

      for (const pattern of SUSPICIOUS_JS_PATTERNS) {
        if (pattern.test(part)) {
          logger.warn(
            'Cel.expr() argument contains a JavaScript operator which is not valid in CEL. Use CEL equivalents instead: === -> ==, !== -> !=.',
            {
              argumentIndex: i,
              pattern: pattern.source,
              input: part,
            }
          );
          break;
        }
      }

      // Warn about missing leading space in operator parts.
      // Only check parts after the first one — the first part is often a standalone
      // CEL expression (e.g., 'true', '1 > 0') where a leading space makes no sense.
      if (i > 0 && MISSING_LEADING_SPACE.test(part)) {
        logger.warn(
          `Cel.expr() operator string at argument index ${i} is missing a leading space. ` +
            `Got "${part}" — did you mean " ${part}"? Without the space, the generated CEL ` +
            'expression will concatenate the operator directly against the previous token, ' +
            'producing invalid CEL (e.g., "field> 0" instead of "field > 0").',
          {
            argumentIndex: i,
            input: part,
          }
        );
      }
    }
  }
}

/**
 * Build a CEL expression from parts. Accepts resource references (`schema.spec.*`,
 * `resources.*.status.*`), other CEL expressions, and literal strings/numbers/booleans.
 * Parts are concatenated directly (no spaces). Use `Cel.join` for spaced joining.
 *
 * The type parameter `T` constrains what the expression evaluates to at runtime,
 * ensuring type safety through the serialization pipeline.
 *
 * @typeParam T - The CEL expression's result type (e.g., `boolean`, `string`, `number`)
 *
 * @example Status readiness check
 * ```typescript
 * ready: Cel.expr<boolean>(resources.deployment.status.readyReplicas, ' > 0')
 * ```
 *
 * @example Conditional phase
 * ```typescript
 * phase: Cel.expr<string>(resources.helm.status.phase, ' == "Ready" ? "Ready" : "Installing"')
 * ```
 *
 * @example Static value (backtick + quotes)
 * ```typescript
 * phase: Cel.expr<string>`'running'`
 * ```
 */
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

  validateExprParts(actualParts);

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
      // Quote string literals for CEL, escaping special characters
      return `"${escapeCelString(part)}"`;
    }

    if (typeof part === 'number' || typeof part === 'boolean') {
      return String(part);
    }

    // For other types, convert to string and quote
    return `"${escapeCelString(String(part))}"`;
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
      parts.push(`"${escapeCelString(strings[i] ?? '')}"`);
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
        parts.push(`"${escapeCelString(value)}"`);
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
 * CEL (Common Expression Language) utilities for building type-safe expressions
 * in resource graph status builders.
 *
 * In Kro mode, CEL expressions are serialized into the RGD YAML and evaluated
 * by the Kro operator at runtime. In Direct mode, they are evaluated locally
 * using the `cel-js` library.
 *
 * @example Basic usage
 * ```typescript
 * import { Cel } from 'typekro';
 *
 * // Boolean expression
 * ready: Cel.expr<boolean>(resources.deploy.status.readyReplicas, ' > 0')
 *
 * // String template with %s placeholders
 * url: Cel.template('https://%s/api', schema.spec.hostname)
 *
 * // Tagged template literal
 * greeting: Cel.cel`Hello ${schema.spec.name}`
 *
 * // Conditional
 * phase: Cel.conditional(resources.deploy.status.readyReplicas, '"Ready"', '"Pending"')
 *
 * // CEL built-in functions
 * count: Cel.size(resources.deploy.status.readyReplicas)
 * ```
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
