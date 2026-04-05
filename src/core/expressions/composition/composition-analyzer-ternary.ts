/**
 * Ternary detection and collection aggregate analysis for the composition analyzer.
 *
 * Handles:
 * - Ternary expressions in factory arguments → CEL conditionals in templates
 * - Ternary expressions in return statements → CEL conditionals in status
 * - Collection aggregate patterns (`.map().length`, `.every()`, `.some()`, etc.)
 */

import { getComponentLogger } from '../../logging/index.js';
import {
  expressionToCel,
  factoryArgKeyToTemplatePath,
  findFactoryCallsInSubtree,
  getSource,
  isCompileTimeLiteral,
  referencesSpec,
} from './composition-analyzer-helpers.js';
import type {
  ASTAnalysisResult,
  ASTNode,
  CallExpression,
  CollectionVariable,
  ConditionalExpression,
  Identifier,
  Literal,
  MemberExpression,
  Property,
} from './composition-analyzer-types.js';

const logger = getComponentLogger('composition-analyzer');

// ---------------------------------------------------------------------------
// Ternary detection in factory arguments and status returns
// ---------------------------------------------------------------------------

/**
 * Scan a factory call's ObjectExpression argument for property values that are
 * ConditionalExpression (ternary) nodes referencing the spec parameter.
 *
 * At runtime, `spec.env === 'production' ? 3 : 1` evaluates to `1` because
 * `===` on proxies returns false. But in the serialized Kro YAML, this should
 * be a CEL conditional: `${schema.spec.env == "production" ? 3 : 1}`.
 *
 * Detected ternaries are stored as templateOverrides in the analysis result.
 */
export function analyzeFactoryArgTernaries(
  call: CallExpression,
  resourceId: string,
  fullSource: string,
  specParamName: string,
  result: ASTAnalysisResult
): void {
  const firstArg = call.arguments[0];
  if (!firstArg || firstArg.type !== 'ObjectExpression') return;

  walkObjectForTernaries(firstArg, '', resourceId, fullSource, specParamName, result);
}

/**
 * Recursively walk an ObjectExpression looking for Property nodes whose value
 * is a ConditionalExpression that references the spec parameter. Each match is
 * recorded as a template override at the full dotted property path.
 *
 * This enables authors to write plain JavaScript ternaries deep inside
 * structured factory arguments — e.g., `{ spec: { replicas: spec.env === 'prod' ? 3 : 1 } }`
 * or `{ env: [{ name: 'MODE', value: spec.debug ? 'debug' : 'prod' }] }` — and
 * still get correct CEL conditionals in the emitted template. Without this
 * recursion only top-level ternaries (direct children of the factory's first
 * argument) were detected.
 */
function walkObjectForTernaries(
  objectNode: ASTNode,
  parentPath: string,
  resourceId: string,
  fullSource: string,
  specParamName: string,
  result: ASTAnalysisResult
): void {
  if (objectNode.type !== 'ObjectExpression') return;
  const properties = (objectNode as ASTNode & { properties: Property[] }).properties;
  if (!properties) return;

  for (const prop of properties) {
    if (prop.type !== 'Property') continue;

    const key = prop.key;
    const keyName =
      key.type === 'Identifier'
        ? (key as Identifier).name
        : key.type === 'Literal'
          ? String((key as Literal).value)
          : undefined;
    if (!keyName) continue;

    // Ternary value → emit template override at the full dotted path
    if (prop.value.type === 'ConditionalExpression') {
      const ternary = prop.value as ConditionalExpression;
      if (!referencesSpec(ternary.test, specParamName)) continue;
      if (isCompileTimeLiteral(ternary.test)) continue;

      // Build the full property path. The top-level caller passes an empty
      // parentPath; nested calls pass the dotted path built so far.
      const topLevelPath = parentPath === '' ? factoryArgKeyToTemplatePath(keyName) : null;
      const fullPath = parentPath === '' ? topLevelPath : `${parentPath}.${keyName}`;
      if (!fullPath) continue;

      const celExpr = expressionToCel(ternary, fullSource, specParamName);

      let overrides = result.templateOverrides.get(resourceId);
      if (!overrides) {
        overrides = [];
        result.templateOverrides.set(resourceId, overrides);
      }
      overrides.push({ propertyPath: fullPath, celExpression: celExpr });

      logger.debug('Detected ternary in factory argument', {
        resourceId,
        property: keyName,
        templatePath: fullPath,
        cel: celExpr,
      });
      continue;
    }

    // Nested object → recurse, extending the dotted path
    if (prop.value.type === 'ObjectExpression') {
      const topLevelPath = parentPath === '' ? factoryArgKeyToTemplatePath(keyName) : null;
      const childPath = parentPath === '' ? topLevelPath : `${parentPath}.${keyName}`;
      if (!childPath) continue;
      walkObjectForTernaries(
        prop.value,
        childPath,
        resourceId,
        fullSource,
        specParamName,
        result
      );
    }
  }
}

