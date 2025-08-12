/**
 * Dependency Resolution Engine
 *
 * Analyzes Kubernetes resources to build dependency graphs and provides
 * topological ordering for deployment.
 */

import { isCelExpression, isKubernetesRef } from '../../utils/index.js';
import { CircularDependencyError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import { KUBERNETES_REF_BRAND } from '../constants/brands.js';
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

    // Add all resources as nodes first
    for (const resource of resources) {
      graph.addNode(resource.id, resource);
    }

    // Analyze each resource for references and add edges
    for (const resource of resources) {
      const references = this.extractReferences(resource);

      for (const ref of references) {
        // Skip schema references (these are internal TypeKro references)
        if (ref.resourceId !== '__schema__') {
          try {
            graph.addEdge(resource.id, ref.resourceId);
          } catch {
            // Log warning if referenced resource doesn't exist in the graph
            // This might be an external reference that will be resolved at runtime
            this.logger.warn('Reference to unknown resource', {
              referencedResourceId: ref.resourceId,
              sourceResourceId: resource.id
            });
          }
        }
      }
    }

    return graph;
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
        throw new Error('Unable to determine deployment order - possible circular dependency');
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
