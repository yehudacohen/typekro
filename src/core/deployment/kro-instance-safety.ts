import { CEL_EXPRESSION_BRAND } from '../../shared/brands.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { getIncludeWhen } from '../metadata/index.js';
import type { SingletonDefinitionRecord } from '../types/deployment.js';
import type { KubernetesResource } from '../types/kubernetes.js';
import type { KroCompatibleType } from '../types/serialization.js';
import { evaluateSchemaCelExpression } from './schema-cel-evaluator.js';

type ResourceCollection = Record<string, KubernetesResource> | readonly KubernetesResource[];

export interface KroInstanceNamespaceSafetyInput<TSpec extends KroCompatibleType> {
  readonly compositionName: string;
  readonly instanceNamespace: string;
  readonly spec: TSpec;
  readonly resources?: ResourceCollection;
  readonly compositionFn?: (spec: TSpec) => unknown;
  /**
   * Namespace names the factory has HOISTED out of the RGD graph (emitted as
   * retained resources OUTSIDE the graph, created deps-first). A hoisted
   * namespace is no longer a graph-owned child, so it can never be garbage
   * collected when the instance CR is deleted — the finalizer-stranding concern
   * this guard protects against is structurally resolved. The guard therefore
   * treats an owned namespace that has been hoisted as SAFE, even though it still
   * appears in the composition's resources. Everything NOT hoisted (an owned
   * namespace whose name can't be proven, or one the caller EXPLICITLY pinned the
   * instance back into) still throws.
   */
  readonly hoistedNamespaces?: ReadonlySet<string>;
}

interface CompositionSafetyMetadata {
  readonly name?: string;
  readonly resources?: readonly KubernetesResource[];
  readonly _compositionFn?: (spec: KroCompatibleType) => unknown;
}

function resourceEntries(
  resources: ResourceCollection | undefined
): [string, KubernetesResource][] {
  if (!resources) return [];
  return Array.isArray(resources)
    ? resources.map((resource, index) => [String(index), resource])
    : Object.entries(resources);
}

