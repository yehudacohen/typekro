/**
 * Call expression dispatcher and global / Math function converters.
 *
 * Extracted from JavaScriptToCelAnalyzer. All functions are stateless.
 */

import type {
  CallExpression as ESTreeCallExpression,
  Expression as ESTreeExpression,
  SpreadElement as ESTreeSpreadElement,
} from 'estree';

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import type { CelExpression } from '../../types/common.js';
import {
  convertArrayEvery,
  convertArrayFilter,
  convertArrayFind,
  convertArrayFlatMap,
  convertArrayJoin,
  convertArrayMap,
  convertArraySome,
} from './array-method-converters.js';
import { convertLengthProperty } from './ast-helpers.js';
import type { AnalysisContext, ConvertNodeFn } from './shared-types.js';
import {
  convertStringEndsWith,
  convertStringIncludes,
  convertStringIndexOf,
  convertStringLastIndexOf,
  convertStringPadEnd,
  convertStringPadStart,
  convertStringRepeat,
  convertStringReplace,
  convertStringSlice,
  convertStringSplit,
  convertStringStartsWith,
  convertStringSubstring,
  convertStringToLowerCase,
  convertStringToUpperCase,
  convertStringTrim,
} from './string-method-converters.js';

type Args = readonly (ESTreeExpression | ESTreeSpreadElement)[];

// ── Global functions (Number, String, Boolean, parseInt, parseFloat) ───

export function convertGlobalFunction(
  functionName: string,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  const convertedArgs = args.map((arg) => convertNode(arg, context));

  switch (functionName) {
    case 'Number':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `double(${convertedArgs[0]?.expression || 'null'})`,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'String':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `string(${convertedArgs[0]?.expression || 'null'})`,
          _type: 'string',
        } as CelExpression;
      }
      break;
    case 'Boolean':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `bool(${convertedArgs[0]?.expression || 'null'})`,
          _type: 'boolean',
        } as CelExpression;
      }
      break;
    case 'parseInt':
      if (args.length >= 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `int(${convertedArgs[0]?.expression || 'null'})`,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'parseFloat':
      if (args.length >= 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `double(${convertedArgs[0]?.expression || 'null'})`,
          _type: 'number',
        } as CelExpression;
      }
      break;
  }

  throw new ConversionError(
    `Unsupported global function: ${functionName}`,
    functionName,
    'function-call'
  );
}

// ── Math functions ─────────────────────────────────────────────────

export function convertMathFunction(
  mathMethod: string,
  args: Args,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  const convertedArgs = args.map((arg) => convertNode(arg, context));

  switch (mathMethod) {
    case 'min':
      if (args.length >= 2) {
        if (args.length === 2) {
          return {
            [CEL_EXPRESSION_BRAND]: true,
            expression: `${convertedArgs[0]?.expression || 'null'} < ${convertedArgs[1]?.expression || 'null'} ? ${convertedArgs[0]?.expression || 'null'} : ${convertedArgs[1]?.expression || 'null'}`,
            _type: 'number',
          } as CelExpression;
        }
        let expression = convertedArgs[0]?.expression || 'null';
        for (let i = 1; i < convertedArgs.length; i++) {
          expression = `${expression} < ${convertedArgs[i]?.expression || 'null'} ? ${expression} : ${convertedArgs[i]?.expression || 'null'}`;
        }
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'max':
      if (args.length >= 2) {
        if (args.length === 2) {
          return {
            [CEL_EXPRESSION_BRAND]: true,
            expression: `${convertedArgs[0]?.expression || 'null'} > ${convertedArgs[1]?.expression || 'null'} ? ${convertedArgs[0]?.expression || 'null'} : ${convertedArgs[1]?.expression || 'null'}`,
            _type: 'number',
          } as CelExpression;
        }
        let expression = convertedArgs[0]?.expression || 'null';
        for (let i = 1; i < convertedArgs.length; i++) {
          expression = `${expression} > ${convertedArgs[i]?.expression || 'null'} ? ${expression} : ${convertedArgs[i]?.expression || 'null'}`;
        }
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'abs':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `${convertedArgs[0]?.expression || 'null'} < 0 ? -${convertedArgs[0]?.expression || 'null'} : ${convertedArgs[0]?.expression || 'null'}`,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'floor':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `int(${convertedArgs[0]?.expression || 'null'})`,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'ceil':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `int(${convertedArgs[0]?.expression || 'null'} + 0.999999)`,
          _type: 'number',
        } as CelExpression;
      }
      break;
    case 'round':
      if (args.length === 1) {
        return {
          [CEL_EXPRESSION_BRAND]: true,
          expression: `int(${convertedArgs[0]?.expression || 'null'} + 0.5)`,
          _type: 'number',
        } as CelExpression;
      }
      break;
  }

  throw new ConversionError(
    `Unsupported Math function: ${mathMethod}`,
    `Math.${mathMethod}`,
    'function-call'
  );
}

