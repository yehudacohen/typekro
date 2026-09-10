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
import type { TypeKroChartValue } from '../../core/types/common.js';

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
  /**
   * Additional Helm values for user overrides. Works in BOTH modes:
   * a concrete object is deep-merged into the mapped values at build time,
   * and a schema reference (`customValues: schema.spec.customValues` in an
   * outer composition) is carried through the graph-aware runtime values
   * merge, so the override lands in the KRO-serialized HelmRelease values.
   */
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
  phase: 'Ready' | 'Installing' | 'Failed';
  /** Whether the operator is ready to manage installations. */
  ready: boolean;
  /** Whether the HelmRelease Ready condition is explicitly False. */
  failed: boolean;
  /** Deployed chart version. */
  version?: string;
}

/** ArkType schema for ClickHouseOperatorBootstrapStatus. */
export const ClickHouseOperatorBootstrapStatusSchema = type({
  phase: '"Ready" | "Installing" | "Failed"',
  ready: 'boolean',
  failed: 'boolean',
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
export type ClickHouseHelmRepositoryConfig = typeof ClickHouseHelmRepositoryConfigSchema.infer;

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
  /** Helm values (plain object, or a graph-aware runtime values merge). */
  'values?': 'object',
  /** HelmRepository name to reference (default: 'altinity'). */
  'repositoryName?': 'string',
  /** Resource ID for composition references. */
  'id?': 'string',
});

/**
 * Configuration for the altinity-clickhouse-operator Helm release.
 *
 * `values` is widened beyond the ArkType inference so a graph-aware
 * {@link TypeKroChartValue} (including a runtime values-merge expression
 * produced when `customValues` is a schema ref) flows through to the
 * underlying `helmRelease` factory.
 */
export type ClickHouseOperatorHelmReleaseConfig = Omit<
  typeof ClickHouseOperatorHelmReleaseConfigSchema.infer,
  'values'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
};

// ============================================================================
// Storage: PVC (default) vs S3-backed object storage
//
// SCHEMA-FIRST. Every shape below is an ArkType schema whose TypeScript type
// is INFERRED from it (`typeof X.infer`), so the S3 configuration is described
// exactly once. The two invariants that are not expressible as a shape —
// "exactly one credential transport" and "an AWS region or a custom endpoint,
// never neither" — are encoded IN the schemas (an `undefined` sibling on each
// auth branch, and a `.narrow()` on the S3 branch), so an invalid literal is
// rejected by the type AND by runtime validation rather than only by a factory
// guard several calls deeper.
// ============================================================================

/**
 * IRSA credential transport for the S3 disk.
 *
 * The factory creates (or annotates) a ServiceAccount with
 * `eks.amazonaws.com/role-arn` and runs the CHI pod template as it; the
 * rendered disk configuration then uses
 * `<use_environment_credentials>true</use_environment_credentials>` so the AWS
 * SDK inside ClickHouse picks up the projected web-identity token. NO key
 * material appears in any manifest.
 *
 * `secretRef?: 'undefined'` is the exclusivity half of the contract: it makes
 * `{ irsa, secretRef }` fail the union instead of silently matching this
 * branch (ArkType object schemas allow unknown extra keys).
 */
export const ClickHouseS3IrsaAuthSchema = type({
  irsa: {
    /** IAM role ARN the ServiceAccount assumes (see the docs for the policy). */
    roleArn: 'string > 0',
    /**
     * ServiceAccount name (default: `<installation-name>-s3`). Supply an
     * existing name to reuse a ServiceAccount managed elsewhere — the
     * composition then annotates its own copy of it.
     */
    'serviceAccountName?': 'string > 0',
  },
  'secretRef?': 'undefined',
});

/** IRSA credential transport (see {@link ClickHouseS3IrsaAuthSchema}). */
export type ClickHouseS3IrsaAuth = typeof ClickHouseS3IrsaAuthSchema.infer;

