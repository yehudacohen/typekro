/**
 * Status AST Utilities — Parsing, source extraction, and pattern detection
 *
 * Extracted from status-builder-analyzer.ts. Contains AST-related operations:
 * - Parsing status builder functions
 * - Extracting source text from AST nodes
 * - Analyzing return statements and object properties
 * - Detecting logical operator patterns
 */

import * as acorn from 'acorn';
import * as estraverse from 'estraverse';
import type { Node as ESTreeNode, ObjectExpression, ReturnStatement } from 'estree';
import { ConversionError, ensureError } from '../../errors.js';
import { getIdentifierName } from '../analysis/ast-type-guards.js';
import type { PropertyAnalysis, ReturnStatementAnalysis } from './status-builder-types.js';

// ── Parsing ──────────────────────────────────────────────────────────

/**
 * Parse status builder function to AST
 */
export function parseStatusBuilderFunction(source: string): ESTreeNode {
  try {
    // Parse the function source with modern JavaScript support using acorn
    const ast = acorn.parse(source, {
      ecmaVersion: 2022, // Support modern JavaScript features including optional chaining
      sourceType: 'script',
      locations: true,
      ranges: true,
    });

    return ast as ESTreeNode;
  } catch (error: unknown) {
    throw new ConversionError(
      `Failed to parse status builder function: ${ensureError(error).message}`,
      source,
      'javascript'
    );
  }
}

// ── Return statement analysis ────────────────────────────────────────

/**
 * Analyze the return statement of the status builder
 */
export function analyzeReturnStatement(
  ast: ESTreeNode,
  originalSource: string
): ReturnStatementAnalysis | null {
  let foundReturnStatement: ReturnStatement | null = null;
  let foundArrowFunction: ESTreeNode | null = null;

  // Find the return statement or arrow function with implicit return
  estraverse.traverse(ast, {
    enter: (node) => {
      if (node.type === 'ReturnStatement') {
        foundReturnStatement = node as ReturnStatement;
        return estraverse.VisitorOption.Break;
      }
      if (node.type === 'ArrowFunctionExpression' && node.body?.type === 'ObjectExpression') {
        foundArrowFunction = node;
        return estraverse.VisitorOption.Break;
      }
      return undefined;
    },
  });

  // Handle explicit return statement
  if (foundReturnStatement) {
    const returnStatement = foundReturnStatement as ReturnStatement;

    // Check if it returns an object expression
    const returnsObject = returnStatement.argument?.type === 'ObjectExpression';

    if (!returnsObject) {
      return {
        node: returnStatement,
        returnsObject: false,
        properties: [],
        sourceLocation: {
          line: returnStatement.loc?.start.line || 0,
          column: returnStatement.loc?.start.column || 0,
          length: 0,
        },
      };
    }

    // Analyze properties in the object expression
    const objectExpression = returnStatement.argument as ObjectExpression;
    const properties = analyzeObjectProperties(objectExpression, originalSource);

    return {
      node: returnStatement,
      returnsObject: true,
      properties,
      sourceLocation: {
        line: returnStatement.loc?.start.line || 0,
        column: returnStatement.loc?.start.column || 0,
        length: returnStatement.range ? returnStatement.range[1] - returnStatement.range[0] : 0,
      },
    };
  }

  // Handle arrow function with implicit return
  const arrowFn = foundArrowFunction as (ESTreeNode & { body?: ESTreeNode }) | null;
  if (arrowFn && arrowFn.body?.type === 'ObjectExpression') {
    const objectExpression = arrowFn.body as ObjectExpression;
    const properties = analyzeObjectProperties(objectExpression, originalSource);

    return {
      // Arrow function implicit return is represented as a ReturnStatement equivalent
      node: arrowFn as unknown as ReturnStatement,
      returnsObject: true,
      properties,
      sourceLocation: {
        line: objectExpression.loc?.start.line || 0,
        column: objectExpression.loc?.start.column || 0,
        length: objectExpression.range ? objectExpression.range[1] - objectExpression.range[0] : 0,
      },
    };
  }

  return null;
}

// ── Object property analysis ─────────────────────────────────────────

/**
 * Analyze properties in an object expression
 */
