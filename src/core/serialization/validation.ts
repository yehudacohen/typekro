/**
 * Resource graph validation and dependency analysis
 */

import { extractResourceReferences, generateDeterministicResourceId } from '../../utils/index';
import { formatReferenceError } from '../errors.js';
import type { ValidationResult } from '../types/serialization.js';
import type { KubernetesResource } from '../types.js';

/**
 * Validate resource graph for cycles and missing dependencies
 */
export function validateResourceGraph(
  resources: Record<string, KubernetesResource>
): ValidationResult {
  const errors: string[] = [];

  // Extract all references and check for missing targets
  const resourceIds = new Set<string>();
  const allReferences: { from: string; to: string; field: string }[] = [];

  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate deterministic one
    const resourceId =
      (resource as { __resourceId?: string }).__resourceId ||
      generateDeterministicResourceId(
        resource.kind,
        resource.metadata?.name || resourceName,
        resource.metadata?.namespace
      );
    resourceIds.add(resourceId);

    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      allReferences.push({
        from: resourceId,
        to: ref.resourceId,
        field: ref.fieldPath,
      });
    }
  }

  // Check for missing dependencies with enhanced error messages
  for (const ref of allReferences) {
    if (!resourceIds.has(ref.to)) {
      const availableResources = Array.from(resourceIds);
      const referenceError = formatReferenceError(ref.from, ref.to, ref.field, availableResources);
      errors.push(referenceError.message);
      if (referenceError.suggestions) {
        errors.push(...referenceError.suggestions.map((s) => `  Suggestion: ${s}`));
      }
    }
  }

  // Check for cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    if (recursionStack.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }

    visited.add(nodeId);
    recursionStack.add(nodeId);

    // Find all dependencies of this node
    const dependencies = allReferences.filter((ref) => ref.from === nodeId);
    for (const dep of dependencies) {
      if (hasCycle(dep.to)) {
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const resourceId of resourceIds) {
    if (!visited.has(resourceId) && hasCycle(resourceId)) {
      errors.push(`Circular dependency detected involving resource '${resourceId}'`);
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get dependency order for resources (topological sort)
 */
export function getDependencyOrder(resources: Record<string, KubernetesResource>): string[] {
  const resourceIds = new Map<string, string>();
  const dependencies: { from: string; to: string }[] = [];

  // Build dependency graph
  for (const [resourceName, resource] of Object.entries(resources)) {
    // Use the embedded resource ID if available, otherwise generate deterministic one
    const resourceId =
      (resource as { __resourceId?: string }).__resourceId ||
      generateDeterministicResourceId(
        resource.kind,
        resource.metadata?.name || resourceName,
        resource.metadata?.namespace
      );
    resourceIds.set(resourceName, resourceId);

    const refs = extractResourceReferences(resource);
    for (const ref of refs) {
      dependencies.push({
        from: resourceId,
        to: ref.resourceId,
      });
    }
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // Initialize
  for (const [resourceName] of Object.entries(resources)) {
    const resourceId = resourceIds.get(resourceName);
    if (resourceId) {
      inDegree.set(resourceId, 0);
      adjList.set(resourceId, []);
    }
  }

  // Build adjacency list and calculate in-degrees
  for (const dep of dependencies) {
    adjList.get(dep.from)?.push(dep.to);
    inDegree.set(dep.to, (inDegree.get(dep.to) || 0) + 1);
  }

  // Process nodes with no incoming edges
  const queue: string[] = [];
  const result: string[] = [];

  for (const [resourceId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(resourceId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current) {
      result.push(current);

      const neighbors = adjList.get(current) || [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);

        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  // Convert back to resource names
  const idToName = new Map<string, string>();
  for (const [name, id] of resourceIds.entries()) {
    idToName.set(id, name);
  }

  return result.map((id) => idToName.get(id)).filter((name): name is string => name !== undefined);
}

/**
 * Debug utility to visualize resource dependencies
 */
export function visualizeDependencies(resources: Record<string, KubernetesResource>): string {
  const lines: string[] = [];
  lines.push('Resource Dependency Graph:');
  lines.push('========================');

  for (const [resourceName, resource] of Object.entries(resources)) {
    const refs = extractResourceReferences(resource);

    if (refs.length === 0) {
      lines.push(`${resourceName} (no dependencies)`);
    } else {
      lines.push(`${resourceName} depends on:`);
      for (const ref of refs) {
        lines.push(`  - ${ref.resourceId}.${ref.fieldPath}`);
      }
    }
    lines.push('');
  }

  const order = getDependencyOrder(resources);
  lines.push('Deployment Order:');
  lines.push('-----------------');
  order.forEach((name, index) => {
    lines.push(`${index + 1}. ${name}`);
  });

  return lines.join('\n');
}
