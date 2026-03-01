/**
 * Kubernetes-specific types and resource definitions
 */

import type {
  KubernetesObject,
  RbacV1Subject,
  V1CertificateSigningRequest,
  V1ConfigMap,
  V1CronJob,
  V1CSIDriver,
  V1CSINode,
  V1CustomResourceDefinition,
  V1DaemonSet,
  V1Deployment,
  V1Endpoint,
  V1EndpointSubset,
  V1HorizontalPodAutoscaler,
  V1Ingress,
  V1IngressClass,
  V1Job,
  V1Lease,
  V1LimitRange,
  V1MutatingWebhookConfiguration,
  V1Namespace,
  V1NetworkPolicy,
  V1Node,
  V1ObjectMeta,
  V1PersistentVolume,
  V1PersistentVolumeClaim,
  V1Pod,
  V1PodDisruptionBudget,
  V1PolicyRule,
  V1ReplicaSet,
  V1ReplicationController,
  V1ResourceQuota,
  V1RoleRef,
  V1RuntimeClass,
  V1Secret,
  V1Service,
  V1StatefulSet,
  V1ValidatingWebhookConfiguration,
  V1VolumeAttachment,
  V2HorizontalPodAutoscaler,
} from '@kubernetes/client-node';
import type { CelExpression, KubernetesRef } from './common.js';
import type { MagicProxy } from './references.js';

export interface KubernetesResource<TSpec = unknown, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta;
  spec?: TSpec;
  status?: TStatus;
  /**
   * Resource graph identifier used for dependency tracking and Kro resource references.
   *
   * In Kro mode, this becomes the resource entry `id` in the ResourceGraphDefinition YAML,
   * and is used in CEL expressions to reference this resource (e.g., `myDeployment.status.readyReplicas`).
   * Must be camelCase (Kro requirement). When omitted, auto-generated from `kind` + `metadata.name`
   * via {@link generateDeterministicResourceId}.
   *
   * **Not the same as `metadata.name`** — this is an internal graph identifier, not a Kubernetes name.
   * It is stripped from all Kubernetes API payloads before submission.
   *
   * Required when `metadata.name` is dynamic (e.g., `schema.spec.name`), because a static
   * camelCase identifier cannot be derived from a runtime value.
   *
   * @example
   * ```ts
   * // Auto-generated: kind=Deployment, name="my-app" → id="deploymentMyApp"
   * Deployment({ name: 'my-app', image: 'nginx' })
   *
   * // Explicit (required for dynamic names):
   * Deployment({ name: schema.spec.name, image: 'nginx', id: 'webDeployment' })
   * ```
   */
  id?: string;
  // Secret/ConfigMap data fields
  data?: { [key: string]: string };
  stringData?: { [key: string]: string };
  // RBAC resource fields (from @kubernetes/client-node)
  rules?: V1PolicyRule[];
  roleRef?: V1RoleRef;
  subjects?: RbacV1Subject[];
  // Storage resource fields
  provisioner?: string;
  parameters?: { [key: string]: string };
  // Networking resource fields
  subsets?: V1EndpointSubset[];
  addressType?: string;
  endpoints?: V1Endpoint[];
  // Priority resource fields
  value?: number;
  globalDefault?: boolean;
  description?: string;
  // External reference marker for serialization
  __externalRef?: boolean;
  // Custom toJSON method for serialization
  toJSON?: () => KubernetesResource<TSpec, TStatus>;
}

/**
 * Internal type augmentation for objects that carry a non-enumerable `__resourceId`
 * property. This property is set by the proxy system via `Object.defineProperty`
 * and is used for cross-resource references and dependency tracking.
 *
 * Use the {@link hasResourceId} type guard to safely narrow to this type
 * instead of ad-hoc `as any` or `as unknown as { __resourceId?: string }` casts.
 *
 * @internal
 */
export interface WithResourceId {
  readonly __resourceId?: string;
}

