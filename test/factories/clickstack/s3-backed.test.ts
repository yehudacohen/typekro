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
import { type } from 'arktype';
import * as yaml from 'js-yaml';
import {
  CRONJOB_NAME_MAX_LENGTH,
  DNS_LABEL_MAX_LENGTH,
  deriveNameLengthLimit,
} from '../../../src/core/kubernetes/naming.js';
import { makeClickstackBootstrap } from '../../../src/factories/clickstack/compositions/clickstack-bootstrap.js';
import { CLICKSTACK_GATEWAY_NAME_SUFFIX } from '../../../src/factories/clickstack/resources/helm.js';
import {
  CLICKSTACK_GENERATED_NAMES,
  CLICKSTACK_NAME_LIMIT,
  CLICKSTACK_NAME_PATTERN,
  CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX,
  ClickStackBootstrapConfigSchema,
  type ClickStackPersistentQueueOptions,
  ClickStackReleaseNameSchema,
} from '../../../src/factories/clickstack/types.js';
import {
  type CollectorConfigFragment,
  mergeCollectorConfig,
  renderCollectorConfig,
} from '../../../src/factories/clickstack/utils/collector-config.js';
import {
  CLICKSTACK_INGEST_PIPELINES_CONFIG,
  CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
  mapClickStackConfigToHelmValues,
} from '../../../src/factories/clickstack/utils/helm-values-mapper.js';
import {
  CLICKSTACK_RETENTION_TABLES,
  DEFAULT_QUEUE_EXPORTER_NAMES,
  DEFAULT_QUEUE_FS_GROUP,
  clickStackQueueClaimName,
  normalizeRenderedTtl,
  parseRetentionDuration,
  persistentQueueConfigFragment,
  QUEUE_EXTENSION_NAME,
  QUEUE_FS_GROUP_CHANGE_POLICY,
  renderPersistentQueueClaimSpec,
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

/**
 * THE OVERLAY IS ONE YAML DOCUMENT — the defect these tests exist for.
 *
 * The overlay used to be two hand-written YAML strings concatenated. Both open
 * a top-level `service:` key, so the rendered `custom.config.yaml` declared
 * `service` twice and the OpAMP supervisor rejected the WHOLE file
 * (`yaml: unmarshal errors: … mapping key "service" already defined`), leaving
 * the agent with NEITHER the ingest pipelines nor the queue while the Pod
 * still reported Ready off the supervisor's own health_check.
 *
 * Every assertion below therefore PARSES the rendered document. A substring
 * probe is what let the duplicate key through in the first place: both
 * `service:` blocks were present, and `toContain` was delighted by each of
 * them.
 */
describe('the collector overlay is a single well-formed YAML document', () => {
  /** Parse the overlay the way the supervisor does — one document, strictly. */
  function parseOverlay(rendered: string): Record<string, unknown> {
    const documents = yaml.loadAll(rendered);
    // More than one document would mean a stray `---`; zero means empty.
    expect(documents.length).toBe(1);
    const parsed = documents[0];
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`overlay did not parse to a mapping: ${JSON.stringify(parsed)}`);
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Count top-level mapping keys in the RAW TEXT.
   *
   * `yaml.load` silently keeps the last of two duplicate keys, so parsing
   * alone cannot see the defect. Go's `yaml.v2` — which is what the OpAMP
   * supervisor uses — errors instead. This counts the raw column-0 keys so a
   * regression is caught the way the supervisor catches it.
   */
  function topLevelKeys(rendered: string): string[] {
    return rendered
      .split('\n')
      .filter((line) => /^[A-Za-z_][^\s:]*:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
  }

  function queueFor(options: Partial<ClickStackPersistentQueueOptions> = {}) {
    const resolved = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true, ...options },
    });
    if (resolved.persistentQueue === undefined) throw new Error('expected a queue');
    return resolved.persistentQueue;
  }

  function renderOverlay(options?: Partial<ClickStackPersistentQueueOptions>) {
    const fragments =
      options === undefined
        ? [CLICKSTACK_INGEST_PIPELINES_FRAGMENT]
        : [CLICKSTACK_INGEST_PIPELINES_FRAGMENT, persistentQueueConfigFragment(queueFor(options))];
    return renderCollectorConfig(fragments);
  }

  it('declares `service` EXACTLY ONCE with the queue enabled', () => {
    const rendered = renderOverlay({});
    const keys = topLevelKeys(rendered);

    expect(keys.filter((key) => key === 'service').length).toBe(1);
    // Every key is unique, not just `service`.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(['exporters', 'extensions', 'service']);
  });

  it('keeps BOTH contributions to `service` — pipelines and extensions', () => {
    const parsed = parseOverlay(renderOverlay({}));
    const service = parsed.service as Record<string, unknown>;

    // The ingest pipelines survived the merge…
    const pipelines = service.pipelines as Record<string, { receivers: string[] }>;
    expect(Object.keys(pipelines).sort()).toEqual(['logs/in', 'metrics', 'traces']);
    expect(pipelines['logs/in']?.receivers).toEqual(['fluentforward', 'otlp/hyperdx']);
    expect(pipelines.metrics?.receivers).toEqual(['prometheus', 'otlp/hyperdx']);
    expect(pipelines.traces?.receivers).toEqual(['nop', 'otlp/hyperdx']);
    // …and so did the queue's extension list, in the same mapping.
    expect(service.extensions).toEqual(['health_check', 'file_storage/hyperdx']);
  });

  it("declares the file_storage extension the exporters' queue references", () => {
    const parsed = parseOverlay(renderOverlay({}));
    const extensions = parsed.extensions as Record<string, Record<string, unknown>>;

    expect(Object.keys(extensions)).toEqual(['file_storage/hyperdx']);
    expect(extensions['file_storage/hyperdx']).toEqual({
      directory: '/var/lib/otelcol/file_storage',
      create_directory: true,
    });
    // `service.extensions` must NAME it, or the extension is never started and
    // the collector refuses a config whose exporters point at it.
    expect(parsed.service as { extensions: string[] }).toHaveProperty('extensions');
    expect((parsed.service as { extensions: string[] }).extensions).toContain(
      'file_storage/hyperdx'
    );
  });

  it('gives EVERY name in exporterNames its own sending_queue.storage', () => {
    const exporterNames = ['clickhouse', 'clickhouse/sessions', 'clickhouse/metrics'];
    const parsed = parseOverlay(renderOverlay({ exporterNames }));
    const exporters = parsed.exporters as Record<string, Record<string, unknown>>;

    expect(Object.keys(exporters).sort()).toEqual([...exporterNames].sort());
    for (const name of exporterNames) {
      expect(exporters[name]?.sending_queue).toEqual({
        enabled: true,
        storage: 'file_storage/hyperdx',
      });
    }
  });

  it('honors an overridden directory and extension list', () => {
    const parsed = parseOverlay(
      renderOverlay({
        directory: '/data/queue',
        extensions: ['health_check', 'opamp', 'file_storage/hyperdx'],
      })
    );

    expect(
      (parsed.extensions as Record<string, Record<string, unknown>>)['file_storage/hyperdx']
        ?.directory
    ).toBe('/data/queue');
    expect((parsed.service as { extensions: string[] }).extensions).toEqual([
      'health_check',
      'opamp',
      'file_storage/hyperdx',
    ]);
  });

  /**
   * DECIDED AND DOCUMENTED: an exporter name the agent does not define is
   * SURFACED, not rejected.
   *
   * It cannot be rejected here. The exporter set lives in the remote
   * configuration the OpAMP supervisor hands the agent — nothing this factory
   * renders knows it — so the only honest build-time behaviour is to carry the
   * operator's name through verbatim, document that it fails silently (the
   * `exporters` map grows an exporter no pipeline uses while the real one keeps
   * its in-memory queue), and assert the names against the agent's EFFECTIVE
   * configuration on a live cluster. `test/integration/clickstack/s3-backed.test.ts`
   * does exactly that.
   */
  it('carries an unknown exporter name through verbatim rather than guessing', () => {
    const parsed = parseOverlay(renderOverlay({ exporterNames: ['clickhouse/not-a-real-one'] }));
    const exporters = parsed.exporters as Record<string, Record<string, unknown>>;

    expect(Object.keys(exporters)).toEqual(['clickhouse/not-a-real-one']);
    // The default is the one name we CAN vouch for, and it is not silently
    // substituted for the operator's choice.
    expect(DEFAULT_QUEUE_EXPORTER_NAMES).toEqual(['clickhouse']);
    expect(Object.keys(exporters)).not.toContain('clickhouse');
  });

  it('rejects an empty exporterNames list at construction', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        mode: 's3',
        persistentQueue: { enabled: true, exporterNames: [] },
      })
    ).toThrow(/exporterNames' cannot be empty/);
  });

  it('rejects an extensions list that drops the file_storage extension', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        mode: 's3',
        persistentQueue: { enabled: true, extensions: ['health_check'] },
      })
    ).toThrow(/must include 'file_storage\/hyperdx'/);
  });

  it('renders IDENTICALLY to the hand-written overlay when no queue is configured', () => {
    // The queue fix must not churn the ConfigMap of every install that does
    // not enable the queue. This is the exact text the concatenating
    // implementation emitted, spelled out rather than derived.
    expect(renderOverlay()).toBe(
      [
        'service:',
        '  pipelines:',
        '    logs/in:',
        '      receivers: [fluentforward, otlp/hyperdx]',
        '    metrics:',
        '      receivers: [prometheus, otlp/hyperdx]',
        '    traces:',
        '      receivers: [nop, otlp/hyperdx]',
        '',
      ].join('\n')
    );
    // …and the exported constant is that same rendering.
    expect(CLICKSTACK_INGEST_PIPELINES_CONFIG).toBe(renderOverlay());
  });
});

