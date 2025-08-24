/**
 * Deployment-related types
 */

import type { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';

import type { DependencyGraph } from '../dependencies/index.js';
import type { KubernetesRef } from './common.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from './kubernetes.js';
import type { KroCompatibleType, SchemaProxy, Scope } from './serialization.js';

/**
 * Represents a deployed Kubernetes resource with metadata about its deployment status
 */
export interface DeployedResource {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  manifest: KubernetesResource;
  status: 'deployed' | 'ready' | 'failed';
  deployedAt: Date;
  error?: Error;
  alchemyResourceId?: string;
  alchemyResourceType?: string;
}

// =============================================================================
// YAML CLOSURE TYPES
// =============================================================================

/**
 * Represents a resource applied by a deployment closure
 */
export interface AppliedResource {
  kind: string;
  name: string;
  namespace?: string | undefined;
  apiVersion: string;
}

/**
 * Context provided to YAML closures during deployment execution
 */
export interface DeploymentContext {
  kubernetesApi?: KubernetesObjectApi;
  alchemyScope?: Scope;
  namespace?: string;
  // Level-based execution context - enables future closure extensibility
  deployedResources: Map<string, DeployedResource>; // Resources available at this level
  resolveReference: (ref: KubernetesRef) => Promise<unknown>; // Resolve cross-resource references
}

/**
 * A closure that executes deployment operations during the deployment phase
 * Generic type that can be used for YAML, Terraform, Pulumi, or any other deployment operations
 */
export type DeploymentClosure<T = AppliedResource[]> = (
  deploymentContext: DeploymentContext
) => Promise<T>;

/**
 * Information about a closure's dependencies for level-based execution
 */
export interface ClosureDependencyInfo {
  name: string;
  closure: DeploymentClosure;
  dependencies: string[]; // Resource IDs that this closure depends on
  level: number; // Execution level determined by dependency analysis
}

/**
 * Enhanced deployment plan that includes both resources and closures organized by execution level
 */
export interface EnhancedDeploymentPlan {
  levels: Array<{
    resources: string[];
    closures: ClosureDependencyInfo[];
  }>;
  totalResources: number;
  totalClosures: number;
  maxParallelism: number;
}

// =============================================================================
// DEPLOYMENT OPTIONS AND CONFIGURATION
// =============================================================================

export interface DeploymentOptions {
  mode: 'direct' | 'kro' | 'alchemy' | 'auto';
  namespace?: string;
  timeout?: number;
  waitForReady?: boolean;
  dryRun?: boolean;
  rollbackOnFailure?: boolean;
  retryPolicy?: RetryPolicy;
  progressCallback?: (event: DeploymentEvent) => void;

  /** Hydrate Enhanced proxy status fields with live cluster data (default: true) */
  hydrateStatus?: boolean;
}

export interface AlchemyDeploymentOptions {
  namespace?: string;
  timeout?: number;
  waitForReady?: boolean;
  dryRun?: boolean;
  rollbackOnFailure?: boolean;
  retryPolicy?: RetryPolicy;
  progressCallback?: (event: DeploymentEvent) => void;

  /**
   * SECURITY WARNING: Only set to true in non-production environments.
   * This disables TLS certificate verification and makes connections vulnerable
   * to man-in-the-middle attacks.
   *
   * @default false (secure by default)
   */
  skipTLSVerify?: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMultiplier: number;
  initialDelay: number;
  maxDelay: number;
}

export interface DeploymentEvent {
  type:
    | 'started'
    | 'progress'
    | 'completed'
    | 'failed'
    | 'rollback'
    | 'status-hydrated'
    | 'resource-warning'
    | 'resource-status'
    | 'resource-ready';
  resourceId?: string;
  message: string;
  timestamp?: Date;
  error?: Error;
  details?: any;
}

export interface DeploymentError {
  resourceId: string;
  phase: 'validation' | 'deployment' | 'readiness' | 'rollback';
  error: Error;
  timestamp: Date;
}

export interface DeploymentResult {
  deploymentId: string;
  resources: DeployedResource[];
  dependencyGraph: DependencyGraph;
  duration: number;
  status: 'success' | 'partial' | 'failed';
  errors: DeploymentError[];
  alchemyMetadata?: AlchemyDeploymentMetadata;
}

export interface AlchemyDeploymentMetadata {
  scope: string;
  registeredTypes: string[]; // All unique resource types registered
  resourceIds: string[]; // All individual resource IDs
  totalResources: number; // Total number of individual resources
  resourceIdToType: Record<string, string>; // Mapping for debugging
}

export interface ResourceGraphResource {
  id: string;
  manifest: DeployableK8sResource<Enhanced<unknown, unknown>>;
}

export interface ResourceGraph {
  name: string;
  resources: ResourceGraphResource[];
  dependencyGraph: DependencyGraph;
}

// New typed ResourceGraph interface for the factory pattern
export interface TypedResourceGraph<
  TSpec extends KroCompatibleType = any,
  TStatus extends KroCompatibleType = any,
> {
  name: string;
  resources: KubernetesResource[];
  closures?: Record<string, DeploymentClosure>; // Deployment closures for direct mode

  // Factory creation with mode selection
  factory<TMode extends 'kro' | 'direct'>(
    mode: TMode,
    options?: FactoryOptions
  ): FactoryForMode<TMode, TSpec, TStatus>;

  // Utility methods
  toYaml(): string;
  schema?: SchemaProxy<TSpec, TStatus>; // Only for typed graphs from builder functions
}

// Factory options determine deployment strategy
export interface FactoryOptions {
  namespace?: string;
  timeout?: number;
  waitForReady?: boolean;
  retryPolicy?: RetryPolicy;
  progressCallback?: (event: DeploymentEvent) => void;

  // Status hydration - if false, Enhanced proxy status fields won't be populated with live data
  hydrateStatus?: boolean;

  // Alchemy integration - if provided, factory will use alchemy for deployment
  alchemyScope?: Scope;
  kubeConfig?: KubeConfig;

  // Deployment closures - for direct mode factories
  closures?: Record<string, DeploymentClosure>;

  /**
   * SECURITY WARNING: Only set to true in non-production environments.
   * This disables TLS certificate verification and makes connections vulnerable
   * to man-in-the-middle attacks.
   *
   * @default false (secure by default)
   */
  skipTLSVerify?: boolean;
}

// Type mapping for factory selection
export type FactoryForMode<
  TMode,
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> = TMode extends 'kro'
  ? KroResourceFactory<TSpec, TStatus>
  : TMode extends 'direct'
    ? DirectResourceFactory<TSpec, TStatus>
    : never;

// Unified factory interface - all modes implement this
export interface ResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> {
  // Core deployment - single method handles all cases
  deploy(spec: TSpec): Promise<Enhanced<TSpec, TStatus>>;

  // Instance management
  getInstances(): Promise<Enhanced<TSpec, TStatus>[]>;
  deleteInstance(name: string): Promise<void>;
  getStatus(): Promise<FactoryStatus>;

  // Metadata
  readonly mode: 'kro' | 'direct';
  readonly name: string;
  readonly namespace: string;
  readonly isAlchemyManaged: boolean;
}

// Mode-specific factories extend the base interface
export interface DirectResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends ResourceFactory<TSpec, TStatus> {
  mode: 'direct';

  // Direct-specific features
  rollback(): Promise<RollbackResult>;
  toDryRun(spec: TSpec): Promise<DeploymentResult>;
  toYaml(spec: TSpec): string; // Generate instance deployment YAML
}

export interface KroResourceFactory<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> extends ResourceFactory<TSpec, TStatus> {
  mode: 'kro';

  // Kro-specific features
  readonly rgdName: string;
  getRGDStatus(): Promise<RGDStatus>;
  toYaml(): string; // Generate RGD YAML (no args needed)
  toYaml(spec: TSpec): string; // Generate CRD instance YAML

  // Schema proxy for type-safe instance creation
  schema: SchemaProxy<TSpec, TStatus>;
}

export interface FactoryStatus {
  name: string;
  mode: 'kro' | 'direct';
  isAlchemyManaged: boolean;
  namespace: string;
  instanceCount: number;
  lastDeployment?: Date;
  health: 'healthy' | 'degraded' | 'failed';
}

export interface RGDStatus {
  name: string;
  phase: 'pending' | 'ready' | 'failed';
  conditions: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
  observedGeneration?: number;
}

export interface ReadinessConfig {
  timeout: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  errorRetryDelay: number;
  progressInterval: number;
}

export interface RollbackResult {
  deploymentId: string;
  rolledBackResources: string[];
  duration: number;
  status: 'success' | 'partial' | 'failed';
  errors: DeploymentError[];
}

export interface DeploymentOperationStatus {
  deploymentId: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  startTime: Date;
  endTime?: Date;
  duration?: number;
  resources: DeployedResource[];
}

export interface DeploymentStateRecord {
  deploymentId: string;
  resources: DeployedResource[];
  dependencyGraph: DependencyGraph;
  startTime: Date;
  endTime?: Date;
  status: 'running' | 'completed' | 'failed';
  options: DeploymentOptions;
}

// =============================================================================
// DEPLOYMENT ERROR CLASSES
// =============================================================================

export class ResourceDeploymentError extends Error {
  constructor(resourceName: string, resourceKind: string, cause: Error) {
    super(`Failed to deploy ${resourceKind}/${resourceName}: ${cause.message}`);
    this.name = 'ResourceDeploymentError';
    this.cause = cause;
  }
}

export class ResourceReadinessTimeoutError extends Error {
  constructor(resource: DeployedResource, timeout: number) {
    super(`Timeout after ${timeout}ms waiting for ${resource.kind}/${resource.name} to be ready`);
    this.name = 'ResourceReadinessTimeoutError';
  }
}

// =============================================================================
// REFERENCE RESOLUTION CONTEXT
// =============================================================================

/**
 * Context for resolving references in resources
 * Moved here from references.ts to avoid circular dependency
 */
export interface ResolutionContext {
  deployedResources: DeployedResource[];
  kubeClient: KubeConfig;
  namespace?: string;
  timeout?: number;
  cache?: Map<string, unknown>;
  deploymentId?: string;
  resourceKeyMapping?: Map<string, unknown>;
}
