/**
 * ClickStack (HyperDX) Type Definitions
 *
 * ArkType schemas as the single source of truth for config shapes, with types
 * inferred via `typeof Schema.infer` (mirrors the clickhouse/dagster families).
 *
 * Wraps the OFFICIAL ClickStack Helm chart (MIT):
 * - Chart: `clickstack` 3.2.x from https://clickhouse.github.io/ClickStack-helm-charts
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

import type { ClickStackHyperdxOidcOptions } from './hyperdx-oidc/index.js';
import { type } from 'arktype';
import type { ValuesMergeExpression } from '../../core/aspects/values-merge.js';
import {
  CRONJOB_NAME_MAX_LENGTH,
  DNS_LABEL_MAX_LENGTH,
  DNS_SUBDOMAIN_MAX_LENGTH,
  deriveNameLengthLimit,
  HELM_RELEASE_NAME_MAX_LENGTH,
  validateDnsSubdomainName,
  validateSecretDataKey,
} from '../../core/kubernetes/naming.js';
import type { TypeKroChartValues, TypeKroValue } from '../../core/types/common.js';
import type { HelmReleasePostRenderer, HelmReleaseValuesFromSource } from '../helm/types.js';
import { CLICKSTACK_GATEWAY_NAME_SUFFIX } from './resources/helm.js';
import { CLICKSTACK_MONGO_NAME_SUFFIX } from './resources/mongo.js';
import { QUEUE_CLAIM_NAME_SUFFIX } from './utils/storage.js';

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
 * charts/clickstack/values.yaml, chart 3.2.0). The index signature keeps the
 * rest of the chart's surface reachable through the values passthrough.
 */
