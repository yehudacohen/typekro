/**
 * Dropped status-leaf validation for KRO mode.
 *
 * THE RULE: a KRO status field must reference at least one RESOURCE in the
 * graph. KRO's own instance builder enforces exactly that — `instance status
 * field must refer to a resource` (KRO `builder.go`, quoted in
 * `kro-instance-safety.ts`) — and its status CEL environment has no `schema`
 * identifier at all. A status expression with no resource in it therefore has
 * nothing to project from and is left unset on the instance. The declared
 * status schema then promises a field the custom resource never carries, and
 * every consumer that reads the CR directly (kubectl, another controller, an
 * `externalRef` from a second composition) sees `undefined`.
 *
 * Two shapes have no resource in them, and KRO drops BOTH the same way:
 *
 *  - a bare LITERAL — a string, number, boolean, literal array/object, or a
 *    reference-free CEL expression such as `Cel.expr`'running'``;
 *  - a bare SCHEMA REFERENCE — `schema.spec.foo` standing alone in a status
 *    leaf. It looks resolvable (the CR does hold that value in its own spec),
 *    but a status leaf is a PROJECTION, and there is no resource here to
 *    project from. TypeKro's own serializer already agrees: it classifies a
 *    schema-only status field as "static" and excludes it from the emitted
 *    status block — see invariant I1/I2 in
 *    `test/unit/nested-composition-kro-serialization.test.ts` ("KRO status CEL
 *    does NOT support `schema.spec.*`"), the same conclusion in
 *    `src/core/proxy/create-resource.ts` ("classifies the resulting status
 *    field as schema-derived and drops it from the live KRO CR's status
 *    entirely"), and `assertNoHoistWeakenedStatusFields`, which already THROWS
 *    for precisely this shape when a hoisted Namespace leaves a field
 *    schema-only. This module simply makes the general case agree with that
 *    special one.
 *
 * What stays valid is any expression ANCHORED on a resource. A mixed template
 * such as `` `http://${schema.spec.name}-svc:${svc.spec.ports[0].port}` `` is
 * fine: the resource reference gives KRO the dependency it requires, and
 * `schema.spec.*` resolves against the instance's own spec from there. The
 * serializer deliberately preserves those (`cel-references.ts`: "Plain CR spec
 * fields must remain `schema.spec.*`"), and
 * `nested-composition-kro-serialization.test.ts` pins the emitted shape. So the
 * test is not "does this mention `schema`" but "does this reference a
 * resource".
 *
 * TypeKro classified both dropped shapes as "static" and hydrated them
 * client-side in `getStatus()`, which hides the gap from the composition's own
 * author while leaving it wide open for everybody else. This module finds those
 * leaves at serialization time so the author is told before the RGD ships.
 *
 * Direct mode is unaffected — there is no KRO reconciler in that path and the
 * status object is assembled locally, so literals and schema refs are perfectly
 * fine there. The check therefore runs only from the KRO schema emitter.
 *
 * See issue #188.
 */

import {
  KUBERNETES_REF_MARKER_SOURCE,
  KUBERNETES_REF_SCHEMA_MARKER_SOURCE,
} from '../../shared/brands.js';
import {
  celRootReferences,
  kubernetesMarkerReferences,
} from '../../utils/cel-resource-identifiers.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { lookupNestedExpression } from '../serialization/cel-references.js';

/** Why a status leaf never reaches the instance. */
export type DroppedStatusLeafKind =
  /** A bare literal, or a reference-free CEL expression. */
  | 'literal'
  /** A `schema.spec.*` reference with no resource to anchor it. */
  | 'schema-reference';

/** One status leaf that would be dropped by KRO. */
export interface LiteralStatusLeaf {
  /** Full status path, e.g. `status.url`, `status.info.mode`, `status.entrypoints[0]`. */
  readonly path: string;
  /** Rendered form of the offending value, for the diagnostic message. */
  readonly literal: string;
  /** Which of the two no-resource shapes this leaf is. */
  readonly kind: DroppedStatusLeafKind;
}

/** Longest rendered literal included in a diagnostic before truncation. */
const MAX_RENDERED_LITERAL_LENGTH = 60;

/**
 * CEL roots that are NOT a resource: the instance's own spec, in both the
 * pre-rewrite (`__schema__`) and emitted (`schema`) spellings.
 */
const SCHEMA_REFERENCE_ROOTS: ReadonlySet<string> = new Set(['schema', '__schema__']);

