/**
 * Hyperspike Valkey Operator Type Definitions
 *
 * ArkType schemas are the SINGLE source of truth for validated config types.
 * TypeScript types are INFERRED from schemas using `typeof Schema.infer`.
 * Status interfaces remain hand-written since they represent k8s API responses,
 * not user-provided config that needs validation.
 *
 * @see https://github.com/hyperspike/valkey-operator
 * @see https://doc.crds.dev/github.com/hyperspike/valkey-operator
 */

import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';

// ============================================================================
// Shared Schema Shapes
// ============================================================================

/** Shared ArkType schema shape for Kubernetes tolerations. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number',
} as const;

/** Shared ArkType schema shape for pod resource requirements. */
const resourceRequirementsSchemaShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

// ============================================================================
// Bootstrap Config (Helm Operator Install)
// ============================================================================

/**
 * ArkType schema for the Valkey operator bootstrap configuration.
 *
 * Used by the `valkeyBootstrap` composition to deploy the operator
 * controller into the cluster via Helm.
 */
export const ValkeyBootstrapConfigSchema = type({
  /** Release name for the Helm installation. */
  name: 'string',
  /** Namespace for the operator (default: 'valkey-operator-system'). */
  'namespace?': 'string',
  /** Chart version. */
  'version?': 'string',
  /** Raw Helm values merged last (preferred passthrough API). */
  'values?': 'Record<string, unknown>',
  /** @deprecated Use `values` instead. */
  'customValues?': 'Record<string, unknown>',
  /**
   * Whether the operator install should be treated as shared cluster
   * infrastructure (default: `true`). When `true`, the Namespace,
   * HelmRepository, and HelmRelease are tagged with
   * `scopes: ['cluster']` so `factory.deleteInstance()` will NOT
   * remove them — multiple consumers can converge on the same
   * operator install. Set to `false` for dedicated per-instance
   * operators.
   */
  'shared?': 'boolean',
});

/** Configuration for installing the Hyperspike Valkey operator via Helm. */
export type ValkeyBootstrapConfig = typeof ValkeyBootstrapConfigSchema.infer;

// ============================================================================
// Valkey CRD Resource
// ============================================================================

/**
 * ArkType schema for a Hyperspike Valkey cluster configuration.
 *
 * The `storage` field mirrors `*corev1.PersistentVolumeClaim` from the CRD Go types.
 * The `servicePassword` field mirrors `*corev1.SecretKeySelector` (name + key).
 * The `resources` field mirrors `*corev1.ResourceRequirements`.
 * The `shards` field maps to the CRD json tag `"nodes"` — the factory handles this mapping.
 *
 * @see https://doc.crds.dev/github.com/hyperspike/valkey-operator
 */
export const ValkeyConfigSchema = type({
  /** Cluster name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /** Valkey cluster specification. */
  spec: {
    // Core
    /** Valkey container image. */
    'image?': 'string',
    /** Metrics exporter image. */
    'exporterImage?': 'string',
    /** Number of primary nodes/shards (default: 3). */
    'shards?': 'number',
    /**
     * Requested replicas per shard (default: 0). Hyperspike v0.0.61 currently
     * creates additional primaries; see upstream issue #186.
     */
    'replicas?': 'number',
    /** Cluster domain (default: 'cluster.local'). */
    'clusterDomain?': 'string',

    // Authentication
    /** Allow connections without authentication (default: false). */
    'anonymousAuth?': 'boolean',
    /** Reference to an existing password secret (*corev1.SecretKeySelector). */
    'servicePassword?': { name: 'string', key: 'string', 'optional?': 'boolean' },

    // TLS
    /** Enable TLS encryption (default: false). */
    'tls?': 'boolean',
    /** Certificate issuer name (requires cert-manager). */
    'certIssuer?': 'string',
    /** Certificate issuer type: 'ClusterIssuer' or 'Issuer' (default: 'ClusterIssuer'). */
    'certIssuerType?': '"ClusterIssuer" | "Issuer"',

    // Storage & Resources
    /** Persistent storage configuration (*corev1.PersistentVolumeClaim). */
    'storage?': {
      'spec?': {
        /** PVC access modes (default: ['ReadWriteOnce']). */
        'accessModes?': 'string[]',
        /** Storage class name. */
        'storageClassName?': 'string',
        /** Storage resource requests. */
        'resources?': {
          'requests?': { 'storage?': 'string' },
        },
      },
    },
    /** Run init container to fix volume permissions (default: false). */
    'volumePermissions?': 'boolean',
    /** Pod resource requirements (*corev1.ResourceRequirements). */
    'resources?': resourceRequirementsSchemaShape,
    // Networking
    /** Preferred endpoint type for cluster communication. */
    'clusterPreferredEndpointType?': '"ip" | "hostname" | "unknown-endpoint"',

    // External Access
    /** External access configuration. */
    'externalAccess?': {
      /** Enable external access (default: false). */
      'enabled?': 'boolean',
      /** Access type: 'Proxy' (Envoy) or 'LoadBalancer' (default: 'Proxy'). */
      'type?': '"LoadBalancer" | "Proxy"',
      /** Enable external DNS support. */
      'externalDNS?': 'boolean',
      /** TLS certificate issuer name. */
      'certIssuer?': 'string',
      /** Certificate issuer type (default: 'ClusterIssuer'). */
      'certIssuerType?': 'string',
      /** Envoy proxy settings (when type is 'Proxy'). */
      'proxy?': {
        /** Envoy proxy image (default: 'envoyproxy/envoy:v1.32.1'). */
        'image?': 'string',
        /** Number of proxy replicas (default: 1). */
        'replicas?': 'number',
        /** External proxy hostname. */
        'hostname?': 'string',
        /** Proxy pod resources. */
        'resources?': resourceRequirementsSchemaShape,
        /** Additional Envoy configuration. */
        'extraConfig?': 'string',
        /** Service annotations. */
        'annotations?': 'Record<string, string>',
      },
      /** LoadBalancer settings (when type is 'LoadBalancer'). */
      'loadBalancer?': {
        /** Service annotations. */
        'annotations?': 'Record<string, string>',
      },
    },

    // Monitoring
    /** Enable Prometheus metrics endpoint (default: false). */
    'prometheus?': 'boolean',
    /** Labels for Prometheus metric matching. */
    'prometheusLabels?': 'Record<string, string>',
    /** Create Prometheus ServiceMonitor resource (default: false). */
    'serviceMonitor?': 'boolean',

    // Scheduling
    /** Node label selectors for pod placement. */
    'nodeSelector?': 'Record<string, string>',
    /** Taint tolerations. */
    'tolerations?': type(tolerationSchemaShape).array(),
  },
});