/**
 * Secret-backed access-key credential transport for the S3 disk.
 *
 * The keys are wired as pod env vars via `secretKeyRef` and referenced from
 * the disk configuration with ClickHouse's `from_env` attribute, so the key
 * VALUES never enter the CHI spec. Inline keys are not accepted at all.
 */
export const ClickHouseS3SecretRefAuthSchema = type({
  secretRef: {
    /** Secret name in the CHI namespace. */
    name: 'string > 0',
    /** Key holding the access key id (default: 'AWS_ACCESS_KEY_ID'). */
    'accessKeyIdKey?': 'string > 0',
    /** Key holding the secret access key (default: 'AWS_SECRET_ACCESS_KEY'). */
    'secretAccessKeyKey?': 'string > 0',
  },
  'irsa?': 'undefined',
});

/** Secret-backed transport (see {@link ClickHouseS3SecretRefAuthSchema}). */
export type ClickHouseS3SecretRefAuth = typeof ClickHouseS3SecretRefAuthSchema.infer;

/**
 * Exactly one S3 credential transport — never inline keys.
 *
 * The union is discriminated by which key is present, and each branch pins the
 * other to `undefined`, so "both" and "neither" are both schema errors.
 */
export const ClickHouseS3AuthSchema = ClickHouseS3IrsaAuthSchema.or(
  ClickHouseS3SecretRefAuthSchema
);

/** Exactly one S3 credential transport (see {@link ClickHouseS3AuthSchema}). */
export type ClickHouseS3Auth = typeof ClickHouseS3AuthSchema.infer;

/**
 * ClickHouse credentials the backup CronJob connects with. Omit to connect as
 * `default` with no password (the dev-first single-node default).
 */
const clickHouseS3BackupAuthShape = {
  secretRef: {
    name: 'string > 0',
    /** Key holding the ClickHouse user name (default: 'username'). */
    'usernameKey?': 'string > 0',
    /** Key holding the ClickHouse password (default: 'password'). */
    'passwordKey?': 'string > 0',
  },
} as const;

/**
 * Scheduled `BACKUP ... TO S3(...)` options.
 *
 * This is the durability story for `diskType: 's3'`, where part METADATA lives
 * on the local disk and the bucket alone cannot be reattached. It is optional
 * (and largely redundant) for `s3_plain_rewritable`.
 */
export const ClickHouseS3BackupOptionsSchema = type({
  /** Cron schedule for the backup CronJob (e.g. '0 2 * * *'). */
  schedule: 'string > 0',
  /** Backup bucket (default: the data disk's bucket). */
  'bucket?': 'string > 0',
  /** Backup key prefix (default: 'backups'); must not be the bucket root. */
  'prefix?': 'string > 0',
  /** Database to back up (default: 'default'). */
  'database?': 'string > 0',
  /**
   * Age-based pruning. Rendered as a real prune step in the CronJob (an
   * `aws s3 rm` pass over expired timestamped backup prefixes) — not an
   * accepted-but-ignored hint, and not a substitute for a bucket lifecycle
   * policy if you prefer to own expiry in AWS.
   */
  'retention?': { days: 'number.integer > 0' },
  /** ClickHouse credentials the CronJob connects with. */
  'auth?': clickHouseS3BackupAuthShape,
});

/** Scheduled backup options (see {@link ClickHouseS3BackupOptionsSchema}). */
export type ClickHouseS3BackupOptions = typeof ClickHouseS3BackupOptionsSchema.infer;

/**
 * The `region`-or-`endpoint` requirement, as one message shared by every
 * schema that carries the S3 branch.
 *
 * It is a `.narrow()` rather than a shape because either field alone is
 * sufficient: `region` composes `https://<bucket>.s3.<region>.amazonaws.com/`,
 * `endpoint` points at an S3-compatible service, and neither leaves the
 * factory no endpoint to compose at all.
 */
export const S3_TARGET_REQUIREMENT =
  "an S3 target: set 'region' for AWS S3, or 'endpoint' for an S3-compatible " +
  'service such as MinIO (at least one is required)';

