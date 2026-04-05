/**
 * Core recursive AST traversal for the composition body analyzer.
 *
 * Contains the mutually recursive `walkBody`, `walkStatement`, and `walkExpression`
 * functions, plus the `registerResourceControlFlow` and `extractFunctionBody` helpers.
 *
 * These functions MUST stay together because they are mutually recursive.
 */

import { getComponentLogger } from '../../logging/index.js';
import {
  conditionToCel,
  extractFactoryId,
  extractFactoryName,
  findFactoryCallsInSubtree,
  isCompileTimeLiteral,
  isFactoryCall,
  iterableToCel,
  negateCondition,
  referencesSpec,
} from './composition-analyzer-helpers.js';
import {
  analyzeFactoryArgTernaries,
  analyzeReturnCollectionAggregates,
  analyzeReturnStatementTernaries,
  findFactoryMapCall,
} from './composition-analyzer-ternary.js';
import type {
  ASTAnalysisResult,
  ASTNode,
  CallExpression,
  ConditionalExpression,
  ForEachDimension,
  ForOfStatement,
  Identifier,
  IfStatement,
  IncludeWhenCondition,
  LogicalExpression,
  MemberExpression,
  TraversalContext,
  VariableDeclarator,
} from './composition-analyzer-types.js';

const logger = getComponentLogger('composition-analyzer');

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

/**
 * Walk the AST body to find factory calls and their enclosing control flow.
 *
 * This uses a recursive visitor that tracks the current stack of control flow
 * constructs (ForOfStatement, IfStatement) and attaches them when a factory
 * call is found.
 */
export function walkBody(
  body: ASTNode[],
  fullSource: string,
  specParamName: string,
  ctx: TraversalContext,
  result: ASTAnalysisResult
): void {
  for (const stmt of body) {
    walkStatement(stmt, fullSource, specParamName, ctx, result);
  }
}

