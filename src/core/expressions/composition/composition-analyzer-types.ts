/**
 * Type definitions for the composition body analyzer.
 *
 * Contains AST node interfaces, domain interfaces for analysis results,
 * and internal traversal context types.
 */

// ---------------------------------------------------------------------------
// AST node interfaces (ESTree / acorn-compatible)
// ---------------------------------------------------------------------------

/** ESTree AST node (acorn-compatible) */
export interface ASTNode {
  type: string;
  [key: string]: unknown;
}

export interface ForOfStatement extends ASTNode {
  type: 'ForOfStatement';
  left: ASTNode;
  right: ASTNode;
  body: ASTNode;
}

export interface IfStatement extends ASTNode {
  type: 'IfStatement';
  test: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode | null;
}

export interface CallExpression extends ASTNode {
  type: 'CallExpression';
  callee: ASTNode;
  arguments: ASTNode[];
}

export interface ConditionalExpression extends ASTNode {
  type: 'ConditionalExpression';
  test: ASTNode;
  consequent: ASTNode;
  alternate: ASTNode;
}

export interface LogicalExpression extends ASTNode {
  type: 'LogicalExpression';
  operator: string;
  left: ASTNode;
  right: ASTNode;
}

export interface MemberExpression extends ASTNode {
  type: 'MemberExpression';
  object: ASTNode;
  property: ASTNode;
  computed: boolean;
}

export interface Identifier extends ASTNode {
  type: 'Identifier';
  name: string;
}

export interface Literal extends ASTNode {
  type: 'Literal';
  value: unknown;
  raw?: string;
}

export interface Property extends ASTNode {
  type: 'Property';
  key: ASTNode;
  value: ASTNode;
}

export interface VariableDeclarator extends ASTNode {
  type: 'VariableDeclarator';
  id: ASTNode;
  init: ASTNode | null;
}

// ---------------------------------------------------------------------------
// Exported domain interfaces
// ---------------------------------------------------------------------------

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
export interface ASTAnalysisResult {
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
// Internal traversal types
// ---------------------------------------------------------------------------

/** Info about a factory call found in the AST */
export interface FactoryCallInfo {
  id: string;
  factoryName: string;
}

/**
 * Context maintained during AST traversal to track enclosing control flow.
 */
export interface TraversalContext {
  /** Stack of forEach dimensions (outermost first) */
  forEachStack: ForEachDimension[];
  /** Stack of includeWhen conditions (outermost first) */
  includeWhenStack: IncludeWhenCondition[];
}

/** Tracked collection variable: the result of spec.array.map(cb) that produces factories */
export interface CollectionVariable {
  /** The variable name (e.g., 'workers') */
  varName: string;
  /** The resource ID from the factory call inside .map() */
  resourceId: string;
}
