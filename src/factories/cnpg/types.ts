/**
 * CloudNativePG (CNPG) Type Definitions
 *
 * TypeScript interfaces and ArkType schemas for all CNPG custom resources.
 * Covers the postgresql.cnpg.io/v1 API group.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/
 */

import { type Type, type } from 'arktype';

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
// Bootstrap Config (Helm Operator Install)
// ============================================================================

/**
 * Configuration for installing the CloudNativePG operator via Helm.
 *
 * Used by the `cnpgBootstrap` composition to deploy the operator
 * controller into the cluster.
 */
export interface CnpgBootstrapConfig {
  /** Release name for the Helm installation. */
  name: string;
  /** Namespace for the operator (default: 'cnpg-system'). */
  namespace?: string;
  /** Chart version (default: '0.23.0'). */
  version?: string;
  /** Whether to install CRDs with the chart (default: true). */
  installCRDs?: boolean;
  /** Number of operator controller replicas (default: 1). */
  replicaCount?: number;
  /** Monitoring configuration. */
  monitoring?: { enabled?: boolean };
  /** Operator pod resources. */
  resources?: ResourceRequirements;
  /** Additional Helm values for user overrides. */
  customValues?: Record<string, unknown>;
}

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

/** ArkType schema for CnpgBootstrapConfig. */
export const CnpgBootstrapConfigSchema: Type<CnpgBootstrapConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'installCRDs?': 'boolean',
  'replicaCount?': 'number',
  'monitoring?': { 'enabled?': 'boolean' },
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
  'customValues?': 'Record<string, unknown>',
});

/** ArkType schema for CnpgBootstrapStatus. */
export const CnpgBootstrapStatusSchema: Type<CnpgBootstrapStatus> = type({
  phase: '"Ready" | "Installing"',
  ready: 'boolean',
  'version?': 'string',
});

// ============================================================================
// Cluster Resource
// ============================================================================

/** PVC-based storage configuration for a CNPG cluster. */
export interface StorageConfiguration {
  /** Storage size (e.g. '10Gi', '100Gi'). Required. */
  size: string;
  /** Storage class name (e.g. 'gp3', 'standard'). */
  storageClass?: string;
  /** Allow online volume resize (default: true on supported storage classes). */
  resizeInUseVolumes?: boolean;
  /** PVC template overrides. */
  pvcTemplate?: {
    accessModes?: string[];
    volumeMode?: string;
  };
}

/** PostgreSQL server configuration. */
export interface PostgresConfiguration {
  /** PostgreSQL GUC parameters (e.g. shared_buffers, max_connections). */
  parameters?: Record<string, string>;
  /** Custom pg_hba.conf entries. */
  pg_hba?: string[];
  /** Shared preload libraries list. */
  shared_preload_libraries?: string[];
}

/** Cluster initialization method. */
export interface BootstrapConfiguration {
  /** Initialize a new cluster with initdb. */
  initdb?: {
    /** Application database name (default: 'app'). */
    database?: string;
    /** Database owner (default: 'app'). */
    owner?: string;
    /** Character set encoding (default: 'UTF8'). */
    encoding?: string;
    /** Enable data page checksums. */
    dataChecksums?: boolean;
    /** Locale provider: 'builtin' or 'icu' (PG 15+). */
    localeProvider?: string;
    /** ICU locale code. */
    icuLocale?: string;
  };
  /** Bootstrap from an existing backup (PITR). */
  recovery?: {
    /** External cluster source name. */
    source: string;
    /** Recovery target for PITR. */
    recoveryTarget?: {
      targetTime?: string;
      targetLSN?: string;
      targetName?: string;
      exclusive?: boolean;
    };
  };
  /** Bootstrap from pg_basebackup. */
  pg_basebackup?: {
    /** External cluster source name. */
    source: string;
  };
}

