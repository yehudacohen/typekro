/**
 * Persistent-queue storage: `file_storage` compaction and the `bytes` sizer.
 *
 * The queue keeps each signal in a bbolt file, and a bbolt file keeps its
 * high-water mark after its items are deleted. After an extended backend
 * outage a drained queue file therefore stays as large as the backlog was,
 * and every signal's queue shares the one claim. These tests pin what TypeKro
 * renders about that: compaction on by default (with the exact block), the
 * opt-out that restores the previous rendering, and the per-signal byte
 * bounds. `test/integration/clickstack/queue-compaction.test.ts` runs the same
 * renderings through the real collector binary.
 */

import { describe, expect, it } from 'bun:test';
import * as yaml from 'js-yaml';
import type { ClickStackPersistentQueueOptions } from '../../../src/factories/clickstack/types.js';
import { renderCollectorConfig } from '../../../src/factories/clickstack/utils/collector-config.js';
import {
  CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
  mapClickStackConfigToHelmValues,
} from '../../../src/factories/clickstack/utils/helm-values-mapper.js';
import {
  persistentQueueConfigFragment,
  resolveClickStackStorage,
} from '../../../src/factories/clickstack/utils/storage.js';

function renderOverlay(options: Partial<ClickStackPersistentQueueOptions> = {}): string {
  const resolved = resolveClickStackStorage('t', {
    mode: 's3',
    persistentQueue: { enabled: true, ...options },
  });
  if (resolved.persistentQueue === undefined) throw new Error('expected a queue');
  return renderCollectorConfig([
    CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
    persistentQueueConfigFragment(resolved.persistentQueue),
  ]);
}

function parsed(options: Partial<ClickStackPersistentQueueOptions> = {}) {
  return yaml.load(renderOverlay(options)) as {
    extensions: Record<string, Record<string, unknown>>;
    exporters: Record<string, { sending_queue: Record<string, unknown> }>;
  };
}

/** The complete default overlay with the queue enabled. */
const GOLDEN_DEFAULT_OVERLAY = `service:
  pipelines:
    logs/in:
      receivers: [fluentforward, otlp/hyperdx]
    metrics:
      receivers: [prometheus, otlp/hyperdx]
    traces:
      receivers: [nop, otlp/hyperdx]
  extensions:
    - health_check
    - file_storage/hyperdx
extensions:
  file_storage/hyperdx:
    directory: /var/lib/otelcol/file_storage
    create_directory: true
    compaction:
      on_start: true
      on_rebound: true
      directory: /var/lib/otelcol/file_storage
      rebound_needed_threshold_mib: 256
      rebound_trigger_threshold_mib: 32
      check_interval: 5s
      cleanup_on_start: true
exporters:
  clickhouse:
    sending_queue:
      enabled: true
      storage: file_storage/hyperdx
`;

/** The eight lines compaction adds — and the only lines it adds. */
const COMPACTION_LINES = [
  '    compaction:',
  '      on_start: true',
  '      on_rebound: true',
  '      directory: /var/lib/otelcol/file_storage',
  '      rebound_needed_threshold_mib: 256',
  '      rebound_trigger_threshold_mib: 32',
  '      check_interval: 5s',
  '      cleanup_on_start: true',
];

