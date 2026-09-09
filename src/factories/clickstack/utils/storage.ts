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
 * 1. **Retention** — `TTL <timestamp> + INTERVAL n UNIT DELETE`, applied by an
 *    idempotent CronJob because the tables do not exist until the collector
 *    has migrated, and because TypeKro does not own their DDL.
 * 2. **Persistent queue** — a `file_storage`-backed exporter queue so a
 *    ClickHouse restart (which is exactly what an S3-backed node rebuild
 *    causes) does not drop in-flight telemetry.
 *
 * S3_PLAIN_REWRITABLE NOTE: `MODIFY TTL` normally schedules a materialization
 * MUTATION, and the `plain_rewritable` metadata type does not support
 * mutations. Every statement this module emits therefore carries
 * `SETTINGS materialize_ttl_after_modify = 0`; TTL-driven expiry then happens
 * during merges, which plain_rewritable does support.
 */

import type { ClickStackPersistentQueueOptions, ClickStackStorageOptions } from '../types.js';

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

/** Default exporter whose `sending_queue` is switched to file storage. */
export const DEFAULT_QUEUE_EXPORTER_NAME = 'clickhouse';

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
   * Fragments to look for in `system.tables.create_table_query` to decide the
   * TTL is ALREADY applied.
   *
   * ClickHouse re-renders a stored TTL from its AST, so the text that comes
   * back is NOT the text that went in: `INTERVAL 30 DAY` normally renders as
   * `toIntervalDay(30)`. Both spellings are checked so the idempotence probe
   * does not silently degrade into "re-ALTER on every run" if the renderer
   * changes.
   */
  readonly ttlMarkers: readonly string[];
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
    readonly size?: string;
    readonly storageClassName?: string;
    readonly exporterName: string;
    readonly extensions: readonly string[];
  };
}

/**
 * Resolve and validate the build-time storage options.
 *
 * @param context - Entry point name for every error message
 * @param options - Build-time storage options (omit for the PVC default)
 * @returns The resolved options, with retention expanded per table
 * @throws Error when a retention duration is unparseable, or when an
 *   S3-specific option is set on the PVC default
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
        ttlExpression: `${target.column} + INTERVAL ${amount} ${unit} DELETE`,
        ttlMarkers: [
          // Normalized AST rendering (what ClickHouse actually stores).
          `toInterval${unit.charAt(0)}${unit.slice(1).toLowerCase()}(${amount})`,
          // Source spelling, in case a release renders it verbatim.
          `INTERVAL ${amount} ${unit}`,
        ],
      });
    }
  }

  const queue = options?.persistentQueue;
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
        ...(queue.size !== undefined && { size: queue.size }),
        ...(queue.storageClassName !== undefined && {
          storageClassName: queue.storageClassName,
        }),
        exporterName: queue.exporterName ?? DEFAULT_QUEUE_EXPORTER_NAME,
        extensions: queue.extensions ?? DEFAULT_QUEUE_EXTENSIONS,
      },
    }),
  };
}

/**
 * Render the idempotent retention DDL script.
 *
 * IDEMPOTENCE, and why this is a CronJob rather than a one-shot Job: the OTel
 * tables do not exist until the gateway collector's goose migrations have run,
 * and TypeKro does not own their DDL — so the script waits for each table to
 * appear, and re-checks on every run. It only issues `MODIFY TTL` when the
 * table's current `create_table_query` does NOT already contain the target
 * expression, so a converged cluster does no metadata churn.
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
    const applied = entry.ttlMarkers
      .map((marker) => `position(create_table_query, '${marker}') > 0`)
      .join(' OR ');
    lines.push(
      '',
      `# ${entry.signal}: ${entry.table} -> ${entry.duration}`,
      `if [ "$(run_query "EXISTS TABLE \\\`${entry.table}\\\`")" = "1" ]; then`,
      `  CURRENT="$(run_query "SELECT countIf(${applied})` +
        ` FROM system.tables WHERE database = currentDatabase() AND name = '${entry.table}'")"`,
      '  if [ "$CURRENT" = "0" ]; then',
      `    echo "Applying TTL ${ttl} to ${entry.table}"`,
      // materialize_ttl_after_modify = 0: the materialization pass is a
      // MUTATION, which s3_plain_rewritable does not support. Expiry still
      // happens during merges.
      `    run_query "ALTER TABLE \\\`${entry.table}\\\` MODIFY TTL ${ttl}` +
        ` SETTINGS materialize_ttl_after_modify = 0"`,
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
 * Render the collector-config overlay that enables the persistent queue.
 *
 * ⚠️ The YAML lists here REPLACE the supervisor's own lists (the chart's
 * `customConfig` is a merge, not a deep list append) — see the warning on
 * {@link ClickStackPersistentQueueOptions}.
 *
 * @param queue - Resolved persistent-queue configuration
 * @returns A YAML fragment appended to `global.otelCollector.customConfig`
 */
export function renderPersistentQueueConfig(
  queue: NonNullable<ResolvedClickStackStorage['persistentQueue']>
): string {
  return [
    'extensions:',
    `  ${QUEUE_EXTENSION_NAME}:`,
    `    directory: ${queue.directory}`,
    '    create_directory: true',
    'exporters:',
    `  ${queue.exporterName}:`,
    '    sending_queue:',
    '      enabled: true',
    `      storage: ${QUEUE_EXTENSION_NAME}`,
    'service:',
    `  extensions: [${queue.extensions.join(', ')}]`,
    '',
  ].join('\n');
}

/**
 * Chart values that give the gateway collector a writable queue directory.
 *
 * An `emptyDir` survives a ClickHouse restart but not a collector pod restart;
 * pass `persistentQueue.size` for a PVC that survives both.
 *
 * @param queue - Resolved persistent-queue configuration
 * @returns Values under the `otel-collector` subchart alias
 */
export function renderPersistentQueueValues(
  queue: NonNullable<ResolvedClickStackStorage['persistentQueue']>
): Record<string, unknown> {
  const volume =
    queue.size === undefined
      ? { name: QUEUE_VOLUME_NAME, emptyDir: {} }
      : {
          name: QUEUE_VOLUME_NAME,
          ephemeral: {
            volumeClaimTemplate: {
              spec: {
                accessModes: ['ReadWriteOnce'],
                resources: { requests: { storage: queue.size } },
                ...(queue.storageClassName !== undefined && {
                  storageClassName: queue.storageClassName,
                }),
              },
            },
          },
        };

  return {
    'otel-collector': {
      extraVolumes: [volume],
      extraVolumeMounts: [{ name: QUEUE_VOLUME_NAME, mountPath: queue.directory }],
    },
  };
}