describe('mergeCollectorConfig conflict policy', () => {
  it('merges mappings key by key', () => {
    expect(mergeCollectorConfig([{ a: { b: 1 } }, { a: { c: 2 } }])).toEqual({
      a: { b: 1, c: 2 },
    });
  });

  it('unions sequences in order, de-duplicating', () => {
    expect(
      mergeCollectorConfig([
        { service: { extensions: ['health_check', 'opamp'] } },
        { service: { extensions: ['opamp', 'file_storage/hyperdx'] } },
      ])
    ).toEqual({ service: { extensions: ['health_check', 'opamp', 'file_storage/hyperdx'] } });
  });

  it('keeps identical scalars', () => {
    expect(mergeCollectorConfig([{ a: { b: 'x' } }, { a: { b: 'x' } }])).toEqual({ a: { b: 'x' } });
  });

  it('THROWS on two fragments disagreeing about a scalar, naming the path', () => {
    expect(() =>
      mergeCollectorConfig([
        { extensions: { 'file_storage/hyperdx': { directory: '/a' } } },
        { extensions: { 'file_storage/hyperdx': { directory: '/b' } } },
      ])
    ).toThrow(/extensions\.file_storage\/hyperdx\.directory.*"\/a" vs "\/b"/);
  });

  it('THROWS when one fragment makes a key a mapping and another a scalar', () => {
    expect(() =>
      mergeCollectorConfig([{ service: { extensions: {} } }, { service: { extensions: ['a'] } }])
    ).toThrow(/Conflicting collector configuration at 'service\.extensions'/);
  });

  /**
   * REGRESSION: merging used to ADOPT an incoming sub-object by reference.
   *
   * `CLICKSTACK_INGEST_PIPELINES_FRAGMENT` is a module constant shared by every
   * composition in the process, so the queue's `service.extensions` was written
   * straight into it — and the NEXT install, queue or no queue, inherited the
   * previous one's overlay.
   */
  it('does not mutate its inputs, so a shared fragment constant stays clean', () => {
    const before = JSON.stringify(CLICKSTACK_INGEST_PIPELINES_FRAGMENT);
    const queue = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true, extensions: ['opamp', 'file_storage/hyperdx'] },
    }).persistentQueue;
    if (queue === undefined) throw new Error('expected a queue');

    renderCollectorConfig([
      CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
      persistentQueueConfigFragment(queue),
    ]);

    expect(JSON.stringify(CLICKSTACK_INGEST_PIPELINES_FRAGMENT)).toBe(before);
    // And a second render is byte-identical to the first — the pollution
    // showed up as drift between consecutive calls.
    const first = renderCollectorConfig([
      CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
      persistentQueueConfigFragment(queue),
    ]);
    const second = renderCollectorConfig([
      CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
      persistentQueueConfigFragment(queue),
    ]);
    expect(second).toBe(first);
    // …and the queue-free rendering is still the queue-free rendering.
    expect(renderCollectorConfig([CLICKSTACK_INGEST_PIPELINES_FRAGMENT])).toBe(
      CLICKSTACK_INGEST_PIPELINES_CONFIG
    );
  });

  it('never lets a merged document carry a duplicate top-level key', () => {
    const rendered = renderCollectorConfig([
      { service: { pipelines: { logs: { receivers: ['otlp'] } } } },
      { service: { extensions: ['health_check'] } },
      { extensions: { health_check: {} } },
    ]);
    const topLevel = rendered
      .split('\n')
      .filter((line) => /^[A-Za-z_][^\s:]*:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));

    expect(new Set(topLevel).size).toBe(topLevel.length);
  });
});

/**
 * REGRESSION: the merge used to write straight into `Object.prototype`.
 *
 * `mergeInto` tested `key in target`, and `'__proto__' in {}` is TRUE — it is
 * an accessor inherited from `Object.prototype`. So the "already present, merge
 * into it" branch read `target.__proto__` (which IS `Object.prototype`), saw a
 * mapping on both sides, and recursed into it. One fragment with a top-level
 * `__proto__` key mutated every object in the process.
 *
 * The exporter map hit the accessor's other half: `Object.fromEntries` defines
 * an own property rather than polluting, but the merge's CLONE then assigned
 * `copy[key] = …` onto a plain `{}`, where `__proto__` calls the inherited
 * SETTER and re-parents the copy instead of adding a key. An
 * `exporterNames: ['__proto__']` install rendered `exporters: {}` and the queue
 * silently configured nothing.
 *
 * Each case asserts BOTH that the construction is refused with the path named
 * AND that `Object.prototype` is untouched afterwards.
 */
