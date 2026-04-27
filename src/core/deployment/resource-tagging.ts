/**
 * Resource Tagging
 *
 * Applies typekro-ownership metadata to Kubernetes resources at deploy time
 * as labels and annotations, and extracts it back at delete time. This is
 * the core of typekro's label-based deployment-state backend: the cluster
 * IS the state, no separate ConfigMap record is kept.
 *
 * ## What gets tagged
 *
 * **Labels** (selector-queryable, constrained to 63-char DNS-label values):
 *   - `typekro.io/managed-by=typekro` — claims ownership; acts as a broad
 *     filter for "find everything typekro has deployed"
 *   - `typekro.io/factory-name=<sanitized>` — scopes a resource to one
 *     factory identity
 *   - `typekro.io/instance-name=<sanitized>` — scopes a resource to one
 *     deployed instance within a factory
 *
 * **Annotations** (arbitrary strings, used for state that exceeds label
 * constraints or isn't selector-queried):
 *   - `typekro.io/deployment-id=<uuid>` — groups resources from a single
 *     deployment call
 *   - `typekro.io/resource-id=<node-id>` — original composition-local
 *     resource id (may differ from `metadata.name` and isn't DNS-constrained)
 *   - `typekro.io/factory-name=<raw>` — unsanitized factory name for display
 *     and exact-match comparisons (labels may be truncated/sanitized)
 *   - `typekro.io/instance-name=<raw>` — same, for instance name
 *   - `typekro.io/factory-namespace=<ns>` — the factory's "home" namespace
 *     (where the factory was invoked from). Used by cross-namespace
 *     discovery to narrow queries.
 *   - `typekro.io/scopes=<json-array>` — JSON-encoded list of scope names
 *     this resource belongs to (e.g., `["cluster"]`). Empty/absent means
 *     "instance-private." See {@link getEffectiveScopes}.
 *   - `typekro.io/depends-on=<json-array>` — JSON-encoded list of
 *     composition-local resource ids that THIS resource depends on. Used
 *     by discovery to reconstruct the dependency graph for reverse-
 *     topological deletion without needing the original composition source.
 *
 * ## Why this design
 *
 * A prior iteration stored the deployment record in a ConfigMap in the
 * factory namespace. That worked for cross-process cleanup but had
 * drawbacks: the ConfigMap could drift from reality (e.g., a resource
 * deleted manually leaves a dangling record), required a bootstrap
 * namespace for the record to live in, and made multi-consumer ownership
 * of shared resources ambiguous.
 *
 * Storing the state directly on the resources makes the cluster self-
 * describing: `kubectl get all -l typekro.io/factory-name=X` returns the
 * full set. No external index to keep in sync. Shared resources can
 * carry tags from multiple owners naturally.
 */

import { getMetadataField } from '../metadata/index.js';
import type { KubernetesResource } from '../types/kubernetes.js';

// ── Label keys ────────────────────────────────────────────────────────────

/** Label set on every resource deployed by typekro. */
export const MANAGED_BY_LABEL = 'typekro.io/managed-by';
export const MANAGED_BY_VALUE = 'typekro';

/** Label identifying the factory that deployed this resource. */
export const FACTORY_NAME_LABEL = 'typekro.io/factory-name';

/** Label identifying the instance within a factory. */
export const INSTANCE_NAME_LABEL = 'typekro.io/instance-name';

// ── Annotation keys ───────────────────────────────────────────────────────

/** Annotation carrying the deployment run id. */
export const DEPLOYMENT_ID_ANNOTATION = 'typekro.io/deployment-id';

/** Annotation carrying the composition-local resource id (pre-sanitization). */
export const RESOURCE_ID_ANNOTATION = 'typekro.io/resource-id';

/** Annotation carrying the raw (unsanitized) factory name. */
export const FACTORY_NAME_ANNOTATION = 'typekro.io/factory-name';

/** Annotation carrying the raw (unsanitized) instance name. */
export const INSTANCE_NAME_ANNOTATION = 'typekro.io/instance-name';

