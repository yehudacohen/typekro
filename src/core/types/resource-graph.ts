/**
 * Resource Graph Types
 *
 * This module contains the ResourceGraph interface that represents
 * a complete resource graph with deployment capabilities.
 */

import type { DependencyGraph } from '../dependencies/graph.js';
import type {
  AlchemyDeploymentOptions,
  DeploymentOperationStatus,
  DeploymentOptions,
  DeploymentResult,
  RollbackResult,
} from './deployment.js';
import type { Enhanced } from './kubernetes.js';
import type { SchemaMagicProxy } from './references.js';

/**
 * Represents a complete resource graph with deployment capabilities
 */
export interface ResourceGraph<TSpec = any, TStatus = any> {
  /**
   * The name of this resource graph
   */
  name: string;

  /**
   * The resources in this graph
   */
  resources: Array<{
    id: string;
    manifest: Enhanced<any, any>;
  }>;

  /**
   * The dependency graph showing relationships between resources
   */
  dependencyGraph: DependencyGraph;

  /**
   * Schema proxy for accessing spec fields in a type-safe way
   */
  schema: SchemaMagicProxy<{ spec: TSpec; status: TStatus }>;

  /**
   * Deploy the resource graph to a Kubernetes cluster
   */
  deploy(options?: DeploymentOptions): Promise<DeploymentResult>;

  /**
   * Deploy the resource graph through alchemy's resource management system
   */
  deployWithAlchemy(scope: any, options?: AlchemyDeploymentOptions): Promise<DeploymentResult>;

  /**
   * Get the deployment status of this resource graph
   */
  getStatus(): Promise<DeploymentOperationStatus>;

  /**
   * Rollback the deployment of this resource graph
   */
  rollback(): Promise<RollbackResult>;

  /**
   * Perform a dry run deployment to validate the resource graph
   */
  toDryRun(options?: DeploymentOptions): Promise<DeploymentResult>;

  /**
   * Convert the resource graph to YAML for inspection or manual deployment
   */
  toYaml(): string;

  /**
   * Create a factory for this resource graph that can create instances
   */
  factory<TMode extends 'direct' | 'kro'>(
    mode: TMode,
    options?: { namespace?: string }
  ): Promise<any>;
}