describe('collector overlay keys cannot reach the object model', () => {
  /** A fragment with a genuine OWN `__proto__` key — a literal cannot make one. */
  function withOwnProtoKey(value: unknown, path: readonly string[] = []): CollectorConfigFragment {
    const leaf = Object.create(null) as Record<string, unknown>;
    leaf.__proto__ = value;
    return path.reduceRight<Record<string, unknown>>(
      (inner, segment) => ({ [segment]: inner }),
      leaf
    );
  }

  /** Nothing in this describe block may leave a mark on Object.prototype. */
  function expectPrototypeClean() {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  }

  it('sanity-checks the fixture: the fragment really carries an own __proto__ key', () => {
    const fragment = withOwnProtoKey({ polluted: 'yes' });
    expect(Object.getOwnPropertyNames(fragment)).toEqual(['__proto__']);
    expect(Object.keys(fragment)).toEqual(['__proto__']);
  });

  it('REFUSES a top-level __proto__ key, naming the path, and leaves the prototype alone', () => {
    expect(() => mergeCollectorConfig([withOwnProtoKey({ polluted: 'yes' })])).toThrow(
      /Unsafe collector configuration key at '__proto__'/
    );
    expectPrototypeClean();
  });

  it('REFUSES a NESTED __proto__ key, naming the full path', () => {
    // Nested under a key another fragment already contributed, so the merge
    // takes the "already present" branch — the one that used to recurse into
    // `Object.prototype`.
    expect(() =>
      mergeCollectorConfig([
        { service: { pipelines: { logs: { receivers: ['otlp'] } } } },
        withOwnProtoKey({ polluted: 'yes' }, ['service', 'pipelines']),
      ])
    ).toThrow(/Unsafe collector configuration key at 'service\.pipelines\.__proto__'/);
    expectPrototypeClean();
  });

  it('REFUSES __proto__ inside a sequence item, too', () => {
    expect(() =>
      mergeCollectorConfig([
        { processors: [withOwnProtoKey({ polluted: 'yes' })] },
        { processors: ['batch'] },
      ])
    ).toThrow(/Unsafe collector configuration key at 'processors\.0\.__proto__'/);
    expectPrototypeClean();
  });

  it('REFUSES `constructor` and `prototype` as mapping keys as well', () => {
    expect(() => mergeCollectorConfig([{ exporters: { constructor: {} } }])).toThrow(
      /Unsafe collector configuration key at 'exporters\.constructor'/
    );
    expect(() => mergeCollectorConfig([{ exporters: { prototype: {} } }])).toThrow(
      /Unsafe collector configuration key at 'exporters\.prototype'/
    );
    expectPrototypeClean();
  });

  it('REFUSES an exporterNames entry that names an object-model member', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(() =>
        resolveClickStackStorage('makeClickstackBootstrap', {
          mode: 's3',
          persistentQueue: { enabled: true, exporterNames: [name] },
        })
      ).toThrow(
        new RegExp(
          `'storage\\.persistentQueue\\.exporterNames\\[0\\]' is "${name}"`.replace(/[$]/g, '\\$')
        )
      );
    }
    expectPrototypeClean();
  });

  it('REFUSES an extensions entry that names an object-model member', () => {
    expect(() =>
      resolveClickStackStorage('makeClickstackBootstrap', {
        mode: 's3',
        persistentQueue: {
          enabled: true,
          extensions: ['file_storage/hyperdx', '__proto__'],
        },
      })
    ).toThrow(/'storage\.persistentQueue\.extensions\[1\]' is "__proto__"/);
    expectPrototypeClean();
  });

  /**
   * The resolver is not the only door: `persistentQueueConfigFragment` is
   * exported and takes a resolved object, which a caller can hand-build.
   */
  it('REFUSES the name again in persistentQueueConfigFragment itself', () => {
    expect(() =>
      persistentQueueConfigFragment({
        directory: '/var/lib/otelcol/file_storage',
        size: '10Gi',
        fsGroup: 10001,
        accessModes: ['ReadWriteOnce'],
        exporterNames: ['__proto__'],
        extensions: ['health_check', 'file_storage/hyperdx'],
      })
    ).toThrow(/Unsafe collector configuration key at 'exporters\.__proto__'/);
    expectPrototypeClean();
  });

  it('builds every mapping in the merged result WITHOUT a prototype', () => {
    const merged = mergeCollectorConfig([
      CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
      { exporters: { clickhouse: { sending_queue: { enabled: true } } } },
    ]);

    expect(Object.getPrototypeOf(merged)).toBeNull();
    const service = merged.service as Record<string, unknown>;
    expect(Object.getPrototypeOf(service)).toBeNull();
    expect(Object.getPrototypeOf(service.pipelines as object)).toBeNull();
    // So `__proto__` is a plain missing key on the result, not an accessor.
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
    expect((merged as Record<string, unknown>).__proto__).toBeUndefined();
  });

  /**
   * Where the danger is NOT: js-yaml. On the default schema `dump` emits a
   * `__proto__` key and `load` reads it back as an ordinary own property
   * without touching `Object.prototype`, so the document round-trips
   * faithfully both ways. Pinned here because the fix is placed on the
   * assumption that the serialiser is innocent and our own merge was not.
   */
  it('pins js-yaml as SAFE in both directions, which is why the guard sits upstream', () => {
    const loaded = yaml.load('__proto__:\n  polluted: yes\n') as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(loaded)).toEqual(['__proto__']);
    expectPrototypeClean();

    const dumpable = Object.create(null) as Record<string, unknown>;
    dumpable.__proto__ = { polluted: 'yes' };
    dumpable.keep = 1;
    expect(yaml.dump(dumpable)).toBe("__proto__:\n  polluted: 'yes'\nkeep: 1\n");
    expectPrototypeClean();
  });

  it('renders a document that contains no __proto__ key, and re-loads clean', () => {
    const queue = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true, exporterNames: ['clickhouse', 'clickhouse/2'] },
    }).persistentQueue;
    if (queue === undefined) throw new Error('expected a queue');
    const rendered = renderCollectorConfig([
      CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
      persistentQueueConfigFragment(queue),
    ]);

    expect(rendered).not.toContain('__proto__');
    expect(rendered).not.toContain('constructor');

    const reloaded = yaml.load(rendered) as Record<string, unknown>;
    const exporters = reloaded.exporters as Record<string, unknown>;
    // The whole point of the guard: every requested exporter SURVIVED the
    // round trip, instead of an `exporters: {}` nobody noticed.
    expect(Object.keys(exporters).sort()).toEqual(['clickhouse', 'clickhouse/2']);
    expectPrototypeClean();
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

  it('pins the collector to one replica, unconditionally', () => {
    // Not a property of the volume: the queue is a bbolt database under an
    // exclusive file lock, so there is no configuration in which a second
    // collector may open it.
    const values = renderPersistentQueueValues(resolveQueue({}), 'c-otel-queue');
    expect((values['otel-collector'] as Record<string, unknown>).replicaCount).toBe(1);
    expect(
      (
        renderPersistentQueueValues(
          resolveQueue({ size: '40Gi', storageClassName: 'gp3' }),
          'c-otel-queue'
        )['otel-collector'] as Record<string, unknown>
      ).replicaCount
    ).toBe(1);
  });

  it('forces Recreate, because one replica does not bound a ROLLOUT', () => {
    // `replicaCount: 1` bounds the steady state only. The chart leaves the
    // Deployment on RollingUpdate, whose default maxSurge rounds up to one
    // extra Pod, so an upgrade creates the replacement while the old collector
    // still holds the RWO claim and the bbolt lock. On another node the new Pod
    // is stuck on Multi-Attach and RollingUpdate will not terminate the old one
    // until it is Ready, so the rollout deadlocks; on the same node it starts
    // and reports Ready off the supervisor's health_check while its
    // file_storage extension cannot take the lock. Recreate drains first.
    const values = renderPersistentQueueValues(resolveQueue({}), 'c-otel-queue');
    const collector = values['otel-collector'] as Record<string, unknown>;
    expect(collector.rollout).toEqual({ strategy: 'Recreate' });

    // No `rollingUpdate` key travels with it: the chart's Deployment template
    // emits that block only on the RollingUpdate branch, and the API server
    // rejects a Recreate strategy that carries one.
    expect(collector.rollout).not.toHaveProperty('rollingUpdate');

    // Independent of every queue knob — it is a property of the single-writer
    // queue itself, not of the volume's size or class.
    expect(
      (
        renderPersistentQueueValues(
          resolveQueue({ size: '40Gi', storageClassName: 'gp3' }),
          'c-otel-queue'
        )['otel-collector'] as Record<string, unknown>
      ).rollout
    ).toEqual({ strategy: 'Recreate' });
  });

  it('offers NO access-mode knob — the claim is always ReadWriteOnce', () => {
    // The RWX escape hatch is gone: a shared filesystem hands every replica
    // the same locked bbolt database, so it never bought multi-replica ingest.
    expect(resolveQueue({}).accessModes).toEqual(['ReadWriteOnce']);
    // An accessModes value is not part of the option type any more, and is
    // ignored rather than honoured if one is smuggled through at runtime.
    expect(resolveQueue({ accessModes: ['ReadWriteMany'] }).accessModes).toEqual(['ReadWriteOnce']);
    expect(renderPersistentQueueClaimSpec(resolveQueue({})).accessModes).toEqual(['ReadWriteOnce']);
  });

  it('derives the claim name from the release name, for mount and claim alike', () => {
    expect(clickStackQueueClaimName('clickstack')).toBe('clickstack-otel-queue');
  });

  // LIVE FINDING (#222): on a block PVC (the AWS EBS CSI default StorageClass)
  // the fresh filesystem is root:root 0755, the collector runs as uid/gid
  // 10001, and nothing chowns the mount — so the exporter fails to start with
  // `open …/file_storage/exporter_clickhouse__logs: permission denied` and the
  // gateway crash-loops. The chart's gateway is the aliased
  // opentelemetry-collector subchart, which renders its `podSecurityContext`
  // value into the Deployment verbatim — so that VALUE is the seam. #223 first
  // shipped a Kustomize post-renderer targeting `<release>-otel-collector`
  // on the mistaken premise that no value could carry it; the chart also
  // truncates that name at 63, so the patch silently missed long releases.
  it('makes the queue volume writable: podSecurityContext.fsGroup on the otel-collector values', () => {
    const values = renderPersistentQueueValues(resolveQueue({}), 'clickstack-otel-queue');
    const collector = values['otel-collector'] as Record<string, unknown>;

    expect(collector.podSecurityContext).toEqual({
      fsGroup: 10001,
      // Skip the recursive chown once the root already carries the group: the
      // queue directory can hold gigabytes of bbolt pages.
      fsGroupChangePolicy: 'OnRootMismatch',
    });
    expect(QUEUE_FS_GROUP_CHANGE_POLICY).toBe('OnRootMismatch');
    // A value, not a patch: nothing here names the gateway Deployment, so
    // nothing here can miss it.
    expect(JSON.stringify(values)).not.toContain('-otel-collector');
    expect(JSON.stringify(values)).not.toContain('postRenderers');
  });

  it("defaults fsGroup to the collector image's otel group (10001) and honours an override", () => {
    expect(DEFAULT_QUEUE_FS_GROUP).toBe(10001);
    expect(resolveQueue({}).fsGroup).toBe(10001);
    expect(resolveQueue({ fsGroup: 2000 }).fsGroup).toBe(2000);

    const custom = renderPersistentQueueValues(resolveQueue({ fsGroup: 2000 }), 'c-otel-queue');
    expect((custom['otel-collector'] as Record<string, unknown>).podSecurityContext).toEqual({
      fsGroup: 2000,
      fsGroupChangePolicy: 'OnRootMismatch',
    });
  });

  it('accepts fsGroup 0 — the root group, which Kubernetes does not forbid', () => {
    expect(resolveQueue({ fsGroup: 0 }).fsGroup).toBe(0);
    const root = renderPersistentQueueValues(resolveQueue({ fsGroup: 0 }), 'c-otel-queue');
    expect(
      (root['otel-collector'] as { podSecurityContext: { fsGroup: unknown } }).podSecurityContext
        .fsGroup
    ).toBe(0);
  });

  it('rejects an fsGroup that is not a non-negative SAFE integer, naming the option', () => {
    // `fsGroup` is an int64 on the Pod spec. `Number.isInteger(1e20)` is true,
    // so the guard has to be `isSafeInteger` — 1e20 is neither a representable
    // int64 nor a GID any kubelet applies.
    for (const fsGroup of [-1, 1.5, Number.NaN, 1e20, 2 ** 53, Number.POSITIVE_INFINITY]) {
      expect(() => resolveQueue({ fsGroup })).toThrow(
        /'storage\.persistentQueue\.fsGroup' must be a non-negative integer/
      );
    }
    // Validated only when the queue is on — an unused option is not an error,
    // consistent with `exporterNames` / `extensions`.
    expect(
      resolveClickStackStorage('t', {
        mode: 's3',
        persistentQueue: { enabled: false, fsGroup: -1 },
      }).persistentQueue
    ).toBeUndefined();
  });
});