function resolveSpecPath(spec: KroCompatibleType, fieldPath: string): unknown {
  const parts = fieldPath.replace(/^spec\./, '').split('.');
  let current: unknown = spec;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveNamespaceName(value: unknown, spec: KroCompatibleType): string | undefined {
  if (isKubernetesRef(value)) {
    if (value.resourceId !== '__schema__') return undefined;
    const resolved = resolveSpecPath(spec, value.fieldPath);
    return resolved === undefined || resolved === null ? undefined : String(resolved);
  }

  if (isCelExpression(value)) {
    const expression = value.expression.trim().replace(/^\$\{\s*|\s*\}$/g, '');
    // A concrete re-execution turns Cel.expr(spec.namespace) into a bare
    // DNS-label expression body. It is already the resolved namespace.
    if (/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(expression)) {
      return expression;
    }

    try {
      const resolved = evaluateSchemaCelExpression(value, spec);
      return typeof resolved === 'string' ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  if (typeof value !== 'string') return undefined;
  const marker = new RegExp(KUBERNETES_REF_SCHEMA_MARKER_SOURCE, 'g');
  let unresolved = false;
  const resolved = value.replace(marker, (_match, fieldPath: string) => {
    const fieldValue = resolveSpecPath(spec, fieldPath);
    if (fieldValue === undefined || fieldValue === null) {
      unresolved = true;
      return _match;
    }
    return String(fieldValue);
  });
  return unresolved ? undefined : resolved;
}

function concreteResources<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): [string, KubernetesResource][] {
  if (!input.compositionFn) return resourceEntries(input.resources);

  const context = createCompositionContext(`kro-instance-safety-${input.compositionName}`, {
    deduplicateIds: true,
    isReExecution: true,
  });
  runWithCompositionContext(context, () => input.compositionFn?.(input.spec));
  const executed = Object.entries(context.resources) as [string, KubernetesResource][];
  return executed;
}

function concreteBoolean(value: unknown, spec: KroCompatibleType): boolean | undefined {
  if (typeof value === 'boolean') return value;

  if (isKubernetesRef(value)) {
    if (value.resourceId !== '__schema__') return undefined;
    const resolved = resolveSpecPath(spec, value.fieldPath);
    return typeof resolved === 'boolean' ? resolved : undefined;
  }

  if (isCelExpression(value)) {
    try {
      const resolved = evaluateSchemaCelExpression(value, spec);
      return typeof resolved === 'boolean' ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^\$\{\s*|\s*\}$/g, '');
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  const schemaPath = /^(?:schema\.)?(spec\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(
    normalized
  )?.[1];
  if (!schemaPath) return undefined;
  const resolved = resolveSpecPath(spec, schemaPath);
  return typeof resolved === 'boolean' ? resolved : undefined;
}

export function isActiveOwnedResource(
  resource: KubernetesResource,
  spec: KroCompatibleType
): boolean {
  if (Reflect.get(resource, '__externalRef') === true) return false;

  const metadataConditions = getIncludeWhen(resource);
  const legacyConditions = Reflect.get(resource, 'includeWhen');
  const conditions =
    metadataConditions ?? (Array.isArray(legacyConditions) ? legacyConditions : undefined);
  return !conditions?.some((condition) => concreteBoolean(condition, spec) === false);
}

/**
 * The concrete Namespaces a composition actively creates and OWNS as graph
 * children, resolved against the concrete instance spec.
 *
 * `owned` holds the resolved names; `unresolved` holds the resource ids of owned
 * Namespaces whose name cannot be evaluated from the spec (so their safety
 * cannot be proven). This is the single detection primitive shared by the
 * ownership GUARD ({@link assertKroInstanceNamespaceOwnershipSafe}) and the
 * workload-namespace HOISTING logic in the KRO factory: a composition owns its
 * instance namespace exactly when the resolved instance namespace is in `owned`.
 */
export interface OwnedNamespaceDetection {
  readonly owned: ReadonlySet<string>;
  readonly unresolved: readonly string[];
}

/**
 * Per-resource detection: for each actively-owned Namespace, its resource id
 * mapped to its resolved concrete name. `unresolved` holds the ids of owned
 * Namespaces whose name cannot be evaluated from the spec.
 *
 * The resource ids are stable across the re-execution used here (dedup + explicit
 * `id`s), so a factory can match them back to its own `resources` to HOIST the
 * owned namespace out of the RGD graph. Re-execution is also what resolves the
 * schema-driven names to concrete values (the built `resources` carry `${...}`
 * KRO templates that can't be evaluated directly).
 */
export function detectOwnedNamespaceResources<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): { ownedById: Map<string, string>; unresolved: string[] } {
  const ownedById = new Map<string, string>();
  const unresolved: string[] = [];
  for (const [resourceId, resource] of concreteResources(input)) {
    if (resource.kind !== 'Namespace') continue;
    if (!isActiveOwnedResource(resource, input.spec)) continue;

    const ownedNamespace = resolveNamespaceName(resource.metadata?.name, input.spec);
    if (ownedNamespace === undefined) {
      unresolved.push(resourceId);
    } else {
      ownedById.set(resourceId, ownedNamespace);
    }
  }
  return { ownedById, unresolved };
}

export function detectOwnedNamespaces<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): OwnedNamespaceDetection {
  const { ownedById, unresolved } = detectOwnedNamespaceResources(input);
  return { owned: new Set(ownedById.values()), unresolved };
}

/**
 * The CONCRETE (re-executed against the spec) resource objects for each
 * actively-owned Namespace, keyed by resource id. Unlike
 * {@link detectOwnedNamespaceResources} (which returns only the resolved names),
 * this returns the full concrete metadata — labels (incl. Pod Security),
 * annotations, name — so the KRO factory can PRESERVE the original Namespace
 * configuration when it hoists the Namespace out of the graph and re-emits it as
 * a retained resource (finding #5), rather than synthesizing a bare Namespace.
 */
export function concreteOwnedNamespaceResources<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): Map<string, KubernetesResource> {
  const byId = new Map<string, KubernetesResource>();
  for (const [resourceId, resource] of concreteResources(input)) {
    if (resource.kind !== 'Namespace') continue;
    if (!isActiveOwnedResource(resource, input.spec)) continue;
    byId.set(resourceId, resource);
  }
  return byId;
}

/**
 * Whether a name expression, IN ITS ENTIRETY, is exactly the schema field
 * `spec.namespace` — the single field the instance namespace is derived from.
 *
 * This is a STRUCTURAL equivalence check (finding #4), not substring matching.
 * A Namespace is hoistable out of the SHARED RGD only when it can be PROVEN,
 * spec-independently, that for every instance its name === the instance's
 * resolved namespace. That holds exactly when the whole name expression is:
 *   - a bare `spec.namespace` / `schema.spec.namespace` (optionally `string(...)`
 *     wrapped), or
 *   - the `spec.namespace || <default>` idiom, which the JS→CEL compiler emits as
 *     `has(schema.spec.namespace) ? schema.spec.namespace : "<literal>"` — the
 *     active value is still the single field `spec.namespace`, and the literal
 *     only applies when the field is absent (in which case the instance couldn't
 *     land in a schema-driven namespace either), or
 *   - the raw `__KUBERNETES_REF___schema___spec.namespace__` marker (whole string).
 *
 * Anything else — a literal, a DIFFERENT field, a concatenation, a prefix/suffix,
 * or any other transform — is NOT provable and FAILS CLOSED (not hoisted; the
 * ownership guard then decides its safety per concrete spec).
 */
/** Strip one layer of redundant, fully-enclosing parentheses. */
function stripOuterParens(expr: string): string {
  let out = expr.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let depth = 0;
    let enclosing = true;
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i < out.length - 1) {
          enclosing = false;
          break;
        }
      }
    }
    if (!enclosing) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

