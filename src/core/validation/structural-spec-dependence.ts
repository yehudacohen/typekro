/**
 * Structural spec-dependence diagnostics.
 *
 * ## The rule
 *
 * A `ResourceGraphDefinition` is fixed at build time. `schema.spec.*` values
 * are *runtime* references: KRO substitutes them per instance, long after the
 * composition function has run. So a spec value may decide what a field
 * **contains** (a value position), but it may never decide what the graph
 * **looks like** — which resources exist, how many list entries there are, or
 * what an object's keys are called (a structural position).
 *
 * When a composition puts a spec value in a structural position, the
 * composition function still runs: the schema proxy hands the author a
 * `KubernetesRef` and JavaScript does something plausible-but-wrong with it.
 * An `if` takes the truthy branch because a proxy object is truthy. A `.map()`
 * runs exactly once against a sentinel element. `Object.keys()` yields one
 * fabricated key. The RGD that comes out is well-formed and silently encodes
 * the build-time guess for every instance.
 *
 * This module turns that silence into a KRO-mode serialization error.
 *
 * ## What is detected
 *
 * Two independent detectors, deliberately narrow so that legitimate
 * value-position uses (`replicas: spec.replicas`, `` url: `http://${spec.host}` ``,
 * CEL ternaries in status) stay silent:
 *
 * 1. {@link scanRgdResourcesForStructuralSpecArtifacts} — reads the RGD that is
 *    about to be emitted and reports build-time residue that can only come from
 *    a structural use. This is evidence-based: every finding is a concrete
 *    artifact in the output, so there are no false positives by construction.
 *      - `spec-derived-key`: an object key (or resource id) that is a schema
 *        reference marker — `{ [spec.key]: v }`, or `Object.fromEntries(...)`
 *        over a spec collection.
 *      - `runtime-map-enumerated`: the `__typekroSchemaKey` sentinel, which the
 *        schema proxy hands out when a composition enumerates a
 *        `Record<string, V>` spec field (`Object.keys(spec.settings)`,
 *        `{ ...spec.settings }`) whose keys are not knowable until runtime.
 *      - `collection-length-collapsed`: a `$item` element sentinel surviving in
 *        a resource that carries no `forEach` dimension — a `.map()` / `for-of`
 *        over a spec collection that was flattened to a single element instead
 *        of being compiled to KRO's `forEach`. A backstop: the serializer
 *        normally rewrites `$item` either into a `forEach` loop variable or
 *        into a whole-array reference (`ports: ${schema.spec.ports}`), both of
 *        which are correct, so this catches only what those miss.
 *
 * 2. {@link detectStructuralSpecPredicates} — parses the composition source and
 *    reports branch predicates that are spec-derived in a form the control-flow
 *    analyzer cannot compile to `includeWhen`, so the branch was decided at
 *    build time:
 *      - `uncompiled-predicate`: the `if` / ternary test reaches the spec only
 *        through a local binding (`const enabled = spec.enabled; if (enabled)`,
 *        `const { enabled } = spec;`), so the analyzer's lexical `spec` check
 *        misses it and no `includeWhen` is attached.
 *      - `switch-discriminator`: a `switch` on a spec-derived discriminant.
 *        There is no `switch` lowering at all; the proxy matches no `case`, so
 *        `default` wins for every instance.
 *      - `collection-length-read`: `.length` on a spec-derived collection or
 *        string. The proxy always answers `1`, so the value is a build-time
 *        constant no matter what the instance holds.
 *
 * ## What is NOT detected
 *
 * Static analysis of arbitrary JavaScript cannot be complete, and this check
 * does not pretend otherwise. Known blind spots:
 *
 *   - A predicate laundered through a **helper function** or a module-level
 *     constant: `if (isEnabled(spec))`. The alias resolver only walks
 *     top-level `const`/`let` bindings in the composition body.
 *   - A predicate on a value read back **out of a resource** rather than off
 *     the spec proxy.
 *   - Structure decided by a spec value that is **consumed by a factory** and
 *     collapsed inside it, if the collapse leaves no marker, sentinel or
 *     `$item` residue in the emitted RGD.
 *   - Anything reached through `eval`, dynamic imports, or a composition whose
 *     source cannot be parsed (the AST detector degrades to silence, never to
 *     a false positive).
 *
 * Detector 1 is the backstop for most of these: however the structure was
 * decided, if the decision left residue in the RGD it is reported.
 */

