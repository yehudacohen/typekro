/**
 * CloudNativePG (CNPG) Type Definitions
 *
 * ArkType schemas as the single source of truth, with types inferred via
 * `typeof Schema.infer`. Status types remain as hand-written interfaces.
 *
 * @see https://cloudnative-pg.io/documentation/1.25/cloudnative-pg.v1/
 */

import { type } from 'arktype';

import type { TypeKroChartValue } from '../../core/types/common.js';
import type { HelmReleaseLifecycleOptions } from '../helm/types.js';
import {
  BARMAN_CLOUD_BUCKET_CONSTRAINT,
  BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT,
  BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT,
  BARMAN_CLOUD_PREFIX_CONSTRAINT,
  BARMAN_RETENTION_POLICY,
} from './utils/barman-cloud-constraints.js';

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
    'jobs?': 'number.integer',
    'immediateCheckpoint?': 'boolean',
  },
  'wal?': {
    'compression?': 'string',
    'maxParallel?': 'number.integer',
  },
  'tags?': 'Record<string, string>',
} as const;

/** Shared ArkType schema shape for Kubernetes tolerations. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number.integer',
} as const;

/**
 * A CNPG-I plugin a cluster uses (`spec.plugins[]` and `externalClusters[].plugin`). For the
 * Barman Cloud plugin, `parameters.barmanObjectName` names the `ObjectStore`.
 */
const pluginSchemaShape = {
  name: 'string',
  'enabled?': 'boolean',
  'isWALArchiver?': 'boolean',
  'parameters?': 'Record<string, string>',
} as const;

/** The plugin a `Backup` or `ScheduledBackup` with `method: 'plugin'` uses. */
const pluginConfigurationSchemaShape = {
  name: 'string',
  'parameters?': 'Record<string, string>',
} as const;

const ClusterPluginSchema = type(pluginSchemaShape);
const PluginConfigurationSchema = type(pluginConfigurationSchemaShape);

/** A `spec.plugins[]` entry of a `Cluster`. */
export type ClusterPlugin = typeof ClusterPluginSchema.infer;

/** `pluginConfiguration` of a `Backup` or `ScheduledBackup`. */
export type PluginConfiguration = typeof PluginConfigurationSchema.infer;

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
  /** Chart version (default: `CNPG_CHART_VERSION`, '0.29.2', operator 1.30.2). */
  'version?': 'string',
  /** Whether to install CRDs with the chart (default: true). */
  'installCRDs?': 'boolean',
  /** Number of operator controller replicas (default: 1). */
  'replicaCount?': 'number.integer',
  /** Monitoring configuration. */
  'monitoring?': { 'enabled?': 'boolean' },
  /** Operator pod resources. */
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
  /** Additional Helm values for user overrides. */
  'customValues?': 'Record<string, unknown>',
  /**
   * Whether the operator install should be treated as shared cluster
   * infrastructure (default: `true`). When `true`, the Namespace,
   * HelmRepository, and HelmRelease are tagged with
   * `scopes: ['cluster']` so `factory.deleteInstance()` will NOT
   * remove them — multiple consumers (e.g., many `webAppWithProcessing`
   * deployments) can converge on the same operator install. Set to
   * `false` for dedicated per-instance operators (e.g., isolated
   * multi-tenancy or version testing).
   */
  'shared?': 'boolean',
});

/** Configuration for installing the CloudNativePG operator via Helm. */
export type CnpgBootstrapConfig = typeof CnpgBootstrapConfigSchema.infer;

/**
 * Observed status of a CloudNativePG operator deployment.
 */
export interface CnpgBootstrapStatus {
  /** Overall deployment phase (derived from HelmRelease Ready condition). */
  phase: 'Ready' | 'Installing' | 'Failed';
  /** Whether the operator is ready to manage clusters. */
  ready: boolean;
  /** Whether the HelmRelease Ready condition is explicitly False. */
  failed: boolean;
  /** Deployed chart version. */
  version?: string;
}

