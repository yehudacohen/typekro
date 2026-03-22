/**
 * Hyperspike Valkey Operator Type Definitions
 *
 * TypeScript interfaces and ArkType schemas for the Valkey CRD.
 * Covers the hyperspike.io/v1 API group.
 *
 * @see https://github.com/hyperspike/valkey-operator
 * @see https://doc.crds.dev/github.com/hyperspike/valkey-operator
 */

import { type Type, type } from 'arktype';

// ============================================================================
// Common Kubernetes Types
// ============================================================================

/** Pod resource requests and limits. */
export interface ResourceRequirements {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

/** Kubernetes toleration for pod scheduling. */
export interface Toleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** Reference to a key in a Kubernetes Secret. */
export interface SecretKeySelector {
  name: string;
  key: string;
}

// ============================================================================
// Bootstrap Config (Helm Operator Install)
// ============================================================================

/**
 * Configuration for installing the Hyperspike Valkey operator via Helm.
 *
 * Used by the `valkeyBootstrap` composition to deploy the operator
 * controller into the cluster.
 */
export interface ValkeyBootstrapConfig {
  /** Release name for the Helm installation. */
  name: string;
  /** Namespace for the operator (default: 'valkey-operator-system'). */
  namespace?: string;
  /** Chart version. */
  version?: string;
  /** Additional Helm values for user overrides. */
  customValues?: Record<string, unknown>;
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
  /** Deployed operator version (app version, not chart version). */
  version?: string;
}

/** ArkType schema for ValkeyBootstrapConfig. */
export const ValkeyBootstrapConfigSchema: Type<ValkeyBootstrapConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'customValues?': 'Record<string, unknown>',
});

/** ArkType schema for ValkeyBootstrapStatus. */
export const ValkeyBootstrapStatusSchema: Type<ValkeyBootstrapStatus> = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  failed: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Valkey Resource
// ============================================================================

/** Persistent storage configuration for Valkey nodes. */
export interface ValkeyStorageConfig {
  /** PVC access modes (default: ['ReadWriteOnce']). */
  accessModes?: string[];
  /** Storage class name. */
  storageClassName?: string;
  /** Storage request. */
  resources?: {
    requests?: { storage?: string };
  };
}

/** Envoy proxy settings for external access. */
export interface ProxySettings {
  /** Envoy proxy image (default: 'envoyproxy/envoy:v1.32.1'). */
  image?: string;
  /** Number of proxy replicas (default: 1). */
  replicas?: number;
  /** External proxy hostname. */
  hostname?: string;
  /** Proxy pod resources. */
  resources?: ResourceRequirements;
  /** Additional Envoy configuration. */
  extraConfig?: string;
  /** Service annotations. */
  annotations?: Record<string, string>;
}

/** LoadBalancer service settings for external access. */
export interface LoadBalancerSettings {
  /** Service annotations. */
  annotations?: Record<string, string>;
}

/** External access configuration for exposing Valkey outside the cluster. */
export interface ExternalAccessConfig {
  /** Enable external access (default: false). */
  enabled?: boolean;
  /** Access type: 'Proxy' (Envoy) or 'LoadBalancer' (default: 'Proxy'). */
  type?: 'LoadBalancer' | 'Proxy';
  /** Enable external DNS support. */
  externalDNS?: boolean;
  /** TLS certificate issuer name. */
  certIssuer?: string;
  /** Certificate issuer type (default: 'ClusterIssuer'). */
  certIssuerType?: string;
  /** Envoy proxy settings (when type is 'Proxy'). */
  proxy?: ProxySettings;
  /** LoadBalancer settings (when type is 'LoadBalancer'). */
  loadBalancer?: LoadBalancerSettings;
}

/**
 * Configuration for a Hyperspike Valkey cluster.
 *
 * @see https://doc.crds.dev/github.com/hyperspike/valkey-operator
 */