const REF_MARKER_PATTERN = new RegExp(KUBERNETES_REF_MARKER_SOURCE, 'g');
const SCHEMA_REF_MARKER_PATTERN = new RegExp(KUBERNETES_REF_SCHEMA_MARKER_SOURCE);

/**
 * Blank every TypeKro ref marker out of an expression before CEL analysis.
 *
 * Markers are read by {@link kubernetesMarkerReferences}, never by the CEL
 * parser: a marker's own text (`__KUBERNETES_REF___schema___spec_name__`) is a
 * legal CEL identifier, so leaving it in place would make a SCHEMA marker parse
 * as a root named `__KUBERNETES_REF___schema___spec` — i.e. read as a resource.
 * Replacing each with an empty string literal keeps the surrounding expression
 * parseable while contributing no references of its own.
 */
function stripRefMarkers(expression: string): string {
  return expression.replace(REF_MARKER_PATTERN, '""');
}

/**
 * Does this CEL expression reference at least one RESOURCE?
 *
 * Handles every expression shape the status analyzer produces: ref markers,
 * KRO mixed templates (`http://${svc.status.clusterIP}`), and plain CEL
 * (`deploy.status.readyReplicas > 0`).
 *
 * `kubernetesMarkerReferences` already drops the `__schema__` root, so a marker
 * hit is by construction a resource. For the parsed form, a root of `schema` /
 * `__schema__` is the instance's own spec rather than a resource, so it does
 * not anchor the leaf.
 *
 * A reference-free expression — `'"web"'`, `'41.5'`, `'true'` — is a literal in
 * CEL clothing and gets dropped exactly like a bare literal would.
 *
 * CEL string literals never surface as identifier nodes and macro-bound lambda
 * variables are excluded, so `['a','b'].map(x, x)` does not read as a
 * reference to `x`.
 */
function expressionReferencesResource(expression: string): boolean {
  if (kubernetesMarkerReferences(expression).length > 0) return true;
  return celRootReferences(stripRefMarkers(expression)).some(
    (reference) => !SCHEMA_REFERENCE_ROOTS.has(reference.root)
  );
}

/** Does this CEL expression mention the instance's own spec? */
function expressionReferencesSchema(expression: string): boolean {
  if (SCHEMA_REF_MARKER_PATTERN.test(expression)) return true;
  return celRootReferences(stripRefMarkers(expression)).some((reference) =>
    SCHEMA_REFERENCE_ROOTS.has(reference.root)
  );
}

/**
 * Is this plain status string safe to hand to the CEL analyzer at all?
 *
 * A plain string is ordinary data, not CEL, so it must never be analyzed
 * wholesale: `'http://static.example.test'` would parse as the identifiers
 * `http`, `static`, `example` and `test` and read as four references to
 * resources that do not exist. Only two shapes are expressions:
 *
 *  - a TypeKro ref marker, resource (`__KUBERNETES_REF_<id>_<path>__`) or
 *    schema (`__KUBERNETES_REF___schema___spec.name__`);
 *  - a `${...}` interpolation, which the status analyzer emits for a mixed
 *    template or an already-converted CEL expression. Those DO get analyzed,
 *    so a hand-written `${"idle"}` is still caught.
 */
function stringIsExpression(value: string): boolean {
  return value.includes('__KUBERNETES_REF_') || value.includes('${');
}

/** Does this plain status string reference at least one resource? */
function stringReferencesResource(value: string): boolean {
  return stringIsExpression(value) && expressionReferencesResource(value);
}

/** Does this plain status string reference the instance's own spec? */
function stringReferencesSchema(value: string): boolean {
  return stringIsExpression(value) && expressionReferencesSchema(value);
}

function renderLiteral(value: unknown): string {
  const rendered =
    value === undefined
      ? 'undefined'
      : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? JSON.stringify(value)
        : (JSON.stringify(value) ?? String(value));
  return rendered.length > MAX_RENDERED_LITERAL_LENGTH
    ? `${rendered.slice(0, MAX_RENDERED_LITERAL_LENGTH)}…`
    : rendered;
}

function isPlainStatusObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value)
  );
}

/** Is this ref the instance's own spec rather than a graph resource? */
function isSchemaRef(value: { resourceId: string }): boolean {
  return SCHEMA_REFERENCE_ROOTS.has(value.resourceId);
}

