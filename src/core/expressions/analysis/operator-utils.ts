/**
 * Operator mapping, precedence, and boolean-test utilities.
 *
 * All functions are pure (stateless) – extracted from JavaScriptToCelAnalyzer
 * to reduce the class to a slim orchestrator.
 */

import { ConversionError } from '../../errors.js';

// ── Operator mapping ───────────────────────────────────────────────

const JS_TO_CEL_OPERATOR: Record<string, string> = {
  '===': '==',
  '!==': '!=',
  '&&': '&&',
  '||': '||',
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
  '==': '==',
  '!=': '!=',
};

/** Map a JavaScript logical/comparison operator to its CEL equivalent. */
export function mapOperatorToCel(operator: string): string {
  return JS_TO_CEL_OPERATOR[operator] ?? operator;
}

const BINARY_OPERATOR_MAP: Record<string, string> = {
  '===': '==',
  '!==': '!=',
  '==': '==',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
};

/** Map a JavaScript binary operator (including arithmetic) to CEL. Throws for unsupported ops. */
export function convertBinaryOperator(operator: string): string {
  const celOperator = BINARY_OPERATOR_MAP[operator];
  if (!celOperator) {
    throw new ConversionError(
      `Unsupported binary operator: ${operator}`,
      String(operator),
      'binary-operation'
    );
  }
  return celOperator;
}

// ── Precedence ─────────────────────────────────────────────────────

const OPERATOR_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '??': 1,
  '?': 0,
};

/** Get numeric precedence for an operator (lower = binds less tightly). */
export function getOperatorPrecedence(operator: string): number {
  return OPERATOR_PRECEDENCE[operator] ?? 10;
}

/** Whether an operator is left-associative. Ternary (`?`) is the only right-associative one. */
export function isLeftAssociative(operator: string): boolean {
  return operator !== '?';
}

/**
 * Find the "main" (lowest-precedence) operator at depth-0 in an expression string.
 */
export function getMainOperator(expression: string): string | null {
  const operators = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%'];
  let depth = 0;
  let mainOp: string | null = null;
  let lowestPrec = Infinity;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (depth === 0) {
      for (const op of operators) {
        if (expression.substring(i, i + op.length) === op) {
          const prec = getOperatorPrecedence(op);
          if (prec <= lowestPrec) {
            lowestPrec = prec;
            mainOp = op;
          }
          i += op.length - 1;
          break;
        }
      }
    }
  }

  return mainOp;
}

/**
 * Wrap `expression` in parentheses when its main operator has lower precedence
 * than `parentOperator`, or when it is a right operand with equal precedence
 * for left-associative operators.
 */
export function addParenthesesIfNeeded(
  expression: string,
  parentOperator?: string,
  isLeftOperand?: boolean
): string {
  if (!parentOperator) return expression;

  const exprOp = getMainOperator(expression);
  if (!exprOp) return expression;

  const parentPrec = getOperatorPrecedence(parentOperator);
  const exprPrec = getOperatorPrecedence(exprOp);

  if (
    exprPrec < parentPrec ||
    (exprPrec === parentPrec && !isLeftOperand && isLeftAssociative(parentOperator))
  ) {
    return `(${expression})`;
  }

  return expression;
}

// ── Boolean test helpers ───────────────────────────────────────────

/** Check whether an expression string already contains a boolean comparison. */
export function isBooleanExpression(expression: string): boolean {
  const comparisonOperators = ['==', '!=', '>', '<', '>=', '<=', '&&', '||'];
  return comparisonOperators.some((op) => expression.includes(` ${op} `));
}

/**
 * Convert a CEL expression to a boolean test.
 * If the expression is already boolean, return it unchanged;
 * otherwise wrap it in truthy-check conditions.
 */
export function convertToBooleanTest(expression: string): string {
  if (isBooleanExpression(expression)) return expression;
  return `${expression} != null && ${expression} != "" && ${expression} != false && ${expression} != 0`;
}

// ── Type inference helper ──────────────────────────────────────────

/** Infer a representative zero-value from a Kubernetes field path. */
export function inferTypeFromFieldPath(
  fieldPath: string
): string | number | boolean | Record<string, unknown> | unknown[] {
  if (fieldPath.includes('replicas') || fieldPath.includes('count') || fieldPath.includes('port')) {
    return 0;
  }
  if (
    fieldPath.includes('ready') ||
    fieldPath.includes('available') ||
    fieldPath.includes('enabled')
  ) {
    return false;
  }
  if (
    fieldPath.includes('name') ||
    fieldPath.includes('image') ||
    fieldPath.includes('namespace')
  ) {
    return '';
  }
  if (fieldPath.includes('labels') || fieldPath.includes('annotations')) {
    return {};
  }
  if (
    fieldPath.includes('conditions') ||
    fieldPath.includes('ingress') ||
    fieldPath.includes('containers')
  ) {
    return [];
  }
  return '';
}
