/**
 * ClickStack storage consumption: TTL retention and the collector's
 * persistent sending queue.
 *
 * The storage POLICY needs nothing here. The `clickhouse` factory sets
 * `merge_tree/storage_policy` as the server default, so the gateway
 * collector's goose migrations create `otel_logs` / `otel_traces` /
 * `otel_metrics_*` / `hyperdx_sessions` on the S3 policy with no
 * `SETTINGS storage_policy` clause and no per-table DDL from TypeKro. This
 * module covers the two things a server default cannot express:
 *
 * 1. **Retention** — `TTL toDateTime(<timestamp>) + INTERVAL n UNIT DELETE`,
 *    applied by an idempotent CronJob because the tables do not exist until the
 *    collector has migrated, and because TypeKro does not own their DDL.
 *    LIVE-VERIFIED: the collector's own migration already sets a 30-day TTL
 *    (`toDateTime(Timestamp) + toIntervalDay(30)` with `ttl_only_drop_parts`),
 *    so `retention` OVERRIDES that default rather than establishing the first
 *    one — which is exactly why the idempotence probe compares the COMPLETE
 *    TTL clause rather than merely asking whether a TTL exists.
 * 2. **Persistent queue** — a `file_storage`-backed exporter queue so a
 *    ClickHouse restart (which is exactly what an S3-backed node rebuild
 *    causes) does not drop in-flight telemetry. Its directory is backed by a
 *    STANDALONE PersistentVolumeClaim owned by the composition: an `emptyDir`
 *    or a generic ephemeral volume is deleted with the collector Pod, so
 *    neither survives the collector restart the queue exists to survive.
 *
 * S3_PLAIN_REWRITABLE NOTE: retention and that disk type are MUTUALLY
 * EXCLUSIVE, and `resolveClickStackStorage` rejects the combination.
 * `MODIFY TTL` normally schedules a materialization MUTATION, which
 * plain_rewritable does not support — every statement this module emits
 * therefore carries `SETTINGS materialize_ttl_after_modify = 0` so expiry
 * happens during merges instead. LIVE-VERIFIED (ClickHouse 25.7) that this is
 * not enough: the immutable metadata type refuses the metadata ALTER itself
 * ("ALTER TABLE commands are not supported on immutable disk", code 344), and
 * the identical statement succeeds against a table on the server's local
 * policy. The setting is kept for the `diskType: 's3'` path, where the
 * materialization pass is the only thing worth skipping.
 */

import type { ClickStackPersistentQueueOptions, ClickStackStorageOptions } from '../types.js';
import { assertSafeCollectorConfigKey, type CollectorConfigFragment } from './collector-config.js';

/** Default cron schedule for the retention DDL CronJob. */
export const DEFAULT_RETENTION_SCHEDULE = '17 * * * *';

/**
 * Default image for the retention DDL CronJob. The ClickStack chart vendors
 * ClickHouse 25.7, so the matching server image supplies a compatible
 * `clickhouse-client`.
 */
export const DEFAULT_RETENTION_IMAGE = 'clickhouse/clickhouse-server:25.7';

/** Default persistent-queue directory inside the collector pod. */
export const DEFAULT_QUEUE_DIRECTORY = '/var/lib/otelcol/file_storage';

/** Default `file_storage` extension instance name. */
export const QUEUE_EXTENSION_NAME = 'file_storage/hyperdx';

/**
 * Default exporters whose `sending_queue` is switched to file storage.
 *
 * The ClickStack collector defines a single ClickHouse exporter, `clickhouse`,
 * and all three signal pipelines export through it. A name that is NOT one the
 * agent defines fails silently: the supervisor merges the overlay, the
 * `exporters` map simply grows an exporter no pipeline uses, and the real one
 * keeps its in-memory queue. That is why the integration suite asserts these
 * names against the agent's own EFFECTIVE configuration instead of trusting
 * the default.
 */
export const DEFAULT_QUEUE_EXPORTER_NAMES = ['clickhouse'] as const;

/**
 * Default `service.extensions` list emitted with the queue overlay.
 *
 * A YAML list in `global.otelCollector.customConfig` REPLACES the supervisor's
 * own list, so this must name every extension the collector needs — see the
 * warning on {@link ClickStackPersistentQueueOptions}.
 */
export const DEFAULT_QUEUE_EXTENSIONS = ['health_check', QUEUE_EXTENSION_NAME] as const;

/** Volume name used for the persistent-queue directory. */
export const QUEUE_VOLUME_NAME = 'otel-file-storage';

/**
 * Deployment update strategy forced on the gateway whenever the queue is on.
 *
 * The collector chart's `rollout.strategy` (default `RollingUpdate`) becomes
 * the Deployment's `spec.strategy.type` verbatim. `Recreate` is the only value
 * under which a rollout terminates the old collector BEFORE creating its
 * replacement, which is what a single-writer queue on a ReadWriteOnce claim
 * requires — see {@link renderPersistentQueueValues} for why the replica pin
 * does not cover this on its own.
 */
export const QUEUE_ROLLOUT_STRATEGY = 'Recreate';

