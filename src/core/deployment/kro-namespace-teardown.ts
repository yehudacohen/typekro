import type * as k8s from '@kubernetes/client-node';

import { ensureError } from '../errors.js';
import {
  createBunCompatibleApiClient,
  createBunCompatibleKubernetesObjectApi,
} from '../kubernetes/bun-api-client.js';
import { getComponentLogger } from '../logging/index.js';
import type { TypeKroLogger } from '../logging/types.js';
import { isConflictError } from './k8s-helpers.js';
import { createRollbackManager } from './rollback-manager.js';

/**
 * Annotation stamped on a hoisted workload Namespace at CREATE time, recording
 * the RGD that created it — the durable ownership RECORD used by teardown. A
 * Namespace is a deletion candidate ONLY if it carries this annotation set to
 * THIS composition's RGD name (i.e. typekro created it for this composition);
 * an adopted/pre-existing Namespace never carries it and is never deleted.
 */
export const NAMESPACE_OWNER_ANNOTATION = 'typekro.io/created-by-rgd';

/**
 * Annotation stamped on the instance CR at DEPLOY time recording the CONCRETE names
 * of every Namespace this instance hoisted out of the RGD graph (finding #4). Value is
 * a JSON array of names (e.g. `["team-a","team-a-monitoring"]`). Teardown + the pre-hoist
 * guard read it back EXACTLY so a hoisted name derived from an ARBITRARY spec field (e.g.
 * `spec.targetNamespace`) round-trips without re-deriving it from `metadata.namespace` /
 * `spec.namespace` (which can be wrong for non-1:1 hoists).
 */
export const HOISTED_NAMESPACES_ANNOTATION = 'typekro.io/hoisted-namespaces';

/**
 * Parse the {@link HOISTED_NAMESPACES_ANNOTATION} value back into a list of namespace
 * names. Tolerant: a missing/blank value yields `[]`; a malformed value yields `[]`
 * (callers decide the fallback). Only string entries are returned.
 */
export function parseHoistedNamespacesAnnotation(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return [];
  }
}

/**
 * A richer read of {@link HOISTED_NAMESPACES_ANNOTATION} that DISTINGUISHES three cases the
 * pre-hoist guard must treat differently:
 *  - `present` — a valid JSON array, INCLUDING an explicit empty `[]` (the instance hoists zero
 *    namespaces). This is per-instance PROOF and is SAFE — the guard must NOT fail closed on it.
 *  - `missing` — no annotation at all: a genuinely-legacy CR predating the record → FAIL CLOSED.
 *  - `malformed` — present but not a JSON array → FAIL CLOSED.
 * (Teardown uses {@link parseHoistedNamespacesAnnotation}, where any non-list just means "nothing
 * to clean" — the missing-vs-empty distinction only matters for the fail-closed guard.)
 */
export type HoistedNamespacesRecord =
  | { readonly status: 'present'; readonly names: string[] }
  | { readonly status: 'missing' }
  | { readonly status: 'malformed' };

export function readHoistedNamespacesRecord(value: string | undefined): HoistedNamespacesRecord {
  if (typeof value !== 'string' || value.trim().length === 0) return { status: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { status: 'malformed' };
  }
  if (!Array.isArray(parsed)) return { status: 'malformed' };
  // STRICT: reject the ENTIRE array (→ fail closed) unless EVERY element is a non-empty string.
  // Filtering junk out (e.g. [42] or [""] → []) would masquerade as a valid empty record and let
  // the guard proceed WITHOUT protecting the intended namespace. An empty [] is vacuously valid.
  if (!parsed.every((n): n is string => typeof n === 'string' && n.length > 0)) {
    return { status: 'malformed' };
  }
  return { status: 'present', names: parsed };
}

/**
 * The minimal LIST surface used by {@link listNamespacesOwnedByRgd}. {@link
 * k8s.KubernetesObjectApi} satisfies it; tests inject a mock.
 */
export interface NamespaceListApi {
  list(
    apiVersion: string,
    kind: string,
    namespace?: string,
    pretty?: string,
    exact?: boolean,
    exportt?: boolean,
    fieldSelector?: string,
    labelSelector?: string,
    limit?: number,
    continueToken?: string
  ): Promise<unknown>;
}

