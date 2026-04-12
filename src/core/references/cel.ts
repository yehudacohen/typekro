import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { getInnerCelPath } from '../serialization/cel-references.js';
import type { CelExpression, RefOrValue } from '../types.js';

const logger = getComponentLogger('cel');

/**
 * Escape a string for safe embedding in a CEL string literal.
 * Prevents CEL injection by escaping backslashes first, then double quotes.
 *
 * TODO: consolidate with escapeCelLiteral in core.ts (which also handles
 * \n, \r, \t) and CelEvaluator.escapeCelString in cel-evaluator.ts.
 * All four copies implement the same core logic — extract to a shared
 * utils/cel-escape.ts module.
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
          throw new TypeKroError(
            `Cel.expr() argument at index ${i} contains JavaScript operator '${pattern.source}' which is not valid in CEL. ` +
              'Use CEL equivalents instead: === -> ==, !== -> !=.',
            'CEL_INVALID_JS_OPERATOR'
          );
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
function expr<T = unknown>(...parts: RefOrValue<unknown>[]): CelExpression<T> & T {
  validateExprParts(parts);

  const celParts = parts.map((part) => {
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
function join<T = unknown>(...parts: RefOrValue<unknown>[]): CelExpression<T> & T {
  // Add spaces between parts for readability
  const spacedParts: RefOrValue<unknown>[] = [];
  for (let i = 0; i < parts.length; i++) {
    spacedParts.push(parts[i]);
    if (i < parts.length - 1) {
      spacedParts.push(' ');
    }
  }

  return expr<T>(...spacedParts);
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
): CelExpression<T> & T {
  return expr<T>(condition, ' ? ', trueValue, ' : ', falseValue);
}

/**
 * Creates a CEL `has(path)` expression for checking whether an optional
 * schema or resource field is present.
 *
 * Use this in `includeWhen`, `readyWhen`, and other conditional contexts
 * where you need to test whether a user provided an optional spec field.
 * In KRO mode, the result is emitted as `has(schema.spec.X)` (or
 * `has(resources.X.Y)`); in direct mode, the caller should use native
 * JavaScript truthiness checks instead — this helper is only meaningful
 * when the argument is a KubernetesRef proxy.
 *
 * @example
 * ```typescript
 * // Create a Secret only when the user did NOT provide an external ref
 * setIncludeWhen(autoSecret, [Cel.not(Cel.has(spec.externalSecretRef))]);
 *
 * // Branch a field value on whether an optional field is present
 * valueFrom: {
 *   secretKeyRef: {
 *     name: Cel.conditional(
 *       Cel.has(spec.externalSecretRef),
 *       spec.externalSecretRef.name,
 *       Cel.str(spec.name, '-secret')
 *     ),
 *   },
 * }
 * ```
 */
function has(ref: RefOrValue<unknown>): CelExpression<boolean> & boolean {
  if (isKubernetesRef(ref)) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `has(${getInnerCelPath(ref)})`,
    } as CelExpression<boolean> & boolean;
  }
  if (isCelExpression(ref)) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `has(${ref.expression})`,
    } as CelExpression<boolean> & boolean;
  }
  throw new Error(
    'Cel.has() requires a KubernetesRef or CelExpression argument. Direct-mode callers should use native JavaScript truthiness checks instead.'
  );
}

/**
 * Negate a CEL boolean expression or a KubernetesRef.
 *
 * When passed a bare KubernetesRef, this is equivalent to
 * `!has(path)` — i.e., "the optional field is NOT set". This is the
 * natural read for conditions like "create this resource only when the
 * user didn't provide X".
 *
 * When passed a CelExpression, it produces `!(expression)`.
 *
 * @example
 * ```typescript
 * // Create the auto-Secret only when the user hasn't provided an external one
 * setIncludeWhen(autoSecret, [Cel.not(spec.externalSecretRef)]);
 * ```
 */
