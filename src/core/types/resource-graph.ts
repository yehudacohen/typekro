/**
 * Resource Graph Types
 * 
 * This module contains types related to resource graphs to avoid
 * circular dependencies between deployment and serialization types.
 */

import type { DependencyGraph } from '../dependencies/graph.js';
import type { Enhanced } from './kubernetes.js';
import type { SchemaMagicProxy } from './references.js';

// Forward declare deployment types to avoid circular dependency
export interface DeploymentOptions {
  mode?: 'direct' | 'kro' | 'alchemy';
  namespace?: string;
  waitForReady?: boolean;
  timeout?: number;
}

export interface DeploymentResult {
  status: 'success' | 'failed' | 'partial';
  deploymentId: string;
  resources: any[];
  dependencyGraph: DependencyGraph;
  duration: number;
  errors: any[];
}

export interface DeploymentOperationStatus {
  status: 'pending' | 'deploying' | 'ready' | 'failed';
  message?: string;
  resources?: any[];
}

export interface RollbackResult {
  status: 'success' | 'failed';
  message?: string;
}

export interface AlchemyDeploymentOptions extends DeploymentOptions {
  scope?: any;
}

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