/**
 * List the NAMES of every Namespace carrying {@link NAMESPACE_OWNER_ANNOTATION} == `rgdName`
 * — the DURABLE, cluster-side record of every workload Namespace typekro created for this RGD.
 *
 * Unlike the CR's {@link HOISTED_NAMESPACES_ANNOTATION} (which dies WITH the instance CR), this
 * record survives the CR, so:
 *   - a teardown RETRY after the CR is already gone can still FIND + clean the owned
 *     namespace(s) (and gate the RGD/CRD delete on their cleanup), and
 *   - the pre-hoist guard can resolve an existing instance's namespaces EXACTLY without
 *     approximating from `metadata.namespace` / `spec.namespace`.
 *
 * Lists cluster-wide (small N in practice) and filters client-side by the ownership
 * annotation, FOLLOWING the list continuation token so an owned namespace beyond the first
 * page is never hidden by a silent cap. A list error PROPAGATES (callers fail closed /
 * preserve): an unreadable list is not proof that no owned namespace exists.
 */
export async function listNamespacesOwnedByRgd(
  kubeConfig: k8s.KubeConfig,
  rgdName: string,
  options: { k8sApi?: NamespaceListApi; logger?: TypeKroLogger } = {}
): Promise<string[]> {
  const k8sApi = options.k8sApi ?? createBunCompatibleKubernetesObjectApi(kubeConfig);
  const owned: string[] = [];
  let continueToken: string | undefined;
  do {
    const result = (await k8sApi.list(
      'v1',
      'Namespace',
      undefined, // namespace (cluster-scoped)
      undefined, // pretty
      undefined, // exact
      undefined, // export
      undefined, // fieldSelector
      undefined, // labelSelector
      100, // limit
      continueToken // continue
    )) as unknown as {
      items?: Array<{ metadata?: { name?: unknown; annotations?: Record<string, string> } }>;
      metadata?: { continue?: unknown };
    };
    for (const item of result.items ?? []) {
      const name = item.metadata?.name;
      if (
        typeof name === 'string' &&
        name.length > 0 &&
        item.metadata?.annotations?.[NAMESPACE_OWNER_ANNOTATION] === rgdName
      ) {
        owned.push(name);
      }
    }
    const next = result.metadata?.continue;
    continueToken = typeof next === 'string' && next.length > 0 ? next : undefined;
  } while (continueToken);
  return owned;
}

/** Default bound for the gated Namespace delete (poll to a real 404, then throw). */
const DEFAULT_NAMESPACE_DELETE_TIMEOUT_MS = 120_000;

/** The API group of a `group/version` (or `v1` core, whose group is `""`). */
function groupOfApiVersion(apiVersion: string): string {
  return apiVersion.includes('/') ? (apiVersion.split('/')[0] ?? '') : '';
}

/**
 * A namespaced RESOURCE TYPE discovered from the cluster's API surface. `apiVersion`
 * is the group/version (`v1`, `apps/v1`, `kro.run/v1alpha1`); `kind` is the object
 * kind used to LIST instances of the type in a namespace.
 */
export interface NamespacedResourceType {
  readonly apiVersion: string;
  readonly kind: string;
}

/**
 * Discovery + listing surface for the emptiness check, injected so the
 * classification LOGIC is unit-testable OFFLINE (the maintainer validates real
 * cluster discovery on OrbStack). The default cluster implementation is
 * {@link createClusterNamespaceInventory}.
 */
export interface NamespaceInventory {
  /** All NAMESPACED, LISTABLE resource types the cluster currently serves. */
  discoverNamespacedTypes(): Promise<NamespacedResourceType[]>;
  /** The names of every object of `type` present in `namespace`. */
  listObjectNames(type: NamespacedResourceType, namespace: string): Promise<string[]>;
}

/**
 * The verdict of the emptiness gate. `empty: false` ALWAYS carries a human `reason`
 * — either a real occupant, or an uncertainty (discovery/list error) that fails the
 * gate toward RETAIN.
 */
