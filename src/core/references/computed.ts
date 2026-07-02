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
type AliasDefinitionMap<TInput> = Record<string, (input: TInput) => unknown>;
type AliasResult<TAliases extends Record<string, (...args: never[]) => unknown>> = {
  readonly [K in keyof TAliases]: ComputedExpression<ReturnType<TAliases[K]>>;
};

/**
 * Define reusable status aliases for a single TypeKro resource.
 *
 * @example
 * ```ts
 * const web = alias(deployment, {
 *   ready: (d) => d.status.readyReplicas >= d.spec.replicas,
 *   available: (d) => d.status.availableReplicas,
 * });
 * return { ready: web.ready };
 * ```
 */
export function alias<
  TResource extends Enhanced<unknown, unknown>,
  TAliases extends AliasDefinitionMap<TResource>,
>(resource: TResource, aliasDefinitions: TAliases): AliasResult<TAliases> {
  return Object.fromEntries(
    Object.entries(aliasDefinitions).map(([name, expression]) => [
      name,
      computedFromSource({ resource }, expression.toString(), 'resources.resource'),
    ])
  ) as AliasResult<TAliases>;
}

/**
 * Define reusable status aliases over multiple TypeKro resources.
 *
 * @example
 * ```ts
 * const app = aliases({ deployment, service }, {
 *   ready: ({ deployment, service }) =>
 *     deployment.status.readyReplicas >= deployment.spec.replicas &&
 *     service.status.loadBalancer.ingress.length > 0,
 * });
 * return { ready: app.ready };
 * ```
 */
export function aliases<
  TResources extends ComputedResourceMap,
  TAliases extends AliasDefinitionMap<TResources>,
>(resources: TResources, aliasDefinitions: TAliases): AliasResult<TAliases> {
  return Object.fromEntries(
    Object.entries(aliasDefinitions).map(([name, expression]) => [
      name,
      computed(resources, expression),
    ])
  ) as AliasResult<TAliases>;
}

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
  return computedFromSource(resources, expression.toString(), 'resources');
}

function computedFromSource<T, TResources extends ComputedResourceMap>(
  resources: TResources,
  source: string,
  parameterPath: string
): ComputedExpression<T> {
  const { expressionSource, resourceParameterBindings } = extractComputedExpressionSource(
    source,
    parameterPath
  );
  const normalizedExpression = normalizeComputedResourceParameter(
    expressionSource,
    resourceParameterBindings
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
    expression: normalizeCelResourceAliases(result.celExpression.expression, resources),
  } as ComputedExpression<T>;
}

function extractComputedExpressionSource(
  source: string,
  parameterPath: string
): {
  readonly expressionSource: string;
  readonly resourceParameterBindings?: Record<string, string>;
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

  const resourceParameterBindings = computedResourceParameterBindings(functionNode, parameterPath);
  return resourceParameterBindings
    ? {
        expressionSource: getNodeSource(bodyExpression, wrappedSource),
        resourceParameterBindings,
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

function computedResourceParameterBindings(
  functionNode: ArrowFunctionExpression | FunctionExpression,
  parameterPath: string
): Record<string, string> | undefined {
  const [parameter] = functionNode.params;
  if (!parameter) {
    return undefined;
  }
  if (parameter.type === 'Identifier') {
    return { [parameter.name]: parameterPath };
  }
  if (parameter.type !== 'ObjectPattern') {
    return undefined;
  }

  const bindings: Record<string, string> = {};
  for (const property of parameter.properties) {
    if (property.type !== 'Property' || property.key.type !== 'Identifier') {
      continue;
    }
    const resourceName = property.key.name;
    if (property.value.type === 'Identifier') {
      bindings[property.value.name] = `${parameterPath}.${resourceName}`;
    } else if (
      property.value.type === 'AssignmentPattern' &&
      property.value.left.type === 'Identifier'
    ) {
      bindings[property.value.left.name] = `${parameterPath}.${resourceName}`;
    }
  }

  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

function normalizeComputedResourceParameter(
  expressionSource: string,
  resourceParameterBindings?: Record<string, string>
): string {
  if (!resourceParameterBindings) {
    return expressionSource;
  }
  let normalizedExpression = expressionSource;
  for (const [localName, replacementPath] of Object.entries(resourceParameterBindings)) {
    if (localName === replacementPath) {
      continue;
    }
    normalizedExpression = normalizedExpression.replace(
      new RegExp(`\\b${escapeRegExp(localName)}\\.`, 'g'),
      `${replacementPath}.`
    );
  }
  return normalizedExpression;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCelResourceAliases(expression: string, resources: ComputedResourceMap): string {
  let normalizedExpression = expression.replace(/\bresources\./g, '');
  for (const [localName, resource] of Object.entries(resources)) {
    const resourceId = resourceIdOf(resource);
    if (!resourceId || resourceId === localName) {
      continue;
    }
    normalizedExpression = normalizedExpression.replace(
      new RegExp(`\\b${escapeRegExp(localName)}\\.`, 'g'),
      `${resourceId}.`
    );
  }
  return normalizedExpression;
}

function resourceIdOf(resource: Enhanced<unknown, unknown>): string | undefined {
  const candidate = (resource as { readonly id?: unknown }).id;
  return typeof candidate === 'string' ? candidate : undefined;
}