describe('persistent queue compaction', () => {
  it('renders the golden default overlay, compaction included', () => {
    expect(renderOverlay()).toBe(GOLDEN_DEFAULT_OVERLAY);
  });

  it('changes the no-options rendering ONLY by the compaction block', () => {
    // The rendering before compaction existed is the golden minus exactly
    // these lines, and turning both modes off reproduces it byte for byte.
    const withoutCompaction = GOLDEN_DEFAULT_OVERLAY.split('\n')
      .filter((line) => !COMPACTION_LINES.includes(line))
      .join('\n');
    expect(GOLDEN_DEFAULT_OVERLAY.split('\n').length - withoutCompaction.split('\n').length).toBe(
      COMPACTION_LINES.length
    );
    expect(renderOverlay({ compaction: { onStart: false, onRebound: false } })).toBe(
      withoutCompaction
    );
  });

  it('changes nothing else in the chart values', () => {
    const values = (compaction: ClickStackPersistentQueueOptions['compaction']) => {
      const storage = resolveClickStackStorage('t', {
        mode: 's3',
        persistentQueue: { enabled: true, ...(compaction !== undefined && { compaction }) },
      });
      const rendered = mapClickStackConfigToHelmValues(
        {
          name: 'clickstack',
          namespace: 'observability',
          clickhouse: { host: 'clickhouse', username: 'otel', password: 'test-only' },
          apiKey: 'test-only-api-key',
        },
        { storage }
      ) as { global: { otelCollector: { customConfig: string } } };
      // Everything except the overlay, which the tests above pin line by line.
      const otelCollector: Record<string, unknown> = { ...rendered.global.otelCollector };
      delete otelCollector.customConfig;
      return { ...rendered, global: { ...rendered.global, otelCollector } };
    };
    expect(values(undefined)).toEqual(values({ onStart: false, onRebound: false }));
  });

  it('compacts in the queue directory itself, on the same volume', () => {
    const compaction = parsed({ directory: '/data/queue' }).extensions['file_storage/hyperdx']
      ?.compaction as Record<string, unknown>;
    expect(compaction.directory).toBe('/data/queue');
  });

  it('takes typed overrides', () => {
    const extension = parsed({
      compaction: {
        onStart: false,
        reboundNeededMiB: 1024,
        reboundTriggerMiB: 64,
        checkInterval: '30s',
      },
    }).extensions['file_storage/hyperdx'];
    expect(extension?.compaction).toEqual({
      on_start: false,
      on_rebound: true,
      directory: '/var/lib/otelcol/file_storage',
      rebound_needed_threshold_mib: 1024,
      rebound_trigger_threshold_mib: 64,
      check_interval: '30s',
      cleanup_on_start: true,
    });
  });

  it('keeps the block when only one mode is on', () => {
    const compaction = parsed({ compaction: { onRebound: false } }).extensions[
      'file_storage/hyperdx'
    ]?.compaction as Record<string, unknown>;
    expect(compaction.on_start).toBe(true);
    expect(compaction.on_rebound).toBe(false);
  });

  it('rejects malformed compaction options', () => {
    const resolve = (compaction: unknown) =>
      resolveClickStackStorage('t', {
        persistentQueue: {
          enabled: true,
          compaction: compaction as NonNullable<ClickStackPersistentQueueOptions['compaction']>,
        },
      });
    expect(() => resolve({ onStart: 'yes' })).toThrow(/compaction.onStart' must be a boolean/);
    expect(() => resolve({ reboundNeededMiB: 0 })).toThrow(/reboundNeededMiB' must be a positive/);
    expect(() => resolve({ reboundTriggerMiB: 1.5 })).toThrow(/reboundTriggerMiB' must be a/);
    // trigger >= needed would let a compacted file qualify again on every check.
    expect(() => resolve({ reboundTriggerMiB: 256 })).toThrow(/must be smaller than/);
    expect(() => resolve({ reboundNeededMiB: 16 })).toThrow(/must be smaller than/);
    expect(() => resolve({ checkInterval: '5' })).toThrow(/checkInterval' must be a whole/);
    expect(() => resolve({ checkInterval: '500ms' })).toThrow(/must be between 1s and 60m/);
  });

  it('ignores compaction options while the queue is disabled', () => {
    expect(
      resolveClickStackStorage('t', {
        persistentQueue: { enabled: false, compaction: { reboundNeededMiB: -1 } },
      }).persistentQueue
    ).toBeUndefined();
  });
});

describe('persistent queue byte bounds (sizer: bytes)', () => {
  it('renders no sizer by default, or for an explicit requests sizer', () => {
    expect(parsed().exporters.clickhouse?.sending_queue).toEqual({
      enabled: true,
      storage: 'file_storage/hyperdx',
    });
    expect(renderOverlay({ sizer: 'requests' })).toBe(GOLDEN_DEFAULT_OVERLAY);
  });

  it('bounds each signal queue at half the claim split three ways per exporter', () => {
    expect(parsed({ sizer: 'bytes' }).exporters.clickhouse?.sending_queue).toEqual({
      enabled: true,
      storage: 'file_storage/hyperdx',
      sizer: 'bytes',
      // floor(10Gi / 2 / 3)
      queue_size: 1_789_569_706,
    });
    const two = parsed({
      sizer: 'bytes',
      size: '600Mi',
      exporterNames: ['clickhouse', 'clickhouse/rrweb'],
    }).exporters;
    // floor(600Mi / 2 / 6)
    expect(two.clickhouse?.sending_queue.queue_size).toBe(52_428_800);
    expect(two['clickhouse/rrweb']?.sending_queue.queue_size).toBe(52_428_800);
    expect(parsed({ sizer: 'bytes', size: '3G' }).exporters.clickhouse?.sending_queue).toEqual(
      expect.objectContaining({ queue_size: 500_000_000 })
    );
  });

  it('takes an explicit byte bound, and the batched default does not apply', () => {
    const queue = parsed({
      sizer: 'bytes',
      queueSize: 1_000_000_000,
      batch: { flushTimeout: '30s' },
    }).exporters.clickhouse?.sending_queue;
    expect(queue?.queue_size).toBe(1_000_000_000);
    expect(queue?.sizer).toBe('bytes');
  });

  it('rejects bounds that add up to more than the claim', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        persistentQueue: { enabled: true, sizer: 'bytes', size: '1Gi', queueSize: 400_000_000 },
      })
    ).toThrow(/times 3 signal queues .* exceeds the claim/);
  });

  it('needs an explicit bound when the claim size cannot be read', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        persistentQueue: { enabled: true, sizer: 'bytes', size: '1e10' },
      })
    ).toThrow(/Set 'storage.persistentQueue.queueSize'/);
    expect(
      resolveClickStackStorage('t', {
        persistentQueue: { enabled: true, sizer: 'bytes', size: '1e10', queueSize: 1000 },
      }).persistentQueue?.queueSize
    ).toBe(1000);
  });

  it('rejects a byte batch the queue could never hold', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        persistentQueue: {
          enabled: true,
          sizer: 'bytes',
          queueSize: 1000,
          batch: { flushTimeout: '30s', sizer: 'bytes', minSize: 5000 },
        },
      })
    ).toThrow(/batch.minSize' \(5000 bytes\) must not exceed/);
  });

  it('rejects an unknown sizer', () => {
    expect(() =>
      resolveClickStackStorage('t', {
        persistentQueue: {
          enabled: true,
          sizer: 'items' as unknown as 'bytes',
        },
      })
    ).toThrow(/sizer' must be 'requests' or 'bytes'/);
  });
});