export type NamespaceEmptinessVerdict =
  | { readonly empty: true }
  | { readonly empty: false; readonly reason: string };

/**
 * Whether an object found in a namespace is a k8s AUTO-PROVISIONED default that does
 * NOT count as "occupied" — every namespace has these regardless of what a
 * user/stack put in it:
 *   - the `default` ServiceAccount,
 *   - the `kube-root-ca.crt` ConfigMap (the injected cluster CA bundle),
 *   - `default-token-*` Secrets (older k8s auto-mounted the SA token this way).
 *
 * `Event` objects are handled at DISCOVERY time ({@link isEventType}) — they are
 * transient, controller-generated bookkeeping (a just-drained namespace still holds
 * deletion Events for up to the event TTL), never a resource a user/stack owns, so
 * they must not pin an otherwise-empty namespace open. Treating them as occupants
 * would make the gate almost never fire. This is a deliberate, documented extension
 * of the brief's three-item default list.
 *
 * Keyed by GROUP + kind + name (finding #5): the built-in defaults all live in the
 * CORE group (`""`). Keying by kind/name alone would wrongly exempt an unrelated CRD
 * whose kind happened to be `ServiceAccount` / `ConfigMap` / `Secret` in some OTHER
 * group — a real occupant — from the emptiness gate.
 */
export function isAutoProvisionedDefault(group: string, kind: string, name: string): boolean {
  if (group !== '') return false; // only genuine CORE-group built-ins are defaults
  if (kind === 'ServiceAccount' && name === 'default') return true;
  if (kind === 'ConfigMap' && name === 'kube-root-ca.crt') return true;
  if (kind === 'Secret' && name.startsWith('default-token-')) return true;
  return false;
}

/**
 * Event types — transient, never counted as occupants. Keyed by GROUP + kind (finding
 * #5): only the CORE-group (`""`) `Event` and the `events.k8s.io` `Event` are exempted,
 * so an unrelated CRD named `Event` in some OTHER group is still treated as an occupant.
 */
export function isEventType(group: string, kind: string): boolean {
  return kind === 'Event' && (group === '' || group === 'events.k8s.io');
}

/**
 * Classify whether `namespace` is EMPTY (safe to delete) by enumerating every
 * namespaced resource type via discovery and listing each in the namespace. Returns
 * `empty: true` ONLY when nothing but k8s auto-provisioned defaults is present.
 *
 * FAIL SAFE (finding #3 + #4): on ANY uncertainty — discovery error, a per-type list
 * error, or an unexpected occupant — the verdict is `empty: false` (RETAIN). Deleting
 * an occupied namespace is high harm; retaining an empty one is low harm, so every
 * ambiguity resolves toward RETAIN.
 */
export async function classifyNamespaceEmptiness(
  inventory: NamespaceInventory,
  namespace: string,
  logger: TypeKroLogger = getComponentLogger('kro-namespace-teardown')
): Promise<NamespaceEmptinessVerdict> {
  let types: NamespacedResourceType[];
  try {
    types = await inventory.discoverNamespacedTypes();
  } catch (error: unknown) {
    return {
      empty: false,
      reason: `API discovery of namespaced types failed (retaining to be safe): ${ensureError(error).message}`,
    };
  }

  for (const type of types) {
    const group = groupOfApiVersion(type.apiVersion);
    if (isEventType(group, type.kind)) continue; // transient bookkeeping — never an occupant
    let names: string[];
    try {
      names = await inventory.listObjectNames(type, namespace);
    } catch (error: unknown) {
      // Fail toward RETAIN: we could not prove this type is absent.
      return {
        empty: false,
        reason: `could not list ${type.apiVersion}/${type.kind} in "${namespace}" (retaining to be safe): ${ensureError(error).message}`,
      };
    }
    for (const name of names) {
      if (!isAutoProvisionedDefault(group, type.kind, name)) {
        return {
          empty: false,
          reason: `namespace "${namespace}" still contains ${type.apiVersion}/${type.kind} "${name}" (another stack or user owns resources here)`,
        };
      }
    }
    logger.debug('Emptiness check: type clear', {
      namespace,
      type: `${type.apiVersion}/${type.kind}`,
      count: names.length,
    });
  }
  return { empty: true };
}

