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
  clickStackQueueClaimName,
  normalizeRenderedTtl,
  parseRetentionDuration,
  renderPersistentQueueClaimSpec,
  renderPersistentQueueConfig,
  renderPersistentQueueValues,
  renderRetentionScript,
  resolveClickStackStorage,
  ttlAlreadyApplied,
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

  // LIVE FINDING (ClickHouse 25.7): a table on an `s3_plain_rewritable` policy
  // refuses `ALTER TABLE … MODIFY TTL` outright — "ALTER TABLE commands are not
  // supported on immutable disk 's3'", code 344 SUPPORT_IS_DISABLED — while the
  // identical statement succeeds on the server's local policy. Rendering the
  // CronJob anyway would ship a job that CrashLoops on every run while
  // reporting a retention policy that never takes effect.
  it('rejects retention on an immutable s3_plain_rewritable ClickHouse', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        retention: { logs: '30d' },
      })
    ).toThrow(
      /cannot be applied to a ClickHouse whose 'storage.diskType' is 's3_plain_rewritable'/
    );
  });

  it('allows retention on the mutable s3 disk type', () => {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      diskType: 's3',
      retention: { logs: '30d' },
    });
    expect(resolved.retentionEntries.length).toBeGreaterThan(0);
  });

  it('allows s3_plain_rewritable with no retention (the collector keeps its own TTL)', () => {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      diskType: 's3_plain_rewritable',
      persistentQueue: { enabled: true },
    });
    expect(resolved.retentionEntries).toEqual([]);
    expect(resolved.persistentQueue).toBeDefined();
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
    // source spelling alone would re-ALTER on every run. Both COMPLETE
    // clauses are accepted; the AST form is what a live server returns.
    expect(script).toContain('[ "$CURRENT" != "toDateTime(Timestamp) + toIntervalDay(30)" ]');
    expect(script).toContain('[ "$CURRENT" != "toDateTime(Timestamp) + INTERVAL 30 DAY" ]');
  });

  it('compares the COMPLETE clause, never a substring of create_table_query', () => {
    // A substring probe matches a partial or different TTL — see the near-miss
    // cases exercised against ttlAlreadyApplied below.
    expect(script).not.toContain('position(create_table_query');
    expect(script).not.toContain('countIf(');
    // The clause is extracted whole out of engine_full: strip the trailing
    // ` SETTINGS …`, take everything after `TTL `, collapse whitespace.
    expect(script).toContain(
      "extract(replaceRegexpOne(engine_full, ' SETTINGS .*', ''), 'TTL (.*)')"
    );
    expect(script).toContain("'[[:space:]]+', ' '");
  });

  it('keeps the extraction SQL free of shell-hostile escapes', () => {
    // The expression is nested inside a double-quoted command substitution, so
    // a `$` anchor or a backslash escape would be mangled by the shell before
    // ClickHouse ever saw it.
    const extraction = script
      .split('\n')
      .filter((line) => line.includes('replaceRegexpOne(engine_full'));
    expect(extraction.length).toBe(resolved.retentionEntries.length);
    for (const line of extraction) {
      expect(line).not.toContain('\\');
      // The only `$` on the line is the `$(run_query …)` substitution itself.
      expect(line.replace('$(run_query', '')).not.toContain('$');
    }
  });

  it('echoes the actual clause on a mismatch, so a rendering change is visible', () => {
    expect(script).toContain('(current: [$CURRENT])');
    expect(script).toContain('already matches 30d');
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
    expect(script).toContain('FROM system.tables WHERE database = currentDatabase()');
    expect(script).toContain('does not exist yet');
  });

  it('takes the connection from the chart-owned env, never from a manifest literal', () => {
    expect(script).toContain('${CLICKHOUSE_SERVER_ENDPOINT');
    expect(script).toContain('${CLICKHOUSE_PASSWORD');
    expect(script).not.toContain('test-only');
  });
});