/** Barman-based object store backup configuration. */
export interface BarmanObjectStoreConfiguration {
  /** Cloud storage destination (e.g. 's3://bucket/path'). Required. */
  destinationPath: string;
  /** AWS S3 authentication. */
  s3Credentials?: {
    accessKeyId: SecretKeyRef;
    secretAccessKey: SecretKeyRef;
    region?: string;
    sessionToken?: SecretKeyRef;
  };
  /** Azure Blob Storage authentication. */
  azureCredentials?: {
    connectionString?: SecretKeyRef;
    storageAccount?: SecretKeyRef;
    storageKey?: SecretKeyRef;
  };
  /** Google Cloud Storage authentication. */
  googleCredentials?: {
    gkeEnvironment?: boolean;
  };
  /** Custom S3-compatible endpoint URL. */
  endpointURL?: string;
  /** Custom backup server name. */
  serverName?: string;
  /** Data backup settings. */
  data?: {
    compression?: string;
    encryption?: string;
    jobs?: number;
    immediateCheckpoint?: boolean;
  };
  /** WAL archiving settings. */
  wal?: {
    compression?: string;
    maxParallel?: number;
  };
  /** Backup metadata tags. */
  tags?: Record<string, string>;
}

/** Cluster backup configuration. */
export interface BackupSpec {
  /** Barman object store configuration. */
  barmanObjectStore?: BarmanObjectStoreConfiguration;
  /** Backup retention policy (e.g. '30d', '4w', '2m'). */
  retentionPolicy?: string;
  /** Backup target: 'primary' or 'prefer-standby'. */
  target?: 'primary' | 'prefer-standby';
  /** Volume snapshot configuration. */
  volumeSnapshot?: {
    className?: string;
    online?: boolean;
    onlineConfiguration?: {
      immediateCheckpoint?: boolean;
      waitForArchive?: boolean;
    };
  };
}

/** Pod anti-affinity and scheduling configuration. */
export interface AffinityConfiguration {
  /** Enable pod anti-affinity (default: true). */
  enablePodAntiAffinity?: boolean;
  /** Node label selectors. */
  nodeSelector?: Record<string, string>;
  /** Taint tolerations. */
  tolerations?: Toleration[];
  /** Topology label for pod distribution (e.g. 'kubernetes.io/hostname'). */
  topologyKey?: string;
  /** Anti-affinity strength: 'preferred' or 'required'. */
  podAntiAffinityType?: 'preferred' | 'required';
}

/** Prometheus monitoring configuration. */
export interface MonitoringConfiguration {
  /** Enable monitoring. */
  enabled?: boolean;
  /** ConfigMap references for custom metric queries. */
  customQueriesConfigMap?: LocalObjectReference[];
  /** Enable PodMonitor creation. */
  podMonitorEnabled?: boolean;
}

/** TLS certificate configuration for the cluster. */
export interface CertificatesConfiguration {
  /** Secret name for the server CA certificate. */
  serverCASecret?: string;
  /** Secret name for the server TLS certificate. */
  serverTLSSecret?: string;
  /** Secret name for the client CA certificate. */
  clientCASecret?: string;
  /** Secret name for the replication TLS certificate. */
  replicationTLSSecret?: string;
}

/** External cluster reference for recovery or replication. */
export interface ExternalCluster {
  /** Unique name for the external cluster reference. */
  name: string;
  /** Connection parameters (host, port, dbname, etc.). */
  connectionParameters?: Record<string, string>;
  /** Barman object store for backup-based recovery. */
  barmanObjectStore?: BarmanObjectStoreConfiguration;
  /** Password secret reference. */
  password?: SecretKeyRef;
}

/**
 * Configuration for a CloudNativePG PostgreSQL cluster.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ClusterSpec
 */
export interface ClusterConfig {
  /** Cluster name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Resource ID for composition references. */
  id?: string;
  /** Cluster specification. */
  spec: {
    /** Number of PostgreSQL instances (primary + replicas). Default: 1. */
    instances?: number;
    /** PostgreSQL container image. */
    imageName?: string;
    /** Image pull policy. */
    imagePullPolicy?: string;
    /** Image pull secrets. */
    imagePullSecrets?: LocalObjectReference[];
    /** Instance storage configuration. Required. */
    storage: StorageConfiguration;
    /** PostgreSQL server configuration. */
    postgresql?: PostgresConfiguration;
    /** Cluster initialization method. */
    bootstrap?: BootstrapConfiguration;
    /** Backup configuration. */
    backup?: BackupSpec;
    /** Pod resource requirements. */
    resources?: ResourceRequirements;
    /** Pod scheduling and anti-affinity. */
    affinity?: AffinityConfiguration;
    /** Prometheus monitoring. */
    monitoring?: MonitoringConfiguration;
    /** TLS certificate configuration. */
    certificates?: CertificatesConfiguration;
    /** External cluster references. */
    externalClusters?: ExternalCluster[];
  };
}

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