/**
 * The OWNERSHIP-gated + EMPTY-gated delete (findings #3 + #4), shared by BOTH the
 * imperative `deleteInstance` path and the Alchemy teardown handler.
 *
 * ORDER: this runs AFTER the instance CR is gone (KRO has graph-deleted every child)
 * but BEFORE the RGD/CRD teardown — the current teardown order is CR → namespace →
 * RGD → CRD (the generated CRD is torn down LAST). Deleting the namespace while the
 * RGD + CRD are still HEALTHY/Active is deliberate: the namespace controller confirms
 * emptiness instantly and can never terminate against a *Terminating* CRD (upstream
 * kro #1171). Never scans-and-deletes arbitrary namespaces: the caller passes exactly
 * the namespace THIS instance declared/hoisted.
 *
 * TWO GATES, ownership PRIMARY: with `ownedByRgd` set (both callers pass it), the
 * namespace is deleted ONLY if it carries {@link NAMESPACE_OWNER_ANNOTATION} equal to
 * this RGD (typekro CREATED it) AND is empty. An ADOPTED/undeclared namespace (no
 * matching stamp) is RETAINED — never deleted — as is one another stack/user still
 * OCCUPIES (non-empty) or one that cannot be read (fail-safe retain).
 *
 * GATED (not best-effort): a pre-delete 404 is benign (already gone), but the delete
 * itself polls to a real 404 and THROWS {@link DeploymentTimeoutError} on timeout — a
 * stuck namespace finalizer surfaces as an error, never a silently-abandoned
 * Terminating namespace. (The generated-CRD delete, a LATER step in `deleteInstance`,
 * is the only best-effort deletion — see {@link KroResourceFactoryImpl.deleteInstance}.)
 */
export async function deleteNamespaceIfEmpty(
  kubeConfig: k8s.KubeConfig,
  namespace: string,
  options: {
    logger?: TypeKroLogger;
    inventory?: NamespaceInventory;
    k8sApi?: Pick<k8s.KubernetesObjectApi, 'read' | 'delete'>;
    context?: Record<string, unknown>;
    /**
     * When set, delete ONLY if the live Namespace carries
     * {@link NAMESPACE_OWNER_ANNOTATION} equal to this value (typekro created it
     * for this composition's RGD). An adopted/undeclared Namespace — no matching
     * ownership annotation — is RETAINED. This is the PRIMARY ownership guard;
     * emptiness below is the secondary safety net.
     */
    ownedByRgd?: string;
    /** Bound for the gated delete (poll to a real 404, throw on timeout). */
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const logger = options.logger ?? getComponentLogger('kro-namespace-teardown');
  const context = options.context ?? {};
  const k8sApi = options.k8sApi ?? createBunCompatibleKubernetesObjectApi(kubeConfig);

  // Early existence + OWNERSHIP check FIRST — one read serves both. A 404 means the
  // namespace is already gone (skip discovery entirely). Any OTHER read error →
  // fail-safe RETAIN. When `ownedByRgd` is set, the same read proves ownership: only a
  // namespace typekro created for THIS RGD (matching annotation) is a candidate; an
  // adopted/undeclared namespace is retained (finding #3/#4).
  let live: { metadata?: { annotations?: Record<string, string> } };
  try {
    live = (await k8sApi.read({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace },
    })) as { metadata?: { annotations?: Record<string, string> } };
  } catch (error: unknown) {
    const k8sErr = error as { statusCode?: number; code?: number; body?: { code?: number } };
    const code = k8sErr.statusCode ?? k8sErr.code ?? k8sErr.body?.code;
    if (code === 404) {
      logger.debug('Namespace already gone before empty-gate; nothing to do', {
        namespace,
        ...context,
      });
      return;
    }
    logger.info('Retaining namespace after teardown — could not read it (ownership unproven)', {
      namespace,
      error: ensureError(error).message,
      ...context,
    });
    return;
  }

  if (options.ownedByRgd !== undefined) {
    const owner = live.metadata?.annotations?.[NAMESPACE_OWNER_ANNOTATION];
    if (owner !== options.ownedByRgd) {
      logger.info(
        'Retaining namespace after teardown — not owned by this composition (adopted/undeclared)',
        { namespace, expectedOwner: options.ownedByRgd, actualOwner: owner ?? '(none)', ...context }
      );
      return;
    }
  }

  const inventory = options.inventory ?? createClusterNamespaceInventory(kubeConfig);
  const verdict = await classifyNamespaceEmptiness(inventory, namespace, logger);
  if (!verdict.empty) {
    logger.info('Retaining namespace after teardown — not empty (or emptiness unproven)', {
      namespace,
      reason: verdict.reason,
      ...context,
    });
    return;
  }

  // GATED delete via the engine's ONE deletion primitive: delete, then poll to a real
  // 404 and THROW on timeout (finding #1). Because teardown already waited for the CRD
  // to 404, an empty owned namespace should drain promptly; if it does NOT, a stuck
  // finalizer surfaces as an error rather than a silently-abandoned Terminating
  // namespace. A pre-delete 404 is benign (handled by the primitive).
  const rollback = createRollbackManager(k8sApi as k8s.KubernetesObjectApi);
  await rollback.deleteResourceAndWait(
    { apiVersion: 'v1', kind: 'Namespace', name: namespace },
    { timeout: options.timeoutMs ?? DEFAULT_NAMESPACE_DELETE_TIMEOUT_MS }
  );
  logger.debug('Deleted the empty owned namespace after teardown', { namespace, ...context });
}

