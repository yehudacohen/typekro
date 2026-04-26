/**
 * Stateless utility functions for the composition body analyzer.
 *
 * Used by both ternary analysis and AST traversal modules.
 */

import * as estraverse from 'estraverse';
import { escapeRegExp } from '../../../utils/helpers.js';
import { isKnownFactory } from '../../resources/factory-registry.js';
import { getIdentifierName } from '../analysis/ast-type-guards.js';
import type {
  ASTNode,
  CallExpression,
  FactoryCallInfo,
  Identifier,
  Literal,
  Property,
} from './composition-analyzer-types.js';

// ---------------------------------------------------------------------------
// Hardcoded factory names (fallback for when factories aren't imported)
// ---------------------------------------------------------------------------

/**
 * Static set of well-known factory names used as a fallback when the
 * dynamic FactoryRegistry hasn't been populated (e.g. in unit tests that
 * only import the analyzer without importing the actual factory modules).
 *
 * The FactoryRegistry is checked first; this list is only consulted when
 * `isKnownFactory()` returns false.
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

// ---------------------------------------------------------------------------
// Source extraction
// ---------------------------------------------------------------------------

/**
 * Extract source text from an AST node using character ranges.
 */
export function getSource(node: ASTNode, fullSource: string): string {
  const range = node.range as [number, number] | undefined;
  if (range) {
    return fullSource.substring(range[0], range[1]);
  }
  return '<unknown>';
}

// ---------------------------------------------------------------------------
// Factory call detection
// ---------------------------------------------------------------------------

/**
 * Check if a CallExpression is a factory call (Deployment, ConfigMap, Service, etc.)
 * by looking at the callee name against the central FactoryRegistry.
 *
 * Custom factories become first-class by calling `registerFactory()` at import
 * time — no need to edit this file.
 */
export function isFactoryCall(node: ASTNode): node is CallExpression {
  if (node.type !== 'CallExpression') return false;
  const call = node as CallExpression;
  const callee = call.callee;
  if (callee.type === 'Identifier') {
    const name = (callee as Identifier).name;
    return isKnownFactory(name) || KNOWN_FACTORY_NAMES.has(name);
  }
  return false;
}