/**
 * Type guard that checks whether an object carries the internal `__resourceId` property.
 *
 * Since `__resourceId` is non-enumerable (set via `Object.defineProperty`),
 * this guard uses a direct property check rather than `in` or `hasOwnProperty`.
 *
 * @internal
 */
export function hasResourceId(obj: unknown): obj is WithResourceId {
  return (
    typeof obj === 'object' && obj !== null && (obj as WithResourceId).__resourceId !== undefined
  );
}

export type KubernetesResourceHeader<T extends KubernetesResource> = Pick<
  T,
  'apiVersion' | 'kind'
> & {
  metadata: {
    name: string;
    namespace: string;
  };
};

/**
 * A Kubernetes resource with a required resource graph identifier.
 * Used in deployment pipelines where every resource must have an `id` for
 * dependency ordering and status tracking.
 *
 * @see {@link KubernetesResource.id} for full documentation of the `id` field semantics.
 */
export interface DeployableKubernetesResource<TSpec = unknown, TStatus = unknown>
  extends KubernetesResource<TSpec, TStatus> {
  id: string;
}

/**
 * Helper type to make all properties of T non-optional and non-undefined recursively
 * This provides a cleaner developer experience by removing undefined from Kubernetes types
 */
type NonOptional<T> = {
  [K in keyof T]-?: T[K] extends object
    ? T[K] extends Array<infer U>
      ? NonOptional<U>[]
      : NonOptional<NonNullable<T[K]>>
    : NonNullable<T[K]>;
};

// =============================================================================
// CONDITIONAL EXPRESSION CONDITION TYPES
// =============================================================================

/**
 * Condition type accepted by {@link Enhanced.withIncludeWhen}.
 *
 * - `KubernetesRef<boolean>` — magic proxy access like `spec.ingress.enabled`
 * - `CelExpression<boolean>` — explicit CEL via `Cel.expr<boolean>(...)`
 * - `string` — raw CEL expression string
 * - `boolean` — static include/exclude
 */
export type IncludeWhenCondition =
  | KubernetesRef<boolean>
  | KubernetesRef<string>
  | CelExpression<boolean>
  | string
  | boolean;

/**
 * Callback form for {@link Enhanced.withReadyWhen}: receives a `self` (or `each`
 * for collections) object and returns a boolean expression. The function body is
 * parsed via `toString()` and transpiled to CEL at serialization time.
 *
 * @example
 * ```typescript
 * deployment.withReadyWhen((self: { status: { readyReplicas: number } }) =>
 *   self.status.readyReplicas > 0
 * );
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- self shape is user-defined per resource
export type ReadyWhenCallback = (self: any) => boolean;

/**
 * Condition type accepted by {@link Enhanced.withReadyWhen}.
 *
 * - `ReadyWhenCallback` — arrow function parsed to CEL (dominant pattern)
 * - `CelExpression<boolean>` — explicit CEL via `Cel.expr<boolean>(...)`
 * - `KubernetesRef<boolean>` — magic proxy boolean reference
 * - `string` — raw CEL expression string
 * - `boolean` — static ready/not-ready
 */
export type ReadyWhenCondition =
  | ReadyWhenCallback
  | CelExpression<boolean>
  | KubernetesRef<boolean>
  | KubernetesRef<string>
  | string
  | boolean;

// =============================================================================
// ENHANCED RESOURCE TYPE
// =============================================================================

/**
 * The final, user-facing type. All key properties are now magic proxies,
 * providing a consistent and powerful developer experience.
 * This mirrors the actual Kubernetes resource structure with magic proxy support.
 *
 * Note: Both spec and status are required for better type safety and reference creation
 * The NonOptional wrapper removes undefined from all fields for cleaner type experience
 *
 * IMPORTANT: We use Omit to remove spec/status/metadata from KubernetesResource before
 * adding the MagicProxy versions. This prevents intersection type conflicts where the same
 * property is defined in both parts of the intersection (e.g., status?: TStatus vs
 * readonly status: MagicProxy<TStatus>), which causes TypeScript to create complex
 * intersection types like (string & KubernetesRef<string>) when accessing nested properties.
 */
