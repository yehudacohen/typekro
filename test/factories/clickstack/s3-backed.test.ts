/**
 * ClickStack consuming an S3-backed ClickHouse (#183).
 *
 * The storage POLICY needs no ClickStack-side work — the `clickhouse` factory
 * makes it the server default, so the gateway collector's goose migrations
 * create the OTel tables on it with no `SETTINGS storage_policy`. These tests
 * cover the parts a server default cannot express: TTL retention, the
 * collector's persistent sending queue, and the status contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { makeClickstackBootstrap } from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import {
  CLICKSTACK_RETENTION_TABLES,
  parseRetentionDuration,
  renderPersistentQueueConfig,
  renderRetentionScript,
  resolveClickStackStorage,
} from '../../../src/factories/clickstack/utils/storage.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

const ORIGINAL_STRICT_ENV = process.env.TYPEKRO_STRICT_CEL;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
});

afterAll(() => {
  if (ORIGINAL_STRICT_ENV === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT_ENV;
});

const SPEC = {
  name: 'clickstack',
  namespace: 'observability',
  clickhouse: {
    host: 'clickhouse-observability.observability.svc.cluster.local',
    username: 'otelcollector',
    password: 'test-only',
  },
  apiKey: 'test-only-api-key',
};

describe('parseRetentionDuration', () => {
  it('parses days, hours and minutes', () => {
    expect(parseRetentionDuration('t', 'f', '30d')).toEqual({ amount: 30, unit: 'DAY' });
    expect(parseRetentionDuration('t', 'f', '720h')).toEqual({ amount: 720, unit: 'HOUR' });
    expect(parseRetentionDuration('t', 'f', '90m')).toEqual({ amount: 90, unit: 'MINUTE' });
  });

  it('rejects an unparseable or zero duration loudly', () => {
    expect(() => parseRetentionDuration('t', 'storage.retention.logs', '30 days')).toThrow(
      /must be a retention duration of minutes, hours or days/
    );
    expect(() => parseRetentionDuration('t', 'storage.retention.logs', '0d')).toThrow(
      /must be at least 1/
    );
  });
});

describe('resolveClickStackStorage', () => {
  it('defaults to PVC mode with no retention and no queue', () => {
    const resolved = resolveClickStackStorage('t', undefined);
    expect(resolved.mode).toBe('pvc');
    expect(resolved.retentionEntries).toEqual([]);
    expect(resolved.persistentQueue).toBeUndefined();
  });

  it('rejects S3-only descriptors on the PVC default', () => {
    expect(() => resolveClickStackStorage('t', { diskType: 's3' })).toThrow(
      /rejects 'storage.diskType' and 'storage.policyName'/
    );
  });

  it('expands each signal to every table the collector creates for it', () => {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      retention: { logs: '30d', traces: '7d', metrics: '90d' },
    });
    const tables = resolved.retentionEntries.map((entry) => entry.table);

    expect(tables).toEqual([
      ...CLICKSTACK_RETENTION_TABLES.logs.map((entry) => entry.table),
      ...CLICKSTACK_RETENTION_TABLES.traces.map((entry) => entry.table),
      ...CLICKSTACK_RETENTION_TABLES.metrics.map((entry) => entry.table),
    ]);
    // Metrics key off TimeUnix, logs/traces off Timestamp, sessions off
    // TimestampTime — the columns HyperDX's own source definitions use.
    expect(resolved.retentionEntries.find((e) => e.table === 'otel_metrics_gauge')?.column).toBe(
      'TimeUnix'
    );
    expect(resolved.retentionEntries.find((e) => e.table === 'hyperdx_sessions')?.column).toBe(
      'TimestampTime'
    );
  });

  it('leaves an unconfigured signal alone', () => {
    const resolved = resolveClickStackStorage('t', { mode: 's3', retention: { traces: '7d' } });
    expect(resolved.retentionEntries.map((entry) => entry.table)).toEqual(['otel_traces']);
  });
});

describe('renderRetentionScript', () => {
  const resolved = resolveClickStackStorage('t', {
    mode: 's3',
    retention: { logs: '30d', metrics: '90d' },
  });
  const script = renderRetentionScript(resolved);

  it('emits a MODIFY TTL per table with the signal duration', () => {
    // `toDateTime(...)` matches the form the collector's own migration stores.
    expect(script).toContain('MODIFY TTL toDateTime(Timestamp) + INTERVAL 30 DAY DELETE');
    expect(script).toContain('MODIFY TTL toDateTime(TimeUnix) + INTERVAL 90 DAY DELETE');
    expect(script).toContain('otel_logs');
    expect(script).toContain('otel_metrics_gauge');
    expect(script).not.toContain('otel_traces');
  });

  it('probes the NORMALIZED ClickHouse rendering, not the text it sent', () => {
    // A stored TTL comes back re-rendered from the AST, so probing for the
    // source spelling alone would re-ALTER on every run.
    expect(script).toContain("position(create_table_query, 'toIntervalDay(30)') > 0");
    expect(script).toContain("position(create_table_query, 'INTERVAL 30 DAY') > 0");
  });

  it('disables TTL materialization, because plain_rewritable rejects mutations', () => {
    // `MODIFY TTL` normally schedules a materialization MUTATION, and the
    // plain_rewritable metadata type does not support mutations. Expiry still
    // happens during merges.
    const occurrences = script.split('materialize_ttl_after_modify = 0').length - 1;
    expect(occurrences).toBe(resolved.retentionEntries.length);
  });

  it('is idempotent: it checks for the table and for the TTL already being set', () => {
    expect(script).toContain('EXISTS TABLE');
    expect(script).toContain('position(create_table_query');
    expect(script).toContain('does not exist yet');
  });

  it('takes the connection from the chart-owned env, never from a manifest literal', () => {
    expect(script).toContain('${CLICKHOUSE_SERVER_ENDPOINT');
    expect(script).toContain('${CLICKHOUSE_PASSWORD');
    expect(script).not.toContain('test-only');
  });
});

describe('renderPersistentQueueConfig', () => {
  it('wires file_storage into the exporter queue and the service extensions', () => {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true },
    });
    if (resolved.persistentQueue === undefined) throw new Error('expected a queue');
    const config = renderPersistentQueueConfig(resolved.persistentQueue);

    expect(config).toContain('file_storage/hyperdx:');
    expect(config).toContain('directory: /var/lib/otelcol/file_storage');
    expect(config).toContain('storage: file_storage/hyperdx');
    expect(config).toContain('extensions: [health_check, file_storage/hyperdx]');
  });

  it('honors an overridden exporter name and extension list', () => {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: {
        enabled: true,
        exporterName: 'clickhouse/hyperdx',
        extensions: ['health_check', 'opamp', 'file_storage/hyperdx'],
        directory: '/data/queue',
      },
    });
    if (resolved.persistentQueue === undefined) throw new Error('expected a queue');
    const config = renderPersistentQueueConfig(resolved.persistentQueue);

    expect(config).toContain('clickhouse/hyperdx:');
    expect(config).toContain('extensions: [health_check, opamp, file_storage/hyperdx]');
    expect(config).toContain('directory: /data/queue');
  });
});

describe('makeClickstackBootstrap({ storage })', () => {
  it('renders the retention CronJob and keeps the collector overlay intact', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3',
      kind: 'ClickStackS3Bootstrap',
      storage: {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        retention: { logs: '30d', traces: '7d', metrics: '90d' },
      },
    });
    const yaml = bootstrap.toYaml();

    expect(yaml).toContain('kind: CronJob');
    expect(yaml).toContain('otel-retention');
    expect(yaml).toContain('MODIFY TTL');
    expect(yaml).toContain('clickstack-config');
    expect(yaml).toContain('clickstack-secret');
    // The existing ingest-pipeline overlay must survive alongside it.
    expect(yaml).toContain('otlp/hyperdx');
    // And the hard pins still win.
    expect(yaml).toMatch(/clickhouse:\s*\n\s+enabled: false/);
  });

  it('renders no retention CronJob when no signal is configured', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-noretention',
      kind: 'ClickStackS3NoRetention',
      storage: { mode: 's3' },
    });
    const yaml = bootstrap.toYaml();
    // Only the Team bootstrap CronJob, never an otel-retention one.
    expect(yaml).not.toContain('otel-retention');
  });

  it('adds the persistent queue config and its backing volume together', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-queue',
      kind: 'ClickStackS3Queue',
      storage: { mode: 's3', persistentQueue: { enabled: true, size: '10Gi' } },
    });
    const yaml = bootstrap.toYaml();

    expect(yaml).toContain('file_storage/hyperdx');
    expect(yaml).toContain('otel-file-storage');
    expect(yaml).toContain('storage: 10Gi');
  });

  it('surfaces storage next to the gateway endpoint on the status contract', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-status',
      kind: 'ClickStackS3Status',
      storage: {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        policyName: 's3_main',
        retention: { logs: '30d' },
        persistentQueue: { enabled: true },
      },
    });
    const serialized = JSON.stringify(bootstrap.plan?.(SPEC, { strict: true }));

    expect(serialized).toContain('"key":"mode","value":{"kind":"literal","value":"s3"}');
    expect(serialized).toContain(
      '"key":"diskType","value":{"kind":"literal","value":"s3_plain_rewritable"}'
    );
    expect(serialized).toContain('"key":"persistentQueue","value":{"kind":"literal","value":true}');
  });

  it('reports pvc mode and no queue by default', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-default-storage',
      kind: 'ClickStackDefaultStorage',
    });
    const serialized = JSON.stringify(bootstrap.plan?.(SPEC, { strict: true }));

    expect(serialized).toContain('"key":"mode","value":{"kind":"literal","value":"pvc"}');
    expect(serialized).toContain(
      '"key":"persistentQueue","value":{"kind":"literal","value":false}'
    );
  });

  it('rejects a schema reference in the build-time storage option', () => {
    expect(() =>
      makeClickstackBootstrap({
        storage: {
          mode: 's3',
          policyName: {
            [KUBERNETES_REF_BRAND]: true,
            resourceId: '__schema__',
            fieldPath: 'spec.policyName',
          } as unknown as string,
        },
      })
    ).toThrow(/build-time options contain a schema\/resource reference/);
  });

  it('rejects an unparseable retention duration at CONSTRUCTION time', () => {
    expect(() =>
      makeClickstackBootstrap({ storage: { mode: 's3', retention: { logs: 'forever' } } })
    ).toThrow(/'storage.retention.logs' must be a retention duration/);
  });
});
