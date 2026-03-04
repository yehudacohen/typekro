/**
 * JavaScript string method → CEL expression converters.
 *
 * Each function converts a specific JS string method call to its CEL equivalent.
 * All functions are stateless – they receive a `convertNode` callback for recursion.
 */

import type { Expression as ESTreeExpression, SpreadElement as ESTreeSpreadElement } from 'estree';

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import type { CelExpression } from '../../types/common.js';
import { getArg } from './ast-helpers.js';
import type { AnalysisContext, ConvertNodeFn } from './shared-types.js';

type Args = readonly (ESTreeExpression | ESTreeSpreadElement)[];

// ── includes → contains ────────────────────────────────────────────

export function convertStringIncludes(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.includes() requires exactly one argument',
      'String.includes()',
      'function-call'
    );
  }
  const searchValue = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.contains(${searchValue.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── startsWith ─────────────────────────────────────────────────────

export function convertStringStartsWith(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.startsWith() requires exactly one argument',
      'String.startsWith()',
      'function-call'
    );
  }
  const searchValue = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.startsWith(${searchValue.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── endsWith ───────────────────────────────────────────────────────

export function convertStringEndsWith(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.endsWith() requires exactly one argument',
      'String.endsWith()',
      'function-call'
    );
  }
  const searchValue = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.endsWith(${searchValue.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── toLowerCase → lowerAscii ───────────────────────────────────────

export function convertStringToLowerCase(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 0) {
    throw new ConversionError(
      'String.toLowerCase() requires no arguments',
      'String.toLowerCase()',
      'function-call'
    );
  }
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.lowerAscii()`,
    _type: undefined,
  } as CelExpression;
}

// ── toUpperCase → upperAscii ───────────────────────────────────────

export function convertStringToUpperCase(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 0) {
    throw new ConversionError(
      'String.toUpperCase() requires no arguments',
      'String.toUpperCase()',
      'function-call'
    );
  }
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.upperAscii()`,
    _type: undefined,
  } as CelExpression;
}

// ── trim (placeholder — CEL has no native trim) ────────────────────

export function convertStringTrim(
  object: CelExpression,
  args: Args,
  _context: AnalysisContext
): CelExpression {
  if (args.length !== 0) {
    throw new ConversionError(
      'String.trim() requires no arguments',
      'String.trim()',
      'function-call'
    );
  }
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.trim()`,
    _type: undefined,
  } as CelExpression;
}

// ── substring ──────────────────────────────────────────────────────

export function convertStringSubstring(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length < 1 || args.length > 2) {
    throw new ConversionError(
      'String.substring() requires 1 or 2 arguments',
      'String.substring()',
      'function-call'
    );
  }
  const start = convertNode(getArg(args, 0), context);
  if (args.length === 1) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${object.expression}.substring(${start.expression})`,
      _type: undefined,
    } as CelExpression;
  }
  const end = convertNode(getArg(args, 1), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.substring(${start.expression}, ${end.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── slice → substring ──────────────────────────────────────────────

export function convertStringSlice(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length < 1 || args.length > 2) {
    throw new ConversionError(
      'String.slice() requires 1 or 2 arguments',
      'String.slice()',
      'function-call'
    );
  }
  const start = convertNode(getArg(args, 0), context);
  if (args.length === 1) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `${object.expression}.substring(${start.expression})`,
      _type: undefined,
    } as CelExpression;
  }
  const end = convertNode(getArg(args, 1), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.substring(${start.expression}, ${end.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── split ──────────────────────────────────────────────────────────

export function convertStringSplit(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.split() requires exactly one argument',
      'String.split()',
      'function-call'
    );
  }
  const separator = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.split(${separator.expression})`,
    _type: undefined,
  } as CelExpression;
}

// ── padStart (simulated) ───────────────────────────────────────────

export function convertStringPadStart(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length < 1 || args.length > 2) {
    throw new ConversionError(
      'String.padStart() requires 1 or 2 arguments',
      'String.padStart()',
      'function-call'
    );
  }
  const targetLength = convertNode(getArg(args, 0), context);
  const padString = args.length > 1 ? convertNode(getArg(args, 1), context) : { expression: '" "' };
  const expression = `size(${object.expression}) >= ${targetLength.expression} ? ${object.expression} : (${padString.expression}.repeat(${targetLength.expression} - size(${object.expression})) + ${object.expression})`;
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: 'string',
  } as CelExpression;
}

// ── padEnd (simulated) ─────────────────────────────────────────────

export function convertStringPadEnd(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length < 1 || args.length > 2) {
    throw new ConversionError(
      'String.padEnd() requires 1 or 2 arguments',
      'String.padEnd()',
      'function-call'
    );
  }
  const targetLength = convertNode(getArg(args, 0), context);
  const padString = args.length > 1 ? convertNode(getArg(args, 1), context) : { expression: '" "' };
  const expression = `size(${object.expression}) >= ${targetLength.expression} ? ${object.expression} : (${object.expression} + ${padString.expression}.repeat(${targetLength.expression} - size(${object.expression})))`;
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: 'string',
  } as CelExpression;
}

// ── repeat (placeholder — CEL has no native repeat) ────────────────

export function convertStringRepeat(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.repeat() requires exactly one argument',
      'String.repeat()',
      'function-call'
    );
  }
  const count = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.repeat(${count.expression})`,
    _type: 'string',
  } as CelExpression;
}

// ── replace ────────────────────────────────────────────────────────

export function convertStringReplace(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 2) {
    throw new ConversionError(
      'String.replace() requires exactly two arguments',
      'String.replace()',
      'function-call'
    );
  }
  const searchValue = convertNode(getArg(args, 0), context);
  const replaceValue = convertNode(getArg(args, 1), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.replace(${searchValue.expression}, ${replaceValue.expression})`,
    _type: 'string',
  } as CelExpression;
}

// ── indexOf (approximation: 0 or -1) ──────────────────────────────

export function convertStringIndexOf(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.indexOf() requires exactly one argument',
      'String.indexOf()',
      'function-call'
    );
  }
  const searchValue = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.contains(${searchValue.expression}) ? 0 : -1`,
    _type: 'number',
  } as CelExpression;
}

// ── lastIndexOf (approximation: size()-size(search) or -1) ─────────

export function convertStringLastIndexOf(
  object: CelExpression,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  if (args.length !== 1) {
    throw new ConversionError(
      'String.lastIndexOf() requires exactly one argument',
      'String.lastIndexOf()',
      'function-call'
    );
  }
  const searchValue = convertNode(getArg(args, 0), context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}.contains(${searchValue.expression}) ? size(${object.expression}) - size(${searchValue.expression}) : -1`,
    _type: 'number',
  } as CelExpression;
}