/**
 * The object-storage half of the S3 branch, shared by the build-time topology
 * and the installation `storage` input so the two can never drift.
 *
 * BUILD-TIME: every field here compiles into a `storage_configuration` XML
 * document and selects which resources exist (ServiceAccount, backup
 * CronJob), so it is fixed at construction time. Only the thin local volume
 * sizing (`size` / `storageClassName`) stays runtime spec.
 */
const clickHouseS3StorageShape = {
  /** Discriminator selecting object-storage mode. */
  mode: '"s3"',
  /** Bucket name (the factory builds the endpoint from it). */
  bucket: 'string > 0',
  /** Key prefix inside the bucket (default: the bucket root). */
  'prefix?': 'string',
  /** AWS region — required unless `endpoint` is set. */
  'region?': 'string > 0',
  /**
   * Base URL of a custom S3-compatible service (MinIO, Ceph RGW), e.g.
   * `http://minio.minio.svc.cluster.local:9000`. Bucket and prefix are
   * appended path-style by the factory; do not include them here.
   */
  'endpoint?': 'string > 0',
  /**
   * Disk type — the DURABILITY choice, deliberately not a boolean:
   * - `'s3'` (default): part metadata on the local disk. Fast and
   *   fully-featured, but the bucket is not self-describing — durability comes
   *   from `backup`.
   * - `'s3_plain_rewritable'`: metadata in the bucket, so node loss is a
   *   restart + reattach. Requires ClickHouse >= 24.5, a SINGLE replica, and
   *   no mutations (see the module docs on `utils/s3-storage.ts`).
   */
  'diskType?': '"s3" | "s3_plain_rewritable"',
  /** Local read-through cache in front of the object-storage disk. */
  cache: {
    /** Cache cap as a Kubernetes quantity; must fit inside `storage.size`. */
    size: 'string > 0',
    /** Cache directory (default: '/var/lib/clickhouse/disks/s3_cache/'). */
    'path?': 'string > 0',
  },
  /** MergeTree storage policy name (default: 's3_main'). */
  'policyName?': 'string > 0',
  /** S3 credentials — IRSA or a Secret reference. */
  auth: ClickHouseS3AuthSchema,
  /** Optional scheduled backups with a documented restore path. */
  'backup?': ClickHouseS3BackupOptionsSchema,
} as const;

/**
 * S3-backed storage options — object storage as the durable record, with only
 * a bounded local read-through cache on the node.
 */
export const ClickHouseS3StorageOptionsSchema = type(clickHouseS3StorageShape).narrow(
  (storage, ctx) =>
    storage.region !== undefined ||
    storage.endpoint !== undefined ||
    ctx.mustBe(S3_TARGET_REQUIREMENT)
);

/** S3-backed storage options (see {@link ClickHouseS3StorageOptionsSchema}). */
export type ClickHouseS3StorageOptions = typeof ClickHouseS3StorageOptionsSchema.infer;

/** PVC-backed storage — today's behaviour, and still the default. */
export const ClickHousePvcStorageOptionsSchema = type({
  /** Discriminator; omit for the PVC default. */
  'mode?': '"pvc"',
});

/** PVC-backed storage (see {@link ClickHousePvcStorageOptionsSchema}). */
export type ClickHousePvcStorageOptions = typeof ClickHousePvcStorageOptionsSchema.infer;

/**
 * BUILD-TIME storage topology accepted by {@link makeClickHouseCluster}.
 *
 * `mode: 'pvc'` (or omitting `storage` entirely) is the default and preserves
 * existing behaviour byte for byte.
 */
export const ClickHouseStorageTopologySchema = ClickHousePvcStorageOptionsSchema.or(
  ClickHouseS3StorageOptionsSchema
);

/** BUILD-TIME storage topology (see {@link ClickHouseStorageTopologySchema}). */
export type ClickHouseStorageTopology = typeof ClickHouseStorageTopologySchema.infer;

