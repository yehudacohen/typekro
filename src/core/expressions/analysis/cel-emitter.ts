/**
 * CEL Emitter — AST-to-CEL conversion engine
 *
 * Extracted from analyzer.ts. Contains all methods that convert ESTree AST nodes
 * into CEL expression strings. Each function takes an AST node, an AnalysisContext,
 * and a recursive converter callback, returning a CelExpression.
 */

import type {
  BinaryExpression as ESTreeBinaryExpression,
  SimpleCallExpression as ESTreeCallExpression,
  ChainExpression as ESTreeChainExpression,
  ConditionalExpression as ESTreeConditionalExpression,
  LogicalExpression as ESTreeLogicalExpression,
  MemberExpression as ESTreeMemberExpression,
  Node as ESTreeNode,
  SimpleLiteral as ESTreeSimpleLiteral,
} from 'estree';
import { CEL_EXPRESSION_BRAND, KUBERNETES_REF_BRAND } from '../../constants/brands.js';
import { ConversionError } from '../../errors.js';
import type { CelExpression, KubernetesRef } from '../../types/common.js';
import type { Enhanced } from '../../types/kubernetes.js';
import {
  convertArrayAccess as convertArrayAccessFn,
  extractMemberPath as extractMemberPathFn,
  isComplexExpression as isComplexExpressionFn,
} from './ast-helpers.js';
import {
  convertArrayExpression as convertArrayExpressionFn,
  convertIdentifier as convertIdentifierFn,
  convertLiteral as convertLiteralFn,
  convertTemplateLiteral as convertTemplateLiteralFn,
  convertUnaryExpression as convertUnaryExpressionFn,
} from './ast-node-converters.js';
import { convertCallExpression as convertCallExpressionFn } from './call-expression-converters.js';
import {
  addParenthesesIfNeeded as addParenthesesIfNeededFn,
  convertToBooleanTest as convertToBooleanTestFn,
  inferTypeFromFieldPath as inferTypeFromFieldPathFn,
  mapOperatorToCel as mapOperatorToCelFn,
} from './operator-utils.js';
import type { AnalysisContext } from './shared-types.js';
import { SourceMapUtils } from './source-map.js';

/**
 * Callback type for recursive AST node conversion.
 * The cel-emitter functions need this to recurse into sub-nodes.
 */
export type ASTNodeConverter = (node: ESTreeNode, context: AnalysisContext) => CelExpression;

// ── isResourceReference (needed by several emitter functions) ────────

/**
 * Check if an expression string looks like a resource reference
 */
export function isResourceReference(expression: string): boolean {
  // Check for explicit resource/schema prefixes
  if (expression.includes('resources.') || expression.includes('schema.')) {
    return true;
  }

  // Check if it starts with a known resource name (for direct references like deployment.status.field)
  const parts = expression.split('.');
  if (parts.length >= 2) {
    const resourceName = parts[0];
    // This is a heuristic - if it looks like a resource reference pattern
    return !!(
      resourceName &&
      /^[a-zA-Z][a-zA-Z0-9-]*$/.test(resourceName) &&
      (parts[1] === 'status' || parts[1] === 'spec' || parts[1] === 'metadata')
    );
  }

  return false;
}

// ── Main AST dispatch ────────────────────────────────────────────────

/**
 * Convert an AST node to CEL expression (dispatcher).
 */
export function convertASTNode(
  node: ESTreeNode,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  switch (node.type) {
    case 'BinaryExpression':
      return convertBinaryExpression(node, context, converter);
    case 'MemberExpression':
      return convertMemberExpression(node, context, converter);
    case 'ConditionalExpression':
      return convertConditionalExpression(node, context, converter);
    case 'LogicalExpression':
      return convertLogicalExpression(node, context, converter);
    case 'ChainExpression':
      return convertOptionalChaining(node, context, converter);
    case 'TemplateLiteral':
      return convertTemplateLiteralFn(node, context, converter);
    case 'Literal':
      return convertLiteralFn(node, context);
    case 'CallExpression':
      return convertCallExpressionFn(node, context, converter);
    case 'ArrayExpression':
      return convertArrayExpressionFn(node, context, converter);
    case 'Identifier':
      return convertIdentifierFn(node, context);
    case 'UnaryExpression':
      return convertUnaryExpressionFn(node, context, converter);
    default:
      throw new ConversionError(
        `Unsupported expression type: ${node.type}`,
        String(node.type),
        'unknown'
      );
  }
}

// ── Binary expression ────────────────────────────────────────────────

/**
 * Convert binary expressions (>, <, ==, !=, &&, ||) with KubernetesRef operand handling
 */