/** Annotation carrying the factory's home namespace. */
export const FACTORY_NAMESPACE_ANNOTATION = 'typekro.io/factory-namespace';

/** Annotation carrying scope membership as a JSON array of strings. */
export const SCOPES_ANNOTATION = 'typekro.io/scopes';

/** Annotation carrying dependency ids as a JSON array of strings. */
export const DEPENDS_ON_ANNOTATION = 'typekro.io/depends-on';

/** Annotation carrying the immutable singleton owner spec fingerprint. */
export const SINGLETON_SPEC_FINGERPRINT_ANNOTATION = 'typekro.io/singleton-spec-fingerprint';

// ── Tagging context and API ───────────────────────────────────────────────

/**
 * Everything needed to stamp a resource with its typekro ownership
 * metadata at deploy time.
 */
export interface TagContext {
  /** Factory identifier (raw, pre-sanitization). */
  factoryName: string;
  /** Instance identifier (raw, pre-sanitization). */
  instanceName: string;
  /** Deployment run id — usually the engine's generated `deployment-<ts>-<rand>`. */
  deploymentId: string;
  /** The factory's home namespace — where it was invoked from. */
  factoryNamespace: string;
  /** The composition-local resource id (graph node id). */
  resourceId: string;
  /**
   * Scope names this resource belongs to. Empty or undefined means
   * "instance-private — delete on deleteInstance by default."
   */
  scopes?: string[];
  /**
   * IDs of resources this resource depends on (from the dependency graph).
   * Used for reverse-topological deletion reconstruction.
   */
  dependencies?: string[];
  /** Fingerprint for singleton owner resources. */
  singletonSpecFingerprint?: string;
}

/**
 * Apply typekro ownership metadata to a resource manifest. Mutates
 * `manifest.metadata.labels` and `manifest.metadata.annotations` in place.
 *
 * Called from the deploy path right before the resource is serialized and
 * sent to the cluster. The manifest at that point is a plain object (post
 * reference-resolution and namespace-application), so in-place mutation is
 * safe and avoids an extra clone.
 *
 * Existing user-set labels and annotations are preserved — only the
 * `typekro.io/*` keys are added or overwritten.
 */
export function applyTypekroTags(manifest: KubernetesResource, ctx: TagContext): void {
  if (!manifest.metadata) {
    (manifest as unknown as { metadata: Record<string, unknown> }).metadata = {};
  }
  const metadata = manifest.metadata as unknown as {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };

  metadata.labels = { ...(metadata.labels ?? {}) };
  metadata.annotations = { ...(metadata.annotations ?? {}) };

  // Labels: sanitized, DNS-label-compatible
  metadata.labels[MANAGED_BY_LABEL] = MANAGED_BY_VALUE;
  metadata.labels[FACTORY_NAME_LABEL] = sanitiseLabelValue(ctx.factoryName);
  metadata.labels[INSTANCE_NAME_LABEL] = sanitiseLabelValue(ctx.instanceName);

  // Annotations: raw values + state that can't fit in labels
  metadata.annotations[FACTORY_NAME_ANNOTATION] = ctx.factoryName;
  metadata.annotations[INSTANCE_NAME_ANNOTATION] = ctx.instanceName;
  metadata.annotations[FACTORY_NAMESPACE_ANNOTATION] = ctx.factoryNamespace;
  metadata.annotations[DEPLOYMENT_ID_ANNOTATION] = ctx.deploymentId;
  metadata.annotations[RESOURCE_ID_ANNOTATION] = ctx.resourceId;

  if (ctx.scopes) {
    metadata.annotations[SCOPES_ANNOTATION] = JSON.stringify(ctx.scopes);
  }
  if (ctx.dependencies && ctx.dependencies.length > 0) {
    metadata.annotations[DEPENDS_ON_ANNOTATION] = JSON.stringify(ctx.dependencies);
  }
  if (ctx.singletonSpecFingerprint) {
    metadata.annotations[SINGLETON_SPEC_FINGERPRINT_ANNOTATION] = ctx.singletonSpecFingerprint;
  }
}

