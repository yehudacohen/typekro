/**
 * ClickStack (HyperDX) Type Definitions
 *
 * ArkType schemas as the single source of truth for config shapes, with types
 * inferred via `typeof Schema.infer` (mirrors the clickhouse/dagster families).
 *
 * Wraps the OFFICIAL ClickStack Helm chart (MIT):
 * - Chart: `clickstack` 3.0.x from https://clickhouse.github.io/ClickStack-helm-charts
 *   (classic Helm repo, NOT OCI). The old hyperdxio/helm-charts repo is archived
 *   and its `hdx-oss-v2` chart is deprecated — do not use them.
 * - Components: the HyperDX app (UI + API + OpAMP server on 4320 that remotely
 *   configures the collector), an OTel gateway collector (the chart's only Helm
 *   dependency: the official `opentelemetry-collector` subchart, alias
 *   `otel-collector`), and schema "goose" migrations run by the collector at
 *   startup that auto-create `otel_logs` / `otel_traces` / `otel_metrics_*` /
 *   `hyperdx_sessions`.
 *
 * EXTERNAL CLICKHOUSE ONLY: this family hard-codes `clickhouse.enabled: false`
 * and `mongodb.enabled: false`. The chart's bundled ClickHouse/Keeper and
 * MongoDB are CRDs owned by the separate `clickstack-operators` prerequisite
 * chart (ClickHouse Inc.'s own operator + a MongoDB community operator), which
 * we deliberately do NOT install — its ClickHouse CRDs would collide with the
 * Altinity clickhouse-operator that manages our ClickHouseInstallation.
 *
 * BUILD-TIME vs RUNTIME SPLIT: choices that decide WHICH resources exist or
 * how values trees are shaped (the Mongo mode, internal-Mongo storage, static
 * raw chart values) are CONSTRUCTION-time options on
 * `makeClickstackBootstrap(...)` / `makeClickstackK8sTelemetry(...)` — plain
 * JS branches on them are safe because they are always concrete. The runtime
 * spec (these schemas) carries only proxy-safe VALUES (names, namespaces,
 * endpoints, versions, credentials) that serialize cleanly as CEL refs in KRO
 * mode.
 *
 * SCHEMA / REPLICATION CAVEAT: the collector's auto-migrations create plain
 * single-node MergeTree tables — fine for a 1-replica CHI (dev-first sizing);
 * multi-replica / `ON CLUSTER` schemas are NOT supported by ClickStack's
 * tooling. Revisit before scaling the external ClickHouse beyond one replica.
 *
 * @see https://github.com/ClickHouse/ClickStack-helm-charts
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack
 */

import { type } from 'arktype';
import type { ValuesMergeExpression } from '../../core/aspects/values-merge.js';
import type { TypeKroChartValues } from '../../core/types/common.js';

// ============================================================================
// ClickHouse version-coupling guidance
// ============================================================================

/**
 * Loose ClickHouse version coupling facts for the external-ClickHouse mode,
 * exported for downstream platform layers that own the CHI sizing/versioning.
 *
 * Sources (verified 2026-07-06 against ClickHouse/ClickStack-helm-charts main):
 * - The chart vendors ClickHouse `25.7-alpine` for its (disabled here) bundled
 *   cluster (charts/clickstack/values.yaml `clickhouse.cluster.spec.containerTemplate`).
 * - ClickStack's seed schemas ship a "<26.2 compatibility" variant, so recent
 *   25.x/26.x servers are accepted — the coupling is loose, not pinned.
 * - The optional JSON-typed schema is gated behind the
 *   `HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE` env flag and wants
 *   ClickHouse 25.3+ (native JSON type maturity).
 */
export const CLICKSTACK_CLICKHOUSE_GUIDANCE = {
  /** ClickHouse version the chart vendors/tests against for its bundled cluster. */
  chartVendoredClickHouseVersion: '25.7',
  /** Minimum recommended ClickHouse version for an external cluster. */
  minRecommendedClickHouseVersion: '25.3',
  /** Env flag (in `hyperdx.config`) enabling the JSON-typed OTel schema. */
  jsonSchemaFlag: 'HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE',
  /** Minimum ClickHouse version for the JSON-typed schema. */
  jsonSchemaMinClickHouseVersion: '25.3',
  /**
   * The collector's goose migrations create single-node MergeTree tables only;
   * multi-replica / ON CLUSTER schemas are not supported by ClickStack tooling.
   */
  singleNodeSchemaOnly: true,
} as const;