/** Local volume sizing — present in BOTH storage modes. */
const clickHouseLocalVolumeShape = {
  /**
   * Volume size (e.g. '100Gi').
   *
   * In PVC mode this is the MergeTree data volume. In S3 mode it is the thin
   * local volume mounted at `/var/lib/clickhouse`, which holds server
   * metadata, the read-through cache, and — for `diskType: 's3'` — part
   * metadata; size it for the cache, not for the dataset.
   */
  size: 'string > 0',
  /**
   * StorageClass name. On EKS this should be a WaitForFirstConsumer +
   * `allowVolumeExpansion: true` gp3 class so the PVC binds in the zone the
   * scheduler places the pod (and can grow in place).
   */
  'storageClassName?': 'string > 0',
} as const;

/** Local volume sizing — present in BOTH storage modes. */
export const ClickHouseLocalVolumeOptionsSchema = type(clickHouseLocalVolumeShape);

/** Local volume sizing (see {@link ClickHouseLocalVolumeOptionsSchema}). */
export type ClickHouseLocalVolumeOptions = typeof ClickHouseLocalVolumeOptionsSchema.infer;

/**
 * The `storage` input accepted by `clickHouseInstallation()`: local volume
 * sizing plus, in S3 mode, the full object-storage configuration.
 *
 * This is the COMPLETE description — the S3 branch is modelled field by field
 * rather than widened onto the schema afterwards, so
 * {@link ClickHouseInstallationConfig} can be inferred straight from
 * {@link ClickHouseInstallationConfigSchema}.
 */
export const ClickHouseInstallationStorageSchema = type({
  ...clickHouseLocalVolumeShape,
  /** Storage mode discriminator (default: 'pvc'). */
  'mode?': '"pvc"',
}).or(
  type({ ...clickHouseLocalVolumeShape, ...clickHouseS3StorageShape }).narrow(
    (storage, ctx) =>
      storage.region !== undefined ||
      storage.endpoint !== undefined ||
      ctx.mustBe(S3_TARGET_REQUIREMENT)
  )
);

/** The `storage` input (see {@link ClickHouseInstallationStorageSchema}). */
export type ClickHouseInstallationStorage = typeof ClickHouseInstallationStorageSchema.infer;

// ============================================================================
// ClickHouseInstallation (CHI) Resource
// ============================================================================

/**
 * ArkType schema for a single ClickHouse user entry.
 *
 * ARRAY shape (not a name-keyed map): user NAMES become CHI configuration
 * PATH FRAGMENTS (`<user>/password_sha256_hex`), so they must be concrete
 * strings at build time — a map keyed by schema proxies would serialize its
 * keys as `__typekroSchemaKey/...` garbage. The array shape keeps names in a
 * plain value position where the factory can validate them loudly, while
 * `passwordSha256Hex`/`networksIp` are ordinary VALUES and may be schema
 * references or CEL expressions.
 */
export const ClickHouseUserSchema = type({
  /** User name — becomes a CHI config path fragment; MUST be concrete. */
  name: 'string',
  /** SHA256 hex digest of the user password (value position — refs OK). */
  'passwordSha256Hex?': 'string',
  /**
   * Secret-backed plaintext password. The Altinity operator resolves this
   * reference without copying credential material into the CHI spec.
   * Mutually exclusive with `passwordSha256Hex`.
   */
  'passwordSecretRef?': {
    name: 'string > 0',
    key: 'string > 0',
  },
  /** Allowed source networks, e.g. ['::/0'] (value position — refs OK). */
  'networksIp?': 'string[]',
});

/** A single ClickHouse user entry (see {@link ClickHouseUserSchema}). */
export type ClickHouseUser = typeof ClickHouseUserSchema.infer;