export function analyzeObjectProperties(
  objectExpression: ObjectExpression,
  originalSource: string
): PropertyAnalysis[] {
  const properties: PropertyAnalysis[] = [];

  for (const prop of objectExpression.properties) {
    if (prop.type === 'Property' && prop.key.type === 'Identifier') {
      const propertyAnalysis: PropertyAnalysis = {
        name: prop.key.name,
        valueNode: prop.value,
        valueSource: getNodeSource(prop.value, originalSource),
        containsKubernetesRefs: false, // Will be determined during field analysis
        sourceLocation: {
          line: prop.loc?.start.line || 0,
          column: prop.loc?.start.column || 0,
          length: prop.range ? prop.range[1] - prop.range[0] : 0,
        },
      };

      properties.push(propertyAnalysis);
    }
  }

  return properties;
}

// ── Source text extraction ────────────────────────────────────────────

/**
 * Extract source code for an AST node using range information
 */
export function getNodeSource(node: ESTreeNode, originalSource: string): string {
  if (!node || !node.type) {
    return '';
  }

  // Acorn nodes have start/end properties not in ESTree types
  const acornNode = node as ESTreeNode & {
    start?: number;
    end?: number;
    range?: [number, number];
  };

  // Try to use range information to extract the actual source
  let start: number | undefined;
  let end: number | undefined;

  // Check for start/end properties (acorn format)
  if (typeof acornNode.start === 'number' && typeof acornNode.end === 'number') {
    start = acornNode.start;
    end = acornNode.end;
  }
  // Check for range array (alternative format)
  else if (Array.isArray(acornNode.range) && acornNode.range.length === 2) {
    start = acornNode.range[0];
    end = acornNode.range[1];
  }

  // If we have valid range information, extract the source
  if (
    typeof start === 'number' &&
    typeof end === 'number' &&
    start >= 0 &&
    end <= originalSource.length &&
    start <= end
  ) {
    const extracted = originalSource.slice(start, end).trim();

    if (extracted.length > 0) {
      return extracted;
    }
  }

  // Fallback to manual reconstruction for specific node types
  const n = node as ESTreeNode & Record<string, unknown>;
  switch (node.type) {
    case 'Literal':
      return typeof n.value === 'string' ? `"${n.value}"` : String(n.value);
    case 'Identifier':
      return getIdentifierName(n);
    case 'BinaryExpression': {
      const left = getNodeSource(n.left as ESTreeNode, originalSource);
      const right = getNodeSource(n.right as ESTreeNode, originalSource);
      return `${left} ${n.operator} ${right}`;
    }
    case 'MemberExpression': {
      const object = getNodeSource(n.object as ESTreeNode, originalSource);
      if (n.computed) {
        return `${object}[${getNodeSource(n.property as ESTreeNode, originalSource)}]`;
      }
      const propertyName =
        getIdentifierName(n.property as ESTreeNode) ||
        getNodeSource(n.property as ESTreeNode, originalSource);
      return `${object}.${propertyName}`;
    }
    case 'ConditionalExpression':
      return `${getNodeSource(n.test as ESTreeNode, originalSource)} ? ${getNodeSource(n.consequent as ESTreeNode, originalSource)} : ${getNodeSource(n.alternate as ESTreeNode, originalSource)}`;
    case 'LogicalExpression':
      return `${getNodeSource(n.left as ESTreeNode, originalSource)} ${n.operator} ${getNodeSource(n.right as ESTreeNode, originalSource)}`;
    case 'CallExpression': {
      const callee = getNodeSource(n.callee as ESTreeNode, originalSource);
      const args = (n.arguments as ESTreeNode[])
        .map((arg: ESTreeNode) => getNodeSource(arg, originalSource))
        .join(', ');
      return `${callee}(${args})`;
    }
    case 'ArrowFunctionExpression': {
      const params = (n.params as ESTreeNode[])
        .map((param: ESTreeNode) => getIdentifierName(param))
        .join(', ');
      const body = getNodeSource(n.body as ESTreeNode, originalSource);
      return `(${params}) => ${body}`;
    }
    case 'TemplateLiteral': {
      // Simplified template literal reconstruction
      let result = '`';
      const quasis = (n.quasis as Array<{ value?: { raw?: string; cooked?: string } }>) || [];
      const expressions = (n.expressions as ESTreeNode[]) || [];
      for (let i = 0; i < quasis.length; i++) {
        const quasi = quasis[i];
        result += quasi?.value?.raw || quasi?.value?.cooked || '';
        const expr = expressions[i];
        if (expr && i < expressions.length) {
          result += `\${${getNodeSource(expr, originalSource)}}`;
        }
      }
      result += '`';
      return result;
    }
    default:
      // Fallback - return a placeholder
      return `<${node.type}>`;
  }
}