/**
 * The create-first API surface: an atomic CREATE (POST) plus a READ used only to
 * classify a pre-existing namespace on conflict. {@link k8s.KubernetesObjectApi}
 * satisfies this; tests inject a mock.
 */
export interface NamespaceCreateFirstApi {
  create(
    resource: k8s.KubernetesObject,
    pretty?: string,
    dryRun?: string,
    fieldManager?: string
  ): Promise<unknown>;
  read(resource: {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
  }): Promise<unknown>;
}

/** Verdict of {@link decideNamespaceOwnershipCreateFirst}. */
export interface NamespaceOwnershipDecision {
  /** True IFF our CREATE returned 201 — i.e. WE created the namespace this call. */
  readonly created: boolean;
  /**
   * True IFF typekro (this RGD) owns the namespace: it either created it now (`created`)
   * or a PRIOR create by this RGD stamped it (matching {@link NAMESPACE_OWNER_ANNOTATION}).
   * A namespace merely ADOPTED (created by someone else) is `owned: false`.
   */
  readonly owned: boolean;
}

/**
 * ATOMIC ownership decision via CREATE-FIRST (finding #3), shared by the imperative and
 * alchemy deploy paths. The old GET→(if 404)→SSA-patch-with-owner-stamp was raceable:
 * another actor creating the namespace between the GET and the patch let typekro ADOPT
 * it yet stamp it owned — and later DELETE it. Instead:
 *
 *   1. Attempt to CREATE the namespace (POST) WITH the ownership stamp. A 201 is proof
 *      WE created it → we own it (ownership is atomic: owned IFF we created it).
 *   2. On 409 (already exists) it is NOT ours to claim by this call. READ it and treat
 *      it as owned ONLY if it already carries THIS RGD's stamp (a prior create by us);
 *      otherwise it is ADOPTED (`owned: false`). This 409-read is race-free for the
 *      ownership decision because ownership was fixed at the original 201-create.
 *   3. Any OTHER create error is rethrown for the caller to handle (fail loud).
 *
 * `manifestWithStamp` MUST already carry {@link NAMESPACE_OWNER_ANNOTATION} = `ownerRgd`
 * plus the complete declared namespace config, so a 201 lands the full config atomically.
 */