/**
 * ArkType schema for ClickHouseInstallationConfig.
 *
 * HIGH-LEVEL configuration compiled by `clickHouseInstallation()` into a
 * `clickhouse.altinity.com/v1` ClickHouseInstallation (CHI) spec. This is
 * deliberately not a 1:1 CRD mirror: the typed factory exists to compile the
 * zone-pinning layout the operator cannot express natively (see
 * `utils/zone-layout.ts`).
 *
 * BUILD-TIME vs RUNTIME: `shards`, `replicas`, `zones`, and user NAMES are
 * BUILD-TIME fields — the compiler enumerates pod templates and per-replica
 * layout entries from them, so they must be concrete JS values (the factory
 * throws loudly if any receives a KubernetesRef/CEL expression). Everything
 * else (name, namespace, version, storage sizes, credentials, keeper host,
 * ...) sits in plain VALUE positions and may be schema references. For
 * schema-driven topology use `makeClickHouseCluster()`, which fixes the
 * topology at construction time and exposes only ref-safe runtime spec.
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
  'shards?': 'number.integer',
  /** Replicas per shard (default: 1). */
  'replicas?': 'number.integer',
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
  /**
   * Storage for ClickHouse data. Required.
   *
   * {@link ClickHouseInstallationStorageSchema} is the COMPLETE description: a
   * discriminated union on `mode` whose S3 branch models the object-storage
   * configuration field by field, with the credential-transport and
   * region-or-endpoint invariants encoded in the schema itself. Nothing about
   * `storage` is widened onto the inferred type afterwards.
   */
  storage: ClickHouseInstallationStorageSchema,
  /**
   * ClickHouse users (ARRAY shape), compiled to the operator's path-keyed
   * `spec.configuration.users` format
   * (`<user>/password_sha256_hex`, `<user>/networks/ip`).
   *
   * User NAMES become path fragments and must be concrete strings (the
   * factory throws on refs); password/networks values may be refs.
   */
  'users?': ClickHouseUserSchema.array(),
  /**
   * (ClickHouse) Keeper coordination endpoint, wired into
   * `spec.configuration.zookeeper.nodes` (the operator uses the zookeeper
   * section for clickhouse-keeper too). Required for replicated tables
   * when `replicas > 1`.
   */
  'keeper?': {
    host: 'string',
    /** Keeper client port (default: 2181). */
    'port?': 'number.integer',
  },
  /** ClickHouse server container resources. */
  'podResources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
});

/**
 * High-level configuration for a ClickHouseInstallation.
 *
 * INFERRED WHOLE from {@link ClickHouseInstallationConfigSchema} — including
 * `storage`, whose S3 branch the schema now models field by field. There is no
 * hand-written widening layer, so a field cannot exist in the type without
 * existing in the schema that validates it.
 */
export type ClickHouseInstallationConfig = typeof ClickHouseInstallationConfigSchema.infer;

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
// ClickHouse Cluster Composition (build-time topology + runtime spec)
// ============================================================================

/**
 * BUILD-TIME user declaration for {@link ClickHouseClusterTopology}.
 *
 * The user NAME becomes a CHI configuration path fragment
 * (`<name>/password_sha256_hex`) and the allowed networks are part of the
 * cluster's access topology — both are fixed at construction time. The
 * password hash is env-specific and flows through the RUNTIME spec
 * (`spec.users.<name>.passwordSha256Hex`), so it may be a schema reference.
 */
export interface ClickHouseClusterUserTopology {
  /** User name — becomes a CHI config path fragment AND a runtime spec key. */
  readonly name: string;
  /** Allowed source networks (default: ['::/0']). */
  readonly networksIp?: readonly string[];
  /** Runtime credential representation. Defaults to the legacy SHA256 form. */
  readonly credentialSource?: 'sha256' | 'secret';
}

/**
 * BUILD-TIME topology for {@link makeClickHouseCluster}.
 *
 * These are resolved when the composition is CONSTRUCTED (real JS values),
 * NOT KRO spec fields: the zone-pinned layout enumerates pod templates and
 * per-replica entries, so zones/replicas/shards cannot be instance-dynamic.
 * (Same pattern as `makeCaddyIngress` — build-time choices select the
 * resource set statically.)
 */