function not(operand: RefOrValue<unknown>): CelExpression<boolean> & boolean {
  if (isKubernetesRef(operand)) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `!has(${getInnerCelPath(operand)})`,
    } as CelExpression<boolean> & boolean;
  }
  if (isCelExpression(operand)) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `!(${operand.expression})`,
    } as CelExpression<boolean> & boolean;
  }
  if (typeof operand === 'boolean') {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: String(!operand),
    } as CelExpression<boolean> & boolean;
  }
  throw new Error(
    'Cel.not() requires a KubernetesRef, CelExpression, or boolean argument.'
  );
}

/**
 * Creates a CEL expression for mathematical operations
 */
function math<T = unknown>(
  operation: string,
  ...operands: RefOrValue<CelValue>[]
): CelExpression<T> & T {
  const operandStrings = operands.map((op) => {
    if (isKubernetesRef(op)) {
      return getInnerCelPath(op);
    }
    if (isCelExpression(op)) {
      return op.expression;
    }
    return String(op);
  });

  return expr<T>(`${operation}(${operandStrings.join(', ')})`);
}

/**
 * Convert a value to its CEL representation for use inside a ternary.
 * Unlike `expr()` which concatenates raw strings, this function
 * properly quotes string literals and converts marker strings
 * (containing `__KUBERNETES_REF__` tokens) to CEL concatenation.
 */
function celValueForTernary(value: RefOrValue<CelValue>): string {
  if (isKubernetesRef(value)) {
    return getInnerCelPath(value);
  }
  if (isCelExpression(value)) {
    return value.expression;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '""';
  }
  const str = String(value);
  // Check for __KUBERNETES_REF__ markers from template literal coercion.
  // Convert markers to CEL concatenation: "literal" + string(ref) + "literal"
  if (str.includes('__KUBERNETES_REF_')) {
    const parts: string[] = [];
    let lastIndex = 0;
    const pattern = /__KUBERNETES_REF_(__schema__|[^_]+)_([a-zA-Z0-9.$]+)__/g;
    let m: RegExpExecArray | null = pattern.exec(str);
    while (m !== null) {
      if (m.index > lastIndex) {
        parts.push(`"${escapeCelString(str.slice(lastIndex, m.index))}"`);
      }
      const resourceId = m[1]!;
      const fieldPath = m[2]!;
      const celPath =
        resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
      parts.push(`string(${celPath})`);
      lastIndex = m.index + m[0].length;
      m = pattern.exec(str);
    }
    if (lastIndex < str.length) {
      parts.push(`"${escapeCelString(str.slice(lastIndex))}"`);
    }
    return parts.length === 1 ? parts[0]! : parts.join(' + ');
  }
  // Plain string → quote as CEL string literal
  return `"${escapeCelString(str)}"`;
}

/**
 * Creates a conditional CEL expression with smart value conversion.
 *
 * Unlike `Cel.conditional` (which concatenates raw strings), `Cel.cond`
 * properly quotes string literals, converts marker strings from template
 * literal coercion, and handles KubernetesRef values — producing valid
 * CEL ternary expressions without manual escaping.
 *
 * @example Resource status condition with string values
 * ```typescript
 * env: { CACHE_MODE: Cel.cond(cache.status.ready, 'redis', 'memory') }
 * // → ${cache.status.ready ? "redis" : "memory"}
 * ```
 *
 * @example Marker strings from template literals
 * ```typescript
 * env: { URL: Cel.cond(cache.status.ready, `http://${cache.metadata.name}:6379`, '') }
 * // → ${cache.status.ready ? "http://" + string(cache.metadata.name) + ":6379" : ""}
 * ```
 */