// ============================================================================
// Shared ArkType shapes
// ============================================================================

const resourceRequirementsShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

const imageShape = {
  'repository?': 'string',
  'tag?': 'string',
  'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
} as const;

// ============================================================================
// Chart values shapes (typed subsets of the OFFICIAL charts' values.yaml)
// ============================================================================

/**
 * Typed subset of the official `clickstack` chart values we map or pin
 * (verified 2026-07-06 against ClickHouse/ClickStack-helm-charts
 * charts/clickstack/values.yaml, chart 3.0.1). The index signature keeps the
 * rest of the chart's surface reachable through the values passthrough.
 */
export interface ClickStackHelmValues {
  /** HyperDX app (UI + API + OpAMP). */
  hyperdx?: {
    /** Shared non-sensitive env (rendered into the `clickstack-config` ConfigMap). */
    config?: Record<string, unknown>;
    /** Shared sensitive env (rendered into the `clickstack-secret` Secret). */
    secrets?: Record<string, unknown>;
    /** HyperDX Deployment knobs incl. `defaultConnections`/`defaultSources`. */
    deployment?: Record<string, unknown>;
    ports?: { api?: number; app?: number; opamp?: number };
    [key: string]: unknown;
  };
  /** Bundled ClickHouse (CRDs owned by clickstack-operators) — HARD-PINNED false. */
  clickhouse?: { enabled?: boolean; [key: string]: unknown };
  /** Bundled MongoDB (MongoDBCommunity CRD) — HARD-PINNED false. */
  mongodb?: { enabled?: boolean; [key: string]: unknown };
  /** OTel gateway collector subchart (alias `otel-collector`). */
  'otel-collector'?: { enabled?: boolean; [key: string]: unknown };
  /** Naming anchor for the status contract — HARD-PINNED to the release name. */
  fullnameOverride?: string;
  [key: string]: unknown;
}

/**
 * Typed subset of the STOCK `opentelemetry-collector` chart values used by
 * the k8s telemetry pair (preset names verified 2026-07-06 against
 * open-telemetry/opentelemetry-helm-charts charts/opentelemetry-collector).
 */