export interface ClickStackHelmValues {
  /** Cross-subchart settings, including the supported collector config overlay. */
  global?: {
    otelCollector?: { customConfig?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
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

/**
 * Per-signal retention for the OTel tables the gateway collector creates.
 *
 * Values are duration strings — `'30d'`, `'720h'`, `'90m'` — compiled into
 * `ALTER TABLE ... MODIFY TTL <timestamp column> + INTERVAL <n> <unit> DELETE`.
 * Omit a signal to leave its table's TTL alone.
 *
 * ⚠️ NOT COMPATIBLE WITH `diskType: 's3_plain_rewritable'`, and the
 * combination is rejected at construction. That metadata type is immutable:
 * ClickHouse refuses every `ALTER TABLE` on it except settings and comments
 * (code 344, `SUPPORT_IS_DISABLED` — LIVE-VERIFIED against 25.7), so the
 * retention CronJob could never apply a TTL there. Use `diskType: 's3'` for
 * TypeKro-managed TTL, or keep the TTL the collector's own migrations create.
 */
export interface ClickStackRetentionOptions {
  /** `otel_logs` (and `hyperdx_sessions`, which is a log-kind table). */
  logs?: string;
  /** `otel_traces`. */
  traces?: string;
  /** `otel_metrics_gauge`, `otel_metrics_sum`, `otel_metrics_histogram`. */
  metrics?: string;
}

/**
 * OTel gateway collector persistent sending queue.
 *
 * WHY: the gateway buffers in memory by default, so a ClickHouse restart —
 * exactly what an S3-backed node rebuild causes — drops whatever is in flight.
 * A `file_storage`-backed queue survives it, PROVIDED the directory backing it
 * outlives the collector Pod. Enabling this therefore renders a standalone
 * PersistentVolumeClaim owned by the composition and mounts it by
 * `claimName` — never an `emptyDir` or a generic ephemeral volume, both of
 * which Kubernetes deletes with the Pod.
 *
 * ⚠️ EXACTLY ONE GATEWAY COLLECTOR REPLICA. The queue is a bbolt database and
 * the `file_storage` extension holds an exclusive file lock on it, so a second
 * collector opening the same directory blocks on that lock
 * (opentelemetry-collector-contrib issue #5894). A build-time
 * `values['otel-collector'].replicaCount` above 1 is REJECTED at construction,
 * and the rendered values pin `replicaCount: 1`. There is deliberately no
 * shared-volume escape hatch: `ReadWriteMany` would hand every replica the
 * same locked database. Per-replica queues would need the chart's
 * `mode: statefulset` with `volumeClaimTemplates`, which this composition does
 * not model today.
 *
 * ⚠️ THE OVERLAY IS ONE YAML DOCUMENT. This is emitted through the chart's
 * supported `global.otelCollector.customConfig` merge seam, which the ingest
 * pipelines use too, and a YAML list in that overlay REPLACES the supervisor's
 * own list rather than appending to it. That means `extensions` below must
 * enumerate every extension the collector needs, and `exporterNames` must
 * match exporters the OpAMP supervisor actually defines. Both are exposed as
 * options precisely because the correct values depend on the ClickStack
 * version you deploy — check the rendered collector config before relying on
 * this in production.
 *
 * LIVE FINDING (fixed): the overlay used to be assembled by CONCATENATING the
 * ingest-pipeline YAML and this queue's YAML, and both open a top-level
 * `service:` key, so the supervisor rejected the whole file
 * (`mapping key "service" already defined`) and the agent ran with NEITHER.
 * Contributions are structured fragments now, deep-merged and serialised once
 * — see `utils/collector-config.ts`.
 */
export interface ClickStackPersistentQueueOptions {
  /** Enable the file-storage-backed sending queue (default: false). */
  enabled: boolean;
  /** Queue directory inside the collector pod. */
  directory?: string;
  /**
   * Size of the queue's PersistentVolumeClaim (default: `'10Gi'`).
   *
   * There is deliberately NO ephemeral fallback: enabling the queue always
   * renders a standalone PVC owned by the composition, because a queue that
   * does not outlive the collector Pod is not a persistent queue. An
   * `emptyDir` and a *generic ephemeral volume* are both deleted together with
   * their owning Pod
   * (https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/), so
   * either would make this option a no-op under exactly the restart it exists
   * to survive.
   */
  size?: string;
  /** StorageClass for the queue PVC (cluster default when omitted). */
  storageClassName?: string;
  /**
   * Group id the queue volume is made writable for (default: `10001`; a
   * non-negative integer — `0` is the root group, which Kubernetes allows).
   *
   * WHY IT EXISTS: a freshly provisioned BLOCK volume (the AWS EBS CSI default
   * StorageClass, and most other block provisioners) is formatted with a
   * `root:root` 0755 filesystem, and nothing in the chart chowns the mount.
   * The gateway collector image (`clickstack-otel-collector`, verified on
   * 2.35.0) runs as its `otel` user, uid/gid 10001, so the collector cannot
   * create its bbolt databases in the mounted directory and the exporter
   * refuses to start:
   *
   *   open /var/lib/otelcol/file_storage/exporter_clickhouse__logs: permission denied
   *
   * Kubernetes fixes exactly this with a Pod `securityContext.fsGroup` — the
   * kubelet chowns the volume to that group on mount — and the chart exposes
   * it: ClickStack 3.2.0's gateway is the stock `opentelemetry-collector`
   * 0.146.1 subchart under the alias `otel-collector`, whose
   * `podSecurityContext` value is rendered verbatim into the Deployment's Pod
   * `securityContext`. Whenever the queue is enabled TypeKro pins
   * `otel-collector.podSecurityContext.fsGroup` to this value and
   * `fsGroupChangePolicy` to `OnRootMismatch` as part of the mapper's hard
   * pins, so a build-time `values` or direct-mode `customValues` entry can add
   * other `podSecurityContext` fields but not change these two. Override this
   * when running a collector image whose user has a different primary group.
   *
   * @see https://github.com/yehudacohen/typekro/issues/222
   */
  fsGroup?: number;
  /**
   * Exporters whose `sending_queue` is switched to file storage. Must be
   * non-empty when the queue is enabled; defaults to the single ClickHouse
   * exporter the ClickStack collector defines.
   *
   * ⚠️ NOT VALIDATED AT BUILD TIME, BY DESIGN — a name TypeKro cannot check.
   * The exporter set lives in the remote configuration the OpAMP supervisor
   * hands the agent, not in anything this factory renders, so a name the agent
   * does not define cannot be rejected here. It fails SILENTLY at runtime: the
   * supervisor merges the overlay, the `exporters` map simply grows an exporter
   * no pipeline references, and the real exporter keeps its in-memory queue.
   * The integration suite therefore asserts these names against the agent's own
   * EFFECTIVE configuration instead of trusting the default.
   */
  exporterNames?: readonly string[];
  /**
   * The complete `service.extensions` list to emit. It REPLACES the
   * supervisor's list, so it must name every extension the collector needs.
   */
  extensions?: readonly string[];
}

/**
 * BUILD-TIME description of the EXTERNAL ClickHouse's storage, plus the
 * ClickStack-side knobs that depend on it.
 *
 * WHY build-time: `retention` renders a DDL CronJob and `persistentQueue`
 * renders chart values plus volumes — both decide WHICH resources exist and
 * what static text they carry, the same class as the Mongo mode.
 *
 * NO PER-TABLE DDL IS NEEDED for the storage policy itself: the `clickhouse`
 * factory sets `merge_tree/storage_policy` as the server DEFAULT, so the
 * gateway collector's goose migrations create `otel_logs` / `otel_traces` /
 * `otel_metrics_*` / `hyperdx_sessions` on the S3 policy without any
 * `SETTINGS storage_policy` clause (see the SCHEMA caveat in
 * `compositions/clickstack-bootstrap.ts`). These options exist for the two
 * things the server default cannot express — TTL and the collector queue — and
 * to surface the mode on the status contract.
 */
export interface ClickStackStorageOptions {
  /** Storage mode of the external ClickHouse (default: 'pvc'). */
  mode?: 'pvc' | 's3';
  /** Object-storage disk type, echoed onto the status contract. */
  diskType?: 's3' | 's3_plain_rewritable';
  /** The external ClickHouse's default MergeTree policy (default: 's3_main'). */
  policyName?: string;
  /** Per-signal TTL, rendered as an idempotent DDL CronJob. */
  retention?: ClickStackRetentionOptions;
  /** Cron schedule for the retention DDL CronJob (default: '17 * * * *'). */
  retentionSchedule?: string;
  /** Image running `clickhouse-client` for the retention DDL. */
  retentionImage?: string;
  /** OTel gateway collector persistent sending queue. */
  persistentQueue?: ClickStackPersistentQueueOptions;
}

/**
 * Default Secret key the initial user's password is read from.
 *
 * It lives in the SAME Secret the Team-bootstrap CronJob already reads
 * `HYPERDX_API_KEY` from (`clickstack-secret`, the chart-owned Secret), so a
 * password never travels through a build option, a runtime spec field, a
 * HelmRelease `spec.values` tree or the CronJob manifest.
 */
export const DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY = 'HYPERDX_INITIAL_USER_PASSWORD';

/**
 * Collection TypeKro records its OWN bootstrap state in.
 *
 * WHY A TYPEKRO-OWNED COLLECTION. The one-shot state has to be durable and
 * INDEPENDENT of whether the seeded account still exists — "have I ever
 * seeded?" is not the same question as "does a user exist right now?", and
 * answering the first with the second resurrects an account an operator
 * deliberately deleted on the very next minute's run. It deliberately does NOT
 * live as an extra field on HyperDX's own `teams` or `users` document: that
 * schema is upstream-owned, and framework bookkeeping written into it would be
 * invisible to the app's migrations and liable to be dropped or to collide
 * with a future upstream field.
 */
export const CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION = 'typekro_bootstrap';

/** `_id` of the marker document recording that initial-user bootstrap is done. */
export const CLICKSTACK_INITIAL_USER_MARKER_ID = 'initial-user';

/**
 * Environment variable the CronJob carries the HyperDX API's base URL in.
 *
 * The bootstrap script is BUILD-TIME text, but the release name and namespace
 * it would need to address the API are RUNTIME values (schema refs in KRO
 * mode), so the URL cannot be baked into the script. It is computed in the
 * composition from the release naming and the HyperDX API port, and
 * handed to the container as an environment value — the same shape the Mongo
 * URI already uses for the same reason.
 */
export const CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV = 'HYPERDX_API_BASE_URL';

/**
 * A POSIX environment variable name — what the CronJob container can carry as
 * an `env[].name` and the bootstrap script can read back from `process.env`.
 *
 * Strictly NARROWER than a Kubernetes Secret data key in character set, so a
 * key that satisfies this satisfies the API server's character rule too. The
 * LENGTH bound is the part this pattern does not carry, which is why
 * `passwordSecretKey` is checked against {@link validateSecretDataKey} as well.
 */
const CLICKSTACK_ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * BUILD-TIME description of the first HyperDX account, registered by the same
 * CronJob that reconciles the ingestion key.
 *
 * WHY THIS EXISTS. HyperDX bootstraps on a FIRST-RUN-CLAIMS-THE-INSTANCE
 * pattern: the first visitor to `POST /register/password` creates the account
 * AND the Team, `setupTeamDefaults` provisions that Team's connections and
 * sources, and registration then closes behind them forever (409
 * `teamAlreadyExists`). Exactly one registration exists per instance, and
 * whoever spends it becomes the administrator.
 *
 * TypeKro's Team-bootstrap CronJob creates the Team directly, to pre-seed the
 * ingestion API key. That SPENDS the instance's one registration without
 * producing an account — the stack converges to one Team, zero users, and a
 * login page nobody can satisfy (#227). Configuring `initialUser` makes the
 * CronJob spend the registration the way upstream intends: through the app's
 * own endpoint, which produces the account, the Team, the connection and the
 * sources in one call. TypeKro then patches only `teams.apiKey`.
 *
 * WHY build-time: the address is rendered INTO the mongosh script the CronJob
 * runs, which decides what static text the CronJob carries — the same class as
 * the retention DDL. Only the PASSWORD is runtime, and it is not carried here
 * at all — see {@link ClickStackInitialUserOptions.passwordSecretKey}.
 *
 * @see https://github.com/yehudacohen/typekro/issues/227
 */
export interface ClickStackInitialUserOptions {
  /**
   * Address of the first account, posted verbatim to `/register/password`.
   *
   * TypeKro checks only that it is a non-empty string. HyperDX's
   * `registrationSchema` is the AUTHORITY on what an address may be, and it
   * rejects a bad one with a 400 whose body names the field — a second,
   * divergent rule here could only reject addresses the app would have taken.
   * A rejected registration is not a consumed registration, so a typo costs a
   * failed CronJob run and nothing else.
   */
  email: string;
  /**
   * Key inside the CHART-OWNED `clickstack-secret` Secret holding the initial
   * password (default: {@link DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY}).
   * The key also names the container environment variable the script reads the
   * value back from.
   *
   * USE THIS with the `secretValues` credential mode, where the chart renders
   * `clickstack-secret` from a `hyperdx.secrets` fragment supplied by an
   * external Secret through Flux `valuesFrom` — the credential then never
   * enters the HelmRelease or the RGD. Mutually exclusive with
   * {@link ClickStackInitialUserOptions.passwordSecretRef}.
   *
   * THE PASSWORD ITSELF IS NEVER A PROP. Only the key name is, so nothing
   * about the credential is representable in a build option, a CR spec or the
   * rendered CronJob.
   */
  passwordSecretKey?: string;
  /**
   * An EXTERNALLY-OWNED Secret to read the password from instead of the
   * chart's `clickstack-secret`.
   *
   * USE THIS with the inline credential mode. There, the only route into
   * `clickstack-secret` is build-time `values.hyperdx.secrets`, which lands
   * the password in the HelmRelease `spec.values` tree in etcd — undoing the
   * entire point of keeping it out of a prop. Referencing a Secret you create
   * and rotate yourself sidesteps how the chart materialises its own Secret
   * altogether. The Secret must live in the ClickStack workload Namespace,
   * because a `secretKeyRef` is namespace-local.
   *
   * Mutually exclusive with
   * {@link ClickStackInitialUserOptions.passwordSecretKey}. The container
   * environment variable is always
   * {@link DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY}, since a Secret key
   * (`[-._a-zA-Z0-9]+`) need not be a legal environment variable name.
   */
  passwordSecretRef?: {
    /** Secret name, an RFC 1123 DNS subdomain. */
    name: string;
    /** Key inside that Secret, `[-._a-zA-Z0-9]+`. */
    key: string;
  };
  /**
   * Opt out of the chart-version allowlist.
   *
   * See {@link CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS} for what the
   * allowlist actually guards and why it is exact. Set this when you have
   * audited a chart version TypeKro has not.
   */
  allowUnvalidatedChartVersion?: boolean;
}

/** {@link ClickStackInitialUserOptions} with its defaults applied. */
export interface ResolvedClickStackInitialUser {
  /**
   * Address, trimmed and otherwise verbatim. NOT lowercased: the HyperDX user
   * model registers passport-local-mongoose with `usernameLowerCase`, so the
   * app normalises it on the way in and TypeKro second-guessing that would be
   * one more private-behaviour assumption for no gain.
   */
  email: string;
  /** Secret the password is read from — the chart's, or an external one. */
  passwordSecretName: string;
  /** Key inside {@link ResolvedClickStackInitialUser.passwordSecretName}. */
  passwordSecretKey: string;
  /** POSIX env-var name the bootstrap script reads the password back from. */
  passwordEnvVarName: string;
  /** Whether the caller opted out of the chart-version allowlist. */
  allowUnvalidatedChartVersion: boolean;
}

/**
 * Validate and normalize {@link ClickStackInitialUserOptions}.
 *
 * @param context - Caller name, for the error message
 * @param chartSecretName - Name of the chart-owned Secret (`clickstack-secret`)
 * @param options - The build-time option, or `undefined` when unconfigured
 * @returns The resolved option, or `undefined` when unconfigured
 * @throws Error when the address or the Secret reference is unusable
 */
export function resolveClickStackInitialUser(
  context: string,
  chartSecretName: string,
  options?: ClickStackInitialUserOptions
): ResolvedClickStackInitialUser | undefined {
  if (options === undefined) return undefined;

  // Presence only. `/register/password` owns address validity — see
  // ClickStackInitialUserOptions.email.
  const email = typeof options.email === 'string' ? options.email.trim() : '';
  if (email.length === 0) {
    throw new Error(
      `${context}: initialUser.email is required and must be a non-empty address — it is what ` +
        'the bootstrap CronJob posts to HyperDX `/register/password` to claim the instance.'
    );
  }

  // The two password routes name DIFFERENT Secrets with different owners, so
  // accepting both would leave which one wins to declaration order.
  if (options.passwordSecretKey !== undefined && options.passwordSecretRef !== undefined) {
    throw new Error(
      `${context}: initialUser.passwordSecretKey and initialUser.passwordSecretRef are mutually ` +
        `exclusive. Use passwordSecretKey to read a key from the chart-owned ${chartSecretName} ` +
        'Secret (the default — populate it through the secretValues credential mode, whose ' +
        '`hyperdx.secrets` fragment the chart renders into that Secret), or passwordSecretRef to ' +
        'read from a Secret you create and own yourself.'
    );
  }

  const allowUnvalidatedChartVersion = options.allowUnvalidatedChartVersion === true;

  if (options.passwordSecretRef !== undefined) {
    const { name, key } = options.passwordSecretRef;
    // The API server's real rules, from the one shared validator, rather than
    // a local approximation that would accept a 300-character key or `..`.
    const nameProblem = validateDnsSubdomainName(name);
    if (nameProblem !== undefined) {
      throw new Error(
        `${context}: initialUser.passwordSecretRef.name ${JSON.stringify(name)} is not a usable ` +
          `Secret name — it ${nameProblem}.`
      );
    }
    const keyProblem = validateSecretDataKey(key);
    if (keyProblem !== undefined) {
      throw new Error(
        `${context}: initialUser.passwordSecretRef.key ${JSON.stringify(key)} is not a usable ` +
          `Secret data key — it ${keyProblem}.`
      );
    }
    return {
      email,
      passwordSecretName: name,
      passwordSecretKey: key,
      // A Secret key may legally contain `-` and `.`, which a POSIX env-var
      // name may not, so the env var is fixed rather than derived from it.
      passwordEnvVarName: DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY,
      allowUnvalidatedChartVersion,
    };
  }

  const passwordSecretKey =
    options.passwordSecretKey ?? DEFAULT_CLICKSTACK_INITIAL_USER_PASSWORD_KEY;
  // This key has to satisfy BOTH rules, because it names the Secret entry and
  // the container environment variable. The env-var pattern is the stricter of
  // the two on characters, so the Secret rule contributes only its length
  // bound here — which is exactly the part a POSIX pattern cannot express.
  if (!CLICKSTACK_ENV_VAR_NAME_PATTERN.test(passwordSecretKey)) {
    throw new Error(
      `${context}: initialUser.passwordSecretKey ${JSON.stringify(passwordSecretKey)} is not a ` +
        `POSIX environment variable name — expected ${CLICKSTACK_ENV_VAR_NAME_PATTERN.source}. ` +
        'The key names both the Secret entry and the CronJob container environment variable ' +
        'the bootstrap script reads it back from. Use initialUser.passwordSecretRef when the key ' +
        'in your own Secret cannot be one.'
    );
  }
  const passwordKeyProblem = validateSecretDataKey(passwordSecretKey);
  if (passwordKeyProblem !== undefined) {
    throw new Error(
      `${context}: initialUser.passwordSecretKey ${JSON.stringify(passwordSecretKey)} is not a ` +
        `usable Secret data key — it ${passwordKeyProblem}.`
    );
  }

  return {
    email,
    passwordSecretName: chartSecretName,
    passwordSecretKey,
    passwordEnvVarName: passwordSecretKey,
    allowUnvalidatedChartVersion,
  };
}

/**
 * The EXACT chart versions `initialUser` is allowed on.
 *
 * WHAT IS ACTUALLY COUPLED, AND WHY THE GUARD SURVIVED THE REWRITE. Registering
 * through `POST /register/password` moved almost all of this off TypeKro: the
 * account document, its hashing parameters and `setupTeamDefaults`' connections
 * and sources are all produced by the app's own code. What remains is a single
 * write into an upstream-owned schema — `teams.apiKey`, patched so the
 * collector's pre-shared ingestion key matches the Team the app just created —
 * plus the registration contract itself (the route, the `{email, password,
 * confirmPassword}` body, and 409 `teamAlreadyExists` meaning "already
 * claimed"). The HTTP half fails LOUDLY if it drifts: a moved route 404s and
 * the CronJob goes red. The `teams.apiKey` half does not — a renamed field
 * would leave the Job green and ingestion silently unauthenticated — and it is
 * the reason a version guard is still worth its cost.
 *
 * WHY AN EXACT LIST RATHER THAN A SERIES. A prefix or `startsWith` test over a
 * version STRING is not a version test: `'3.2.0 || 4.0.0'` and `'>=3.2.0'` are
 * both legal Helm version RANGES that a prefix check waves through, and either
 * resolves to a chart nobody audited. Set membership cannot be fooled that way,
 * because a range expression is never equal to a version. Patch releases are
 * NOT auto-accepted either: nothing about a `z`-bump promises the app's data
 * contract is unchanged, the audit is minutes of work, and adding a string to
 * this array is the cheapest possible way to record that somebody did it.
 *
 * WHERE IT IS ENFORCED. Both modes, because the maintainer's point stands that
 * a build-time throw alone is not a guard when `version` is a RUNTIME spec
 * field. Direct mode and any concrete build-time version are refused by
 * {@link isClickStackInitialUserValidatedChartVersion} at render time; KRO mode
 * additionally narrows the generated CRD's `spec.version` with the CEL rule
 * from {@link clickStackInitialUserVersionValidationRule}, so a consumer who
 * sets an unaudited version on the custom resource at apply time is rejected by
 * ADMISSION, where there is no build to fail.
 */
export const CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS = ['3.2.0'] as const;

/** HyperDX appVersion the registration contract above was verified against. */
export const CLICKSTACK_INITIAL_USER_VALIDATED_APP_VERSION = '2.35.0';

/**
 * Whether a chart version is on the exact allowlist.
 *
 * @param version - Chart version string
 * @returns `true` when the version is one TypeKro has audited
 */
export function isClickStackInitialUserValidatedChartVersion(version: string): boolean {
  return (CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS as readonly string[]).includes(
    version.trim()
  );
}

/**
 * The CEL rule that narrows `spec.version` on the generated CRD when
 * `initialUser` is configured.
 *
 * This is the KRO-mode half of the allowlist: the rule becomes an
 * `x-kubernetes-validations` entry on the field, so the API server refuses a CR
 * carrying an unaudited version instead of admitting it and leaving the
 * CronJob to patch `teams.apiKey` on a schema nobody has read.
 *
 * @returns A CEL expression over `self`, the submitted `spec.version`
 */
export function clickStackInitialUserVersionValidationRule(): string {
  const allowed = CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS.map((version) =>
    JSON.stringify(version)
  ).join(', ');
  return `self in [${allowed}]`;
}

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
  /**
   * Static Flux Kustomize post-renderers applied to the ClickStack HelmRelease
   * after Helm renders the chart. Build-time and concrete for the same reason
   * `values` is, and passed through to the HelmRelease verbatim — the
   * composition adds none of its own (the persistent queue's `fsGroup` rides
   * on the `otel-collector.podSecurityContext` chart value instead; see
   * {@link ClickStackPersistentQueueOptions.fsGroup}). Typed graph-aware like
   * `values` so it plugs into the `helmRelease` factory; a reference in it is
   * still rejected loudly at construction like every other build-time option.
   */
  postRenderers?: TypeKroValue<HelmReleasePostRenderer>[];
  /** RGD name override (needed when registering both variants in one cluster). */
  name?: string;
  /** KRO kind override. */
  kind?: string;
  /**
   * The external ClickHouse's storage story and the ClickStack-side knobs that
   * depend on it (TTL retention, collector persistent queue, status contract).
   * Omit for the PVC default — existing behaviour is unchanged.
   */
  storage?: ClickStackStorageOptions;
  /**
   * The first HyperDX account, seeded by the Team-bootstrap CronJob.
   *
   * Omit for the previous behaviour, which leaves the UI unreachable once the
   * CronJob has created the Team (`/register/password` answers 409
   * `teamAlreadyExists` from then on) — see {@link ClickStackInitialUserOptions}.
   */
  initialUser?: ClickStackInitialUserOptions;
  /**
   * Sign in to HyperDX with OpenID Connect providers, via TypeKro's HyperDX
   * OIDC plugin. The providers live in a caller-owned Secret that the plugin
   * re-reads at runtime. See {@link ClickStackHyperdxOidcOptions}.
   */
  hyperdxOidc?: ClickStackHyperdxOidcOptions;
}

/** Build-time options for inline credentials with internal Mongo. */
export type ClickStackInlineInternalMongoBuildOptions = ClickStackBuildOptionsBase & {
  mongo?: { mode: 'internal'; storage?: ClickStackMongoStorageOptions };
  credentials?: { source: 'inline' };
};

/** Build-time options for Secret-backed credentials with internal Mongo. */
export type ClickStackSecretValuesInternalMongoBuildOptions = ClickStackBuildOptionsBase & {
  mongo?: { mode: 'internal'; storage?: ClickStackMongoStorageOptions };
  credentials: { source: 'secretValues' };
};

/** Every supported internal-Mongo construction-time configuration. */
export type ClickStackInternalMongoBuildOptions =
  | ClickStackInlineInternalMongoBuildOptions
  | ClickStackSecretValuesInternalMongoBuildOptions;

/** Build-time options for inline credentials with external Mongo. */
export type ClickStackInlineExternalMongoBuildOptions = ClickStackBuildOptionsBase & {
  mongo: { mode: 'external' };
  credentials?: { source: 'inline' };
};

/** Build-time options for Secret-backed credentials with external Mongo. */
export type ClickStackSecretValuesExternalMongoBuildOptions = ClickStackBuildOptionsBase & {
  mongo: { mode: 'external' };
  credentials: { source: 'secretValues' };
};

/** Every supported external-Mongo construction-time configuration. */
export type ClickStackExternalMongoBuildOptions =
  | ClickStackInlineExternalMongoBuildOptions
  | ClickStackSecretValuesExternalMongoBuildOptions;

/** Union accepted by `makeClickstackBootstrap`. */
export type ClickStackBuildOptions =
  | ClickStackInternalMongoBuildOptions
  | ClickStackExternalMongoBuildOptions;

// ============================================================================
// Bootstrap runtime spec (external ClickHouse)
// ============================================================================

const clickhouseConnectionBaseShape = {
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
  /** Read-mostly UI user for HyperDX connections (default: `username`). Needs SHOW + SELECT. */
  'appUsername?': 'string',
} as const;

/** Suffix of the CronJob that provisions the HyperDX Team + API key (`<name>-team-bootstrap`). */
export const CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX = '-team-bootstrap';

/** Suffix of the retention-DDL CronJob (`<name>-otel-retention`), present with `storage.retention`. */
export const CLICKSTACK_RETENTION_NAME_SUFFIX = '-otel-retention';

/**
 * Suffix of the contract ConfigMap's name (`<release>-contract`).
 *
 * THIS COMPOSITION IS THE SOLE DECLARER of `<release>-contract`. The ClickHouse
 * cluster composition used to append the same bare `-contract` to its
 * installation name, so a stack that named its ClickHouse cluster and its
 * ClickStack release after the stack put two independently-owned ConfigMaps on
 * one `(kind, namespace, name)` and KRO refused the second instance with
 * `resource belongs to a different ApplySet … cannot reassign`. That one is now
 * `<installation>-clickhouse-contract`; this name and its keys are unchanged.
 *
 * Any new contract ConfigMap in a composition that can share a namespace and a
 * name with these must be component-scoped the same way —
 * `assertNoDuplicateDeclarations` in the test utilities is the guard.
 */
export const CLICKSTACK_CONTRACT_CONFIGMAP_SUFFIX = '-contract';

/**
 * Every object name the bootstrap — or the chart it installs, or a controller
 * downstream — derives from the runtime `name`, with the limit each one has to
 * satisfy. {@link deriveNameLengthLimit} turns the list into the bound on
 * `name` so the number in the schema can be traced to the name that produced
 * it (the Traefik bootstrap keeps its own list the same way).
 *
 * The chart itself does not fail on a long release name: the aliased
 * `opentelemetry-collector` subchart renders the gateway Deployment and
 * Service as `printf "%s-%s" .Release.Name "otel-collector" | trunc 63 |
 * trimSuffix "-"`, so past 48 characters it silently TRUNCATES — and the
 * status contract's `gateway.*Endpoint` fields, which assume the literal
 * `<name>-otel-collector`, would then point at a Service that does not exist
 * (#222 follow-up). The CronJobs fail louder and earlier: Kubernetes rejects a
 * CronJob whose name exceeds 52 characters at create time, so an over-long
 * `<name>-team-bootstrap` never ran and `ready` never became true. Both are
 * refused HERE, with the binding constraint in the message, instead of being
 * discovered as a missing Service or a CronJob admission error.
 */
export const CLICKSTACK_GENERATED_NAMES = [
  {
    describedAs:
      'the Team-bootstrap CronJob `<name>-team-bootstrap` (a CronJob name leaves 11 of the 63-character Job label for the `-<scheduled-time>` suffix)',
    suffix: CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX,
    limit: CRONJOB_NAME_MAX_LENGTH,
  },
  {
    describedAs: 'the retention CronJob `<name>-otel-retention`',
    suffix: CLICKSTACK_RETENTION_NAME_SUFFIX,
    limit: CRONJOB_NAME_MAX_LENGTH,
  },
  {
    describedAs:
      "the chart's gateway collector Deployment and Service `<name>-otel-collector` (the chart truncates it at 63, which would orphan the status endpoints)",
    suffix: CLICKSTACK_GATEWAY_NAME_SUFFIX,
    limit: DNS_LABEL_MAX_LENGTH,
  },
  {
    describedAs: "the HelmRelease's Helm release name",
    limit: HELM_RELEASE_NAME_MAX_LENGTH,
  },
  {
    describedAs: 'the HyperDX Service `<name>` (`fullnameOverride`)',
    limit: DNS_LABEL_MAX_LENGTH,
  },
  {
    describedAs: 'the internal Mongo StatefulSet and Service `<name>-mongodb`',
    suffix: CLICKSTACK_MONGO_NAME_SUFFIX,
    limit: DNS_LABEL_MAX_LENGTH,
  },
  {
    describedAs: 'the persistent-queue PersistentVolumeClaim `<name>-otel-queue`',
    suffix: QUEUE_CLAIM_NAME_SUFFIX,
    limit: DNS_SUBDOMAIN_MAX_LENGTH,
  },
  {
    describedAs: 'the status-contract ConfigMap `<name>-contract`',
    suffix: CLICKSTACK_CONTRACT_CONFIGMAP_SUFFIX,
    limit: DNS_SUBDOMAIN_MAX_LENGTH,
  },
] as const;

/**
 * Longest runtime `name` the bootstrap accepts, derived from
 * {@link CLICKSTACK_GENERATED_NAMES}. Exported so tests assert the derivation
 * rather than a number copied out of it, and so the composition body can
 * refuse an over-long concrete name in direct mode with the same message.
 */
export const CLICKSTACK_NAME_LIMIT = deriveNameLengthLimit(CLICKSTACK_GENERATED_NAMES);

/**
 * A Kubernetes DNS-1123 label: lowercase alphanumerics and `-`, starting and
 * ending with an alphanumeric. Every object the bootstrap derives from `name`
 * ({@link CLICKSTACK_GENERATED_NAMES}) is one, so the release name must be
 * too — `""`, `"Foo"`, `"foo_bar"` and `"foo/bar"` all fit the length bound
 * and are all refused by the API server later. Unflagged and RE2-compatible,
 * which is what KRO SimpleSchema can carry as `pattern="…"`.
 */
export const CLICKSTACK_NAME_PATTERN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

/**
 * The runtime `name`: {@link CLICKSTACK_NAME_PATTERN} intersected with the
 * derived length bound {@link CLICKSTACK_NAME_LIMIT}. Both stay plain
 * constraints in the ArkType AST (a `pattern` and a `maxLength`), which KRO
 * SimpleSchema serializes as `string | maxLength=N pattern="…"`, so the API
 * server refuses a malformed or over-long name on the instance too.
 * `.configure` sits on the length constraint ALONE (the Traefik bootstrap's
 * arrangement), so a name that violates the pattern still reports the pattern
 * while an over-long one reports the binding constraint behind the number.
 *
 * Exported so the composition body can run the very same schema on a concrete
 * direct-mode `name` — see {@link assertClickStackReleaseName}.
 */
export const ClickStackReleaseNameSchema = type(CLICKSTACK_NAME_PATTERN).and(
  type.string
    .atMostLength(CLICKSTACK_NAME_LIMIT.maxLength)
    .configure({ message: CLICKSTACK_NAME_LIMIT.message })
);

/**
 * Refuse a concrete release name the runtime schema would refuse, with the
 * schema's own message. Direct-mode `toYaml` does not run `validateSpec`, so
 * without this a malformed or over-long concrete `name` would sail through the
 * composition and render a CronJob the API server rejects plus status
 * endpoints naming a gateway Service the chart truncated away. Running
 * {@link ClickStackReleaseNameSchema} itself — rather than re-deriving the
 * checks — is what keeps the two paths from drifting.
 *
 * @param name - A concrete (non-reference) release name
 * @throws Error naming the offending value and the violated constraint
 */
export function assertClickStackReleaseName(name: string): void {
  const result = ClickStackReleaseNameSchema(name);
  if (result instanceof type.errors) {
    throw new Error(`ClickStack release name ${JSON.stringify(name)} is invalid: ${result.summary}`);
  }
}

const bootstrapBaseShape = {
  /**
   * Release name for the Helm installation: a DNS label
   * ({@link CLICKSTACK_NAME_PATTERN}) of at most {@link CLICKSTACK_NAME_LIMIT} characters.
   */
  name: ClickStackReleaseNameSchema,
  /** Namespace for the stack (default: 'clickstack'). */
  'namespace?': 'string',
  /** Chart version (default: '3.2.0'). */
  'version?': 'string',
  // SECRETS CAVEAT: `password`/`appPassword` below (and the required inline
  // `apiKey` on the inline-mode schemas) travel as PLAINTEXT runtime spec values all the way into the
  // generated HelmRelease's `spec.values.hyperdx.secrets.*` — a Kubernetes
  // object stored in etcd, readable by anyone with read access to the
  // HelmRelease/RGD instance (`kubectl get helmrelease -o yaml`), unlike
  // `k8s-telemetry.ts`'s `apiKeySecret` (a `secretKeyRef` env var — the
  // value never appears in any CR spec). Use the secretValues constructor
  // mode when these three fields need to stay out of the CR spec.
  // Treat them as no more protected than any other spec field; do not
  // consider this family production-ready for credentials that need
  // stronger-than-etcd-RBAC protection until that gap is closed.
  /** External ClickHouse connection (REQUIRED — external-only build-around). */
  clickhouse: {
    ...clickhouseConnectionBaseShape,
    /** Ingest/collector password → `hyperdx.secrets.CLICKHOUSE_PASSWORD` (default: ''). PLAINTEXT in the HelmRelease spec — see the secrets caveat above. */
    'password?': 'string',
    /** UI user password → `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD` (default: `password`). PLAINTEXT in the HelmRelease spec — see the secrets caveat above. */
    'appPassword?': 'string',
  },
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

const secretValuesBootstrapBaseShape = {
  ...bootstrapBaseShape,
  clickhouse: clickhouseConnectionBaseShape,
} as const;

/**
 * Runtime spec for the internal-Mongo variant (the default
 * `clickstackBootstrap`). Mongo needs no runtime config — mode and storage
 * are build-time (`makeClickstackBootstrap`).
 */
export const ClickStackBootstrapConfigSchema = type({
  ...bootstrapBaseShape,
  /** HyperDX ingestion API key → `hyperdx.secrets.HYPERDX_API_KEY`. Required and non-empty in inline mode. */
  apiKey: 'string > 0',
});

/** Runtime configuration for the internal-Mongo bootstrap variant. */
export type ClickStackBootstrapConfig = typeof ClickStackBootstrapConfigSchema.infer;

/** Runtime schema used by the Secret-backed internal-Mongo variant. */
export const ClickStackSecretValuesBootstrapConfigSchema = type({
  ...secretValuesBootstrapBaseShape,
  credentialsSecret: {
    name: 'string > 0',
    'valuesKey?': 'string > 0',
  },
});

/** Runtime configuration for the Secret-backed internal-Mongo variant. */
export type ClickStackSecretValuesBootstrapConfig =
  typeof ClickStackSecretValuesBootstrapConfigSchema.infer;

/**
 * Runtime spec for the external-Mongo variant: base + a required `mongoUri`.
 */
export const ClickStackExternalMongoBootstrapConfigSchema = type({
  ...bootstrapBaseShape,
  /** HyperDX ingestion API key → `hyperdx.secrets.HYPERDX_API_KEY`. Required and non-empty in inline mode. */
  apiKey: 'string > 0',
  /** Full MongoDB connection URI → `hyperdx.config.MONGO_URI` (verbatim). */
  mongoUri: 'string',
});

/** Runtime configuration for the external-Mongo bootstrap variant. */
export type ClickStackExternalMongoBootstrapConfig =
  typeof ClickStackExternalMongoBootstrapConfigSchema.infer;

/** Runtime schema used by the Secret-backed external-Mongo variant. */
export const ClickStackSecretValuesExternalMongoBootstrapConfigSchema = type({
  ...secretValuesBootstrapBaseShape,
  credentialsSecret: {
    name: 'string > 0',
    'valuesKey?': 'string > 0',
  },
  mongoUri: 'string',
});

/** Runtime configuration for the Secret-backed external-Mongo variant. */
export type ClickStackSecretValuesExternalMongoBootstrapConfig =
  typeof ClickStackSecretValuesExternalMongoBootstrapConfigSchema.infer;

/** Widest runtime config the values mapper accepts (either variant). */
export type ClickStackBootstrapRuntimeConfig = (
  | ClickStackBootstrapConfig
  | ClickStackSecretValuesBootstrapConfig
  | ClickStackExternalMongoBootstrapConfig
  | ClickStackSecretValuesExternalMongoBootstrapConfig
) & {
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
 * `<name>-otel-collector` (subchart naming off `.Release.Name`). The subchart
 * truncates that name at 63 characters, so the literal holds only because the
 * runtime schema bounds `name` ({@link CLICKSTACK_NAME_LIMIT}).
 *
 * EVERY DECLARED FIELD IS OBSERVABLE THROUGH KRO. Fields anchored on the owned
 * HelmRelease serialize as KRO status CEL directly: `ready`, `phase`,
 * `ui.url`, `gateway.otlpHttpEndpoint`, `gateway.otlpGrpcEndpoint`,
 * `app.host` — natural JS template literals over
 * `clickstackHelmRelease.metadata.name`/`.namespace` (bimodal on typekro
 * >= 0.24.0: status CEL in `factory('kro')`, concrete strings via direct-mode
 * re-execution), never `schema.spec.*` (KRO status CEL cannot reference the
 * instance spec).
 *
 * `version` is anchored on that same HelmRelease — its chart pin,
 * `clickstackHelmRelease.spec.chart.spec.version` — so the reported version is
 * the one Flux is reconciling rather than an echo of the request.
 *
 * The remaining fields — `app.appPort`, `app.apiPort`, and the whole `storage`
 * block — are CONSTRUCTION-TIME values with no owned resource that already
 * carries them. Emitted as literals they were dropped by KRO, so the declared
 * schema promised fields the live CR never carried. The composition instead
 * writes them into a ConfigMap it OWNS (`<release>-contract`) and projects
 * them back from that resource, so `kubectl get clickstackbootstraps -o yaml`
 * shows the whole contract. The ConfigMap's values are strings, so the ports
 * come back through CEL `int(...)` and `persistentQueue` through an
 * `== "true"` comparison.
 *
 * Ports are the chart defaults (`hyperdx.ports`, `otel-collector.ports`);
 * port overrides via build-time raw values are NOT reflected here.
 */
export const ClickStackBootstrapStatusSchema = type({
  /** Overall readiness from the owned HelmRelease Ready condition. */
  ready: 'boolean',
  /** Coarse phase from the owned HelmRelease Ready condition. */
  phase: '"Ready" | "Installing" | "Failed"',
  /** Chart version pinned on the owned HelmRelease. */
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
  /**
   * Storage contract of the external ClickHouse this stack writes to, next to
   * `gateway.otlpHttpEndpoint` so a consumer reads durability and ingest from
   * one place. Construction-time values, PROJECTED from the owned
   * `<release>-contract` ConfigMap so they appear on the live KRO CR status
   * (same treatment as `app.appPort`/`apiPort` and `version`).
   */
  storage: {
    /** 'pvc' or 's3'. */
    mode: '"pvc" | "s3"',
    /** Object-storage disk type of the external ClickHouse. */
    'diskType?': '"s3" | "s3_plain_rewritable"',
    /** Default MergeTree storage policy the OTel tables are created on. */
    'policyName?': 'string',
    /** Configured per-signal TTL, when a retention CronJob is rendered. */
    'retention?': {
      'logs?': 'string',
      'traces?': 'string',
      'metrics?': 'string',
    },
    /** Whether the gateway collector uses a file-storage sending queue. */
    'persistentQueue?': 'boolean',
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

/**
 * ArkType schema for ClickStackHelmReleaseConfig.
 *
 * `values` and `valuesFrom` are validated as `object` / `object[]` and carry
 * their precise TypeScript types through `.as<>()`. Neither is a shape ArkType
 * can describe: a values tree is an OPEN chart-values document that may also
 * be a runtime {@link ValuesMergeExpression}, and `valuesFrom` entries may be
 * graph-aware {@link TypeKroValue}s. Restating either as a schema shape would
 * make it a second source of truth for the chart's own values contract; the
 * cast keeps the config INFERRED whole from this schema instead of needing a
 * hand-written widening layer on top of `.infer`.
 */
export const ClickStackHelmReleaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  /** Official clickstack chart values (graph-aware trees / runtime merges allowed). */
  'values?': type('object').as<ClickStackMappedHelmValues>(),
  /** Secret/ConfigMap values overlays resolved by Flux before inline values. */
  'valuesFrom?': type('object[]').as<TypeKroValue<HelmReleaseValuesFromSource>[]>(),
  /**
   * Flux Kustomize transformations applied after Helm renders the chart. Patch
   * targets stay graph-aware so a `<release>-…` name can be a schema
   * reference in KRO mode (same `object[]` + `.as<>()` reasoning as
   * `valuesFrom`).
   */
  'postRenderers?': type('object[]').as<TypeKroValue<HelmReleasePostRenderer>[]>(),
  'id?': 'string',
});

/** Configuration for the ClickStack HelmRelease wrapper. */
export type ClickStackHelmReleaseConfig = typeof ClickStackHelmReleaseConfigSchema.infer;

/**
 * ArkType schema for OtelCollectorHelmReleaseConfig.
 *
 * See {@link ClickStackHelmReleaseConfigSchema} for why `values` is an
 * `object` carrying its precise type through `.as<>()`.
 */
export const OtelCollectorHelmReleaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  /** Stock opentelemetry-collector chart values (graph-aware trees / runtime merges allowed). */
  'values?': type('object').as<OtelCollectorMappedHelmValues>(),
  'id?': 'string',
});

/** Configuration for a stock opentelemetry-collector HelmRelease wrapper. */
export type OtelCollectorHelmReleaseConfig = typeof OtelCollectorHelmReleaseConfigSchema.infer;

// ============================================================================
// Internal Mongo resources
// ============================================================================

/**
 * ArkType schema for ClickStackMongoConfig.
 *
 * Configuration for the internal-mode MongoDB StatefulSet/Service pair.
 */
export const ClickStackMongoConfigSchema = type({
  /** ClickStack instance name; resources are named `<name>-mongodb`. */
  name: 'string',
  /** Target namespace. */
  namespace: 'string',
  /** PVC size (default: '5Gi'). Build-time concrete value. */
  'storageSize?': 'string',
  /** Optional StorageClass for the PVC. Build-time concrete value. */
  'storageClassName?': 'string',
  /** Mongo image (default: 'mongo:7'). */
  'image?': 'string',
  /** Resource id for the StatefulSet. */
  'statefulSetId?': 'string',
  /** Resource id for the Service. */
  'serviceId?': 'string',
});

/** Configuration for the internal-mode MongoDB StatefulSet/Service pair. */
export type ClickStackMongoConfig = typeof ClickStackMongoConfigSchema.infer;
