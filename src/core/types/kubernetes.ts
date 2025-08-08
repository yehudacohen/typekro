/**
 * Kubernetes-specific types and resource definitions
 */

import type {
  KubernetesObject,
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
  V1Subject,
  V1ValidatingWebhookConfiguration,
  V1VolumeAttachment,
  V2HorizontalPodAutoscaler,
} from '@kubernetes/client-node';
import type { MagicProxy } from './references.js';

export interface KubernetesResource<TSpec = unknown, TStatus = unknown> {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta;
  spec?: TSpec;
  status?: TStatus;
  // Resource ID for dependency tracking and deployment
  id?: string;
  // RBAC resource fields (from @kubernetes/client-node)
  rules?: V1PolicyRule[];
  roleRef?: V1RoleRef;
  subjects?: V1Subject[];
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
}

/**
 * A Kubernetes resource with required ID for deployment tracking
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

/**
 * The final, user-facing type. All key properties are now magic proxies,
 * providing a consistent and powerful developer experience.
 * This mirrors the actual Kubernetes resource structure with magic proxy support.
 *
 * Note: Both spec and status are required for better type safety and reference creation
 * The NonOptional wrapper removes undefined from all fields for cleaner type experience
 */
export type Enhanced<TSpec, TStatus> = KubernetesResource<TSpec, TStatus> & {
  readonly status: MagicProxy<NonOptional<TStatus>>; // Required for better type safety, no undefined
  readonly spec: MagicProxy<NonOptional<TSpec>>; // No undefined fields
  readonly metadata: MagicProxy<V1ObjectMeta>; // Keep metadata fields optional as they should be
  readonly id?: string; // Explicit resource ID for Kro serialization
  // Common Kubernetes resource fields that appear at root level
  readonly data?: MagicProxy<{ [key: string]: string }>; // ConfigMap, Secret
  readonly stringData?: MagicProxy<{ [key: string]: string }>; // Secret (write-only)
  readonly rules?: MagicProxy<V1PolicyRule[]>; // Role, ClusterRole
  readonly roleRef?: MagicProxy<V1RoleRef>; // RoleBinding, ClusterRoleBinding
  readonly subjects?: MagicProxy<V1Subject[]>; // RoleBinding, ClusterRoleBinding
  readonly provisioner?: MagicProxy<string>; // StorageClass
  readonly parameters?: MagicProxy<{ [key: string]: string }>; // StorageClass
  readonly subsets?: MagicProxy<V1EndpointSubset[]>; // Endpoints
  
  // Optional readiness evaluator that returns structured status
  readonly readinessEvaluator?: ReadinessEvaluator;
};

// =============================================================================
// READINESS EVALUATION TYPES

/**
 * Structured resource status for detailed readiness information
 */
export interface ResourceStatus {
  ready: boolean;
  reason?: string;        // Machine-readable reason code
  message?: string;       // Human-readable status message
  details?: Record<string, any>; // Additional debugging information
}

/**
 * Readiness evaluator function type
 */
export type ReadinessEvaluator<T = any> = (liveResource: T) => ResourceStatus;

/**
 * Fluent builder interface for Enhanced resources with readiness evaluation
 */
export interface EnhancedBuilder<TSpec, TStatus> extends Enhanced<TSpec, TStatus> {
  withReadinessEvaluator(evaluator: ReadinessEvaluator): Enhanced<TSpec, TStatus>;
}

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
// KUBERNETES RESOURCE STATUS TYPES FOR DEPLOYMENT ENGINE
// =============================================================================

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
  [key: string]: any;
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
  readonly id: string; // Make id required for deployment
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
    readonly id?: string; // Optional ID for deployment tracking
  };

/**
 * Deployable version of K8sClientCompatible with required ID
 */
export type DeployableK8sResource<T extends Enhanced<any, any>> = K8sClientCompatible<T> & {
  readonly id: string; // Required ID for deployment operations
};

/**
 * Union type for resources that can be used in deployment operations
 * This handles both our typed resources and raw Kubernetes API objects
 */
export type DeploymentResource =
  | K8sClientCompatible<Enhanced<any, any>>
  | KubernetesObject;

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