// ── Extraction (used by discovery / delete path) ──────────────────────────

/**
 * Parsed typekro ownership metadata extracted from a live resource's
 * labels and annotations. Shape mirrors {@link TagContext} but with the
 * nullable fields explicit, because labels/annotations may be missing
 * (e.g., if a resource was tagged by an older typekro version).
 */
export interface ExtractedTags {
  factoryName?: string;
  instanceName?: string;
  factoryNamespace?: string;
  deploymentId?: string;
  resourceId?: string;
  scopes: string[];
  dependencies: string[];
}

/**
 * Extract typekro metadata from a live Kubernetes resource. The live
 * resource is whatever the server returned from a list/read call —
 * `metadata.labels` and `metadata.annotations` are plain records.
 *
 * Never throws: malformed annotations (bad JSON, wrong types) are
 * silently ignored and return empty defaults. The caller should treat
 * missing fields as "we don't know" rather than "the resource is
 * un-owned," because this function is invoked on resources that matched
 * a label selector upstream.
 */
export function extractTypekroTags(resource: {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
}): ExtractedTags {
  const labels = resource.metadata?.labels ?? {};
  const annotations = resource.metadata?.annotations ?? {};

  // Prefer annotations for raw values (they aren't sanitized); fall
  // back to labels so we still get a usable value when annotations are
  // stripped by a downstream mutator.
  const factoryName = annotations[FACTORY_NAME_ANNOTATION] ?? labels[FACTORY_NAME_LABEL];
  const instanceName = annotations[INSTANCE_NAME_ANNOTATION] ?? labels[INSTANCE_NAME_LABEL];

  return {
    ...(factoryName !== undefined && { factoryName }),
    ...(instanceName !== undefined && { instanceName }),
    ...(annotations[FACTORY_NAMESPACE_ANNOTATION] !== undefined && {
      factoryNamespace: annotations[FACTORY_NAMESPACE_ANNOTATION],
    }),
    ...(annotations[DEPLOYMENT_ID_ANNOTATION] !== undefined && {
      deploymentId: annotations[DEPLOYMENT_ID_ANNOTATION],
    }),
    ...(annotations[RESOURCE_ID_ANNOTATION] !== undefined && {
      resourceId: annotations[RESOURCE_ID_ANNOTATION],
    }),
    scopes: parseJsonStringArray(annotations[SCOPES_ANNOTATION]),
    dependencies: parseJsonStringArray(annotations[DEPENDS_ON_ANNOTATION]),
  };
}

/**
 * Compute the effective scope set for a resource, merging three sources:
 *
 *   1. `typekro.io/scopes` annotation on the live manifest (the
 *      canonical cluster-side source, used by cross-process delete).
 *   2. WeakMap `scopes` metadata set via `setMetadataField` in-process
 *      (used when the resource is still in memory and hasn't been
 *      tagged on-cluster yet — e.g., during deploy).
 *   3. The legacy `lifecycle: 'shared'` alias, which is equivalent to
 *      `scopes: ['shared']`.
 *
 * Returns an empty array if the resource is "instance-private" (no
 * scopes from any source). Factory-provided `scope: 'cluster'` metadata is
 * treated as membership in the broader `cluster` deletion/application scope.
 */
export function getEffectiveScopes(resource: KubernetesResource): string[] {
  const scopes = new Set<string>();

  // 1. Annotation (authoritative for on-cluster resources)
  const annotation = resource.metadata?.annotations?.[SCOPES_ANNOTATION];
  for (const s of parseJsonStringArray(annotation)) scopes.add(s);

  // 2. WeakMap metadata (in-process deploy path)
  const fromMeta = getMetadataField(resource as object, 'scopes');
  if (fromMeta) {
    for (const s of fromMeta) scopes.add(s);
  }

  // 3. Canonical factory scope metadata for cluster-scoped resources.
  if (getMetadataField(resource as object, 'scope') === 'cluster') {
    scopes.add('cluster');
  }

  // 4. Legacy lifecycle alias
  const legacy = getMetadataField(resource as object, 'lifecycle');
  if (legacy === 'shared') scopes.add('shared');

  // 5. Annotation-based legacy: `typekro.io/lifecycle: shared` from any
  //    pre-scopes deployment is also treated as `['shared']`.
  const lifecycleAnn = resource.metadata?.annotations?.['typekro.io/lifecycle'];
  if (lifecycleAnn === 'shared') scopes.add('shared');

  return Array.from(scopes);
}

