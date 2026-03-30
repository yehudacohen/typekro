/**
 * CloudNativePG (CNPG) Type Definitions
 *
 * ArkType schemas as the single source of truth, with types inferred via
 * `typeof Schema.infer`. Status types remain as hand-written interfaces.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/
 */

import { type } from 'arktype';

// ============================================================================
// Common Kubernetes Types
// ============================================================================

/** Reference to a key in a Kubernetes Secret. */
export interface SecretKeyRef {
  name: string;
  key: string;
}

/** Minimal object reference (name only). */
export interface LocalObjectReference {
  name: string;
}

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

// ============================================================================
// Shared Schema Shapes
// ============================================================================

/** Shared ArkType schema shape for BarmanObjectStoreConfiguration. */
const barmanObjectStoreSchemaShape = {
  destinationPath: 'string',
  's3Credentials?': {
    accessKeyId: { name: 'string', key: 'string' },
    secretAccessKey: { name: 'string', key: 'string' },
    'region?': 'string',
    'sessionToken?': { name: 'string', key: 'string' },
  },
  'azureCredentials?': {
    'connectionString?': { name: 'string', key: 'string' },
    'storageAccount?': { name: 'string', key: 'string' },
    'storageKey?': { name: 'string', key: 'string' },
  },
  'googleCredentials?': {
    'gkeEnvironment?': 'boolean',
  },
  'endpointURL?': 'string',
  'serverName?': 'string',
  'data?': {
    'compression?': 'string',
    'encryption?': 'string',
    'jobs?': 'number',
    'immediateCheckpoint?': 'boolean',
  },
  'wal?': {
    'compression?': 'string',
    'maxParallel?': 'number',
  },
  'tags?': 'Record<string, string>',
} as const;

/** Shared ArkType schema shape for Kubernetes tolerations. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number',
} as const;

// ============================================================================
// Bootstrap Config (Helm Operator Install)
// ============================================================================

/**
 * ArkType schema for CnpgBootstrapConfig.
 *
 * Configuration for installing the CloudNativePG operator via Helm.
 * Used by the `cnpgBootstrap` composition to deploy the operator
 * controller into the cluster.
 */
export const CnpgBootstrapConfigSchema = type({
  /** Release name for the Helm installation. */
  name: 'string',
  /** Namespace for the operator (default: 'cnpg-system'). */
  'namespace?': 'string',
  /** Chart version (default: '0.23.0'). */
  'version?': 'string',
  /** Whether to install CRDs with the chart (default: true). */
  'installCRDs?': 'boolean',
  /** Number of operator controller replicas (default: 1). */
  'replicaCount?': 'number',
  /** Monitoring configuration. */
  'monitoring?': { 'enabled?': 'boolean' },
  /** Operator pod resources. */
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
  /** Additional Helm values for user overrides. */
  'customValues?': 'Record<string, unknown>',
});

/** Configuration for installing the CloudNativePG operator via Helm. */
export type CnpgBootstrapConfig = typeof CnpgBootstrapConfigSchema.infer;

/**
 * Observed status of a CloudNativePG operator deployment.
 */
export interface CnpgBootstrapStatus {
  /** Overall deployment phase (derived from HelmRelease Ready condition). */
  phase: 'Ready' | 'Installing';
  /** Whether the operator is ready to manage clusters. */
  ready: boolean;
  /** Deployed chart version. */
  version?: string;
}

/** ArkType schema for CnpgBootstrapStatus. */
export const CnpgBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Cluster Resource
// ============================================================================

/**
 * ArkType schema for ClusterConfig.
 *
 * Configuration for a CloudNativePG PostgreSQL cluster.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ClusterSpec
 */