export type Enhanced<TSpec, TStatus> = Omit<
  KubernetesResource<TSpec, TStatus>,
  'spec' | 'status' | 'metadata'
> & {
  readonly status: MagicProxy<NonOptional<TStatus>>; // Required for better type safety, no undefined
  readonly spec: MagicProxy<NonOptional<TSpec>>; // No undefined fields
  readonly metadata: MagicProxy<V1ObjectMeta>; // Keep metadata fields optional as they should be
  /** @see {@link KubernetesResource.id} for full documentation of the `id` field semantics. */
  readonly id?: string;
  // Common Kubernetes resource fields that appear at root level
  readonly data?: MagicProxy<{ [key: string]: string }>; // ConfigMap, Secret
  readonly stringData?: MagicProxy<{ [key: string]: string }>; // Secret (write-only)
  readonly rules?: MagicProxy<V1PolicyRule[]>; // Role, ClusterRole
  readonly roleRef?: MagicProxy<V1RoleRef>; // RoleBinding, ClusterRoleBinding
  readonly subjects?: MagicProxy<RbacV1Subject[]>; // RoleBinding, ClusterRoleBinding
  readonly provisioner?: MagicProxy<string>; // StorageClass
  readonly parameters?: MagicProxy<{ [key: string]: string }>; // StorageClass
  readonly subsets?: MagicProxy<V1EndpointSubset[]>; // Endpoints

  // Optional readiness evaluator that returns structured status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stored evaluator is called with runtime K8s objects
  readonly readinessEvaluator?: ReadinessEvaluator<any>;

  // Fluent builder method for setting readiness evaluator
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts evaluators typed for any K8s resource
  withReadinessEvaluator(evaluator: ReadinessEvaluator<any>): Enhanced<TSpec, TStatus>;

  // Kro v0.8.x conditional expression support (added at runtime by ConditionalExpressionIntegrator)
  /** Set includeWhen condition — CEL expression, magic proxy boolean ref, or static boolean */
  withIncludeWhen(condition: IncludeWhenCondition): Enhanced<TSpec, TStatus>;
  /** Set readyWhen condition — callback `(self) => bool`, CEL expression, ref, or static boolean */
  withReadyWhen(condition: ReadyWhenCondition): Enhanced<TSpec, TStatus>;
};

// =============================================================================
// READINESS EVALUATION TYPES

/**
 * Structured resource status for detailed readiness information
 */
export interface ResourceStatus {
  ready: boolean;
  reason?: string; // Machine-readable reason code
  message?: string; // Human-readable status message
  details?: Record<string, unknown>; // Additional debugging information
}

/**
 * Evaluates the readiness of a live Kubernetes resource.
 *
 * Use an explicit type parameter for typed K8s resources (e.g.,
 * `ReadinessEvaluator<V1Deployment>`). For CRD-based resources without
 * a typed client, pass `any` explicitly: `ReadinessEvaluator<any>`.
 *
 * @typeParam T - The live resource type. Defaults to `unknown` to encourage
 *   explicit typing; use `any` for untyped CRD resources.
 */
export type ReadinessEvaluator<T = unknown> = (liveResource: T) => ResourceStatus;

// =============================================================================
// KRO-SPECIFIC TYPES

/**
 * Kro-managed status fields that are added to custom resources
 */
export interface KroStatusFields {
  state?: 'ACTIVE' | 'PROGRESSING' | 'FAILED' | 'TERMINATING';
  conditions?: Array<{
    type: string;
    status: 'True' | 'False' | 'Unknown';
    lastTransitionTime?: string;
    reason?: string;
    message?: string;
  }>;
  observedGeneration?: number;
}

