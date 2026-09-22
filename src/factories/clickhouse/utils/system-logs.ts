/**
 * ClickHouse System Log Table Configuration
 *
 * ClickHouse writes its own telemetry into `system.*_log` MergeTree tables —
 * `query_log`, `trace_log`, `metric_log`, `part_log`, `blob_storage_log` and
 * friends. They are written continuously, in small batches, by the server
 * itself, and in normal operation nothing ever reads them.
 *
 * TWO THINGS ABOUT THEM ARE LOAD-BEARING, and neither is ClickHouse's default:
 *
 * 1. WHERE THEY LIVE. `clickHouseInstallation()` in S3 mode sets the object
 *    storage policy as the SERVER-WIDE MergeTree default
 *    (`merge_tree/storage_policy`, see `utils/s3-storage.ts`), deliberately, so
 *    that tables created by tooling outside TypeKro — the ClickStack/HyperDX
 *    gateway collector's goose migrations, SigNoz's migrator — land on object
 *    storage with no per-table DDL. A server-wide default is server-WIDE: it
 *    catches ClickHouse's own system log tables too, which is not what anybody
 *    wanted. On `plain_rewritable` object storage those tables accumulate
 *    parts, `tmp_merge_*` directories and `__meta` entries, and STARTUP walks
 *    that metadata one S3 round trip at a time — so boot time grows with
 *    uptime until the liveness probe outruns it and the server can no longer
 *    start at all. See docs/api/clickhouse/index.md and
 *    https://github.com/yehudacohen/typekro/issues/232.
 *
 * 2. HOW LONG THEY LIVE. ClickHouse ships NO TTL on most of them, so they grow
 *    without bound on whatever disk they are on — an unbounded table nobody
 *    reads is what turns a healthy install into an unrecoverable one.
 *
 * Both are fixed here by PER-LOG configuration, which ClickHouse reads out of
 * the `<query_log>` / `<trace_log>` / ... sections of the server config
 * (the operator renders `configuration.settings` keys like
 * `query_log/storage_policy` into exactly those sections). Pinning the system
 * logs back to the local `default` disk leaves the server-wide MergeTree
 * default — and therefore where USER data lands — completely untouched.
 *
 * @module
 */

import type { ClickHouseSystemLogOptions } from '../types.js';
import type { Loosen } from './loosen.js';

/**
 * System-log options as they arrive from a `Composable<...>` config: every
 * field loosened to `| undefined`, because the runtime check below — not the
 * compile-time shape — is this function's contract. Same pattern as
 * {@link ClickHouseStorageInput}.
 */
export type ClickHouseSystemLogInput = Loosen<ClickHouseSystemLogOptions>;

/**
 * ClickHouse's own system log tables, as ENABLED BY DEFAULT.
 *
 * SOURCE, not guesswork: the `<*_log>` sections of ClickHouse's own shipped
 * server configuration, `programs/server/config.xml` at tag
 * `v25.7.1.3997-stable` (lines 1104-1401) — the 25.7 series the composition is
 * used with. A system log table EXISTS IF AND ONLY IF its config section
 * exists: `createSystemLog()` in `src/Interpreters/SystemLog.cpp` returns
 * early ("Not creating {}.{} since corresponding section '{}' is missing from
 * config") when the section is absent. That cuts both ways and is why this
 * list is the DEFAULT-ENABLED set rather than every log ClickHouse knows
 * about:
 *
 * - `session_log` is SHIPPED COMMENTED OUT and is therefore absent from this
 *   list. Emitting a `<session_log><storage_policy>` element for it would
 *   CREATE the section and so ENABLE a log the server does not run today.
 *
 * - `opentelemetry_span_log` is enabled by default but is absent from this
 *   list too, for a different reason — see
 *   {@link CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS}.
 *
 * A server older or newer than 25.7 is safe either way: ClickHouse ignores a
 * config section for a log it does not implement, and a log ADDED in a later
 * version simply is not pinned (it inherits the server-wide default, which is
 * the pre-fix behaviour for that one table).
 */
export const CLICKHOUSE_SYSTEM_LOG_TABLES = [
  'query_log',
  'trace_log',
  'query_thread_log',
  'query_views_log',
  'part_log',
  'text_log',
  'metric_log',
  'latency_log',
  'error_log',
  'query_metric_log',
  'asynchronous_metric_log',
  'crash_log',
  'processors_profile_log',
  'asynchronous_insert_log',
  'backup_log',
  's3queue_log',
  'blob_storage_log',
] as const;

/**
 * Default-enabled system logs that declare a full `<engine>` in ClickHouse's
 * shipped configuration, and therefore CANNOT be given `<storage_policy>` or
 * `<ttl>` here.
 *
 * `createSystemLog()` (src/Interpreters/SystemLog.cpp, v25.7) throws
 * BAD_ARGUMENTS at STARTUP when a log declares both `<engine>` and any of
 * `<partition_by>` / `<ttl>` / `<order_by>` / `<storage_policy>` / `<settings>`:
 * "If 'engine' is specified for system table, SETTINGS storage_policy = '...'
 * should be specified directly inside 'engine'". Emitting one of those keys
 * for such a log would turn a storage fix into a server that refuses to boot.
 *
 * Only `opentelemetry_span_log` is in this position in 25.7: it needs a custom
 * engine because it has no `event_date`/`event_time` (it is ordered by
 * `finish_date, finish_time_us`) — which independently disqualifies it from
 * the `event_date`-based retention TTL below. It is only written when
 * OpenTelemetry span propagation is switched on, which this composition does
 * not do.
 */
export const CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS = ['opentelemetry_span_log'] as const;

