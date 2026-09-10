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
 * "Unresolved" is itself two different things, and they are kept apart. The
 * cluster answering "I do not serve that" is a fact worth caching and worth
 * telling the user. Failing to reach the cluster at all is not a fact about the
 * cluster, and reporting it as one — then caching it for five minutes — is how
 * a transient RBAC or network error turns into a confident lie. Hence the
 * three-way {@link ClusterCapabilityResolution}.
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
import {
  type ApiReadFailure,
  classifyApiReadError,
  describeApiReadError,
  isNotFoundError,
} from '../deployment/k8s-helpers.js';
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

/**
 * Why discovery could not answer. `notFound` is excluded on purpose: a 404 *is*
 * an answer ("not served"), everything here is the absence of one.
 */
export type DiscoveryFailure = Exclude<ApiReadFailure, 'notFound'>;

/**
 * The outcome of asking a cluster about a kind.
 *
 * Three-way, not two-way, because "the cluster does not serve this" and "we
 * could not find out" have opposite consequences: the first is a durable fact
 * worth caching and reporting to the user, the second is a transient failure
 * that must never be reported as a fact about the cluster.
 */
export type ClusterCapabilityResolution =
  | { status: 'served'; apiVersion: string }
  | { status: 'unserved'; reason: string }
  | { status: 'unknown'; reason: string; failure: DiscoveryFailure };

/**
 * What a single `GET /apis/<group>/<version>` told us.
 *
 * - `served` — the server answered with a resource list; `kinds` is what it holds.
 * - `unserved` — the server answered 404: this group version is definitively not served.
 * - `unknown` — no answer (unreachable, RBAC, timeout, TLS). Says nothing about the cluster.
 */
export type ApiGroupProbe =
  | { status: 'served'; kinds: readonly string[] }
  | { status: 'unserved' }
  | { status: 'unknown'; failure: DiscoveryFailure; message: string };

/**
 * The one cluster call capability resolution needs.
 *
 * Narrow on purpose: a test supplies a fake with a literal map of group
 * versions to kinds and never touches `@kubernetes/client-node`.
 */
