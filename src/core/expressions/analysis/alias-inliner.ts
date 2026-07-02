/**
 * Lexical alias collection and inlining for status expressions.
 *
 * This pass intentionally works on source/AST before JS values are evaluated,
 * because JavaScript operators erase the symbolic proxy expression at runtime.
 */

export type LexicalAliasScope = Record<string, string>;

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from acorn/estraverse are intentionally handled dynamically.
type AnyNode = Record<string, any>;

export function buildLexicalAliasScope(ast: unknown, source: string): LexicalAliasScope {
  const scope: LexicalAliasScope = {};
  const statements = topLevelFunctionStatements(ast as AnyNode);

  for (const statement of statements) {
    if (statement.type === 'ReturnStatement') {
      break;
    }
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
      continue;
    }

    for (const declaration of statement.declarations ?? []) {
      collectVariableAlias(declaration, source, scope);
    }
  }

  return scope;
}

export function inlineLexicalAliases(expression: string, scope: LexicalAliasScope): string {
  let result = expression;
  const entries = Object.entries(scope).sort((left, right) => right[0].length - left[0].length);

  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const [aliasPath, aliasExpression] of entries) {
      const next = replaceAliasPath(result, aliasPath, aliasExpression);
      if (next !== result) {
        changed = true;
        result = next;
      }
    }
    if (!changed) {
      return result;
    }
  }

  throw new Error(`Could not fully inline lexical aliases in expression: ${expression}`);
}

export function topLevelReturnStatement(ast: unknown): AnyNode | undefined {
  return topLevelFunctionStatements(ast as AnyNode).find(
    (statement) => statement.type === 'ReturnStatement'
  );
}

function collectVariableAlias(
  declaration: AnyNode,
  source: string,
  scope: LexicalAliasScope
): void {
  if (
    declaration.type !== 'VariableDeclarator' ||
    declaration.id?.type !== 'Identifier' ||
    !declaration.init
  ) {
    return;
  }

  const aliasName = declaration.id.name;
  const init = declaration.init;
  const explicitAliases = collectExplicitAliases(aliasName, init, source);
  if (explicitAliases) {
    Object.assign(scope, explicitAliases);
    return;
  }

  if (init.type === 'ObjectExpression') {
    collectObjectAliases(aliasName, init, source, scope);
    return;
  }

  if (isInlineableAliasExpression(init)) {
    scope[aliasName] = getNodeSource(init, source);
  }
}

function collectObjectAliases(
  prefix: string,
  objectNode: AnyNode,
  source: string,
  scope: LexicalAliasScope
): void {
  for (const property of objectNode.properties ?? []) {
    if (property.type !== 'Property') {
      continue;
    }
    const key = propertyName(property.key);
    if (!key) {
      continue;
    }
    const aliasPath = `${prefix}.${key}`;
    if (property.value.type === 'ObjectExpression') {
      collectObjectAliases(aliasPath, property.value, source, scope);
    } else if (isInlineableAliasExpression(property.value)) {
      scope[aliasPath] = getNodeSource(property.value, source);
    }
  }
}

function collectExplicitAliases(
  aliasName: string,
  init: AnyNode,
  source: string
): LexicalAliasScope | undefined {
  if (init.type !== 'CallExpression' || init.callee?.type !== 'Identifier') {
    return undefined;
  }

  if (init.callee.name === 'alias') {
    return collectSingleResourceAliases(aliasName, init, source);
  }
  if (init.callee.name === 'aliases') {
    return collectMultiResourceAliases(aliasName, init, source);
  }
  return undefined;
}

function collectSingleResourceAliases(
  aliasName: string,
  callNode: AnyNode,
  source: string
): LexicalAliasScope | undefined {
  const [resourceNode, definitionsNode] = callNode.arguments ?? [];
  if (!resourceNode || definitionsNode?.type !== 'ObjectExpression') {
    return undefined;
  }

  const resourceSource = getNodeSource(resourceNode, source);
  const aliases: LexicalAliasScope = {};
  for (const property of definitionsNode.properties ?? []) {
    if (property.type !== 'Property') {
      continue;
    }
    const key = propertyName(property.key);
    const expressionSource = callbackExpressionSource(property.value, source, {
      identifierPath: resourceSource,
    });
    if (key && expressionSource) {
      aliases[`${aliasName}.${key}`] = expressionSource;
    }
  }
  return aliases;
}

function collectMultiResourceAliases(
  aliasName: string,
  callNode: AnyNode,
  source: string
): LexicalAliasScope | undefined {
  const [resourcesNode, definitionsNode] = callNode.arguments ?? [];
  if (resourcesNode?.type !== 'ObjectExpression' || definitionsNode?.type !== 'ObjectExpression') {
    return undefined;
  }

  const resources = objectResourceBindings(resourcesNode, source);
  const aliases: LexicalAliasScope = {};
  for (const property of definitionsNode.properties ?? []) {
    if (property.type !== 'Property') {
      continue;
    }
    const key = propertyName(property.key);
    const expressionSource = callbackExpressionSource(property.value, source, {
      destructuredPaths: resources,
    });
    if (key && expressionSource) {
      aliases[`${aliasName}.${key}`] = expressionSource;
    }
  }
  return aliases;
}