export function walkStatement(
  node: ASTNode,
  fullSource: string,
  specParamName: string,
  ctx: TraversalContext,
  result: ASTAnalysisResult
): void {
  switch (node.type) {
    case 'ExpressionStatement':
      walkExpression(
        (node as ASTNode & { expression: ASTNode }).expression,
        fullSource,
        specParamName,
        ctx,
        result
      );
      break;

    case 'VariableDeclaration': {
      const declarations = (node as ASTNode & { declarations: VariableDeclarator[] }).declarations;
      for (const decl of declarations) {
        if (decl.init) {
          walkExpression(decl.init, fullSource, specParamName, ctx, result);

          // Track collection variables: `const deployments = spec.regions.map(factoryCb)`
          // This enables later resolution of `deployments.length` → `size(resourceId)`.
          if (decl.id.type === 'Identifier') {
            const varName = (decl.id as Identifier).name;
            const resourceId = findFactoryMapCall(decl.init, specParamName);
            if (resourceId) {
              result._collectionVariables.set(varName, { varName, resourceId });
              logger.debug('Tracked collection variable', { varName, resourceId });
            }
          }
        }
      }
      break;
    }

    case 'ForOfStatement': {
      const forOf = node as ForOfStatement;
      // Extract the iterator variable name
      let varName = 'item';
      if (forOf.left.type === 'VariableDeclaration') {
        const decls = (forOf.left as ASTNode & { declarations: VariableDeclarator[] }).declarations;
        if (decls[0]?.id.type === 'Identifier') {
          varName = (decls[0].id as Identifier).name;
        }
      }

      // Build the forEach dimension
      const dimension: ForEachDimension = {
        variableName: varName,
        source: iterableToCel(forOf.right, fullSource, specParamName),
      };

      // Push dimension and walk body
      const newCtx: TraversalContext = {
        forEachStack: [...ctx.forEachStack, dimension],
        includeWhenStack: [...ctx.includeWhenStack],
        optionalFieldNames: ctx.optionalFieldNames,
      };

      const body = forOf.body;
      if (body.type === 'BlockStatement') {
        walkBody(
          (body as ASTNode & { body: ASTNode[] }).body,
          fullSource,
          specParamName,
          newCtx,
          result
        );
      } else {
        walkStatement(body, fullSource, specParamName, newCtx, result);
      }
      break;
    }

    case 'IfStatement': {
      const ifStmt = node as IfStatement;
      const testNode = ifStmt.test;

      // Only produce includeWhen if the condition references the spec parameter
      // and is NOT a compile-time literal
      if (!isCompileTimeLiteral(testNode) && referencesSpec(testNode, specParamName)) {
        const condition: IncludeWhenCondition = {
          expression: conditionToCel(testNode, fullSource, specParamName, ctx.optionalFieldNames),
        };

        const newCtx: TraversalContext = {
          forEachStack: [...ctx.forEachStack],
          includeWhenStack: [...ctx.includeWhenStack, condition],
          optionalFieldNames: ctx.optionalFieldNames,
        };

        // Walk consequent
        const consequent = ifStmt.consequent;
        if (consequent.type === 'BlockStatement') {
          walkBody(
            (consequent as ASTNode & { body: ASTNode[] }).body,
            fullSource,
            specParamName,
            newCtx,
            result
          );
        } else {
          walkStatement(consequent, fullSource, specParamName, newCtx, result);
        }
      } else {
        // Compile-time or non-spec condition: walk through without adding includeWhen
        const consequent = ifStmt.consequent;
        if (consequent.type === 'BlockStatement') {
          walkBody(
            (consequent as ASTNode & { body: ASTNode[] }).body,
            fullSource,
            specParamName,
            ctx,
            result
          );
        } else {
          walkStatement(consequent, fullSource, specParamName, ctx, result);
        }
      }

      // Walk alternate (else branch).
      // If the condition references spec, the else branch gets a NEGATED includeWhen
      // so that resources created in the else are only included when the condition is false.
      if (ifStmt.alternate) {
        let elseCtx = ctx;
        if (!isCompileTimeLiteral(testNode) && referencesSpec(testNode, specParamName)) {
          const negatedCondition: IncludeWhenCondition = {
            expression: negateCondition(
              conditionToCel(testNode, fullSource, specParamName, ctx.optionalFieldNames)
            ),
          };
          elseCtx = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, negatedCondition],
            optionalFieldNames: ctx.optionalFieldNames,
          };
        }

        if (ifStmt.alternate.type === 'IfStatement') {
          walkStatement(ifStmt.alternate, fullSource, specParamName, elseCtx, result);
        } else if (ifStmt.alternate.type === 'BlockStatement') {
          walkBody(
            (ifStmt.alternate as ASTNode & { body: ASTNode[] }).body,
            fullSource,
            specParamName,
            elseCtx,
            result
          );
        } else {
          walkStatement(ifStmt.alternate, fullSource, specParamName, elseCtx, result);
        }
      }
      break;
    }

    case 'BlockStatement': {
      walkBody(
        (node as ASTNode & { body: ASTNode[] }).body,
        fullSource,
        specParamName,
        ctx,
        result
      );
      break;
    }

    case 'ReturnStatement': {
      // Analyze return statement for ternary expressions in status values
      analyzeReturnStatementTernaries(node, fullSource, specParamName, result);
      // Analyze return statement for collection aggregate expressions
      analyzeReturnCollectionAggregates(
        node,
        fullSource,
        result._collectionVariables,
        specParamName,
        result
      );
      // Also walk the return argument to catch factory calls inside return statements
      // (e.g., `return Deployment({...})` inside a .map() callback body)
      const returnArg = (node as ASTNode & { argument: ASTNode | null }).argument;
      if (returnArg) {
        walkExpression(returnArg, fullSource, specParamName, ctx, result);
      }
      break;
    }

    default: {
      // For unknown statement types, try to traverse children generically
      // to catch factory calls in unexpected locations
      const allFactoryCalls = findFactoryCallsInSubtree(node);
      for (const call of allFactoryCalls) {
        registerResourceControlFlow(call.id, call.factoryName, ctx, result);
      }
      break;
    }
  }
}

/**
 * Walk an expression node looking for factory calls and control flow patterns.
 */
