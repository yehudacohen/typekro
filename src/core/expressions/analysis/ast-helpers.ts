/**
 * AST path extraction, property helpers, and small utility converters.
 *
 * All functions are pure (stateless) – extracted from JavaScriptToCelAnalyzer.
 */

import type {
  ArrowFunctionExpression as ESTreeArrowFunction,
  Expression as ESTreeExpression,
  MemberExpression as ESTreeMemberExpression,
  Node as ESTreeNode,
  SimpleLiteral as ESTreeSimpleLiteral,
  SpreadElement as ESTreeSpreadElement,
} from 'estree';

import { CEL_EXPRESSION_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import type { CelExpression } from '../../types/common.js';
import type { AnalysisContext, ConvertNodeFn } from './shared-types.js';

/**
 * Recursively extract a dot-separated member path from an AST node.
 * Returns strings like `"deployment.status.replicas"` or `"obj?.[0]"`.
 */
export function extractMemberPath(node: ESTreeNode): string {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'MemberExpression') {
    const object = extractMemberPath(node.object);

    if (node.computed) {
      const property = getSourceText(node.property);
      const optionalMarker = node.optional ? '?.' : '';
      return `${object}${optionalMarker}[${property}]`;
    }
    const property = getPropertyName(node.property);
    const optionalMarker = node.optional ? '?.' : '.';
    return `${object}${optionalMarker}${property}`;
  }

  if (node.type === 'ChainExpression') {
    return extractMemberPath(node.expression);
  }

  throw new ConversionError(
    `Cannot extract path from node type: ${node.type}`,
    String(node.type),
    'member-access'
  );
}

/**
 * Check whether a node represents a complex expression that cannot be
 * handled as a simple path (e.g. contains a call expression somewhere).
 */
export function isComplexExpression(node: ESTreeNode): boolean {
  if (node.type === 'CallExpression') return true;
  if (node.type === 'MemberExpression') return isComplexExpression(node.object);
  return false;
}

/** Get simple source text from a literal AST node (fallback for computed access). */
export function getSourceText(node: ESTreeNode): string {
  if (node.type === 'Literal') return String(node.value);
  return '<expression>';
}

/**
 * Get the property name from an AST node that appears as a MemberExpression
 * property – handles `Identifier`, `PrivateIdentifier`, and string `Literal`.
 */
export function getPropertyName(prop: ESTreeExpression | { type: string; name: string }): string {
  if ('name' in prop && (prop.type === 'Identifier' || prop.type === 'PrivateIdentifier')) {
    return prop.name;
  }
  if (prop.type === 'Literal' && 'value' in prop) {
    return String((prop as ESTreeSimpleLiteral).value);
  }
  return '<unknown>';
}

/**
 * Extract the parameter name and arrow function body from an ESTree argument
 * that is expected to be an `ArrowFunctionExpression`.
 */
export function extractArrowPredicate(arg: ESTreeExpression | ESTreeSpreadElement): {
  param: string;
  arrow: ESTreeArrowFunction;
} {
  if (arg.type !== 'ArrowFunctionExpression') {
    throw new ConversionError(
      'Expected arrow function predicate',
      String(arg.type),
      'function-call'
    );
  }
  const firstParam = arg.params[0];
  const paramName = firstParam && firstParam.type === 'Identifier' ? firstParam.name : '_item';
  return { param: paramName, arrow: arg };
}

/**
 * Safely retrieve an argument at a specific index, throwing if missing.
 */
export function getArg(
  args: readonly (ESTreeExpression | ESTreeSpreadElement)[],
  index: number
): ESTreeExpression | ESTreeSpreadElement {
  const arg = args[index];
  if (!arg) {
    throw new ConversionError(`Expected argument at index ${index}`, '', 'function-call');
  }
  return arg;
}

/**
 * Convert computed array access: `array[index]`.
 */
export function convertArrayAccess(
  node: ESTreeMemberExpression,
  context: AnalysisContext,
  convertNode: ConvertNodeFn
): CelExpression {
  const object = convertNode(node.object, context);
  const property = convertNode(node.property, context);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `${object.expression}[${property.expression}]`,
    _type: undefined,
  } as CelExpression;
}

/**
 * Convert `.length` when accessed as a call-like reference → `size(obj)`.
 */
export function convertLengthProperty(
  object: CelExpression,
  _context: AnalysisContext
): CelExpression {
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: `size(${object.expression})`,
    _type: undefined,
  } as CelExpression;
}