// ── Pattern detection ────────────────────────────────────────────────

/**
 * Detect logical operators (||, &&) in an AST node that involve member expressions.
 */
export function detectLogicalOperatorWarnings(node: ESTreeNode, fieldName: string): string[] {
  const warnings: string[] = [];

  const walk = (n: ESTreeNode): void => {
    if (!n || typeof n !== 'object') return;

    if (n.type === 'LogicalExpression' && (n.operator === '||' || n.operator === '&&')) {
      const leftNode = (n as ESTreeNode & { left: ESTreeNode }).left;
      const rightNode = (n as ESTreeNode & { right: ESTreeNode }).right;

      // Check if either side involves a member expression (property access chain)
      const leftHasMember = containsMemberExpression(leftNode);
      const rightHasMember = containsMemberExpression(rightNode);

      if (leftHasMember || rightHasMember) {
        const operator = n.operator as string;
        const leftSrc = getNodeSource(leftNode, '');
        const rightSrc = getNodeSource(rightNode, '');
        const exprSrc = leftSrc && rightSrc ? `${leftSrc} ${operator} ${rightSrc}` : '';

        if (operator === '||') {
          warnings.push(
            `Status field '${fieldName}' uses '||' operator${exprSrc ? ` (${exprSrc})` : ''}. ` +
              `KubernetesRef proxies are always truthy, so the right-hand side is never reached. ` +
              `Use Cel.expr() for fallback logic, e.g.: Cel.expr<Type>(ref, ' != "" ? ', ref, ' : "default"')`
          );
        } else {
          warnings.push(
            `Status field '${fieldName}' uses '&&' operator${exprSrc ? ` (${exprSrc})` : ''}. ` +
              `KubernetesRef proxies are always truthy, so '&&' silently returns only the right-hand operand. ` +
              `Use Cel.expr<boolean>() for logical AND, e.g.: Cel.expr<boolean>(refA, ' && ', refB)`
          );
        }
      }

      // Continue walking to find nested logical expressions
      walk(leftNode);
      walk(rightNode);
    } else if (n.type === 'ConditionalExpression') {
      const cond = n as ESTreeNode & {
        test: ESTreeNode;
        consequent: ESTreeNode;
        alternate: ESTreeNode;
      };
      walk(cond.test);
      walk(cond.consequent);
      walk(cond.alternate);
    } else if (n.type === 'BinaryExpression') {
      const bin = n as ESTreeNode & { left: ESTreeNode; right: ESTreeNode };
      walk(bin.left);
      walk(bin.right);
    } else if (n.type === 'UnaryExpression') {
      const unary = n as ESTreeNode & { argument: ESTreeNode };
      walk(unary.argument);
    } else if (n.type === 'CallExpression') {
      const call = n as ESTreeNode & { callee: ESTreeNode; arguments: ESTreeNode[] };
      walk(call.callee);
      for (const arg of call.arguments) {
        walk(arg);
      }
    } else if (n.type === 'TemplateLiteral') {
      const tpl = n as ESTreeNode & { expressions: ESTreeNode[] };
      for (const expr of tpl.expressions) {
        walk(expr);
      }
    }
  };

  walk(node);
  return warnings;
}

/**
 * Check if an AST node contains a MemberExpression (property access chain).
 */
export function containsMemberExpression(node: ESTreeNode): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'MemberExpression') return true;

  // Check child nodes for common expression types
  if (node.type === 'CallExpression') {
    const call = node as ESTreeNode & { callee: ESTreeNode; arguments: ESTreeNode[] };
    if (containsMemberExpression(call.callee)) return true;
    return call.arguments.some((arg) => containsMemberExpression(arg));
  }
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') {
    const bin = node as ESTreeNode & { left: ESTreeNode; right: ESTreeNode };
    return containsMemberExpression(bin.left) || containsMemberExpression(bin.right);
  }
  if (node.type === 'UnaryExpression') {
    const unary = node as ESTreeNode & { argument: ESTreeNode };
    return containsMemberExpression(unary.argument);
  }
  if (node.type === 'ConditionalExpression') {
    const cond = node as ESTreeNode & {
      test: ESTreeNode;
      consequent: ESTreeNode;
      alternate: ESTreeNode;
    };
    return (
      containsMemberExpression(cond.test) ||
      containsMemberExpression(cond.consequent) ||
      containsMemberExpression(cond.alternate)
    );
  }

  return false;
}