import { Parser } from 'acorn';
import * as estraverse from 'estraverse';
import { TypeKroError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import type { KroResourceTemplate } from '../types/serialization.js';

const logger = getComponentLogger('structural-spec-dependence');

/**
 * Sentinel key handed out by the schema proxy's `ownKeys` trap for
 * `Record<string, V>` spec fields, whose real keys only exist at runtime.
 * Must stay in sync with `src/core/references/schema-proxy.ts`.
 */
const RUNTIME_MAP_SENTINEL = '__typekroSchemaKey';

/** Prefix of the schema-reference marker string emitted by the schema proxy. */
const SCHEMA_REF_MARKER_PREFIX = '__KUBERNETES_REF___schema___';

/**
 * A schema reference ending in the proxy's `$item` element sentinel, which it
 * appends when a spec collection is iterated. Anchored to a schema path rather
 * than matching a bare `$item`, so a shell script or template in a ConfigMap
 * that happens to contain `$item` is not mistaken for one.
 *
 * Survives into the RGD only when the iteration was NOT compiled into a KRO
 * `forEach` dimension.
 */
const COLLECTION_ITEM_REFERENCE =
  /(?:schema\.spec|__KUBERNETES_REF___schema___spec)[A-Za-z0-9_.$[\]?]*\.\$item/;

/** How a runtime spec value ended up deciding build-time structure. */
export type StructuralSpecDependenceKind =
  | 'spec-derived-key'
  | 'runtime-map-enumerated'
  | 'collection-length-collapsed'
  | 'uncompiled-predicate'
  | 'switch-discriminator'
  | 'collection-length-read';

/** One place where graph structure was decided by a runtime spec value. */
export interface StructuralSpecDependenceFinding {
  readonly kind: StructuralSpecDependenceKind;
  /**
   * Where the dependence surfaced: a resource id, or `resource.<id>` plus the
   * dotted path inside its template, or a source excerpt for AST findings.
   */
  readonly location: string;
  /** Spec paths involved, as `spec.<path>` (may be empty when unresolvable). */
  readonly specPaths: readonly string[];
  /** One sentence naming what the emitted RGD actually encodes. */
  readonly detail: string;
}

/**
 * A place where the composition read the keys of a spec field at build time.
 * A candidate for a `runtime-map-enumerated` finding, not a finding itself.
 */
export interface MapEnumerationSite {
  /** Source excerpt, e.g. `Object.keys(spec.settings)` or `...spec.app.env`. */
  readonly location: string;
  /** The `spec.<path>` whose keys were read. */
  readonly specPath: string;
}

interface CompositionSourceAnalysis {
  readonly findings: StructuralSpecDependenceFinding[];
  readonly mapEnumerationSites: MapEnumerationSite[];
}

/** Thrown when a KRO-mode RGD would silently encode a build-time guess. */
export class StructuralSpecDependenceError extends TypeKroError {
  constructor(
    message: string,
    public readonly graphName: string,
    public readonly findings: readonly StructuralSpecDependenceFinding[]
  ) {
    super(message, 'STRUCTURAL_SPEC_DEPENDENCE', { graphName, findings });
    this.name = 'StructuralSpecDependenceError';
  }
}

// ---------------------------------------------------------------------------
// Detector 1 — emitted-RGD scan
// ---------------------------------------------------------------------------

function schemaPathFromMarker(text: string): string | undefined {
  const match = new RegExp(`${SCHEMA_REF_MARKER_PREFIX}([A-Za-z0-9_.$[\\]?]+?)__`).exec(text);
  return match?.[1] === undefined ? undefined : trimProxySentinelSuffix(match[1]);
}

/**
 * Trim the proxy's own placeholder segments so the reported path names the spec
 * field the author wrote, not the sentinel the proxy appended.
 */
function trimProxySentinelSuffix(path: string): string {
  return path
    .replace(new RegExp(`(?:\\.${RUNTIME_MAP_SENTINEL})+$`), '')
    .replace(/(?:\.\$item)+$/, '');
}

/** Collect every `schema.spec.<path>` / marker path mentioned anywhere in `text`. */
function schemaPathsIn(text: string): string[] {
  const paths = new Set<string>();
  const markerPattern = new RegExp(`${SCHEMA_REF_MARKER_PREFIX}([A-Za-z0-9_.$[\\]?]+?)__`, 'g');
  for (const match of text.matchAll(markerPattern)) {
    if (match[1]) paths.add(trimProxySentinelSuffix(match[1]));
  }
  for (const match of text.matchAll(/schema\.(spec\.[A-Za-z0-9_.$[\]?]+)/g)) {
    if (match[1]) paths.add(trimProxySentinelSuffix(match[1]));
  }
  return [...paths].filter((path) => path !== '' && path !== 'spec');
}

interface TemplateVisitor {
  onKey(path: string, key: string, child: unknown): void;
  onString(path: string, value: string): void;
}

/**
 * Walk an already-serialized template (plain JSON data — no proxies, no
 * `KubernetesRef` objects) reporting every object key and every string leaf.
 */
function walkTemplate(value: unknown, path: string, visitor: TemplateVisitor): void {
  if (typeof value === 'string') {
    visitor.onString(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkTemplate(entry, `${path}[${index}]`, visitor));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    visitor.onKey(childPath, key, child);
    walkTemplate(child, childPath, visitor);
  }
}

/**
 * Report build-time residue in the RGD that is about to be emitted.
 *
 * Operates on the serialized manifest rather than on live composition state,
 * so every finding is backed by a concrete artifact in the output.
 */
export function scanRgdResourcesForStructuralSpecArtifacts(
  resources: readonly KroResourceTemplate[]
): StructuralSpecDependenceFinding[] {
  const findings: StructuralSpecDependenceFinding[] = [];

  for (const entry of resources) {
    const id = entry.id;

    if (id.includes(SCHEMA_REF_MARKER_PREFIX) || id.includes(RUNTIME_MAP_SENTINEL)) {
      findings.push({
        kind: 'spec-derived-key',
        location: `resource id "${id}"`,
        specPaths: schemaPathsIn(id),
        detail:
          'the resource id itself was built from a runtime spec value, so the RGD names one ' +
          'resource after a build-time placeholder instead of one resource per instance value',
      });
    }

    // A `forEach` dimension IS the legitimate way to let a spec collection
    // decide how many resources exist, and its own source expression lives
    // outside the template. When one is present, a surviving `$item` in the
    // template is the loop variable doing its job, not a collapsed collection.
    const hasForEach = Array.isArray(entry.forEach) && entry.forEach.length > 0;
    // Template paths already reported via their key, so the string walk that
    // follows does not report the same leaf twice.
    const seenAtPath = new Set<string>();

    walkTemplate(entry.template, '', {
      onKey(path, key, child) {
        if (key.includes(SCHEMA_REF_MARKER_PREFIX)) {
          const specPath = schemaPathFromMarker(key);
          findings.push({
            kind: 'spec-derived-key',
            location: `resource "${id}" at template.${path}`,
            specPaths: specPath ? [specPath] : [],
            detail:
              'an object key was built from a runtime spec value; KRO substitutes references ' +
              'in values only, so the RGD carries the unsubstituted reference as a literal key',
          });
          seenAtPath.add(path);
          return;
        }
        if (key.includes(RUNTIME_MAP_SENTINEL)) {
          findings.push({
            kind: 'runtime-map-enumerated',
            location: `resource "${id}" at template.${path}`,
            // The sentinel key carries no path, but the value the proxy paired
            // with it does (`${schema.spec.settings.__typekroSchemaKey}`).
            specPaths: typeof child === 'string' ? schemaPathsIn(child) : [],
            detail:
              'the composition enumerated a map-typed spec field at build time; its real keys ' +
              'exist only per instance, so the RGD encodes one placeholder key',
          });
          seenAtPath.add(path);
        }
      },
      onString(path, value) {
        if (seenAtPath.has(path)) return;
        if (value.includes(RUNTIME_MAP_SENTINEL)) {
          findings.push({
            kind: 'runtime-map-enumerated',
            location: `resource "${id}" at template.${path}`,
            specPaths: schemaPathsIn(value),
            detail:
              'the composition enumerated a map-typed spec field at build time; its real keys ' +
              'exist only per instance, so the RGD encodes one placeholder key',
          });
          return;
        }
        if (!hasForEach && COLLECTION_ITEM_REFERENCE.test(value)) {
          const specPaths = schemaPathsIn(value);
          findings.push({
            kind: 'collection-length-collapsed',
            location: `resource "${id}" at template.${path}`,
            specPaths,
            detail:
              'a spec collection was iterated at build time and flattened to a single element; ' +
              'the RGD encodes exactly one entry regardless of how many the instance supplies',
          });
        }
      },
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector 2 — composition-source scan
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: acorn/estraverse ESTree nodes are handled dynamically.
type AnyNode = Record<string, any>;

/** Read the composition's spec parameter name (`(spec) => ...` → `spec`). */
function specParamNameOf(fn: AnyNode): string | undefined {
  const first = fn.params?.[0] as AnyNode | undefined;
  if (!first) return undefined;
  if (first.type === 'Identifier') return first.name as string;
  return undefined;
}

/** The composition's own function node, whichever form the source parsed into. */
function findCompositionFunction(program: AnyNode): AnyNode | undefined {
  let found: AnyNode | undefined;
  estraverse.traverse(program as never, {
    enter(node) {
      if (found) return estraverse.VisitorOption.Break;
      const type = (node as AnyNode).type;
      if (
        type === 'ArrowFunctionExpression' ||
        type === 'FunctionExpression' ||
        type === 'FunctionDeclaration'
      ) {
        found = node as AnyNode;
        return estraverse.VisitorOption.Break;
      }
      return undefined;
    },
    fallback: 'iteration',
  });
  return found;
}

/**
 * Local bindings that alias a **pure spec member chain**.
 *
 * Maps binding name → the `spec.<path>` it stands for. Deliberately narrow:
 * only `const`/`let` declarations at the top level of the composition body
 * whose initializer is a plain property read off the spec parameter (or off
 * another such binding), plus object destructuring of one.
 *
 * Anything richer is NOT an alias. A binding produced by a call, a ternary, an
 * object literal or a spread is *build-time-shaped*: it is where compositions
 * put the graph-vs-direct-mode idiom (`const graphMode =
 * isKubernetesRef(spec.name)`, `const targetNamespace = graphMode ? Cel.expr(…)
 * : spec.namespace ?? DEFAULT`), and following those would flag deliberate
 * build-time branching as a runtime dependence. Stopping at the first opaque
 * node trades completeness for zero false positives, which is the only
 * trade that makes a default-on check usable.
 */
type SpecAliasScope = Map<string, string>;

/** Unwrap parenthesis-like and TypeScript-only wrapper nodes. */
function unwrap(node: AnyNode | undefined): AnyNode | undefined {
  let current = node;
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'AwaitExpression')
  ) {
    current = (current.expression ?? current.argument) as AnyNode | undefined;
  }
  return current;
}

/**
 * The `spec.<path>` a node names, when the node is a **pure member chain**
 * rooted at the spec parameter or at a pure alias — nothing else.
 *
 * A computed segment (`spec.users[name]`) resolves to the object's path,
 * because a runtime-keyed read still depends on the object it reads from.
 */
function pureSpecChainPath(
  node: AnyNode | undefined,
  specParam: string,
  aliases: SpecAliasScope
): string | undefined {
  const current = unwrap(node);
  if (!current) return undefined;
  if (current.type === 'Identifier') {
    const name = current.name as string;
    if (name === specParam) return 'spec';
    return aliases.get(name);
  }
  if (current.type !== 'MemberExpression' && current.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  const objectPath = pureSpecChainPath(current.object as AnyNode, specParam, aliases);
  if (!objectPath) return undefined;
  if (current.computed) return objectPath;
  const property = (current.property as AnyNode | undefined)?.name as string | undefined;
  if (!property) return undefined;
  // `toResourceGraph` hands the whole schema proxy in, so the first hop off the
  // parameter is `.spec` and must not be doubled up.
  if (objectPath === 'spec' && property === 'spec') return 'spec';
  return `${objectPath}.${property}`;
}

/**
 * Spec paths an expression depends on: pure spec chains combined by operators
 * that pass their operands through unchanged.
 *
 * The walk stops at calls and function bodies — a helper's return value and a
 * callback's internals are opaque, and following them is what turns
 * `resolved.users.map((u) => spec.users[u.name])` into a bogus claim that the
 * resulting array is spec-derived.
 */
function specPathsOf(
  node: AnyNode | undefined,
  specParam: string,
  aliases: SpecAliasScope
): string[] {
  const paths = new Set<string>();

  const visit = (raw: AnyNode | undefined): void => {
    const current = unwrap(raw);
    if (!current) return;

    const chain = pureSpecChainPath(current, specParam, aliases);
    if (chain) {
      paths.add(chain);
      return;
    }

    switch (current.type) {
      case 'UnaryExpression':
        visit(current.argument as AnyNode);
        return;
      case 'BinaryExpression':
      case 'LogicalExpression':
        visit(current.left as AnyNode);
        visit(current.right as AnyNode);
        return;
      case 'ConditionalExpression':
        visit(current.test as AnyNode);
        visit(current.consequent as AnyNode);
        visit(current.alternate as AnyNode);
        return;
      case 'TemplateLiteral':
        for (const expression of (current.expressions ?? []) as AnyNode[]) visit(expression);
        return;
      case 'SequenceExpression':
        for (const expression of (current.expressions ?? []) as AnyNode[]) visit(expression);
        return;
      default:
        // Calls, functions, object/array literals and everything else are
        // opaque on purpose. See {@link SpecAliasScope}.
        return;
    }
  };

  visit(node);
  return [...paths].filter((path) => path !== 'spec').sort();
}

/**
 * Collect top-level bindings that alias a pure spec member chain.
 *
 * Two forms only: `const enabled = spec.enabled;` and
 * `const { enabled, mode: storageMode } = spec;`.
 */
function buildSpecAliasScope(body: AnyNode[], specParam: string): SpecAliasScope {
  const aliases: SpecAliasScope = new Map();

  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of (statement.declarations ?? []) as AnyNode[]) {
      const init = declarator.init as AnyNode | undefined;
      if (!init) continue;
      const initPath = pureSpecChainPath(init, specParam, aliases);
      if (!initPath) continue;

      const id = declarator.id as AnyNode;
      if (id.type === 'Identifier') {
        aliases.set(id.name as string, initPath);
        continue;
      }
      if (id.type === 'ObjectPattern') {
        for (const property of (id.properties ?? []) as AnyNode[]) {
          if (property.type !== 'Property') continue;
          const key = (property.key as AnyNode)?.name as string | undefined;
          const local = (property.value as AnyNode)?.name as string | undefined;
          if (!key || !local) continue;
          aliases.set(local, `${initPath}.${key}`);
        }
      }
    }
  }

  return aliases;
}

/** True when the subtree registers a resource (any call that is not a bare method chain). */
function containsResourceRegistration(node: AnyNode | undefined): boolean {
  if (!node) return false;
  let found = false;
  estraverse.traverse(node as never, {
    enter(raw) {
      if (found) return estraverse.VisitorOption.Break;
      const current = raw as AnyNode;
      if (current.type !== 'CallExpression' && current.type !== 'NewExpression') return undefined;
      const callee = current.callee as AnyNode;
      // A factory/composition call is an Identifier callee (`ConfigMap(...)`)
      // or a namespaced one (`simple.Deployment(...)`, `kubernetes.core.Service(...)`)
      // whose final segment starts with an uppercase letter.
      const name =
        callee?.type === 'Identifier'
          ? (callee.name as string)
          : ((callee?.property as AnyNode)?.name as string | undefined);
      if (name && /^[A-Z]/.test(name)) {
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
 * The enumerated operand when `node` reads an object's keys — `Object.keys(x)`,
 * `Object.values(x)`, `Object.entries(x)`, or a spread `{ ...x }` / `[ ...x ]`.
 */
function mapEnumerationTarget(node: AnyNode): AnyNode | undefined {
  if (node.type === 'SpreadElement' || node.type === 'RestElement') {
    return node.argument as AnyNode | undefined;
  }
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as AnyNode | undefined;
  if (callee?.type !== 'MemberExpression') return undefined;
  const object = (callee.object as AnyNode | undefined)?.name as string | undefined;
  const method = (callee.property as AnyNode | undefined)?.name as string | undefined;
  if (object !== 'Object') return undefined;
  if (method !== 'keys' && method !== 'values' && method !== 'entries') return undefined;
  return (node.arguments as AnyNode[] | undefined)?.[0];
}

function excerpt(source: string, node: AnyNode, limit = 80): string {
  const start = node.start as number | undefined;
  const end = node.end as number | undefined;
  if (typeof start !== 'number' || typeof end !== 'number') return '<expression>';
  const text = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Report spec-derived structure decisions visible in the composition source
 * that the control-flow analyzer does not compile into KRO constructs.
 *
 * Degrades to an empty result — never to a guess — when the source cannot be
 * parsed or the spec parameter is not a plain identifier.
 */
function analyzeCompositionSource(
  compositionSource: string | undefined
): CompositionSourceAnalysis {
  if (!compositionSource) return { findings: [], mapEnumerationSites: [] };

  let program: AnyNode;
  try {
    program = Parser.parse(compositionSource, {
      ecmaVersion: 2022,
      sourceType: 'script',
      ranges: true,
    }) as unknown as AnyNode;
  } catch {
    try {
      program = Parser.parse(`(${compositionSource})`, {
        ecmaVersion: 2022,
        sourceType: 'script',
        ranges: true,
      }) as unknown as AnyNode;
      // Offsets shift by the added paren; excerpts stay readable either way.
    } catch (error) {
      logger.debug('Composition source could not be parsed for structural analysis', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { findings: [], mapEnumerationSites: [] };
    }
  }

  const fn = findCompositionFunction(program);
  const specParam = fn ? specParamNameOf(fn) : undefined;
  if (!fn || !specParam) return { findings: [], mapEnumerationSites: [] };

  const bodyNode = fn.body as AnyNode;
  const body: AnyNode[] = bodyNode?.type === 'BlockStatement' ? (bodyNode.body as AnyNode[]) : [];
  const aliases = buildSpecAliasScope(body, specParam);

  const findings: StructuralSpecDependenceFinding[] = [];
  const mapEnumerationSites: MapEnumerationSite[] = [];
  const seen = new Set<string>();
  const push = (finding: StructuralSpecDependenceFinding): void => {
    const key = `${finding.kind}|${finding.location}|${finding.specPaths.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  /**
   * A predicate is *compiled* when the analyzer's own gate would fire: the test
   * lexically mentions the spec parameter. Those become `includeWhen` and stay
   * silent here. Anything spec-derived that the gate misses decided the branch
   * at build time.
   */
  const mentionsSpecLexically = (node: AnyNode): boolean => {
    let found = false;
    estraverse.traverse(node as never, {
      enter(raw) {
        if (found) return estraverse.VisitorOption.Break;
        const current = raw as AnyNode;
        if (current.type === 'Identifier' && current.name === specParam) {
          found = true;
          return estraverse.VisitorOption.Break;
        }
        return undefined;
      },
      fallback: 'iteration',
    });
    return found;
  };

  /**
   * `.length` inside a status expression is FINE: the JS→CEL analyzer rewrites
   * `schema.spec.x.length` to `size(schema.spec.x)`, which KRO evaluates per
   * instance. Only a `.length` that lands in a resource TEMPLATE is a
   * build-time constant. Status expressions live in the composition's `return`
   * statement and inside explicit `Cel.*(…)` arguments, so track that context
   * and stay silent there.
   */
  let celContextDepth = 0;
  const opensCelContext = (node: AnyNode): boolean => {
    if (node.type === 'ReturnStatement') return true;
    if (node.type !== 'CallExpression') return false;
    const callee = node.callee as AnyNode | undefined;
    return (
      callee?.type === 'MemberExpression' &&
      ((callee.object as AnyNode | undefined)?.name as string | undefined) === 'Cel'
    );
  };

  estraverse.traverse(fn as never, {
    leave(raw) {
      if (opensCelContext(raw as AnyNode)) celContextDepth -= 1;
    },
    enter(raw) {
      const node = raw as AnyNode;
      if (opensCelContext(node)) celContextDepth += 1;

      if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
        const test = node.test as AnyNode;
        const branchCarriesResources =
          containsResourceRegistration(node.consequent as AnyNode) ||
          containsResourceRegistration(node.alternate as AnyNode);
        if (!branchCarriesResources) return undefined;
        if (mentionsSpecLexically(test)) return undefined;
        const specPaths = specPathsOf(test, specParam, aliases);
        if (specPaths.length === 0) return undefined;
        push({
          kind: 'uncompiled-predicate',
          location: `condition \`${excerpt(compositionSource, test)}\``,
          specPaths,
          detail:
            'the branch decides which resources exist and reaches the spec only through a local ' +
            'binding, so TypeKro could not compile it to a KRO includeWhen and the build-time ' +
            'branch is baked into the RGD',
        });
        return undefined;
      }

      if (node.type === 'SwitchStatement') {
        if (!containsResourceRegistration(node)) return undefined;
        const specPaths = specPathsOf(node.discriminant as AnyNode, specParam, aliases);
        if (specPaths.length === 0) return undefined;
        push({
          kind: 'switch-discriminator',
          location: `switch (${excerpt(compositionSource, node.discriminant as AnyNode, 60)})`,
          specPaths,
          detail:
            'a switch on a spec value selects which resources exist; TypeKro has no lowering for ' +
            'switch, so no case matches the runtime reference and the default branch is baked ' +
            'into the RGD for every instance',
        });
        return undefined;
      }

      if (
        (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
        !node.computed &&
        (node.property as AnyNode)?.name === 'length'
      ) {
        if (celContextDepth > 0) return undefined;
        // A pure chain only: `spec.items.length`, not a `.length` read on a
        // build-time-shaped local that merely mentions the spec somewhere.
        const chain = pureSpecChainPath(node.object as AnyNode, specParam, aliases);
        if (!chain || chain === 'spec') return undefined;
        push({
          kind: 'collection-length-read',
          location: `\`${excerpt(compositionSource, node, 60)}\``,
          specPaths: [chain],
          detail:
            'the schema proxy answers `.length` with the build-time placeholder 1, so the emitted ' +
            'value is a constant rather than the instance’s actual length',
        });
        return undefined;
      }

      const enumerated = mapEnumerationTarget(node);
      if (enumerated) {
        const chain = pureSpecChainPath(enumerated, specParam, aliases);
        if (chain && chain !== 'spec') {
          const site = { location: excerpt(compositionSource, node, 60), specPath: chain };
          if (!mapEnumerationSites.some((existing) => existing.specPath === site.specPath)) {
            mapEnumerationSites.push(site);
          }
        }
      }

      return undefined;
    },
    fallback: 'iteration',
  });

  return { findings, mapEnumerationSites };
}

/**
 * Branch predicates and `.length` reads the control-flow analyzer does not
 * compile. See {@link analyzeCompositionSource}.
 */
export function detectStructuralSpecPredicates(
  compositionSource: string | undefined
): StructuralSpecDependenceFinding[] {
  return analyzeCompositionSource(compositionSource).findings;
}

/**
 * Sites where the composition reads the keys of a spec field at build time.
 *
 * These are CANDIDATES, never findings. Enumerating an *object-typed* spec
 * field is legitimate — the schema proxy is shape-aware and yields the real
 * declared names — and the AST cannot tell that apart from a map-typed field,
 * whose keys exist only per instance. Only the emitted RGD can, by leaving the
 * `__typekroSchemaKey` sentinel behind; but that sentinel carries no path when
 * it was consumed as a plain string. Reporting these alongside such a finding
 * lets the message point at the lines worth reading without claiming any one
 * of them is the culprit.
 */
export function detectMapEnumerationSites(
  compositionSource: string | undefined
): readonly MapEnumerationSite[] {
  return analyzeCompositionSource(compositionSource).mapEnumerationSites;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Remedies, ordered most-specific-first for the kinds present. */
function remediesFor(kinds: ReadonlySet<StructuralSpecDependenceKind>): string[] {
  const remedies: string[] = [];
  if (kinds.has('uncompiled-predicate')) {
    remedies.push(
      'Inline the spec reference into the condition itself (`if (spec.enabled) { … }`) so TypeKro ' +
        'compiles it to a KRO includeWhen.'
    );
  }
  remedies.push(
    'Make it a BUILD-TIME factory option: take the value as an argument to the factory that ' +
      'builds the composition, so the structure is decided before the RGD is emitted, and ship ' +
      'one RGD per shape.'
  );
  remedies.push(
    'Keep the structure FIXED and pass the spec value as a plain field: every resource, list ' +
      'entry and key always exists, and the runtime value only decides what a field contains.'
  );
  return remedies;
}

function formatFinding(finding: StructuralSpecDependenceFinding, index: number): string {
  const paths =
    finding.specPaths.length > 0
      ? finding.specPaths.map((path) => `\`${path}\``).join(', ')
      : '(unresolved spec path)';
  return [
    `  ${index + 1}. [${finding.kind}] ${finding.location}`,
    `     spec value: ${paths}`,
    `     ${finding.detail}`,
  ].join('\n');
}

/** Render the diagnostic text shared by the error and the escape-hatch warning. */
export function formatStructuralSpecDependence(
  graphName: string,
  findings: readonly StructuralSpecDependenceFinding[],
  mapEnumerationSites: readonly MapEnumerationSite[] = []
): string {
  const kinds = new Set(findings.map((finding) => finding.kind));
  const remedies = remediesFor(kinds)
    .map((remedy, index) => `  ${String.fromCharCode(97 + index)}) ${remedy}`)
    .join('\n');
  const candidates =
    mapEnumerationSites.length > 0
      ? [
          '',
          'A placeholder key above carries no spec path, because it was consumed as a plain',
          'string. The composition reads spec keys at build time in these places — one of them',
          'reads a map-typed field whose keys only exist per instance:',
          mapEnumerationSites
            .map((site) => `  - \`${site.location}\` (\`${site.specPath}\`)`)
            .join('\n'),
        ]
      : [];
  return [
    `Resource graph "${graphName}" lets a runtime spec value decide build-time STRUCTURE. ` +
      'TypeKro can only serialize a ResourceGraphDefinition whose shape is fixed: `schema.spec.*` ' +
      'is substituted per instance, so it may decide what a field CONTAINS but never which ' +
      'resources, list entries or keys EXIST.',
    '',
    `${findings.length} structural use${findings.length === 1 ? '' : 's'} of a spec value:`,
    findings.map(formatFinding).join('\n'),
    ...candidates,
    '',
    'Two shapes are legitimate:',
    remedies,
    '',
    'To keep the current behavior while migrating, pass ' +
      '`{ allowStructuralSpecDependence: true }` in the composition options — the RGD is emitted ' +
      'unchanged and this becomes a warning.',
  ].join('\n');
}

/**
 * Whether the structural spec-dependence check ignores per-composition escape
 * hatches.
 *
 * `TYPEKRO_STRUCTURAL_SPEC=strict` makes every structural use an error even
 * when the composition sets `allowStructuralSpecDependence`, so a repository
 * can audit what its shipped graphs still depend on without editing them.
 * Resolved in ONE place, matching `isStrictCelDiagnosticsEnabled`.
 */
export function isStructuralSpecDependenceStrict(): boolean {
  return process.env.TYPEKRO_STRUCTURAL_SPEC === 'strict';
}

/**
 * Gate KRO-mode serialization on structural spec-dependence.
 *
 * Throws {@link StructuralSpecDependenceError} unless `allow` is set, in which
 * case the same report is logged as a warning naming every path.
 */
export function assertNoStructuralSpecDependence(input: {
  graphName: string;
  resources: readonly KroResourceTemplate[];
  compositionSource?: string | undefined;
  allow?: boolean | undefined;
}): void {
  const source = analyzeCompositionSource(input.compositionSource);
  const findings = [
    ...scanRgdResourcesForStructuralSpecArtifacts(input.resources),
    ...source.findings,
  ];
  if (findings.length === 0) return;

  // Offer the enumeration candidates only when a sentinel finding could not
  // name its own path — the AST cannot prove which site produced it.
  const needsCandidates = findings.some(
    (finding) => finding.kind === 'runtime-map-enumerated' && finding.specPaths.length === 0
  );
  const message = formatStructuralSpecDependence(
    input.graphName,
    findings,
    needsCandidates ? source.mapEnumerationSites : []
  );
  if (input.allow && !isStructuralSpecDependenceStrict()) {
    logger.warn(message, {
      graphName: input.graphName,
      specPaths: [...new Set(findings.flatMap((finding) => finding.specPaths))],
      kinds: [...new Set(findings.map((finding) => finding.kind))],
    });
    return;
  }
  throw new StructuralSpecDependenceError(message, input.graphName, findings);
}
