import * as acorn from 'acorn';
import type {
  ArrowFunctionExpression,
  BlockStatement,
  Expression,
  FunctionExpression,
  Program,
} from 'estree';
import { CEL_EXPRESSION_BRAND } from '../constants/brands.js';
import { ensureError, TypeKroError } from '../errors.js';
import { JavaScriptToCelAnalyzer } from '../expressions/analysis/analyzer.js';
import { getNodeSource } from '../expressions/factory/status-ast-utils.js';
import type { CelExpression } from '../types/common.js';
import type { Enhanced } from '../types/kubernetes.js';

export type ComputedExpression<T = unknown> = CelExpression<T> & T;

type ComputedResourceMap = Record<string, Enhanced<unknown, unknown>>;

/**
 * Define a reusable TypeKro status value from a native JavaScript expression.
 *
 * `computed(...)` is intended for framework and library authors that want to
 * expose ergonomic aliases such as `web.ready`, while still letting TypeKro
 * analyze the underlying JavaScript expression and serialize it to CEL.
 *
 * The callback is parsed, not executed. Use the provided resource map inside the
 * callback, either via destructuring or a named parameter.
 *
 * @example
 * ```ts
 * const ready = computed({ web }, ({ web }) =>
 *   web.status.availableReplicas >= web.spec.replicas
 * );
 * return { ready };
 * ```
 */
export function computed<T, TResources extends ComputedResourceMap>(
  resources: TResources,
  expression: (resources: TResources) => T
): ComputedExpression<T> {
  const source = expression.toString();
  const { expressionSource, resourceParameterName } = extractComputedExpressionSource(source);
  const normalizedExpression = normalizeComputedResourceParameter(
    expressionSource,
    resourceParameterName
  );
  const analyzer = new JavaScriptToCelAnalyzer();
  const result = analyzer.analyzeExpression(normalizedExpression, {
    type: 'status',
    availableReferences: resources,
    factoryType: 'kro',
    dependencies: [],
  });

  if (!result.valid || !result.celExpression) {
    throw new TypeKroError(
      `computed() could not convert the supplied JavaScript expression to CEL: ${result.errors.map((error) => error.message).join('; ') || 'unknown conversion error'}`,
      'COMPUTED_EXPRESSION_INVALID',
      { expression: normalizedExpression }
    );
  }

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: result.celExpression.expression,
  } as ComputedExpression<T>;
}

function extractComputedExpressionSource(source: string): {
  readonly expressionSource: string;
  readonly resourceParameterName?: string;
} {
  const wrappedSource = `(${source})`;
  let ast: Program;
  try {
    ast = acorn.parse(wrappedSource, {
      ecmaVersion: 2022,
      sourceType: 'script',
      ranges: true,
      locations: true,
    }) as unknown as Program;
  } catch (error: unknown) {
    throw new TypeKroError(
      `computed() could not parse the supplied function: ${ensureError(error).message}`,
      'COMPUTED_EXPRESSION_PARSE_FAILED',
      { source }
    );
  }

  const functionNode = firstComputedFunctionNode(ast);
  if (!functionNode) {
    throw new TypeKroError(
      'computed() requires an arrow function or function expression.',
      'COMPUTED_EXPRESSION_INVALID_FUNCTION',
      { source }
    );
  }

  const bodyExpression = computedFunctionBodyExpression(functionNode);
  if (!bodyExpression) {
    throw new TypeKroError(
      'computed() requires an expression body or a block body with a direct top-level return expression.',
      'COMPUTED_EXPRESSION_MISSING_RETURN',
      { source }
    );
  }

  const resourceParameterName = computedResourceParameterName(functionNode);
  return resourceParameterName
    ? {
        expressionSource: getNodeSource(bodyExpression, wrappedSource),
        resourceParameterName,
      }
    : { expressionSource: getNodeSource(bodyExpression, wrappedSource) };
}

function firstComputedFunctionNode(
  ast: Program
): ArrowFunctionExpression | FunctionExpression | undefined {
  const expression =
    ast.body[0]?.type === 'ExpressionStatement' ? ast.body[0].expression : undefined;
  if (expression?.type === 'ArrowFunctionExpression' || expression?.type === 'FunctionExpression') {
    return expression;
  }
  return undefined;
}

function computedFunctionBodyExpression(
  functionNode: ArrowFunctionExpression | FunctionExpression
): Expression | undefined {
  if (
    functionNode.type === 'ArrowFunctionExpression' &&
    functionNode.body.type !== 'BlockStatement'
  ) {
    return functionNode.body;
  }
  if (functionNode.body.type !== 'BlockStatement') {
    return undefined;
  }
  return topLevelReturnExpression(functionNode.body);
}

function topLevelReturnExpression(body: BlockStatement): Expression | undefined {
  const statement = body.body.find((node) => node.type === 'ReturnStatement');
  return statement?.type === 'ReturnStatement' ? (statement.argument ?? undefined) : undefined;
}

function computedResourceParameterName(
  functionNode: ArrowFunctionExpression | FunctionExpression
): string | undefined {
  const [parameter] = functionNode.params;
  return parameter?.type === 'Identifier' ? parameter.name : undefined;
}

function normalizeComputedResourceParameter(
  expressionSource: string,
  resourceParameterName?: string
): string {
  if (!resourceParameterName || resourceParameterName === 'resources') {
    return expressionSource;
  }
  return expressionSource.replace(
    new RegExp(`\\b${escapeRegExp(resourceParameterName)}\\.`, 'g'),
    'resources.'
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