/**
 * The gateway subchart's OWN `extraVolumes` entry, which we must re-emit.
 *
 * Helm REPLACES a list-valued override rather than appending to it, and the
 * chart mounts the ConfigMap rendered from `global.otelCollector.customConfig`
 * through exactly these two lists. Chart 3.2.0's `values.yaml` says so in a
 * comment on the defaults:
 *
 *   "NOTE: if you override extraVolumes/extraVolumeMounts yourself, Helm
 *    replaces these lists entirely -- re-include the entries below to keep
 *    global.otelCollector.customConfig working."
 *
 * LIVE-VERIFIED what happens when you don't: the queue volume alone evicts the
 * custom-config mount, the OpAMP supervisor logs `Could not read local config
 * file: open /etc/otelcol-contrib/custom/custom.config.yaml: no such file or
 * directory` on every poll, never composes a merged agent config, and the
 * collector never starts its OTLP receivers — while the Pod still reports
 * Ready, because readiness comes from the SUPERVISOR's health_check and not
 * from the agent. Enabling the persistent queue would silently take the whole
 * gateway down.
 */
export const CHART_CUSTOM_CONFIG_VOLUME_NAME = 'custom-config';

/** ConfigMap the chart renders `global.otelCollector.customConfig` into. */
export const CHART_CUSTOM_CONFIG_CONFIG_MAP_NAME = 'clickstack-otel-custom-config';

/** Directory the chart mounts {@link CHART_CUSTOM_CONFIG_CONFIG_MAP_NAME} at. */
export const CHART_CUSTOM_CONFIG_MOUNT_PATH = '/etc/otelcol-contrib/custom';

/** Default size of the persistent-queue PersistentVolumeClaim. */
export const DEFAULT_QUEUE_SIZE = '10Gi';

/**
 * Access modes of the persistent-queue PersistentVolumeClaim — not an option.
 *
 * `ReadWriteMany` used to be selectable, on the theory that a shared volume
 * would let several collector replicas run off one queue directory. It does
 * not, and the volume was never the binding constraint: the OTel `file_storage`
 * extension stores the queue in a bbolt database, and bbolt takes an EXCLUSIVE
 * FILE LOCK on open (the extension's own README says a single collector
 * instance per directory; collector-contrib issue #5894 is the second instance
 * hanging on that lock). Two replicas pointed at one directory therefore either
 * block forever or, if the lock is lost across a node boundary the way a
 * network filesystem can lose it, corrupt the database. Offering RWX advertised
 * a multi-replica queue that cannot exist, so the knob is gone and the claim is
 * always `ReadWriteOnce`.
 */
export const QUEUE_ACCESS_MODES = ['ReadWriteOnce'] as const;

/** Name suffix of the queue PersistentVolumeClaim (and its resource id). */
export const QUEUE_CLAIM_NAME_SUFFIX = '-otel-queue';

/**
 * Name of the queue PersistentVolumeClaim for a release.
 *
 * Shared by the composition (which CREATES the claim) and the values mapper
 * (which MOUNTS it by `claimName`), so the two cannot drift. Accepts a schema
 * reference for `name` the same way every other name in this family does — the
 * template literal serializes to CEL in KRO mode.
 *
 * @param releaseName - Helm release name (`spec.name`)
 * @returns The claim name
 */
export function clickStackQueueClaimName(releaseName: string): string {
  return `${releaseName}${QUEUE_CLAIM_NAME_SUFFIX}`;
}

/** ConfigMap the ClickStack chart renders the shared non-secret env into. */
export const CLICKSTACK_CONFIG_MAP_NAME = 'clickstack-config';

/** Secret the ClickStack chart renders the shared secret env into. */
export const CLICKSTACK_SECRET_NAME = 'clickstack-secret';

/** One OTel table and the column its TTL is expressed against. */
export interface ClickStackRetentionTable {
  /** Table name as created by the gateway collector's goose migrations. */
  readonly table: string;
  /** Timestamp column the TTL is expressed against. */
  readonly column: string;
}

/**
 * Tables per signal, with the timestamp column each one's TTL keys off.
 *
 * Columns mirror the `defaultSources` the values mapper emits (which mirror
 * the chart's own defaults), so they track the schema HyperDX queries:
 * `Timestamp` for logs/traces, `TimeUnix` for metrics, `TimestampTime` for
 * sessions.
 */
export const CLICKSTACK_RETENTION_TABLES: Readonly<
  Record<'logs' | 'traces' | 'metrics', readonly ClickStackRetentionTable[]>
> = {
  logs: [
    { table: 'otel_logs', column: 'Timestamp' },
    // A session is a log-kind table in HyperDX's own source definitions, so it
    // follows the logs retention rather than getting its own knob.
    { table: 'hyperdx_sessions', column: 'TimestampTime' },
  ],
  traces: [{ table: 'otel_traces', column: 'Timestamp' }],
  metrics: [
    { table: 'otel_metrics_gauge', column: 'TimeUnix' },
    { table: 'otel_metrics_sum', column: 'TimeUnix' },
    { table: 'otel_metrics_histogram', column: 'TimeUnix' },
  ],
};

/** A retention duration parsed into a ClickHouse `INTERVAL`. */
export interface ParsedRetention {
  readonly amount: number;
  readonly unit: 'MINUTE' | 'HOUR' | 'DAY';
}