export const ClusterConfigSchema = type({
  /** Cluster name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /** Cluster specification. */
  spec: {
    /** Number of PostgreSQL instances (primary + replicas). Default: 1. */
    'instances?': 'number',
    /** PostgreSQL container image. */
    'imageName?': 'string',
    /** Image pull policy. */
    'imagePullPolicy?': 'string',
    /** Image pull secrets. */
    'imagePullSecrets?': type({ name: 'string' }).array(),
    /** Instance storage configuration. Required. */
    storage: {
      /** Storage size (e.g. '10Gi', '100Gi'). Required. */
      size: 'string',
      /** Storage class name (e.g. 'gp3', 'standard'). */
      'storageClass?': 'string',
      /** Allow online volume resize (default: true on supported storage classes). */
      'resizeInUseVolumes?': 'boolean',
      /** PVC template overrides. */
      'pvcTemplate?': {
        'accessModes?': 'string[]',
        'volumeMode?': 'string',
      },
    },
    /** PostgreSQL server configuration. */
    'postgresql?': {
      /** PostgreSQL GUC parameters (e.g. shared_buffers, max_connections). */
      'parameters?': 'Record<string, string>',
      /** Custom pg_hba.conf entries. */
      'pg_hba?': 'string[]',
      /** Shared preload libraries list. */
      'shared_preload_libraries?': 'string[]',
    },
    /** Cluster initialization method. */
    'bootstrap?': {
      /** Initialize a new cluster with initdb. */
      'initdb?': {
        /** Application database name (default: 'app'). */
        'database?': 'string',
        /** Database owner (default: 'app'). */
        'owner?': 'string',
        /** Character set encoding (default: 'UTF8'). */
        'encoding?': 'string',
        /** Enable data page checksums. */
        'dataChecksums?': 'boolean',
        /** Locale provider: 'builtin' or 'icu' (PG 15+). */
        'localeProvider?': 'string',
        /** ICU locale code. */
        'icuLocale?': 'string',
      },
      /** Bootstrap from an existing backup (PITR). */
      'recovery?': {
        /** External cluster source name. */
        source: 'string',
        /** Recovery target for PITR. */
        'recoveryTarget?': {
          'targetTime?': 'string',
          'targetLSN?': 'string',
          'targetName?': 'string',
          'exclusive?': 'boolean',
        },
      },
      /** Bootstrap from pg_basebackup. */
      'pg_basebackup?': {
        /** External cluster source name. */
        source: 'string',
      },
    },
    /** Backup configuration. */
    'backup?': {
      /** Barman object store configuration. */
      'barmanObjectStore?': barmanObjectStoreSchemaShape,
      /** Backup retention policy (e.g. '30d', '4w', '2m'). */
      'retentionPolicy?': 'string',
      /** Backup target: 'primary' or 'prefer-standby'. */
      'target?': '"primary" | "prefer-standby"',
      /** Volume snapshot configuration. */
      'volumeSnapshot?': {
        'className?': 'string',
        'online?': 'boolean',
        'onlineConfiguration?': {
          'immediateCheckpoint?': 'boolean',
          'waitForArchive?': 'boolean',
        },
      },
    },
    /** Pod resource requirements. */
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
    /** Pod scheduling and anti-affinity. */
    'affinity?': {
      /** Enable pod anti-affinity (default: true). */
      'enablePodAntiAffinity?': 'boolean',
      /** Node label selectors. */
      'nodeSelector?': 'Record<string, string>',
      /** Taint tolerations. */
      'tolerations?': type(tolerationSchemaShape).array(),
      /** Topology label for pod distribution (e.g. 'kubernetes.io/hostname'). */
      'topologyKey?': 'string',
      /** Anti-affinity strength: 'preferred' or 'required'. */
      'podAntiAffinityType?': '"preferred" | "required"',
    },
    /** Prometheus monitoring. */
    'monitoring?': {
      /** Enable monitoring. */
      'enabled?': 'boolean',
      /** ConfigMap references for custom metric queries. */
      'customQueriesConfigMap?': type({ name: 'string' }).array(),
      /** Enable PodMonitor creation. */
      'podMonitorEnabled?': 'boolean',
    },
    /** TLS certificate configuration. */
    'certificates?': {
      /** Secret name for the server CA certificate. */
      'serverCASecret?': 'string',
      /** Secret name for the server TLS certificate. */
      'serverTLSSecret?': 'string',
      /** Secret name for the client CA certificate. */
      'clientCASecret?': 'string',
      /** Secret name for the replication TLS certificate. */
      'replicationTLSSecret?': 'string',
    },
    /** External cluster references. */
    'externalClusters?': type({
      /** Unique name for the external cluster reference. */
      name: 'string',
      /** Connection parameters (host, port, dbname, etc.). */
      'connectionParameters?': 'Record<string, string>',
      /** Barman object store for backup-based recovery. */
      'barmanObjectStore?': barmanObjectStoreSchemaShape,
      /** Password secret reference. */
      'password?': { name: 'string', key: 'string' },
    }).array(),
  },
});