export interface OtelCollectorHelmValues {
  /** Instance identity — re-pinned per telemetry instance. */
  mode?: 'daemonset' | 'deployment' | 'statefulset';
  image?: { repository?: string; tag?: string; [key: string]: unknown };
  presets?: {
    logsCollection?: { enabled?: boolean; [key: string]: unknown };
    hostMetrics?: { enabled?: boolean; [key: string]: unknown };
    kubeletMetrics?: { enabled?: boolean; [key: string]: unknown };
    kubernetesAttributes?: { enabled?: boolean; [key: string]: unknown };
    kubernetesEvents?: { enabled?: boolean; [key: string]: unknown };
    clusterMetrics?: { enabled?: boolean; [key: string]: unknown };
    [key: string]: unknown;
  };
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Values tree accepted by the ClickStack/OTel HelmRelease wrappers: a typed
 * (possibly graph-aware) chart values object, or the runtime values-merge
 * expression produced when per-instance `customValues` arrives as a schema
 * ref (the serializer compiles it to a KRO runtime map-merge).
 */
export type ClickStackMappedHelmValues =
  | TypeKroChartValues<ClickStackHelmValues>
  | ValuesMergeExpression;

/** Same, for the stock opentelemetry-collector instances. */
export type OtelCollectorMappedHelmValues =
  | TypeKroChartValues<OtelCollectorHelmValues>
  | ValuesMergeExpression;

// ============================================================================
// Build-time options (construction, NOT runtime spec)
// ============================================================================

/** Internal-Mongo PVC sizing — build-time (shapes the StatefulSet template). */
export interface ClickStackMongoStorageOptions {
  /** PVC size (default: '5Gi'). */
  size?: string;
  /** Optional StorageClass for the PVC. */
  storageClassName?: string;
}

/**
 * Mongo mode — BUILD-TIME because it decides WHICH resources exist.
 *
 * HyperDX has a HARD MongoDB dependency for app state (dashboards, alerts,
 * users; MongoDB is SSPL at runtime).
 * - `internal` (default): a minimal single-replica typekro-native
 *   StatefulSet + Service running `mongo:7` — NO operator, NO CRDs, NO auth.
 *   APP METADATA ONLY, dev-first; not HA.
 * - `external`: bring your own MongoDB; the variant's runtime spec gains a
 *   required `mongoUri` field wired into `hyperdx.config.MONGO_URI`.
 */
export type ClickStackMongoBuildOptions =
  | { mode: 'internal'; storage?: ClickStackMongoStorageOptions }
  | { mode: 'external' };

/** Shared build-time options for both bootstrap variants. */
interface ClickStackBuildOptionsBase {
  /**
   * Static raw official-chart values merged at construction time (they win
   * over the typed mapping), EXCEPT the hard pins — `clickhouse.enabled: false`,
   * `mongodb.enabled: false`, and `fullnameOverride` (the status contract's
   * naming anchor) — which are re-applied after the merge. Build-time by
   * design: a free-form values tree cannot be represented per-instance in a
   * KRO schema without silently dropping it (the accepted-but-ignored config
   * class this family refuses to ship). Per-instance, DIRECT-MODE-ONLY
   * overrides can go through the runtime type's `customValues` instead (an
   * internal escape hatch, not part of the KRO-mode schema — see
   * `ClickStackBootstrapRuntimeConfig`'s doc comment below).
   */
  values?: TypeKroChartValues<ClickStackHelmValues>;
  /** RGD name override (needed when registering both variants in one cluster). */
  name?: string;
  /** KRO kind override. */
  kind?: string;
}

/** Build-time options for the internal-Mongo bootstrap variant. */
export interface ClickStackInternalMongoBuildOptions extends ClickStackBuildOptionsBase {
  mongo?: { mode: 'internal'; storage?: ClickStackMongoStorageOptions };
}

/** Build-time options for the external-Mongo bootstrap variant. */
export interface ClickStackExternalMongoBuildOptions extends ClickStackBuildOptionsBase {
  mongo: { mode: 'external' };
}

/** Union accepted by `makeClickstackBootstrap`. */
export type ClickStackBuildOptions =
  | ClickStackInternalMongoBuildOptions
  | ClickStackExternalMongoBuildOptions;

// ============================================================================
// Bootstrap runtime spec (external ClickHouse)
// ============================================================================

const bootstrapBaseShape = {
  /** Release name for the Helm installation. */
  name: 'string',
  /** Namespace for the stack (default: 'clickstack'). */
  'namespace?': 'string',
  /** Chart version (default: '3.0.1'). */
  'version?': 'string',
  // SECRETS CAVEAT: `password`/`appPassword` below (and `apiKey` further
  // down) travel as PLAINTEXT runtime spec values all the way into the
  // generated HelmRelease's `spec.values.hyperdx.secrets.*` — a Kubernetes
  // object stored in etcd, readable by anyone with read access to the
  // HelmRelease/RGD instance (`kubectl get helmrelease -o yaml`), unlike
  // `k8s-telemetry.ts`'s `apiKeySecret` (a `secretKeyRef` env var — the
  // value never appears in any CR spec). There is currently NO
  // existing-Secret / secretKeyRef alternative for these three fields.
  // Treat them as no more protected than any other spec field; do not
  // consider this family production-ready for credentials that need
  // stronger-than-etcd-RBAC protection until that gap is closed.
  /** External ClickHouse connection (REQUIRED — external-only build-around). */
  clickhouse: {
    /** DNS host of the external ClickHouse service (no scheme, no port). */
    host: 'string',
    /** Native TCP port (default: 9000) → `CLICKHOUSE_ENDPOINT`/`CLICKHOUSE_SERVER_ENDPOINT`. */
    'nativePort?': 'number.integer',
    /** HTTP port (default: 8123) → HyperDX UI `defaultConnections` host. */
    'httpPort?': 'number.integer',
    /** OTel export target database (default: 'default') → `HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE`. */
    'database?': 'string',
    /** Ingest/collector user (default: 'default') → `hyperdx.config.CLICKHOUSE_USER`. Needs SELECT,INSERT,CREATE,SHOW on the database. */
    'username?': 'string',
    /** Ingest/collector password → `hyperdx.secrets.CLICKHOUSE_PASSWORD` (default: ''). PLAINTEXT in the HelmRelease spec — see the secrets caveat above. */
    'password?': 'string',
    /** Read-mostly UI user for HyperDX connections (default: `username`). Needs SHOW + SELECT. */
    'appUsername?': 'string',
    /** UI user password → `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD` (default: `password`). PLAINTEXT in the HelmRelease spec — see the secrets caveat above. */
    'appPassword?': 'string',
  },
  /** HyperDX ingestion API key → `hyperdx.secrets.HYPERDX_API_KEY`. PLAINTEXT in the HelmRelease spec — see the secrets caveat above `clickhouse`. */
  'apiKey?': 'string',
  /** HyperDX app (UI/API) conveniences. */
  'hyperdx?': {
    'replicas?': 'number.integer',
    'resources?': resourceRequirementsShape,
    'image?': imageShape,
    /** Public URL of the HyperDX UI → `hyperdx.config.FRONTEND_URL`. */
    'frontendUrl?': 'string',
  },
  // NOTE: `customValues` is NOT part of this schema, so KRO-mode callers
  // (validated against this shape) can't use it — the mapped values tree
  // carries CEL templates (CLICKHOUSE_ENDPOINT, defaultConnections, ...),
  // and the runtime values merge cannot embed template leaves inside a KRO
  // map-merge expression (the serialized CEL comes out invalid, verified
  // empirically). `ClickStackBootstrapRuntimeConfig` below re-adds
  // `customValues` as an internal, DIRECT-MODE-ONLY escape hatch (only a
  // concrete object merges — see helm-values-mapper.ts) with no test
  // coverage backing it as a supported feature. For anything beyond ad hoc
  // direct-mode tweaks, use build-time raw chart overrides instead
  // (`makeClickstackBootstrap({ values })`), where the merge happens on
  // concrete objects before serialization.
} as const;

/**
 * Runtime spec for the internal-Mongo variant (the default
 * `clickstackBootstrap`). Mongo needs no runtime config — mode and storage
 * are build-time (`makeClickstackBootstrap`).
 */
export const ClickStackBootstrapConfigSchema = type(bootstrapBaseShape);

/** Runtime configuration for the internal-Mongo bootstrap variant. */
export type ClickStackBootstrapConfig = typeof ClickStackBootstrapConfigSchema.infer;

/**
 * Runtime spec for the external-Mongo variant: base + a required `mongoUri`.
 */
export const ClickStackExternalMongoBootstrapConfigSchema = type({
  ...bootstrapBaseShape,
  /** Full MongoDB connection URI → `hyperdx.config.MONGO_URI` (verbatim). */
  mongoUri: 'string',
});

/** Runtime configuration for the external-Mongo bootstrap variant. */
export type ClickStackExternalMongoBootstrapConfig =
  typeof ClickStackExternalMongoBootstrapConfigSchema.infer;

/** Widest runtime config the values mapper accepts (either variant). */
export type ClickStackBootstrapRuntimeConfig = ClickStackBootstrapConfig & {
  mongoUri?: string;
  /**
   * INTERNAL, DIRECT-MODE-ONLY escape hatch — not part of the runtime
   * schema (`bootstrapBaseShape`), so KRO-mode callers can never populate
   * this field and it's absent from the generated CRD. Only a CONCRETE
   * object merges (see helm-values-mapper.ts); no test coverage backs this
   * as a supported feature. Prefer build-time `values` for anything beyond
   * ad hoc direct-mode tweaks.
   */
  customValues?: Record<string, unknown>;
};

// ============================================================================
// Bootstrap status — a typed service contract, not just readiness
// ============================================================================

/**
 * Observed ClickStack status. Downstream compositions consume connection
 * details from here instead of reconstructing chart service-naming rules —
 * e.g. `clickstackK8sTelemetry` wiring:
 * `{ endpoint: stack.status.gateway.otlpHttpEndpoint }`.
 *
 * Naming anchor: the values mapper pins `fullnameOverride` to the release
 * name, so the HyperDX app Service is named exactly `<name>` (the chart's
 * `clickstack.hyperdx.fullname` helper skips its `-app` suffix when
 * `fullnameOverride` is set) and the gateway Service is
 * `<name>-otel-collector` (subchart naming off `.Release.Name`).
 *
 * KRO STATUS vs CLIENT-HYDRATED SPLIT: fields anchored on the owned
 * HelmRelease resource serialize as KRO status CEL and appear on the live
 * KRO CR's status (GitOps/KRO consumers can read them): `ready`, `phase`,
 * `ui.url`, `gateway.otlpHttpEndpoint`, `gateway.otlpGrpcEndpoint`,
 * `app.host` — natural JS template literals over
 * `clickstackHelmRelease.metadata.name`/`.namespace` (bimodal on typekro
 * >= 0.24.0: status CEL in `factory('kro')`, concrete strings via direct-mode
 * re-execution), never `schema.spec.*` (KRO status CEL cannot reference the
 * instance spec). The BARE build-time constants `app.appPort` (3000) and
 * `app.apiPort` (8000), plus the spec-derived `version`, have no resource
 * anchor and are hydrated CLIENT-SIDE by TypeKro (absent from the KRO CR
 * status); the ports remain KRO-visible inside the URL fields.
 * Ports are the chart defaults (`hyperdx.ports`, `otel-collector.ports`);
 * port overrides via build-time raw values are NOT reflected here.
 */
export const ClickStackBootstrapStatusSchema = type({
  /** Overall readiness from the owned HelmRelease Ready condition. */
  ready: 'boolean',
  /** Coarse phase from the owned HelmRelease Ready condition. */
  phase: '"Ready" | "Installing" | "Failed"',
  /** Configured chart version. */
  'version?': 'string',
  /** HyperDX UI. */
  ui: {
    /** In-cluster URL of the HyperDX UI (app port 3000). */
    url: 'string',
  },
  /** OTel gateway collector ingest endpoints (the `otel-collector` subchart Service). */
  gateway: {
    /** OTLP/HTTP ingest endpoint (servicePort 4318). */
    otlpHttpEndpoint: 'string',
    /** OTLP/gRPC ingest endpoint (servicePort 4317). */
    otlpGrpcEndpoint: 'string',
  },
  /** HyperDX app Service coordinates. */
  app: {
    /** In-cluster DNS host of the HyperDX app Service. */
    host: 'string',
    /** UI port. */
    appPort: 'number.integer',
    /** API port. */
    apiPort: 'number.integer',
  },
});

/** Observed status type for ClickStack bootstrap. */
export type ClickStackBootstrapStatus = typeof ClickStackBootstrapStatusSchema.infer;

// ============================================================================
// K8s Telemetry (stock opentelemetry-collector chart, twice)
// ============================================================================

/**
 * Build-time options for `makeClickstackK8sTelemetry`. Values passthrough is
 * build-time for the same accepted-but-ignored-config reason as the bootstrap.
 */
export interface ClickStackK8sTelemetryBuildOptions {
  /** Daemonset-instance raw chart values merged at construction (`mode` is re-pinned). */
  daemonset?: { values?: TypeKroChartValues<OtelCollectorHelmValues> };
  /** Deployment-instance raw chart values merged at construction (`mode` is re-pinned). */
  deployment?: { values?: TypeKroChartValues<OtelCollectorHelmValues> };
  /** RGD name override. */
  name?: string;
  /** KRO kind override. */
  kind?: string;
}

/**
 * ArkType schema for ClickStackK8sTelemetryConfig (runtime spec).
 *
 * The documented ClickStack Kubernetes ingestion pattern: TWO instances of the
 * STOCK `opentelemetry-collector` chart —
 * - a daemonset instance (presets: logsCollection, hostMetrics,
 *   kubernetesAttributes, kubeletMetrics), and
 * - a deployment instance (presets: kubernetesAttributes, kubernetesEvents,
 *   clusterMetrics),
 * both exporting `otlphttp` to the ClickStack gateway collector with
 * `authorization: <HYPERDX_API_KEY>` header auth.
 *
 * @see https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/kubernetes
 */
export const ClickStackK8sTelemetryConfigSchema = type({
  /** Base release name; the composition derives `<name>-daemonset` and `<name>-deployment`. */
  name: 'string',
  /** Namespace for the collectors (default: 'clickstack-telemetry'). */
  'namespace?': 'string',
  /** Stock opentelemetry-collector chart version (default: '0.146.1'). */
  'version?': 'string',
  /**
   * OTLP/HTTP endpoint of the ClickStack gateway collector. Wire it from the
   * bootstrap's status contract (`stack.status.gateway.otlpHttpEndpoint`).
   * Default assumes the canonical install (`name: 'clickstack'` in namespace
   * 'clickstack').
   */
  'endpoint?': 'string',
  /**
   * Existing Secret holding the HyperDX ingestion API key (REQUIRED). Wired as
   * an env var via `secretKeyRef` and referenced from the exporter's
   * `authorization` header via OTel `${env:...}` config expansion — the key
   * value never lands in Helm values.
   */
  apiKeySecret: {
    name: 'string',
    /** Key inside the Secret (default: 'HYPERDX_API_KEY'). */
    'key?': 'string',
  },
});

/** Runtime configuration for the ClickStack k8s telemetry composition. */
export type ClickStackK8sTelemetryConfig = typeof ClickStackK8sTelemetryConfigSchema.infer;

/** Observed status of the k8s telemetry collectors. */
export const ClickStackK8sTelemetryStatusSchema = type({
  /** Both collector HelmReleases report Ready. */
  ready: 'boolean',
  /** Either collector HelmRelease reports Ready=False. */
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
});

// ============================================================================
// Shared HelmRepository singletons
// ============================================================================

/** Spec accepted by the shared ClickStack HelmRepository singleton. */
export const ClickStackHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

/** Status surfaced by the shared ClickStack HelmRepository singleton. */
export const ClickStackHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

/** Spec accepted by the shared OpenTelemetry HelmRepository singleton. */
export const OtelHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

/** Status surfaced by the shared OpenTelemetry HelmRepository singleton. */
export const OtelHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

// ============================================================================
// Helm wrapper configs
// ============================================================================

/** Configuration for the ClickStack/OTel HelmRepository wrappers. */
export const ClickStackHelmRepositoryConfigSchema = type({
  'name?': 'string',
  'namespace?': 'string',
  'url?': 'string',
  'interval?': 'string',
  'id?': 'string',
});

/** Configuration for the ClickStack HelmRepository wrapper. */
export type ClickStackHelmRepositoryConfig = typeof ClickStackHelmRepositoryConfigSchema.infer;

/** Configuration for the ClickStack HelmRelease wrapper. */
export interface ClickStackHelmReleaseConfig {
  name: string;
  namespace?: string;
  version?: string;
  repositoryName?: string;
  repositoryNamespace?: string;
  /** Official clickstack chart values (graph-aware trees / runtime merges allowed). */
  values?: ClickStackMappedHelmValues;
  id?: string;
}

/** Configuration for a stock opentelemetry-collector HelmRelease wrapper. */
export interface OtelCollectorHelmReleaseConfig {
  name: string;
  namespace?: string;
  version?: string;
  repositoryName?: string;
  repositoryNamespace?: string;
  /** Stock opentelemetry-collector chart values (graph-aware trees / runtime merges allowed). */
  values?: OtelCollectorMappedHelmValues;
  id?: string;
}

// ============================================================================
// Internal Mongo resources
// ============================================================================

/** Configuration for the internal-mode MongoDB StatefulSet/Service pair. */
export interface ClickStackMongoConfig {
  /** ClickStack instance name; resources are named `<name>-mongodb`. */
  name: string;
  /** Target namespace. */
  namespace: string;
  /** PVC size (default: '5Gi'). Build-time concrete value. */
  storageSize?: string;
  /** Optional StorageClass for the PVC. Build-time concrete value. */
  storageClassName?: string;
  /** Mongo image (default: 'mongo:7'). */
  image?: string;
  /** Resource id for the StatefulSet. */
  statefulSetId?: string;
  /** Resource id for the Service. */
  serviceId?: string;
}