/**
 * Put ref markers back into the form the author would recognise:
 * `__KUBERNETES_REF___schema___spec.name__` reads as `${schema.spec.name}`.
 *
 * Markers are an internal encoding of template-literal analysis. Printing one
 * raw makes the diagnostic look like a TypeKro bug rather than a description of
 * the author's own status field.
 */
function humanizeRefMarkers(expression: string): string {
  return expression.replace(REF_MARKER_PATTERN, (_match, root: string, fieldPath: string) => {
    const readableRoot = root === '__schema__' ? 'schema' : root;
    return `\${${readableRoot}.${fieldPath}}`;
  });
}

/**
 * Render an expression as itself, unquoted — `schema.spec.foo`, not
 * `"schema.spec.foo"`. Quoting a reference would read as a string literal and
 * misdescribe what the author actually wrote.
 */
function renderExpression(expression: string): string {
  const readable = humanizeRefMarkers(expression);
  return readable.length > MAX_RENDERED_LITERAL_LENGTH
    ? `${readable.slice(0, MAX_RENDERED_LITERAL_LENGTH)}…`
    : readable;
}

/** Render a bare schema ref the way the author wrote it: `schema.spec.foo`. */
function renderSchemaRef(fieldPath: string): string {
  return renderExpression(`schema.${fieldPath.replace(/^schema\./, '')}`);
}

/**
 * Classify an expression that has already been found to reference no resource.
 */
function droppedExpressionLeaf(path: string, expression: string): LiteralStatusLeaf {
  return expressionReferencesSchema(expression)
    ? { path, literal: renderExpression(expression), kind: 'schema-reference' }
    : { path, literal: renderLiteral(expression), kind: 'literal' };
}

/**
 * Walk one status value, appending every leaf KRO would drop from beneath it.
 */
function collectLeaves(
  value: unknown,
  path: string,
  nestedStatusCel: Record<string, string> | undefined,
  found: LiteralStatusLeaf[]
): void {
  if (isKubernetesRef(value)) {
    const nestedRef = (value as { __nestedComposition?: boolean }).__nestedComposition === true;

    if (!nestedRef) {
      // A projection of a graph resource anchors the leaf and is exactly what
      // KRO wants. A bare `schema.spec.*` does not: it is the instance's own
      // spec, not a resource, so KRO has nothing to project and leaves the
      // field unset — the same outcome as a literal, by the same mechanism.
      if (isSchemaRef(value) && typeof value.fieldPath === 'string') {
        found.push({
          path,
          literal: renderSchemaRef(value.fieldPath),
          kind: 'schema-reference',
        });
      }
      return;
    }

    if (!nestedStatusCel || typeof value.fieldPath !== 'string') return;

    // A nested composition's status field is only as projectable as the
    // expression the inner composition put behind it: `outer.ready` is a
    // dropped leaf when the inner `ready` was `true`, and equally when it was a
    // `schema.spec` passthrough — flattening does not give either one a
    // resource to project from. Resolve one level and classify what is actually
    // there. An unresolvable reference is left alone —
    // `validateStatusCelExpressions` reports those structurally.
    const innerExpression = lookupNestedExpression(
      value.resourceId,
      value.fieldPath.replace(/^status\./, ''),
      nestedStatusCel
    );
    if (innerExpression !== undefined && !expressionReferencesResource(innerExpression)) {
      found.push(droppedExpressionLeaf(path, innerExpression));
    }
    return;
  }

  if (isCelExpression(value)) {
    if (!expressionReferencesResource(value.expression)) {
      found.push(droppedExpressionLeaf(path, value.expression));
    }
    return;
  }

  if (Array.isArray(value)) {
    // An empty array is itself the dropped value — there are no elements to
    // blame, so report the field.
    if (value.length === 0) {
      found.push({ path, literal: '[]', kind: 'literal' });
      return;
    }
    value.forEach((item, index) => {
      collectLeaves(item, `${path}[${index}]`, nestedStatusCel, found);
    });
    return;
  }

  if (isPlainStatusObject(value)) {
    const entries = Object.entries(value).filter(([key]) => !key.startsWith('__'));
    if (entries.length === 0) {
      found.push({ path, literal: '{}', kind: 'literal' });
      return;
    }
    for (const [key, nested] of entries) {
      if (nested === undefined) continue;
      collectLeaves(nested, `${path}.${key}`, nestedStatusCel, found);
    }
    return;
  }

  // Template-literal analysis leaves ref markers and `${...}` interpolations in
  // plain strings; only those are expressions, and only a resource inside one
  // anchors the leaf. Everything else here is bare data.
  if (typeof value === 'string') {
    if (!stringReferencesResource(value)) {
      found.push(
        stringReferencesSchema(value)
          ? { path, literal: renderExpression(value), kind: 'schema-reference' }
          : { path, literal: renderLiteral(value), kind: 'literal' }
      );
    }
    return;
  }

  if (value === undefined) return;
  found.push({ path, literal: renderLiteral(value), kind: 'literal' });
}