/**
 * Configuration for a CloudNativePG PostgreSQL cluster.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ClusterSpec
 */
export type ClusterConfig = typeof ClusterConfigSchema.infer;

/** Status condition for a CNPG cluster. */
export interface ClusterCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/**
 * Observed status of a CloudNativePG cluster.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ClusterStatus
 */
export interface ClusterStatus {
  /** Total instances detected. */
  instances?: number;
  /** Number of ready instances. */
  readyInstances?: number;
  /** Active primary instance name. */
  currentPrimary?: string;
  /** Write (primary) service name. */
  writeService?: string;
  /** Read (replica) service name. */
  readService?: string;
  /** Cluster operational phase. */
  phase?: string;
  /** Status conditions. */
  conditions?: ClusterCondition[];
  /** Last successful backup timestamp. */
  lastSuccessfulBackup?: string;
  /** Certificate status. */
  certificates?: {
    serverCASecret?: string;
    expirations?: Record<string, string>;
  };
}

// ============================================================================
// Backup Resource
// ============================================================================

/**
 * ArkType schema for BackupConfig.
 *
 * Configuration for an on-demand CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#BackupSpec
 */
export const BackupConfigSchema = type({
  /** Backup name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /** Backup specification. */
  spec: {
    /** Target cluster reference. Required. */
    cluster: { name: 'string' },
    /** Backup method. */
    'method?': '"barmanObjectStore" | "volumeSnapshot" | "plugin"',
    /** Backup target. */
    'target?': '"primary" | "prefer-standby"',
    /** Hot/cold backup for volume snapshots (default: true). */
    'online?': 'boolean',
    /** Online backup configuration. */
    'onlineConfiguration?': {
      'immediateCheckpoint?': 'boolean',
      'waitForArchive?': 'boolean',
    },
  },
});

/**
 * Configuration for an on-demand CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#BackupSpec
 */
export type BackupConfig = typeof BackupConfigSchema.infer;

/**
 * Observed status of a CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#BackupStatus
 */
export interface BackupStatus {
  /** Backup lifecycle phase. */
  phase?: 'new' | 'started' | 'completed' | 'failed';
  /** Barman backup identifier. */
  backupId?: string;
  /** Barman backup name. */
  backupName?: string;
  /** Backup start timestamp. */
  startedAt?: string;
  /** Backup completion timestamp. */
  stoppedAt?: string;
  /** Error message if failed. */
  error?: string;
  /** Cloud storage destination path. */
  destinationPath?: string;
}

// ============================================================================
// ScheduledBackup Resource
// ============================================================================

/**
 * ArkType schema for ScheduledBackupConfig.
 *
 * Configuration for a cron-scheduled CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ScheduledBackupSpec
 */
export const ScheduledBackupConfigSchema = type({
  /** ScheduledBackup name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /** ScheduledBackup specification. */
  spec: {
    /** Target cluster reference. Required. */
    cluster: { name: 'string' },
    /**
     * Cron expression with seconds (robfig/cron format).
     * Example: '0 0 2 * * *' = 2 AM daily. Required.
     */
    schedule: 'string',
    /** Backup method. */
    'method?': '"barmanObjectStore" | "volumeSnapshot" | "plugin"',
    /** Trigger first backup immediately on creation. */
    'immediate?': 'boolean',
    /** Pause scheduled backups. */
    'suspend?': 'boolean',
    /** Backup target. */
    'target?': '"primary" | "prefer-standby"',
    /** Owner reference policy for created Backup resources. */
    'backupOwnerReference?': '"none" | "self" | "cluster"',
  },
});