describe('ttlAlreadyApplied (the comparison the retention script implements)', () => {
  const entry = resolveClickStackStorage('t', {
    mode: 's3',
    retention: { logs: '3d' },
  }).retentionEntries.find((candidate) => candidate.table === 'otel_logs');
  if (entry === undefined) throw new Error('expected an otel_logs entry');

  it('accepts the exact AST rendering a live server returns', () => {
    expect(ttlAlreadyApplied('toDateTime(Timestamp) + toIntervalDay(3)', entry)).toBe(true);
  });

  it('accepts the source spelling, in case a release renders it verbatim', () => {
    expect(ttlAlreadyApplied('toDateTime(Timestamp) + INTERVAL 3 DAY', entry)).toBe(true);
  });

  it('tolerates whitespace differences but nothing else', () => {
    expect(ttlAlreadyApplied('  toDateTime(Timestamp)  +   toIntervalDay(3) ', entry)).toBe(true);
    expect(normalizeRenderedTtl('a   b\n c ')).toBe('a b c');
  });

  // NEAR MISSES — every one of these is a FALSE POSITIVE for a substring
  // probe (`position(create_table_query, 'toIntervalDay(3)') > 0`), which is
  // the bug this comparison replaces: it would report the table as converged
  // and skip a change that is genuinely needed.
  it('rejects a longer interval that merely CONTAINS the intended one', () => {
    // 30 days when 3 was asked for: 'toIntervalDay(3' is a prefix of
    // 'toIntervalDay(30)'.
    expect(ttlAlreadyApplied('toDateTime(Timestamp) + toIntervalDay(30)', entry)).toBe(false);
    expect(ttlAlreadyApplied('toDateTime(Timestamp) + toIntervalDay(365)', entry)).toBe(false);
  });

  it('rejects the intended interval with extra clauses appended', () => {
    expect(
      ttlAlreadyApplied("toDateTime(Timestamp) + toIntervalDay(3) TO VOLUME 'cold'", entry)
    ).toBe(false);
    expect(
      ttlAlreadyApplied(
        "toDateTime(Timestamp) + toIntervalDay(3) WHERE ServiceName != 'audit'",
        entry
      )
    ).toBe(false);
  });

  it('rejects a multi-entry TTL whose FIRST entry is the intended one', () => {
    expect(
      ttlAlreadyApplied(
        'toDateTime(Timestamp) + toIntervalDay(3), toDateTime(Timestamp) + toIntervalDay(90)',
        entry
      )
    ).toBe(false);
  });

  it('rejects the same interval keyed off a different column', () => {
    expect(ttlAlreadyApplied('toDateTime(TimestampTime) + toIntervalDay(3)', entry)).toBe(false);
  });

  it('rejects a table with no TTL at all', () => {
    expect(ttlAlreadyApplied('', entry)).toBe(false);
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

describe('the persistent queue outlives the collector Pod', () => {
  function resolveQueue(options: Record<string, unknown>) {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true, ...options } as never,
    });
    if (resolved.persistentQueue === undefined) throw new Error('expected a queue');
    return resolved.persistentQueue;
  }

  it('mounts a STANDALONE claim by name — never emptyDir, never a generic ephemeral volume', () => {
    // Kubernetes deletes an emptyDir with the Pod, and deletes a generic
    // ephemeral volume's PVC with the Pod that owns it, so neither survives
    // the collector restart the queue exists to survive.
    const values = renderPersistentQueueValues(resolveQueue({}), 'clickstack-otel-queue');
    const collector = values['otel-collector'] as Record<string, unknown>;
    const volumes = collector.extraVolumes as Record<string, unknown>[];

    expect(volumes).toContainEqual({
      name: 'otel-file-storage',
      persistentVolumeClaim: { claimName: 'clickstack-otel-queue' },
    });
    expect(JSON.stringify(values)).not.toContain('emptyDir');
    expect(JSON.stringify(values)).not.toContain('ephemeral');
    expect(collector.extraVolumeMounts).toContainEqual({
      name: 'otel-file-storage',
      mountPath: '/var/lib/otelcol/file_storage',
    });
  });

  // LIVE FINDING: Helm REPLACES a list-valued override rather than appending,
  // and the chart mounts its `global.otelCollector.customConfig` ConfigMap
  // through these same two lists (its own values.yaml says so). Overriding
  // them with only the queue volume evicted that mount, so the OpAMP
  // supervisor logged "Could not read local config file: open
  // /etc/otelcol-contrib/custom/custom.config.yaml: no such file or directory"
  // on every poll and never started the agent's OTLP receivers — with the Pod
  // still Ready, because readiness comes from the supervisor's health_check.
  // Enabling the queue silently took the whole gateway down.
  it("re-emits the chart's own custom-config volume, which Helm would otherwise drop", () => {
    const values = renderPersistentQueueValues(resolveQueue({}), 'clickstack-otel-queue');
    const collector = values['otel-collector'] as Record<string, unknown>;

    expect(collector.extraVolumes).toContainEqual({
      name: 'custom-config',
      configMap: { name: 'clickstack-otel-custom-config', optional: true },
    });
    expect(collector.extraVolumeMounts).toContainEqual({
      name: 'custom-config',
      mountPath: '/etc/otelcol-contrib/custom',
      readOnly: true,
    });
    // Both lists carry the chart entry AND the queue entry, in that order.
    expect((collector.extraVolumes as unknown[]).length).toBe(2);
    expect((collector.extraVolumeMounts as unknown[]).length).toBe(2);
  });

  it('claims a real volume with a default size, with no ephemeral fallback', () => {
    // There is no "omit size for an emptyDir" path any more: enabling the
    // queue always renders a claim.
    expect(resolveQueue({}).size).toBe('10Gi');
    expect(resolveQueue({ size: '40Gi' }).size).toBe('40Gi');
    expect(renderPersistentQueueClaimSpec(resolveQueue({}))).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '10Gi' } },
    });
    expect(
      renderPersistentQueueClaimSpec(resolveQueue({ size: '5Gi', storageClassName: 'gp3' }))
    ).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '5Gi' } },
      storageClassName: 'gp3',
    });
  });

  it('pins the collector to one replica for a ReadWriteOnce claim', () => {
    const rwo = renderPersistentQueueValues(resolveQueue({}), 'c-otel-queue');
    expect((rwo['otel-collector'] as Record<string, unknown>).replicaCount).toBe(1);
  });

  it('leaves the replica count alone for a shareable (RWX) claim', () => {
    const shared = resolveQueue({ accessModes: ['ReadWriteMany'], storageClassName: 'efs-sc' });
    expect(shared.shared).toBe(true);
    const values = renderPersistentQueueValues(shared, 'c-otel-queue');
    expect((values['otel-collector'] as Record<string, unknown>).replicaCount).toBeUndefined();
    expect(renderPersistentQueueClaimSpec(shared).accessModes).toEqual(['ReadWriteMany']);
  });

  it('treats ReadWriteOncePod as NOT shareable — it is stricter than RWO', () => {
    expect(resolveQueue({ accessModes: ['ReadWriteOncePod'] }).shared).toBe(false);
  });

  it('rejects an empty access-mode list', () => {
    expect(() => resolveQueue({ accessModes: [] })).toThrow(/at least one access mode/);
  });

  it('derives the claim name from the release name, for mount and claim alike', () => {
    expect(clickStackQueueClaimName('clickstack')).toBe('clickstack-otel-queue');
  });
});

