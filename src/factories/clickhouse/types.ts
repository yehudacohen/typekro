/**
 * ClickHouse (Altinity clickhouse-operator) Type Definitions
 *
 * ArkType schemas as the single source of truth for config shapes, with types
 * inferred via `typeof Schema.infer`. Status types remain hand-written
 * interfaces, mirroring the CNPG factory family.
 *
 * Wraps the OFFICIAL Altinity clickhouse-operator (Apache-2.0):
 * - Operator chart: `altinity-clickhouse-operator` from https://helm.altinity.com
 * - CHI CRD: `clickhouseinstallations.clickhouse.altinity.com/v1`
 * - CHK CRD: `clickhousekeeperinstallations.clickhouse-keeper.altinity.com/v1`
 *
 * @see https://github.com/Altinity/clickhouse-operator
 * @see https://docs.altinity.com/altinitykubernetesoperator/
 */

import { type } from 'arktype';

// ============================================================================
// Bootstrap Config (Helm Operator Install)
// ============================================================================

/**
 * ArkType schema for ClickHouseOperatorBootstrapConfig.
 *
 * Configuration for installing the Altinity clickhouse-operator via Helm.
 * Used by the `clickhouseOperatorBootstrap` composition to deploy the
 * operator controller into the cluster.
 *
 * IMPORTANT: the operator is CLUSTER-SCOPED and owns the ClickHouse CRDs —
 * install exactly ONE per cluster. Multiple installs fight over CRD ownership
 * and watch the same resources. The bootstrap defaults to `shared: true`
 * (cluster-scoped resource tagging) accordingly.
 */
export const ClickHouseOperatorBootstrapConfigSchema = type({
  /** Release name for the Helm installation. */
  name: 'string',
  /** Namespace for the operator (default: 'clickhouse-system'). */
  'namespace?': 'string',
  /** Chart version (default: '0.27.1'). */
  'version?': 'string',
  /**
   * Metrics exporter configuration. The chart enables the metrics exporter
   * by default (`metrics.enabled: true`).
   */
  'metrics?': { 'enabled?': 'boolean' },
  /**
   * CRD installation via Helm hook (`crdHook.enabled`). NOTE: when deploying
   * through Flux (as this composition does), helm-controller's CRD handling
   * interacts with hook-installed CRDs — Flux only upgrades CRDs per its
   * `install.crds`/`upgrade.crds` policy, so CRD upgrades across operator
   * versions may need explicit attention. Leave unset to use chart defaults.
   */
  'crdHook?': { 'enabled?': 'boolean' },
  /** Operator pod resources. */
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
  /** Additional Helm values for user overrides. */
  'customValues?': 'Record<string, unknown>',
  /**
   * Whether the operator install should be treated as shared cluster
   * infrastructure (default: `true`). When `true`, the Namespace and
   * HelmRelease are tagged with `scopes: ['cluster']` so
   * `factory.deleteInstance()` will NOT remove them — the operator is
   * one-per-cluster infrastructure that every ClickHouseInstallation
   * consumer depends on. Set to `false` only for dedicated throwaway
   * environments (e.g. kind-cluster integration tests).
   */
  'shared?': 'boolean',
});

/** Configuration for installing the Altinity clickhouse-operator via Helm. */
export type ClickHouseOperatorBootstrapConfig =
  typeof ClickHouseOperatorBootstrapConfigSchema.infer;

/**
 * Observed status of an Altinity clickhouse-operator deployment.
 */
export interface ClickHouseOperatorBootstrapStatus {
  /** Overall deployment phase (derived from HelmRelease Ready condition). */
  phase: 'Ready' | 'Installing';
  /** Whether the operator is ready to manage installations. */
  ready: boolean;
  /** Deployed chart version. */
  version?: string;
}

/** ArkType schema for ClickHouseOperatorBootstrapStatus. */
export const ClickHouseOperatorBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Shared HelmRepository Singleton
// ============================================================================

/** Spec accepted by the shared ClickHouse HelmRepository singleton. */
export const ClickHouseHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

/** Status surfaced by the shared ClickHouse HelmRepository singleton. */
export const ClickHouseHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

// ============================================================================
// Helm Integration Types
// ============================================================================

/**
 * ArkType schema for ClickHouseHelmRepositoryConfig.
 *
 * Configuration for the Altinity Helm chart repository.
 */
