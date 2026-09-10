/**
 * Literal status-leaf validation for KRO mode.
 *
 * KRO only populates an instance's `status` from expressions it can resolve
 * against the graph's own resources. A status leaf that is a bare literal
 * (a string, number, boolean, or a literal array/object) is not an expression
 * KRO resolves — it is simply left unset on the instance. The declared status
 * schema then promises a field that the custom resource never carries, and
 * every consumer that reads the CR directly (kubectl, another controller, an
 * `externalRef` from a second composition) sees `undefined`.
 *
 * TypeKro classifies such leaves as "static" and hydrates them client-side in
 * `getStatus()`, which hides the gap from the composition's own author while
 * leaving it wide open for everybody else. This module finds those leaves at
 * serialization time so the author is told before the RGD ships.
 *
 * Direct mode is unaffected — there is no KRO reconciler in that path and the
 * status object is assembled locally, so literals are perfectly fine. The
 * check therefore runs only from the KRO schema emitter.
 *
 * See issue #188.
 */

import { celRootReferences } from '../../utils/cel-resource-identifiers.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { lookupNestedExpression } from '../serialization/cel-references.js';

/** One status leaf that would be dropped by KRO. */
export interface LiteralStatusLeaf {
  /** Full status path, e.g. `status.url`, `status.info.mode`, `status.entrypoints[0]`. */
  readonly path: string;
  /** Rendered form of the offending value, for the diagnostic message. */
  readonly literal: string;
}

/** Longest rendered literal included in a diagnostic before truncation. */
const MAX_RENDERED_LITERAL_LENGTH = 60;

/**
 * Does this plain status string carry a reference?
 *
 * A plain string is ordinary data, not CEL, so it must never be handed
 * wholesale to the CEL analyzer: `'http://static.example.test'` would parse as
 * the identifiers `http`, `static`, `example` and `test` and read as four
 * references to resources that do not exist. Only two shapes count:
 *
 *  - a TypeKro ref marker, resource (`__KUBERNETES_REF_<id>_<path>__`) or
 *    schema (`__KUBERNETES_REF___schema___spec.name__`) — KRO resolves the
 *    first and already holds the value for the second;
 *  - a `${...}` interpolation, which the status analyzer emits for a mixed
 *    template or an already-converted CEL expression. Those DO get analyzed,
 *    so a hand-written `${"idle"}` is still caught.
 */
function stringReferencesSomething(value: string): boolean {
  if (value.includes('__KUBERNETES_REF_')) return true;
  if (!value.includes('${')) return false;
  return celRootReferences(value).length > 0;
}

/**
 * Does this CEL expression reference anything KRO can resolve?
 *
 * Accepts every expression shape the status analyzer produces:
 *  - ref markers, resource or schema
 *  - KRO mixed templates (`http://${svc.status.clusterIP}`)
 *  - plain CEL (`deploy.status.readyReplicas > 0`, `schema.spec.name`)
 *
 * A reference-free expression — `'"web"'`, `'41.5'`, `'true'` — is a literal in
 * CEL clothing and gets dropped exactly like a bare literal would.
 *
 * CEL string literals never surface as identifier nodes and macro-bound lambda
 * variables are excluded, so `['a','b'].map(x, x)` does not read as a
 * reference to `x`.
 */
function expressionReferencesSomething(expression: string): boolean {
  if (expression.includes('__KUBERNETES_REF_')) return true;
  return celRootReferences(expression).length > 0;
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

/**
 * Walk one status value, appending every literal leaf found beneath it.
 */
function collectLeaves(
  value: unknown,
  path: string,
  nestedStatusCel: Record<string, string> | undefined,
  found: LiteralStatusLeaf[]
): void {
  // A projection of a graph resource, or a `schema.spec.*` reference. Both are
  // expressions KRO (or, for schema refs, the CR spec it already holds) can
  // resolve, so neither is a literal.
  if (isKubernetesRef(value)) {
    const nestedRef = (value as { __nestedComposition?: boolean }).__nestedComposition === true;
    if (!nestedRef || !nestedStatusCel || typeof value.fieldPath !== 'string') return;

    // A nested composition's status field is only as projectable as the
    // expression the inner composition put behind it: `outer.ready` is a
    // literal leaf when the inner `ready` was `true`. Resolve one level and
    // classify what is actually there. An unresolvable reference is left
    // alone — `validateStatusCelExpressions` reports those structurally.
    const innerExpression = lookupNestedExpression(
      value.resourceId,
      value.fieldPath.replace(/^status\./, ''),
      nestedStatusCel
    );
    if (innerExpression !== undefined && !expressionReferencesSomething(innerExpression)) {
      found.push({ path, literal: renderLiteral(innerExpression) });
    }
    return;
  }

  if (isCelExpression(value)) {
    if (!expressionReferencesSomething(value.expression)) {
      found.push({ path, literal: renderLiteral(value.expression) });
    }
    return;
  }

  if (Array.isArray(value)) {
    // An empty array is itself the dropped value — there are no elements to
    // blame, so report the field.
    if (value.length === 0) {
      found.push({ path, literal: '[]' });
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
      found.push({ path, literal: '{}' });
      return;
    }
    for (const [key, nested] of entries) {
      if (nested === undefined) continue;
      collectLeaves(nested, `${path}.${key}`, nestedStatusCel, found);
    }
    return;
  }

  // Template-literal analysis leaves ref markers in plain strings; those are
  // references. Everything else here is a bare literal.
  if (typeof value === 'string') {
    if (!stringReferencesSomething(value)) {
      found.push({ path, literal: renderLiteral(value) });
    }
    return;
  }

  if (value === undefined) return;
  found.push({ path, literal: renderLiteral(value) });
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
 * Human-readable diagnostic for a set of literal status leaves.
 */
export function formatLiteralStatusLeaves(leaves: readonly LiteralStatusLeaf[]): string {
  const paths = leaves.map((leaf) => `  - ${leaf.path} = ${leaf.literal}`).join('\n');
  return (
    'KRO leaves literal status fields unset, so the declared status schema would promise ' +
    `${leaves.length === 1 ? 'a field' : 'fields'} the instance never carries:\n${paths}\n` +
    'Project each leaf from a resource this graph owns (for example, put the value in a ' +
    'ConfigMap you create and reference `myConfigMap.data.<key>`), or remove the field from ' +
    'the status schema. Set `allowLiteralStatus: true` to log these paths instead of failing ' +
    'while migrating.'
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