/** ArkType schema for CnpgBootstrapStatus. */
export const CnpgBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing" | "Failed"',
  ready: 'boolean',
  failed: 'boolean',
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
    'instances?': 'number.integer',
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
      /**
       * In-tree Barman object store configuration. Deprecated by CloudNativePG since 1.26 and
       * removed in 1.32.0: use the Barman Cloud plugin (`plugins` with an `ObjectStore`).
       */
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
    /**
     * CNPG-I plugins, such as the Barman Cloud plugin for WAL archiving and base backups. See
     * `barmanCloudPlugin()`.
     */
    'plugins?': ClusterPluginSchema.array(),
    /**
     * Metadata for the service account CNPG creates for the cluster (named after it). For IRSA,
     * annotate it with `eks.amazonaws.com/role-arn`; EKS Pod Identity needs no annotation.
     */
    'serviceAccountTemplate?': {
      metadata: {
        'annotations?': 'Record<string, string>',
        'labels?': 'Record<string, string>',
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
      /** In-tree Barman object store for backup-based recovery. Deprecated; see `plugin`. */
      'barmanObjectStore?': barmanObjectStoreSchemaShape,
      /** A plugin that serves this source, such as the Barman Cloud plugin for recovery. */
      'plugin?': pluginSchemaShape,
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

/** An `externalClusters[]` entry of a `Cluster`. */
export type ClusterExternalCluster = NonNullable<ClusterConfig['spec']['externalClusters']>[number];

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
    /** The plugin that takes the backup; required with `method: 'plugin'`. */
    'pluginConfiguration?': pluginConfigurationSchemaShape,
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
    /** The plugin that takes the backups; required with `method: 'plugin'`. */
    'pluginConfiguration?': pluginConfigurationSchemaShape,
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
    'instances?': 'number.integer',
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
  /** Chart version (default: `CNPG_CHART_VERSION`, '0.29.2', operator 1.30.2). */
  'version?': 'string',
  /** Helm values. */
  'values?': 'Record<string, unknown>',
  /** HelmRepository name to reference (default: 'cnpg-repo'). */
  'repositoryName?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/** Configuration for the CNPG Helm release. */
export type CnpgHelmReleaseConfig = Omit<typeof CnpgHelmReleaseConfigSchema.infer, 'values'> &
  HelmReleaseLifecycleOptions & {
    /**
     * Graph-aware Helm values serialized recursively by TypeKro. Accepts a
     * whole-object schema reference or a runtime values-merge node so per-instance
     * overrides survive KRO serialization instead of being enumerated at build
     * time (issue #190).
     */
    values?: TypeKroChartValue<Record<string, unknown>>;
  };

// ============================================================================
// Barman Cloud Plugin: ObjectStore
// ============================================================================

/**
 * S3 credentials of an `ObjectStore`, workload identity only: barman-cloud uses the IAM role
 * of the cluster's service account (IRSA or EKS Pod Identity). There are no fields for access
 * keys, and `objectStore()` refuses them at runtime too.
 */
export interface BarmanCloudS3WorkloadIdentity {
  inheritFromIAMRole: true;
}

/**
 * `spec.configuration` of an `ObjectStore` for S3. The schema is the in-tree
 * `BarmanObjectStoreConfiguration`, narrowed to S3 with workload identity.
 *
 * @see https://cloudnative-pg.io/plugin-barman-cloud/docs/plugin-barman-cloud.v1/
 */
export interface BarmanCloudS3Configuration {
  /** `s3://<bucket>/<prefix>`; both parts non-empty. The plugin adds `/<serverName>/`. */
  destinationPath: string;
  s3Credentials: BarmanCloudS3WorkloadIdentity;
  /** An S3-compatible endpoint; omit for AWS S3. */
  endpointURL?: string;
  /** Secret key holding the CA bundle for `endpointURL`. */
  endpointCA?: SecretKeyRef;
  s3AddressingStyle?: 'auto' | 'virtual' | 'path';
  wal?: {
    compression?: 'bzip2' | 'gzip' | 'lz4' | 'snappy' | 'xz' | 'zstd';
    encryption?: 'AES256' | 'aws:kms';
    maxParallel?: number;
  };
  data?: {
    compression?: 'bzip2' | 'gzip' | 'lz4' | 'snappy' | 'zstd';
    encryption?: 'AES256' | 'aws:kms';
    jobs?: number;
    immediateCheckpoint?: boolean;
  };
  /** Tags on the backup files. */
  tags?: Record<string, string>;
  /** Tags on the history files. */
  historyTags?: Record<string, string>;
}

/** `spec` of a Barman Cloud `ObjectStore`. */
export interface ObjectStoreSpec {
  configuration: BarmanCloudS3Configuration;
  /** How long base backups and WAL are kept, such as `30d`, `4w` or `6m`. */
  retentionPolicy?: string;
  /** Settings of the plugin sidecar in every instance pod that uses this store. */
  instanceSidecarConfiguration?: {
    resources?: ResourceRequirements;
    /** Seconds between retention policy runs. @default 1800 */
    retentionPolicyIntervalSeconds?: number;
    logLevel?: 'error' | 'warning' | 'info' | 'debug' | 'trace';
    /**
     * Environment of the sidecar. Static AWS keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
     * `AWS_SESSION_TOKEN`) are refused.
     */
    env?: Array<{ name: string; value?: string; valueFrom?: Record<string, unknown> }>;
  };
}

/** The recovery window the plugin records per server name. */
export interface ObjectStoreRecoveryWindow {
  firstRecoverabilityPoint?: string;
  lastSuccessfulBackupTime?: string;
  lastFailedBackupTime?: string;
}

/**
 * Observed status of an `ObjectStore`. The plugin reports no conditions, only each server's
 * recovery window once it has taken backups.
 */
export interface ObjectStoreStatus {
  serverRecoveryWindow?: Record<string, ObjectStoreRecoveryWindow>;
}

export interface ObjectStoreConfig {
  name: string;
  namespace?: string;
  spec: ObjectStoreSpec;
  id?: string;
}

// ============================================================================
// Barman Cloud Plugin: Helm and compositions
// ============================================================================

export interface BarmanCloudPluginHelmReleaseConfig extends HelmReleaseLifecycleOptions {
  name: string;
  /** Namespace of the release and the plugin: the CloudNativePG operator's namespace. */
  namespace?: string;
  /**
   * Version of the CloudNativePG operator running in that namespace, such as `1.30.2`. Required:
   * the plugin needs `BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION` or later, and an older one is
   * refused (`CNPG_BARMAN_CLOUD_OPERATOR_INCOMPATIBLE`).
   */
  operatorVersion: string;
  /** Chart version. @default BARMAN_CLOUD_PLUGIN_CHART_VERSION */
  version?: string;
  /** HelmRepository name. @default 'cnpg-repo' */
  repositoryName?: string;
  /**
   * Extra chart values. `crds.create` and `service.name` belong to the factory: a concrete value
   * that changes them is refused, and they are applied last over values only known per instance.
   */
  values?: TypeKroChartValue<Record<string, unknown>>;
  id?: string;
}

/** A DNS-1123 label, such as a namespace or a cluster name. */
const dnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');

/**
 * Inputs of `barmanCloudPluginBootstrap`, which installs the plugin from its official chart.
 * `namespace` must be the CloudNativePG operator's namespace. `version` is required and may only
 * be the pinned chart version, `BARMAN_CLOUD_PLUGIN_CHART_VERSION`. `operatorVersion` is required
 * and must be a CloudNativePG version the plugin supports (1.30.0 or later).
 */
export const BarmanCloudPluginBootstrapConfigSchema = type({
  /** Release name. */
  name: dnsLabel,
  /** The CloudNativePG operator's namespace. @default 'cnpg-system' */
  'namespace?': dnsLabel,
  /** The pinned chart version, `BARMAN_CLOUD_PLUGIN_CHART_VERSION`. */
  version: BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT.type,
  /**
   * Version of the CloudNativePG operator in `namespace`, such as `1.30.2`; 1.30.0 or later.
   * `cnpgBootstrap` installs `CNPG_OPERATOR_VERSION` by default.
   */
  operatorVersion: BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT.type,
  /** Extra chart values over the chart defaults; `crds.create` and `service.name` are fixed. */
  'values?': 'Record<string, unknown>',
});

export type BarmanCloudPluginBootstrapConfig = typeof BarmanCloudPluginBootstrapConfigSchema.infer;

export const BarmanCloudPluginBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing" | "Failed"',
  ready: 'boolean',
  failed: 'boolean',
  version: 'string',
});

