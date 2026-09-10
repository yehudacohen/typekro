/**
 * Cluster API capability resolution.
 *
 * Some resources can only be rendered once the target cluster has said which
 * group version it actually serves for a kind. `MutatingAdmissionPolicy` is the
 * motivating case: beta on Kubernetes 1.34/1.35
 * (`admissionregistration.k8s.io/v1beta1`), GA from 1.36
 * (`admissionregistration.k8s.io/v1`), never both on the same server, and
 * absent entirely below 1.34. Guessing produces an apply failure for the whole
 * graph, so nothing here ever guesses: a capability is either resolved against
 * a cluster or reported as unresolved, and the caller skips the resource.
 *
 * Two pieces make that work:
 *
 * - {@link resolveClusterCapability} runs discovery once per cluster and caches
 *   the answer under the **cluster's identity**, never globally. A process that
 *   talks to two clusters — a test suite with two fakes, multi-cluster
 *   tooling — gets an independent answer for each.
 * - {@link runWithDeployTarget} publishes the cluster a deployment is currently
 *   targeting, so synchronous code further down (a composition body re-executed
 *   at deploy time) can read the answer resolved for *that* cluster without
 *   threading a `KubeConfig` through every call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import { createBunCompatibleApiClient } from './bun-api-client.js';

const logger = getComponentLogger('api-capability');

/**
 * A kind whose served group version has to come from the cluster.
 *
 * `versions` is bare version names in preference order — the first one the
 * cluster serves the kind at wins.
 */
export interface ClusterCapabilityRequirement {
  /** Stable id; forms half of the cache key (the cluster identity is the other half). */
  id: string;
  group: string;
  kind: string;
  versions: readonly string[];
}

export type ClusterCapabilityResolution =
  | { status: 'served'; apiVersion: string }
  | { status: 'unserved'; reason: string };

/**
 * The one cluster call capability resolution needs.
 *
 * Narrow on purpose: a test supplies a fake with a literal map of group
 * versions to kinds and never touches `@kubernetes/client-node`.
 */
export interface ApiGroupDiscovery {
  /**
   * Kinds served at `<group>/<version>`, or `undefined` when the cluster does
   * not serve that group version at all.
   */
  servedKinds(group: string, version: string): Promise<readonly string[] | undefined>;
}

// ---------------------------------------------------------------------------
// Cluster identity
// ---------------------------------------------------------------------------

/**
 * A stable fingerprint for the cluster a `KubeConfig` currently points at.
 *
 * Server URL plus CA material plus the context's cluster name: two kubeconfigs
 * that reach the same API server with the same trust root are the same cluster,
 * and two contexts that differ in any of those are not. Returns `undefined`
 * when the config names no current cluster — there is nothing to key on, so
 * nothing may be cached.
 */
