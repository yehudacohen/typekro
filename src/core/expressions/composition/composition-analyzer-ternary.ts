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
  extractResourceStatusRef,
  factoryArgKeyToTemplatePath,
  findFactoryCallsInSubtree,
  getSource,
  isCompileTimeLiteral,
  referencesSpec,
  remapResourceStatusReferences,
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
  ResourceStatusTernary,
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
  result: ASTAnalysisResult,
  optionalFieldNames?: Set<string>
): void {
  const firstArg = call.arguments[0];
  if (!firstArg || firstArg.type !== 'ObjectExpression') return;

  walkObjectForTernaries(firstArg, '', resourceId, fullSource, specParamName, result, optionalFieldNames);
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
  result: ASTAnalysisResult,
  optionalFieldNames?: Set<string>
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
      if (isCompileTimeLiteral(ternary.test)) continue;

      // Check for resource-status ternary (e.g., cache.status.ready ? X : Y).
      // For direct factory calls, we record the full ternary info (property
      // path, alternate value) so processCompositionBodyAnalysis can construct
      // a targeted template override without re-execution. For non-factory
      // calls (nested compositions), we record just the detection info for
      // the scoped re-execution approach (Phase 4).
      const statusRef = extractResourceStatusRef(ternary.test, specParamName, optionalFieldNames);
      if (statusRef) {
        // Build the property path for the override target
        const topLevelPath = parentPath === '' ? factoryArgKeyToTemplatePath(keyName) : null;
        const fullPath = parentPath === '' ? topLevelPath : `${parentPath}.${keyName}`;

        if (fullPath && ternary.consequent.type === 'ObjectExpression' && ternary.alternate.type === 'ObjectExpression') {
          const trueFields = extractObjectLiteralLeaves(ternary.consequent, fullPath);
          const falseFields = extractObjectLiteralLeaves(ternary.alternate, fullPath);
          const allPaths = new Set([...trueFields.keys(), ...falseFields.keys()]);
          if (allPaths.size > 0) {
            let overrides = result.templateOverrides.get(resourceId);
            if (!overrides) {
              overrides = [];
              result.templateOverrides.set(resourceId, overrides);
            }
            const statusResourceId = result.variableToResourceId.get(statusRef.variableName) ?? statusRef.variableName;
            const conditionExpr = statusRef.conditionExpression
              ? remapResourceStatusReferences(
                  statusRef.conditionExpression,
                  new Map(result.variableToResourceId).set(statusRef.variableName, statusResourceId)
                )
              : `${statusResourceId}.status.${statusRef.statusField}`;
            for (const path of allPaths) {
              const trueValue = trueFields.get(path) ?? 'omit()';
              const falseValue = falseFields.get(path) ?? 'omit()';
              overrides.push({
                propertyPath: path,
                celExpression: `\${${conditionExpr} ? ${trueValue} : ${falseValue}}`,
              });
            }
            continue;
          }
        }

        const consequentCel = literalNodeToCel(ternary.consequent);
        const alternateCel = literalNodeToCel(ternary.alternate);

        const entry: ResourceStatusTernary = {
          ...statusRef,
        };
        // Only set callSiteResourceId for direct factory calls
        if (resourceId !== '__non_factory_call__') {
          entry.callSiteResourceId = resourceId;
        }
        if (fullPath) {
          entry.propertyPath = fullPath;
        }
        if (alternateCel) {
          entry.alternateCel = alternateCel;
        }
        result.resourceStatusTernaries.push(entry);

        if (fullPath && consequentCel && alternateCel && resourceId !== '__non_factory_call__') {
          let overrides = result.templateOverrides.get(resourceId);
          if (!overrides) {
            overrides = [];
            result.templateOverrides.set(resourceId, overrides);
          }
          const statusResourceId = result.variableToResourceId.get(statusRef.variableName) ?? statusRef.variableName;
          const conditionExpr = statusRef.conditionExpression
            ? remapResourceStatusReferences(
                statusRef.conditionExpression,
                new Map(result.variableToResourceId).set(statusRef.variableName, statusResourceId)
              )
            : `${statusResourceId}.status.${statusRef.statusField}`;
          overrides.push({
            propertyPath: fullPath,
            celExpression: `\${${conditionExpr} ? ${consequentCel} : ${alternateCel}}`,
          });
        }
        logger.debug('Detected resource-status ternary in factory argument', {
          resourceId,
          variableName: statusRef.variableName,
          statusField: statusRef.statusField,
          conditionExpression: statusRef.conditionExpression,
          propertyPath: fullPath,
          alternateCel,
        });
        continue;
      }

      if (!referencesSpec(ternary.test, specParamName)) continue;

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
        result,
        optionalFieldNames
      );
    }
  }
}

function literalNodeToCel(node: ASTNode): string | undefined {
  if (node.type !== 'Literal') return undefined;
  const value = (node as unknown as { value: unknown }).value;
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return '""';
  return undefined;
}

function extractObjectLiteralLeaves(
  objectNode: ASTNode,
  parentPath: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (objectNode.type !== 'ObjectExpression') return result;

  const properties = (objectNode as ASTNode & { properties: Property[] }).properties;
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

    const fullPath = `${parentPath}.${keyName}`;
    if (prop.value.type === 'ObjectExpression') {
      for (const [nestedPath, value] of extractObjectLiteralLeaves(prop.value, fullPath)) {
        result.set(nestedPath, value);
      }
      continue;
    }

    const literal = literalNodeToCel(prop.value);
    if (literal !== undefined) {
      result.set(fullPath, literal);
    }
  }

  return result;
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
  if (!base) return undefined;

  switch (methodName) {
    case 'every': {
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base);
      if (!lambda) return undefined;
      return `${base}.all(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'some': {
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base);
      if (!lambda) return undefined;
      return `${base}.exists(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'filter': {
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base);
      if (!lambda) return undefined;
      return `${base}.filter(${lambda.lambdaVar}, ${lambda.body})`;
    }
    case 'map': {
      // Note: this is the aggregate .map() (on the collection result),
      // NOT the factory-producing .map() on spec.array.
      // If it's the factory-producing map, findFactoryMapCall would have returned the resourceId.
      const cb = call.arguments[0];
      if (!cb) return undefined;
      const lambda = callbackToCelLambda(cb, fullSource, base);
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