export interface ValkeyConfig {
  /** Cluster name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Resource ID for composition references. */
  id?: string;
  /** Valkey cluster specification. */
  spec: {
    /** Valkey container image. */
    image?: string;
    /** Metrics exporter image. */
    exporterImage?: string;
    /** Number of primary nodes/shards (default: 3). */
    shards?: number;
    /** Additional replicas per shard (default: 0). */
    replicas?: number;
    /** Cluster domain (default: 'cluster.local'). */
    clusterDomain?: string;

    // Authentication
    /** Allow connections without authentication (default: false). */
    anonymousAuth?: boolean;
    /** Reference to an existing password secret. */
    servicePassword?: SecretKeySelector;

    // TLS
    /** Enable TLS encryption (default: false). */
    tls?: boolean;
    /** Certificate issuer name (requires cert-manager). */
    certIssuer?: string;
    /** Certificate issuer type: 'ClusterIssuer' or 'Issuer' (default: 'ClusterIssuer'). */
    certIssuerType?: string;

    // Storage & Resources
    /** Persistent storage configuration. */
    storage?: ValkeyStorageConfig;
    /** Run init container to fix volume permissions (default: false). */
    volumePermissions?: boolean;
    /** Pod resource requirements. */
    resources?: ResourceRequirements;
    /** Platform-managed security context (default: false). */
    platformManagedSecurityContext?: boolean;

    // Networking
    /** Preferred endpoint type for cluster communication. */
    clusterPreferredEndpointType?: 'ip' | 'hostname' | 'unknown-endpoint';

    // External Access
    /** External access configuration. */
    externalAccess?: ExternalAccessConfig;

    // Monitoring
    /** Enable Prometheus metrics endpoint (default: false). */
    prometheus?: boolean;
    /** Labels for Prometheus metric matching. */
    prometheusLabels?: Record<string, string>;
    /** Create Prometheus ServiceMonitor resource (default: false). */
    serviceMonitor?: boolean;

    // Scheduling
    /** Node label selectors for pod placement. */
    nodeSelector?: Record<string, string>;
    /** Taint tolerations. */
    tolerations?: Toleration[];
  };
}

/** Status condition for a Valkey cluster. */
export interface ValkeyCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  lastTransitionTime: string;
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

// ============================================================================
// ArkType Schemas
// ============================================================================

/** Shared ArkType schema shape for Toleration. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number',
} as const;

/** ArkType schema for ValkeyConfig. */
export const ValkeyConfigSchema: Type<ValkeyConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    // Core
    'image?': 'string',
    'exporterImage?': 'string',
    'shards?': 'number',
    'replicas?': 'number',
    'clusterDomain?': 'string',

    // Authentication
    'anonymousAuth?': 'boolean',
    'servicePassword?': { name: 'string', key: 'string' },

    // TLS
    'tls?': 'boolean',
    'certIssuer?': 'string',
    'certIssuerType?': 'string',

    // Storage & Resources
    'storage?': {
      'accessModes?': 'string[]',
      'storageClassName?': 'string',
      'resources?': {
        'requests?': { 'storage?': 'string' },
      },
    },
    'volumePermissions?': 'boolean',
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
    'platformManagedSecurityContext?': 'boolean',

    // Networking
    'clusterPreferredEndpointType?': '"ip" | "hostname" | "unknown-endpoint"',

    // External Access
    'externalAccess?': {
      'enabled?': 'boolean',
      'type?': '"LoadBalancer" | "Proxy"',
      'externalDNS?': 'boolean',
      'certIssuer?': 'string',
      'certIssuerType?': 'string',
      'proxy?': {
        'image?': 'string',
        'replicas?': 'number',
        'hostname?': 'string',
        'resources?': {
          'requests?': { 'cpu?': 'string', 'memory?': 'string' },
          'limits?': { 'cpu?': 'string', 'memory?': 'string' },
        },
        'extraConfig?': 'string',
        'annotations?': 'Record<string, string>',
      },
      'loadBalancer?': {
        'annotations?': 'Record<string, string>',
      },
    },

    // Monitoring
    'prometheus?': 'boolean',
    'prometheusLabels?': 'Record<string, string>',
    'serviceMonitor?': 'boolean',

    // Scheduling
    'nodeSelector?': 'Record<string, string>',
    'tolerations?': type(tolerationSchemaShape).array(),
  },
});

// ============================================================================
// Helm Integration Types
// ============================================================================

/** Configuration for the Valkey operator Helm chart repository. */
export interface ValkeyHelmRepositoryConfig {
  /** Repository name (default: 'valkey-operator-repo'). */
  name?: string;
  /** Namespace for the HelmRepository (default: flux-system). */
  namespace?: string;
  /** OCI registry URL (default: 'oci://ghcr.io/hyperspike'). */
  url?: string;
  /** Repository type (default: 'oci' — Hyperspike uses OCI registry). */
  type?: 'default' | 'oci';
  /** Sync interval (default: '5m'). */
  interval?: string;
  /** Resource ID for composition references. */
  id?: string;
}

/** Configuration for the Valkey operator Helm release. */
export interface ValkeyHelmReleaseConfig {
  /** Release name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Chart version. */
  version?: string;
  /** Helm values. */
  values?: Record<string, unknown>;
  /** HelmRepository name to reference (default: 'valkey-operator-repo'). */
  repositoryName?: string;
  /** Resource ID for composition references. */
  id?: string;
}
