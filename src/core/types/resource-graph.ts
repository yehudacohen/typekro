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
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
  RollbackResult,
} from './deployment.js';
import type { Enhanced } from './kubernetes.js';
import type { SchemaMagicProxy } from './references.js';
import type { KroCompatibleType, Scope } from './schema.js';

/**
 * Represents a complete resource graph with deployment capabilities
 */
export interface ResourceGraph<
  TSpec extends KroCompatibleType = KroCompatibleType,
  TStatus extends KroCompatibleType = KroCompatibleType,
> {
  /**
   * The name of this resource graph
   */
  name: string;

  /**
   * The resources in this graph
   */
  // biome-ignore lint/suspicious/noExplicitAny: resources are heterogeneous — Enhanced types are invariant so any is required
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
  deployWithAlchemy(scope: Scope, options?: AlchemyDeploymentOptions): Promise<DeploymentResult>;

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
  factory(mode: 'kro', options?: PublicFactoryOptions): KroResourceFactory<TSpec, TStatus>;
  factory(mode: 'direct', options?: PublicFactoryOptions): DirectResourceFactory<TSpec, TStatus>;
  factory(
    mode: 'kro' | 'direct',
    options?: PublicFactoryOptions
  ): KroResourceFactory<TSpec, TStatus> | DirectResourceFactory<TSpec, TStatus>;
}