function callbackExpressionSource(
  callbackNode: AnyNode,
  source: string,
  bindings: { identifierPath?: string; destructuredPaths?: Record<string, string> }
): string | undefined {
  if (
    callbackNode.type !== 'ArrowFunctionExpression' &&
    callbackNode.type !== 'FunctionExpression'
  ) {
    return undefined;
  }

  const expressionNode = callbackBodyExpression(callbackNode);
  if (!expressionNode) {
    return undefined;
  }

  let expressionSource = getNodeSource(expressionNode, source);
  const [parameter] = callbackNode.params ?? [];
  if (parameter?.type === 'Identifier' && bindings.identifierPath) {
    expressionSource = replaceAliasPath(expressionSource, parameter.name, bindings.identifierPath);
  } else if (parameter?.type === 'ObjectPattern' && bindings.destructuredPaths) {
    const parameterBindings = destructuredParameterBindings(parameter, bindings.destructuredPaths);
    for (const [localName, replacementPath] of Object.entries(parameterBindings)) {
      expressionSource = replaceAliasPath(expressionSource, localName, replacementPath);
    }
  }

  return expressionSource;
}

function callbackBodyExpression(callbackNode: AnyNode): AnyNode | undefined {
  if (callbackNode.body?.type && callbackNode.body.type !== 'BlockStatement') {
    return callbackNode.body;
  }
  if (callbackNode.body?.type !== 'BlockStatement') {
    return undefined;
  }
  const statement = (callbackNode.body.body ?? []).find(
    (node: AnyNode) => node.type === 'ReturnStatement'
  );
  return statement?.argument;
}

function objectResourceBindings(objectNode: AnyNode, source: string): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const property of objectNode.properties ?? []) {
    if (property.type !== 'Property') {
      continue;
    }
    const key = propertyName(property.key);
    if (!key) {
      continue;
    }
    bindings[key] = getNodeSource(property.value, source);
  }
  return bindings;
}

function destructuredParameterBindings(
  parameter: AnyNode,
  resources: Record<string, string>
): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const property of parameter.properties ?? []) {
    if (property.type !== 'Property') {
      continue;
    }
    const key = propertyName(property.key);
    if (!key || !resources[key]) {
      continue;
    }
    if (property.value.type === 'Identifier') {
      bindings[property.value.name] = resources[key];
    } else if (
      property.value.type === 'AssignmentPattern' &&
      property.value.left?.type === 'Identifier'
    ) {
      bindings[property.value.left.name] = resources[key];
    }
  }
  return bindings;
}

function isInlineableAliasExpression(node: AnyNode): boolean {
  return (
    node.type === 'Identifier' ||
    node.type === 'Literal' ||
    node.type === 'TemplateLiteral' ||
    node.type === 'MemberExpression' ||
    node.type === 'ChainExpression' ||
    node.type === 'BinaryExpression' ||
    node.type === 'LogicalExpression' ||
    node.type === 'ConditionalExpression' ||
    node.type === 'UnaryExpression'
  );
}

function topLevelFunctionStatements(ast: AnyNode): AnyNode[] {
  const firstStatement = ast.body?.[0];
  const expression =
    firstStatement?.type === 'ExpressionStatement' ? firstStatement.expression : undefined;
  const functionNode =
    expression?.type === 'ArrowFunctionExpression' || expression?.type === 'FunctionExpression'
      ? expression
      : firstStatement?.type === 'FunctionDeclaration'
        ? firstStatement
        : undefined;

  if (!functionNode) {
    return [];
  }
  if (functionNode.body?.type === 'BlockStatement') {
    return functionNode.body.body ?? [];
  }
  return [];
}

function replaceAliasPath(expression: string, aliasPath: string, aliasExpression: string): string {
  const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(aliasPath)}(?![\\w$])`, 'g');
  return expression.replace(pattern, parenthesizeAliasExpression(aliasExpression));
}

function parenthesizeAliasExpression(expression: string): string {
  return needsParentheses(expression) ? `(${expression})` : expression;
}

function needsParentheses(expression: string): boolean {
  return /\s(?:\|\||&&|[!=<>]=?|[+\-*/%])\s|\?/.test(expression.trim());
}

function propertyName(node: AnyNode): string | undefined {
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return undefined;
}

export function getNodeSource(node: AnyNode, fullSource: string): string {
  if (node.range) {
    return fullSource.substring(node.range[0], node.range[1]);
  }

  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? JSON.stringify(node.value) : String(node.value);
    case 'Identifier':
      return node.name;
    case 'BinaryExpression':
    case 'LogicalExpression':
      return `${getNodeSource(node.left, fullSource)} ${node.operator} ${getNodeSource(node.right, fullSource)}`;
    case 'ConditionalExpression':
      return `${getNodeSource(node.test, fullSource)} ? ${getNodeSource(node.consequent, fullSource)} : ${getNodeSource(node.alternate, fullSource)}`;
    case 'UnaryExpression':
      return `${node.operator}${getNodeSource(node.argument, fullSource)}`;
    case 'ChainExpression':
      return getNodeSource(node.expression, fullSource);
    case 'MemberExpression': {
      const object = getNodeSource(node.object, fullSource);
      const property = node.computed
        ? `[${getNodeSource(node.property, fullSource)}]`
        : `.${propertyName(node.property) ?? getNodeSource(node.property, fullSource)}`;
      return `${object}${property}`;
    }
    case 'TemplateLiteral': {
      let result = '`';
      const quasis = node.quasis ?? [];
      const expressions = node.expressions ?? [];
      for (let index = 0; index < quasis.length; index++) {
        result += quasis[index]?.value?.raw ?? '';
        if (expressions[index]) {
          result += `\${${getNodeSource(expressions[index], fullSource)}}`;
        }
      }
      return `${result}\``;
    }
    default:
      return '<unknown>';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