export function clusterIdentity(kubeConfig: k8s.KubeConfig): string | undefined {
  let cluster: ReturnType<k8s.KubeConfig['getCurrentCluster']>;
  try {
    cluster = kubeConfig.getCurrentCluster();
  } catch {
    return undefined;
  }
  if (!cluster?.server) return undefined;

  const material = [
    cluster.name ?? '',
    cluster.server,
    cluster.caData ?? '',
    cluster.caFile ?? '',
    String(cluster.skipTLSVerify ?? false),
  ].join('|');

  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** How long a resolved capability stays good. A cluster can be upgraded under us. */
export const CLUSTER_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Ceiling on cached entries so long-lived multi-cluster tooling cannot grow unbounded. */
export const CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES = 64;

interface CacheEntry {
  resolution: ClusterCapabilityResolution;
  expiresAt: number;
}

/** Keyed by `<cluster identity>|<requirement id>` — never by requirement alone. */
const cache = new Map<string, CacheEntry>();

function cacheKey(clusterId: string, requirementId: string): string {
  return `${clusterId}|${requirementId}`;
}

function readCache(
  clusterId: string,
  requirementId: string
): ClusterCapabilityResolution | undefined {
  const key = cacheKey(clusterId, requirementId);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.resolution;
}

function writeCache(
  clusterId: string,
  requirementId: string,
  resolution: ClusterCapabilityResolution,
  ttlMs: number
): void {
  const key = cacheKey(clusterId, requirementId);
  // Re-insert so iteration order is insertion recency; the oldest entry is the
  // first key Map yields.
  cache.delete(key);
  cache.set(key, { resolution, expiresAt: Date.now() + ttlMs });
  while (cache.size > CLUSTER_CAPABILITY_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Read a previously resolved capability without touching the cluster. */
export function getCachedClusterCapability(
  requirement: ClusterCapabilityRequirement,
  clusterId: string
): ClusterCapabilityResolution | undefined {
  return readCache(clusterId, requirement.id);
}

/** Drop every cached capability. Test seam. */
export function resetClusterCapabilityCache(): void {
  cache.clear();
}

/** Number of live cache entries. Test seam for the bounded-lifetime contract. */
export function clusterCapabilityCacheSize(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The shape `CustomObjectsApi.getAPIResources()` returns, narrowed to what we read. */
interface ApiResourceList {
  resources?: Array<{ name?: string; kind?: string }>;
}

/**
 * Discovery backed by a real cluster.
 *
 * `GET /apis/<group>/<version>` is the definitive test, and is why this is
 * discovery rather than a list call: 1.32 and 1.33 serve
 * `admissionregistration.k8s.io/v1` for webhook configurations while not
 * serving `MutatingAdmissionPolicy` at all, so "the group version exists" is
 * not the same question as "the kind is served".
 */
export function kubeConfigApiGroupDiscovery(kubeConfig: k8s.KubeConfig): ApiGroupDiscovery {
  return {
    async servedKinds(group: string, version: string): Promise<readonly string[] | undefined> {
      try {
        const clientNode = await import('@kubernetes/client-node');
        const api = createBunCompatibleApiClient(
          kubeConfig,
          clientNode.CustomObjectsApi
        ) as unknown as {
          getAPIResources(request: { group: string; version: string }): Promise<ApiResourceList>;
        };
        const list = await api.getAPIResources({ group, version });
        return (list.resources ?? [])
          .filter((resource) => typeof resource.name === 'string' && !resource.name.includes('/'))
          .map((resource) => resource.kind)
          .filter((kind): kind is string => typeof kind === 'string');
      } catch (error: unknown) {
        // A 404 means the group version is not served. Anything else — an
        // unreachable server, RBAC — is equally "we did not learn that this is
        // served", and the caller's fail-safe is to skip the resource.
        logger.debug('API group version discovery failed', {
          group,
          version,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Ask a cluster which group version serves a kind, memoized per cluster.
 *
 * Never falls back to a preferred or assumed version: when no candidate is
 * served the result is `unserved` and the caller must skip the resource.
 */
export async function resolveClusterCapability(
  requirement: ClusterCapabilityRequirement,
  options: {
    clusterId: string;
    discovery: ApiGroupDiscovery;
    /** Skip the cache read. The write still happens. */
    refresh?: boolean;
    ttlMs?: number;
  }
): Promise<ClusterCapabilityResolution> {
  const {
    clusterId,
    discovery,
    refresh = false,
    ttlMs = CLUSTER_CAPABILITY_CACHE_TTL_MS,
  } = options;

  if (!refresh) {
    const cached = readCache(clusterId, requirement.id);
    if (cached) return cached;
  }

  let resolution: ClusterCapabilityResolution = {
    status: 'unserved',
    reason:
      `the cluster does not serve ${requirement.kind} at any of ` +
      requirement.versions.map((version) => `${requirement.group}/${version}`).join(', '),
  };

  for (const version of requirement.versions) {
    const kinds = await discovery.servedKinds(requirement.group, version);
    if (kinds?.includes(requirement.kind)) {
      resolution = { status: 'served', apiVersion: `${requirement.group}/${version}` };
      break;
    }
  }

  writeCache(clusterId, requirement.id, resolution, ttlMs);
  return resolution;
}

// ---------------------------------------------------------------------------
// Deploy-time registry
// ---------------------------------------------------------------------------

/**
 * Requirements the deployment path resolves before it materializes a graph.
 *
 * A module that renders a capability-gated resource registers its requirement
 * on load; the direct deployment path resolves whatever is registered against
 * the cluster it is about to deploy to. Keeping the list here rather than in
 * the deployment layer is what stops the engine from having to know about any
 * particular kind.
 */
const deployTimeRequirements = new Map<string, ClusterCapabilityRequirement>();

/** Register a requirement to be resolved before each deployment. Idempotent. */
export function registerDeployTimeCapability(requirement: ClusterCapabilityRequirement): void {
  deployTimeRequirements.set(requirement.id, requirement);
}

/** Every registered deploy-time requirement. */
export function listDeployTimeCapabilities(): ClusterCapabilityRequirement[] {
  return [...deployTimeRequirements.values()];
}

/**
 * Resolve every registered requirement against a cluster and return that
 * cluster's identity, or `undefined` when the config names no cluster (nothing
 * was resolved, and callers must treat every capability as unavailable).
 *
 * Resolution failures are not fatal: a requirement that cannot be resolved is
 * cached as `unserved`, which makes the caller skip the resource — the whole
 * point of the seam is that an unknown API is never assumed to be present.
 */
export async function resolveDeployTimeCapabilities(
  kubeConfig: k8s.KubeConfig,
  options: { discovery?: ApiGroupDiscovery } = {}
): Promise<string | undefined> {
  const clusterId = clusterIdentity(kubeConfig);
  if (!clusterId) return undefined;

  const requirements = listDeployTimeCapabilities();
  if (requirements.length === 0) return clusterId;

  const discovery = options.discovery ?? kubeConfigApiGroupDiscovery(kubeConfig);
  for (const requirement of requirements) {
    await resolveClusterCapability(requirement, { clusterId, discovery });
  }
  return clusterId;
}

// ---------------------------------------------------------------------------
// Deploy target context
// ---------------------------------------------------------------------------

const DEPLOY_TARGET = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `clusterId` published as the cluster this deployment targets.
 *
 * Synchronous code inside — notably a composition body re-executed at deploy
 * time — can then read capabilities resolved for exactly that cluster. Nested
 * and concurrent deployments to different clusters do not see each other's
 * target.
 */
export function runWithDeployTarget<T>(clusterId: string, fn: () => T): T {
  return DEPLOY_TARGET.run(clusterId, fn);
}

/** The cluster the current deployment targets, if any. */
export function getCurrentDeployTarget(): string | undefined {
  return DEPLOY_TARGET.getStore();
}
