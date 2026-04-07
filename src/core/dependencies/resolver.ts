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
import type { KubernetesRef } from '../types/common.js';
import type { DeployableK8sResource, Enhanced } from '../types/kubernetes.js';
import { DependencyGraph } from './graph.js';

export class DependencyResolver {
  private logger = getComponentLogger('dependency-resolver');

  /**
   * Build a dependency graph from a collection of Kubernetes resources
   */
  buildDependencyGraph(
    resources: DeployableK8sResource<Enhanced<unknown, unknown>>[]
  ): DependencyGraph {
    const graph = new DependencyGraph();

    // Add all resources as nodes and build a reverse map from original
    // composition IDs (e.g., 'database') to graph IDs (e.g., 'testappResource0Database').
    // Marker strings in template literals use the original composition ID, but
    // the graph nodes use the prefixed deployment ID.
    const originalIdToGraphId = new Map<string, string>();
    for (const resource of resources) {
      graph.addNode(resource.id, resource);

      const originalId = getResourceId(resource);
      if (originalId && originalId !== resource.id) {
        originalIdToGraphId.set(originalId, resource.id);
      }
    }

    // Analyze each resource for references and add edges
    for (const resource of resources) {
      const references = this.extractReferences(resource);

      for (const ref of references) {
        // Skip schema references (these are internal TypeKro references)
        if (ref.resourceId !== '__schema__') {
          // Resolve the reference ID: try graph ID first, then original ID mapping
          const targetId = graph.hasNode(ref.resourceId)
            ? ref.resourceId
            : originalIdToGraphId.get(ref.resourceId);

          if (targetId) {
            try {
              graph.addEdge(resource.id, targetId);
            } catch {
              // Edge already exists — safe to ignore
            }
          } else {
            // Log warning if referenced resource doesn't exist in the graph
            // This might be an external reference that will be resolved at runtime
            this.logger.warn('Reference to unknown resource', {
              referencedResourceId: ref.resourceId,
              sourceResourceId: resource.id,
            });
          }
        }
      }
    }

    // Detect implicit namespace dependencies: if a resource has metadata.namespace
    // matching the metadata.name of a Namespace resource in the graph, the resource
    // depends on that Namespace being created first.
    const namespaceResources = new Map<string, string>(); // namespace name → resource graph ID
    for (const resource of resources) {
      if (resource.kind === 'Namespace' && resource.metadata?.name) {
        namespaceResources.set(resource.metadata.name, resource.id);
      }
    }

    if (namespaceResources.size > 0) {
      for (const resource of resources) {
        const ns = resource.metadata?.namespace;
        if (ns && namespaceResources.has(ns)) {
          const nsResourceId = namespaceResources.get(ns)!;
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
    const servicePatterns = new Map<string, { id: string; pattern: RegExp }>();
    for (const resource of resources) {
      const isDnsAddressable = getMetadataField(resource, 'dnsAddressable');
      if (isDnsAddressable && resource.metadata?.name) {
        const name = String(resource.metadata.name);
        if (name && !name.includes('$')) {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          servicePatterns.set(name, {
            id: resource.id,
            pattern: new RegExp(`(?:^|[/:@.])${escaped}(?:[/:@.]|$)`),
          });
        }
      }
    }

    if (servicePatterns.size > 0) {
      for (const resource of resources) {
        const stringValues = this.collectStringValues(resource);
        for (const value of stringValues) {
          for (const [svcName, { id: svcResourceId, pattern }] of servicePatterns) {
            if (svcResourceId !== resource.id && pattern.test(value)) {
              try {
                graph.addEdge(resource.id, svcResourceId);
                this.logger.debug('Added implicit service-name dependency', {
                  resource: resource.id,
                  referencedService: svcName,
                  serviceResource: svcResourceId,
                });
              } catch {
                // Node not found in graph — resource ID mismatch
              }
            }
          }
        }
      }
    }

    return graph;
  }

  /**
   * Collect all string values from a resource's spec fields (env vars,
   * container config, etc.). Used for implicit service-name dependency
   * detection. Only traverses `spec` — not `metadata` — to avoid
   * false positives from label values and annotation content.
   */
  private collectStringValues(
    resource: DeployableK8sResource<Enhanced<unknown, unknown>>
  ): string[] {
    const MAX_DEPTH = 20;
    const values: string[] = [];
    const traverse = (obj: unknown, depth = 0): void => {
      if (depth > MAX_DEPTH) return;
      if (typeof obj === 'string' && obj.length > 0 && obj.length < 500) {
        values.push(obj);
      } else if (Array.isArray(obj)) {
        for (const item of obj) traverse(item, depth + 1);
      } else if (obj !== null && typeof obj === 'object') {
        for (const value of Object.values(obj)) traverse(value, depth + 1);
      }
    };
    // Focus on spec.template.spec.containers (env vars) and metadata
    const spec = (resource as any)?.spec;
    if (spec) traverse(spec);
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

    // Simple regex to find resource references in CEL expressions
    // Pattern: resourceId.section.field (e.g., database.status.endpoint)
    const refPattern = /(\w+)\.(\w+)\.(\w+)/g;
    let match: RegExpExecArray | null = refPattern.exec(expression);

    while (match !== null) {
      const [, resourceId, section, field] = match;

      refs.push({
        [KUBERNETES_REF_BRAND]: true,
        resourceId,
        fieldPath: `${section}.${field}`,
      } as KubernetesRef);

      match = refPattern.exec(expression);
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
  analyzeDeletionOrder(
    graph: DependencyGraph,
    sharedResourceIds?: Set<string>
  ): DeploymentPlan {
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