export interface ClickHouseClusterTopology {
  /**
   * Availability zones to pin replicas to (round-robin when
   * replicas > zones.length). WHY build-time AND why at all: EBS volumes are
   * zonal, and the operator's own `podDistribution` supports only the
   * `kubernetes.io/hostname` topologyKey (Altinity/clickhouse-operator#772),
   * so per-zone spreading must be compiled as an explicit per-replica layout.
   */
  readonly zones?: readonly string[];
  /** Replicas per shard (default: 1). */
  readonly replicas?: number;
  /** Shard count (default: 1). */
  readonly shards?: number;
  /**
   * Whether the cluster coordinates through (ClickHouse) Keeper. Structural:
   * it decides whether the CHI has a `zookeeper` section and whether the
   * runtime spec requires `keeper: { host }`. Default: `true` when
   * `replicas > 1` (replicated tables need coordination), else `false`.
   */
  readonly keeper?: boolean;
  /** Declared ClickHouse users (names/networks build-time, passwords runtime). */
  readonly users?: readonly ClickHouseClusterUserTopology[];
  /**
   * Storage topology (default: `{ mode: 'pvc' }` — today's behaviour).
   *
   * WHY build-time: the S3 branch compiles into a `storage_configuration` XML
   * document embedded in the CHI's `configuration.files` AND decides which
   * resources exist (the IRSA ServiceAccount, the backup CronJob). Both are
   * exactly the class of choice `zones` already occupies — a schema reference
   * there could only serialize as a `__KUBERNETES_REF__` marker inside server
   * configuration text, so the constructor rejects one loudly.
   *
   * The per-instance half stays in the runtime spec: `storage.size` and
   * `storage.storageClassName` size the thin local volume that hosts the
   * read-through cache.
   */
  readonly storage?: ClickHouseStorageTopology;
}

/** Runtime keeper connection spec (present iff the topology enables keeper). */
export interface ClickHouseClusterKeeperSpec {
  /** Keeper client host, e.g. `keeper-<chk>.<ns>.svc.cluster.local`. */
  host: string;
  /** Keeper client port (default: 2181 — the operator's KpDefaultZKPortNumber). */
  port?: number;
}

