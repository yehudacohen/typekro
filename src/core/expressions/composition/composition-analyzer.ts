/**
 * Composition Body Analyzer
 *
 * Post-hoc AST analysis of composition function bodies to detect control flow
 * patterns (if-statements, for-of loops, ternary expressions) wrapping factory
 * calls. Detected patterns are translated to Kro v0.8.x directives:
 *
 *   - IfStatement → includeWhen
 *   - ForOfStatement / .map() / .forEach() → forEach
 *   - ConditionalExpression (ternary with factory call) → includeWhen
 *   - ConditionalExpression (ternary value in factory arg) → CEL conditional
 *
 * Integration: Called after the composition function executes and all resources
 * are collected, but before YAML serialization. Attaches non-enumerable
 * `includeWhen` and `forEach` properties on Enhanced resource objects.
 */

import { Parser } from 'acorn';
import * as estraverse from 'estraverse';
import { ensureError } from '../../errors.js';
import { getComponentLogger } from '../../logging/index.js';

const logger = getComponentLogger('composition-analyzer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** ESTree AST node (acorn-compatible) */
interface ASTNode {
  type: string;
  [key: string]: unknown;
}

interface ForOfStatement extends ASTNode {
  type: 'ForOfStatement';
  left: ASTNode;
  right: ASTNode;
  body: ASTNode;
}

interface IfStatement extends ASTNode {
  type: 'IfStatement';
  test: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode | null;
}

interface CallExpression extends ASTNode {
  type: 'CallExpression';
  callee: ASTNode;
  arguments: ASTNode[];
}

interface ConditionalExpression extends ASTNode {
  type: 'ConditionalExpression';
  test: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode;
}

interface LogicalExpression extends ASTNode {
  type: 'LogicalExpression';
  operator: string;
  left: ASTNode;
  right: ASTNode;
}

interface MemberExpression extends ASTNode {
  type: 'MemberExpression';
  object: ASTNode;
  property: ASTNode;
  computed: boolean;
}

interface Identifier extends ASTNode {
  type: 'Identifier';
  name: string;
}

interface Literal extends ASTNode {
  type: 'Literal';
  value: unknown;
  raw?: string;
}

interface Property extends ASTNode {
  type: 'Property';
  key: ASTNode;
  value: ASTNode;
}

interface VariableDeclarator extends ASTNode {
  type: 'VariableDeclarator';
  id: ASTNode;
  init: ASTNode | null;
}

/** Dimension detected from a forEach loop */
export interface ForEachDimension {
  /** The iterator variable name (e.g. 'region') — becomes the dimension key */
  variableName: string;
  /** The CEL expression for the iterable source (e.g. '${schema.spec.regions}') */
  source: string;
}

/** includeWhen condition attached to a resource */
export interface IncludeWhenCondition {
  /** CEL expression string (e.g. '${schema.spec.monitoring}') */
  expression: string;
}

/** Analysis result for a single resource */
export interface ResourceControlFlow {
  resourceId: string;
  forEach: ForEachDimension[];
  includeWhen: IncludeWhenCondition[];
}

/** Info about a factory call found in the AST but not registered at runtime */
export interface UnregisteredFactory {
  resourceId: string;
  factoryName: string;
  /** The full AST node source for the factory call arguments (for stub creation) */
  argSource: string;
}

/** A CEL expression that overrides a literal value in a resource template or status mapping */
export interface ExpressionOverride {
  /** Dot-separated property path within the resource template (e.g. 'spec.replicas') */
  propertyPath: string;
  /** CEL expression string wrapped in ${} (e.g. '${schema.spec.env == "production" ? 3 : 1}') */
  celExpression: string;
}

/** Full analysis result */
export interface CompositionAnalysisResult {
  resources: Map<string, ResourceControlFlow>;
  /** Factory calls found in AST that weren't registered at runtime */
  unregisteredFactories: UnregisteredFactory[];
  /**
   * Template value overrides: ternary expressions in factory arguments that
   * evaluated to a literal at runtime (because === on proxies fails) but should
   * be CEL conditionals in the serialized output.
   * Keyed by resource ID.
   */
  templateOverrides: Map<string, ExpressionOverride[]>;
  /** @internal Not currently used — collection detection is done inline in expression tree */
  _collectionVariables: Map<string, CollectionVariable>;
  /**
   * Status value overrides: ternary expressions in the return statement that
   * evaluated to a literal at runtime but should be CEL conditionals.
   */
  statusOverrides: ExpressionOverride[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers: source extraction and CEL conversion
// ---------------------------------------------------------------------------

/**
 * Extract source text from an AST node using character ranges.
 */
function getSource(node: ASTNode, fullSource: string): string {
  const range = node.range as [number, number] | undefined;
  if (range) {
    return fullSource.substring(range[0], range[1]);
  }
  return '<unknown>';
}

/**
 * Check if a CallExpression is a factory call (Deployment, ConfigMap, Service, etc.)
 * by looking at the callee name.
 */
const KNOWN_FACTORY_NAMES = new Set([
  'Deployment',
  'ConfigMap',
  'Service',
  'Ingress',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Secret',
  'PersistentVolumeClaim',
  'ServiceAccount',
  'Role',
  'RoleBinding',
  'ClusterRole',
  'ClusterRoleBinding',
  'HorizontalPodAutoscaler',
  'PodDisruptionBudget',
  'NetworkPolicy',
  'HelmRelease',
  'HelmRepository',
  'GitRepository',
  'Kustomization',
  'externalRef',
  // Common custom factory patterns
  'Namespace',
  'LimitRange',
  'ResourceQuota',
]);

function isFactoryCall(node: ASTNode): node is CallExpression {
  if (node.type !== 'CallExpression') return false;
  const call = node as CallExpression;
  const callee = call.callee;
  if (callee.type === 'Identifier') {
    return KNOWN_FACTORY_NAMES.has((callee as Identifier).name);
  }
  return false;
}

/** Extract the factory function name from a factory call expression */
function extractFactoryName(call: CallExpression): string {
  if (call.callee.type === 'Identifier') {
    return (call.callee as Identifier).name;
  }
  return 'Unknown';
}

/**
 * Extract the `id` property value from factory call arguments.
 *
 * Factory calls like `Deployment({ name: ..., id: 'web' })` have
 * an ObjectExpression as their first argument containing the id property.
 */
function extractFactoryId(call: CallExpression): string | undefined {
  const firstArg = call.arguments[0];
  if (!firstArg || firstArg.type !== 'ObjectExpression') return undefined;

  const properties = (firstArg as ASTNode & { properties: Property[] }).properties;
  if (!properties) return undefined;

  for (const prop of properties) {
    if (prop.type !== 'Property') continue;
    const key = prop.key;
    const keyName =
      key.type === 'Identifier'
        ? (key as Identifier).name
        : key.type === 'Literal'
          ? String((key as Literal).value)
          : undefined;
    if (keyName === 'id' && prop.value.type === 'Literal') {
      return String((prop.value as Literal).value);
    }
  }
  return undefined;
}

/**
 * Convert a JS if-condition AST node to a CEL expression string.
 *
 * - Replaces `spec.` with `schema.spec.` (for the schema proxy parameter)
 * - Converts `===` to `==`, `!==` to `!=`
 * - Wraps in `${}` for Kro CEL syntax
 */
function conditionToCel(node: ASTNode, fullSource: string, specParamName: string): string {
  let source = getSource(node, fullSource);

  // Replace the spec parameter name with schema.spec
  // Must use word boundary to avoid replacing substrings
  source = source.replace(new RegExp(`\\b${specParamName}\\.`, 'g'), 'schema.spec.');

  // JS → CEL operator conversions
  source = source.replace(/===/g, '==');
  source = source.replace(/!==/g, '!=');

  // Note: We do NOT convert quotes here. Bun's transpiler normalizes JS strings
  // to double quotes in fn.toString(), so the source text already uses double quotes.
  // For template values (inside resource templates), double quotes work fine because
  // they're nested in the YAML structure. For status values, the caller is responsible
  // for converting double quotes to single quotes if needed to avoid YAML escaping.

  return `\${${source}}`;
}

/**
 * Convert an iterable source expression to a Kro forEach CEL reference.
 *
 * e.g. `spec.regions` → `${schema.spec.regions}`
 * e.g. `spec.workers.filter(w => w.enabled)` → `${schema.spec.workers.filter(w, w.enabled)}`
 */
function iterableToCel(node: ASTNode, fullSource: string, specParamName: string): string {
  let source = getSource(node, fullSource);

  // Replace the spec parameter name with schema.spec
  source = source.replace(new RegExp(`\\b${specParamName}\\.`, 'g'), 'schema.spec.');

  // Convert arrow function callbacks to CEL lambda syntax
  // Pattern: .filter((w) => w.enabled) → .filter(w, w.enabled)
  // Pattern: .filter((w) => w.priority > 5) → .filter(w, w.priority > 5)
  source = source.replace(
    /\.\s*(filter|map|exists|all)\s*\(\s*\(?([a-zA-Z_$][a-zA-Z0-9_$]*)\)?\s*=>\s*(?:\{\s*(?:return\s+)?)?([\s\S]+?)(?:\s*;?\s*\})?\s*\)/g,
    (_match, method: string, param: string, body: string) => {
      let cleanBody = body.trim();
      // JS → CEL operators
      cleanBody = cleanBody.replace(/===/g, '==');
      cleanBody = cleanBody.replace(/!==/g, '!=');
      return `.${method}(${param}, ${cleanBody})`;
    }
  );

  // JS → CEL operators for outer expression
  source = source.replace(/===/g, '==');
  source = source.replace(/!==/g, '!=');

  return `\${${source}}`;
}

/**
 * Check if a condition node is a compile-time literal (e.g. `true`, `false`, `1`).
 * Compile-time literals should NOT produce includeWhen directives.
 */
function isCompileTimeLiteral(node: ASTNode): boolean {
  if (node.type === 'Literal') return true;
  // Unary: `!true`, `-1`
  if (node.type === 'UnaryExpression') {
    const unary = node as ASTNode & { argument: ASTNode };
    return isCompileTimeLiteral(unary.argument);
  }
  return false;
}

/**
 * Check if a condition references the schema spec parameter.
 * Only conditions that reference schema fields should produce includeWhen.
 */
function referencesSpec(node: ASTNode, specParamName: string): boolean {
  let found = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- estraverse types are loose
  estraverse.traverse(node as any, {
    enter(n) {
      if (n.type === 'Identifier' && (n as unknown as Identifier).name === specParamName) {
        found = true;
        return estraverse.VisitorOption.Break;
      }
      return undefined;
    },
    fallback: 'iteration',
  });
  return found;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/** Info about a factory call found in the AST */
interface FactoryCallInfo {
  id: string;
  factoryName: string;
}

/**
 * Find all factory calls in a subtree and return their resource IDs and factory names.
 */
function findFactoryCallsInSubtree(node: ASTNode): FactoryCallInfo[] {
  const calls: FactoryCallInfo[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- estraverse types are loose
  estraverse.traverse(node as any, {
    enter(n) {
      const astNode = n as unknown as ASTNode;
      if (isFactoryCall(astNode)) {
        const call = astNode as CallExpression;
        const id = extractFactoryId(call);
        if (id) {
          calls.push({ id, factoryName: extractFactoryName(call) });
        }
      }
      return undefined;
    },
    fallback: 'iteration',
  });
  return calls;
}

/**
 * Extract the spec parameter name from the composition function source.
 *
 * Handles patterns:
 *   (spec) => { ... }
 *   function(spec) { ... }
 *   (spec) => expr
 */
function extractSpecParamName(functionSource: string): string {
  // Arrow function: (spec) => ... or spec => ...
  const arrowMatch = functionSource.match(
    /^\s*(?:(?:async\s+)?\(?([a-zA-Z_$][a-zA-Z0-9_$]*)\)?\s*=>)/
  );
  if (arrowMatch?.[1]) return arrowMatch[1];

  // Regular function: function(spec) { ... } or function name(spec) { ... }
  const funcMatch = functionSource.match(/function\s*\w*\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/);
  if (funcMatch?.[1]) return funcMatch[1];

  return 'spec'; // Fallback
}

/**
 * Context maintained during AST traversal to track enclosing control flow.
 */
interface TraversalContext {
  /** Stack of forEach dimensions (outermost first) */
  forEachStack: ForEachDimension[];
  /** Stack of includeWhen conditions (outermost first) */
  includeWhenStack: IncludeWhenCondition[];
}

// ---------------------------------------------------------------------------
// Ternary detection in factory arguments and status returns
// ---------------------------------------------------------------------------

/**
 * Convert a full expression AST node to a CEL string (not just conditions).
 *
 * Reuses the same transforms as conditionToCel:
 * - `spec.` → `schema.spec.`
 * - `===` → `==`, `!==` → `!=`
 * - Single quotes → double quotes
 * - Wraps in `${}`
 */
function expressionToCel(node: ASTNode, fullSource: string, specParamName: string): string {
  return conditionToCel(node, fullSource, specParamName);
}

/**
 * Map a factory argument property key name to its template property path.
 *
 * Factory arguments like `{ name: ..., image: ..., replicas: ... }` map to
 * template paths like `spec.replicas`. Special keys are mapped differently:
 * - `name` → `metadata.name`
 * - `id` → skipped (internal, not a template property)
 * - Everything else → `spec.{key}`
 */
function factoryArgKeyToTemplatePath(key: string): string | undefined {
  if (key === 'id') return undefined; // Internal, not a template field
  if (key === 'name') return 'metadata.name';
  if (key === 'namespace') return 'metadata.namespace';
  if (key === 'labels') return 'metadata.labels';
  if (key === 'annotations') return 'metadata.annotations';
  return `spec.${key}`;
}

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
function analyzeFactoryArgTernaries(
  call: CallExpression,
  resourceId: string,
  fullSource: string,
  specParamName: string,
  result: CompositionAnalysisResult
): void {
  const firstArg = call.arguments[0];
  if (!firstArg || firstArg.type !== 'ObjectExpression') return;

  const properties = (firstArg as ASTNode & { properties: Property[] }).properties;
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

    const templatePath = factoryArgKeyToTemplatePath(keyName);
    if (!templatePath) continue;

    // Convert the full ternary expression to CEL
    const celExpr = expressionToCel(ternary, fullSource, specParamName);

    // Store the override
    let overrides = result.templateOverrides.get(resourceId);
    if (!overrides) {
      overrides = [];
      result.templateOverrides.set(resourceId, overrides);
    }
    overrides.push({ propertyPath: templatePath, celExpression: celExpr });

    logger.debug('Detected ternary in factory argument', {
      resourceId,
      property: keyName,
      templatePath,
      cel: celExpr,
    });
  }
}

/**
 * Analyze a ReturnStatement's object literal for ternary expressions
 * referencing the spec parameter. These become status overrides.
 */
function analyzeReturnStatementTernaries(
  returnNode: ASTNode,
  fullSource: string,
  specParamName: string,
  result: CompositionAnalysisResult
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

/** Tracked collection variable: the result of spec.array.map(cb) that produces factories */
interface CollectionVariable {
  /** The variable name (e.g., 'workers') */
  varName: string;
  /** The resource ID from the factory call inside .map() */
  resourceId: string;
}

/**
 * Check if a CallExpression is a `.map()` call on a spec array whose callback
 * contains factory calls. If so, return the resource ID from the factory.
 *
 * Matches: spec.workers.map(worker => Deployment({...}))
 * Also matches transpiled inline forms (no variable assignment).
 */
function findFactoryMapCall(node: ASTNode, specParamName: string): string | undefined {
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
function callbackToCelLambda(
  callbackNode: ASTNode,
  fullSource: string,
  resourceId: string
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
function analyzeReturnCollectionAggregates(
  returnNode: ASTNode,
  fullSource: string,
  _collections: Map<string, CollectionVariable>,
  specParamName: string,
  result: CompositionAnalysisResult
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
function convertCollectionExpressionToCel(
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
function convertCollectionCallToCel(
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

/**
 * Walk the AST body to find factory calls and their enclosing control flow.
 *
 * This uses a recursive visitor that tracks the current stack of control flow
 * constructs (ForOfStatement, IfStatement) and attaches them when a factory
 * call is found.
 */
function walkBody(
  body: ASTNode[],
  fullSource: string,
  specParamName: string,
  ctx: TraversalContext,
  result: CompositionAnalysisResult
): void {
  for (const stmt of body) {
    walkStatement(stmt, fullSource, specParamName, ctx, result);
  }
}

function walkStatement(
  node: ASTNode,
  fullSource: string,
  specParamName: string,
  ctx: TraversalContext,
  result: CompositionAnalysisResult
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
          expression: conditionToCel(testNode, fullSource, specParamName),
        };

        const newCtx: TraversalContext = {
          forEachStack: [...ctx.forEachStack],
          includeWhenStack: [...ctx.includeWhenStack, condition],
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
            expression: negateCondition(conditionToCel(testNode, fullSource, specParamName)),
          };
          elseCtx = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, negatedCondition],
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
function walkExpression(
  node: ASTNode,
  fullSource: string,
  specParamName: string,
  ctx: TraversalContext,
  result: CompositionAnalysisResult
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
      const condition = conditionToCel(testNode, fullSource, specParamName);

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
          };
          registerResourceControlFlow(call.id, call.factoryName, newCtx, result);
        }

        // Alternate gets negated condition
        for (const call of alternateCalls) {
          const negatedCondition = negateCondition(condition);
          const newCtx: TraversalContext = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, { expression: negatedCondition }],
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
        const condition = conditionToCel(logical.left, fullSource, specParamName);
        for (const call of rightCalls) {
          const newCtx: TraversalContext = {
            forEachStack: [...ctx.forEachStack],
            includeWhenStack: [...ctx.includeWhenStack, { expression: condition }],
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

/**
 * Negate a CEL condition expression.
 *
 * `${schema.spec.monitoring}` → `${!schema.spec.monitoring}`
 */
function negateCondition(condition: string): string {
  // Remove ${...} wrapper
  const inner = condition.replace(/^\$\{/, '').replace(/\}$/, '');
  return `\${!${inner}}`;
}

/**
 * Register the control flow context for a resource.
 *
 * If the resource was already seen, this merges the contexts (this handles
 * cases where a factory call appears in multiple code paths, though this
 * is unlikely for well-formed compositions).
 */
function registerResourceControlFlow(
  resourceId: string,
  factoryName: string,
  ctx: TraversalContext,
  result: CompositionAnalysisResult
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a composition function's source code to detect control flow
 * patterns (if-statements, for-of loops, ternary expressions) wrapping
 * factory calls. Returns the detected patterns keyed by resource ID.
 *
 * @param compositionFn - The original composition function
 * @param resourceIds - Set of known resource IDs (to validate matches)
 * @returns Analysis result with forEach/includeWhen per resource
 */
export function analyzeCompositionBody(
  compositionFn: (...args: unknown[]) => unknown,
  resourceIds: Set<string>
): CompositionAnalysisResult {
  const result: CompositionAnalysisResult = {
    resources: new Map(),
    unregisteredFactories: [],
    templateOverrides: new Map(),
    _collectionVariables: new Map(),
    statusOverrides: [],
    errors: [],
  };

  try {
    const fnSource = compositionFn.toString();
    const specParamName = extractSpecParamName(fnSource);

    // Parse the function source
    const ast = Parser.parse(fnSource, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      ranges: true,
    }) as unknown as ASTNode & { body: ASTNode[] };

    // Find the function body
    // The parsed source may be:
    //   - A FunctionDeclaration/FunctionExpression with a body
    //   - An arrow function as an ExpressionStatement
    const functionBody = extractFunctionBody(ast);
    if (!functionBody) {
      logger.debug('Could not extract function body from composition function');
      return result;
    }

    // Note: collection variable tracking is done inline in analyzeReturnCollectionAggregates
    // by detecting spec.array.map(cb).method() patterns directly in the expression tree.
    // Bun's transpiler may inline variable assignments, so we can't rely on VariableDeclaration.

    // Walk the function body
    const ctx: TraversalContext = {
      forEachStack: [],
      includeWhenStack: [],
    };

    walkBody(functionBody, fnSource, specParamName, ctx, result);

    // Separate registered from unregistered resources.
    // Only add entries that aren't already tracked by registerResourceControlFlow.
    for (const [id] of result.resources) {
      if (!resourceIds.has(id) && !result.unregisteredFactories.some((f) => f.resourceId === id)) {
        // This factory call was found in the AST but wasn't registered at runtime.
        // This happens when the factory is inside an if-branch that wasn't taken
        // (e.g. `if (spec.env === 'production')` where spec is a proxy).
        // Track it so the integration layer can create stub resources.
        // Note: the factoryName may already have been captured by registerResourceControlFlow;
        // this fallback uses '' which causes createStubResource to return null (harmless).
        result.unregisteredFactories.push({
          resourceId: id,
          factoryName: '', // registerResourceControlFlow already captured the better entry
          argSource: '',
        });
        logger.debug(`Resource ${id} found in AST but not registered at runtime`);
      }
    }
  } catch (error: unknown) {
    const msg = `Failed to analyze composition function: ${ensureError(error).message}`;
    logger.warn(msg);
    result.errors.push(msg);
  }

  return result;
}

/**
 * Extract the body statements from the parsed function AST.
 */
function extractFunctionBody(ast: ASTNode & { body: ASTNode[] }): ASTNode[] | null {
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

/**
 * Apply the analysis results to Enhanced resources by attaching
 * non-enumerable `forEach` and `includeWhen` properties.
 *
 * This is the integration point that modifies resources in-place before serialization.
 *
 * @param resources - The resources map (keyed by resource ID)
 * @param analysis - The analysis result from `analyzeCompositionBody()`
 */
export function applyAnalysisToResources(
  resources: Record<string, unknown>,
  analysis: CompositionAnalysisResult
): void {
  for (const [resourceId, controlFlow] of analysis.resources) {
    const resource = resources[resourceId];
    if (!resource || typeof resource !== 'object') continue;

    // Attach forEach as non-enumerable array of dimension objects
    if (controlFlow.forEach.length > 0) {
      const forEachDimensions = controlFlow.forEach.map((dim) => ({
        [dim.variableName]: dim.source,
      }));

      // Merge with existing forEach if present (from explicit API)
      const existing = Object.getOwnPropertyDescriptor(resource, 'forEach')?.value;
      const merged = existing
        ? [...(Array.isArray(existing) ? existing : [existing]), ...forEachDimensions]
        : forEachDimensions;

      Object.defineProperty(resource, 'forEach', {
        value: merged,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }

    // Attach includeWhen as non-enumerable array of CEL strings
    if (controlFlow.includeWhen.length > 0) {
      const celStrings = controlFlow.includeWhen.map((c) => c.expression);

      // Merge with existing includeWhen if present (from explicit .withIncludeWhen() calls)
      const existing = Object.getOwnPropertyDescriptor(resource, 'includeWhen')?.value;
      const merged = existing
        ? [...(Array.isArray(existing) ? existing : [existing]), ...celStrings]
        : celStrings;

      Object.defineProperty(resource, 'includeWhen', {
        value: merged,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  // Attach template overrides as non-enumerable __templateOverrides on resources
  for (const [resourceId, overrides] of analysis.templateOverrides) {
    const resource = resources[resourceId];
    if (!resource || typeof resource !== 'object' || overrides.length === 0) continue;

    Object.defineProperty(resource, '__templateOverrides', {
      value: overrides,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}