/** Configuration for a Hyperspike Valkey cluster. */
export type ValkeyConfig = typeof ValkeyConfigSchema.infer;

// ============================================================================
// Status Types (interfaces — not schema-validated)
// ============================================================================

/** Status condition for a Valkey cluster. */
export interface ValkeyCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  lastTransitionTime: string;
  observedGeneration?: number;
}

/**
 * Observed status of a Valkey cluster.
 */
export interface ValkeyStatus {
  /** Whether the cluster is operational. */
  ready?: boolean;
  /** Status conditions. */
  conditions?: ValkeyCondition[];
}

/**
 * Observed status of a Valkey operator deployment.
 */
export interface ValkeyBootstrapStatus {
  /**
   * Overall deployment phase (derived from HelmRelease Ready condition).
   * Note: cannot distinguish Failed from Installing due to CEL limitation (#48).
   * Use the `failed` field for failure detection.
   */
  phase: 'Ready' | 'Installing';
  /** Whether the operator is ready to manage Valkey clusters. */
  ready: boolean;
  /** Whether the HelmRelease Ready condition is explicitly False. */
  failed: boolean;
  /** Deployment-time version (the built-in default is normalized to the app version). */
  version?: string;
}

/** ArkType schema for ValkeyBootstrapStatus. */
export const ValkeyBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  failed: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Shared HelmRepository Singleton
// ============================================================================

/** Spec accepted by the shared Valkey HelmRepository singleton. */
export const ValkeyHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

/** Status surfaced by the shared Valkey HelmRepository singleton. */
export const ValkeyHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

// ============================================================================
// Helm Integration
// ============================================================================

/** ArkType schema for the Valkey operator Helm chart repository configuration. */
export const ValkeyHelmRepositoryConfigSchema = type({
  /** Repository name (default: 'valkey-operator-repo'). */
  'name?': 'string',
  /** Namespace for the HelmRepository (default: flux-system). */
  'namespace?': 'string',
  /** OCI registry URL (default: 'oci://ghcr.io/hyperspike'). */
  'url?': 'string',
  /** Sync interval (default: '5m'). */
  'interval?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the Valkey operator Helm chart repository. */
export type ValkeyHelmRepositoryConfig = typeof ValkeyHelmRepositoryConfigSchema.infer;

/** ArkType schema for the Valkey operator Helm release configuration. */
export const ValkeyHelmReleaseConfigSchema = type({
  /** Release name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Chart version. */
  'version?': 'string',
  /** Helm values. */
  'values?': 'Record<string, unknown>',
  /** HelmRepository name to reference (default: 'valkey-operator-repo'). */
  'repositoryName?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the Valkey operator Helm release. */
export type ValkeyHelmReleaseConfig = Omit<typeof ValkeyHelmReleaseConfigSchema.infer, 'values'> & {
  /** Graph-aware Helm values serialized recursively by TypeKro. */
  values?: TypeKroChartValue<Record<string, unknown>>;
};