describe('makeClickstackBootstrap({ storage })', () => {
  it('renders the retention CronJob and keeps the collector overlay intact', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3',
      kind: 'ClickStackS3Bootstrap',
      storage: {
        mode: 's3',
        // `diskType: 's3'`, not `s3_plain_rewritable`: that metadata type is
        // immutable and refuses the retention ALTER (see the guard below).
        diskType: 's3',
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

  it('OWNS a PersistentVolumeClaim for the queue and mounts it by claimName', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-pvc',
      kind: 'ClickStackS3QueuePvc',
      storage: {
        mode: 's3',
        persistentQueue: { enabled: true, size: '25Gi', storageClassName: 'gp3' },
      },
    });
    const yaml = bootstrap.toYaml();

    // The claim is a resource of the composition, not a chart-templated
    // Pod-scoped volume.
    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('-otel-queue');
    expect(yaml).toContain('claimName:');
    expect(yaml).toContain('storage: 25Gi');
    expect(yaml).toContain('storageClassName: gp3');
    // The HelmRelease waits on the claim, so the collector's first Pod can
    // bind it.
    expect(yaml).toContain('typekro.dev/depends-on-clickstackQueueClaim');
    // The RWO claim pins the collector Deployment to one replica.
    expect(yaml).toContain('replicaCount: 1');

    // The two volume shapes Kubernetes deletes with the Pod must not appear in
    // the collector's own values. (`volumeClaimTemplates` legitimately appears
    // elsewhere in the document — the internal Mongo StatefulSet uses one.)
    const collectorValues = yaml.slice(
      yaml.indexOf('otel-collector:'),
      yaml.indexOf('- id: clickstackMongoService')
    );
    expect(collectorValues).toContain('claimName:');
    expect(collectorValues).not.toContain('emptyDir');
    expect(collectorValues).not.toContain('ephemeral');
    expect(collectorValues).not.toContain('volumeClaimTemplate');
  });

  it('renders NO queue claim when the queue is off', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-noqueue',
      kind: 'ClickStackS3NoQueue',
      storage: { mode: 's3' },
    });
    const yaml = bootstrap.toYaml();
    expect(yaml).not.toContain('kind: PersistentVolumeClaim');
    expect(yaml).not.toContain('-otel-queue');
  });

  it('rejects several collector replicas on a ReadWriteOnce queue at CONSTRUCTION', () => {
    // One RWO claim cannot back a multi-replica Deployment: the extra Pods
    // would wedge on Multi-Attach, or two collectors would write the same
    // file_storage directory.
    expect(() =>
      makeClickstackBootstrap({
        name: 'clickstack-s3-queue-replicas',
        kind: 'ClickStackS3QueueReplicas',
        storage: { mode: 's3', persistentQueue: { enabled: true } },
        values: { 'otel-collector': { replicaCount: 3 } },
      })
    ).toThrow(/must run\s+one replica|must run one replica/);
  });

  it('allows several collector replicas once the queue claim is ReadWriteMany', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-rwx',
      kind: 'ClickStackS3QueueRwx',
      storage: {
        mode: 's3',
        persistentQueue: { enabled: true, accessModes: ['ReadWriteMany'], storageClassName: 'efs' },
      },
      values: { 'otel-collector': { replicaCount: 3 } },
    });
    const yaml = bootstrap.toYaml();
    expect(yaml).toContain('ReadWriteMany');
    expect(yaml).toContain('replicaCount: 3');
  });

  it('does not constrain replicas when no queue is requested', () => {
    expect(() =>
      makeClickstackBootstrap({
        name: 'clickstack-s3-noqueue-replicas',
        kind: 'ClickStackS3NoQueueReplicas',
        storage: { mode: 's3' },
        values: { 'otel-collector': { replicaCount: 3 } },
      })
    ).not.toThrow();
  });

  it('surfaces storage next to the gateway endpoint on the status contract', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-status',
      kind: 'ClickStackS3Status',
      storage: {
        mode: 's3',
        diskType: 's3',
        policyName: 's3_main',
        retention: { logs: '30d' },
        persistentQueue: { enabled: true },
      },
    });
    const serialized = JSON.stringify(bootstrap.plan?.(SPEC, { strict: true }));

    expect(serialized).toContain('"key":"mode","value":{"kind":"literal","value":"s3"}');
    expect(serialized).toContain('"key":"diskType","value":{"kind":"literal","value":"s3"}');
    expect(serialized).toContain('"key":"persistentQueue","value":{"kind":"literal","value":true}');
  });

  it('still echoes s3_plain_rewritable on the status contract (without retention)', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-s3-status-pr',
      kind: 'ClickStackS3StatusPr',
      storage: {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        policyName: 's3_main',
        persistentQueue: { enabled: true },
      },
    });
    const serialized = JSON.stringify(bootstrap.plan?.(SPEC, { strict: true }));

    expect(serialized).toContain(
      '"key":"diskType","value":{"kind":"literal","value":"s3_plain_rewritable"}'
    );
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
