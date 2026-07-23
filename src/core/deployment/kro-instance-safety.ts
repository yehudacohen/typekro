import { CEL_EXPRESSION_BRAND } from '../../shared/brands.js';
import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { createCompositionContext, runWithCompositionContext } from '../composition/context.js';
import { KUBERNETES_REF_SCHEMA_MARKER_SOURCE } from '../constants/brands.js';
import { TypeKroError } from '../errors.js';
import { copyResourceMetadata, getIncludeWhen } from '../metadata/index.js';
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
   * SIBLING resources OUTSIDE the graph, created deps-first). typekro NEVER emits a
   * Namespace into RGD YAML: every owned Namespace is applied as a sibling before
   * the RGD and torn down after it, so KRO never owns a namespace and can never
   * garbage-collect one when the instance CR is deleted — the finalizer-stranding
   * concern this guard protects against is structurally resolved for typekro's own
   * factories. The guard therefore treats an owned namespace that has been hoisted
   * as SAFE, even though it still appears in the composition's resources. It remains
   * a defense-in-depth net for HAND-AUTHORED graphs that place a Namespace directly
   * in an RGD (an owned namespace whose name can't be proven, or one the caller
   * EXPLICITLY pinned the instance back into without hoisting) — those still throw.
   */
  readonly hoistedNamespaces?: ReadonlySet<string>;
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

/**
 * Resolve a Namespace METADATA value (a label or annotation VALUE) to its concrete
 * string form (finding #5).
 *
 * Unlike {@link resolveNamespaceName} — which resolves a namespace NAME and is
 * correctly restricted to DNS-label shape — metadata values are UNRESTRICTED strings:
 * `Team_A`, free text with spaces, arbitrary annotation content. The old path routed
 * these through `resolveNamespaceName`, whose DNS-label short-circuit only accepts a
 * CEL body matching a DNS label and then hands anything else to the CEL evaluator,
 * which throws / returns undefined for a plain literal like `Team_A` or `some text` —
 * silently DROPPING valid metadata.
 *
 * A concrete re-execution collapses a schema-derived value into a CEL whose BODY is
 * the resolved literal. So for a CEL value we:
 *   - first try evaluating it (handles genuine expressions — `has()`, `orValue()`,
 *     concatenations); if that yields a primitive, use it;
 *   - otherwise the body is a concrete literal that is not a valid standalone CEL
 *     program (e.g. `Team_A`, `some text`) — return it VERBATIM as the concrete value,
 *     with NO DNS-label restriction.
 * Numbers / booleans are stringified; refs resolve against the spec; plain strings and
 * marker-embedded strings defer to {@link resolveNamespaceName} (which returns them
 * verbatim / resolves the marker). Returns `undefined` only for a genuinely
 * unresolvable value (an unresolved schema ref), so the caller drops just those.
 */