/** ArkType schema for ClusterConfig. */
export const ClusterConfigSchema: Type<ClusterConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    'instances?': 'number',
    'imageName?': 'string',
    'imagePullPolicy?': 'string',
    'imagePullSecrets?': type({ name: 'string' }).array(),
    storage: {
      size: 'string',
      'storageClass?': 'string',
      'resizeInUseVolumes?': 'boolean',
      'pvcTemplate?': {
        'accessModes?': 'string[]',
        'volumeMode?': 'string',
      },
    },
    'postgresql?': {
      'parameters?': 'Record<string, string>',
      'pg_hba?': 'string[]',
      'shared_preload_libraries?': 'string[]',
    },
    'bootstrap?': {
      'initdb?': {
        'database?': 'string',
        'owner?': 'string',
        'encoding?': 'string',
        'dataChecksums?': 'boolean',
        'localeProvider?': 'string',
        'icuLocale?': 'string',
      },
      'recovery?': {
        source: 'string',
        'recoveryTarget?': {
          'targetTime?': 'string',
          'targetLSN?': 'string',
          'targetName?': 'string',
          'exclusive?': 'boolean',
        },
      },
      'pg_basebackup?': {
        source: 'string',
      },
    },
    'backup?': {
      'barmanObjectStore?': barmanObjectStoreSchemaShape,
      'retentionPolicy?': 'string',
      'target?': '"primary" | "prefer-standby"',
      'volumeSnapshot?': {
        'className?': 'string',
        'online?': 'boolean',
        'onlineConfiguration?': {
          'immediateCheckpoint?': 'boolean',
          'waitForArchive?': 'boolean',
        },
      },
    },
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
    'affinity?': {
      'enablePodAntiAffinity?': 'boolean',
      'nodeSelector?': 'Record<string, string>',
      'tolerations?': type({
        'key?': 'string',
        'operator?': '"Exists" | "Equal"',
        'value?': 'string',
        'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
        'tolerationSeconds?': 'number',
      }).array(),
      'topologyKey?': 'string',
      'podAntiAffinityType?': '"preferred" | "required"',
    },
    'monitoring?': {
      'enabled?': 'boolean',
      'customQueriesConfigMap?': type({ name: 'string' }).array(),
      'podMonitorEnabled?': 'boolean',
    },
    'certificates?': {
      'serverCASecret?': 'string',
      'serverTLSSecret?': 'string',
      'clientCASecret?': 'string',
      'replicationTLSSecret?': 'string',
    },
    'externalClusters?': type({
      name: 'string',
      'connectionParameters?': 'Record<string, string>',
      'barmanObjectStore?': barmanObjectStoreSchemaShape,
      'password?': { name: 'string', key: 'string' },
    }).array(),
  },
});

// ============================================================================
// Backup Resource
// ============================================================================

/**
 * Configuration for an on-demand CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#BackupSpec
 */
export interface BackupConfig {
  /** Backup name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Resource ID for composition references. */
  id?: string;
  /** Backup specification. */
  spec: {
    /** Target cluster reference. Required. */
    cluster: LocalObjectReference;
    /** Backup method. */
    method?: 'barmanObjectStore' | 'volumeSnapshot' | 'plugin';
    /** Backup target. */
    target?: 'primary' | 'prefer-standby';
    /** Hot/cold backup for volume snapshots (default: true). */
    online?: boolean;
    /** Online backup configuration. */
    onlineConfiguration?: {
      immediateCheckpoint?: boolean;
      waitForArchive?: boolean;
    };
  };
}

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

/** ArkType schema for BackupConfig. */
export const BackupConfigSchema: Type<BackupConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    cluster: { name: 'string' },
    'method?': '"barmanObjectStore" | "volumeSnapshot" | "plugin"',
    'target?': '"primary" | "prefer-standby"',
    'online?': 'boolean',
    'onlineConfiguration?': {
      'immediateCheckpoint?': 'boolean',
      'waitForArchive?': 'boolean',
    },
  },
});

// ============================================================================
// ScheduledBackup Resource
// ============================================================================

/**
 * Configuration for a cron-scheduled CNPG backup.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#ScheduledBackupSpec
 */
