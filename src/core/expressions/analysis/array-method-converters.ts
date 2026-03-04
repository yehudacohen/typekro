/**
 * JavaScript array method → CEL expression converters.
 *
 * Each function converts a specific JS array method call to its CEL equivalent.
 * All functions are stateless – they receive a `convertNode` callback for recursion.
 */

import type { Expression as ESTreeExpression, SpreadElement as ESTreeSpreadElement } from 'estree';

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';
import type { CelExpression } from '../../types/common.js';
import { extractArrowPredicate, getArg, getPropertyName } from './ast-helpers.js';
import { convertBinaryOperator } from './operator-utils.js';
import type { AnalysisContext, ConvertNodeFn } from './shared-types.js';

type Args = readonly (ESTreeExpression | ESTreeSpreadElement)[];

// ── find → filter()[0] ─────────────────────────────────────────────

export function convertArrayFind(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.find() requires exactly one argument',
      'Array.find()',
      'function-call'
    );
  }

  const arg = getArg(args, 0);
  if (arg.type === 'ArrowFunctionExpression' && arg.body.type === 'BinaryExpression') {
    const { param } = extractArrowPredicate(arg);
    const binaryExpr = arg.body;

    let leftExpr: string;
    if (
      binaryExpr.left.type === 'MemberExpression' &&
      binaryExpr.left.object.type === 'Identifier' &&
      binaryExpr.left.object.name === param
    ) {
      leftExpr = `${param}.${getPropertyName(binaryExpr.left.property)}`;
    } else {
      try {
        const leftResult = convertNode(binaryExpr.left, context);
        leftExpr = leftResult.expression.replace(new RegExp(`\\b${param}\\b`, 'g'), param);
      } catch (error: unknown) {
        const logger = getComponentLogger('expression-analyzer');
        logger.debug('Failed to convert left side of filter binary expression', { err: error });
        leftExpr = `${param}.property`;
      }
    }

    let rightExpr: string;
    try {
      const rightResult = convertNode(binaryExpr.right, context);
      rightExpr = rightResult.expression;
    } catch (error: unknown) {
      const logger = getComponentLogger('expression-analyzer');
      logger.debug('Failed to convert right side of filter binary expression', { err: error });
      rightExpr = 'value';
    }

    const operator = convertBinaryOperator(binaryExpr.operator);
    const expression = `${object.expression}.filter(${param}, ${leftExpr} ${operator} ${rightExpr})[0]`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  throw new ConversionError(
    'Complex Array.find() predicates cannot be automatically converted to CEL. Only simple binary comparisons (e.g., c => c.type === "Available") are supported.',
    `${object.expression}.find(...)`,
    'function-call',
    undefined,
    undefined,
    [
      'Simplify the predicate to a binary comparison like: c => c.field === "value"',
      'Use Cel.expr() to write the CEL filter expression directly',
      'Example CEL: Cel.expr(array, \'.filter(x, x.field == "value")[0]\')',
    ]
  );
}

// ── filter ─────────────────────────────────────────────────────────

export function convertArrayFilter(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.filter() requires exactly one argument',
      'Array.filter()',
      'function-call'
    );
  }

  const arg = getArg(args, 0);
  if (arg.type === 'ArrowFunctionExpression') {
    const { param, arrow } = extractArrowPredicate(arg);

    if (arrow.body.type === 'MemberExpression') {
      const property = getPropertyName(arrow.body.property);
      const expression = `${object.expression}.filter(${param}, has(${param}.${property}) && ${param}.${property} != null)`;
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }
    if (arrow.body.type === 'BinaryExpression') {
      const left = convertNode(arrow.body.left, context);
      const operator = convertBinaryOperator(arrow.body.operator);
      const right = convertNode(arrow.body.right, context);
      const leftExpr = left.expression.replace(new RegExp(`\\b${param}\\b`, 'g'), param);
      const expression = `${object.expression}.filter(${param}, ${leftExpr} ${operator} ${right.expression})`;
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression,
        _type: undefined,
      } as CelExpression;
    }
  }

  throw new ConversionError(
    'Complex Array.filter() predicates cannot be automatically converted to CEL. Only simple property access (e.g., i => i.ip) and binary comparisons (e.g., i => i.type === "Available") are supported.',
    `${object.expression}.filter(...)`,
    'function-call',
    undefined,
    undefined,
    [
      'Simplify the predicate to a property access or binary comparison',
      'Use Cel.expr() to write the CEL filter expression directly',
      'Example CEL: Cel.expr(array, \'.filter(x, x.field == "value")\')',
    ]
  );
}

