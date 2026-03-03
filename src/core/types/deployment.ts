/**
 * Deployment-related types
 */

import type { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import { CALLABLE_COMPOSITION_BRAND, NESTED_COMPOSITION_BRAND } from '../constants/brands.js';
import type { DependencyGraph } from '../dependencies/index.js';
import type { HttpTimeoutConfig } from '../kubernetes/index.js';
import type { KubernetesRef } from './common.js';
import type { DeployableK8sResource, Enhanced, KubernetesResource } from './kubernetes.js';
import type { InferType, KroCompatibleType, SchemaProxy, Scope } from './schema.js';

/**
 * Represents a deployed Kubernetes resource with metadata about its deployment status.
 */
export interface DeployedResource {
  /**
   * Resource graph identifier (camelCase). This is the internal tracking ID,
   * not the Kubernetes `metadata.name`. Resolved via {@link getResourceId}.
   */
  id: string;
  kind: string;
  /** The Kubernetes `metadata.name` of the deployed resource. */
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
  kubeConfig?: KubeConfig; // For operations that need direct API access (e.g., CRD patching)
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

/**
 * Strategy for handling resource conflicts (409 AlreadyExists errors)
 * - 'warn': Log warning and treat existing resource as success (default)
 * - 'fail': Throw ResourceConflictError on conflict
 * - 'patch': Attempt to patch the existing resource with new values
 * - 'replace': Delete and recreate the resource
 */
export type ConflictStrategy = 'warn' | 'fail' | 'patch' | 'replace';

// =============================================================================
// SHARED CONFIG SUB-TYPES
// =============================================================================

/** Event monitoring configuration for Kubernetes deployments */
export interface EventMonitoringConfig {
  /** Enable event monitoring (default: false) */
  enabled?: boolean;
  /** Event types to monitor (default: ['Warning', 'Error']) */
  eventTypes?: ('Normal' | 'Warning' | 'Error')[];
  /** Include child resources in monitoring (default: true) */
  includeChildResources?: boolean;
  /** Deduplication window in seconds (default: 60) */
  deduplicationWindow?: number;
  /** Maximum events per resource per minute (default: 100) */
  maxEventsPerSecond?: number;
}

/** Debug logging configuration for deployment diagnostics */
export interface DebugLoggingConfig {
  /** Enable debug logging (default: false) */
  enabled?: boolean;
  /** Enable status polling debug logs (default: true when enabled) */
  statusPolling?: boolean;
  /** Enable readiness evaluation debug logs (default: true when enabled) */
  readinessEvaluation?: boolean;
  /** Maximum status object size to log in bytes (default: 1024) */
  maxStatusObjectSize?: number;
  /** Enable verbose mode with additional diagnostic information (default: false) */
  verboseMode?: boolean;
}

/** Automatic environment fixes configuration */
export interface AutoFixConfig {
  /** Automatically patch Flux CRDs for Kubernetes 1.33+ compatibility (default: true) */
  fluxCRDs?: boolean;
  /** Log level for auto-fix operations (default: 'info') */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

// =============================================================================
// BASE DEPLOYMENT CONFIG
// =============================================================================

/**
 * Common deployment configuration shared by DeploymentOptions,
 * FactoryOptions, and AlchemyDeploymentOptions.
 */
export interface BaseDeploymentConfig {
  /** Kubernetes namespace for deployment */
  namespace?: string;
  /** Timeout in milliseconds for readiness waits */
  timeout?: number;
  /** Wait for resources to become ready after deployment */
  waitForReady?: boolean;
  /** Retry policy for transient failures */
  retryPolicy?: RetryPolicy;
  /** Callback for deployment progress events */
  progressCallback?: (event: DeploymentEvent) => void;
}

// =============================================================================
// DEPLOYMENT OPTIONS
// =============================================================================

export interface DeploymentOptions extends BaseDeploymentConfig {
  mode: 'direct' | 'kro' | 'alchemy' | 'auto';
  dryRun?: boolean;
  rollbackOnFailure?: boolean;

  /**
   * Abort readiness waits for all resources when any resource in the same level fails
   * This significantly speeds up deployments when failures occur
   * @default true
   */
  abortOnFailure?: boolean;

  /**
   * Hydrate Enhanced proxy status fields with live cluster data
   * IMPORTANT: Requires waitForReady: true to ensure resources have status
   * When false, status will be null and only spec will be accessible
   * @default true
   */
  hydrateStatus?: boolean;

  /**
   * Strategy for handling resource conflicts (409 AlreadyExists errors)
   * - 'warn': Log warning and treat existing resource as success (default)
   * - 'fail': Throw ResourceConflictError on conflict
   * - 'patch': Attempt to patch the existing resource with new values
   * - 'replace': Delete and recreate the resource
   * @default 'warn'
   */
  conflictStrategy?: ConflictStrategy;

  /** Event monitoring configuration */
  eventMonitoring?: EventMonitoringConfig;

  /** Debug logging configuration */
  debugLogging?: DebugLoggingConfig;

  /** Automatic environment fixes configuration */
  autoFix?: AutoFixConfig;

  /** Output configuration */
  outputOptions?: {
    /** Enable console logging (default: true) */
    consoleLogging?: boolean;
    /** Log level for console output (default: 'info') */
    logLevel?: 'error' | 'warn' | 'info' | 'debug';
    /** Event types to deliver via progress callbacks (default: all) */
    progressCallbackEvents?: ('kubernetes-event' | 'status-debug' | 'child-resource-discovered')[];
  };

  /**
   * HTTP request timeout configuration for Kubernetes API operations
   * Configures timeouts for different operation types (watch, GET, POST, PATCH, DELETE)
   *
   * These timeouts apply when running in Bun runtime to prevent requests from hanging
   * indefinitely. The defaults are:
   * - watch: 5 seconds (allows clean reconnection)
   * - default (GET/LIST): 30 seconds
   * - create (POST): 60 seconds (may trigger webhooks)
   * - update (PATCH/PUT): 60 seconds (may trigger webhooks)
   * - delete (DELETE): 90 seconds (may wait for finalizers)
   *
   * @default Uses built-in defaults for each operation type
   */
  httpTimeouts?: HttpTimeoutConfig;
}

export interface AlchemyDeploymentOptions extends BaseDeploymentConfig {
  dryRun?: boolean;
  rollbackOnFailure?: boolean;

  /**
   * SECURITY WARNING: Only set to true in non-production environments.
   * This disables TLS certificate verification and makes connections vulnerable
   * to man-in-the-middle attacks.
   *
   * @default false (secure by default)
   */
  skipTLSVerify?: boolean;
}

/**
 * Configuration for exponential-backoff retry behaviour during resource deployment.
 *
 * The engine waits `initialDelay * backoffMultiplier^attempt` milliseconds between
 * retries, capped at `maxDelay`.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts before giving up */
  maxRetries: number;
  /** Multiplier applied to the delay after each failed attempt */
  backoffMultiplier: number;
  /** Delay (ms) before the first retry */
  initialDelay: number;
  /** Upper bound (ms) on the computed backoff delay */
  maxDelay: number;
}

/**
 * Event emitted during a deployment lifecycle.
 *
 * Subscribe via `DeploymentOptions.onProgress` to receive real-time
 * updates about each resource's progress through the deployment pipeline.
 */
export interface DeploymentEvent {
  /** Discriminator indicating the stage/nature of the event */
  type:
    | 'started'
    | 'progress'
    | 'completed'
    | 'failed'
    | 'rollback'
    | 'status-hydrated'
    | 'resource-warning'
    | 'resource-status'
    | 'resource-ready'
    | 'kubernetes-event'
    | 'status-debug'
    | 'child-resource-discovered';
  /** Identifier of the resource this event relates to (if applicable) */
  resourceId?: string;
  /** Human-readable description of the event */
  message: string;
  /** When the event occurred (defaults to now) */
  timestamp?: Date;
  /** Error object when `type` is `'failed'` */
  error?: Error;
  /** Arbitrary payload with event-specific context */
  details?: unknown;
}

/**
 * Kubernetes event data delivered via progress callbacks
 */
export interface KubernetesEventData extends DeploymentEvent {
  type: 'kubernetes-event';
  eventType: 'Normal' | 'Warning' | 'Error';
  reason: string;
  source: {
    component: string;
    host?: string;
  };
  involvedObject: {
    kind: string;
    name: string;
    namespace?: string;
    uid?: string;
  };
  count?: number;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
  eventMessage: string;
}

/**
 * Status debug information delivered via progress callbacks
 */
export interface StatusDebugEvent extends DeploymentEvent {
  type: 'status-debug';
  resourceId: string;
  currentStatus: Record<string, unknown>;
  readinessResult: boolean | { ready: boolean; reason?: string };
  context: {
    attempt: number;
    elapsedTime: number;
    isTimeout: boolean;
  };
}

/**
 * Child resource discovery event
 */
export interface ChildResourceDiscoveredEvent extends DeploymentEvent {
  type: 'child-resource-discovered';
  parentResource: string;
  childResource: {
    kind: string;
    name: string;
    namespace?: string;
  };
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

/**
 * Internal deployment-specific resource graph used by the deployment engine.
 *
 * Not to be confused with `ResourceGraph<TSpec, TStatus>` in `resource-graph.ts`,
 * which is the generic, user-facing interface returned by `toResourceGraph()`.
 */
export interface DeploymentResourceGraph {
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

/**
 * Status proxy for nested compositions - returns KubernetesRef objects
 * that reference the nested composition's computed status fields.
 *
 * Supports nested property access at the type level to match runtime Proxy behavior.
 * Uses MagicProxy to enable property access on KubernetesRef-wrapped objects.
 *
 * Example: status.components.kroSystem is valid when components is an object.
 * Example: status.ingressClass?.name properly resolves to string type, not any.
 */
export type StatusProxy<TStatus> = TStatus;

/**
 * Resource returned when a composition is called as a function with a spec.
 * Contains the spec, a status proxy, and metadata about the nested composition instance.
 */
export interface NestedCompositionResource<TSpec, TStatus> {
  readonly [NESTED_COMPOSITION_BRAND]: true;
  readonly spec: TSpec;
  readonly status: StatusProxy<TStatus>;
  readonly __compositionId: string;
  readonly __resources: KubernetesResource[];
}

/**
 * A composition that can be both:
 * 1. Called as a function with a spec to create nested composition instances
 * 2. Used as a TypedResourceGraph for deployment
 * 3. Has a .status property for cross-composition status references
 */
export type CallableComposition<
  TSpec extends KroCompatibleType,
  TStatus extends KroCompatibleType,
> = {
  readonly [CALLABLE_COMPOSITION_BRAND]: true;
  (spec: TSpec): NestedCompositionResource<TSpec, TStatus>;

  // Status proxy for cross-composition references
  // Enables: composition.status.field in status builders
  readonly status: InferType<TStatus>;
} & TypedResourceGraph<TSpec, TStatus>;

/**
 * Options passed to `deploy()` on a `TypedResourceGraph`.
 *
 * Extends {@link BaseDeploymentConfig} with factory-specific settings for
 * status hydration, Alchemy scope binding, deployment closures, and
 * Kubernetes API configuration.
 */
export interface FactoryOptions extends BaseDeploymentConfig {
  /** When false, Enhanced proxy status fields won't be populated with live cluster data */
  hydrateStatus?: boolean;

  /** Alchemy scope — when provided the factory will deploy via Alchemy */
  alchemyScope?: Scope;
  /** Explicit KubeConfig override for cluster connection */
  kubeConfig?: KubeConfig;

  /** Deployment closures for direct-mode factories */
  closures?: Record<string, DeploymentClosure>;

  // biome-ignore lint/suspicious/noExplicitAny: internal composition re-execution accepts arbitrary schemas
  /** Re-execution function for the composition (internal use) */
  compositionFn?: (spec: any) => any;
  // biome-ignore lint/suspicious/noExplicitAny: holds the original definition shape which varies by composition
  /** Original composition definition (internal use) */
  compositionDefinition?: any;
  // biome-ignore lint/suspicious/noExplicitAny: holds the original options shape which varies by composition
  /** Original composition options (internal use) */
  compositionOptions?: any;

  /**
   * SECURITY WARNING: Only set to true in non-production environments.
   * This disables TLS certificate verification and makes connections vulnerable
   * to man-in-the-middle attacks.
   *
   * @default false (secure by default)
   */
  skipTLSVerify?: boolean;

  /** Event monitoring configuration */
  eventMonitoring?: EventMonitoringConfig;

  /** Debug logging configuration */
  debugLogging?: DebugLoggingConfig;

  /** Automatic environment fixes configuration */
  autoFix?: AutoFixConfig;

  // Factory pattern integration for expression handling
  /** Factory type for expression analysis and conversion */
  factoryType?: 'direct' | 'kro';
  /** Pre-analyzed status mappings for factory-specific handling */
  statusMappings?: Record<string, unknown>;

  /**
   * HTTP request timeout configuration for Kubernetes API operations
   * Configures timeouts for different operation types (watch, GET, POST, PATCH, DELETE)
   *
   * These timeouts apply when running in Bun runtime to prevent requests from hanging
   * indefinitely. The defaults are:
   * - watch: 5 seconds (allows clean reconnection)
   * - default (GET/LIST): 30 seconds
   * - create (POST): 60 seconds (may trigger webhooks)
   * - update (PATCH/PUT): 60 seconds (may trigger webhooks)
   * - delete (DELETE): 90 seconds (may wait for finalizers)
   *
   * @default Uses built-in defaults for each operation type
   */
  httpTimeouts?: HttpTimeoutConfig;
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
// Error classes are exported from '../deployment/errors.js' directly.
// They were previously re-exported here, but that created a circular dependency:
// deployment.ts → deployment/errors.ts → deployment.ts
// Import errors from '../deployment/errors.js' or '../deployment/index.js' instead.

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
  schema?: { spec?: unknown; status?: unknown };
}