/** Extract the factory function name from a factory call expression */
export function extractFactoryName(call: CallExpression): string {
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
export function extractFactoryId(call: CallExpression): string | undefined {
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

// ---------------------------------------------------------------------------
// CEL conversion
// ---------------------------------------------------------------------------

/**
 * Convert a JS if-condition AST node to a CEL expression string.
 *
 * - Replaces `spec.` with `schema.spec.` (for the schema proxy parameter)
 * - Converts `===` to `==`, `!==` to `!=`
 * - Wraps bare schema field references that name an OPTIONAL field with
 *   `has()` so `if (spec.x)` and `!spec.x` express field-presence checks
 *   (matching JavaScript truthiness) rather than reading the field's
 *   value as a boolean. Required fields pass through unchanged because
 *   `has(schema.spec.required)` is always true and would make the
 *   condition vacuous.
 * - Wraps the result in `${}` for Kro CEL syntax.
 */
export function conditionToCel(
  node: ASTNode,
  fullSource: string,
  specParamName: string,
  optionalFieldNames?: Set<string>
): string {
  let source = getSource(node, fullSource);

  // Replace the spec parameter name with schema.spec
  // Must use word boundary to avoid replacing substrings
  // escapeRegExp prevents regex injection if specParamName contains metacharacters
  source = source.replace(new RegExp(`\\b${escapeRegExp(specParamName)}\\.`, 'g'), 'schema.spec.');

  // JS → CEL operator conversions
  source = source.replace(/===/g, '==');
  source = source.replace(/!==/g, '!=');
  // Kro CEL has no optional chaining syntax. Presence checks are handled
  // separately via has(...) wrapping for optional fields.
  source = source.replace(/\?\./g, '.');
  // Bun/esbuild may minify booleans inside function source: `false` → `!1`,
  // `true` → `!0`. Normalize them back to plain CEL booleans for readability
  // and stable test output.
  source = source.replace(/(^|[^\w])!1(?=$|[^\w])/g, '$1false');
  source = source.replace(/(^|[^\w])!0(?=$|[^\w])/g, '$1true');

  // JS `Object.keys(X).length` → CEL `size(X)`. The `.length` on a map
  // enumeration is equivalent to the map's size in CEL. We convert the
  // whole `Object.keys(X).length` expression in one pass so the result
  // composes cleanly with any surrounding comparison operators
  // (`> 0`, `>= N`, etc.).
  source = source.replace(
    /Object\.keys\((schema\.spec\.[a-zA-Z0-9_.]+)\)\.length/g,
    'size($1)'
  );

  // JS `X.length` on a schema reference where X is known to be an array
  // or map-like also maps to `size(X)` in CEL. This handles the common
  // pattern `if (spec.items.length > 0)` without requiring Object.keys.
  source = source.replace(
    /(schema\.spec\.[a-zA-Z0-9_.]+)\.length\b/g,
    'size($1)'
  );

  // Truthiness → has() for OPTIONAL fields only. JavaScript's
  // `if (spec.x)` means "the field is set" when x is optional, but
  // "the value is truthy" when x is a required boolean. We pick the
  // right interpretation based on whether the tested field is declared
  // as optional in the schema. KRO CEL's `has(schema.spec.X)` is the
  // canonical presence check; a bare `schema.spec.X` used as a boolean
  // throws when X is absent.
  //
  // Two passes:
  //
  //   1. **Standalone bare ref** — the *entire* condition is a single
  //      `schema.spec.<path>` (or its negation). Rewrite to `has(...)`.
  //      Handles `if (spec.x)`, `if (!spec.x)`, `if (spec.a.b.c)`.
  //
  //   2. **Bare ref in a compound** — the condition has `&&` or `||`,
  //      and one side is a bare optional ref (e.g. the left operand
  //      of `spec.secrets && size(spec.secrets) > 0`). Wrap just that
  //      operand with `has()` so the compound evaluates safely.
  //
  // In both passes, the check fires only when the top-level segment
  // of the referenced path is a declared optional field — required
  // fields keep their JS semantics (value-based truthiness).
  //
  // Note: We do NOT convert quotes here. Bun's transpiler normalizes JS strings
  // to double quotes in fn.toString(), so the source text already uses double quotes.
  // For template values (inside resource templates), double quotes work fine because
  // they're nested in the YAML structure. For status values, the caller is responsible
  // for converting double quotes to single quotes if needed to avoid YAML escaping.

  // Pass 1: standalone bare ref.
  const bareRefPattern = /^(!?)(schema\.spec\.([\w]+)(?:\.[\w]+)*)\s*$/;
  const bareMatch = bareRefPattern.exec(source);
  if (bareMatch) {
    const negation = bareMatch[1];
    const path = bareMatch[2];
    const topLevelField = bareMatch[3];
    if (topLevelField && optionalFieldNames?.has(topLevelField)) {
      source = `${negation}has(${path})`;
    }
  }

  // Pass 2: bare ref as an operand of `&&` / `||`. Handles the common
  // pattern `spec.secrets && size(spec.secrets) > 0` where the LHS
  // needs has() to avoid throwing on absent optional fields.
  if (optionalFieldNames && optionalFieldNames.size > 0) {
    source = source.replace(
      /(^|[\s(])(!?)(schema\.spec\.([\w]+)(?:\.[\w]+)*)(?=\s*(?:&&|\|\|))/g,
      (match, leading, negation, path, topLevelField) => {
        if (optionalFieldNames.has(topLevelField)) {
          return `${leading}${negation}has(${path})`;
        }
        return match;
      }
    );
  }

  return `\${${source}}`;
}

/**
 * Convert an iterable source expression to a Kro forEach CEL reference.
 *
 * e.g. `spec.regions` → `${schema.spec.regions}`
 * e.g. `spec.workers.filter(w => w.enabled)` → `${schema.spec.workers.filter(w, w.enabled)}`
 */
export function iterableToCel(node: ASTNode, fullSource: string, specParamName: string): string {
  let source = getSource(node, fullSource);

  // Replace the spec parameter name with schema.spec
  // escapeRegExp prevents regex injection if specParamName contains metacharacters
  source = source.replace(new RegExp(`\\b${escapeRegExp(specParamName)}\\.`, 'g'), 'schema.spec.');

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

// ---------------------------------------------------------------------------
// Condition analysis
// ---------------------------------------------------------------------------

/**
 * Check if a condition node is a compile-time literal (e.g. `true`, `false`, `1`).
 * Compile-time literals should NOT produce includeWhen directives.
 */
export function isCompileTimeLiteral(node: ASTNode): boolean {
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
export function referencesSpec(node: ASTNode, specParamName: string): boolean {
  let found = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- estraverse types are loose
  // biome-ignore lint/suspicious/noExplicitAny: estraverse expects broad ESTree node shapes.
  estraverse.traverse(node as any, {
    enter(n) {
      if (n.type === 'Identifier' && getIdentifierName(n) === specParamName) {
        found = true;
        return estraverse.VisitorOption.Break;
      }
      return undefined;
    },
    fallback: 'iteration',
  });
  return found;
}

/**
 * Check if an expression references a resource's status field — i.e.,
 * contains a `<identifier>.status.<field>` MemberExpression where the
 * root identifier is NOT the spec parameter and NOT a known JS global.
 *
 * Returns the `{ variableName, statusField }` if found, or `undefined`.
 * Used by the ternary detector to widen its gate beyond spec-only conditions.
 *
 * **Limitation — compound conditions**: Returns on the first match
 * (`VisitorOption.Break`). For compound expressions like
 * `cache.status.ready && db.status.instances >= 1`, only the first
 * status ref (`cache.status.ready`) is captured. The inverted run
 * then flips only that field, which may not fully invert the ternary
 * if the second condition also contributes. This is acceptable for
 * now: compound resource-status ternaries are rare, and `dependsOn`
 * + `Cel.cond` can handle them explicitly.
 */
export function extractResourceStatusRef(
  node: ASTNode,
  specParamName: string
): { variableName: string; statusField: string } | undefined {
  const GLOBALS = new Set([
    'this', 'globalThis', 'window', 'console', 'process', 'Math', 'JSON',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Date',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'Symbol',
    'Proxy', 'Reflect', 'Buffer', 'undefined', 'NaN', 'Infinity',
    'setTimeout', 'setInterval', 'queueMicrotask', 'Intl',
    'module', 'exports', 'require', 'schema',
  ]);

  let result: { variableName: string; statusField: string } | undefined;
  const memberPath = (member: ASTNode): string[] | undefined => {
    if (member.type === 'Identifier') return [getIdentifierName(member) ?? ''];
    const property = member.property as ASTNode | undefined;
    if (
      member.type === 'MemberExpression' &&
      !member.computed &&
      property?.type === 'Identifier'
    ) {
      const objectPath = memberPath(member.object as ASTNode);
      const propertyName = getIdentifierName(property);
      if (objectPath && propertyName) return [...objectPath, propertyName];
    }
    return undefined;
  };
  const statusAccess = (member: ASTNode): { variableName: string; statusField: string } | undefined => {
    const path = memberPath(member);
    if (!path || path.length < 3 || path[1] !== 'status') return undefined;
    const variableName = path[0];
    if (!variableName || variableName === specParamName || GLOBALS.has(variableName)) return undefined;
    return { variableName, statusField: path.slice(2).join('.') };
  };
  const literalToCel = (literal: Literal): string => {
    if (typeof literal.value === 'string') return JSON.stringify(literal.value);
    if (literal.value === null) return 'null';
    return String(literal.value);
  };
  const expressionNodeToCel = (expr: ASTNode): string => {
    if (expr.type === 'Identifier') return getIdentifierName(expr) ?? '';
    if (expr.type === 'Literal') return literalToCel(expr as Literal);
    if (expr.type === 'MemberExpression') return memberPath(expr)?.join('.') ?? '';
    if (expr.type === 'BinaryExpression' || expr.type === 'LogicalExpression') {
      const left = expressionNodeToCel(expr.left as ASTNode);
      const right = expressionNodeToCel(expr.right as ASTNode);
      const operator = String(expr.operator).replace('===', '==').replace('!==', '!=');
      return `${left} ${operator} ${right}`;
    }
    if (expr.type === 'UnaryExpression') {
      return `${expr.operator ?? ''}${expressionNodeToCel(expr.argument as ASTNode)}`;
    }
    if (expr.type === 'CallExpression') {
      const call = expr as unknown as CallExpression;
      const callee = call.callee;
      if (callee.type === 'MemberExpression' && !callee.computed) {
        const target = expressionNodeToCel(callee.object as ASTNode);
        const method = getIdentifierName(callee.property as ASTNode) ?? '';
        const args = call.arguments.map((arg) => expressionNodeToCel(arg)).join(', ');
        return `${target}.${method}(${args})`;
      }
    }
    if (expr.type === 'ArrowFunctionExpression') {
      const param = (expr.params as ASTNode[] | undefined)?.[0];
      const paramName = param?.type === 'Identifier' ? getIdentifierName(param) : undefined;
      return `${paramName ?? '_'}, ${expressionNodeToCel(expr.body as ASTNode)}`;
    }
    return '';
  };
  // biome-ignore lint/suspicious/noExplicitAny: estraverse expects broad ESTree node shapes.
  estraverse.traverse(node as any, {
    enter(n) {
      const astNode = n as unknown as ASTNode;
      if (astNode.type === 'CallExpression') {
        const call = astNode as unknown as CallExpression;
        if (call.callee.type === 'MemberExpression' && !call.callee.computed) {
          const target = statusAccess(call.callee.object as ASTNode);
          const method = getIdentifierName(call.callee.property as ASTNode);
          if (target && method) {
            result = {
              variableName: target.variableName,
              statusField: `${target.statusField}.${method}(${call.arguments.map((arg) => expressionNodeToCel(arg)).join(', ')})`,
            };
            return estraverse.VisitorOption.Break;
          }
        }
      }

      // Match: X.status.Y where X is an Identifier
      if (
        astNode.type === 'MemberExpression' &&
        !astNode.computed &&
        (astNode.property as ASTNode | undefined)?.type === 'Identifier'
      ) {
        const access = statusAccess(astNode);
        if (access) {
          result = access;
          return estraverse.VisitorOption.Break;
        }
      }
      return undefined;
    },
    fallback: 'iteration',
  });
  return result;
}

// ---------------------------------------------------------------------------
// Factory call search
// ---------------------------------------------------------------------------

/**
 * Find all factory calls in a subtree and return their resource IDs and factory names.
 */
export function findFactoryCallsInSubtree(node: ASTNode): FactoryCallInfo[] {
  const calls: FactoryCallInfo[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: estraverse expects broad ESTree node shapes.
  estraverse.traverse(node as any, {
    enter(n) {
      const astNode = n as unknown as ASTNode;
      if (isFactoryCall(astNode)) {
        const call = astNode as CallExpression;
        const id = extractFactoryId(call);
        if (id) {
          calls.push({ id, factoryName: extractFactoryName(call), node: call });
        }
      }
      return undefined;
    },
    fallback: 'iteration',
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Spec parameter extraction
// ---------------------------------------------------------------------------

/**
 * Extract the spec parameter name from the composition function source.
 *
 * Handles patterns:
 *   (spec) => { ... }
 *   function(spec) { ... }
 *   (spec) => expr
 */
export function extractSpecParamName(functionSource: string): string {
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

// ---------------------------------------------------------------------------
// Expression and path utilities
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
export function expressionToCel(node: ASTNode, fullSource: string, specParamName: string): string {
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
export function factoryArgKeyToTemplatePath(key: string): string | undefined {
  if (key === 'id') return undefined; // Internal, not a template field
  if (key === 'name') return 'metadata.name';
  if (key === 'namespace') return 'metadata.namespace';
  if (key === 'labels') return 'metadata.labels';
  if (key === 'annotations') return 'metadata.annotations';
  if (key === 'data') return 'data';
  if (key === 'stringData') return 'stringData';
  if (key === 'binaryData') return 'binaryData';
  if (key === 'immutable') return 'immutable';
  if (key === 'type') return 'type';
  return `spec.${key}`;
}

/**
 * Negate a CEL condition expression.
 *
 * `${schema.spec.monitoring}` → `${!schema.spec.monitoring}`
 */
export function negateCondition(condition: string): string {
  // Remove ${...} wrapper
  const inner = condition.replace(/^\$\{/, '').replace(/\}$/, '');
  return `\${!${inner}}`;
}