/**
 * Decide whether a resource matches a scope filter.
 *
 * Used by both the deploy path (`targetScopes`) and the delete path
 * (`deleteInstance` scopes). The semantics are additive:
 *
 *   - **Unscoped** resources (empty effective scopes) match when
 *     `includeUnscoped` is `true` (the default). Set to `false` to
 *     exclude them — useful when you want to tear down only shared
 *     infrastructure without touching instance-private resources.
 *   - **Scoped** resources match when ANY of their scopes appear in
 *     the `scopeFilter`. An empty filter means "no broader scopes
 *     targeted" — only unscoped resources pass.
 *
 * Examples (default includeUnscoped=true):
 *   scopesMatchFilter([],            [])            === true   // unscoped, included by default
 *   scopesMatchFilter([],            ['cluster'])   === true   // unscoped, still included
 *   scopesMatchFilter(['cluster'],   [])            === false  // scoped, not targeted
 *   scopesMatchFilter(['cluster'],   ['cluster'])   === true   // scoped, targeted
 *
 * With includeUnscoped=false:
 *   scopesMatchFilter([],            ['cluster'], false) === false  // unscoped excluded
 *   scopesMatchFilter(['cluster'],   ['cluster'], false) === true   // scoped still matches
 */
export function scopesMatchFilter(
  resourceScopes: string[],
  scopeFilter: string[],
  includeUnscoped = true
): boolean {
  if (resourceScopes.length === 0) return includeUnscoped;
  return resourceScopes.some((s) => scopeFilter.includes(s));
}

/**
 * Decide whether a resource matches deploy-side `targetScopes` semantics.
 *
 * Deployment targeting is intentionally stricter than delete-side filtering:
 * - `undefined` means deploy everything (handled by callers before invoking this helper).
 * - `[]` means deploy only instance-private/unscoped resources.
 * - Non-empty filters deploy only resources with at least one matching lifecycle scope.
 */
export function scopesMatchDeployTarget(resourceScopes: string[], targetScopes: string[]): boolean {
  if (targetScopes.length === 0) return resourceScopes.length === 0;
  if (resourceScopes.length === 0) return false;
  return resourceScopes.some((s) => targetScopes.includes(s));
}

// ── Label selector construction ───────────────────────────────────────────

/**
 * Build a label selector string for locating all resources belonging to
 * a specific factory + instance. Used by the discovery path at delete
 * time.
 */
export function buildFactoryInstanceSelector(opts: {
  factoryName: string;
  instanceName: string;
}): string {
  return [
    `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    `${FACTORY_NAME_LABEL}=${sanitiseLabelValue(opts.factoryName)}`,
    `${INSTANCE_NAME_LABEL}=${sanitiseLabelValue(opts.instanceName)}`,
  ].join(',');
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a JSON-encoded string array annotation. Returns an empty array
 * on any parsing failure (missing, non-JSON, wrong shape) — this is
 * intentional: a broken annotation should not crash the rollback path.
 */
function parseJsonStringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Sanitise a string for use as a Kubernetes label value. Labels must be
 * DNS-label-compatible (alphanumeric + `-`, `_`, `.`, max 63 chars) and
 * must start+end with an alphanumeric. Replace anything else with `-`
 * and truncate.
 *
 * Note: this is not collision-free — two factory names that differ only
 * in disallowed characters will sanitise to the same value. Callers
 * that need collision resistance should use the annotation form.
 */
export function sanitiseLabelValue(value: string): string {
  const sanitised = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[-._]+|[-._]+$/g, '');
  // An empty string is an invalid K8s label value. Fall back to a
  // deterministic placeholder so selectors don't break.
  return sanitised || 'unknown';
}
