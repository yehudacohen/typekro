/**
 * Deployment State Discovery
 *
 * Reconstructs a DeploymentStateRecord for a factory+instance by querying
 * the cluster for resources labeled with typekro ownership metadata.
 *
 * This module implements the "cluster IS the state" model: there is no
 * separate state backend (ConfigMap, database, etc). Every typekro-managed
 * resource is tagged at deploy time with labels and annotations via
 * {@link applyTypekroTags}, and at delete time we walk the cluster to
 * find those resources and rebuild the graph from their annotations.
 *
 * ## Discovery strategy
 *
 * To cover every GVK a typekro composition might have touched, we:
 *
 *   1. Issue label-filtered list calls against a hardcoded set of
 *      built-in GVKs (Deployments, Services, Namespaces, etc.).
 *   2. List all CRDs on the cluster, extract their (group, version, kind,
 *      scope) tuples, and issue label-filtered list calls against each.
 *   3. Merge the results.
 *
 * Each list is scoped by a label selector, so even on large clusters the
 * response from a GVK with no matching resources is a near-empty payload.
 * The main cost is the number of list calls, which is bounded by
 * (built-in GVKs) + (CRDs on cluster) — typically 30-150 requests total
 * for a fresh discovery. Requests are issued with bounded parallelism.
 *
 * ## Why not use /apis discovery?
 *
 * The Kubernetes discovery API (`/apis`, `/api/v1`) gives a complete
 * list of API resources, but client-node 1.x doesn't expose a typed
 * helper for walking it, and we'd need to issue one request per group-
 * version anyway to get the `resources[]` list for each. Listing CRDs
 * directly is simpler and covers every custom kind; the hardcoded
 * built-in list covers the rest.
 *
 * ## Graph reconstruction
 *
 * Each discovered resource carries a `typekro.io/depends-on` annotation
 * containing a JSON array of composition-local ids it depends on. We
 * walk the discovered resources twice: first pass adds every id as a
 * graph node, second pass adds edges. Dangling edges (pointing to a
 * resource that no longer exists on the cluster) are silently dropped
 * — that's the expected state after a partial delete.
 */

import type * as k8s from '@kubernetes/client-node';
import { DependencyGraph } from '../dependencies/graph.js';
import { getComponentLogger } from '../logging/index.js';
import type { DeployedResource, DeploymentStateRecord } from '../types/deployment.js';
import type {
  CustomResourceDefinitionItem,
  CustomResourceDefinitionList,
  KubernetesResource,
} from '../types.js';
import {
  buildFactoryInstanceSelector,
  extractTypekroTags,
} from './resource-tagging.js';

const logger = getComponentLogger('deployment-state-discovery');

/**
 * GVK tuple used for per-kind list calls.
 *
 * `namespaced` is currently unused — all list calls use a cluster-wide
 * scan (namespace=undefined) because typekro compositions can span
 * multiple namespaces. The field is retained for a planned optimization
 * where namespace-scoped listing could reduce API server load on large
 * clusters by only querying namespaces the factory has touched.
 */
export interface GvkTarget {
  apiVersion: string;
  kind: string;
  namespaced: boolean;
}

/**
 * Built-in Kubernetes GVKs that typekro compositions commonly deploy.
 * Kept intentionally narrow: adding entries here costs one list call
 * per delete, so we only include kinds that are actually used by typekro
 * factories.
 *
 * If a user deploys a built-in kind not on this list (e.g., a
 * NetworkPolicy) and then deletes across processes, the resource will
 * be missed by discovery. The fix is to add it here. A broader
 * solution (full /apis walk) would be a follow-up optimization.
 *
 * With the `knownGvks` hint from the factory (see
 * `discoverDeployedResourcesByInstance`), this list is only used as a
 * fallback when the composition's resource templates are unavailable.
 *
 * Last audited: 2026-04-06.
 */