export async function decideNamespaceOwnershipCreateFirst(
  api: NamespaceCreateFirstApi,
  manifestWithStamp: k8s.KubernetesObject,
  ownerRgd: string,
  fieldManager = 'typekro'
): Promise<NamespaceOwnershipDecision> {
  try {
    await api.create(manifestWithStamp, undefined, undefined, fieldManager);
    return { created: true, owned: true };
  } catch (error: unknown) {
    // Use the project's CENTRALIZED 409 classifier so EVERY conflict shape the
    // @kubernetes/client-node stack surfaces (statusCode / response.statusCode /
    // body.code / bare code) is recognized as AlreadyExists — the old hand-rolled
    // check missed `response.statusCode === 409`.
    if (!isConflictError(error)) throw error; // non-conflict create failure — caller decides
  }
  // 409: the namespace already exists. Owned only if a prior create by THIS RGD stamped it.
  const name = manifestWithStamp.metadata?.name;
  const live = (await api.read({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: typeof name === 'string' ? name : '' },
  })) as { metadata?: { annotations?: Record<string, string> } };
  const owned = live.metadata?.annotations?.[NAMESPACE_OWNER_ANNOTATION] === ownerRgd;
  return { created: false, owned };
}

/**
 * Metrics-only aggregated API groups. Their served resources (`pods`, `nodes`) are
 * EPHEMERAL, read-only metrics samples — never persistent occupants that a stack/user
 * "owns" — so an APIService backing one of these must NOT trip the coverage
 * uncertainty check below (that would make the secondary emptiness gate RETAIN on
 * essentially every cluster with metrics-server installed). Any OTHER aggregated
 * APIService group is treated as UNCERTAINTY → RETAIN.
 */
const METRICS_AGGREGATION_GROUPS = new Set([
  'metrics.k8s.io',
  'custom.metrics.k8s.io',
  'external.metrics.k8s.io',
]);

/**
 * Default {@link NamespaceInventory} backed by the live cluster. Discovery enumerates
 * EVERY served API group DYNAMICALLY — the core group via `CoreV1Api.getAPIResources()`
 * and every other served group via `CustomObjectsApi.getAPIResources(group, version)`
 * (the generic per-group discovery endpoint, `GET /apis/{group}/{version}`) — all
 * through the Bun-compatible client wrappers (no raw HTTP; identical under Bun and Node).
 * This covers built-in AND custom (CRD) namespaced kinds uniformly, since a CRD's group
 * appears in the served-group list. Listing uses `KubernetesObjectApi.list(apiVersion,
 * kind, namespace)` and FOLLOWS the list continuation token so a namespace with more
 * objects than one page never hides an occupant behind a silent cap (finding #5b).
 *
 * COVERAGE / UNCERTAINTY (finding #5a): the emptiness gate is a SECONDARY backstop
 * (ownership is the PRIMARY teardown guard), so it must never misclassify occupied as
 * empty. If the cluster serves a namespaced group this inventory CANNOT enumerate — for
 * ANY reason: a native group whose discovery call fails, or an aggregated APIService
 * whose external backend is unreachable — discovery THROWS an uncertainty error, which
 * {@link classifyNamespaceEmptiness} turns into a fail-safe RETAIN. The ONLY groups
 * deliberately skipped are the ephemeral metrics aggregation groups (their samples are
 * never persistent occupants). There is no native-vs-aggregated distinction: anything we
 * can't enumerate is uncertainty.
 */