/** Runtime (proxy-safe) spec fields shared by every cluster topology. */
export interface ClickHouseClusterSpecBase {
  /** Installation name (CHI metadata.name). */
  name: string;
  /** Target namespace — explicit, it anchors the derived service hostnames. */
  namespace: string;
  /** ClickHouse server image tag, e.g. '25.12.5'. */
  version: string;
  /**
   * Logical cluster name inside the CHI (default: 'cluster').
   * SIGNOZ COMPATIBILITY: SigNoz's migrations hardcode `cluster`.
   */
  clusterName?: string;
  /**
   * Local volume for ClickHouse data.
   *
   * In the default PVC topology this is the MergeTree data volume. In an
   * S3-backed topology (`makeClickHouseCluster({ storage: { mode: 's3' } })`)
   * it is the thin local volume that hosts the read-through cache — the object
   * store holds the data.
   */
  storage: ClickHouseLocalVolumeOptions;
  /** ClickHouse server container resources. */
  podResources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

/**
 * Runtime spec for a cluster built by {@link makeClickHouseCluster}.
 *
 * `keeper` and `users` requiredness is enforced by the generated ArkType
 * schema (keeper required iff the topology enables it; one `users.<name>`
 * entry required per declared user) — the TS type keeps them optional-shaped
 * because the effective keeper default (`replicas > 1`) is a runtime value.
 */
export type ClickHouseClusterSpec = ClickHouseClusterSpecBase & {
  /** Keeper connection (required iff the topology enables keeper). */
  keeper?: ClickHouseClusterKeeperSpec;
  /** Per-declared-user runtime credentials, keyed by build-time user name. */
  users?: Record<
    string,
    { passwordSha256Hex: string } | { passwordSecretRef: { name: string; key: string } }
  >;
};

/**
 * Typed service contract exposed by {@link makeClickHouseCluster}.
 *
 * Connection details are DERIVED from the Altinity operator's actual naming
 * conventions so downstream compositions never reconstruct hostnames by hand
 * (verified against operator release-0.27.1 sources):
 * - CR-level Service: `clickhouse-{chi-name}`, type ClusterIP
 *   (`pkg/model/chi/namer/patterns.go` patternCRServiceName +
 *   `pkg/model/chi/creator/service.go`)
 * - per-host Services: `chi-{chi}-{cluster}-{shard}-{replica}`
 * - ports: native TCP 9000 / HTTP 8123
 *   (`pkg/apis/clickhouse.altinity.com/v1/type_host.go`
 *   ChDefaultTCPPortNumber / ChDefaultHTTPPortNumber)
 *
 * EVERY DECLARED FIELD IS OBSERVABLE THROUGH KRO. Fields derived from the
 * owned CHI serialize as KRO status CEL directly: `ready`, `phase`,
 * `clickhouse.host`, `clickhouse.nativeUrl`, `clickhouse.httpUrl`,
 * `clickhouse.clusterName`, `keeper.host`, `keeper.port`, `installation.*`.
 * The rest are CONSTRUCTION-TIME values with no natural CHI field to read —
 * `clickhouse.port`, `clickhouse.database`, `clickhouse.user`, and the whole
 * `storage` durability block. Rather than emit them as literals (which KRO
 * drops from the instance status, so the declared schema would promise fields
 * the live CR never carries), the composition writes them into a ConfigMap it
 * OWNS (`<installation>-contract`) and projects them back from that resource.
 * The result is that `kubectl get clickhouseclusters -o yaml` shows the whole
 * contract, durability included, in both factory modes.
 *
 * NOTE: operator health is NOT surfaced here — the operator is separate
 * one-per-cluster infrastructure installed by `clickhouseOperatorBootstrap`,
 * whose own status carries `ready`/`phase`/`version` for it.
 *
 * HYDRATION (bimodal — every field resolves in both factory modes): the metadata-anchored fields
 * `clickhouse.host`/`nativeUrl`/`httpUrl` and `installation.name`/`namespace`
 * are built with NATURAL JS template literals over the CHI resource proxy
 * (e.g. `` `clickhouse-${clickhouse.metadata.name}.${clickhouse.metadata.namespace}.svc.cluster.local` ``),
 * which resolve in BOTH factory modes on typekro >= 0.24.0 (the release that
 * carries the #97 resource-metadata-proxy fix):
 *   - `factory('kro')`: the imperative analyzer converts the template literals
 *     to KRO status CEL, and (#97) `clickhouse.metadata.*` resolves
 *     resource-anchored (`clickhouse.metadata.name`) rather than degrading to
 *     `schema.spec.name`, so they land on the live CR status for GitOps/KRO
 *     consumers.
 *   - `factory('direct')`: a template literal is plain JS, so direct mode's
 *     live-status re-execution evaluates it against the real resource values
 *     and hydrates a concrete string. (This replaced an earlier raw
 *     `Cel.expr("...literal CEL...")` workaround that was opaque to direct
 *     mode — the typekro#94 gap, root-caused and fixed in typekro#97.)
 * `ready`/`phase`/`installation.endpoint`/`hostsCount`/`hostsCompletedCount`
 * likewise hydrate in both modes (natural `clickhouse.status.*` reads / JS
 * comparisons).
 * The remaining resource-anchored fields — `clickhouse.clusterName`,
 * `keeper.host`, `keeper.port` — stay raw `Cel.expr` rather than natural
 * template literals for ERGONOMIC reasons: they are deep reads through
 * optional nested arrays (`configuration.clusters[0]` / `zookeeper.nodes[0]`)
 * where natural proxy access requires non-null assertions that add noise
 * without changing the output, and `keeper.port` additionally must stay a
 * number (a template literal would coerce it to a string). This is NOT a
 * hydration limitation: being resource-path CELs they resolve in BOTH modes —
 * status CEL in `factory('kro')`, and the cel-js reference resolver evaluates
 * them against the live CHI in `factory('direct')` (`clusterName` hydrates to
 * the concrete `'cluster'` in the direct-mode integration test).
 */
export interface ClickHouseClusterStatus {
  /** True once the operator reports the CHI fully reconciled ('Completed'). */
  ready: boolean;
  /** Reconcile phase mapped from the operator status state machine. */
  phase: 'Installing' | 'Ready' | 'Failed';
  /** ClickHouse connection contract for downstream compositions. */
  clickhouse: {
    /** CR-level service DNS name: `clickhouse-{name}.{namespace}.svc.cluster.local`. */
    host: string;
    /** Native protocol port (9000). */
    port: number;
    /** Native protocol URL: `clickhouse://{host}:9000`. */
    nativeUrl: string;
    /** HTTP interface URL: `http://{host}:8123`. */
    httpUrl: string;
    /** Logical cluster name (SigNoz needs `cluster`). */
    clusterName: string;
    /** Default database. */
    database: string;
    /** First declared user name, when the topology declares users. */
    user?: string;
  };
  /** Keeper connection echo (present iff the topology enables keeper). */
  keeper?: { host: string; port: number };
  /**
   * Storage contract — what the durability guarantee of this cluster actually
   * is, so consumers (and operators reading `kubectl get clickhousecluster`)
   * never have to infer it from the CHI's XML.
   *
   * PROJECTED FROM THE OWNED CONTRACT CONFIGMAP: these come from the
   * construction-time topology, not from the owned CHI, so the composition
   * writes them into a ConfigMap it owns (`<installation>-contract`) and reads
   * them back from there. That gives them a resource anchor, so — unlike a
   * bare literal, which KRO omits — they appear on the live KRO CR status.
   */
  storage: {
    /** 'pvc' (local MergeTree volume) or 's3' (object storage). */
    mode: 'pvc' | 's3';
    /** Object-storage disk type; absent in PVC mode. */
    diskType?: 's3' | 's3_plain_rewritable';
    /** Default MergeTree storage policy; absent in PVC mode. */
    policyName?: string;
    /** Bucket holding the durable record; absent in PVC mode. */
    bucket?: string;
    /**
     * Whether the bucket alone is enough to rebuild the cluster.
     * `true` only for `s3_plain_rewritable`; `diskType: 's3'` keeps part
     * metadata locally and therefore depends on `backupSchedule`.
     */
    selfDescribingBucket?: boolean;
    /** Cron schedule of the generated backup CronJob, when one exists. */
    backupSchedule?: string;
  };
  /** Raw installation identity + operator progress counters. */
  installation: {
    name: string;
    namespace: string;
    /** Operator-reported endpoint (present once reconciled). */
    endpoint?: string;
    hostsCount?: number;
    hostsCompletedCount?: number;
  };
}

/** ArkType schema for {@link ClickHouseClusterStatus}. */
export const ClickHouseClusterStatusSchema = type({
  ready: 'boolean',
  phase: '"Installing" | "Ready" | "Failed"',
  clickhouse: {
    host: 'string',
    port: 'number.integer',
    nativeUrl: 'string',
    httpUrl: 'string',
    clusterName: 'string',
    database: 'string',
    'user?': 'string',
  },
  'keeper?': { host: 'string', port: 'number.integer' },
  storage: {
    mode: '"pvc" | "s3"',
    'diskType?': '"s3" | "s3_plain_rewritable"',
    'policyName?': 'string',
    'bucket?': 'string',
    'selfDescribingBucket?': 'boolean',
    'backupSchedule?': 'string',
  },
  installation: {
    name: 'string',
    namespace: 'string',
    'endpoint?': 'string',
    'hostsCount?': 'number.integer',
    'hostsCompletedCount?': 'number.integer',
  },
});

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
  'replicas?': 'number.integer',
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