// ── map ────────────────────────────────────────────────────────────

export function convertArrayMap(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.map() requires exactly one argument',
      'Array.map()',
      'function-call'
    );
  }

  const arg = getArg(args, 0);
  if (arg.type === 'ArrowFunctionExpression') {
    const { param, arrow } = extractArrowPredicate(arg);
    if (arrow.body.type !== 'MemberExpression') {
      throw new ConversionError(
        'Complex Array.map() predicates cannot be automatically converted to CEL.',
        `${object.expression}.map(...)`,
        'function-call'
      );
    }
    const property = getPropertyName(arrow.body.property);
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${object.expression}.map(${param}, ${param}.${property})`,
      _type: undefined,
    } as CelExpression;
  }

  throw new ConversionError(
    'Complex Array.map() predicates cannot be automatically converted to CEL. Only simple property access (e.g., c => c.name) is supported.',
    `${object.expression}.map(...)`,
    'function-call',
    undefined,
    undefined,
    [
      'Simplify the predicate to a property access like: c => c.name',
      'Use Cel.expr() to write the CEL map expression directly',
      "Example CEL: Cel.expr(array, '.map(x, x.field)')",
    ]
  );
}

// ── some (always throws — not yet supported) ───────────────────────

export function convertArraySome(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.some() requires exactly one argument',
      'Array.some()',
      'function-call'
    );
  }
  throw new ConversionError(
    'Array.some() predicates cannot be automatically converted to CEL. Lambda support for CEL .exists() macro is not yet implemented.',
    `${object.expression}.some(...)`,
    'function-call',
    undefined,
    undefined,
    [
      'Use Cel.expr() to write the CEL exists expression directly',
      'Example CEL: Cel.expr(array, \'.exists(x, x.field == "value")\')',
      'For simple existence checks, consider using .size() > 0',
    ]
  );
}

// ── every (always throws — not yet supported) ──────────────────────

export function convertArrayEvery(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.every() requires exactly one argument',
      'Array.every()',
      'function-call'
    );
  }
  throw new ConversionError(
    'Array.every() predicates cannot be automatically converted to CEL. Lambda support for CEL .all() macro is not yet implemented.',
    `${object.expression}.every(...)`,
    'function-call',
    undefined,
    undefined,
    [
      'Use Cel.expr() to write the CEL all expression directly',
      'Example CEL: Cel.expr(array, \'.all(x, x.field == "value")\')',
      'For checking all elements match, consider alternative CEL patterns',
    ]
  );
}

// ── join ───────────────────────────────────────────────────────────

export function convertArrayJoin(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.join() requires exactly one argument',
      'Array.join()',
      'function-call'
    );
  }
  const separator = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.join(${separator.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── flatMap → map().flatten() ──────────────────────────────────────

export function convertArrayFlatMap(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'Array.flatMap() requires exactly one argument',
      'Array.flatMap()',
      'function-call'
    );
  }

  const arg = getArg(args, 0);
  if (arg.type === 'ArrowFunctionExpression') {
    const { param, arrow } = extractArrowPredicate(arg);
    if (arrow.body.type === 'MemberExpression') {
      const property = getPropertyName(arrow.body.property);
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `${object.expression}.map(${param}, ${param}.${property}).flatten()`,
        _type: undefined,
      } as CelExpression;
    }
  }

  throw new ConversionError('Unsupported flatMap expression', 'Array.flatMap()', 'function-call');
}