/** Split `<true> : <false>` at the top-level (paren/quote-aware) `:`. */
function splitTopLevelColon(expr: string): [string, string] | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ':' && depth === 0) return [expr.slice(0, i), expr.slice(i + 1)];
  }
  return undefined;
}

function isStringLiteral(expr: string): boolean {
  return /^"[^"]*"$/.test(expr) || /^'[^']*'$/.test(expr);
}

/**
 * Whether a CEL body, in its entirety, tracks the single schema field
 * `spec.namespace`. Handles the bare field, the raw schema marker, and the
 * `spec.namespace || <default>` idiom compiled to a `has()`-guarded ternary —
 * INCLUDING arbitrary nesting of that idiom (`has(x) ? (has(x) ? x : "lit") :
 * "lit"`, which layered defaulting produces), because the active value is always
 * `spec.namespace` and every fallback branch is a string literal.
 */
function tracksSchemaNamespaceBody(expr: string): boolean {
  const body = stripOuterParens(expr.trim());
  // Bare field access (optionally `string(...)`-wrapped, optionally schema-prefixed).
  if (/^(?:string\(\s*)?(?:schema\.)?spec\.namespace(?:\s*\))?$/.test(body)) return true;
  // Raw schema-ref marker for `spec.namespace` (whole string, no surrounding text).
  if (/^__KUBERNETES_REF___schema___spec\.namespace__$/.test(body)) return true;
  // `has(schema.spec.namespace) ? <tracks-namespace> : "<literal>"`.
  const guard = /^has\(\s*(?:schema\.)?spec\.namespace\s*\)\s*\?([\s\S]*)$/.exec(body);
  if (!guard?.[1]) return false;
  const split = splitTopLevelColon(guard[1]);
  if (!split) return false;
  const [trueBranch, falseBranch] = split;
  // The fallback must be a plain string literal (the `|| "default"` value)...
  if (!isStringLiteral(stripOuterParens(falseBranch.trim()))) return false;
  // ...and the active branch must itself track `spec.namespace` (allows nesting).
  return tracksSchemaNamespaceBody(trueBranch);
}

function isExactSchemaNamespaceExpression(raw: string): boolean {
  const body = raw
    .trim()
    .replace(/^\$\{\s*/, '')
    .replace(/\s*\}$/, '')
    .trim();
  return tracksSchemaNamespaceBody(body);
}

/**
 * Whether a Namespace resource's name STRUCTURALLY tracks the schema field the
 * instance namespace is derived from (`spec.namespace`). Used on the spec-less RGD
 * path where a schema-driven name can't be resolved to a concrete value, but a
 * Namespace whose name is EXACTLY `spec.namespace` always coincides, per instance,
 * with the namespace that instance lands in — so it must be hoisted out of the
 * shared RGD. See {@link isExactSchemaNamespaceExpression} for the exact grammar.
 */
export function namespaceNameTracksSchemaNamespace(name: unknown): boolean {
  if (isKubernetesRef(name)) {
    // A schema namespace ref is `__schema__` with fieldPath `spec.namespace` (the
    // real convention) or the bare `namespace` alias — both resolve to the single
    // field `spec.namespace`.
    return (
      name.resourceId === '__schema__' &&
      (name.fieldPath === 'spec.namespace' || name.fieldPath === 'namespace')
    );
  }
  if (isCelExpression(name)) {
    return isExactSchemaNamespaceExpression(name.expression);
  }
  if (typeof name === 'string') {
    return isExactSchemaNamespaceExpression(name);
  }
  return false;
}