export interface ApiGroupDiscovery {
  /** What the cluster says about `<group>/<version>`. */
  servedKinds(group: string, version: string): Promise<ApiGroupProbe>;
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

/**
 * How long an `unknown` outcome is retained — a **failure note**, not an answer.
 *
 * An `unknown` is recorded so that the build which follows a resolve step in the
 * same deployment can say *why* it has no capability ("discovery failed: RBAC")
 * instead of the far weaker "no cluster was asked". It is deliberately not an
 * answer: {@link resolveClusterCapability} treats a stored `unknown` as a cache
 * miss and re-probes, so a transient failure never suppresses the next real
 * attempt, and this short lifetime bounds how long the note can linger at all.
 */
export const CLUSTER_CAPABILITY_UNKNOWN_CACHE_TTL_MS = 10 * 1000;

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

/**
 * Read a previously resolved capability without touching the cluster.
 *
 * May return an `unknown` entry: the reporting path *wants* to see that
 * discovery was attempted and failed, so it can say so rather than claim the
 * cluster lacks the API. {@link resolveClusterCapability} ignores those entries.
 */
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
    async servedKinds(group: string, version: string): Promise<ApiGroupProbe> {
      try {
        const clientNode = await import('@kubernetes/client-node');
        const api = createBunCompatibleApiClient(
          kubeConfig,
          clientNode.CustomObjectsApi
        ) as unknown as {
          getAPIResources(request: { group: string; version: string }): Promise<ApiResourceList>;
        };
        const list = await api.getAPIResources({ group, version });
        return {
          status: 'served',
          kinds: (list.resources ?? [])
            .filter((resource) => typeof resource.name === 'string' && !resource.name.includes('/'))
            .map((resource) => resource.kind)
            .filter((kind): kind is string => typeof kind === 'string'),
        };
      } catch (error: unknown) {
        // Only a 404 is an answer. The server was asked and said this group
        // version does not exist, which is a durable fact about the cluster.
        if (isNotFoundError(error)) {
          logger.debug('API group version is not served', { group, version });
          return { status: 'unserved' };
        }

        // Everything else — unreachable server, RBAC, timeout, TLS — means the
        // question never reached the server. Reporting that as "not served"
        // would put a false claim about the cluster in front of the user (and,
        // before this split, into a five-minute cache).
        const failure = classifyApiReadError(error) as DiscoveryFailure;
        const message = describeApiReadError(error);
        logger.debug('API group version discovery failed', { group, version, failure, message });
        return { status: 'unknown', failure, message };
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
 * Never falls back to a preferred or assumed version, and never turns a
 * discovery failure into a claim about the cluster:
 *
 * - `served` — a candidate version's resource list contains the kind.
 * - `unserved` — every candidate was *answered for* (404, or a 200 list without
 *   the kind) and none serves it. A durable fact; cached for the full TTL.
 * - `unknown` — no candidate served the kind and at least one could not be
 *   checked. The kind may well be served at the version we could not reach, so
 *   nothing may be concluded. Retained only as a short-lived failure note, and
 *   treated as a cache miss by the next call.
 */
export async function resolveClusterCapability(
  requirement: ClusterCapabilityRequirement,
  options: {
    clusterId: string;
    discovery: ApiGroupDiscovery;
    /** Skip the cache read. The write still happens. */
    refresh?: boolean;
    ttlMs?: number;
    /** Lifetime for an `unknown` failure note. */
    unknownTtlMs?: number;
  }
): Promise<ClusterCapabilityResolution> {
  const {
    clusterId,
    discovery,
    refresh = false,
    ttlMs = CLUSTER_CAPABILITY_CACHE_TTL_MS,
    unknownTtlMs = CLUSTER_CAPABILITY_UNKNOWN_CACHE_TTL_MS,
  } = options;

  if (!refresh) {
    const cached = readCache(clusterId, requirement.id);
    // A stored `unknown` is a note about a past failure, never an answer, so it
    // must not short-circuit a fresh attempt.
    if (cached && cached.status !== 'unknown') return cached;
  }

  const groupVersions = requirement.versions.map((version) => `${requirement.group}/${version}`);
  const failures: Array<{ groupVersion: string; failure: DiscoveryFailure; message: string }> = [];
  let resolution: ClusterCapabilityResolution | undefined;

  for (const version of requirement.versions) {
    const probe = await discovery.servedKinds(requirement.group, version);
    if (probe.status === 'served' && probe.kinds.includes(requirement.kind)) {
      resolution = { status: 'served', apiVersion: `${requirement.group}/${version}` };
      break;
    }
    if (probe.status === 'unknown') {
      failures.push({
        groupVersion: `${requirement.group}/${version}`,
        failure: probe.failure,
        message: probe.message,
      });
    }
  }

  if (!resolution) {
    const firstFailure = failures[0];
    resolution = firstFailure
      ? {
          status: 'unknown',
          failure: firstFailure.failure,
          reason:
            `${requirement.kind} discovery against the cluster failed for ` +
            `${failures.map((entry) => entry.groupVersion).join(', ')} ` +
            `(${firstFailure.message}), so whether the cluster serves the kind is unknown`,
        }
      : {
          status: 'unserved',
          reason: `the cluster does not serve ${requirement.kind} at any of ${groupVersions.join(', ')}`,
        };
  }

  writeCache(
    clusterId,
    requirement.id,
    resolution,
    resolution.status === 'unknown' ? unknownTtlMs : ttlMs
  );
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
 * Resolution failures are not fatal: a requirement that cannot be resolved
 * comes back `unknown`, which makes the caller skip the resource just as
 * `unserved` does — the whole point of the seam is that an unverified API is
 * never assumed to be present. The two are kept distinct so the caller can say
 * which happened rather than blaming the cluster for a network error.
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
