/**
 * Dependency-related types
 */

import type { DeployableK8sResource, Enhanced } from './kubernetes.js';

/**
 * Represents a node in the dependency graph
 */
export interface DependencyNode {
  id: string;
  resource: DeployableK8sResource<Enhanced<unknown, unknown>>;
  dependencies: Set<string>; // Resources this node depends on
  dependents: Set<string>; // Resources that depend on this node
}