/**
 * Spec-less STRUCTURAL detection: the ids of owned Namespaces whose name is
 * exactly the schema field `spec.namespace`. These are the owned workload
 * namespaces to HOIST out of the SHARED RGD graph — a STABLE property that is the
 * same for every instance of a factory (finding #4).
 *
 * Deliberately does NOT filter on `includeWhen`: a namespace's ACTIVITY is
 * spec-dependent (`includeWhen: spec.create`), but a namespace named
 * `spec.namespace` is, whenever it IS active, always the very namespace the
 * instance lands in — so it must never be a graph child. When it is INACTIVE for a
 * given spec, removing it from the RGD is harmless (it was not going to be created)
 * and the concrete retained-emission path simply emits nothing for it. Evaluating
 * `includeWhen` here (against an empty spec) would wrongly drop an owned namespace
 * from the hoist set and leave the ownership guard to reject the instance. External
 * references are excluded — they are observed, not owned graph children.
 */
export function detectStructurallyOwnedNamespaceIds(resources: ResourceCollection): Set<string> {
  const ids = new Set<string>();
  for (const [resourceId, resource] of resourceEntries(resources)) {
    if (resource.kind !== 'Namespace') continue;
    if (Reflect.get(resource, '__externalRef') === true) continue;
    if (namespaceNameTracksSchemaNamespace(resource.metadata?.name)) ids.add(resourceId);
  }
  return ids;
}

/** A CEL expression that resolves to the instance's schema namespace. */
function schemaNamespaceCelExpression(): { expression: string } {
  return { [CEL_EXPRESSION_BRAND]: true, expression: 'schema.spec.namespace' } as unknown as {
    expression: string;
  };
}

/**
 * Rewrite every reference to a HOISTED Namespace's `metadata.name` to the concrete
 * schema namespace expression `${schema.spec.namespace}` (finding #3).
 *
 * When a Namespace is hoisted OUT of the RGD graph, any other resource that still
 * refers to it (e.g. a ConfigMap using `${ownedNamespace.metadata.name}`) would
 * leave a live `${...}` reference to a resource KRO no longer knows about, and KRO
 * rejects the whole graph. Because a hoisted Namespace's name is, by construction,
 * exactly the schema field `spec.namespace` (see
 * {@link namespaceNameTracksSchemaNamespace}), rewriting the dangling reference to
 * `schema.spec.namespace` is exact — it yields the same value the removed resource
 * would have.
 *
 * Only resources that actually contain such a reference are reconstructed; every
 * other resource is passed through by identity, so the common case (no reference
 * to the hoisted Namespace) is untouched.
 */
export function rewriteHoistedNamespaceReferences<
  T extends Record<string, KubernetesResource>,