/**
 * Configuration for a cron-scheduled CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ScheduledBackupSpec
 */
export type ScheduledBackupConfig = typeof ScheduledBackupConfigSchema.infer;

/**
 * Observed status of a scheduled backup.
 */
export interface ScheduledBackupStatus {
  /** Status conditions. */
  conditions?: ClusterCondition[];
  /** Latest schedule evaluation time. */
  lastCheckTime?: string;
  /** Most recent backup trigger time. */
  lastScheduleTime?: string;
  /** Next scheduled execution. */
  nextScheduleTime?: string;
  /** Last successful backup completion. */
  lastSuccessfulBackup?: string;
  /** Last failed backup time. */
  lastFailedBackup?: string;
}

// ============================================================================
// Pooler Resource
// ============================================================================

/**
 * ArkType schema for PoolerConfig.
 *
 * Configuration for a CNPG PgBouncer connection pooler.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#PoolerSpec
 */
export const PoolerConfigSchema = type({
  /** Pooler name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
  /** Pooler specification. */
  spec: {
    /** Target cluster reference. Required. */
    cluster: { name: 'string' },
    /** Pooler type: 'rw' (read-write primary), 'ro' (read-only, any replica), 'r' (load-balanced across all standbys). */
    'type?': '"rw" | "ro" | "r"',
    /** Number of PgBouncer replicas (default: 1). */
    'instances?': 'number',
    /** PgBouncer configuration. Required. */
    pgbouncer: {
      /** Pool mode: 'session' (default) or 'transaction'. */
      'poolMode?': '"session" | "transaction"',
      /** Pause/resume connections. */
      'paused?': 'boolean',
      /** PgBouncer parameters (pool_size, max_client_conn, etc.). */
      'parameters?': 'Record<string, string>',
      /** Custom pg_hba rules. */
      'pg_hba?': 'string[]',
      /** Custom auth query. */
      'authQuery?': 'string',
    },
    /** Custom pod template. */
    'template?': 'Record<string, unknown>',
    /** Deployment strategy. */
    'deploymentStrategy?': 'Record<string, unknown>',
  },
});

/**
 * Configuration for a CNPG PgBouncer connection pooler.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#PoolerSpec
 */
export type PoolerConfig = typeof PoolerConfigSchema.infer;

/**
 * Observed status of a CNPG pooler.
 */
export interface PoolerStatus {
  /** Scheduled pod count. */
  instances?: number;
  /** Whether the pooler is ready. */
  ready?: boolean;
  /** Pooler service hostname (derived from resource name). */
  hostname?: string;
  /** Status conditions. */
  conditions?: ClusterCondition[];
}

// ============================================================================
// Helm Integration Types
// ============================================================================

/**
 * ArkType schema for CnpgHelmRepositoryConfig.
 *
 * Configuration for the CNPG Helm chart repository.
 */
export const CnpgHelmRepositoryConfigSchema = type({
  /** Repository name (default: 'cnpg-repo'). */
  'name?': 'string',
  /** Namespace for the HelmRepository (default: flux-system). */
  'namespace?': 'string',
  /** Repository URL (default: 'https://cloudnative-pg.github.io/charts'). */
  'url?': 'string',
  /** Sync interval (default: '5m'). */
  'interval?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the CNPG Helm chart repository. */
export type CnpgHelmRepositoryConfig = typeof CnpgHelmRepositoryConfigSchema.infer;

/**
 * ArkType schema for CnpgHelmReleaseConfig.
 *
 * Configuration for the CNPG Helm release.
 */
export const CnpgHelmReleaseConfigSchema = type({
  /** Release name. */
  name: 'string',
  /** Target namespace. */
  'namespace?': 'string',
  /** Chart version (default: '0.23.0'). */
  'version?': 'string',
  /** Helm values. */
  'values?': 'Record<string, unknown>',
  /** HelmRepository name to reference (default: 'cnpg-repo'). */
  'repositoryName?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the CNPG Helm release. */
export type CnpgHelmReleaseConfig = typeof CnpgHelmReleaseConfigSchema.infer;