export function convertBinaryExpression(
  node: ESTreeBinaryExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  // Convert operands with proper precedence handling
  const left = handleComplexExpression(node.left, context, node.operator, converter);
  const right = handleComplexExpression(node.right, context, node.operator, converter);

  // Map JavaScript operators to CEL operators
  const operator = mapOperatorToCelFn(node.operator);

  // Generate CEL expression with proper precedence
  const leftExpr = addParenthesesIfNeededFn(left.expression, node.operator, true);
  const rightExpr = addParenthesesIfNeededFn(right.expression, node.operator, false);

  const expression = `${leftExpr} ${operator} ${rightExpr}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

// ── Member expression ────────────────────────────────────────────────

/**
 * Convert member expressions (object.property, object['property']) and array access (array[0])
 */
export function convertMemberExpression(
  node: ESTreeMemberExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  // Handle optional member expressions (obj?.prop)
  if (node.optional) {
    return convertOptionalMemberExpression(node, context, converter);
  }

  // Handle computed member access (array[index] or object['key'])
  if (node.computed) {
    return convertArrayAccessFn(node, context, converter);
  }

  // Check if the object is a complex expression (like a method call result)
  if (
    node.object.type === 'CallExpression' ||
    (node.object.type === 'MemberExpression' && isComplexExpressionFn(node.object))
  ) {
    // Convert the object expression first
    const objectExpr = converter(node.object, context);
    const propertyName =
      node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
        ? node.property.name
        : String((node.property as ESTreeSimpleLiteral).value);

    // Create a member access on the result of the complex expression
    const expression = `${objectExpr.expression}.${propertyName}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  // Try to extract the full member path for simple cases
  let path: string;
  try {
    path = extractMemberPathFn(node);
  } catch (_error: unknown) {
    // If path extraction fails, fall back to converting the object and property separately
    const objectExpr = converter(node.object, context);
    const propertyName =
      node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
        ? node.property.name
        : String((node.property as ESTreeSimpleLiteral).value);

    const expression = `${objectExpr.expression}.${propertyName}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  // Check if this is a resource reference
  if (context.availableReferences) {
    for (const [resourceKey, resource] of Object.entries(context.availableReferences)) {
      if (
        path.startsWith(`resources.${resourceKey}.`) ||
        path.startsWith(`${resourceKey}.`) ||
        path === resourceKey
      ) {
        let fieldPath: string;
        if (path === resourceKey) {
          // Direct resource reference
          fieldPath = '';
        } else if (path.startsWith('resources.')) {
          fieldPath = path.substring(`resources.${resourceKey}.`.length);
        } else {
          fieldPath = path.substring(`${resourceKey}.`.length);
        }
        return getResourceFieldReference(resource, resourceKey, fieldPath, context);
      }
    }
  }

  // Handle schema references
  if (path.startsWith('schema.')) {
    return getSchemaFieldReference(path, context);
  }

  // Handle unknown resources - this should be an error in strict mode
  const parts = path.split('.');
  if (parts.length >= 2) {
    let resourceName: string;
    let fieldPath: string;

    // Check if this is a resources.* prefixed expression
    if (parts[0] === 'resources' && parts.length >= 3) {
      resourceName = parts[1] || ''; // The actual resource name after "resources."
      fieldPath = parts.slice(2).join('.'); // The field path after the resource name
    } else {
      resourceName = parts[0] || '';
      fieldPath = parts.slice(1).join('.');
    }

    // For strict validation contexts, check if resource should be available
    // For now, we'll be lenient and allow unknown resources with warnings

    // Create a placeholder KubernetesRef for the unknown resource
    const unknownRef: KubernetesRef<unknown> = {
      [KUBERNETES_REF_BRAND]: true as const,
      resourceId: resourceName,
      fieldPath: fieldPath,
      _type: inferTypeFromFieldPathFn(fieldPath),
    };

    // Add to dependencies
    if (context.dependencies) {
      context.dependencies.push(unknownRef);
    }

    // Generate CEL expression for unknown resource
    const expression = `resources.${resourceName}.${fieldPath}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  throw new ConversionError(`Unable to resolve member expression: ${path}`, path, 'member-access');
}

// ── Conditional expression ───────────────────────────────────────────

/**
 * Convert conditional expressions (condition ? true : false)
 */
export function convertConditionalExpression(
  node: ESTreeConditionalExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  const test = handleComplexExpression(node.test, context, '?', converter);
  const consequent = handleComplexExpression(node.consequent, context, '?', converter);
  const alternate = handleComplexExpression(node.alternate, context, '?', converter);

  // Ensure the test condition is properly formatted for CEL
  let testExpression = test.expression;

  // If the test is a resource reference or optional chaining, ensure it's properly evaluated as boolean
  if (isResourceReference(testExpression) || testExpression.includes('?')) {
    // For resource references, we need to check if they exist and are truthy
    testExpression = convertToBooleanTestFn(testExpression);
  }

  // Add parentheses to operands if needed for precedence
  const testExpr = addParenthesesIfNeededFn(testExpression, '?', true);
  const consequentExpr = addParenthesesIfNeededFn(consequent.expression, '?', false);
  const alternateExpr = addParenthesesIfNeededFn(alternate.expression, '?', false);

  const expression = `${testExpr} ? ${consequentExpr} : ${alternateExpr}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

// ── Logical expression ───────────────────────────────────────────────

/**
 * Convert logical expressions (&&, ||, ??)
 */
export function convertLogicalExpression(
  node: ESTreeLogicalExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  const left = converter(node.left, context);
  const right = converter(node.right, context);

  if (node.operator === '||') {
    return convertLogicalOrFallback(left, right);
  }

  if (node.operator === '&&') {
    return convertLogicalAnd(left, right);
  }

  if (node.operator === '??') {
    return convertNullishCoalescing(left, right);
  }

  // For other logical operators, use direct mapping
  const operator = mapOperatorToCelFn(node.operator);
  const expression = `${left.expression} ${operator} ${right.expression}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

/**
 * Convert logical OR fallback (value || default) to appropriate CEL conditionals
 */
export function convertLogicalOrFallback(left: CelExpression, right: CelExpression): CelExpression {
  // Add parentheses to operands if they contain lower precedence operators
  const leftExpr = addParenthesesIfNeededFn(left.expression, '||', true);
  const rightExpr = addParenthesesIfNeededFn(right.expression, '||', false);

  // For resource references and optional chaining, we can use a simpler null check
  if (isResourceReference(left.expression) || left.expression.includes('?')) {
    // For resource references, primarily check for null/undefined
    const expression = `${leftExpr} != null ? ${leftExpr} : ${rightExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  // For general expressions, check for all falsy values
  const expression = `${leftExpr} != null && ${leftExpr} != "" && ${leftExpr} != false && ${leftExpr} != 0 ? ${leftExpr} : ${rightExpr}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

/**
 * Convert logical AND (value && other) to CEL conditional
 */
export function convertLogicalAnd(left: CelExpression, right: CelExpression): CelExpression {
  // Add parentheses to operands if they contain lower precedence operators
  const leftExpr = addParenthesesIfNeededFn(left.expression, '&&', true);
  const rightExpr = addParenthesesIfNeededFn(right.expression, '&&', false);

  // For resource references, primarily check for null/undefined
  if (isResourceReference(left.expression) || left.expression.includes('?')) {
    const expression = `${leftExpr} != null ? ${rightExpr} : ${leftExpr}`;

    return {
      [CEL_EXPRESSION_BRAND]: true,
      expression,
      _type: undefined,
    } as CelExpression;
  }

  // For general expressions, check for all truthy values
  const expression = `${leftExpr} != null && ${leftExpr} != "" && ${leftExpr} != false && ${leftExpr} != 0 ? ${rightExpr} : ${leftExpr}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

/**
 * Convert nullish coalescing (value ?? default) to CEL null-checking expressions
 */
export function convertNullishCoalescing(left: CelExpression, right: CelExpression): CelExpression {
  // Add parentheses to operands if they contain lower precedence operators
  const leftExpr = addParenthesesIfNeededFn(left.expression, '??', true);
  const rightExpr = addParenthesesIfNeededFn(right.expression, '??', false);

  // Nullish coalescing only checks for null and undefined, not other falsy values
  const expression = `${leftExpr} != null ? ${leftExpr} : ${rightExpr}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

// ── Optional chaining ────────────────────────────────────────────────

/**
 * Convert optional chaining expressions (obj?.prop?.field) to Kro conditional CEL
 */
export function convertOptionalChaining(
  node: ESTreeChainExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  // ChainExpression wraps the actual optional expression
  const expression = node.expression;

  if (expression.type === 'MemberExpression' && expression.optional) {
    return convertOptionalMemberExpression(expression, context, converter);
  }

  if (expression.type === 'CallExpression' && expression.optional) {
    return convertOptionalCallExpression(expression, context, converter);
  }

  // If it's not actually optional, convert the inner expression normally
  return converter(expression, context);
}

/**
 * Convert optional member expressions (obj?.prop, obj?.prop?.field)
 */
export function convertOptionalMemberExpression(
  node: ESTreeMemberExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  // Build the optional chain by recursively processing the object
  const objectExpr = converter(node.object, context);

  let propertyAccess: string;
  if (node.computed) {
    // Handle obj?.[key] syntax
    const property = converter(node.property, context);
    propertyAccess = `[${property.expression}]`;
  } else {
    // Handle obj?.prop syntax
    const propName =
      node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier'
        ? node.property.name
        : String((node.property as ESTreeSimpleLiteral).value);
    propertyAccess = `.${propName}`;
  }

  // Use Kro's ? operator for null-safe access
  const celExpression = `${objectExpr.expression}?${propertyAccess}`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: celExpression,
    _type: undefined,
  } as CelExpression;
}

/**
 * Convert optional call expressions (obj?.method?.())
 */
export function convertOptionalCallExpression(
  node: ESTreeCallExpression,
  context: AnalysisContext,
  converter: ASTNodeConverter
): CelExpression {
  // Convert the callee with optional chaining
  const callee = converter(node.callee as ESTreeNode, context);

  // Convert arguments
  const args = node.arguments
    .map((arg) => converter(arg as ESTreeNode, context).expression)
    .join(', ');

  // Use Kro's ? operator for null-safe method calls
  const expression = `${callee.expression}?(${args})`;

  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

// ── Complex expression handling ──────────────────────────────────────

/**
 * Handle complex nested expressions with proper precedence
 */
export function handleComplexExpression(
  node: ESTreeNode,
  context: AnalysisContext,
  parentOperator: string | undefined,
  converter: ASTNodeConverter
): CelExpression {
  const result = converter(node, context);
  const expressionWithParens = addParenthesesIfNeededFn(result.expression, parentOperator);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: expressionWithParens,
    _type: result._type,
  } as CelExpression;
}

// ── Resource / schema field references ───────────────────────────────

/**
 * Generate CEL expression for resource field reference
 */
export function getResourceFieldReference(
  _resource: Enhanced<unknown, unknown>,
  resourceKey: string,
  fieldPath: string,
  context: AnalysisContext
): CelExpression {
  const expression = `${resourceKey}.${fieldPath}`;
  const ref: KubernetesRef<unknown> = {
    [KUBERNETES_REF_BRAND]: true,
    resourceId: resourceKey,
    fieldPath,
    _type: inferTypeFromFieldPathFn(fieldPath),
  };
  if (!context.dependencies) {
    context.dependencies = [];
  }
  context.dependencies.push(ref);
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression,
    _type: undefined,
  } as CelExpression;
}

/**
 * Generate CEL expression for schema field reference
 */
export function getSchemaFieldReference(path: string, context: AnalysisContext): CelExpression {
  const fieldPath = path.substring('schema.'.length);
  const ref: KubernetesRef<unknown> = {
    [KUBERNETES_REF_BRAND]: true,
    resourceId: '__schema__',
    fieldPath,
    _type: inferTypeFromFieldPathFn(fieldPath),
  };

  if (!context.dependencies) {
    context.dependencies = [];
  }
  context.dependencies.push(ref);

  // Generate CEL expression for schema field reference
  return {
    [CEL_EXPRESSION_BRAND]: true,
    expression: path,
    _type: undefined,
  } as CelExpression;
}

// ── Source-tracked conversion ────────────────────────────────────────

/**
 * Convert an AST node to CEL expression with source location tracking.
 */
export function convertASTNodeWithSourceTracking(
  node: ESTreeNode,
  context: AnalysisContext,
  originalExpression: string,
  sourceLocation: { line: number; column: number; length: number },
  converter: ASTNodeConverter
): CelExpression {
  try {
    const celExpression = convertASTNode(node, context, converter);

    // Add source mapping if builder is available
    if (context.sourceMap) {
      context.sourceMap.addMapping(
        originalExpression,
        celExpression.expression,
        sourceLocation,
        context.type,
        {
          expressionType: SourceMapUtils.determineExpressionType(node.type),
          kubernetesRefs: SourceMapUtils.extractKubernetesRefPaths(celExpression.expression),
          dependencies:
            context.dependencies?.map((dep) => `${dep.resourceId}.${dep.fieldPath}`) || [],
          conversionNotes: [
            `Converted ${node.type} at line ${sourceLocation.line}, column ${sourceLocation.column}`,
          ],
        }
      );
    }

    return celExpression;
  } catch (_error: unknown) {
    // Create detailed conversion error with source location
    const conversionError = ConversionError.forUnsupportedSyntax(
      originalExpression,
      node.type,
      sourceLocation,
      [`The ${node.type} syntax is not supported in this context`]
    );

    throw conversionError;
  }
}