export const ClickHouseHelmRepositoryConfigSchema = type({
  /** Repository name (default: 'altinity'). */
  'name?': 'string',
  /** Namespace for the HelmRepository (default: flux-system). */
  'namespace?': 'string',
  /** Repository URL (default: 'https://helm.altinity.com'). */
  'url?': 'string',
  /** Sync interval (default: '5m'). */
  'interval?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the Altinity Helm chart repository. */
export type ClickHouseHelmRepositoryConfig =
  typeof ClickHouseHelmRepositoryConfigSchema.infer;

/**
 * ArkType schema for ClickHouseOperatorHelmReleaseConfig.
 *
 * Configuration for the altinity-clickhouse-operator Helm release.
 */
export const ClickHouseOperatorHelmReleaseConfigSchema = type({
  /** Release name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Chart version (default: '0.27.1'). */
  'version?': 'string',
  /** Helm values. */
  'values?': 'Record<string, unknown>',
  /** HelmRepository name to reference (default: 'altinity'). */
  'repositoryName?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the altinity-clickhouse-operator Helm release. */
export type ClickHouseOperatorHelmReleaseConfig =
  typeof ClickHouseOperatorHelmReleaseConfigSchema.infer;

// ============================================================================
// ClickHouseInstallation (CHI) Resource
// ============================================================================

/**
 * ArkType schema for ClickHouseInstallationConfig.
 *
 * HIGH-LEVEL configuration compiled by `clickHouseInstallation()` into a
 * `clickhouse.altinity.com/v1` ClickHouseInstallation (CHI) spec. This is
 * deliberately not a 1:1 CRD mirror: the typed factory exists to compile the
 * zone-pinning layout the operator cannot express natively (see
 * `utils/zone-layout.ts`).
 */
export const ClickHouseInstallationConfigSchema = type({
  /** Installation name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /**
   * Logical cluster name inside the CHI (default: 'cluster').
   *
   * SIGNOZ COMPATIBILITY: SigNoz's ClickHouse migrations hardcode the cluster
   * name `cluster` — a SigNoz deployment pointed at this CHI only works when
   * the default is kept. Override only for non-SigNoz consumers.
   */
  'clusterName?': 'string',
  /**
   * ClickHouse server image tag (e.g. '25.12.5'). Compiled into the pod
   * template image `clickhouse/clickhouse-server:<version>` unless `image`
   * overrides the full reference.
   */
  version: 'string',
  /** Full image override (takes precedence over `version`). */
  'image?': 'string',
  /** Shard count (default: 1). */
  'shards?': 'number',
  /** Replicas per shard (default: 1). */
  'replicas?': 'number',
  /**
   * Availability zones to pin replicas to (e.g. ['us-east-2a','us-east-2b']).
   *
   * When provided, the factory compiles a PER-REPLICA layout where each
   * replica's pod template pins one zone via nodeAffinity on
   * `topology.kubernetes.io/zone` (round-robin when replicas > zones).
   * See `utils/zone-layout.ts` for why the operator's own `podDistribution`
   * cannot do this (Altinity/clickhouse-operator#772).
   */
  'zones?': 'string[]',
  /** Persistent storage for ClickHouse data. Required. */
  storage: {
    /** Volume size (e.g. '100Gi'). Required. */
    size: 'string',
    /**
     * StorageClass name. On EKS this should be a WaitForFirstConsumer +
     * `allowVolumeExpansion: true` gp3 class so the PVC binds in the zone the
     * scheduler places the pod (and can grow in place).
     */
    'storageClassName?': 'string',
  },
  /**
   * ClickHouse users, compiled to the operator's path-keyed
   * `spec.configuration.users` format
   * (`<user>/password_sha256_hex`, `<user>/networks/ip`).
   */
  'users?': type({
    '[string]': {
      /** SHA256 hex digest of the user password. */
      'passwordSha256Hex?': 'string',
      /** Allowed source networks (e.g. ['::/0']). */
      'networksIp?': 'string[]',
    },
  }),
  /**
   * (ClickHouse) Keeper coordination endpoint, wired into
   * `spec.configuration.zookeeper.nodes` (the operator uses the zookeeper
   * section for clickhouse-keeper too). Required for replicated tables
   * when `replicas > 1`.
   */
  'keeper?': {
    host: 'string',
    /** Keeper client port (default: 2181). */
    'port?': 'number',
  },
  /** ClickHouse server container resources. */
  'podResources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
});

/** High-level configuration for a ClickHouseInstallation. */
export type ClickHouseInstallationConfig =
  typeof ClickHouseInstallationConfigSchema.infer;

// ----------------------------------------------------------------------------
// CHI spec shapes (what the factory compiles TO). Typed as far as practical;
// the CRD is open (settings/files/pod specs), so `object` escape hatches are
// used where the operator accepts arbitrary structures.
// ----------------------------------------------------------------------------

/** A CHI pod template (`spec.templates.podTemplates[]`). */
export interface ChiPodTemplate {
  name: string;
  /** Kubernetes PodSpec — open CRD structure. */
  spec?: Record<string, unknown>;
  /** Operator zone sugar; the factory emits explicit nodeAffinity instead. */
  zone?: { key?: string; values: string[] };
  podDistribution?: Record<string, unknown>[];
}

/** A CHI volume claim template (`spec.templates.volumeClaimTemplates[]`). */
export interface ChiVolumeClaimTemplate {
  name: string;
  /** Kubernetes PersistentVolumeClaimSpec — open CRD structure. */
  spec: Record<string, unknown>;
}

/** Per-replica entry in a replica-first cluster layout. */
export interface ChiClusterLayoutReplica {
  name?: string;
  templates?: { podTemplate?: string; dataVolumeClaimTemplate?: string };
  shardsCount?: number;
}

/** Cluster layout (`spec.configuration.clusters[].layout`). */
export interface ChiClusterLayout {
  shardsCount?: number;
  replicasCount?: number;
  /** Replica-first explicit layout (used for zone pinning). */
  replicas?: ChiClusterLayoutReplica[];
  shards?: Record<string, unknown>[];
}

/** Logical cluster (`spec.configuration.clusters[]`). */
export interface ChiCluster {
  name: string;
  layout?: ChiClusterLayout;
  templates?: { podTemplate?: string; dataVolumeClaimTemplate?: string };
}

/** ClickHouseInstallation spec (`clickhouse.altinity.com/v1`). */
export interface ClickHouseInstallationSpec {
  defaults?: {
    templates?: {
      podTemplate?: string;
      dataVolumeClaimTemplate?: string;
      serviceTemplate?: string;
    };
  };
  configuration?: {
    clusters?: ChiCluster[];
    /** Keeper/ZooKeeper coordination nodes. */
    zookeeper?: { nodes?: { host: string; port?: number }[] };
    /** Path-keyed user settings (e.g. `admin/password_sha256_hex`). */
    users?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    files?: Record<string, string>;
  };
  templates?: {
    podTemplates?: ChiPodTemplate[];
    volumeClaimTemplates?: ChiVolumeClaimTemplate[];
    serviceTemplates?: Record<string, unknown>[];
  };
}

/**
 * Observed status of a ClickHouseInstallation.
 *
 * The reconcile state lives in `status.status`, one of:
 * `InProgress` | `Completed` | `Aborted` | `Terminating`
 * (source: clickhouse-operator
 * `pkg/apis/clickhouse.altinity.com/v1/type_status.go`).
 */
export interface ClickHouseInstallationStatus {
  /** Reconcile status: 'InProgress' | 'Completed' | 'Aborted' | 'Terminating'. */
  status?: string;
  /** Operator version that produced this status. */
  chopVersion?: string;
  clustersCount?: number;
  shardsCount?: number;
  hostsCount?: number;
  hostsCompletedCount?: number;
  taskID?: string;
  /** Recent reconcile errors. */
  errors?: string[];
  /** Generated ClickHouse endpoint (service DNS name). */
  endpoint?: string;
  fqdns?: string[];
}

// ============================================================================
// ClickHouseKeeperInstallation (CHK) Resource
// ============================================================================

/**
 * ArkType schema for ClickHouseKeeperInstallationConfig.
 *
 * Minimal high-level configuration compiled by
 * `clickHouseKeeperInstallation()` into a `clickhouse-keeper.altinity.com/v1`
 * ClickHouseKeeperInstallation (CHK) spec.
 */
export const ClickHouseKeeperInstallationConfigSchema = type({
  /** Keeper installation name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /** Keeper replica count (default: 1; use an odd number for quorum). */
  'replicas?': 'number',
  /** Persistent storage for the keeper log/snapshot data. */
  'storage?': {
    size: 'string',
    'storageClassName?': 'string',
  },
});

/** High-level configuration for a ClickHouseKeeperInstallation. */
export type ClickHouseKeeperInstallationConfig =
  typeof ClickHouseKeeperInstallationConfigSchema.infer;

/** ClickHouseKeeperInstallation spec (`clickhouse-keeper.altinity.com/v1`). */
export interface ClickHouseKeeperInstallationSpec {
  defaults?: {
    templates?: {
      podTemplate?: string;
      dataVolumeClaimTemplate?: string;
    };
  };
  configuration?: {
    clusters?: { name: string; layout?: { replicasCount?: number } }[];
    settings?: Record<string, unknown>;
  };
  templates?: {
    podTemplates?: ChiPodTemplate[];
    volumeClaimTemplates?: ChiVolumeClaimTemplate[];
  };
}

/**
 * Observed status of a ClickHouseKeeperInstallation.
 *
 * CHK reports the same reconcile state machine as CHI (`status.status`:
 * 'InProgress' | 'Completed' | 'Aborted' | 'Terminating') — the status type
 * is shared operator code.
 */
export type ClickHouseKeeperInstallationStatus = ClickHouseInstallationStatus;