/**
 * Analyze a ReturnStatement's object literal for ternary expressions
 * referencing the spec parameter. These become status overrides.
 */
export function analyzeReturnStatementTernaries(
  returnNode: ASTNode,
  fullSource: string,
  specParamName: string,
  result: ASTAnalysisResult
): void {
  const argument = (returnNode as ASTNode & { argument: ASTNode | null }).argument;
  if (!argument || argument.type !== 'ObjectExpression') return;

  const properties = (argument as ASTNode & { properties: Property[] }).properties;
  if (!properties) return;

  for (const prop of properties) {
    if (prop.type !== 'Property') continue;

    // Only handle ternary values
    if (prop.value.type !== 'ConditionalExpression') continue;

    const ternary = prop.value as ConditionalExpression;

    // Only convert if the condition references the spec parameter
    if (!referencesSpec(ternary.test, specParamName)) continue;

    // Skip if condition is a compile-time literal
    if (isCompileTimeLiteral(ternary.test)) continue;

    // Get the property key name
    const key = prop.key;
    const keyName =
      key.type === 'Identifier'
        ? (key as Identifier).name
        : key.type === 'Literal'
          ? String((key as Literal).value)
          : undefined;
    if (!keyName) continue;

    // Convert the full ternary expression to CEL
    const celExpr = expressionToCel(ternary, fullSource, specParamName);

    result.statusOverrides.push({ propertyPath: keyName, celExpression: celExpr });

    logger.debug('Detected ternary in return statement', {
      property: keyName,
      cel: celExpr,
    });
  }
}

// ---------------------------------------------------------------------------
// Collection aggregate analysis (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Check if a CallExpression is a `.map()` call on a spec array whose callback
 * contains factory calls. If so, return the resource ID from the factory.
 *
 * Matches: spec.workers.map(worker => Deployment({...}))
 * Also matches transpiled inline forms (no variable assignment).
 */
export function findFactoryMapCall(node: ASTNode, specParamName: string): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const call = node as CallExpression;
  if (call.callee.type !== 'MemberExpression') return undefined;
  const member = call.callee as MemberExpression;
  const methodName =
    member.property.type === 'Identifier' ? (member.property as Identifier).name : undefined;

  if (methodName !== 'map') return undefined;

  // Check that the object references the spec parameter
  if (!referencesSpec(member.object, specParamName)) return undefined;

  // Find factory calls in the callback
  const callback = call.arguments[0];
  if (!callback) return undefined;
  const factoryCalls = findFactoryCallsInSubtree(callback);
  if (factoryCalls.length === 0) return undefined;

  return factoryCalls[0]?.id;
}

/**
 * Convert a callback expression to a CEL lambda body.
 *
 * Given: `(w) => w.status.readyReplicas > 0`
 * Extracts the body source and replaces `w.status.X` with the CEL form.
 * The callback parameter becomes the CEL lambda variable.
 */
