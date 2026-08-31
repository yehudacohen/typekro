/**
 * Dependency Resolution Engine
 *
 * Analyzes Kubernetes resources to build dependency graphs and provides
 * topological ordering for deployment.
 */

import { isCelExpression, isKubernetesRef } from '../../utils/type-guards.js';
import { KUBERNETES_REF_BRAND, KUBERNETES_REF_MARKER_PATTERN } from '../constants/brands.js';
import { CircularDependencyError, TypeKroError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { getMetadataField, getResourceId } from '../metadata/index.js';
import {
  collectCelLambdaScopes,
  isCelLambdaLocalAt,
  maskCelStringLiterals,
} from '../references/cel-lexical-scanner.js';
import type { KubernetesRef } from '../types/common.js';
import type { DeployableK8sResource, Enhanced } from '../types/kubernetes.js';
import { DependencyGraph } from './graph.js';

export class DependencyResolver {
  private logger = getComponentLogger('dependency-resolver');

  private static readonly CLUSTER_SERVICE_SUFFIX_PATTERN =
    /^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?|\.cluster\.local)$/i;
  private static readonly BARE_HOST_KEY_PATTERN =
    /(?:^|_)(?:DB|DATABASE|REDIS|VALKEY|CACHE|SERVICE|UPSTREAM|POSTGRES|PG)_(?:HOST|SERVER)$/i;

  /**
   * Build a dependency graph from a collection of Kubernetes resources
   */
  buildDependencyGraph(
    resources: DeployableK8sResource<Enhanced<unknown, unknown>>[],
    options: { readonly knownExternalResourceIds?: ReadonlySet<string> } = {}
  ): DependencyGraph {
    const graph = new DependencyGraph();

    // Add all resources as nodes and build a reverse map from every authored
    // identity to graph IDs. References may use the graph ID, the resource's
    // original composition ID, or a local-variable/callback alias preserved in
    // resource metadata. Nested compositions prefix graph IDs, so resolving only
    // the original resource ID loses otherwise valid dependencies.
    const identityToGraphIds = new Map<string, Set<string>>();
    const registerIdentity = (identity: string | undefined, graphId: string): void => {
      if (!identity) return;
      const owners = identityToGraphIds.get(identity) ?? new Set<string>();
      owners.add(graphId);
      identityToGraphIds.set(identity, owners);
    };
    for (const resource of resources) {
      graph.addNode(resource.id, resource);

      const originalId = getResourceId(resource);
      registerIdentity(resource.id, resource.id);
      registerIdentity(originalId, resource.id);
      for (const alias of getMetadataField(resource, 'resourceAliases') ?? []) {
        registerIdentity(alias, resource.id);
      }
    }

    // Analyze each resource for references and add edges
    for (const resource of resources) {
      const references = this.extractReferences(resource);
      const warnedUnknownReferences = new Set<string>();

      for (const ref of references) {
        // Skip schema references (these are internal TypeKro references)
        if (ref.resourceId !== '__schema__' && ref.resourceId !== 'schema') {
          const targetId = this.resolveResourceIdentity(
            ref.resourceId,
            identityToGraphIds,
            resource
          );

          if (targetId) {
            try {
              graph.addEdge(resource.id, targetId);
            } catch {
              // Edge already exists — safe to ignore
            }
          } else {
            // Log warning if referenced resource doesn't exist in the graph
            // This might be an external reference that will be resolved at runtime
            if (!warnedUnknownReferences.has(ref.resourceId)) {
              warnedUnknownReferences.add(ref.resourceId);
              this.logger.warn('Reference to unknown resource', {
                referencedResourceId: ref.resourceId,
                sourceResourceId: resource.id,
              });
            }
          }
        }
      }

      const explicitDependencies = getMetadataField(resource, 'dependsOn') as
        | Array<{ resourceId: string }>
        | undefined;
      for (const dep of explicitDependencies ?? []) {
        const targetId = this.resolveResourceIdentity(
          dep.resourceId,
          identityToGraphIds,
          resource
        );
        if (!targetId) {
          if (options.knownExternalResourceIds?.has(dep.resourceId)) {
            this.logger.debug('Skipping apply-order edge to known external resource', {
              sourceResourceId: resource.id,
              dependencyResourceId: dep.resourceId,
            });
            continue;
          }
          throw new TypeKroError(
            `dependsOn target '${dep.resourceId}' was not found in resource graph`,
            'INVALID_DEPENDENCY_TARGET',
            { sourceResourceId: resource.id, dependencyResourceId: dep.resourceId }
          );
        }
        try {
          graph.addEdge(resource.id, targetId);
        } catch {
          // Edge already exists — safe to ignore
        }
      }
    }

    // Detect implicit namespace dependencies: if a resource has metadata.namespace
    // matching the metadata.name of a Namespace resource in the graph, the resource
    // depends on that Namespace being created first.
    const namespaceResources = new Map<string, string>(); // namespace name → resource graph ID
    for (const resource of resources) {
      const namespaceName = resource.metadata?.name;
      if (
        resource.kind === 'Namespace' &&
        typeof namespaceName === 'string' &&
        namespaceName.length > 0
      ) {
        namespaceResources.set(namespaceName, resource.id);
      }
    }

    if (namespaceResources.size > 0) {
      for (const resource of resources) {
        const ns = resource.metadata?.namespace;
        if (typeof ns === 'string' && namespaceResources.has(ns)) {
          const nsResourceId = namespaceResources.get(ns);
          if (!nsResourceId) continue;
          // Don't add self-dependency
          if (nsResourceId !== resource.id) {
            try {
              graph.addEdge(resource.id, nsResourceId);
              this.logger.debug('Added implicit namespace dependency', {
                resource: resource.id,
                namespace: ns,
                namespaceResource: nsResourceId,
              });
            } catch {
              // Edge already exists or other issue — safe to ignore
            }
          }
        }
      }
    }

    // Detect implicit service-name dependencies: if a resource's env vars
    // or spec fields contain the metadata.name of another resource that
    // provides a network service (Service, StatefulSet, Deployment), add
    // a dependency edge. This catches patterns like:
    //   VALKEY_HOST: "myapp-cache"
    //   DATABASE_URL: "postgresql://app@myapp-db-pooler:5432/db"
    // where the hostname is the metadata.name of another resource in the
    // graph. Without this, resources that reference nested composition
    // status (which resolves to real strings in direct mode) would deploy
    // in parallel with the services they depend on.
    // Detect DNS-addressable resources: resources marked with
    // `dnsAddressable: true` in their metadata (set by factory functions
    // like service(), deployment(), valkey(), cluster(), etc.).
    // Precompile regex patterns once per service name to avoid creating
    // a new RegExp on every (resource × stringValue × serviceName) pair.
    const dnsAddressableResourcesByName = new Map<
      string,
      Array<{ id: string; namespace?: string }>
    >();
    const serviceResourceIdsByQualifiedHost = new Map<string, Set<string>>();
    for (const resource of resources) {
      const isDnsAddressable = getMetadataField(resource, 'dnsAddressable');
      const resourceName = resource.metadata?.name;
      if (isDnsAddressable && typeof resourceName === 'string') {
        const name = resourceName;
        if (name && !name.includes('$')) {
          const normalizedName = name.toLowerCase();
          const rawNamespace = resource.metadata?.namespace;
          const namespace =
            typeof rawNamespace === 'string' ? rawNamespace.toLowerCase() : undefined;
          const existing = dnsAddressableResourcesByName.get(normalizedName) ?? [];
          existing.push({ id: resource.id, ...(namespace ? { namespace } : {}) });
          dnsAddressableResourcesByName.set(normalizedName, existing);

          if (namespace) {
            const qualifiedHosts = [
              `${normalizedName}.${namespace}.svc`,
              `${normalizedName}.${namespace}.svc.cluster.local`,
            ];

            for (const host of qualifiedHosts) {
              const qualifiedIds = serviceResourceIdsByQualifiedHost.get(host) ?? new Set<string>();
              qualifiedIds.add(resource.id);
              serviceResourceIdsByQualifiedHost.set(host, qualifiedIds);
            }
          }
        }
      }
    }

    if (dnsAddressableResourcesByName.size > 0) {
      for (const resource of resources) {
        const stringValues = this.collectStringValues(resource);
        for (const entry of stringValues) {
          for (const host of this.extractHostCandidates(entry.value, entry.key)) {
            const rawSourceNamespace = resource.metadata?.namespace;
            const matchedServices = this.resolveDnsAddressableServiceIds(
              host,
              typeof rawSourceNamespace === 'string' ? rawSourceNamespace.toLowerCase() : undefined,
              dnsAddressableResourcesByName,
              serviceResourceIdsByQualifiedHost
            );
            for (const svcResourceId of matchedServices.ids) {
              if (svcResourceId === resource.id) continue;
              try {
                graph.addEdge(resource.id, svcResourceId);
                this.logger.debug('Added implicit service-name dependency', {
                  resource: resource.id,
                  referencedHost: host,
                  referencedService: matchedServices.serviceName,
                  serviceResource: svcResourceId,
                });
              } catch (err) {
                this.logger.debug('Failed to add service-name dependency edge', {
                  resource: resource.id,
                  target: svcResourceId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
      }
    }

    return graph;
  }

  private resolveResourceIdentity(
    identity: string,
    identityToGraphIds: ReadonlyMap<string, ReadonlySet<string>>,
    sourceResource: DeployableK8sResource<Enhanced<unknown, unknown>>
  ): string | undefined {
    const sourceResourceId = sourceResource.id;
    const scopedTarget = getMetadataField(sourceResource, 'resourceAliasTargets')?.[identity];
    if (scopedTarget) {
      const scopedOwners = identityToGraphIds.get(scopedTarget);
      if (scopedOwners?.size === 1) return scopedOwners.values().next().value;
    }

    const owners = identityToGraphIds.get(identity);
    if (!owners || owners.size === 0) return undefined;
    if (owners.size > 1) {
      throw new TypeKroError(
        `Resource identity '${identity}' referenced by '${sourceResourceId}' is ambiguous between resources ${[
          ...owners,
        ]
          .map((owner) => `'${owner}'`)
          .join(' and ')}`,
        'AMBIGUOUS_DEPENDENCY_REFERENCE',
        {
          sourceResourceId,
          referencedResourceId: identity,
          owners: [...owners],
        }
      );
    }
    return owners.values().next().value;
  }

  /**
   * Collect string values from a resource's container env vars and
   * connection-string-like fields. Focused extraction avoids false
   * positives from labels, resource limits ("500m"), annotation
   * content, and other spec fields that happen to contain short
   * substrings matching service names.
   */
  /**
   * Fields whose string values should be excluded from hostname detection.
   * Container `image` fields use `:` as a tag separator (e.g., `myapp:latest`)
   * which the hostname regex treats as a port delimiter — creating false
   * dependency edges when a Service shares a name with its image base name.
   */
  private static readonly EXCLUDED_KEYS = new Set(['image', 'imagePullPolicy']);

  private resolveDnsAddressableServiceIds(
    host: string,
    sourceNamespace: string | undefined,
    resourcesByName: Map<string, Array<{ id: string; namespace?: string }>>,
    resourcesByQualifiedHost: Map<string, Set<string>>
  ): { serviceName: string; ids: string[] } {
    const directNameMatch = resourcesByName.get(host);
    if (directNameMatch && directNameMatch.length > 0) {
      if (sourceNamespace) {
        const sameNamespaceMatches = directNameMatch
          .filter((resource) => resource.namespace === sourceNamespace)
          .map((resource) => resource.id);
        if (sameNamespaceMatches.length > 0) {
          return { serviceName: host, ids: sameNamespaceMatches };
        }

        return { serviceName: host, ids: [] };
      }

      return { serviceName: host, ids: [] };
    }

    const exactQualifiedMatch = resourcesByQualifiedHost.get(host);
    if (exactQualifiedMatch && exactQualifiedMatch.size > 0) {
      return {
        serviceName: host.split('.')[0] ?? host,
        ids: Array.from(exactQualifiedMatch),
      };
    }

    const clusterSuffixMatch = host.match(DependencyResolver.CLUSTER_SERVICE_SUFFIX_PATTERN);
    if (clusterSuffixMatch) {
      const serviceName = clusterSuffixMatch[1]?.toLowerCase();
      const explicitNamespace = clusterSuffixMatch[2]?.toLowerCase();
      if (serviceName) {
        const sameNamedResources = resourcesByName.get(serviceName) ?? [];
        if (explicitNamespace) {
          const exactNamespaceMatches = sameNamedResources
            .filter((resource) => resource.namespace === explicitNamespace)
            .map((resource) => resource.id);
          if (exactNamespaceMatches.length > 0) {
            return { serviceName, ids: exactNamespaceMatches };
          }

          return { serviceName, ids: [] };
        }

        if (sourceNamespace) {
          const sameNamespaceMatches = sameNamedResources
            .filter((resource) => resource.namespace === sourceNamespace)
            .map((resource) => resource.id);
          if (sameNamespaceMatches.length > 0) {
            return { serviceName, ids: sameNamespaceMatches };
          }

          return { serviceName, ids: [] };
        }

        return { serviceName, ids: [] };
      }
    }

    return { serviceName: host, ids: [] };
  }

  private extractHostCandidates(value: string, key?: string): string[] {
    const hosts = new Set<string>();
    const trimmedValue = value.trim();

    const authorityMatches = value.matchAll(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/\s]+)/g);
    for (const match of authorityMatches) {
      const authority = match[1];
      if (!authority) continue;
      const hostPort = authority.includes('@') ? authority.split('@').at(-1) : authority;
      const host = hostPort?.split(':')[0];
      if (host) hosts.add(host.toLowerCase());
    }

    const userHostMatches = value.matchAll(
      /(^|[^\w.-])[^\s@/:]+@([a-z0-9.-]+)(?::\d+)?(?=$|[/?\s])/gi
    );
    for (const match of userHostMatches) {
      const host = match[2];
      if (host) hosts.add(host.toLowerCase());
    }

    const hostWithPortMatches = value.matchAll(
      /(^|[^\w.-])([a-z0-9-]+(?:\.[a-z0-9-]+)*)(:\d+)(?=$|[/?\s])/gi
    );
    for (const match of hostWithPortMatches) {
      const host = match[2];
      if (host) hosts.add(host.toLowerCase());
    }

    const dottedHostMatches = value.matchAll(
      /(^|[^\w.-])([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=$|[/?\s])/gi
    );
    for (const match of dottedHostMatches) {
      const host = match[2];
      if (host) hosts.add(host.toLowerCase());
    }

    // Support env-style host values like `VALKEY_HOST=myapp-cache` without
    // reopening broad bare-token matching for arbitrary string values.
    if (
      key &&
      DependencyResolver.BARE_HOST_KEY_PATTERN.test(key) &&
      /^[a-z0-9-]+$/i.test(trimmedValue)
    ) {
      hosts.add(trimmedValue.toLowerCase());
    }

    return Array.from(hosts);
  }

  private collectStringValues(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>
  ): Array<{ value: string; key?: string }> {
    const values: Array<{ value: string; key?: string }> = [];
    const addString = (v: unknown, key?: string): void => {
      if (typeof v === 'string' && v.length > 0 && v.length < 500) {
        // Skip fields that produce false positives in hostname matching.
        if (key && DependencyResolver.EXCLUDED_KEYS.has(key)) return;
        values.push({ value: v, ...(key ? { key } : {}) });
      }
    };

    // Extract env var values from all containers and initContainers
    const podSpec = (resource as { spec?: { template?: { spec?: Record<string, unknown> } } })?.spec
      ?.template?.spec;
    const containers = [
      ...(Array.isArray(podSpec?.containers) ? podSpec.containers : []),
      ...(Array.isArray(podSpec?.initContainers) ? podSpec.initContainers : []),
    ];
    if (containers.length > 0) {
      for (const container of containers) {
        if (Array.isArray(container?.env)) {
          for (const envVar of container.env) {
            addString(envVar?.value, envVar?.name);
          }
        }
        // Also check envFrom secretRef/configMapRef names
        if (Array.isArray(container?.envFrom)) {
          for (const source of container.envFrom) {
            addString(source?.secretRef?.name, 'secretRef.name');
            addString(source?.configMapRef?.name, 'configMapRef.name');
          }
        }
        // Check command and args (may reference service hostnames)
        if (Array.isArray(container?.command)) {
          for (const arg of container.command) addString(arg);
        }
        if (Array.isArray(container?.args)) {
          for (const arg of container.args) addString(arg);
        }
      }
    }

    // For non-Deployment resources (e.g., HelmRelease values, CRD specs),
    // fall back to shallow traversal of spec.* string fields (depth 1-2).
    if (containers.length === 0) {
      const MAX_DEPTH = 3;
      const traverse = (obj: unknown, depth = 0, key?: string): void => {
        if (depth > MAX_DEPTH) return;
        if (typeof obj === 'string' && obj.length > 0 && obj.length < 500) {
          if (key && DependencyResolver.EXCLUDED_KEYS.has(key)) return;
          values.push({ value: obj, ...(key ? { key } : {}) });
        } else if (Array.isArray(obj)) {
          for (const item of obj) traverse(item, depth + 1);
        } else if (obj !== null && typeof obj === 'object') {
          for (const [k, value] of Object.entries(obj)) traverse(value, depth + 1, k);
        }
      };
      const spec = (resource as { spec?: unknown })?.spec;
      if (spec) traverse(spec);
    }

    return values;
  }

  /**
   * Get topological ordering of resources for deployment
   */
  getTopologicalOrder(graph: DependencyGraph): string[] {
    return graph.getTopologicalOrder();
  }

  /**
   * Validate that the dependency graph has no cycles
   */
  validateNoCycles(graph: DependencyGraph): void {
    if (graph.hasCycles()) {
      const cycles = graph.findCycles();
      const cycle = cycles[0] || [];
      const cycleStr = `${cycle.join(' -> ')} -> ${cycle[0]}`;
      throw new CircularDependencyError(`Circular dependency detected: ${cycleStr}`, cycle);
    }
  }

  /**
   * Extract all references from a resource
   */
  private extractReferences(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>
  ): KubernetesRef[] {
    const refs: KubernetesRef[] = [];

    const traverse = (obj: unknown, path: string = ''): void => {
      if (obj === null || obj === undefined) {
        return;
      }

      if (isKubernetesRef(obj)) {
        refs.push(obj);
      } else if (isCelExpression(obj)) {
        // Parse CEL expression for references
        const celRefs = this.parseCelReferences(obj.expression);
        refs.push(...celRefs);
      } else if (typeof obj === 'string') {
        // Detect embedded KubernetesRef marker strings from template literals.
        // Format: __KUBERNETES_REF_{resourceId}_{fieldPath}__
        const markerRefs = this.parseMarkerReferences(obj);
        refs.push(...markerRefs);
      } else if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
          traverse(item, `${path}[${index}]`);
        });
      } else if (typeof obj === 'object') {
        for (const [key, value] of Object.entries(obj)) {
          traverse(value, path ? `${path}.${key}` : key);
        }
      }
    };

    traverse(resource);
    return refs;
  }

  /**
   * Parse embedded KubernetesRef marker strings from serialized values.
   *
   * When a KubernetesRef proxy is used in a template literal (e.g.,
   * `postgresql://${database.status.writeService}:5432/mydb`), the
   * Symbol.toPrimitive handler produces a marker string:
   *   __KUBERNETES_REF_{resourceId}_{fieldPath}__
   *
   * This method extracts those markers so the dependency resolver can
   * detect references to other resources embedded in string values.
   * The same marker format is used by schema-proxy.ts.
   */
  private parseMarkerReferences(value: string): KubernetesRef[] {
    const refs: KubernetesRef[] = [];
    // Match __KUBERNETES_REF_{resourceId}_{fieldPath}__
    // resourceId: word chars, hyphens, digits (e.g., 'database', 'inngest-bootstrap1')
    // fieldPath: word chars, dots, hyphens (e.g., 'status.writeService', 'metadata.name')
    // Exclude __schema__ refs — those are schema proxy refs, not resource dependencies
    const markerPattern = new RegExp(KUBERNETES_REF_MARKER_PATTERN.source, 'g');
    let match: RegExpExecArray | null = markerPattern.exec(value);

    while (match !== null) {
      const [, resourceId, fieldPath] = match;
      refs.push({
        [KUBERNETES_REF_BRAND]: true,
        resourceId,
        fieldPath,
      } as KubernetesRef);
      match = markerPattern.exec(value);
    }

    return refs;
  }

  /**
   * Parse CEL expressions to extract resource references
   */
  private parseCelReferences(expression: string): KubernetesRef[] {
    const refs: KubernetesRef[] = [];
    const searchableExpression = maskCelStringLiterals(expression);
    const lambdaScopes = collectCelLambdaScopes(searchableExpression);

    // Pattern: resourceId.section.field (e.g., database.status.endpoint)
    const refPattern =
      /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let match: RegExpExecArray | null = refPattern.exec(searchableExpression);

    while (match !== null) {
      const [, resourceId, section, field] = match;
      if (!resourceId || !section || !field) {
        match = refPattern.exec(searchableExpression);
        continue;
      }
      if (isCelLambdaLocalAt(resourceId, match.index, lambdaScopes)) {
        match = refPattern.exec(searchableExpression);
        continue;
      }

      // A three-segment window can begin in the middle of a longer member or
      // DNS chain. For example, a resource-derived template ending in
      // `.svc.cluster.local` previously invented a dependency on a resource
      // named `svc`. Real resource references begin at a CEL token boundary;
      // a preceding dot proves that this match is only a suffix.
      if (match.index > 0 && searchableExpression[match.index - 1] === '.') {
        match = refPattern.exec(searchableExpression);
        continue;
      }

      refs.push({
        [KUBERNETES_REF_BRAND]: true,
        resourceId: resourceId === 'schema' ? '__schema__' : resourceId,
        fieldPath: `${section}.${field}`,
      } as KubernetesRef);

      match = refPattern.exec(searchableExpression);
    }

    return refs;
  }

  /**
   * Analyze deployment order and identify parallelizable resources
   */
  analyzeDeploymentOrder(graph: DependencyGraph): DeploymentPlan {
    const topologicalOrder = graph.getTopologicalOrder();
    const levels: string[][] = [];
    const processed = new Set<string>();

    // Group resources by dependency level
    while (processed.size < topologicalOrder.length) {
      const currentLevel: string[] = [];

      for (const resourceId of topologicalOrder) {
        if (processed.has(resourceId)) {
          continue;
        }

        // Check if all dependencies are already processed
        const dependencies = graph.getDependencies(resourceId);
        const allDependenciesProcessed = dependencies.every((dep) => processed.has(dep));

        if (allDependenciesProcessed) {
          currentLevel.push(resourceId);
        }
      }

      if (currentLevel.length === 0) {
        throw new TypeKroError(
          'Unable to determine deployment order - possible circular dependency',
          'DEPLOYMENT_ORDER_FAILED',
          { processedCount: processed.size, totalCount: topologicalOrder.length }
        );
      }

      levels.push(currentLevel);
      currentLevel.forEach((id) => processed.add(id));
    }

    return {
      levels,
      totalResources: topologicalOrder.length,
      maxParallelism: Math.max(...levels.map((level) => level.length)),
    };
  }

  /**
   * Analyze deletion order — reverse of deployment levels.
   *
   * Returns parallelizable levels where the LAST deployment level (leaf
   * resources with the most dependencies) is deleted FIRST. This ensures
   * dependents are removed before their dependencies (e.g., App before
   * Database, Database before Namespace).
   *
   * Resources with `lifecycle: 'shared'` are excluded from the deletion plan.
   */
  analyzeDeletionOrder(graph: DependencyGraph, sharedResourceIds?: Set<string>): DeploymentPlan {
    // Build a subgraph excluding shared resources
    const deletionGraph = sharedResourceIds
      ? this.buildDeletionSubgraph(graph, sharedResourceIds)
      : graph;

    const deploymentPlan = this.analyzeDeploymentOrder(deletionGraph);

    return {
      levels: [...deploymentPlan.levels].reverse(),
      totalResources: deploymentPlan.totalResources,
      maxParallelism: deploymentPlan.maxParallelism,
    };
  }

  /**
   * Build a subgraph excluding shared resources for deletion planning.
   */
  private buildDeletionSubgraph(
    graph: DependencyGraph,
    sharedResourceIds: Set<string>
  ): DependencyGraph {
    const subgraph = new DependencyGraph();

    for (const nodeId of graph.getTopologicalOrder()) {
      if (sharedResourceIds.has(nodeId)) continue;
      const node = graph.getNode(nodeId);
      if (node) subgraph.addNode(nodeId, node.resource);
    }

    for (const nodeId of graph.getTopologicalOrder()) {
      if (sharedResourceIds.has(nodeId)) continue;
      for (const dep of graph.getDependencies(nodeId)) {
        if (sharedResourceIds.has(dep)) continue;
        if (subgraph.hasNode(dep)) {
          subgraph.addEdge(nodeId, dep);
        }
      }
    }

    return subgraph;
  }

  /**
   * Get rollback order (reverse of deployment order)
   */
  getRollbackOrder(graph: DependencyGraph): string[] {
    const deploymentOrder = graph.getTopologicalOrder();
    return deploymentOrder.reverse();
  }

  /**
   * Find resources that can be deployed independently
   */
  findIndependentResources(graph: DependencyGraph): string[] {
    return graph.getRootNodes();
  }

  /**
   * Find resources that nothing else depends on
   */
  findTerminalResources(graph: DependencyGraph): string[] {
    return graph.getLeafNodes();
  }
}

export interface DeploymentPlan {
  levels: string[][]; // Resources grouped by dependency level
  totalResources: number;
  maxParallelism: number;
}

// CircularDependencyError is now imported from ../errors.js