export function resolveConcreteMetadataValue(
  value: unknown,
  spec: KroCompatibleType
): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (isCelExpression(value)) {
    const body = value.expression.trim().replace(/^\$\{\s*|\s*\}$/g, '');
    // A concrete re-execution collapses a schema-derived value into a CEL whose BODY is
    // the resolved LITERAL — that literal must be returned VERBATIM, NEVER fed to the
    // CEL evaluator, which mis-parses many literals (e.g. `data-platform` → `data -
    // platform` → NaN, `Team_A`/free text → identifier/parse errors). Only a body that
    // STILL references the schema (`spec.*` / `schema.spec.*`) or uses a schema CEL
    // helper (`has()` / `.orValue()`) genuinely needs evaluation against the spec.
    const referencesSchema =
      /(?<![\w$])(?:schema\.)?spec\.[A-Za-z_$]/.test(body) ||
      /\bhas\(/.test(body) ||
      /\.orValue\(/.test(body);
    if (referencesSchema) {
      try {
        const evaluated = evaluateSchemaCelExpression(value, spec);
        if (typeof evaluated === 'string') return evaluated;
        if (
          typeof evaluated === 'number' ||
          typeof evaluated === 'boolean' ||
          typeof evaluated === 'bigint'
        ) {
          return String(evaluated);
        }
      } catch {
        // Unevaluable despite looking schema-shaped — fall through to the verbatim body.
      }
    }
    return body.length > 0 ? body : undefined;
  }
  return resolveNamespaceName(value, spec);
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
 * a sibling resource (finding #5), rather than synthesizing a bare Namespace.
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
 * Concrete active resources owned by one KRO instance, excluding external
 * observations. This is used after the owner CR disappears to prove that KRO's
 * asynchronous child deletes have actually reached 404 before shared
 * definitions are removed or teardown is reported successful.
 */
export function concreteActiveOwnedResources<TSpec extends KroCompatibleType>(
  input: Omit<KroInstanceNamespaceSafetyInput<TSpec>, 'instanceNamespace'>
): Map<string, KubernetesResource> {
  const byId = new Map<string, KubernetesResource>();
  for (const [resourceId, resource] of concreteResources(input)) {
    if (!isActiveOwnedResource(resource, input.spec)) continue;
    byId.set(resourceId, resource);
  }
  return byId;
}

/**
 * Select EVERY Namespace to HOIST out of the RGD graph — the new, UNCONDITIONAL
 * model: typekro NEVER emits a Namespace into RGD YAML. Selection is trivially
 * `kind === 'Namespace'` (excluding `__externalRef` observed namespaces, which are
 * not owned graph children), NOT the old structural "name tracks spec.namespace"
 * detection. Every owned Namespace becomes a sibling resource applied before the
 * RGD and torn down after it, so KRO never owns a namespace.
 *
 * Returns a map from each hoisted Namespace's resource id to its RAW
 * `metadata.name` VALUE (a schema `KubernetesRef`, a `CelExpression`, or a plain
 * string). The name value is what {@link rewriteHoistedNamespaceReferences} /
 * {@link rewriteHoistedNamespaceRefsInValue} rewrite dangling references TO — a
 * reference to a hoisted Namespace's `metadata.name` becomes that Namespace's own
 * concrete name expression. The map is a STABLE STRUCTURAL property of the graph
 * (spec-independent), so the shared RGD's shape is identical for every instance.
 *
 * Deliberately does NOT filter on `includeWhen`: a namespace's ACTIVITY is
 * spec-dependent, but whether a resource is a Namespace is not. A namespace that is
 * inactive for a given spec is simply not created as a sibling; removing it from the
 * RGD is harmless (it was not going to be created there either).
 */
export function selectHoistedNamespaces(resources: ResourceCollection): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const [resourceId, resource] of resourceEntries(resources)) {
    if (resource.kind !== 'Namespace') continue;
    if (Reflect.get(resource, '__externalRef') === true) continue;
    byId.set(resourceId, resource.metadata?.name);
  }
  return byId;
}

/** A branded CEL expression object built from a bare expression body. */
function makeCelExpression(expression: string): unknown {
  return { [CEL_EXPRESSION_BRAND]: true, expression } as unknown;
}

/**
 * The substitution forms a reference to a hoisted Namespace's `metadata.name`
 * rewrites TO — derived from the Namespace's OWN name VALUE (finding #3,
 * generalized beyond the `spec.namespace` case):
 *   - `celBody`: what a `<id>.metadata.name` TOKEN inside a CEL expression becomes.
 *   - `marker`:  what a `__KUBERNETES_REF_<id>_metadata.name__` TOKEN inside a
 *                plain/template string becomes (`undefined` when the name has no
 *                representable marker form — the caller then leaves the reference,
 *                and {@link findDanglingHoistedReference} fails loudly).
 *   - `ref`:     what an EXACT `metadata.name` `KubernetesRef` to the hoisted
 *                Namespace becomes.
 *
 * Handles the two provable, common cases end-to-end: a Namespace named by the
 * schema (`${schema.spec.namespace}` and friends → `schema.<fieldPath>`) and a
 * Namespace named by a plain string LITERAL (→ that constant). A Namespace named
 * by an arbitrary CEL expression rewrites its CEL-context and exact-ref references
 * (using the CEL body) but has no simple marker form; a Namespace named by a
 * concatenated/template string is not represented (fails closed). Anything not
 * representable returns `undefined`, leaving the reference for the dangling-
 * reference assertion to catch rather than silently emitting a wrong value.
 */
interface HoistedNameForms {
  readonly celBody: string;
  readonly marker: string | undefined;
  readonly ref: unknown;
}

function hoistedNamespaceNameForms(nameValue: unknown): HoistedNameForms | undefined {
  if (isKubernetesRef(nameValue)) {
    // Only a schema-driven name is representable as an RGD-portable expression.
    if (nameValue.resourceId !== '__schema__') return undefined;
    const fieldPath = nameValue.fieldPath === 'namespace' ? 'spec.namespace' : nameValue.fieldPath;
    const celBody = `schema.${fieldPath}`;
    return {
      celBody,
      marker: `__KUBERNETES_REF___schema___${fieldPath}__`,
      ref: makeCelExpression(celBody),
    };
  }
  if (isCelExpression(nameValue)) {
    const celBody = nameValue.expression.trim().replace(/^\$\{\s*|\s*\}$/g, '');
    // If the CEL body is itself a bare schema field, it has a clean marker form too.
    const schemaField = /^schema\.(spec\.[A-Za-z_$][\w$.]*)$/.exec(celBody)?.[1];
    return {
      celBody,
      marker: schemaField ? `__KUBERNETES_REF___schema___${schemaField}__` : undefined,
      ref: nameValue,
    };
  }
  if (typeof nameValue === 'string') {
    // A serialized schema marker (whole string) → schema field.
    const markerMatch = /^__KUBERNETES_REF___schema___(spec\.[A-Za-z0-9_.$]+?)__$/.exec(
      nameValue.trim()
    );
    if (markerMatch?.[1]) {
      const fieldPath = markerMatch[1];
      return {
        celBody: `schema.${fieldPath}`,
        marker: nameValue.trim(),
        ref: makeCelExpression(`schema.${fieldPath}`),
      };
    }
    // A template string carrying embedded markers is a concatenation with no simple
    // single-token substitution — fail closed.
    if (/__KUBERNETES_REF_/.test(nameValue)) return undefined;
    // A plain string literal (a concrete DNS namespace name).
    return { celBody: JSON.stringify(nameValue), marker: nameValue, ref: nameValue };
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite every reference to a HOISTED Namespace's `metadata.name` — ANYWHERE it
 * appears in a value — to that Namespace's CONCRETE name expression (findings
 * #3 + #6).
 *
 * `hoisted` maps each hoisted Namespace's resource id to its RAW `metadata.name`
 * value (see {@link selectHoistedNamespaces}). When a Namespace is hoisted OUT of
 * the RGD graph, any other value that still refers to it would leave a live
 * reference to a resource KRO no longer knows about, and KRO rejects the whole
 * graph. Each reference is rewritten to the referenced Namespace's own name
 * expression — for a Namespace named `${schema.spec.namespace}` that is
 * `schema.spec.namespace` (as before); for a literally-named Namespace `"foo"`
 * that is the constant `foo` — which is exactly the value the removed resource
 * would have produced.
 *
 * The rewrite is STRUCTURAL, not exact-string (finding #6): it replaces the
 * reference TOKEN `<id>.metadata.name` wherever it occurs, so embedded /
 * concatenated (`ns-${string(id.metadata.name)}`), function-wrapped
 * (`string(id.metadata.name)`), and ternary (`... ? id.metadata.name : "x"`)
 * forms are all handled — in plain strings, CEL expressions, and raw
 * `__KUBERNETES_REF_*` markers alike. It applies to arbitrary values (resource
 * bodies AND status mappings). A reference whose target Namespace name has no
 * representable form is left as-is and caught by
 * {@link findDanglingHoistedReference}.
 */
export function rewriteHoistedNamespaceRefsInValue<T>(
  value: T,
  hoisted: ReadonlyMap<string, unknown>
): T {
  if (hoisted.size === 0) return value;

  // Per-id substitution forms; ids whose name is not representable are skipped
  // (the reference is left dangling for the post-serialization assertion).
  const forms = new Map<string, HoistedNameForms>();
  for (const [id, nameValue] of hoisted) {
    const f = hoistedNamespaceNameForms(nameValue);
    if (f) forms.set(id, f);
  }
  if (forms.size === 0) return value;

  // TOKEN-level (not whole-`${...}`) patterns for a reference to
  // `<id>.metadata.name`, so wrappers/concatenation/ternaries are handled. A
  // negative lookbehind avoids matching an id that is only a SUFFIX of a longer
  // identifier (e.g. `myOwnedNamespace` when the hoisted id is `ownedNamespace`).
  const celTokenReplacers = [...forms].map(([id, f]) => ({
    pattern: new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(id)}\\.metadata\\.name\\b`, 'g'),
    replacement: f.celBody,
  }));
  const markerTokenReplacers = [...forms]
    .filter(([, f]) => f.marker !== undefined)
    .map(([id, f]) => ({
      pattern: new RegExp(`__KUBERNETES_REF_${escapeRegExp(id)}_metadata\\.name__`, 'g'),
      // biome-ignore lint/style/noNonNullAssertion: filtered on marker !== undefined
      replacement: f.marker!,
    }));

  const rewriteString = (input: string): string => {
    let out = input;
    // Use a function replacer so `$` in a replacement is never treated as a
    // special replacement pattern.
    for (const { pattern, replacement } of celTokenReplacers)
      out = out.replace(pattern, () => replacement);
    for (const { pattern, replacement } of markerTokenReplacers)
      out = out.replace(pattern, () => replacement);
    return out;
  };

  const rewriteValue = (val: unknown): unknown => {
    if (isKubernetesRef(val)) {
      // Rewrite ONLY an exact `metadata.name` reference to a hoisted Namespace
      // (finding #7); requiring EXACT field equality lets any unsupported reference
      // fall through to the dangling-reference validation instead.
      const f = forms.get(val.resourceId);
      return f && val.fieldPath === 'metadata.name' ? f.ref : val;
    }
    if (isCelExpression(val)) {
      const rewritten = rewriteString(val.expression);
      return rewritten === val.expression ? val : makeCelExpression(rewritten);
    }
    if (typeof val === 'string') {
      return rewriteString(val);
    }
    if (Array.isArray(val)) {
      let changed = false;
      const next = val.map((item) => {
        const rewritten = rewriteValue(item);
        if (rewritten !== item) changed = true;
        return rewritten;
      });
      return changed ? next : val;
    }
    if (val !== null && typeof val === 'object') {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(val as Record<string, unknown>)) {
        const rewritten = rewriteValue(item);
        if (rewritten !== item) changed = true;
        next[key] = rewritten;
      }
      return changed ? (next as unknown) : val;
    }
    return val;
  };

  return rewriteValue(value) as T;
}

/**
 * The top-level STATUS field names whose value, once the owned Namespace is HOISTED
 * out of the RGD, can no longer be represented in the KRO status schema (finding #6).
 *
 * When a Namespace is hoisted OUT of the RGD, a status field that referenced its
 * `metadata.name` is rewritten to the Namespace's own name expression. KRO requires
 * every instance status field to reference at least one RESOURCE (KRO builder.go:
 * `instance status field must refer to a resource`), and its status CEL environment
 * has no `schema` identifier. So a rewritten value that references NO managed resource
 * is unrepresentable in the KRO status — in BOTH shapes:
 *   - schema-only (`schema.spec.namespace`, for a schema-named Namespace) — KRO
 *     status CEL cannot evaluate `schema`; and
 *   - a plain CONSTANT (for a literally-named Namespace) — a literal has zero resource
 *     dependencies, so KRO rejects it, AND typekro's own schema generation classifies
 *     a literal-only status as static and DROPS it from the emitted KRO status.
 * BOTH were previously handled inconsistently (schema-only rejected, literal silently
 * dropped). We now REJECT both consistently (see {@link assertNoHoistWeakenedStatusFields})
 * — the one behavior. A field that ALSO references a real managed resource stays
 * representable (KRO accepts it; a literal inside it is fine) and is NOT flagged.
 *
 * Returns only TOP-LEVEL status keys (the KRO status schema is a flat map of field →
 * CEL); a field is included iff rewriting its value CHANGED it (it referenced the
 * hoisted Namespace) AND the rewritten value references no managed resource (i.e. it
 * references `schema`, or is a pure constant).
 */
export function hoistWeakenedStatusFields(
  statusMappings: Record<string, unknown> | undefined,
  hoisted: ReadonlyMap<string, unknown>
): string[] {
  if (!statusMappings || hoisted.size === 0) return [];
  const weakened: string[] = [];
  for (const [key, value] of Object.entries(statusMappings)) {
    if (key.startsWith('__')) continue; // internal composition metadata, not a status field
    const rewritten = rewriteHoistedNamespaceRefsInValue(value, hoisted);
    if (rewritten === value) continue; // did not reference a hoisted Namespace
    // Unrepresentable in KRO status when the rewritten value references `schema`
    // (KRO can't eval it) OR references NO managed resource (a pure constant — KRO
    // requires a resource dependency, and typekro would drop it as static).
    if (rewrittenReferencesSchema(rewritten) || !rewrittenReferencesManagedResource(rewritten)) {
      weakened.push(key);
    }
  }
  return weakened;
}

/**
 * Whether a rewritten status value still references the `schema` identifier — a
 * schema-only expression KRO status CEL cannot evaluate.
 */
function rewrittenReferencesSchema(value: unknown): boolean {
  const hasSchema = (s: string): boolean =>
    /(?<![A-Za-z0-9_$])schema\./.test(s) || /__KUBERNETES_REF___schema__/.test(s);
  if (typeof value === 'string') return hasSchema(value);
  if (isCelExpression(value)) return hasSchema(value.expression);
  if (isKubernetesRef(value)) return value.resourceId === '__schema__';
  if (Array.isArray(value)) return value.some(rewrittenReferencesSchema);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(rewrittenReferencesSchema);
  }
  return false;
}

/**
 * Whether a rewritten status value references at least one MANAGED RESOURCE — a
 * non-`schema` KubernetesRef, or a `<id>.status|spec|metadata` / `__KUBERNETES_REF_<id>_`
 * token whose id is not `schema`. KRO requires every status field to reference a
 * resource; a value that references none (a pure constant, or schema-only) is
 * unrepresentable. Used together with {@link rewrittenReferencesSchema} so the
 * literal-only case (finding #6) is rejected consistently with the schema-only case.
 */
function rewrittenReferencesManagedResource(value: unknown): boolean {
  const hasResourceToken = (s: string): boolean => {
    const dotRef = /(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*)\.(?:status|spec|metadata)\b/g;
    for (const match of s.matchAll(dotRef)) {
      if (match[1] !== 'schema') return true;
    }
    const markerRef = /__KUBERNETES_REF_([A-Za-z0-9_$]+?)_/g;
    for (const match of s.matchAll(markerRef)) {
      if (match[1] !== '__schema__' && match[1] !== 'schema') return true;
    }
    return false;
  };
  if (typeof value === 'string') return hasResourceToken(value);
  if (isCelExpression(value)) return hasResourceToken(value.expression);
  if (isKubernetesRef(value)) return value.resourceId !== '__schema__';
  if (Array.isArray(value)) return value.some(rewrittenReferencesManagedResource);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(rewrittenReferencesManagedResource);
  }
  return false;
}

/**
 * HONEST, CONSISTENT behavior for finding #6: REJECT (throw) a composition whose
 * status field(s) resolve ONLY to a hoisted owned Namespace's `metadata.name` — i.e.
 * once the Namespace leaves the RGD the field references no managed resource.
 *
 * KRO requires every instance status field to reference a resource and cannot
 * evaluate `schema` in status CEL, so such a field is unrepresentable in the emitted
 * KRO status whether the Namespace is schema-named (rewrites to `schema.spec.namespace`)
 * or literally-named (rewrites to a constant). Previously the schema case threw while
 * the literal case was silently dropped (schema generation classifies literal-only
 * status as static and excludes it) — the two code paths disagreed. Both are now
 * REJECTED the same way: FAIL LOUDLY at serialization, naming the field(s), so the
 * author restructures the status (derive the value from a managed resource, or drop
 * the field) instead of shipping a silently-weakened status API.
 */
export function assertNoHoistWeakenedStatusFields(
  statusMappings: Record<string, unknown> | undefined,
  hoisted: ReadonlyMap<string, unknown>,
  compositionName: string
): void {
  const weakened = hoistWeakenedStatusFields(statusMappings, hoisted);
  if (weakened.length === 0) return;
  throw new TypeKroError(
    `Composition "${compositionName}" cannot be serialized for KRO: status field(s) ` +
      `[${weakened.join(', ')}] resolve ONLY to a hoisted owned Namespace's metadata.name. ` +
      `Once that Namespace is hoisted out of the RGD the reference no longer targets any managed ` +
      `resource (it becomes a schema-only expression \`schema.spec.namespace\` for a schema-named ` +
      `Namespace, or a bare constant for a literally-named one). KRO requires every status field ` +
      `to reference a resource and cannot evaluate \`schema\` in status CEL, so the field cannot be ` +
      `represented in the KRO status schema either way. Remove the field or derive its value from a ` +
      `managed resource instead of the owned Namespace's name. See docs/advanced/migration.md.`,
    'HOIST_WEAKENED_STATUS_FIELD',
    { compositionName, fields: weakened }
  );
}

/**
 * Resource-map form of {@link rewriteHoistedNamespaceRefsInValue}: rewrite every
 * dangling reference to a hoisted Namespace across a resource collection.
 *
 * Only resources that actually contain such a reference are reconstructed; every
 * other resource is passed through by identity, so the common case (no reference
 * to the hoisted Namespace) is untouched. When a resource IS reconstructed, its
 * TypeKro metadata (WeakMap-stored `includeWhen` / `readinessEvaluator` /
 * `__resourceId` / readiness+iteration markers) is copied onto the new object via
 * {@link copyResourceMetadata} so the rewrite never silently drops it (finding #7).
 */
export function rewriteHoistedNamespaceReferences<T extends Record<string, KubernetesResource>>(
  resources: T,
  hoisted: ReadonlyMap<string, unknown>
): T {
  if (hoisted.size === 0) return resources;

  const result: Record<string, KubernetesResource> = {};
  for (const [id, resource] of Object.entries(resources)) {
    const rewritten = rewriteHoistedNamespaceRefsInValue(resource, hoisted);
    if (rewritten !== resource) {
      // Reconstructed a NEW resource object — carry its non-enumerable / WeakMap
      // TypeKro metadata across so readiness/iteration/includeWhen survive.
      copyResourceMetadata(resource as object, rewritten as object);
    }
    result[id] = rewritten;
  }
  return result as T;
}

/**
 * Scan an emitted RGD YAML for any leftover reference to a hoisted (removed)
 * resource id — either a CEL interpolation `${<id>.…}` or a raw
 * `__KUBERNETES_REF_<id>_…` marker. Returns the FIRST offending id, or
 * `undefined` when the RGD is clean.
 *
 * This is the shared post-serialization dangling-reference check applied to BOTH
 * the factory serialization path ({@link KroResourceFactoryImpl.buildRgdYaml})
 * and the graph/composition serialization path (`core.ts`). After hoisting an
 * owned Namespace out of the RGD, NO reference to it may remain anywhere in the
 * emitted RGD (resource templates, status CEL, nested CEL, overrides); otherwise
 * KRO rejects the graph at runtime with a dangling `${...}` reference. A negative
 * lookbehind avoids matching an id that is only a suffix of a longer identifier.
 */
export function findDanglingHoistedReference(
  rgdYaml: string,
  hoistedIds: ReadonlySet<string>
): string | undefined {
  for (const id of hoistedIds) {
    const escaped = escapeRegExp(id);
    const celRef = new RegExp(`\\$\\{[^}]*?(?<![A-Za-z0-9_$])${escaped}\\.`);
    const markerRef = new RegExp(`__KUBERNETES_REF_${escaped}_`);
    if (celRef.test(rgdYaml) || markerRef.test(rgdYaml)) return id;
  }
  return undefined;
}

/**
 * Reject a KRO instance that would own the Namespace containing its own CR.
 *
 * KRO deletes graph children before clearing the owner CR's finalizer. If a
 * child Namespace contains that CR, namespace termination can strand the
 * finalizer permanently. Re-executing with the concrete instance spec makes
 * this check survive nested compositions and schema-driven namespace names.
 *
 * The KRO factory now HOISTS every owned Namespace OUT of the RGD graph (emitting
 * it as a SIBLING resource created deps-first and torn down after the RGD) before
 * calling this guard, and passes the hoisted names in `hoistedNamespaces`. Because
 * a hoisted namespace is no longer a graph child, deleting the instance can't GC
 * it, so the common create-namespace-and-put-the-instance-in-it pattern is safe —
 * this guard skips it. The guard remains the defense-in-depth net for HAND-AUTHORED
 * graphs that hoisting does not cover: an owned Namespace whose name can't be proven
 * safe (fails closed), and a caller who places `instanceNamespace` on a namespace
 * the composition owns WITHOUT hoisting it (opts into the unsafe pattern).
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