export function callbackToCelLambda(
  callbackNode: ASTNode,
  fullSource: string,
  _resourceId: string
): { lambdaVar: string; body: string } | undefined {
  if (
    callbackNode.type !== 'ArrowFunctionExpression' &&
    callbackNode.type !== 'FunctionExpression'
  ) {
    return undefined;
  }

  const params = (callbackNode as ASTNode & { params: ASTNode[] }).params;
  if (!params[0] || params[0].type !== 'Identifier') return undefined;
  const lambdaVar = (params[0] as Identifier).name;

  // Get the body source
  const bodyNode = (callbackNode as ASTNode & { body: ASTNode }).body;
  let bodySource: string;

  if (bodyNode.type === 'BlockStatement') {
    // Block body with return: { return expr; }
    const stmts = (bodyNode as ASTNode & { body: ASTNode[] }).body;
    const returnStmt = stmts.find((s) => s.type === 'ReturnStatement');
    if (!returnStmt) return undefined;
    const arg = (returnStmt as ASTNode & { argument: ASTNode | null }).argument;
    if (!arg) return undefined;
    bodySource = getSource(arg, fullSource);
  } else {
    // Concise arrow body: (w) => expr
    bodySource = getSource(bodyNode, fullSource);
  }

  // JS → CEL operator conversions
  bodySource = bodySource.replace(/===/g, '==');
  bodySource = bodySource.replace(/!==/g, '!=');

  return { lambdaVar, body: bodySource };
}

/**
 * Analyze the return statement for collection aggregate expressions.
 *
 * Detects patterns like (with or without intermediate variables):
 *   spec.workers.map(cb).length → size(workerDep)
 *   spec.workers.map(cb).every((w) => ...) → workerDep.all(w, ...)
 *   spec.workers.map(cb).some((w) => ...) → workerDep.exists(w, ...)
 *   spec.workers.map(cb).filter((w) => ...).length → size(workerDep.filter(w, ...))
 *   spec.workers.map(cb).map((w) => ...).join(sep) → workerDep.map(w, ...).join(sep)
 *
 * Also handles transpiled forms where variable assignments are inlined.
 */
export function analyzeReturnCollectionAggregates(
  returnNode: ASTNode,
  fullSource: string,
  _collections: Map<string, CollectionVariable>,
  specParamName: string,
  result: ASTAnalysisResult
): void {
  const argument = (returnNode as ASTNode & { argument: ASTNode | null }).argument;
  if (!argument || argument.type !== 'ObjectExpression') return;

  const properties = (argument as ASTNode & { properties: Property[] }).properties;
  if (!properties) return;

  for (const prop of properties) {
    if (prop.type !== 'Property') continue;

    const keyName =
      prop.key.type === 'Identifier'
        ? (prop.key as Identifier).name
        : prop.key.type === 'Literal'
          ? String((prop.key as Literal).value)
          : undefined;
    if (!keyName) continue;

    const celExpr = convertCollectionExpressionToCel(
      prop.value,
      fullSource,
      specParamName,
      _collections
    );
    if (celExpr) {
      result.statusOverrides.push({ propertyPath: keyName, celExpression: celExpr });
      logger.debug('Detected collection aggregate in return statement', {
        property: keyName,
        cel: celExpr,
      });
    }
  }
}

/**
 * Try to convert an expression node containing collection aggregate patterns to CEL.
 *
 * Detects patterns like `spec.workers.map(factoryCb).length` and converts to
 * `size(workerDep)`. Works directly on the expression tree without requiring
 * variable tracking (handles transpiler inlining).
 *
 * Returns the CEL expression string (wrapped in ${}) or undefined.
 */
