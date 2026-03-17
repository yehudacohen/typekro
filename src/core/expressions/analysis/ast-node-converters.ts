/**
 * AST node converters for primitive node types: Literal, Identifier,
 * UnaryExpression, ArrayExpression, and TemplateLiteral.
 *
 * Extracted from JavaScriptToCelAnalyzer. All functions are stateless.
 */

import type {
  ArrayExpression as ESTreeArrayExpression,
  Identifier as ESTreeIdentifier,
  Literal as ESTreeLiteral,
  TemplateLiteral as ESTreeTemplateLiteral,
  UnaryExpression as ESTreeUnaryExpression,
} from 'estree';

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import type { CelExpression } from '../../types/common.js';
import type { AnalysisContext, ConvertNodeFn } from './shared-types.js';

// ── Literal ────────────────────────────────────────────────────────

export function convertLiteral(node: ESTreeLiteral, _context: AnalysisContext): CelExpression {
  let literalValue: string;

  if (typeof node.value === 'string') {
    literalValue = `"${node.value.replace(/"/g, '\\"')}"`;
  } else if (typeof node.value === 'number') {
    literalValue = String(node.value);
  } else if (typeof node.value === 'boolean') {
    literalValue = String(node.value);
  } else if (node.value === null) {
    literalValue = 'null';
  } else if (node.value === undefined) {
    literalValue = 'null';
  } else {
    literalValue = `"${String(node.value).replace(/"/g, '\\"')}"`;
  }

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: literalValue,
    _type: typeof node.value,
  } as CelExpression;
}

// ── Identifier ─────────────────────────────────────────────────────

export function convertIdentifier(node: ESTreeIdentifier, context: AnalysisContext): CelExpression {
  const name = node.name;

  if (context.availableReferences?.[name]) {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: `resources.${name}`,
      _type: undefined,
    } as CelExpression;
  }

  if (name === 'schema') {
    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression: 'schema',
      _type: undefined,
    } as CelExpression;
  }

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: name,
    _type: undefined,
  } as CelExpression;
}

// ── Unary expression (!x, +x, -x, typeof x) ───────────────────────

export function convertUnaryExpression(
  node: ESTreeUnaryExpression,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  const operand = convertNode(node.argument, context);

  switch (node.operator) {
    case '!':
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `!${operand.expression}`,
        _type: 'boolean',
      } as CelExpression;
    case '+':
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `double(${operand.expression})`,
        _type: 'number',
      } as CelExpression;
    case '-':
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `-${operand.expression}`,
        _type: 'number',
      } as CelExpression;
    case 'typeof':
      return {
        [CEL_EXPRESSION_BRAND]: true,
        expression: `type(${operand.expression})`,
        _type: 'string',
      } as CelExpression;
    default:
      throw new ConversionError(
        `Unsupported unary operator: ${node.operator}`,
        String(node.operator),
        'javascript'
      );
  }
}

// ── Array expression [a, b, c] ─────────────────────────────────────

export function convertArrayExpression(
  node: ESTreeArrayExpression,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  const elements = node.elements.map((element) => {
    if (element === null) return 'null';
    return convertNode(element, context).expression;
  });

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `[${elements.join(', ')}]`,
    _type: undefined,
  } as CelExpression;
}

// ── Template literal `...${expr}...` ───────────────────────────────

export function convertTemplateLiteral(
  node: ESTreeTemplateLiteral,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  let result = '';

  for (let i = 0; i < node.quasis.length; i++) {
    const quasi = node.quasis[i];
    const literalPart = quasi?.value.cooked ?? '';
    result += literalPart;

    const exprNode = node.expressions[i];
    if (i < node.expressions.length && exprNode) {
      const expr = convertNode(exprNode, context);
      result += `\${${expr.expression}}`;
    }
  }

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: result,
    _type: 'string',
  } as CelExpression;
}