>(resources: T, hoistedIds: ReadonlySet<string>): T {
  if (hoistedIds.size === 0) return resources;

  // CEL / marker forms of a reference to `<id>.metadata.name`, per hoisted id.
  const celRefPatterns = [...hoistedIds].map(
    (id) => new RegExp(`\\$\\{\\s*${escapeRegExp(id)}\\.metadata\\.name\\s*\\}`, 'g')
  );
  const markerRefPatterns = [...hoistedIds].map(
    (id) => new RegExp(`__KUBERNETES_REF_${escapeRegExp(id)}_metadata\\.name__`, 'g')
  );

  // The literal CEL expression + raw marker a hoisted-Namespace reference becomes.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a literal CEL expression string, not a JS template.
  const schemaNamespaceCel = '${schema.spec.namespace}';
  const schemaNamespaceMarker = '__KUBERNETES_REF___schema___spec.namespace__';

  const rewriteString = (value: string): string => {
    let out = value;
    for (const pattern of celRefPatterns) out = out.replace(pattern, schemaNamespaceCel);
    for (const pattern of markerRefPatterns) out = out.replace(pattern, schemaNamespaceMarker);
    return out;
  };

  const rewriteValue = (value: unknown): unknown => {
    if (isKubernetesRef(value)) {
      return hoistedIds.has(value.resourceId) && value.fieldPath.startsWith('metadata.name')
        ? schemaNamespaceCelExpression()
        : value;
    }
    if (isCelExpression(value)) {
      const rewritten = rewriteString(value.expression);
      return rewritten === value.expression
        ? value
        : ({ [CEL_EXPRESSION_BRAND]: true, expression: rewritten } as unknown);
    }
    if (typeof value === 'string') {
      return rewriteString(value);
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const rewritten = rewriteValue(item);
        if (rewritten !== item) changed = true;
        return rewritten;
      });
      return changed ? next : value;
    }
    if (value !== null && typeof value === 'object') {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const rewritten = rewriteValue(item);
        if (rewritten !== item) changed = true;
        next[key] = rewritten;
      }
      return changed ? next : value;
    }
    return value;
  };

  const result: Record<string, KubernetesResource> = {};
  for (const [id, resource] of Object.entries(resources)) {
    result[id] = rewriteValue(resource) as KubernetesResource;
  }
  return result as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reject a KRO instance that would own the Namespace containing its own CR.
 *
 * KRO deletes graph children before clearing the owner CR's finalizer. If a
 * child Namespace contains that CR, namespace termination can strand the
 * finalizer permanently. Re-executing with the concrete instance spec makes
 * this check survive nested compositions and schema-driven namespace names.
 *
 * The KRO factory HOISTS a self-owned workload Namespace OUT of the RGD graph
 * (emitting it as a retained resource created deps-first, outside the graph)
 * before calling this guard and passes its name in `hoistedNamespaces`. Because a
 * hoisted namespace is no longer a graph child, deleting the instance can't GC it,
 * so the common create-namespace-and-put-the-instance-in-it pattern is safe with
 * the instance left in its natural namespace — this guard skips it. The guard
 * remains the real protection for the cases hoisting cannot cover: an owned
 * Namespace whose name can't be proven safe (fails closed), and a caller who
 * EXPLICITLY pins `instanceNamespace` back onto a namespace the composition owns
 * (opts into the unsafe pattern, so it is never hoisted).
 */
export function assertKroInstanceNamespaceOwnershipSafe<TSpec extends KroCompatibleType>(
  input: KroInstanceNamespaceSafetyInput<TSpec>
): void {
  const { owned, unresolved } = detectOwnedNamespaces(input);

  const unresolvedId = unresolved[0];
  if (unresolvedId !== undefined) {
    throw new TypeKroError(
      `Cannot prove KRO instance namespace '${input.instanceNamespace}' is safe because active owned Namespace '${unresolvedId}' in composition '${input.compositionName}' has a name that cannot be evaluated from the concrete spec. ` +
        'Use a concrete or schema-only CEL Namespace name, or move the KRO instance to a control-plane namespace whose safety can be established.',
      'UNRESOLVED_KRO_NAMESPACE_OWNERSHIP',
      {
        composition: input.compositionName,
        instanceNamespace: input.instanceNamespace,
        resourceId: unresolvedId,
        mode: 'kro',
      }
    );
  }

  // An owned namespace the factory has HOISTED out of the graph is safe: it is no
  // longer a graph child, so deleting the instance can never garbage-collect it.
  if (owned.has(input.instanceNamespace) && input.hoistedNamespaces?.has(input.instanceNamespace)) {
    return;
  }

  if (owned.has(input.instanceNamespace)) {
    throw new TypeKroError(
      `KRO instance namespace '${input.instanceNamespace}' cannot also be an owned Namespace in composition '${input.compositionName}'. ` +
        'Place the KRO instance in a separate control-plane namespace so deleting it cannot terminate the namespace containing its own finalizer.',
      'UNSAFE_KRO_NAMESPACE_OWNERSHIP',
      {
        composition: input.compositionName,
        instanceNamespace: input.instanceNamespace,
        ownedNamespace: input.instanceNamespace,
        mode: 'kro',
      }
    );
  }
}

/** Validate the fixed registry namespace used by a shared singleton owner. */
export function assertSingletonOwnerNamespaceOwnershipSafe(
  definition: SingletonDefinitionRecord
): void {
  const composition = definition.composition as unknown as CompositionSafetyMetadata;
  assertKroInstanceNamespaceOwnershipSafe({
    compositionName: composition.name ?? 'singleton-owner',
    instanceNamespace: definition.registryNamespace,
    spec: definition.spec,
    ...(composition.resources ? { resources: composition.resources } : {}),
    ...(composition._compositionFn ? { compositionFn: composition._compositionFn } : {}),
  });
}