const BUILT_IN_GVKS: GvkTarget[] = [
  // Core API (v1)
  { apiVersion: 'v1', kind: 'Namespace', namespaced: false },
  { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
  { apiVersion: 'v1', kind: 'Secret', namespaced: true },
  { apiVersion: 'v1', kind: 'Service', namespaced: true },
  { apiVersion: 'v1', kind: 'ServiceAccount', namespaced: true },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim', namespaced: true },
  { apiVersion: 'v1', kind: 'PersistentVolume', namespaced: false },
  // Apps
  { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
  { apiVersion: 'apps/v1', kind: 'StatefulSet', namespaced: true },
  { apiVersion: 'apps/v1', kind: 'DaemonSet', namespaced: true },
  { apiVersion: 'apps/v1', kind: 'ReplicaSet', namespaced: true },
  // Batch
  { apiVersion: 'batch/v1', kind: 'Job', namespaced: true },
  { apiVersion: 'batch/v1', kind: 'CronJob', namespaced: true },
  // Networking
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', namespaced: true },
  { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespaced: true },
  // RBAC
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', namespaced: true },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', namespaced: true },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', namespaced: false },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', namespaced: false },
  // Autoscaling
  { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', namespaced: true },
  // Policy
  { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', namespaced: true },
];

/**
 * Enumerate every GVK typekro might need to query on this cluster:
 * hardcoded built-ins + every active CRD version.
 *
 * CRD listing failures (RBAC, transient errors) are logged and the
 * built-in list is returned alone so discovery can still make progress.
 */
export async function discoverClusterGvks(
  k8sApi: k8s.KubernetesObjectApi
): Promise<GvkTarget[]> {
  const targets: GvkTarget[] = [...BUILT_IN_GVKS];

  try {
    const crdList = (await k8sApi.list(
      'apiextensions.k8s.io/v1',
      'CustomResourceDefinition'
    )) as unknown as CustomResourceDefinitionList;

    for (const crd of crdList.items ?? []) {
      const crdTargets = gvkTargetsFromCrd(crd);
      targets.push(...crdTargets);
    }
  } catch (err) {
    logger.warn(
      'Failed to list CRDs during discovery — proceeding with built-in GVKs only',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }

  return targets;
}

/**
 * Extract GVK targets from a single CRD. A CRD may have multiple served
 * versions; we include each served version as its own target because
 * older resources may still exist at a non-storage version.
 */
function gvkTargetsFromCrd(crd: CustomResourceDefinitionItem): GvkTarget[] {
  const group = crd.spec?.group;
  const kind = crd.spec?.names?.kind;
  // CRD spec.scope is "Namespaced" | "Cluster". The typed interface in
  // typekro has [key: string]: unknown on spec, so cast to read it.
  const scope = (crd.spec as { scope?: string } | undefined)?.scope;
  if (!group || !kind) return [];
  const versions = crd.spec?.versions ?? [];
  const namespaced = scope !== 'Cluster';
  const targets: GvkTarget[] = [];
  for (const v of versions) {
    if (!v.served || !v.name) continue;
    targets.push({
      apiVersion: `${group}/${v.name}`,
      kind,
      namespaced,
    });
  }
  return targets;
}

/**
 * Discover the full set of resources belonging to a factory+instance and
 * rebuild a {@link DeploymentStateRecord} ready to feed into
 * {@link DirectDeploymentEngine.rollbackRecord}.
 *
 * Returns `undefined` if no resources match — legitimate state when the
 * instance has already been cleaned up, was never deployed, or was
 * deployed by a typekro version that did not tag resources.
 *
 * Resources are queried cluster-wide (namespace undefined) because
 * typekro compositions can span multiple namespaces (e.g., a webapp
 * composition may deploy operator resources in `cnpg-system` and
 * application resources in `default`). The label selector makes this
 * cheap even on large clusters.
 */
export async function discoverDeployedResourcesByInstance(
  k8sApi: k8s.KubernetesObjectApi,
  opts: {
    factoryName: string;
    instanceName: string;
    /**
     * GVK hint from the factory's resource templates. When provided,
     * only these kinds are queried — dropping a typical delete from
     * 100+ list calls to 5-10. Falls back to full cluster GVK
     * enumeration when omitted (e.g., bare engine calls without a
     * composition in hand).
     */
    knownGvks?: GvkTarget[];
  }
): Promise<DeploymentStateRecord | undefined> {
  const labelSelector = buildFactoryInstanceSelector(opts);
  const gvkTargets = opts.knownGvks?.length
    ? opts.knownGvks
    : await discoverClusterGvks(k8sApi);

  logger.debug('Discovering deployed resources by label', {
    factoryName: opts.factoryName,
    instanceName: opts.instanceName,
    gvkCount: gvkTargets.length,
    labelSelector,
  });

  // Issue list calls with bounded parallelism. Unbounded parallelism
  // can flood the API server on large clusters; 8 concurrent lists is
  // a reasonable default.
  const matches = await listWithConcurrency(
    gvkTargets,
    8,
    async (target) => {
      try {
        const result = await k8sApi.list<KubernetesResource>(
          target.apiVersion,
          target.kind,
          undefined, // namespace — cluster-wide scan
          undefined, // pretty
          undefined, // exact (deprecated)
          undefined, // export (deprecated)
          undefined, // fieldSelector
          labelSelector
        );
        return result.items ?? [];
      } catch (err) {
        // 404 on a GVK means the API server doesn't recognise that
        // kind — expected for CRDs that were uninstalled mid-discovery.
        // Log at debug so the noise doesn't drown out real errors.
        logger.debug('List failed for GVK during discovery', {
          apiVersion: target.apiVersion,
          kind: target.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    }
  );

  // Flatten and deduplicate by (kind, namespace, name). The same
  // resource shouldn't appear twice in practice, but defensive code
  // guards against CRDs that are served at multiple versions.
  const seen = new Set<string>();
  const uniqueResources: KubernetesResource[] = [];
  for (const item of matches.flat()) {
    const key = `${item.kind}/${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueResources.push(item);
  }

  if (uniqueResources.length === 0) {
    logger.debug('No resources found for instance', {
      factoryName: opts.factoryName,
      instanceName: opts.instanceName,
    });
    return undefined;
  }

  return buildRecordFromResources(uniqueResources, opts);
}

/**
 * Convert a set of discovered live resources into a DeploymentStateRecord.
 * Each resource's ownership metadata is pulled from its labels and
 * annotations, and the dependency graph is reconstructed from the
 * per-resource `depends-on` annotations.
 */
function buildRecordFromResources(
  resources: KubernetesResource[],
  opts: { factoryName: string; instanceName: string }
): DeploymentStateRecord {
  const deployedResources: DeployedResource[] = [];
  const idToResource = new Map<string, DeployedResource>();
  const dependenciesById = new Map<string, string[]>();

  // First pass: extract tags and build DeployedResource records
  let deploymentId: string | undefined;
  let earliestStart: Date | undefined;
  let factoryNamespace: string | undefined;

  for (const resource of resources) {
    const tags = extractTypekroTags(resource);
    const id = tags.resourceId;
    if (!id) {
      // A resource with no resource-id annotation can't participate in
      // graph reconstruction — it must have been tagged by a partial
      // upgrade or external mutator. Skip rather than crash.
      logger.debug('Skipping discovered resource with no resource-id annotation', {
        kind: resource.kind,
        name: resource.metadata?.name,
      });
      continue;
    }

    if (!deploymentId && tags.deploymentId) deploymentId = tags.deploymentId;
    if (!factoryNamespace && tags.factoryNamespace) {
      factoryNamespace = tags.factoryNamespace;
    }

    const deployedAt = toDate(resource.metadata?.creationTimestamp);
    if (deployedAt && (!earliestStart || deployedAt < earliestStart)) {
      earliestStart = deployedAt;
    }

    const deployed: DeployedResource = {
      id,
      kind: resource.kind ?? 'Unknown',
      name: resource.metadata?.name ?? 'unknown',
      namespace: resource.metadata?.namespace ?? '',
      manifest: resource,
      status: 'deployed',
      deployedAt: deployedAt ?? new Date(),
    };
    deployedResources.push(deployed);
    idToResource.set(id, deployed);
    if (tags.dependencies.length > 0) {
      dependenciesById.set(id, tags.dependencies);
    }
  }

  // Second pass: rebuild the dependency graph
  const dependencyGraph = new DependencyGraph();
  for (const [id, deployed] of idToResource.entries()) {
    // biome-ignore lint/suspicious/noExplicitAny: minimal plain manifest, not an Enhanced proxy
    dependencyGraph.addNode(id, deployed.manifest as any);
  }
  for (const [from, deps] of dependenciesById.entries()) {
    for (const to of deps) {
      // Skip dangling edges — the dependency may have been deleted
      // manually, or was never tagged (e.g., lifecycle: shared in an
      // older typekro version that we now find via annotations only).
      if (!idToResource.has(to)) continue;
      try {
        dependencyGraph.addEdge(from, to);
      } catch (err) {
        logger.debug('Failed to add edge during discovery — skipping', {
          from,
          to,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    deploymentId: deploymentId ?? `discovered-${Date.now()}`,
    resources: deployedResources,
    dependencyGraph,
    startTime: earliestStart ?? new Date(),
    status: 'completed',
    options: {
      mode: 'direct',
      ...(factoryNamespace && { namespace: factoryNamespace }),
      factoryName: opts.factoryName,
      instanceName: opts.instanceName,
    },
  };
}

/**
 * Safely convert a Kubernetes `creationTimestamp` to a Date.
 * The client-node deserializer returns a `Date` object, but defensive
 * callers may receive strings from raw JSON or test mocks.
 */
function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return undefined;
}

/**
 * Run an async function over an array with bounded parallelism. Used to
 * cap the number of simultaneous API requests during discovery.
 */
async function listWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) continue;
      results[idx] = await fn(item);
    }
  };
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