export function convertCollectionExpressionToCel(
  node: ASTNode,
  fullSource: string,
  specParamName: string,
  collections?: Map<string, CollectionVariable>
): string | undefined {
  // Pattern: expr.length → size(resourceId) or size(chainedExpr)
  if (node.type === 'MemberExpression') {
    const member = node as MemberExpression;
    if (
      member.property.type === 'Identifier' &&
      (member.property as Identifier).name === 'length'
    ) {
      // Direct: spec.arr.map(factoryCb).length → size(resourceId)
      const resourceId = findFactoryMapCall(member.object, specParamName);
      if (resourceId) return `\${size(${resourceId})}`;

      // Variable-based: deployments.length → size(resourceId)
      // where `const deployments = spec.arr.map(factoryCb)` was tracked
      if (member.object.type === 'Identifier' && collections) {
        const varName = (member.object as Identifier).name;
        const tracked = collections.get(varName);
        if (tracked) return `\${size(${tracked.resourceId})}`;
      }

      // Chained: spec.arr.map(factoryCb).filter(...).length → size(filter expr)
      if (member.object.type === 'CallExpression') {
        const inner = convertCollectionCallToCel(
          member.object as CallExpression,
          fullSource,
          specParamName,
          collections
        );
        if (inner) return `\${size(${inner})}`;
      }
    }
    return undefined;
  }

  // Pattern: expr.every/some/filter/map/join(...)
  if (node.type === 'CallExpression') {
    const celInner = convertCollectionCallToCel(
      node as CallExpression,
      fullSource,
      specParamName,
      collections
    );
    if (celInner) return `\${${celInner}}`;
  }

  return undefined;
}

/**
 * Convert a call expression on a factory-producing collection to CEL (unwrapped).
 *
 * Walks up the chain to find the originating `spec.arr.map(factoryCb)` call,
 * extracts the resource ID, then converts the aggregate method to CEL.
 *
 * Returns the CEL expression WITHOUT ${} wrapper, or undefined.
 */
export function convertCollectionCallToCel(
  call: CallExpression,
  fullSource: string,
  specParamName: string,
  collections?: Map<string, CollectionVariable>
): string | undefined {
  if (call.callee.type !== 'MemberExpression') return undefined;
  const member = call.callee as MemberExpression;
  const methodName =
    member.property.type === 'Identifier' ? (member.property as Identifier).name : undefined;
  if (!methodName) return undefined;

  // Try to resolve: either this method is called on a factory-map result,
  // or on a chained intermediate (filter/map result).
  let resourceId: string | undefined;
  let chainedPrefix: string | undefined;

  // Check if the object is directly a spec.arr.map(factoryCb) call
  resourceId = findFactoryMapCall(member.object, specParamName);

  // Check if the object is a tracked collection variable (e.g., `deployments.every(...)`)
  if (!resourceId && member.object.type === 'Identifier' && collections) {
    const varName = (member.object as Identifier).name;
    const tracked = collections.get(varName);
    if (tracked) {
      resourceId = tracked.resourceId;
    }
  }

  if (!resourceId && member.object.type === 'CallExpression') {
    // Chained: spec.arr.map(factoryCb).filter(...).length
    // or: deployments.filter(...).length
    // The object is another call — recurse to get the inner CEL
    chainedPrefix = convertCollectionCallToCel(
      member.object as CallExpression,
      fullSource,
      specParamName,
      collections
    );
  }

  if (!resourceId && !chainedPrefix) return undefined;
  const base = chainedPrefix || resourceId;

  switch (methodName) {
    case 'every': {
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base!);
      if (!lambda) return undefined;
      return `${base}.all(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'some': {
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base!);
      if (!lambda) return undefined;
      return `${base}.exists(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'filter': {
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base!);
      if (!lambda) return undefined;
      return `${base}.filter(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'map': {
      // Note: this is the aggregate .map() (on the collection result),
      // NOT the factory-producing .map() on spec.array.
      // If it's the factory-producing map, findFactoryMapCall would have returned the resourceId.
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base!);
      if (!lambda) return undefined;
      return `${base}.map(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'join': {
      if (!chainedPrefix && resourceId) {
        // Direct: spec.arr.map(factoryCb).join(sep) — need the base as resourceId
        // But actually this doesn't make sense for a factory-producing map
        return undefined;
      }
      if (!chainedPrefix) return undefined;
      const sepArg = call.arguments[0];
      const separator = sepArg?.type === 'Literal' ? String((sepArg as Literal).value) : ', ';
      return `${chainedPrefix}.join('${separator}')`;
    }
    default:
      return undefined;
  }
}