/** The `clickstackHelmRelease` template `spec` from a serialized RGD bundle (`composition.toYaml()`). */
function helmReleaseSpec(rgdYaml: string): {
  values?: Record<string, unknown>;
  postRenderers?: unknown[];
} {
  for (const document of yaml.loadAll(rgdYaml) as Array<{
    kind?: string;
    spec?: {
      resources?: Array<{
        id?: string;
        template?: { spec?: { values?: Record<string, unknown>; postRenderers?: unknown[] } };
      }>;
    };
  }>) {
    if (document?.kind !== 'ResourceGraphDefinition') continue;
    const release = document.spec?.resources?.find(
      (resource) => resource.id === 'clickstackHelmRelease'
    );
    if (release?.template?.spec !== undefined) return release.template.spec;
  }
  throw new Error('expected an RGD carrying the clickstackHelmRelease resource');
}

/** `otel-collector.podSecurityContext` of a HelmRelease's values, or `undefined`. */
function collectorPodSecurityContext(spec: {
  values?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  return (spec.values?.['otel-collector'] as { podSecurityContext?: Record<string, unknown> })
    ?.podSecurityContext;
}

const CALLER_POST_RENDERER = {
  kustomize: {
    patches: [
      {
        target: { kind: 'Deployment', name: 'clickstack' },
        patch: 'metadata:\n  annotations:\n    example.com/owner: platform\n',
      },
    ],
  },
};

describe('the queue volume is writable by the collector (#222)', () => {
  it('pins otel-collector.podSecurityContext in the KRO RGD values — and emits NO post-renderer', () => {
    const yamlText = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-fsgroup',
      kind: 'ClickStackS3QueueFsGroup',
      storage: { mode: 's3', persistentQueue: { enabled: true } },
    }).toYaml();

    expect(yamlText).toContain('podSecurityContext:');
    expect(yamlText).toContain('fsGroup: 10001');
    expect(yamlText).toContain('fsGroupChangePolicy: OnRootMismatch');
    expect(yamlText).not.toContain('postRenderers');

    const spec = helmReleaseSpec(yamlText);
    expect(collectorPodSecurityContext(spec)).toEqual({
      fsGroup: 10001,
      fsGroupChangePolicy: 'OnRootMismatch',
    });
    expect(spec.postRenderers).toBeUndefined();
    // The values never mention the gateway name: the chart truncates
    // `<release>-otel-collector` at 63 characters, and a value cannot miss.
    expect(JSON.stringify(spec.values)).not.toContain('-otel-collector');
  });

  it('renders NO podSecurityContext and NO post-renderer when the queue is off', () => {
    const yamlText = makeClickstackBootstrap({
      name: 'clickstack-s3-noqueue-fsgroup',
      kind: 'ClickStackS3NoQueueFsGroup',
      storage: { mode: 's3' },
    }).toYaml();

    expect(yamlText).not.toContain('postRenderers');
    expect(yamlText).not.toContain('fsGroup');
    expect(yamlText).not.toContain('podSecurityContext');
    const spec = helmReleaseSpec(yamlText);
    expect(collectorPodSecurityContext(spec)).toBeUndefined();
    expect(spec.postRenderers).toBeUndefined();
  });

  it('honours a custom fsGroup', () => {
    const yamlText = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-fsgroup-custom',
      kind: 'ClickStackS3QueueFsGroupCustom',
      storage: { mode: 's3', persistentQueue: { enabled: true, fsGroup: 2000 } },
    }).toYaml();

    expect(yamlText).toContain('fsGroup: 2000');
    expect(yamlText).not.toContain('fsGroup: 10001');
    expect(collectorPodSecurityContext(helmReleaseSpec(yamlText))).toEqual({
      fsGroup: 2000,
      fsGroupChangePolicy: 'OnRootMismatch',
    });
  });

  it('lets build-time values ADD podSecurityContext fields but never change the queue-owned two', () => {
    // The pin sits in the mapper's hard pins, applied LAST with a recursive
    // merge: the caller's `runAsNonRoot`/`seccompProfile` survive alongside
    // it, while `fsGroup`/`fsGroupChangePolicy` are TypeKro's.
    const spec = helmReleaseSpec(
      makeClickstackBootstrap({
        name: 'clickstack-s3-queue-fsgroup-values',
        kind: 'ClickStackS3QueueFsGroupValues',
        storage: { mode: 's3', persistentQueue: { enabled: true } },
        values: {
          'otel-collector': {
            podSecurityContext: {
              fsGroup: 5,
              fsGroupChangePolicy: 'Always',
              runAsNonRoot: true,
              seccompProfile: { type: 'RuntimeDefault' },
            },
          },
        },
      }).toYaml()
    );
    expect(collectorPodSecurityContext(spec)).toEqual({
      fsGroup: 10001,
      fsGroupChangePolicy: 'OnRootMismatch',
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });

    // Without a queue there is no pin, and the caller's block is theirs.
    const unpinned = helmReleaseSpec(
      makeClickstackBootstrap({
        name: 'clickstack-s3-noqueue-fsgroup-values',
        kind: 'ClickStackS3NoQueueFsGroupValues',
        storage: { mode: 's3' },
        values: { 'otel-collector': { podSecurityContext: { fsGroup: 5, runAsNonRoot: true } } },
      }).toYaml()
    );
    expect(collectorPodSecurityContext(unpinned)).toEqual({ fsGroup: 5, runAsNonRoot: true });
  });

  it('lets direct-mode customValues ADD podSecurityContext fields but never change the queue-owned two', () => {
    // Same precedence through the REAL mapper path: typed mapping <
    // build-time `values` < concrete `customValues` < hard pins.
    const storage = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true },
    });
    const values = mapClickStackConfigToHelmValues(
      {
        ...SPEC,
        customValues: {
          'otel-collector': {
            podSecurityContext: { fsGroup: 7, fsGroupChangePolicy: 'Always', runAsUser: 10001 },
          },
        },
      },
      {
        storage,
        values: { 'otel-collector': { podSecurityContext: { fsGroup: 5, runAsNonRoot: true } } },
      }
    ) as Record<string, unknown>;

    expect(collectorPodSecurityContext({ values })).toEqual({
      fsGroup: 10001,
      fsGroupChangePolicy: 'OnRootMismatch',
      runAsNonRoot: true,
      runAsUser: 10001,
    });
  });

  it('passes caller-supplied postRenderers through UNCHANGED and adds none of its own', () => {
    // #223 appended a queue patch after the caller's entries; the fsGroup now
    // travels as a value, so the caller's list is the whole list.
    const withQueue = helmReleaseSpec(
      makeClickstackBootstrap({
        name: 'clickstack-s3-queue-fsgroup-caller',
        kind: 'ClickStackS3QueueFsGroupCaller',
        storage: { mode: 's3', persistentQueue: { enabled: true } },
        postRenderers: [CALLER_POST_RENDERER],
      }).toYaml()
    );
    expect(withQueue.postRenderers).toEqual([CALLER_POST_RENDERER]);
    expect(collectorPodSecurityContext(withQueue)?.fsGroup).toBe(10001);

    const withoutQueue = helmReleaseSpec(
      makeClickstackBootstrap({
        name: 'clickstack-s3-noqueue-fsgroup-caller',
        kind: 'ClickStackS3NoQueueFsGroupCaller',
        storage: { mode: 's3' },
        postRenderers: [CALLER_POST_RENDERER],
      }).toYaml()
    );
    expect(withoutQueue.postRenderers).toEqual([CALLER_POST_RENDERER]);
  });

  it('rejects an invalid fsGroup at CONSTRUCTION time, and accepts 0', () => {
    for (const fsGroup of [-1, 1.5, 1e20]) {
      expect(() =>
        makeClickstackBootstrap({
          storage: { mode: 's3', persistentQueue: { enabled: true, fsGroup } },
        })
      ).toThrow(/'storage\.persistentQueue\.fsGroup' must be a non-negative integer/);
    }
    expect(() =>
      makeClickstackBootstrap({
        storage: { mode: 's3', persistentQueue: { enabled: true, fsGroup: 0 } },
      })
    ).not.toThrow();
  });

  it('rejects a schema reference in build-time postRenderers, like every build-time option', () => {
    expect(() =>
      makeClickstackBootstrap({
        postRenderers: [
          {
            kustomize: {
              patches: [
                {
                  target: {
                    kind: 'Deployment',
                    name: {
                      [KUBERNETES_REF_BRAND]: true,
                      resourceId: '__schema__',
                      fieldPath: 'spec.name',
                    } as unknown as string,
                  },
                  patch: 'a: b',
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/build-time options contain a schema\/resource reference/);
  });
});

describe('the release name is bounded so every name derived from it fits (#222 follow-up)', () => {
  // The chart names the gateway Deployment and Service
  // `printf "%s-%s" .Release.Name "otel-collector" | trunc 63 | trimSuffix "-"`,
  // while the status contract assumes the LITERAL `<name>-otel-collector` —
  // so past 48 characters the endpoints would name a Service that does not
  // exist. Fixing that in CEL is not contained (KRO status CEL would have to
  // reproduce trunc/trimSuffix), and it is not even the tightest bound: the
  // `<name>-team-bootstrap` CronJob is refused by the API server past 52
  // characters. So the runtime `name` is bounded instead, by derivation.
  const GATEWAY_CONSTRAINT = CLICKSTACK_GENERATED_NAMES.find(
    (constraint) => 'suffix' in constraint && constraint.suffix === CLICKSTACK_GATEWAY_NAME_SUFFIX
  );
  const LONG_NAME = 'a'.repeat(49);
  /** ArkType returns its errors (not an `Error` subclass) instead of throwing. */
  const rejects = (result: unknown): boolean =>
    typeof result === 'object' &&
    result !== null &&
    (result as { ' arkKind'?: unknown })[' arkKind'] === 'errors';

  it('binds on the Team-bootstrap CronJob: 52 minus its 15-character suffix', () => {
    expect(CLICKSTACK_NAME_LIMIT.maxLength).toBe(
      CRONJOB_NAME_MAX_LENGTH - CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX.length
    );
    expect(CLICKSTACK_NAME_LIMIT.maxLength).toBe(37);
    expect(CLICKSTACK_NAME_LIMIT.binding.suffix).toBe(CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX);
    expect(CLICKSTACK_NAME_LIMIT.message).toContain('37');
    expect(CLICKSTACK_NAME_LIMIT.message).toContain('team-bootstrap');
  });

  it('documents the gateway truncation gap: 63 minus `-otel-collector` is 48, and every accepted name fits', () => {
    if (GATEWAY_CONSTRAINT === undefined) throw new Error('expected the gateway constraint');
    expect(deriveNameLengthLimit([GATEWAY_CONSTRAINT]).maxLength).toBe(
      DNS_LABEL_MAX_LENGTH - CLICKSTACK_GATEWAY_NAME_SUFFIX.length
    );
    expect(deriveNameLengthLimit([GATEWAY_CONSTRAINT]).maxLength).toBe(48);
    // A 49-character release would be truncated by the chart…
    expect(`${LONG_NAME}${CLICKSTACK_GATEWAY_NAME_SUFFIX}`.length).toBeGreaterThan(
      DNS_LABEL_MAX_LENGTH
    );
    // …and every name the schema accepts renders the literal untruncated, so
    // `status.gateway.*Endpoint` always names the real Service.
    expect(
      CLICKSTACK_NAME_LIMIT.maxLength + CLICKSTACK_GATEWAY_NAME_SUFFIX.length
    ).toBeLessThanOrEqual(DNS_LABEL_MAX_LENGTH);
  });

  it('renders the values-based fsGroup identically for a 49-character release name', () => {
    // The pin is a value under the subchart alias — it never names the
    // Deployment, so the length of the release name cannot make it miss.
    const storage = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true },
    });
    const short = mapClickStackConfigToHelmValues(SPEC, { storage }) as Record<string, unknown>;
    const long = mapClickStackConfigToHelmValues(
      { ...SPEC, name: LONG_NAME },
      { storage }
    ) as Record<string, unknown>;

    const shortContext = collectorPodSecurityContext({ values: short });
    if (shortContext === undefined) throw new Error('expected a podSecurityContext pin');
    expect(collectorPodSecurityContext({ values: long })).toEqual(shortContext);
    expect(collectorPodSecurityContext({ values: long })).toEqual({
      fsGroup: 10001,
      fsGroupChangePolicy: 'OnRootMismatch',
    });
    expect(long.fullnameOverride).toBe(LONG_NAME);
    expect(JSON.stringify(long['otel-collector'])).not.toContain('-otel-collector');
  });

  it('rejects a 49-character name in the runtime schema and serializes the bound into the RGD', () => {
    const rejected = ClickStackBootstrapConfigSchema({
      ...SPEC,
      name: LONG_NAME,
    }) as unknown;
    expect(rejects(rejected)).toBe(true);
    expect(String(rejected)).toContain('at most 37 characters');
    expect(String(rejected)).toContain('team-bootstrap');

    const atLimit = ClickStackBootstrapConfigSchema({
      ...SPEC,
      name: 'a'.repeat(CLICKSTACK_NAME_LIMIT.maxLength),
    }) as unknown;
    expect(rejects(atLimit)).toBe(false);

    const rgd = makeClickstackBootstrap({
      name: 'clickstack-s3-name-bound',
      kind: 'ClickStackS3NameBound',
      storage: { mode: 's3', persistentQueue: { enabled: true } },
    }).toYaml();
    expect(rgd).toContain(`name: string | maxLength=${CLICKSTACK_NAME_LIMIT.maxLength}`);
  });

  it('refuses a 49-character concrete name in direct-mode toYaml with the same message', () => {
    const factory = makeClickstackBootstrap({
      storage: { mode: 's3', persistentQueue: { enabled: true } },
    }).factory('direct', { namespace: SPEC.namespace });

    expect(() => factory.toYaml({ ...SPEC, name: LONG_NAME } as never)).toThrow(
      /at most 37 characters, because the Team-bootstrap CronJob/
    );

    const atLimit = factory.toYaml({
      ...SPEC,
      name: 'a'.repeat(CLICKSTACK_NAME_LIMIT.maxLength),
    } as never);
    expect(atLimit).toContain('fsGroup: 10001');
    expect(atLimit).toContain(`${'a'.repeat(CLICKSTACK_NAME_LIMIT.maxLength)}-team-bootstrap`);
  });

  describe('the boundary: exactly 37 characters is accepted, 38 is rejected, on every path', () => {
    const AT_LIMIT = 'a'.repeat(CLICKSTACK_NAME_LIMIT.maxLength);
    const ONE_OVER = 'a'.repeat(CLICKSTACK_NAME_LIMIT.maxLength + 1);
    const directFactory = () =>
      makeClickstackBootstrap({
        storage: { mode: 's3', persistentQueue: { enabled: true } },
      }).factory('direct', { namespace: SPEC.namespace });

    it('KRO schema', () => {
      expect(AT_LIMIT.length).toBe(37);
      expect(rejects(ClickStackBootstrapConfigSchema({ ...SPEC, name: AT_LIMIT }))).toBe(false);
      const rejected = ClickStackBootstrapConfigSchema({ ...SPEC, name: ONE_OVER }) as unknown;
      expect(rejects(rejected)).toBe(true);
      expect(String(rejected)).toContain('at most 37 characters');
      expect(String(rejected)).toContain('team-bootstrap');
    });

    it('direct-mode deploy (validateSpec runs before any cluster access)', async () => {
      await expect(directFactory().deploy({ ...SPEC, name: ONE_OVER } as never)).rejects.toThrow(
        /Invalid spec: .*at most 37 characters, because the Team-bootstrap CronJob/
      );
    });

    it('direct-mode toYaml', () => {
      const factory = directFactory();
      expect(() => factory.toYaml({ ...SPEC, name: ONE_OVER } as never)).toThrow(
        /at most 37 characters, because the Team-bootstrap CronJob/
      );
      expect(factory.toYaml({ ...SPEC, name: AT_LIMIT } as never)).toContain(
        `${AT_LIMIT}-team-bootstrap`
      );
    });
  });

  describe('the name must be a DNS label, not merely short enough', () => {
    // Every derived object is a Kubernetes name, so a release name the API
    // server would refuse must be refused up front — the length bound alone
    // let these through and they failed downstream at create time.
    const MALFORMED = ['', 'Foo', 'foo_bar', 'foo/bar', '-leading', 'trailing-', 'dot.ted'] as const;
    const directFactory = () =>
      makeClickstackBootstrap({
        storage: { mode: 's3', persistentQueue: { enabled: true } },
      }).factory('direct', { namespace: SPEC.namespace });

    it('is the Traefik bootstrap pattern, unflagged, and serialized into the RGD next to the bound', () => {
      expect(CLICKSTACK_NAME_PATTERN.source).toBe('^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$');
      expect(CLICKSTACK_NAME_PATTERN.flags).toBe('');
      const rgd = makeClickstackBootstrap({
        name: 'clickstack-s3-name-pattern',
        kind: 'ClickStackS3NamePattern',
        storage: { mode: 's3', persistentQueue: { enabled: true } },
      }).toYaml();
      expect(rgd).toContain(
        `name: string | maxLength=${CLICKSTACK_NAME_LIMIT.maxLength} pattern="${CLICKSTACK_NAME_PATTERN.source}"`
      );
    });

    it('KRO schema: rejects every malformed name and names the pattern; accepts a well-formed one', () => {
      for (const name of MALFORMED) {
        expect(name.length).toBeLessThanOrEqual(CLICKSTACK_NAME_LIMIT.maxLength);
        const rejected = ClickStackBootstrapConfigSchema({ ...SPEC, name }) as unknown;
        expect(rejects(rejected), JSON.stringify(name)).toBe(true);
        expect(String(rejected), JSON.stringify(name)).toContain('must be matched by');
      }
      expect(rejects(ClickStackBootstrapConfigSchema({ ...SPEC, name: 'click-stack-01' }))).toBe(
        false
      );
    });

    it('direct-mode deploy: rejects every malformed name through the schema', async () => {
      for (const name of MALFORMED) {
        await expect(
          directFactory().deploy({ ...SPEC, name } as never),
          JSON.stringify(name)
        ).rejects.toThrow(/Invalid spec: .*must be matched by/);
      }
    });

    it('direct-mode toYaml: rejects every malformed name with the SAME message as the schema', () => {
      const factory = directFactory();
      for (const name of MALFORMED) {
        const schemaResult = ClickStackReleaseNameSchema(name);
        if (!(schemaResult instanceof type.errors)) {
          throw new Error(`expected the schema to reject ${JSON.stringify(name)}`);
        }
        expect(() => factory.toYaml({ ...SPEC, name } as never), JSON.stringify(name)).toThrow(
          `ClickStack release name ${JSON.stringify(name)} is invalid: ${schemaResult.summary}`
        );
      }
      expect(factory.toYaml({ ...SPEC, name: 'click-stack-01' } as never)).toContain(
        'click-stack-01-team-bootstrap'
      );
    });
  });
});

describe('the persistent queue cannot outlive a disabled collector', () => {
  // `{ 'otel-collector': { enabled: false } }` with the queue on used to render
  // a HelmRelease with no collector but with the claim, the `file_storage`
  // extension and `persistentQueue: true` in the contract — a queue nothing
  // writes to. `enabled: true` is queue-owned like `replicaCount` and `rollout`.
  const collectorEnabled = (spec: { values?: Record<string, unknown> }): unknown =>
    (spec.values?.['otel-collector'] as { enabled?: unknown } | undefined)?.enabled;

  it('renderPersistentQueueValues pins otel-collector.enabled: true with the other invariants', () => {
    const storage = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true },
    });
    if (storage.persistentQueue === undefined) throw new Error('expected a resolved queue');
    const values = renderPersistentQueueValues(storage.persistentQueue, 'claim')['otel-collector'] as {
      enabled?: unknown;
      replicaCount?: unknown;
      rollout?: unknown;
    };
    expect(values.enabled).toBe(true);
    expect(values.replicaCount).toBe(1);
    expect(values.rollout).toEqual({ strategy: 'Recreate' });
  });

  it('through the real mapper path, build-time values and direct customValues cannot disable the collector', () => {
    const storage = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true },
    });
    const fromBuildTimeValues = mapClickStackConfigToHelmValues(SPEC, {
      storage,
      values: { 'otel-collector': { enabled: false } },
    }) as Record<string, unknown>;
    expect(collectorEnabled({ values: fromBuildTimeValues })).toBe(true);

    const fromCustomValues = mapClickStackConfigToHelmValues(
      { ...SPEC, customValues: { 'otel-collector': { enabled: false } } },
      { storage, values: { 'otel-collector': { enabled: false } } }
    ) as Record<string, unknown>;
    expect(collectorEnabled({ values: fromCustomValues })).toBe(true);
    // The pin is surgical: unrelated caller keys under the alias survive.
    const withOtherKeys = mapClickStackConfigToHelmValues(SPEC, {
      storage,
      values: { 'otel-collector': { enabled: false, nodeSelector: { tier: 'ingest' } } },
    }) as Record<string, unknown>;
    expect(withOtherKeys['otel-collector']).toMatchObject({
      enabled: true,
      nodeSelector: { tier: 'ingest' },
    });
  });

  it('the final HelmRelease carries enabled: true in both the KRO RGD and direct-mode manifests', () => {
    const build = {
      storage: { mode: 's3', persistentQueue: { enabled: true } },
      values: { 'otel-collector': { enabled: false } },
    } as const;

    const rgd = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-collector-on',
      kind: 'ClickStackS3QueueCollectorOn',
      ...build,
    }).toYaml();
    const rgdRelease = helmReleaseSpec(rgd);
    expect(collectorEnabled(rgdRelease)).toBe(true);
    expect(JSON.stringify(rgdRelease.values)).toContain(QUEUE_EXTENSION_NAME);
    // The status contract still reports the queue (the ConfigMap the CEL reads).
    expect(rgd).toContain("storagePersistentQueue: 'true'");

    const direct = makeClickstackBootstrap(build)
      .factory('direct', { namespace: SPEC.namespace })
      .toYaml(SPEC as never);
    const directRelease = (yaml.loadAll(direct) as Array<{ kind?: string; spec?: unknown }>).find(
      (document) => document?.kind === 'HelmRelease'
    );
    if (directRelease === undefined) throw new Error('expected a HelmRelease document');
    expect(collectorEnabled(directRelease.spec as { values?: Record<string, unknown> })).toBe(true);
    expect(direct).toContain(clickStackQueueClaimName(SPEC.name));
  });

  it('without a queue, a caller’s enabled: false passes through untouched', () => {
    const values = mapClickStackConfigToHelmValues(SPEC, {
      storage: resolveClickStackStorage('t', { mode: 's3' }),
      values: { 'otel-collector': { enabled: false } },
    }) as Record<string, unknown>;
    expect(collectorEnabled({ values })).toBe(false);

    const rgd = makeClickstackBootstrap({
      name: 'clickstack-s3-noqueue-collector-off',
      kind: 'ClickStackS3NoQueueCollectorOff',
      storage: { mode: 's3' },
      values: { 'otel-collector': { enabled: false } },
    }).toYaml();
    expect(collectorEnabled(helmReleaseSpec(rgd))).toBe(false);
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
    // The RWO claim pins the collector Deployment to one replica…
    expect(yaml).toContain('replicaCount: 1');
    // …and forces Recreate, so a rollout drains the old collector before the
    // replacement contends for the same claim and the same bbolt lock.
    expect(yaml).toContain('strategy: Recreate');

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
    // Recreate is the queue's constraint, not a house style: with no queue the
    // gateway keeps the chart's own RollingUpdate default and stays available
    // across a rollout, so nothing is pinned here.
    expect(yaml).not.toContain('rollout:');
    expect(yaml).not.toContain('Recreate');
  });

  it('rejects several collector replicas alongside the queue at CONSTRUCTION', () => {
    // bbolt takes an exclusive file lock, so a second collector cannot open
    // the queue database at all — this is not a volume-mode trade-off.
    const build = () =>
      makeClickstackBootstrap({
        name: 'clickstack-s3-queue-replicas',
        kind: 'ClickStackS3QueueReplicas',
        storage: { mode: 's3', persistentQueue: { enabled: true } },
        values: { 'otel-collector': { replicaCount: 3 } },
      });
    expect(build).toThrow(/requires exactly ONE gateway collector replica/);
    // The message has to explain WHY, refuse the shared-volume workaround, and
    // name the path that would actually give every replica its own queue.
    expect(build).toThrow(/bbolt/);
    expect(build).toThrow(/exclusive file lock/);
    expect(build).toThrow(/#5894/);
    expect(build).toThrow(/ReadWriteMany volume does NOT help/);
    expect(build).toThrow(/mode: statefulset/);
    expect(build).toThrow(/volumeClaimTemplates/);
  });

  it('has no shared-volume escape hatch that lifts the replica guard', () => {
    // Previously `accessModes: ['ReadWriteMany']` lifted the guard. It is not
    // an option any more, and smuggling one through changes nothing.
    expect(() =>
      makeClickstackBootstrap({
        name: 'clickstack-s3-queue-rwx',
        kind: 'ClickStackS3QueueRwx',
        storage: {
          mode: 's3',
          persistentQueue: {
            enabled: true,
            storageClassName: 'efs',
            accessModes: ['ReadWriteMany'],
          } as never,
        },
        values: { 'otel-collector': { replicaCount: 3 } },
      })
    ).toThrow(/requires exactly ONE gateway collector replica/);
  });

  it('renders the claim, the claimName mount and the chart custom-config mount on RWO', () => {
    // The single-replica path is the ONLY path now, so it carries everything
    // the previous round fixed: a real claim, mounted by claimName, next to
    // the chart's own custom-config volume (Helm replaces list overrides).
    const yaml = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-single',
      kind: 'ClickStackS3QueueSingle',
      storage: { mode: 's3', persistentQueue: { enabled: true } },
      values: { 'otel-collector': { replicaCount: 1 } },
    }).toYaml();

    expect(yaml).toContain('kind: PersistentVolumeClaim');
    expect(yaml).toContain('ReadWriteOnce');
    expect(yaml).not.toContain('ReadWriteMany');
    // The claim name is the release name plus the suffix — a CEL expression
    // in kro mode, so assert on the suffix and the mount, not the literal.
    expect(yaml).toContain('-otel-queue');
    expect(yaml).toContain('claimName: ${string(schema.spec.name)}-otel-queue');
    expect(yaml).toContain('replicaCount: 1');
    expect(yaml).toContain('strategy: Recreate');
    // The chart's own mount survives next to the queue's — dropping it leaves
    // the OpAMP supervisor unable to read custom.config.yaml.
    expect(yaml).toContain('custom-config');
    expect(yaml).toContain('clickstack-otel-custom-config');
    expect(yaml).toContain('/etc/otelcol-contrib/custom');
    expect(yaml).not.toContain('emptyDir');
  });

  it('overrides a build-time RollingUpdate rather than letting it deadlock', () => {
    // Unlike `replicaCount`, a rollout strategy is not rejected at
    // construction — it is simply overridden, because the deadlock it causes
    // is a property of the queue and not a trade-off the caller can take.
    const yaml = makeClickstackBootstrap({
      name: 'clickstack-s3-queue-rollout',
      kind: 'ClickStackS3QueueRollout',
      storage: { mode: 's3', persistentQueue: { enabled: true } },
      values: {
        'otel-collector': {
          rollout: { strategy: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } },
        },
      },
    }).toYaml();

    expect(yaml).toContain('strategy: Recreate');
    expect(yaml).not.toContain('strategy: RollingUpdate');
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

    // The durability decision is a CONSTRUCTION-TIME value, so it lives as a
    // literal in the contract ConfigMap this composition owns...
    expect(serialized).toContain('"key":"storageMode","value":{"kind":"literal","value":"s3"}');
    expect(serialized).toContain(
      '"key":"storageDiskType","value":{"kind":"literal","value":"s3"}'
    );
    expect(serialized).toContain(
      '"key":"storagePersistentQueue","value":{"kind":"literal","value":"true"}'
    );
    expect(serialized).toContain(
      '"key":"storageRetentionLogs","value":{"kind":"literal","value":"30d"}'
    );

    // ...and the STATUS reads it back from that resource, so it survives KRO
    // instead of being a literal leaf KRO drops from the instance.
    const outputs = serialized.slice(serialized.indexOf('"outputs"'));
    expect(outputs).toContain('clickstackContract.data.storageMode');
    expect(outputs).toContain('clickstackContract.data.storageDiskType');
    expect(outputs).toContain('clickstackContract.data.storagePersistentQueue ==');
    expect(outputs).toContain('clickstackContract.data.storageRetentionLogs');
    expect(outputs).not.toContain('"kind":"literal","value":"s3_main"');
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
      '"key":"storageDiskType","value":{"kind":"literal","value":"s3_plain_rewritable"}'
    );
    expect(serialized.slice(serialized.indexOf('"outputs"'))).toContain(
      'clickstackContract.data.storageDiskType'
    );
  });

  it('reports pvc mode and no queue by default', () => {
    const bootstrap = makeClickstackBootstrap({
      name: 'clickstack-default-storage',
      kind: 'ClickStackDefaultStorage',
    });
    const serialized = JSON.stringify(bootstrap.plan?.(SPEC, { strict: true }));

    expect(serialized).toContain('"key":"storageMode","value":{"kind":"literal","value":"pvc"}');
    expect(serialized).toContain(
      '"key":"storagePersistentQueue","value":{"kind":"literal","value":"false"}'
    );
    // No S3 fields are written to the contract — nor projected — on the PVC
    // default.
    expect(serialized).not.toContain('storageDiskType');
    expect(serialized).not.toContain('storagePolicyName');
    const outputs = serialized.slice(serialized.indexOf('"outputs"'));
    expect(outputs).toContain('clickstackContract.data.storageMode');
    expect(outputs).not.toContain('"key":"diskType"');
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

describe('the build-time `values` object is never mutated', () => {
  const buildValues = () => ({
    'otel-collector': { podAnnotations: { 'example.com/owner': 'platform' } },
    hyperdx: { deployment: { replicas: 1 } },
  });

  it('keeps the caller object unchanged, and the RGD claim name templated, across builds', async () => {
    const values = buildValues();
    const snapshot = structuredClone(values);
    const stack = makeClickstackBootstrap({
      name: 'clickstack-values-reuse',
      kind: 'ClickStackValuesReuse',
      storage: {
        mode: 's3',
        diskType: 's3_plain_rewritable',
        persistentQueue: { enabled: true, size: '1Gi' },
      },
      values,
    });

    // Build 1: the KRO RGD. Build 2: a direct-mode render, where the claim
    // name resolves to a literal. Build 3: the KRO RGD again. The hard pins
    // are merged over `values` on every build, and none may land in it.
    const first = stack.toYaml();
    expect(values).toEqual(snapshot);

    const direct = stack.factory('direct', { namespace: SPEC.namespace }).toYaml(SPEC as never);
    expect(direct).toContain('claimName: clickstack-otel-queue');
    expect(values).toEqual(snapshot);

    const kro = await stack.factory('kro', { namespace: SPEC.namespace });
    await kro.toAlchemyResources({ ...SPEC, version: '3.2.0' } as never);
    expect(values).toEqual(snapshot);

    const second = stack.toYaml();
    expect(values).toEqual(snapshot);
    expect(second).toBe(first);
    expect(second).toContain('claimName: ${string(schema.spec.name)}-otel-queue');
    expect(second).not.toContain('claimName: clickstack-otel-queue');
    // The caller's own keys still reach the chart.
    expect(second).toContain('example.com/owner: platform');
  });

  it('keeps the caller object unchanged when two compositions share it', () => {
    const values = buildValues();
    const snapshot = structuredClone(values);
    const withQueue = makeClickstackBootstrap({
      name: 'clickstack-values-shared-a',
      kind: 'ClickStackValuesSharedA',
      storage: { mode: 's3', persistentQueue: { enabled: true } },
      values,
    });
    const withoutQueue = makeClickstackBootstrap({
      name: 'clickstack-values-shared-b',
      kind: 'ClickStackValuesSharedB',
      storage: { mode: 's3' },
      values,
    });

    withQueue.toYaml();
    const plain = withoutQueue.toYaml();
    expect(values).toEqual(snapshot);
    // No queue pin carried over from the other composition.
    expect(plain).not.toContain('-otel-queue');
    expect(plain).not.toContain('podSecurityContext');
  });

  it('does not mutate the values passed to the mapper directly', () => {
    const values = buildValues();
    const snapshot = structuredClone(values);
    const storage = resolveClickStackStorage('t', {
      mode: 's3',
      persistentQueue: { enabled: true },
    });

    const mapped = mapClickStackConfigToHelmValues(SPEC, { storage, values }) as Record<
      string,
      Record<string, unknown>
    >;
    // A second call over the same object sees exactly what the first did.
    expect(mapClickStackConfigToHelmValues(SPEC, { storage, values })).toEqual(mapped);

    expect(values).toEqual(snapshot);
    expect(mapped['otel-collector']).not.toBe(values['otel-collector']);
    expect(mapped['otel-collector']?.podAnnotations).toEqual({ 'example.com/owner': 'platform' });
    expect(mapped['otel-collector']?.replicaCount).toBe(1);
  });
});