export type BarmanCloudPluginBootstrapStatus = typeof BarmanCloudPluginBootstrapStatusSchema.infer;

/**
 * Inputs of `cnpgS3BackedCluster`: a `Cluster` archiving WAL and base backups through the
 * Barman Cloud plugin to `s3://<bucket>/<prefix>/<name>/`, and a `ScheduledBackup`.
 *
 * There are no credential inputs. barman-cloud runs in the instance pods as the cluster's
 * service account, which CNPG names after the cluster: bind an IAM role to it with an EKS Pod
 * Identity association, or with IRSA through `serviceAccountAnnotations`.
 */
export const CnpgS3BackedClusterConfigSchema = type({
  /** Cluster name; also the server name in the bucket. */
  name: dnsLabel,
  /** Namespace of the cluster, its ObjectStore and its ScheduledBackup. */
  namespace: dnsLabel,
  /** Number of PostgreSQL instances. */
  instances: 'number.integer >= 1',
  /** Volume size of each instance, such as `20Gi`. */
  storageSize: 'string > 0',
  bucket: BARMAN_CLOUD_BUCKET_CONSTRAINT.type,
  prefix: BARMAN_CLOUD_PREFIX_CONSTRAINT.type,
  /** Six-field cron schedule of base backups, such as `0 0 2 * * *`. */
  schedule: 'string > 0',
  /** @default '30d' */
  'retentionPolicy?': type(BARMAN_RETENTION_POLICY),
  /** Annotations on the cluster's service account, such as `eks.amazonaws.com/role-arn`. */
  'serviceAccountAnnotations?': 'Record<string, string>',
});

export type CnpgS3BackedClusterConfig = typeof CnpgS3BackedClusterConfigSchema.infer;

export const CnpgS3BackedClusterStatusSchema = type({
  ready: 'boolean',
  clusterReady: 'boolean',
  walArchiving: 'boolean',
});

export type CnpgS3BackedClusterStatus = typeof CnpgS3BackedClusterStatusSchema.infer;