export function walkExpression(
  node: ASTNode,
  fullSource: string,
  specParamName: string,
  ctx: TraversalContext,
  result: ASTAnalysisResult
): void {
  if (!node) return;

  // Direct factory call: Deployment({...})
  if (isFactoryCall(node)) {
    const call = node as CallExpression;
    const id = extractFactoryId(call);
    if (id) {
      registerResourceControlFlow(id, extractFactoryName(call), ctx, result);
      // Scan factory argument properties for ternary expressions that should become CEL
      analyzeFactoryArgTernaries(call, id, fullSource, specParamName, result);
    }
    return;
  }

  // Array method chaining: spec.regions.map(region => Factory({...}))
  // Also handles: spec.workers.filter(...).map(worker => Factory({...}))
  // IMPORTANT: Check for array iteration methods BEFORE generic method chaining
  if (node.type === 'CallExpression') {
    const call = node as CallExpression;
    if (call.callee.type === 'MemberExpression') {
      const member = call.callee as MemberExpression;
      const methodName =
        member.property.type === 'Identifier' ? (member.property as Identifier).name : undefined;

      const callback = call.arguments[0];
      if ((methodName === 'map' || methodName === 'forEach') && callback) {
        // Check if the callback contains factory calls
        const factoryIds = findFactoryCallsInSubtree(callback);

        if (factoryIds.length > 0) {
          // This is an iteration pattern! Extract the dimension.
          const iterableSource = member.object;

          // Extract the callback parameter name
          let iterVarName = 'item';
          if (
            callback.type === 'ArrowFunctionExpression' ||
            callback.type === 'FunctionExpression'
          ) {
            const params = (callback as ASTNode & { params: ASTNode[] }).params;
            if (params[0]?.type === 'Identifier') {
              iterVarName = (params[0] as Identifier).name;
            }
          }

          const dimension: ForEachDimension = {
            variableName: iterVarName,
            source: iterableToCel(iterableSource, fullSource, specParamName),
          };

          const newCtx: TraversalContext = {
            forEachStack: [...ctx.forEachStack, dimension],
            includeWhenStack: [...ctx.includeWhenStack],
            optionalFieldNames: ctx.optionalFieldNames,
          };

          // Walk the callback body recursively to detect nested control flow
          // (e.g., if-statements inside .map() callbacks → includeWhen + forEach)
          if (
            callback.type === 'ArrowFunctionExpression' ||
            callback.type === 'FunctionExpression'
          ) {
            const cbBody = (callback as ASTNode & { body: ASTNode }).body;
            if (cbBody.type === 'BlockStatement') {
              walkBody(
                (cbBody as ASTNode & { body: ASTNode[] }).body,
                fullSource,
                specParamName,
                newCtx,
                result
              );
            } else {
              // Expression body arrow function: (region) => Deployment({...})
              walkExpression(cbBody, fullSource, specParamName, newCtx, result);
            }
          } else {
            // Fallback: just register the found factories directly
            for (const fCall of factoryIds) {
              registerResourceControlFlow(fCall.id, fCall.factoryName, newCtx, result);
            }
          }
          return;
        }
      }

      // Method chaining: Deployment({...}).withReadyWhen(...)
      // The factory call is inside the chain — recurse into the object
      walkExpression(member.object, fullSource, specParamName, ctx, result);
      return;
    }
  }

  // Ternary: spec.flag ? FactoryA({...}) : FactoryB({...}) or spec.flag ? Factory({...}) : undefined
  if (node.type === 'ConditionalExpression') {
    const cond = node as ConditionalExpression;
    const testNode = cond.test;

    if (!isCompileTimeLiteral(testNode) && referencesSpec(testNode, specParamName)) {
      const condition = conditionToCel(
        testNode,
        fullSource,
        specParamName,
        ctx.optionalFieldNames
      );

      // Check if consequent contains factory calls
      const consequentCalls = findFactoryCallsInSubtree(cond.consequent);
      // Check if alternate contains factory calls
      const alternateCalls = findFactoryCallsInSubtree(cond.alternate);

      if (consequentCalls.length > 0 || alternateCalls.length > 0) {
        // This is a ternary creating/not-creating resources → includeWhen
        for (const call of consequentCalls) {
          const newCtx: TraversalContext = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, { expression: condition }],
            optionalFieldNames: ctx.optionalFieldNames,
          };
          registerResourceControlFlow(call.id, call.factoryName, newCtx, result);
        }

        // Alternate gets negated condition
        for (const call of alternateCalls) {
          const negatedCondition = negateCondition(condition);
          const newCtx: TraversalContext = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, { expression: negatedCondition }],
            optionalFieldNames: ctx.optionalFieldNames,
          };
          registerResourceControlFlow(call.id, call.factoryName, newCtx, result);
        }
        return;
      }
    }
    // If no factory calls in branches, it's a ternary VALUE — fall through
    return;
  }

  // Logical AND short-circuit: spec.flag && Factory({...})
  if (node.type === 'LogicalExpression') {
    const logical = node as LogicalExpression;

    if (logical.operator === '&&') {
      // Check if the right side contains factory calls
      const rightCalls = findFactoryCallsInSubtree(logical.right);
      if (
        rightCalls.length > 0 &&
        !isCompileTimeLiteral(logical.left) &&
        referencesSpec(logical.left, specParamName)
      ) {
        const condition = conditionToCel(
          logical.left,
          fullSource,
          specParamName,
          ctx.optionalFieldNames
        );
        for (const call of rightCalls) {
          const newCtx: TraversalContext = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, { expression: condition }],
            optionalFieldNames: ctx.optionalFieldNames,
          };
          registerResourceControlFlow(call.id, call.factoryName, newCtx, result);
        }
        return;
      }
    }

    // Walk both sides
    walkExpression(logical.left, fullSource, specParamName, ctx, result);
    walkExpression(logical.right, fullSource, specParamName, ctx, result);
    return;
  }

  // For any other expression, search for factory calls in subtree
  const calls = findFactoryCallsInSubtree(node);
  for (const call of calls) {
    registerResourceControlFlow(call.id, call.factoryName, ctx, result);
  }
}