const RETENTION_UNITS: Readonly<Record<string, ParsedRetention['unit']>> = {
  m: 'MINUTE',
  h: 'HOUR',
  d: 'DAY',
};

/**
 * Parse a retention duration string into a ClickHouse `INTERVAL`.
 *
 * @param context - Entry point name for the error message
 * @param field - Offending field path (e.g. `storage.retention.logs`)
 * @param value - Duration string such as `'30d'`, `'720h'`, or `'90m'`
 * @returns The parsed amount and `INTERVAL` unit
 * @throws Error when the duration cannot be parsed or is not positive
 */
export function parseRetentionDuration(
  context: string,
  field: string,
  value: string
): ParsedRetention {
  const match = /^([0-9]+)\s*(m|h|d)$/.exec(value.trim());
  const amount = match?.[1];
  const suffix = match?.[2];
  if (amount === undefined || suffix === undefined) {
    throw new Error(
      `${context}: '${field}' must be a retention duration of minutes, hours or days ` +
        `(e.g. '30d', '720h', '90m') — got ${JSON.stringify(value)}.`
    );
  }
  const parsed = Number(amount);
  if (parsed < 1) {
    throw new Error(`${context}: '${field}' must be at least 1 — got ${JSON.stringify(value)}.`);
  }
  const unit = RETENTION_UNITS[suffix];
  if (unit === undefined) {
    throw new Error(`${context}: '${field}' has an unsupported unit ${JSON.stringify(suffix)}.`);
  }
  return { amount: parsed, unit };
}

/** One resolved retention entry: which table, and the TTL expression for it. */
export interface ResolvedRetentionEntry extends ClickStackRetentionTable {
  readonly signal: 'logs' | 'traces' | 'metrics';
  readonly duration: string;
  /** The `MODIFY TTL` expression to apply. */
  readonly ttlExpression: string;
  /**
   * COMPLETE normalized TTL clauses that mean "the intended TTL is already
   * applied" — matched by EQUALITY, never by substring.
   *
   * WHY EQUALITY: a substring probe is wrong in both directions. Looking for
   * `toIntervalDay(3)` matches a table that actually carries
   * `toIntervalDay(30)`, so a needed change is skipped; and a table carrying
   * the intended interval plus extra clauses (`… + toIntervalDay(30) WHERE
   * …`, or a second `TO VOLUME` entry) also matches, so a DIFFERENT retention
   * policy is reported as converged. Comparing the whole clause makes both
   * cases mismatches, which is the correct answer.
   *
   * TWO SPELLINGS: ClickHouse re-renders a stored TTL from its AST, so the
   * text that comes back is not the text that went in — `INTERVAL 30 DAY`
   * renders as `toIntervalDay(30)`, and the default `DELETE` action is not
   * rendered at all. The AST form is what a live server returns
   * (LIVE-VERIFIED); the source spelling is kept as a second accepted value so
   * the probe does not degrade into "re-ALTER on every run" if a release
   * renders the clause verbatim.
   */
  readonly ttlRenderings: readonly string[];
}

/**
 * Collapse a TTL clause read back from ClickHouse into its comparable form.
 *
 * The server's own rendering is already canonical apart from whitespace, so
 * this only collapses runs of blanks and trims — enough to compare clauses
 * across formatting differences without pretending to normalize SQL.
 *
 * @param rendered - A TTL clause as extracted from `engine_full`
 * @returns The clause with whitespace runs collapsed to single spaces
 */
