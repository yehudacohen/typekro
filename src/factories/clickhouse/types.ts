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
  /** Persistent storage for ClickHouse data. */
  storage: {
    /** Volume size (e.g. '100Gi'). */
    size: string;
    /** StorageClass name (EKS: WaitForFirstConsumer + expandable gp3). */
    storageClassName?: string;
  };
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
  users?: Record<string, { passwordSha256Hex: string }>;
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
 * KRO STATUS vs CLIENT-HYDRATED SPLIT: fields derived from the owned CHI
 * resource serialize as KRO status CEL and appear on the live KRO CR's
 * status (GitOps/KRO consumers can read them):
 * `ready`, `phase`, `clickhouse.host`, `clickhouse.nativeUrl`,
 * `clickhouse.httpUrl`, `clickhouse.clusterName`, `keeper.host`,
 * `keeper.port`, `installation.*`.
 * The remaining fields are BARE build-time constants with no resource
 * anchor (KRO status CEL cannot reference schema.spec.* or literals-only
 * expressions), so they are hydrated CLIENT-SIDE by TypeKro and are NOT on
 * the KRO CR status: `clickhouse.port` (9000 — also visible inside the
 * KRO-serialized `nativeUrl`), `clickhouse.database` ('default'), and
 * `clickhouse.user` (first declared user name).
 *
 * NOTE: operator health is NOT surfaced here — the operator is separate
 * one-per-cluster infrastructure installed by `clickhouseOperatorBootstrap`,
 * whose own status carries `ready`/`phase`/`version` for it.
 *
 * `factory('direct')` LIMITATION (live-verified): the resource-anchored fields above are built via
 * a raw `Cel.expr("...")` string over the CHI's `metadata`/`spec` (required — plain proxy access on
 * `.metadata.*` is misclassified as schema-derived and dropped from KRO status entirely). That
 * technique fixes `factory('kro')` reachability but is opaque to direct mode's live-status
 * re-execution, which has no CEL interpreter and can only hydrate fields it evaluates as plain JS
 * against the live resource. So in DIRECT MODE ONLY, `clickhouse.host`/`nativeUrl`/`httpUrl`/
 * `clusterName`, `keeper.host`/`port`, and `installation.name`/`namespace` remain unresolved
 * `CelExpression` markers (`isCelExpression(value)` is `true`) — a narrow typekro gap, not something
 * this factory can paper over (tracked: typekro#94, "status derivations via the resources proxy
 * silently degrade to schema refs"). **UPDATE:** the root cause is fixed in
 * [typekro#97](https://github.com/yehudacohen/typekro/pull/97) (resource `.metadata.*` reads
 * inside status builders no longer silently degrade to schema refs); once that lands and this
 * factory bumps its typekro dependency, the raw `Cel.expr` workaround above can be dropped in
 * favor of natural proxy syntax, and these fields will hydrate correctly in BOTH modes.
 * `ready`/`phase`/`installation.endpoint`/`hostsCount`/
 * `hostsCompletedCount` DO hydrate in direct mode (plain `clickhouse.status.*` property access).
 * `factory('kro')` callers always get the full live contract on the CR status. Direct-mode callers
 * needing the connection string can build it themselves — same naming rule, from `spec.name`/
 * `spec.namespace`, which they already have synchronously.
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
    port: 'number',
    nativeUrl: 'string',
    httpUrl: 'string',
    clusterName: 'string',
    database: 'string',
    'user?': 'string',
  },
  'keeper?': { host: 'string', port: 'number' },
  installation: {
    name: 'string',
    namespace: 'string',
    'endpoint?': 'string',
    'hostsCount?': 'number',
    'hostsCompletedCount?': 'number',
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