// ---------------------------------------------------------------------------
// Resource registration
// ---------------------------------------------------------------------------

/**
 * Register the control flow context for a resource.
 *
 * If the resource was already seen, this merges the contexts (this handles
 * cases where a factory call appears in multiple code paths, though this
 * is unlikely for well-formed compositions).
 */
export function registerResourceControlFlow(
  resourceId: string,
  factoryName: string,
  ctx: TraversalContext,
  result: ASTAnalysisResult
): void {
  let entry = result.resources.get(resourceId);
  if (!entry) {
    entry = { resourceId, forEach: [], includeWhen: [] };
    result.resources.set(resourceId, entry);
  }

  // Track factory name for unregistered resource creation (stored separately)
  if (factoryName && !result.unregisteredFactories.some((f) => f.resourceId === resourceId)) {
    // Will be used by integration layer if this resource wasn't registered at runtime
    result.unregisteredFactories.push({ resourceId, factoryName, argSource: '' });
  }

  // Merge forEach dimensions (avoid duplicates)
  for (const dim of ctx.forEachStack) {
    const exists = entry.forEach.some(
      (d) => d.variableName === dim.variableName && d.source === dim.source
    );
    if (!exists) {
      entry.forEach.push(dim);
    }
  }

  // Merge includeWhen conditions (avoid duplicates)
  for (const cond of ctx.includeWhenStack) {
    const exists = entry.includeWhen.some((c) => c.expression === cond.expression);
    if (!exists) {
      entry.includeWhen.push(cond);
    }
  }
}

// ---------------------------------------------------------------------------
// Function body extraction
// ---------------------------------------------------------------------------

/**
 * Extract the body statements from the parsed function AST.
 */
export function extractFunctionBody(ast: ASTNode & { body: ASTNode[] }): ASTNode[] | null {
  for (const node of ast.body) {
    // FunctionDeclaration
    if (node.type === 'FunctionDeclaration') {
      const body = (node as ASTNode & { body: ASTNode & { body: ASTNode[] } }).body;
      if (body?.type === 'BlockStatement') {
        return body.body;
      }
    }

    // ExpressionStatement containing an ArrowFunctionExpression or FunctionExpression
    if (node.type === 'ExpressionStatement') {
      const expr = (node as ASTNode & { expression: ASTNode }).expression;

      if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') {
        const body = (expr as ASTNode & { body: ASTNode }).body;
        if (body.type === 'BlockStatement') {
          return (body as ASTNode & { body: ASTNode[] }).body;
        }
        // Concise arrow function body (single expression) — wrap in array
        return [{ type: 'ExpressionStatement', expression: body } as ASTNode];
      }
    }
  }
  return null;
}