function cond<T = unknown>(
  condition: RefOrValue<unknown>,
  trueValue: RefOrValue<CelValue>,
  falseValue: RefOrValue<CelValue>
): CelExpression<T> & T {
  let condCel: string;
  if (isKubernetesRef(condition)) {
    condCel = getInnerCelPath(condition);
  } else if (isCelExpression(condition)) {
    condCel = condition.expression;
  } else if (typeof condition === 'boolean') {
    condCel = String(condition);
    logger.warn('Cel.cond called with a static boolean condition — the ternary is statically evaluable and KRO will always take one branch. This usually means a ref was expected instead of a literal.', {
      condition,
    });
  } else {
    condCel = String(condition);
  }

  const trueCel = celValueForTernary(trueValue);
  const falseCel = celValueForTernary(falseValue);

  const expression = `${condCel} ? ${trueCel} : ${falseCel}`;

  const result = {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    // Mark as a mixed template so processResourceReferences passes it
    // through as-is (does not re-wrap in ${...}).
    __isTemplate: true,
    // toString/Symbol.toPrimitive enable template literal composition:
    //   `redis://${Cel.cond(ref, 'a', 'b')}:6379`
    // produces a valid KRO mixed-template string.
    toString: () => `\${${expression}}`,
    [Symbol.toPrimitive]: () => `\${${expression}}`,
  };

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
): CelExpression<string> & string {
  let result = templateString;
  let valueIndex = 0;

  // Replace %s placeholders with ${...} CEL expressions
  result = result.replace(/%s/g, () => {
    if (valueIndex < values.length) {
      const value = values[valueIndex++];
      if (isKubernetesRef(value)) {
        // For KubernetesRef, create a ${...} placeholder
        return `\${${getInnerCelPath(value)}}`;
      }
      if (isCelExpression(value)) {
        // For CEL expressions, wrap in ${...}
        return `\${${value.expression}}`;
      }
      // For literal values, escape any ${...} sequences that could be
      // misinterpreted as CEL expression placeholders during serialization.
      // Defense-in-depth: user-supplied strings may contain "${" (e.g. shell
      // script snippets). Escaping here prevents the serializer from treating
      // them as CEL injection points. This is intentionally kept even if no
      // caller currently passes such strings.
      return String(value).replace(/\$\{/g, '\\${');
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
function concat(...parts: RefOrValue<CelValue>[]): CelExpression<string> & string {
  const celParts = parts.map((part) => {
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
    _type: 'string' as T,
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
 * greeting: Cel.tag`Hello ${schema.spec.name}`
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
  cond,
  math,
  template,
  concat,
  has,
  not,
  /** Tagged template literal for CEL expressions. Alias: standalone `cel` export. */
  tag: cel,

  // Typed convenience methods — pre-bound type parameters for Cel.expr
  /** Create a boolean CEL expression. Shorthand for Cel.expr<boolean>(...). */
  boolean: (...parts: RefOrValue<unknown>[]): CelExpression<boolean> & boolean =>
    expr<boolean>(...parts),

  /** Create a string CEL expression. Shorthand for Cel.expr<string>(...). */
  str: (...parts: RefOrValue<unknown>[]): CelExpression<string> & string => expr<string>(...parts),

  /** Create a number CEL expression. Shorthand for Cel.expr<number>(...). */
  number: (...parts: RefOrValue<unknown>[]): CelExpression<number> & number =>
    expr<number>(...parts),

  // Common CEL functions as utilities

  /** CEL `min()` — returns the smallest of the given values. */
  min: (...values: RefOrValue<CelValue>[]) => math<number>('min', ...values),

  /** CEL `max()` — returns the largest of the given values. */
  max: (...values: RefOrValue<CelValue>[]) => math<number>('max', ...values),

  /** CEL `size()` — returns the length of a list, map, or string. */
  size: (collection: RefOrValue<CelValue>) => math<number>('size', collection),

  /** CEL `string()` — converts a value to its string representation. */
  string: (value: RefOrValue<CelValue>) =>
    math<string>('string', value) as CelExpression<string> & string,

  /** CEL `int()` — converts a value to an integer. */
  int: (value: RefOrValue<CelValue>) => math<number>('int', value),

  /** CEL `double()` — converts a value to a floating-point number. */
  double: (value: RefOrValue<CelValue>) => math<number>('double', value),
};

// Export cel as a standalone function for template literal usage
export { cel };