export function createClusterNamespaceInventory(kubeConfig: k8s.KubeConfig): NamespaceInventory {
  const objectApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
  return {
    async discoverNamespacedTypes(): Promise<NamespacedResourceType[]> {
      // Deduplicate by apiVersion/kind — a kind can surface via more than one path.
      const seen = new Map<string, NamespacedResourceType>();
      const add = (apiVersion: string, kind: string): void => {
        const key = `${apiVersion}/${kind}`;
        if (!seen.has(key)) seen.set(key, { apiVersion, kind });
      };
      // Add every NAMESPACED, LISTABLE (non-subresource) kind from a discovered
      // V1APIResourceList served at `groupVersion`.
      const addFromList = (
        groupVersion: string,
        list: {
          resources?: Array<{
            name: string;
            kind: string;
            namespaced?: boolean;
            verbs?: string[];
            group?: string;
            version?: string;
          }>;
        }
      ): void => {
        for (const resource of list.resources ?? []) {
          if (resource.namespaced !== true) continue;
          if (resource.name.includes('/')) continue; // subresource
          if (!(resource.verbs ?? []).includes('list')) continue;
          const apiVersion =
            resource.group && resource.version
              ? `${resource.group}/${resource.version}`
              : groupVersion;
          add(apiVersion, resource.kind);
        }
      };

      const k8sClient = await import('@kubernetes/client-node');

      // 1. Core group (`/api/v1`) — no group name, so use the core client directly.
      const coreClient = createBunCompatibleApiClient(kubeConfig, k8sClient.CoreV1Api);
      addFromList('v1', await coreClient.getAPIResources());

      // 2. EVERY other served API group, enumerated dynamically. `getAPIVersions` lists
      // all served groups; for each we discover its preferred version's resources via
      // the GENERIC per-group endpoint. A group we cannot enumerate (discovery failure,
      // or an unreachable aggregated backend) is UNCERTAINTY → RETAIN (throw).
      const apisApi = createBunCompatibleApiClient(kubeConfig, k8sClient.ApisApi);
      const groupList = await apisApi.getAPIVersions();
      // Cast to the CustomObjectsApi shape whose generic `getAPIResources({group, version})`
      // hits `GET /apis/{group}/{version}` for ANY group (built-in or CRD-backed).
      const customApi = createBunCompatibleApiClient(kubeConfig, k8sClient.CustomObjectsApi) as unknown as {
        getAPIResources(request: {
          group: string;
          version: string;
        }): Promise<Parameters<typeof addFromList>[1]>;
      };

      for (const group of groupList.groups ?? []) {
        const groupName = group.name;
        if (typeof groupName !== 'string' || groupName.length === 0) continue;
        // Metrics groups are ephemeral read-only samples — never persistent occupants —
        // so they are deliberately skipped rather than treated as uncertainty.
        if (METRICS_AGGREGATION_GROUPS.has(groupName)) continue;
        // Enumerate EVERY SERVED version of the group, not just the preferred one
        // (finding #5): resources are published per group-VERSION, so a kind served
        // ONLY on a non-preferred version (a common CRD conversion pattern) would be
        // MISSED if we discovered the preferred version alone — and a missed kind lets
        // the gate false-"empty" over a real occupant.
        const versions = (group.versions ?? [])
          .map((v) => v?.version)
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (versions.length === 0) {
          // A served group with no discoverable version — cannot enumerate it → RETAIN.
          throw new Error(
            `served API group "${groupName}" reports no discoverable version; cannot prove the namespace is empty`
          );
        }
        for (const version of versions) {
          try {
            addFromList(
              `${groupName}/${version}`,
              await customApi.getAPIResources({ group: groupName, version })
            );
          } catch (error: unknown) {
            // Cannot enumerate this served namespaced group-version (native OR
            // aggregated) → UNCERTAINTY → fail-safe RETAIN (finding #5).
            throw new Error(
              `cannot enumerate served API group "${groupName}/${version}" ` +
                `(${ensureError(error).message}); cannot prove the namespace is empty`
            );
          }
        }
      }

      return [...seen.values()];
    },

    async listObjectNames(type: NamespacedResourceType, namespace: string): Promise<string[]> {
      // FOLLOW the continuation token so an occupant beyond the first page is never
      // hidden by a silent cap (finding #5b). `list` returns the body directly in
      // @kubernetes/client-node 1.x; `metadata.continue` drives the next page.
      const names: string[] = [];
      let continueToken: string | undefined;
      do {
        const result = (await objectApi.list(
          type.apiVersion,
          type.kind,
          namespace,
          undefined, // pretty
          undefined, // exact
          undefined, // export
          undefined, // fieldSelector
          undefined, // labelSelector
          100, // limit
          continueToken // continue
        )) as unknown as {
          items?: Array<{ metadata?: { name?: unknown } }>;
          metadata?: { continue?: unknown };
        };
        for (const item of result.items ?? []) {
          if (typeof item.metadata?.name === 'string') names.push(item.metadata.name);
        }
        const next = result.metadata?.continue;
        continueToken = typeof next === 'string' && next.length > 0 ? next : undefined;
      } while (continueToken);
      return names;
    },
  };
}