export function normalizeRenderedTtl(rendered: string): string {
  return rendered.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a TTL clause read back from a live table already expresses the
 * intended retention.
 *
 * This is the exact predicate the rendered CronJob script implements in shell
 * (an equality test against {@link ResolvedRetentionEntry.ttlRenderings}); it
 * exists as a function so the comparison semantics — in particular the
 * near-miss cases a substring probe gets wrong — are directly testable.
 *
 * @param currentClause - TTL clause extracted from `system.tables.engine_full`
 * @param entry - The resolved retention entry being converged
 * @returns True when no `MODIFY TTL` is needed
 */
export function ttlAlreadyApplied(currentClause: string, entry: ResolvedRetentionEntry): boolean {
  const normalized = normalizeRenderedTtl(currentClause);
  return entry.ttlRenderings.includes(normalized);
}

/** Fully defaulted, validated ClickStack storage consumption options. */
export interface ResolvedClickStackStorage {
  readonly mode: 'pvc' | 's3';
  readonly diskType?: 's3' | 's3_plain_rewritable';
  readonly policyName?: string;
  readonly retention?: {
    readonly logs?: string;
    readonly traces?: string;
    readonly metrics?: string;
  };
  readonly retentionEntries: readonly ResolvedRetentionEntry[];
  readonly retentionSchedule: string;
  readonly retentionImage: string;
  readonly persistentQueue?: {
    readonly directory: string;
    /** PVC size — always present: there is no ephemeral fallback. */
    readonly size: string;
    readonly storageClassName?: string;
    /** Always {@link QUEUE_ACCESS_MODES} — see the constant for why. */
    readonly accessModes: readonly string[];
    /** Always non-empty — `resolveClickStackStorage` rejects an empty list. */
    readonly exporterNames: readonly string[];
    readonly extensions: readonly string[];
  };
}

/**
 * Reject a collector component name that JavaScript's object model claims.
 *
 * Every name in `exporterNames` and `extensions` ends up as a MAPPING KEY in
 * the rendered overlay, so `__proto__`, `constructor` and `prototype` are
 * refused before they get there — see {@link assertSafeCollectorConfigKey} for
 * the two silent failure modes. The error names the caller's own option path
 * and the offending index.
 *
 * @param context - Entry point name for the error message
 * @param field - The offending option, relative to `storage.persistentQueue`
 * @param names - The supplied component names
 * @throws Error when any name is an object-model member
 */
function assertQueueComponentNames(
  context: string,
  field: 'exporterNames' | 'extensions',
  names: readonly string[]
): void {
  names.forEach((name, index) => {
    try {
      assertSafeCollectorConfigKey(name);
    } catch (cause) {
      throw new Error(
        `${context}: 'storage.persistentQueue.${field}[${index}]' is ` +
          `${JSON.stringify(name)}, which cannot name a collector component. ` +
          `${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  });
}

/**
 * Resolve and validate the build-time storage options.
 *
 * @param context - Entry point name for every error message
 * @param options - Build-time storage options (omit for the PVC default)
 * @returns The resolved options, with retention expanded per table
 * @throws Error when a retention duration is unparseable, when an
 *   S3-specific option is set on the PVC default, or when a queue component
 *   name is an object-model member (see {@link assertQueueComponentNames})
 */
export function resolveClickStackStorage(
  context: string,
  options: ClickStackStorageOptions | undefined
): ResolvedClickStackStorage {
  const mode = options?.mode ?? 'pvc';
  if (mode === 'pvc' && (options?.diskType !== undefined || options?.policyName !== undefined)) {
    throw new Error(
      `${context}: storage mode 'pvc' (the default) rejects 'storage.diskType' and ` +
        `'storage.policyName' — they describe an object-storage-backed ClickHouse. Set ` +
        `storage.mode: 's3' to declare one.`
    );
  }

  // LIVE FINDING (ClickHouse 25.7, kind + MinIO): a table on an
  // `s3_plain_rewritable` policy rejects the retention DDL outright —
  //
  //   Code: 344. DB::Exception: ALTER TABLE commands are not supported on
  //   immutable disk 's3', except for setting and comment alteration.
  //   (SUPPORT_IS_DISABLED)
  //
  // `SETTINGS materialize_ttl_after_modify = 0` does not help: it only skips
  // the materialization MUTATION, and it is the metadata ALTER itself that the
  // immutable metadata type refuses. The same statement against a table on the
  // server's local policy succeeds, so this is specific to the disk type and
  // not to the statement. Rendering the CronJob anyway would ship a job that
  // CrashLoops forever while reporting a retention policy that is never
  // applied, so the combination is rejected here instead.
  if (options?.diskType === 's3_plain_rewritable' && options?.retention !== undefined) {
    throw new Error(
      `${context}: 'storage.retention' cannot be applied to a ClickHouse whose ` +
        `'storage.diskType' is 's3_plain_rewritable'. Retention converges through ` +
        `\`ALTER TABLE … MODIFY TTL\`, and ClickHouse refuses every ALTER except settings and ` +
        `comments on that immutable metadata type ("ALTER TABLE commands are not supported on ` +
        `immutable disk", SUPPORT_IS_DISABLED) — so the CronJob would fail on every run while ` +
        `reporting a retention policy that never takes effect. Use diskType: 's3' (with ` +
        `storage.backup on the ClickHouse side) if you need TypeKro-managed TTL, or drop ` +
        `'storage.retention' and keep the TTL the collector's own migrations create.`
    );
  }

  const retentionEntries: ResolvedRetentionEntry[] = [];
  for (const signal of ['logs', 'traces', 'metrics'] as const) {
    const duration = options?.retention?.[signal];
    if (duration === undefined) continue;
    const { amount, unit } = parseRetentionDuration(
      context,
      `storage.retention.${signal}`,
      duration
    );
    for (const target of CLICKSTACK_RETENTION_TABLES[signal]) {
      retentionEntries.push({
        ...target,
        signal,
        duration,
        // `toDateTime(...)` wraps the column deliberately: the collector's own
        // migration renders its TTL as `toDateTime(Timestamp) + toIntervalDay(30)`
        // (LIVE-VERIFIED against chart 3.2.0), and the timestamp columns are
        // DateTime64. Emitting the same form keeps the stored expression — and
        // therefore the idempotence probe below — directly comparable.
        ttlExpression: `toDateTime(${target.column}) + INTERVAL ${amount} ${unit} DELETE`,
        ttlRenderings: [
          // Normalized AST rendering — exactly what ClickHouse stores and what
          // `engine_full` / `create_table_query` return. The default `DELETE`
          // action is not part of the rendered clause.
          `toDateTime(${target.column}) + toInterval${unit.charAt(0)}${unit
            .slice(1)
            .toLowerCase()}(${amount})`,
          // Source spelling, in case a release renders the clause verbatim.
          `toDateTime(${target.column}) + INTERVAL ${amount} ${unit}`,
        ],
      });
    }
  }

  const queue = options?.persistentQueue;
  const exporterNames = queue?.exporterNames ?? DEFAULT_QUEUE_EXPORTER_NAMES;
  if (queue?.enabled === true && exporterNames.length === 0) {
    throw new Error(
      `${context}: 'storage.persistentQueue.exporterNames' cannot be empty — the queue exists ` +
        `to back an exporter's \`sending_queue\`, and an empty list would render a ` +
        `\`file_storage\` extension that nothing sends through. Omit the option to use ` +
        `${JSON.stringify(DEFAULT_QUEUE_EXPORTER_NAMES)}.`
    );
  }
  const queueExtensions = queue?.extensions ?? DEFAULT_QUEUE_EXTENSIONS;
  if (queue?.enabled === true && !queueExtensions.includes(QUEUE_EXTENSION_NAME)) {
    throw new Error(
      `${context}: 'storage.persistentQueue.extensions' must include ` +
        `'${QUEUE_EXTENSION_NAME}' — the list REPLACES the supervisor's own ` +
        `\`service.extensions\`, so leaving it out means the file_storage extension the ` +
        `exporters reference is never started and the collector refuses the config. Got ` +
        `${JSON.stringify([...queueExtensions])}.`
    );
  }
  if (queue?.enabled === true) {
    // BOTH lists carry COMPONENT NAMES, and a component name becomes a mapping
    // key in the rendered overlay — `exporters.<name>` directly, and an
    // extension instance name under `extensions.<name>`. JavaScript reserves a
    // few of those, and the failure was silent in both directions: a
    // `__proto__` exporter name rendered as `exporters: {}` (the overlay clone
    // re-parented the copy instead of copying the key) while the merge's
    // `key in target` test could hand `Object.prototype` to the deep merge and
    // mutate it process-wide. Rejected
    // HERE, at the option that supplied the name, so the message names the
    // caller's own path rather than a position inside a fragment. The merge
    // itself re-checks every key independently — see
    // {@link assertSafeCollectorConfigKey}.
    assertQueueComponentNames(context, 'exporterNames', exporterNames);
    assertQueueComponentNames(context, 'extensions', queueExtensions);
  }

  return {
    mode,
    ...(options?.diskType !== undefined && { diskType: options.diskType }),
    ...(options?.policyName !== undefined && { policyName: options.policyName }),
    ...(options?.retention !== undefined && { retention: options.retention }),
    retentionEntries,
    retentionSchedule: options?.retentionSchedule ?? DEFAULT_RETENTION_SCHEDULE,
    retentionImage: options?.retentionImage ?? DEFAULT_RETENTION_IMAGE,
    ...(queue?.enabled === true && {
      persistentQueue: {
        directory: queue.directory ?? DEFAULT_QUEUE_DIRECTORY,
        // Always a real claim size: the ephemeral fallback is gone on purpose
        // (see ClickStackPersistentQueueOptions.size).
        size: queue.size ?? DEFAULT_QUEUE_SIZE,
        ...(queue.storageClassName !== undefined && {
          storageClassName: queue.storageClassName,
        }),
        accessModes: [...QUEUE_ACCESS_MODES],
        exporterNames,
        extensions: queueExtensions,
      },
    }),
  };
}

/**
 * Reject more than one gateway collector replica alongside a persistent queue.
 *
 * UNCONDITIONAL: `persistentQueue` means exactly one collector replica, and no
 * volume choice changes that. The `file_storage` extension keeps the queue in a
 * bbolt database, and bbolt takes an EXCLUSIVE FILE LOCK for the lifetime of
 * the handle — the extension's README is explicit that one directory serves one
 * collector instance, and collector-contrib issue #5894 is the report of the
 * second instance hanging on that lock. So a second replica either blocks
 * forever on `Open` or, where the lock does not hold across a node boundary,
 * writes the same pages as the first.
 *
 * The claim's `ReadWriteOnce` mode is a second, weaker line of defence (extra
 * Pods on other nodes stay `Pending` on `Multi-Attach`), not the reason.
 * `ReadWriteMany` was previously accepted as a way to lift this guard; it is
 * gone, because a shared filesystem hands both replicas the same locked
 * database rather than giving each its own.
 *
 * PER-REPLICA STORAGE IS THE REAL ALTERNATIVE, and it is not modelled here:
 * it needs the upstream chart's `mode: statefulset` with `volumeClaimTemplates`
 * so every replica gets its OWN queue directory. This composition renders the
 * gateway as the chart's default Deployment and mounts one standalone claim, so
 * the error names that path as future work rather than pretending it exists.
 *
 * @param context - Entry point name for the error message
 * @param resolved - Resolved storage options
 * @param replicaCount - Collector replica count from the build-time chart
 *   values, when one was set
 * @throws Error when a persistent queue is requested with more than one replica
 */
export function assertQueueReplicaCompatible(
  context: string,
  resolved: ResolvedClickStackStorage,
  replicaCount: unknown
): void {
  if (resolved.persistentQueue === undefined) return;
  if (typeof replicaCount !== 'number' || replicaCount <= 1) return;
  throw new Error(
    `${context}: 'storage.persistentQueue' requires exactly ONE gateway collector replica — ` +
      `got values['otel-collector'].replicaCount = ${replicaCount}. The queue is a bbolt ` +
      `database owned by the OTel 'file_storage' extension, and bbolt holds an exclusive file ` +
      `lock on it: a second collector opening the same database blocks on that lock ` +
      `(opentelemetry-collector-contrib issue #5894, and the filestorage README's "only one ` +
      `collector instance per directory"), and loses the queue's integrity if the lock is not ` +
      `honoured across nodes. A shared ReadWriteMany volume does NOT help — it hands both ` +
      `replicas the same locked database. Drop to one replica. Giving every replica its own ` +
      `queue would need the chart's 'mode: statefulset' with volumeClaimTemplates, which this ` +
      `composition does not model today.`
  );
}

/**
 * Render the idempotent retention DDL script.
 *
 * IDEMPOTENCE, and why this is a CronJob rather than a one-shot Job: the OTel
 * tables do not exist until the gateway collector's goose migrations have run,
 * and TypeKro does not own their DDL — so the script waits for each table to
 * appear, and re-checks on every run. It only issues `MODIFY TTL` when the
 * table's current TTL clause is not already the intended one, so a converged
 * cluster does no metadata churn.
 *
 * THE IDEMPOTENCE PROBE COMPARES WHOLE CLAUSES. It extracts the complete TTL
 * clause out of `system.tables.engine_full` — everything between `TTL ` and
 * the trailing ` SETTINGS …`, whitespace-collapsed — and tests it for EQUALITY
 * against {@link ResolvedRetentionEntry.ttlRenderings}. A substring probe was
 * wrong in both directions (see the doc on `ttlRenderings`), and the actual
 * clause is echoed on a mismatch so a rendering change is visible in the Job
 * log instead of showing up as silent per-run churn.
 *
 * Notes on the SQL: the extraction deliberately contains no backslash escapes
 * and no `$` anchors — it strips the `SETTINGS` tail with `replaceRegexpOne`
 * first and uses the POSIX class `[[:space:]]` — because the expression has to
 * survive being nested inside a double-quoted shell command substitution.
 *
 * @param resolved - Resolved storage options carrying `retentionEntries`
 * @returns A POSIX shell script for `sh -c`
 */
export function renderRetentionScript(resolved: ResolvedClickStackStorage): string {
  const lines: string[] = [
    'set -eu',
    // The chart's ConfigMap/Secret supply the connection, so this works
    // identically in inline and Secret-backed credential modes. The braced
    // forms below are POSIX parameter expansion (suffix/prefix stripping and
    // defaults) — the only places braces are actually required.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell suffix stripping
    'HOST="${CLICKHOUSE_SERVER_ENDPOINT%%:*}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell prefix stripping
    'PORT="${CLICKHOUSE_SERVER_ENDPOINT##*:}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default value
    'DB="${HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE:-default}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default value
    'USER="${CLICKHOUSE_USER:-default}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell default value
    'PASSWORD="${CLICKHOUSE_PASSWORD:-}"',
    // No port in the endpoint: the stripping above left it unchanged.
    'if [ "$PORT" = "$CLICKHOUSE_SERVER_ENDPOINT" ]; then PORT=9000; fi',
    'run_query() {',
    '  clickhouse-client --host "$HOST" --port "$PORT" --user "$USER"' +
      ' --password "$PASSWORD" --database "$DB" --query "$1"',
    '}',
  ];

  for (const entry of resolved.retentionEntries) {
    const ttl = entry.ttlExpression;
    // Whole-clause equality — one `[ "$CURRENT" != … ]` test per accepted
    // rendering, so ANY difference (a shorter interval that is a prefix of the
    // intended one, an extra WHERE/GROUP BY, a second TTL entry) is a
    // mismatch and gets re-applied.
    const mismatch = entry.ttlRenderings
      .map((rendering) => `[ "$CURRENT" != "${rendering}" ]`)
      .join(' && ');
    lines.push(
      '',
      `# ${entry.signal}: ${entry.table} -> ${entry.duration}`,
      `if [ "$(run_query "EXISTS TABLE \\\`${entry.table}\\\`")" = "1" ]; then`,
      // Strip the ` SETTINGS …` tail, take everything after `TTL `, collapse
      // whitespace. Empty when the table carries no TTL at all.
      `  CURRENT="$(run_query "SELECT trim(replaceRegexpAll(` +
        `extract(replaceRegexpOne(engine_full, ' SETTINGS .*', ''), 'TTL (.*)'),` +
        ` '[[:space:]]+', ' '))` +
        ` FROM system.tables WHERE database = currentDatabase() AND name = '${entry.table}'")"`,
      `  if ${mismatch}; then`,
      `    echo "Applying TTL ${ttl} to ${entry.table} (current: [$CURRENT])"`,
      // materialize_ttl_after_modify = 0: the materialization pass is a
      // MUTATION, which s3_plain_rewritable does not support. Expiry still
      // happens during merges.
      `    run_query "ALTER TABLE \\\`${entry.table}\\\` MODIFY TTL ${ttl}` +
        ` SETTINGS materialize_ttl_after_modify = 0"`,
      '  else',
      `    echo "TTL on ${entry.table} already matches ${entry.duration}"`,
      '  fi',
      'else',
      `  echo "Table ${entry.table} does not exist yet; retention will be applied on a later run"`,
      'fi'
    );
  }

  lines.push('', 'echo "Retention convergence complete"', '');
  return lines.join('\n');
}

/**
 * The persistent queue's contribution to the collector-config overlay.
 *
 * ⚠️ A STRUCTURED FRAGMENT, NOT YAML TEXT, and that is the whole point. This
 * used to return a YAML string that the values mapper CONCATENATED onto the
 * ingest-pipeline string. Both opened a top-level `service:` key, so the
 * rendered `custom.config.yaml` declared `service` twice and the OpAMP
 * supervisor rejected the WHOLE file on every poll:
 *
 *   Could not merge local config file: …/custom/custom.config.yaml
 *   yaml: unmarshal errors: line 18: mapping key "service" already defined at line 1
 *
 * The agent then ran with NEITHER the ingest pipelines NOR the queue, while
 * the Pod still reported Ready off the supervisor's own `health_check` — so
 * enabling the queue was a silent no-op that also took OTLP ingestion down.
 * Fragments are merged by `mergeCollectorConfig` (see
 * `utils/collector-config.ts`) and serialised exactly once, which makes a
 * duplicate key unrepresentable.
 *
 * ⚠️ The YAML lists here REPLACE the supervisor's own lists (the chart's
 * `customConfig` is a merge, not a deep list append) — see the warning on
 * {@link ClickStackPersistentQueueOptions}. `service.extensions` is a sequence,
 * so it UNIONS with any other fragment's contribution before that replacement
 * happens.
 *
 * Every name in `exporterNames` gets its own `sending_queue.storage`. A name
 * the agent does not define is inert rather than fatal — see
 * {@link DEFAULT_QUEUE_EXPORTER_NAMES} for why it cannot be checked here.
 *
 * ⚠️ THE EXPORTER MAP IS BUILT KEY BY KEY, on a NULL-PROTOTYPE dictionary, and
 * every name is re-checked. It used to be an `Object.fromEntries` over
 * `exporterNames`, which is honest enough on its own — `fromEntries` DEFINES an
 * own property, so it does not pollute — but the overlay merge then copied the
 * map with `copy[key] = …` onto a plain `{}`, where assigning `__proto__` calls
 * the inherited SETTER and re-parents the copy instead of adding a key. An
 * `exporterNames: ['__proto__']` install therefore rendered `exporters: {}`: a
 * queue that configured nothing, reported no error, and left the real exporter
 * on its in-memory queue. `resolveClickStackStorage` rejects such a name at the
 * option, and this function refuses it again so no caller holding a
 * hand-built `ResolvedClickStackStorage` can route around that.
 *
 * @param queue - Resolved persistent-queue configuration
 * @returns A fragment for `global.otelCollector.customConfig`
 * @throws Error when a component name is a JavaScript object-model member
 */
export function persistentQueueConfigFragment(
  queue: NonNullable<ResolvedClickStackStorage['persistentQueue']>
): CollectorConfigFragment {
  const exporters = Object.create(null) as Record<string, unknown>;
  for (const exporterName of queue.exporterNames) {
    assertSafeCollectorConfigKey(exporterName, ['exporters']);
    // `defineProperty`, not assignment: on a prototype-less dictionary the two
    // are equivalent, and spelling it out keeps the guarantee local — this line
    // cannot become a setter call however the dictionary above is later built.
    Object.defineProperty(exporters, exporterName, {
      value: { sending_queue: { enabled: true, storage: QUEUE_EXTENSION_NAME } },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const extensionName of queue.extensions) {
    // A `service.extensions` entry is a sequence item here, but it NAMES an
    // extension instance whose name is a mapping key under `extensions:` — the
    // same guard applies, at the same construction time.
    assertSafeCollectorConfigKey(extensionName, ['service', 'extensions']);
  }
  return {
    extensions: {
      [QUEUE_EXTENSION_NAME]: {
        directory: queue.directory,
        create_directory: true,
      },
    },
    exporters,
    service: { extensions: [...queue.extensions] },
  };
}

/**
 * Chart values that mount the queue's PersistentVolumeClaim on the collector.
 *
 * The claim is a STANDALONE PersistentVolumeClaim owned by the composition
 * (rendered next to the retention CronJob) and referenced here by
 * `claimName` — never an `emptyDir` and never a *generic ephemeral volume*.
 * Kubernetes deletes a generic ephemeral volume's PVC together with the Pod
 * that owns it, so an ephemeral claim would be destroyed by exactly the
 * collector restart the queue exists to survive.
 *
 * The collector is also PINNED to one replica, unconditionally: the queue is a
 * bbolt database under an exclusive file lock, so a second replica cannot open
 * it at all — see {@link assertQueueReplicaCompatible}, which rejects a
 * build-time `replicaCount` above 1 at construction. The pin makes that
 * guarantee explicit in the rendered values against later drift.
 *
 * ⚠️ `replicaCount: 1` IS NOT ENOUGH ON ITS OWN, which is why
 * `rollout.strategy: 'Recreate'` travels with it. One replica bounds the
 * STEADY state, not the state DURING a rollout: the chart leaves the
 * Deployment on Kubernetes' default `RollingUpdate` (values.yaml `rollout`,
 * collector chart 0.146.x), whose default `maxSurge: 25%` rounds UP to one
 * extra Pod. A rollout therefore creates the replacement Pod while the old one
 * is still running and still holding both the claim and the queue, and that
 * overlap fails in one of two ways depending on where the replacement lands:
 *
 * - **On another node — a stuck rollout.** The ReadWriteOnce claim is still
 *   attached to the old Pod's node, so the replacement never leaves
 *   `ContainerCreating` (`Multi-Attach error for volume`). `RollingUpdate`
 *   will not terminate the old Pod until the new one is Ready, and
 *   `maxUnavailable: 25%` of one replica rounds DOWN to zero, so nothing gives:
 *   the rollout DEADLOCKS until `progressDeadlineSeconds` expires.
 * - **On the same node — a silent two-writer window.** The replacement starts,
 *   and its `file_storage` extension cannot take bbolt's exclusive lock while
 *   the old collector holds it. Readiness does not notice: it comes from the
 *   OpAMP supervisor's own `health_check`, not from the agent's extensions
 *   (the same reason the missing `custom-config` mount below stayed invisible),
 *   so the Pod reports Ready and the rollout "succeeds" over a queue the new
 *   collector could not open. LIVE-OBSERVED on a single-node cluster: under
 *   `RollingUpdate` the replacement went Ready in under 10s.
 *
 * `Recreate` removes the overlap entirely: the old Pod is deleted, its claim
 * detaches and its lock is released, and only then is the replacement created.
 *
 * The cost is a brief gateway outage on every rollout, and the persistent
 * queue is precisely what makes that cost acceptable: producers upstream of
 * the gateway retry, and telemetry the gateway already accepted is on the
 * claim rather than in the departing Pod's memory, so the replacement resumes
 * draining the same queue instead of starting from an empty one.
 *
 * `rollout.rollingUpdate` needs no clearing here. The chart's Deployment
 * template emits that block only under `if eq .Values.rollout.strategy
 * "RollingUpdate"`, so `Recreate` drops it — which matters, because a
 * Deployment carrying `strategy.type: Recreate` alongside a
 * `strategy.rollingUpdate` block is rejected by the API server.
 *
 * ⚠️ THE CHART'S OWN `custom-config` VOLUME IS RE-EMITTED HERE, and must be:
 * Helm REPLACES a list override instead of appending to it, and these are the
 * lists through which the chart mounts the ConfigMap it renders from
 * `global.otelCollector.customConfig` — the overlay that carries the ingest
 * pipelines AND this queue's own `file_storage` wiring. Dropping it makes the
 * OpAMP supervisor fail to read `custom.config.yaml` and never start the
 * agent's receivers, with the Pod still Ready. See
 * {@link CHART_CUSTOM_CONFIG_VOLUME_NAME} for the live evidence.
 *
 * @param queue - Resolved persistent-queue configuration
 * @param claimName - Name of the PVC the composition creates
 *   ({@link clickStackQueueClaimName})
 * @returns Values under the `otel-collector` subchart alias
 */
export function renderPersistentQueueValues(
  queue: NonNullable<ResolvedClickStackStorage['persistentQueue']>,
  claimName: string
): Record<string, unknown> {
  return {
    'otel-collector': {
      extraVolumes: [
        // The chart's own entry, re-emitted because Helm replaces the list.
        {
          name: CHART_CUSTOM_CONFIG_VOLUME_NAME,
          configMap: { name: CHART_CUSTOM_CONFIG_CONFIG_MAP_NAME, optional: true },
        },
        { name: QUEUE_VOLUME_NAME, persistentVolumeClaim: { claimName } },
      ],
      extraVolumeMounts: [
        {
          name: CHART_CUSTOM_CONFIG_VOLUME_NAME,
          mountPath: CHART_CUSTOM_CONFIG_MOUNT_PATH,
          readOnly: true,
        },
        { name: QUEUE_VOLUME_NAME, mountPath: queue.directory },
      ],
      // Always pinned: the queue's bbolt database admits exactly one writer.
      replicaCount: 1,
      // …and one writer AT A TIME, which the replica count alone does not buy
      // during a rollout. RollingUpdate surges a second Pod onto the same RWO
      // claim and the same bbolt lock while the old one still holds both:
      // Multi-Attach deadlock on another node, silent lock contention on the
      // same one. Recreate drains first. The chart emits `rollingUpdate` only
      // for the RollingUpdate branch, so there is nothing to clear.
      rollout: { strategy: QUEUE_ROLLOUT_STRATEGY },
    },
  };
}

/**
 * Spec of the standalone PersistentVolumeClaim backing the collector queue.
 *
 * @param queue - Resolved persistent-queue configuration
 * @returns A `V1PersistentVolumeClaim.spec` object
 */
export function renderPersistentQueueClaimSpec(
  queue: NonNullable<ResolvedClickStackStorage['persistentQueue']>
): Record<string, unknown> {
  return {
    accessModes: [...queue.accessModes],
    resources: { requests: { storage: queue.size } },
    ...(queue.storageClassName !== undefined && {
      storageClassName: queue.storageClassName,
    }),
  };
}
