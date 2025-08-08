/**
 * Dependency Graph Data Structure
 *
 * Represents dependencies between Kubernetes resources and provides
 * efficient traversal and topological sorting capabilities.
 */

import { CircularDependencyError } from '../errors.js';
import type { DependencyNode } from '../types/dependencies.js';
import type { DeployableK8sResource, Enhanced } from '../types/kubernetes.js';

export class DependencyGraph {
  private nodes = new Map<string, DependencyNode>();

  /**
   * Add a node to the dependency graph
   */
  addNode(id: string, resource: DeployableK8sResource<Enhanced<unknown, unknown>>): void {
    if (this.nodes.has(id)) {
      throw new Error(`Node with id '${id}' already exists in dependency graph`);
    }

    this.nodes.set(id, {
      id,
      resource,
      dependencies: new Set(),
      dependents: new Set(),
    });
  }

  /**
   * Add a dependency edge from dependent to dependency
   * @param dependentId - The resource that depends on another
   * @param dependencyId - The resource being depended upon
   */
  addEdge(dependentId: string, dependencyId: string): void {
    const dependent = this.nodes.get(dependentId);
    const dependency = this.nodes.get(dependencyId);

    if (!dependent) {
      throw new Error(`Dependent node '${dependentId}' not found in graph`);
    }
    if (!dependency) {
      throw new Error(`Dependency node '${dependencyId}' not found in graph`);
    }

    dependent.dependencies.add(dependencyId);
    dependency.dependents.add(dependentId);
  }

  /**
   * Get all nodes in the graph
   */
  getNodes(): Map<string, DependencyNode> {
    return new Map(this.nodes);
  }

  /**
   * Get a specific node by ID
   */
  getNode(id: string): DependencyNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get all dependencies of a node
   */
  getDependencies(id: string): string[] {
    const node = this.nodes.get(id);
    return node ? Array.from(node.dependencies) : [];
  }

  /**
   * Get all dependents of a node
   */
  getDependents(id: string): string[] {
    const node = this.nodes.get(id);
    return node ? Array.from(node.dependents) : [];
  }

  /**
   * Check if the graph has any cycles
   */
  hasCycles(): boolean {
    try {
      this.getTopologicalOrder();
      return false;
    } catch (error) {
      return error instanceof CircularDependencyError;
    }
  }

  /**
   * Find cycles in the graph
   */
  findCycles(): string[][] {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (nodeId: string, path: string[]): void => {
      if (recursionStack.has(nodeId)) {
        // Found a cycle
        const cycleStart = path.indexOf(nodeId);
        cycles.push(path.slice(cycleStart).concat(nodeId));
        return;
      }

      if (visited.has(nodeId)) {
        return;
      }

      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = this.nodes.get(nodeId);
      if (node) {
        for (const dependencyId of node.dependencies) {
          dfs(dependencyId, [...path]);
        }
      }

      recursionStack.delete(nodeId);
      path.pop();
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId, []);
      }
    }

    return cycles;
  }

  /**
   * Get topological ordering of nodes
   * Throws CircularDependencyError if cycles are detected
   */
  getTopologicalOrder(): string[] {
    const inDegree = new Map<string, number>();
    const queue: string[] = [];
    const result: string[] = [];

    // Initialize in-degree count
    for (const [nodeId, node] of this.nodes) {
      inDegree.set(nodeId, node.dependencies.size);
      if (node.dependencies.size === 0) {
        queue.push(nodeId);
      }
    }

    // Process nodes with no dependencies
    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) break;
      result.push(nodeId);

      const node = this.nodes.get(nodeId);
      if (!node) continue;
      for (const dependentId of node.dependents) {
        const currentInDegree = inDegree.get(dependentId);
        if (currentInDegree === undefined) continue;
        const newInDegree = currentInDegree - 1;
        inDegree.set(dependentId, newInDegree);

        if (newInDegree === 0) {
          queue.push(dependentId);
        }
      }
    }

    // Check for cycles
    if (result.length !== this.nodes.size) {
      const cycles = this.findCycles();
      const cycle = cycles[0] || [];
      const cycleStr = `${cycle.join(' -> ')} -> ${cycle[0]}`;
      throw new CircularDependencyError(`Circular dependency detected: ${cycleStr}`, cycle);
    }

    return result;
  }

  /**
   * Get nodes that have no dependencies (can be deployed first)
   */
  getRootNodes(): string[] {
    return Array.from(this.nodes.entries())
      .filter(([_, node]) => node.dependencies.size === 0)
      .map(([id, _]) => id);
  }

  /**
   * Get nodes that have no dependents (can be deleted first during rollback)
   */
  getLeafNodes(): string[] {
    return Array.from(this.nodes.entries())
      .filter(([_, node]) => node.dependents.size === 0)
      .map(([id, _]) => id);
  }

  /**
   * Clone the dependency graph
   */
  clone(): DependencyGraph {
    const cloned = new DependencyGraph();

    // Add all nodes
    for (const [id, node] of this.nodes) {
      cloned.addNode(id, node.resource);
    }

    // Add all edges
    for (const [id, node] of this.nodes) {
      for (const dependencyId of node.dependencies) {
        cloned.addEdge(id, dependencyId);
      }
    }

    return cloned;
  }

  /**
   * Get a subgraph containing only the specified nodes and their relationships
   */
  getSubgraph(nodeIds: string[]): DependencyGraph {
    const subgraph = new DependencyGraph();
    const nodeIdSet = new Set(nodeIds);

    // Add nodes that exist in the original graph
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node) {
        subgraph.addNode(nodeId, node.resource);
      }
    }

    // Add edges between nodes in the subgraph
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node) {
        for (const dependencyId of node.dependencies) {
          if (nodeIdSet.has(dependencyId)) {
            subgraph.addEdge(nodeId, dependencyId);
          }
        }
      }
    }

    return subgraph;
  }
}

// CircularDependencyError is now imported from ../errors.js