// ── Call expression dispatcher ─────────────────────────────────────

/**
 * Route a `CallExpression` AST node to the appropriate converter.
 * Handles: global functions, `Math.*`, and method calls on objects.
 */
export function convertCallExpression(
  node: ESTreeCallExpression,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  // Handle global functions
  if (node.callee.type === 'Identifier') {
    return convertGlobalFunction(node.callee.name, node.arguments, context, convertNode);
  }

  // Handle Math.* functions
  if (
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Math' &&
    node.callee.property.type === 'Identifier'
  ) {
    return convertMathFunction(node.callee.property.name, node.arguments, context, convertNode);
  }

  // Handle common JavaScript methods that can be converted to CEL
  if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
    const object = convertNode(node.callee.object, context);
    const methodName = node.callee.property.name;

    switch (methodName) {
      case 'find':
        return convertArrayFind(object, node.arguments, context, convertNode);
      case 'filter':
        return convertArrayFilter(object, node.arguments, context, convertNode);
      case 'map':
        return convertArrayMap(object, node.arguments, context);
      case 'includes':
        return convertStringIncludes(object, node.arguments, context, convertNode);
      case 'some':
        return convertArraySome(object, node.arguments, context);
      case 'every':
        return convertArrayEvery(object, node.arguments, context);
      case 'startsWith':
        return convertStringStartsWith(object, node.arguments, context, convertNode);
      case 'endsWith':
        return convertStringEndsWith(object, node.arguments, context, convertNode);
      case 'toLowerCase':
        return convertStringToLowerCase(object, node.arguments, context);
      case 'toUpperCase':
        return convertStringToUpperCase(object, node.arguments, context);
      case 'trim':
        return convertStringTrim(object, node.arguments, context);
      case 'substring':
        return convertStringSubstring(object, node.arguments, context, convertNode);
      case 'slice':
        return convertStringSlice(object, node.arguments, context, convertNode);
      case 'split':
        return convertStringSplit(object, node.arguments, context, convertNode);
      case 'join':
        return convertArrayJoin(object, node.arguments, context, convertNode);
      case 'flatMap':
        return convertArrayFlatMap(object, node.arguments, context);
      case 'length':
        return convertLengthProperty(object, context);
      case 'padStart':
        return convertStringPadStart(object, node.arguments, context, convertNode);
      case 'padEnd':
        return convertStringPadEnd(object, node.arguments, context, convertNode);
      case 'repeat':
        return convertStringRepeat(object, node.arguments, context, convertNode);
      case 'replace':
        return convertStringReplace(object, node.arguments, context, convertNode);
      case 'indexOf':
        return convertStringIndexOf(object, node.arguments, context, convertNode);
      case 'lastIndexOf':
        return convertStringLastIndexOf(object, node.arguments, context, convertNode);
      default:
        throw new ConversionError(
          `Unsupported method call: ${methodName}`,
          methodName,
          'function-call'
        );
    }
  }

  throw new ConversionError('Unsupported call expression', 'call expression', 'function-call');
}