/**
 * ClickHouse's built-in storage policy over the local `default` disk
 * (`/var/lib/clickhouse`). It is created by the server in code, not from XML,
 * so it always exists alongside any policy the rendered
 * `storage_configuration` adds.
 */
export const CLICKHOUSE_DEFAULT_STORAGE_POLICY = 'default';

/**
 * Default retention for the system log tables, in days.
 *
 * FOURTEEN, and the number is a judgement, so here is the reasoning. These
 * tables have exactly one purpose: answering "what did this server do?" during
 * an incident or a performance investigation. That question is asked about the
 * recent past — a fortnight covers a full two-week on-call rotation, so an
 * engineer picking up an incident can still see the week before it as a
 * baseline, and it comfortably spans a weekend plus the working days either
 * side of it. Past that the rows are not evidence, they are ballast: nothing
 * reads them, and on object storage they are actively harmful because their
 * metadata is walked at every boot.
 *
 * It is also the conservative end of ClickHouse's own house style rather than
 * an invention: the shipped `programs/server/config.xml` already sets
 * `event_date + INTERVAL 30 DAY DELETE` on `processors_profile_log`, `INTERVAL
 * 30 DAY` on `blob_storage_log` and `INTERVAL 3 DAY` on
 * `asynchronous_insert_log`, and the commented-out example on `query_log` is
 * 30 days. Fourteen sits inside that range, and — unlike ClickHouse's own
 * defaults — it is applied to ALL of them rather than three.
 *
 * Any composition that wants a different number says so
 * (`systemLogs: { retentionDays: 30 }`), and any composition that wants
 * ClickHouse's unbounded behaviour back says THAT
 * (`systemLogs: { ttl: false }`).
 */
export const DEFAULT_SYSTEM_LOG_RETENTION_DAYS = 14;

/** Build the default retention TTL expression for a retention window. */
export function defaultSystemLogTtl(retentionDays: number): string {
  return `event_date + INTERVAL ${retentionDays} DAY DELETE`;
}

/** System log configuration with every default applied. */
export interface ResolvedClickHouseSystemLogs {
  /** Policy the system logs are pinned to, or `undefined` for no pinning. */
  readonly storagePolicy?: string;
  /** TTL expression applied to every system log, or `undefined` for none. */
  readonly ttl?: string;
}

/**
 * Apply the system-log defaults for an installation.
 *
 * @param factoryName - Caller name, quoted into validation errors
 * @param options - Caller's per-log options, if any
 * @param serverWideStoragePolicy - The policy the installation sets as the
 *   server-wide MergeTree default, if it sets one. Its PRESENCE is what makes
 *   pinning the default: with no server-wide policy the system logs are
 *   already on the local disk.
 */
export function resolveClickHouseSystemLogs(
  factoryName: string,
  options: ClickHouseSystemLogInput | undefined,
  serverWideStoragePolicy: string | undefined
): ResolvedClickHouseSystemLogs {
  const retentionDays = options?.retentionDays ?? DEFAULT_SYSTEM_LOG_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(
      `${factoryName}: systemLogs.retentionDays must be a positive integer number of days ` +
        `(got ${String(retentionDays)}). Use \`systemLogs: { ttl: false }\` to emit no ` +
        `retention TTL at all.`
    );
  }

  const storagePolicy =
    options?.storagePolicy === false
      ? undefined
      : (options?.storagePolicy ??
        (serverWideStoragePolicy === undefined ? undefined : CLICKHOUSE_DEFAULT_STORAGE_POLICY));
  if (storagePolicy !== undefined && storagePolicy.length === 0) {
    throw new Error(
      `${factoryName}: systemLogs.storagePolicy must be a non-empty policy name, or \`false\` ` +
        `to leave the system log tables on the server-wide MergeTree default.`
    );
  }

  const ttl =
    options?.ttl === false ? undefined : (options?.ttl ?? defaultSystemLogTtl(retentionDays));
  if (ttl !== undefined && ttl.trim().length === 0) {
    throw new Error(
      `${factoryName}: systemLogs.ttl must be a non-empty TTL expression, or \`false\` to ` +
        `emit no retention TTL.`
    );
  }

  return {
    ...(storagePolicy !== undefined && { storagePolicy }),
    ...(ttl !== undefined && { ttl }),
  };
}

/**
 * CHI `configuration.settings` entries that pin and trim ClickHouse's own
 * system log tables.
 *
 * Keys are the operator's path-keyed settings form (`<log>/storage_policy`,
 * `<log>/ttl`), which it renders into `chop-generated-settings.xml` as the
 * matching nested elements — the same mechanism `merge_tree/storage_policy`
 * already rides on.
 *
 * NOTE ON EXISTING SERVERS: ClickHouse compares the CREATE query it would
 * write against the live table (`SystemLog::prepareTable()`), and on a
 * difference it RENAMES the old table to `<table>_0` and creates a fresh one
 * with the new engine. So this configuration takes effect on the next restart
 * — but the renamed `system.*_0` tables stay exactly where they were, and are
 * still loaded at every boot. See the remediation note in
 * docs/api/clickhouse/index.md.
 */
export function clickHouseSystemLogSettings(
  resolved: ResolvedClickHouseSystemLogs
): Record<string, string> {
  const settings: Record<string, string> = {};
  if (resolved.storagePolicy === undefined && resolved.ttl === undefined) return settings;

  for (const table of CLICKHOUSE_SYSTEM_LOG_TABLES) {
    if (resolved.storagePolicy !== undefined) {
      settings[`${table}/storage_policy`] = resolved.storagePolicy;
    }
    if (resolved.ttl !== undefined) {
      settings[`${table}/ttl`] = resolved.ttl;
    }
  }
  return settings;
}