export interface ScheduledBackupConfig {
  /** ScheduledBackup name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Resource ID for composition references. */
  id?: string;
  /** ScheduledBackup specification. */
  spec: {
    /** Target cluster reference. Required. */
    cluster: LocalObjectReference;
    /**
     * Cron expression with seconds (robfig/cron format).
     * Example: '0 0 2 * * *' = 2 AM daily. Required.
     */
    schedule: string;
    /** Backup method. */
    method?: 'barmanObjectStore' | 'volumeSnapshot' | 'plugin';
    /** Trigger first backup immediately on creation. */
    immediate?: boolean;
    /** Pause scheduled backups. */
    suspend?: boolean;
    /** Backup target. */
    target?: 'primary' | 'prefer-standby';
    /** Owner reference policy for created Backup resources. */
    backupOwnerReference?: 'none' | 'self' | 'cluster';
  };
}

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

/** ArkType schema for ScheduledBackupConfig. */
export const ScheduledBackupConfigSchema: Type<ScheduledBackupConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    cluster: { name: 'string' },
    schedule: 'string',
    'method?': '"barmanObjectStore" | "volumeSnapshot" | "plugin"',
    'immediate?': 'boolean',
    'suspend?': 'boolean',
    'target?': '"primary" | "prefer-standby"',
    'backupOwnerReference?': '"none" | "self" | "cluster"',
  },
});

// ============================================================================
// Pooler Resource
// ============================================================================

/** PgBouncer connection pooler configuration. */
export interface PgBouncerSpec {
  /** Pool mode: 'session' (default) or 'transaction'. */
  poolMode?: 'session' | 'transaction';
  /** Pause/resume connections. */
  paused?: boolean;
  /** PgBouncer parameters (pool_size, max_client_conn, etc.). */
  parameters?: Record<string, string>;
  /** Custom pg_hba rules. */
  pg_hba?: string[];
  /** Custom auth query. */
  authQuery?: string;
}

/**
 * Configuration for a CNPG PgBouncer connection pooler.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/#PoolerSpec
 */
export interface PoolerConfig {
  /** Pooler name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Resource ID for composition references. */
  id?: string;
  /** Pooler specification. */
  spec: {
    /** Target cluster reference. Required. */
    cluster: LocalObjectReference;
    /** Pooler type: 'rw' (read-write primary), 'ro' (read-only, any replica), 'r' (load-balanced across all standbys). */
    type?: 'rw' | 'ro' | 'r';
    /** Number of PgBouncer replicas (default: 1). */
    instances?: number;
    /** PgBouncer configuration. Required. */
    pgbouncer: PgBouncerSpec;
    /** Custom pod template. */
    template?: Record<string, unknown>;
    /** Deployment strategy. */
    deploymentStrategy?: Record<string, unknown>;
  };
}

/**
 * Observed status of a CNPG pooler.
 */
export interface PoolerStatus {
  /** Scheduled pod count. */
  instances?: number;
  /** Whether the pooler is ready. */
  ready?: boolean;
  /** Status conditions. */
  conditions?: ClusterCondition[];
}

/** ArkType schema for PoolerConfig. */
export const PoolerConfigSchema: Type<PoolerConfig> = type({
  name: 'string',
  'namespace?': 'string',
  'id?': 'string',
  spec: {
    cluster: { name: 'string' },
    'type?': '"rw" | "ro" | "r"',
    'instances?': 'number',
    pgbouncer: {
      'poolMode?': '"session" | "transaction"',
      'paused?': 'boolean',
      'parameters?': 'Record<string, string>',
      'pg_hba?': 'string[]',
      'authQuery?': 'string',
    },
  },
});

// ============================================================================
// Helm Integration Types
// ============================================================================

/** Configuration for the CNPG Helm chart repository. */
export interface CnpgHelmRepositoryConfig {
  /** Repository name (default: 'cnpg-repo'). */
  name?: string;
  /** Namespace for the HelmRepository (default: flux-system). */
  namespace?: string;
  /** Repository URL (default: 'https://cloudnative-pg.github.io/charts'). */
  url?: string;
  /** Sync interval (default: '5m'). */
  interval?: string;
  /** Resource ID for composition references. */
  id?: string;
}

/** Configuration for the CNPG Helm release. */
export interface CnpgHelmReleaseConfig {
  /** Release name. */
  name: string;
  /** Target namespace. */
  namespace?: string;
  /** Chart version (default: '0.23.0'). */
  version?: string;
  /** Helm values. */
  values?: Record<string, unknown>;
  /** HelmRepository name to reference (default: 'cnpg-repo'). */
  repositoryName?: string;
  /** Resource ID for composition references. */
  id?: string;
}