/**
 * Type modifier that adds Kro-managed status fields to user-defined status types
 */
export type WithKroStatusFields<TStatus> = TStatus & KroStatusFields;

// =============================================================================
// CRD AND CUSTOM RESOURCE MANIFEST TYPES
// =============================================================================

/**
 * Typed interface for CustomResourceDefinition manifests.
 *
 * Replaces `as any` casts when working with CRD objects that come from
 * YAML parsing, API responses, or manual construction. This provides
 * type-safe access to deeply nested CRD schema fields (e.g.,
 * `spec.versions[0].schema.openAPIV3Schema`).
 *
 * For CRDs returned by the `@kubernetes/client-node` API, prefer
 * `V1CustomResourceDefinition` from the client library. Use this interface
 * for CRD manifests parsed from YAML or constructed as plain objects.
 */
export interface CRDManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  spec: {
    group?: string;
    names?: {
      kind?: string;
      plural?: string;
      singular?: string;
      shortNames?: string[];
      [key: string]: unknown;
    };
    scope?: string;
    versions?: Array<{
      name: string;
      served?: boolean;
      storage?: boolean;
      schema?: {
        openAPIV3Schema?: Record<string, unknown>;
      };
      additionalPrinterColumns?: unknown[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  status?: Record<string, unknown>;
}

/**
 * Typed interface for Kro ResourceGraphDefinition (RGD) custom objects.
 *
 * Replaces `as any` casts when accessing RGD objects returned by the
 * CustomObjectsApi (which returns untyped `any`). Provides type-safe access
 * to the RGD schema structure used for status field validation.
 */
export interface RGDManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    [key: string]: unknown;
  };
  spec?: {
    schema?: {
      apiVersion?: string;
      kind?: string;
      spec?: Record<string, unknown>;
      status?: Record<string, unknown>;
      [key: string]: unknown;
    };
    resources?: Array<{
      id?: string;
      template?: unknown;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  status?: {
    state?: string;
    conditions?: Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    [key: string]: unknown;
  };
}

/**
 * A Kubernetes object with an optional status field.
 *
 * The base `KubernetesObject` from `@kubernetes/client-node` only defines
 * `apiVersion`, `kind`, and `metadata`. Many API responses include a `status`
 * field that is not reflected in the base type. This interface extends
 * `KubernetesObject` to provide type-safe access to `status` without
 * requiring `as any` casts.
 */
export interface KubernetesObjectWithStatus {
  apiVersion?: string;
  kind?: string;
  metadata?: V1ObjectMeta;
  spec?: unknown;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

// =============================================================================
// KUBERNETES RESOURCE STATUS TYPES FOR DEPLOYMENT ENGINE
// =============================================================================

/**
 * Standard Kubernetes condition structure used across many resource types
 */
export interface KubernetesCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown' | string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastUpdateTime?: string;
  observedGeneration?: number;
}

/**
 * Generic resource with conditions - used for resources that have status.conditions
 * Uses V1ObjectMeta for compatibility with Kubernetes client types
 */
export interface ResourceWithConditions {
  apiVersion?: string;
  kind?: string;
  metadata?: V1ObjectMeta;
  spec?: unknown;
  status?: {
    conditions?: KubernetesCondition[];
    phase?: string;
    [key: string]: unknown;
  };
}

/**
 * CRD (CustomResourceDefinition) structure for API discovery
 */
export interface CustomResourceDefinitionItem {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    [key: string]: unknown;
  };
  spec?: {
    group?: string;
    names?: {
      kind?: string;
      plural?: string;
      singular?: string;
      [key: string]: unknown;
    };
    versions?: Array<{
      name?: string;
      served?: boolean;
      storage?: boolean;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  status?: {
    conditions?: KubernetesCondition[];
    [key: string]: unknown;
  };
}

/**
 * CRD list response structure
 */
export interface CustomResourceDefinitionList {
  apiVersion?: string;
  kind?: string;
  items?: CustomResourceDefinitionItem[];
  metadata?: {
    continue?: string;
    resourceVersion?: string;
    [key: string]: unknown;
  };
}

/**
 * Pod structure for listing pods
 */
export interface PodItem {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  status?: {
    phase?: string;
    conditions?: KubernetesCondition[];
    [key: string]: unknown;
  };
}

/**
 * Pod list response structure
 */
export interface PodList {
  apiVersion?: string;
  kind?: string;
  items?: PodItem[];
  metadata?: {
    continue?: string;
    resourceVersion?: string;
    [key: string]: unknown;
  };
}

/**
 * Generic Kubernetes API error structure
 */
export interface KubernetesApiError {
  statusCode?: number;
  body?: {
    message?: string;
    reason?: string;
    code?: number;
    details?: {
      name?: string;
      kind?: string;
      causes?: Array<{
        reason?: string;
        message?: string;
        field?: string;
      }>;
    };
  };
  message?: string;
  response?: {
    statusCode?: number;
    body?: unknown;
    headers?: Record<string, string>;
  };
}

export interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

export interface ServiceStatus {
  loadBalancer?: {
    ingress?: Array<{
      ip?: string;
      hostname?: string;
    }>;
  };
}

export interface PodStatus {
  phase?: string;
  containerStatuses?: Array<{
    ready?: boolean;
    name: string;
    state?: any;
  }>;
  conditions?: Array<{
    type: string;
    status: string;
  }>;
}

export interface JobStatus {
  succeeded?: number;
  failed?: number;
  active?: number;
  conditions?: Array<{
    type: string;
    status: string;
  }>;
}

export interface StatefulSetStatus {
  replicas?: number;
  readyReplicas?: number;
  currentReplicas?: number;
  updatedReplicas?: number;
}

export interface DaemonSetStatus {
  desiredNumberScheduled?: number;
  numberReady?: number;
  numberAvailable?: number;
  numberUnavailable?: number;
}

export interface PVCStatus {
  phase?: string;
  accessModes?: string[];
  capacity?: {
    storage?: string;
  };
}

export interface IngressStatus {
  loadBalancer?: {
    ingress?: Array<{
      ip?: string;
      hostname?: string;
    }>;
  };
}

export interface HPAStatus {
  currentReplicas?: number;
  desiredReplicas?: number;
  currentCPUUtilizationPercentage?: number;
}

// Generic status interface for unknown resource types
export interface GenericResourceStatus {
  conditions?: Array<{
    type?: string;
    status?: string;
    reason?: string;
    message?: string;
  }>;
  phase?: string;
  [key: string]: unknown;
}

// Spec interfaces for resources that need them
export interface DeploymentSpec {
  replicas?: number;
  selector?: any;
  template?: any;
}

export interface ServiceSpec {
  type?: string;
  ports?: Array<{
    port: number;
    targetPort?: number | string;
    protocol?: string;
  }>;
  selector?: Record<string, string>;
}

export interface JobSpec {
  completions?: number;
  parallelism?: number;
  template?: any;
}

export interface StatefulSetSpec {
  replicas?: number;
  serviceName?: string;
}

/**
 * Type modifier that makes Enhanced types compatible with Kubernetes client operations
 * This strips the magic proxy layer and provides direct access to the underlying types
 * for use with the Kubernetes API client
 */
export type K8sCompatible<T extends Enhanced<any, any>> = T & {
  // Override magic proxy fields with direct access for K8s client compatibility
  readonly spec: T extends Enhanced<infer TSpec, any> ? TSpec : unknown;
  readonly status: T extends Enhanced<any, infer TStatus> ? TStatus : unknown;
  readonly metadata: V1ObjectMeta;
};

/**
 * Type modifier for resources that need to be deployable (with required ID)
 */
export type DeployableResource<T extends Enhanced<any, any>> = K8sCompatible<T> & {
  /** Required resource graph identifier. @see {@link KubernetesResource.id} */
  readonly id: string;
};

/**
 * Bridge type modifier that makes Enhanced types extend KubernetesObject
 * This creates a seamless bridge between our type system and the Kubernetes client
 */
export type K8sClientCompatible<T extends Enhanced<any, any>> = T &
  KubernetesObject & {
    // Ensure our Enhanced fields are properly typed while maintaining K8s client compatibility
    readonly spec: T extends Enhanced<infer TSpec, any> ? TSpec : unknown;
    readonly status: T extends Enhanced<any, infer TStatus> ? TStatus : unknown;
    readonly metadata: V1ObjectMeta;
    /** @see {@link KubernetesResource.id} */
    readonly id?: string;
  };

/**
 * Deployable version of K8sClientCompatible with required ID
 */
export type DeployableK8sResource<T extends Enhanced<any, any>> = K8sClientCompatible<T> & {
  /** Required resource graph identifier. @see {@link KubernetesResource.id} */
  readonly id: string;
};

/**
 * Union type for resources that can be used in deployment operations
 * This handles both our typed resources and raw Kubernetes API objects
 */
export type DeploymentResource = K8sClientCompatible<Enhanced<any, any>> | KubernetesObject;

/**
 * Type-safe resource accessor that works with both our types and k8s client types
 */
export interface ResourceAccessor {
  getStatus<T = unknown>(resource: DeploymentResource): T | undefined;
  getSpec<T = unknown>(resource: DeploymentResource): T | undefined;
  getKind(resource: DeploymentResource): string;
}

/**
 * Type-safe status extractor that returns properly typed status based on resource kind
 */
export type ExtractStatus<T extends DeploymentResource> = T extends { kind: 'Deployment' }
  ? DeploymentStatus
  : T extends { kind: 'Service' }
    ? ServiceStatus
    : T extends { kind: 'Pod' }
      ? PodStatus
      : T extends { kind: 'Job' }
        ? JobStatus
        : T extends { kind: 'StatefulSet' }
          ? StatefulSetStatus
          : T extends { kind: 'DaemonSet' }
            ? DaemonSetStatus
            : T extends { kind: 'PersistentVolumeClaim' }
              ? PVCStatus
              : T extends { kind: 'Ingress' }
                ? IngressStatus
                : T extends { kind: 'HorizontalPodAutoscaler' }
                  ? HPAStatus
                  : GenericResourceStatus;

/**
 * Type-safe spec extractor that returns properly typed spec based on resource kind
 */
export type ExtractSpec<T extends DeploymentResource> = T extends { kind: 'Deployment' }
  ? DeploymentSpec
  : T extends { kind: 'Service' }
    ? ServiceSpec
    : T extends { kind: 'Job' }
      ? JobSpec
      : T extends { kind: 'StatefulSet' }
        ? StatefulSetSpec
        : unknown;

// =============================================================================
// V1 TYPE DEFINITIONS FOR FACTORY FUNCTIONS
// =============================================================================

// Core workload resource types
export type V1DeploymentSpec = NonNullable<V1Deployment['spec']>;
export type V1DeploymentStatus = NonNullable<V1Deployment['status']>;
export type V1ServiceSpec = NonNullable<V1Service['spec']>;
export type V1ServiceStatus = NonNullable<V1Service['status']>;
export type V1JobSpec = NonNullable<V1Job['spec']>;
export type V1JobStatus = NonNullable<V1Job['status']>;
export type V1StatefulSetSpec = NonNullable<V1StatefulSet['spec']>;
export type V1StatefulSetStatus = NonNullable<V1StatefulSet['status']>;
export type V1CronJobSpec = NonNullable<V1CronJob['spec']>;
export type V1CronJobStatus = NonNullable<V1CronJob['status']>;
export type V1DaemonSetSpec = NonNullable<V1DaemonSet['spec']>;
export type V1DaemonSetStatus = NonNullable<V1DaemonSet['status']>;
export type V1ReplicaSetSpec = NonNullable<V1ReplicaSet['spec']>;
export type V1ReplicaSetStatus = NonNullable<V1ReplicaSet['status']>;
export type V1ReplicationControllerSpec = NonNullable<V1ReplicationController['spec']>;
export type V1ReplicationControllerStatus = NonNullable<V1ReplicationController['status']>;

// Core resource types
export type V1PodSpec = NonNullable<V1Pod['spec']>;
export type V1PodStatus = NonNullable<V1Pod['status']>;
export type V1NamespaceSpec = NonNullable<V1Namespace['spec']>;
export type V1NamespaceStatus = NonNullable<V1Namespace['status']>;
export type V1NodeSpec = NonNullable<V1Node['spec']>;
export type V1NodeStatus = NonNullable<V1Node['status']>;

// Config and Secret types
export type V1ConfigMapData = NonNullable<V1ConfigMap['data']>;
export type V1SecretData = NonNullable<V1Secret['data']>;

// Storage resource types
export type V1PvcSpec = NonNullable<V1PersistentVolumeClaim['spec']>;
export type V1PvcStatus = NonNullable<V1PersistentVolumeClaim['status']>;
export type V1PvSpec = NonNullable<V1PersistentVolume['spec']>;
export type V1PvStatus = NonNullable<V1PersistentVolume['status']>;
export type V1VolumeAttachmentSpec = NonNullable<V1VolumeAttachment['spec']>;
export type V1VolumeAttachmentStatus = NonNullable<V1VolumeAttachment['status']>;

// Policy resource types
export type V1PdbSpec = NonNullable<V1PodDisruptionBudget['spec']>;
export type V1PdbStatus = NonNullable<V1PodDisruptionBudget['status']>;
export type V1ResourceQuotaSpec = NonNullable<V1ResourceQuota['spec']>;
export type V1ResourceQuotaStatus = NonNullable<V1ResourceQuota['status']>;
export type V1LimitRangeSpec = NonNullable<V1LimitRange['spec']>;

// Networking resource types
export type V1IngressSpec = NonNullable<V1Ingress['spec']>;
export type V1IngressStatus = NonNullable<V1Ingress['status']>;
export type V1NetworkPolicySpec = NonNullable<V1NetworkPolicy['spec']>;

// Autoscaling resource types
export type V2HpaSpec = NonNullable<V2HorizontalPodAutoscaler['spec']>;
export type V2HpaStatus = NonNullable<V2HorizontalPodAutoscaler['status']>;
export type V1HpaSpec = NonNullable<V1HorizontalPodAutoscaler['spec']>;
export type V1HpaStatus = NonNullable<V1HorizontalPodAutoscaler['status']>;
export type V1CSIDriverSpec = NonNullable<V1CSIDriver['spec']>;
export type V1CSINodeSpec = NonNullable<V1CSINode['spec']>;
export type V1IngressClassSpec = NonNullable<V1IngressClass['spec']>;
export type V1CertificateSigningRequestSpec = NonNullable<V1CertificateSigningRequest['spec']>;
export type V1CertificateSigningRequestStatus = NonNullable<V1CertificateSigningRequest['status']>;
export type V1LeaseSpec = NonNullable<V1Lease['spec']>;
export type V1MutatingWebhookConfigurationWebhooks = NonNullable<
  V1MutatingWebhookConfiguration['webhooks']
>;
export type V1ValidatingWebhookConfigurationWebhooks = NonNullable<
  V1ValidatingWebhookConfiguration['webhooks']
>;
export type V1CustomResourceDefinitionSpec = NonNullable<V1CustomResourceDefinition['spec']>;
export type V1CustomResourceDefinitionStatus = NonNullable<V1CustomResourceDefinition['status']>;
export type V1RuntimeClassHandler = V1RuntimeClass;