/**
 * Find every status leaf that KRO would leave unset.
 *
 * `statusMappings` is the analyzed status mapping (post-CEL-conversion,
 * pre-static/dynamic split) — the split is exactly what hides the problem, so
 * the walk has to happen before it.
 */
export function findLiteralStatusLeaves(
  statusMappings: Readonly<Record<string, unknown>> | undefined,
  nestedStatusCel?: Record<string, string>
): readonly LiteralStatusLeaf[] {
  if (!statusMappings || typeof statusMappings !== 'object') return [];

  const found: LiteralStatusLeaf[] = [];
  for (const [fieldName, fieldValue] of Object.entries(statusMappings)) {
    // Internal serialization metadata, not user-facing status.
    if (fieldName.startsWith('__') || fieldValue === undefined) continue;
    collectLeaves(fieldValue, `status.${fieldName}`, nestedStatusCel, found);
  }
  return found;
}

/**
 * Human-readable diagnostic for a set of dropped status leaves.
 */
export function formatLiteralStatusLeaves(leaves: readonly LiteralStatusLeaf[]): string {
  const paths = leaves
    .map(
      (leaf) =>
        `  - ${leaf.path} = ${leaf.literal}` +
        (leaf.kind === 'schema-reference' ? ' (schema reference — no resource to project from)' : '')
    )
    .join('\n');
  const schemaNote = leaves.some((leaf) => leaf.kind === 'schema-reference')
    ? ' A bare `schema.spec.*` is dropped for the same reason a literal is: KRO requires every ' +
      'status field to refer to a resource, and its status CEL has no `schema` identifier. It ' +
      'stays valid INSIDE an expression that also references a resource — a template ' +
      'interpolating both `myService.metadata.name` and `schema.spec.namespace` is anchored by ' +
      'the resource, and the spec value resolves from there. To surface a spec value on its ' +
      'own, project it through a resource this graph owns: echo it into a ConfigMap (or an ' +
      'annotation) you create and read it back.'
    : '';
  return (
    "KRO fills a status field only from the graph's own resources, so it leaves these fields " +
    'unset and the declared status schema would promise ' +
    `${leaves.length === 1 ? 'a field' : 'fields'} the instance never carries:\n${paths}\n` +
    'Project each leaf from a resource this graph owns (for example, put the value in a ' +
    'ConfigMap you create and reference `myConfigMap.data.<key>`), or remove the field from ' +
    `the status schema.${schemaNote} Set \`allowLiteralStatus: true\` to log these paths instead ` +
    'of failing while migrating.'
  );
}

/**
 * Default for `allowLiteralStatus` — i.e. whether a literal status leaf warns
 * rather than throwing.
 *
 * `true` (warn) for now. The check is correct and the diagnostic is actionable,
 * but literal status leaves are not a rare mistake in existing code: turning
 * this on as a hard error against the repository's own suite rejected 377
 * serializations across 69 test files and every bootstrap composition listed in
 * `test/unit/literal-status-repo-scan.test.ts`. Shipping that as a patch-level
 * error would break every downstream composition using the same shape, with no
 * migration window.
 *
 * So: warn by default, and let a composition (or a CI job, via the factory
 * option) opt into the error with `allowLiteralStatus: false` today. Flip this
 * constant to `false` in the next major once the bundled compositions are
 * projections — that single edit is the whole migration.
 */
export const DEFAULT_ALLOW_LITERAL_STATUS = true;

/**
 * Resolve the effective `allowLiteralStatus` setting.
 *
 * A factory-level setting wins over the composition's own, so a CI job can run
 * `graph.factory('kro', { allowLiteralStatus: false }).toYaml()` to enforce
 * projection across compositions it does not own.
 */
export function resolveAllowLiteralStatus(
  factoryOption: boolean | undefined,
  compositionOption: boolean | undefined
): boolean {
  return factoryOption ?? compositionOption ?? DEFAULT_ALLOW_LITERAL_STATUS;
}
