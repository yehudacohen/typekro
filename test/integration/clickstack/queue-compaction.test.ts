/**
 * Persistent-queue storage against the REAL gateway collector binary.
 *
 * The unit suite (`test/factories/clickstack/queue-compaction.test.ts`) pins
 * what TypeKro renders; this one checks what the collector does with it, using
 * `clickstack-otel-collector` 2.35.0 (collector v0.155.0):
 *
 * 1. **Validation.** Each rendered overlay is merged with the image's own
 *    `config.yaml` and `standalone-config.yaml` (plus a stub for the three
 *    receivers the OpAMP remote config normally defines) and run through
 *    `otelcontribcol validate`. A deliberately broken copy must FAIL, so a pass
 *    means something.
 * 2. **Compaction.** A gateway runs TypeKro's rendered `file_storage` extension
 *    and `sending_queue` in front of an OTLP backend that is DOWN. The queue
 *    fills past the rebound threshold, the backend comes back, the queue
 *    drains, and:
 *    - with compaction turned off, the drained file keeps its high-water mark
 *      (the failure mode this exists for);
 *    - restarting with the default rendering compacts it online (rebound
 *      compaction; on-start compaction is off by default);
 *    - filling and draining again compacts it online, without a restart;
 *    - the explicit `onStart: true` opt-in compacts it as the file opens.
 * 3. **Per-signal byte bounds.** With `sizer: 'bytes'`, the logs queue stops
 *    accepting at its bound while metrics are still accepted. The harness has
 *    no `batch` processor, so the refusal reaches the sender as a 503; in the
 *    ClickStack pipelines the processor absorbs it and the data is dropped
 *    (see the docs).
 *
 * The harness swaps only the exporter: `otlphttp` instead of `clickhouse`, so
 * the backend can be taken down and brought back with one container. The
 * queue and its storage are the exporter helper's and the `file_storage`
 * extension's either way.
 *
 * Docker-gated: the suite SKIPS when no Docker daemon is reachable. Set
 * REQUIRE_DOCKER_TESTS=true to make a missing daemon a failure (CI does).
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ClickStackPersistentQueueOptions } from '../../../src/factories/clickstack/types.js';
import { renderCollectorConfig } from '../../../src/factories/clickstack/utils/collector-config.js';
import { CLICKSTACK_INGEST_PIPELINES_FRAGMENT } from '../../../src/factories/clickstack/utils/helm-values-mapper.js';
import {
  DEFAULT_QUEUE_DIRECTORY,
  persistentQueueConfigFragment,
  QUEUE_EXTENSION_NAME,
  resolveClickStackStorage,
} from '../../../src/factories/clickstack/utils/storage.js';

setDefaultTimeout(300_000);

const IMAGE =
  process.env.CLICKSTACK_COLLECTOR_TEST_IMAGE ??
  'docker.clickhouse.com/clickhouse/clickstack-otel-collector:2.35.0';
const MIB = 1024 * 1024;
/** The default `rebound_needed_threshold_mib`, which the fill must exceed. */
const REBOUND_NEEDED_BYTES = 256 * MIB;

function docker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function mustDocker(args: string[]): string {
  const result = docker(args);
  if (!result.ok) throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

const dockerAvailable = (() => {
  try {
    return docker(['info', '--format', '{{.ServerVersion}}']).ok;
  } catch {
    return false;
  }
})();
if (!dockerAvailable && process.env.REQUIRE_DOCKER_TESTS === 'true') {
  throw new Error('REQUIRE_DOCKER_TESTS=true but no Docker daemon is reachable');
}
const describeOrSkip = dockerAvailable ? describe : describe.skip;

const RUN = `tk-queue-${process.pid}`;
const NETWORK = `${RUN}-net`;
const SINK = `${RUN}-sink`;
const containers = new Set<string>();
const volumes = new Set<string>();
let workDir = '';

function renderedQueue(options: Partial<ClickStackPersistentQueueOptions> = {}) {
  const resolved = resolveClickStackStorage('queue-compaction-test', {
    mode: 's3',
    persistentQueue: { enabled: true, ...options },
  });
  if (resolved.persistentQueue === undefined) throw new Error('expected a queue');
  const overlay = renderCollectorConfig([
    CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
    persistentQueueConfigFragment(resolved.persistentQueue),
  ]);
  const parsed = yaml.load(overlay) as {
    extensions: Record<string, Record<string, unknown>>;
    exporters: Record<string, { sending_queue: Record<string, unknown> }>;
  };
  const extension = parsed.extensions[QUEUE_EXTENSION_NAME];
  const sendingQueue = parsed.exporters.clickhouse?.sending_queue;
  if (extension === undefined || sendingQueue === undefined) {
    throw new Error(`rendered overlay is missing the queue wiring:\n${overlay}`);
  }
  return { overlay, extension, sendingQueue };
}

function writeFile(name: string, content: string): string {
  const path = join(workDir, name);
  // The collector runs as uid 10001, not as the user running the tests.
  writeFileSync(path, content, { mode: 0o644 });
  chmodSync(path, 0o644);
  return path;
}

/** `otelcontribcol validate` over the image's own config plus the given files. */
function validate(files: string[]): { ok: boolean; output: string } {
  const result = docker([
    'run',
    '--rm',
    '-v',
    `${workDir}:/c:ro`,
    '-e',
    'CLICKHOUSE_ENDPOINT=tcp://clickhouse:9000',
    '-e',
    'HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE=default',
    '-e',
    'CLICKHOUSE_USER=default',
    '-e',
    'CLICKHOUSE_PASSWORD=',
    '-e',
    'HYPERDX_LOG_LEVEL=info',
    '--entrypoint',
    '/otelcontribcol',
    IMAGE,
    'validate',
    '--config',
    '/etc/otelcol-contrib/config.yaml',
    '--config',
    '/etc/otelcol-contrib/standalone-config.yaml',
    ...files.flatMap((file) => ['--config', `/c/${file}`]),
  ]);
  return { ok: result.ok, output: `${result.stdout}\n${result.stderr}` };
}

/** Receivers the OpAMP remote config defines and the ingest overlay attaches. */
const REMOTE_RECEIVERS_STUB = `receivers:
  fluentforward:
    endpoint: 0.0.0.0:24225
  prometheus:
    config:
      scrape_configs:
        - job_name: stub
          static_configs:
            - targets: ['127.0.0.1:8888']
  nop:
`;

/** A named volume the collector's uid can write to, like the fsGroup'd claim. */
function createVolume(): string {
  const volume = `${RUN}-vol-${volumes.size}`;
  mustDocker(['volume', 'create', volume]);
  volumes.add(volume);
  mustDocker([
    'run',
    '--rm',
    '-u',
    '0',
    '-v',
    `${volume}:/d`,
    '--entrypoint',
    'sh',
    IMAGE,
    '-c',
    'chown 10001:10001 /d',
  ]);
  return volume;
}

function gatewayConfig(
  queue: ReturnType<typeof renderedQueue>,
  signals: readonly ('logs' | 'metrics')[]
): string {
  return yaml.dump(
    {
      extensions: { [QUEUE_EXTENSION_NAME]: queue.extension },
      receivers: { otlp: { protocols: { http: { endpoint: '0.0.0.0:4318' } } } },
      exporters: {
        otlphttp: {
          endpoint: `http://${SINK}:4318`,
          // Never give up while the backend is down, and come back quickly.
          retry_on_failure: { initial_interval: '1s', max_interval: '2s', max_elapsed_time: 0 },
          sending_queue: queue.sendingQueue,
        },
      },
      service: {
        extensions: [QUEUE_EXTENSION_NAME],
        telemetry: {
          metrics: {
            readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }],
          },
        },
        pipelines: Object.fromEntries(
          signals.map((signal) => [signal, { receivers: ['otlp'], exporters: ['otlphttp'] }])
        ),
      },
    },
    { lineWidth: -1, noRefs: true }
  );
}

interface Gateway {
  readonly name: string;
  readonly otlpPort: string;
  readonly metricsPort: string;
}

function startGateway(name: string, volume: string, configFile: string): Gateway {
  const container = `${RUN}-${name}`;
  docker(['rm', '-f', container]);
  mustDocker([
    'run',
    '-d',
    '--name',
    container,
    '--network',
    NETWORK,
    '-p',
    '127.0.0.1::4318',
    '-p',
    '127.0.0.1::8888',
    '-v',
    `${volume}:${DEFAULT_QUEUE_DIRECTORY}`,
    '-v',
    `${workDir}:/c:ro`,
    '--entrypoint',
    '/otelcontribcol',
    IMAGE,
    '--config',
    `/c/${configFile}`,
  ]);
  containers.add(container);
  const port = (inner: string) =>
    mustDocker(['port', container, inner]).split('\n')[0]?.split(':').at(-1) as string;
  return { name: container, otlpPort: port('4318/tcp'), metricsPort: port('8888/tcp') };
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 90_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

async function waitForGateway(gateway: Gateway): Promise<void> {
  await waitFor(`${gateway.name} to serve OTLP`, async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.otlpPort}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await response.arrayBuffer();
    return response.ok ? true : undefined;
  });
}

const PADDING = 'x'.repeat(512 * 1024);
const PAYLOADS = {
  logs: JSON.stringify({
    resourceLogs: [
      {
        resource: {},
        scopeLogs: [
          { scope: {}, logRecords: [{ timeUnixNano: '1', body: { stringValue: PADDING } }] },
        ],
      },
    ],
  }),
  metrics: JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'padding', value: { stringValue: PADDING } }] },
        scopeMetrics: [
          {
            scope: {},
            metrics: [{ name: 'm', gauge: { dataPoints: [{ timeUnixNano: '1', asDouble: 1 }] } }],
          },
        ],
      },
    ],
  }),
} as const;

/** POST `count` half-MiB requests; returns how many were accepted. */
async function send(
  gateway: Gateway,
  signal: keyof typeof PAYLOADS,
  count: number
): Promise<{ accepted: number; refused: number }> {
  let accepted = 0;
  let refused = 0;
  for (let index = 0; index < count; index++) {
    const response = await fetch(`http://127.0.0.1:${gateway.otlpPort}/v1/${signal}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: PAYLOADS[signal],
    });
    await response.arrayBuffer();
    if (response.ok) accepted++;
    else refused++;
  }
  return { accepted, refused };
}

function fileSize(gateway: Gateway, signal: 'logs' | 'metrics'): number {
  return Number(
    mustDocker([
      'exec',
      gateway.name,
      'stat',
      '-c',
      '%s',
      `${DEFAULT_QUEUE_DIRECTORY}/exporter_otlphttp__${signal}`,
    ])
  );
}

/** `otelcol_exporter_queue_size` for the logs queue, from the gateway's own telemetry. */
async function queueSize(gateway: Gateway): Promise<number | undefined> {
  const text = await (await fetch(`http://127.0.0.1:${gateway.metricsPort}/metrics`)).text();
  const line = text
    .split('\n')
    .find((entry) => entry.startsWith('otelcol_exporter_queue_size{') && entry.includes('logs'));
  return line === undefined ? undefined : Number(line.split(' ').at(-1));
}

function startSink(): void {
  writeFile(
    'sink.yaml',
    yaml.dump({
      receivers: {
        otlp: { protocols: { http: { endpoint: '0.0.0.0:4318', max_request_body_size: 1 << 30 } } },
      },
      exporters: { nop: {} },
      service: {
        pipelines: {
          logs: { receivers: ['otlp'], exporters: ['nop'] },
          metrics: { receivers: ['otlp'], exporters: ['nop'] },
        },
      },
    })
  );
  docker(['rm', '-f', SINK]);
  mustDocker([
    'run',
    '-d',
    '--name',
    SINK,
    '--network',
    NETWORK,
    '-v',
    `${workDir}:/c:ro`,
    '--entrypoint',
    '/otelcontribcol',
    IMAGE,
    '--config',
    '/c/sink.yaml',
  ]);
  containers.add(SINK);
}

function stopSink(): void {
  docker(['rm', '-f', SINK]);
}

/** Fill the logs queue past the rebound threshold while the backend is down. */
async function fillWhileBackendDown(gateway: Gateway): Promise<number> {
  stopSink();
  const { accepted } = await send(gateway, 'logs', 640);
  expect(accepted).toBe(640);
  const size = fileSize(gateway, 'logs');
  expect(size).toBeGreaterThan(REBOUND_NEEDED_BYTES);
  return size;
}

async function drain(gateway: Gateway): Promise<void> {
  startSink();
  await waitFor('the logs queue to drain', async () =>
    (await queueSize(gateway)) === 0 ? true : undefined
  );
}

beforeAll(() => {
  if (!dockerAvailable) return;
  workDir = mkdtempSync(join(tmpdir(), 'typekro-queue-compaction-'));
  // mkdtemp creates the directory 0700; the collector (uid 10001) reads from it.
  chmodSync(workDir, 0o755);
  if (!docker(['image', 'inspect', IMAGE]).ok) mustDocker(['pull', IMAGE]);
  docker(['network', 'rm', NETWORK]);
  mustDocker(['network', 'create', NETWORK]);
});

afterAll(() => {
  if (!dockerAvailable) return;
  for (const container of containers) docker(['rm', '-f', container]);
  for (const volume of volumes) docker(['volume', 'rm', '-f', volume]);
  docker(['network', 'rm', NETWORK]);
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describeOrSkip('ClickStack queue storage against the collector binary', () => {
  it('validates every rendered overlay, and refuses a broken one', () => {
    writeFile('remote-receivers.yaml', REMOTE_RECEIVERS_STUB);
    const variants: Record<string, Partial<ClickStackPersistentQueueOptions>> = {
      default: {},
      overrides: {
        directory: '/data/queue',
        compaction: { onStart: false, reboundNeededMiB: 1024, reboundTriggerMiB: 64 },
      },
      'compaction-off': { compaction: { onStart: false, onRebound: false } },
      bytes: { sizer: 'bytes', batch: { flushTimeout: '30s', sizer: 'bytes', minSize: 1 << 20 } },
      consumers: { numConsumers: 2, batch: { flushTimeout: '30s' } },
    };
    for (const [name, options] of Object.entries(variants)) {
      const file = `overlay-${name}.yaml`;
      writeFile(file, renderedQueue(options).overlay);
      const result = validate(['remote-receivers.yaml', file]);
      expect({ name, ok: result.ok, output: result.ok ? '' : result.output }).toEqual({
        name,
        ok: true,
        output: '',
      });
    }

    // Negative control: the same overlay with one misspelled compaction key.
    writeFile(
      'overlay-broken.yaml',
      renderedQueue().overlay.replace('rebound_needed_threshold_mib', 'rebound_needed_threshold_mb')
    );
    const broken = validate(['remote-receivers.yaml', 'overlay-broken.yaml']);
    expect(broken.ok).toBe(false);
    expect(broken.output).toContain("'compaction' has invalid keys: rebound_needed_threshold_mb");
  });

  it('compacts a drained queue file online, and on start only when opted in; without compaction it keeps its size', async () => {
    const volume = createVolume();
    const offConfig = gatewayConfig(
      renderedQueue({ compaction: { onStart: false, onRebound: false } }),
      ['logs']
    );

    // 1. Control: compaction off. The drained file keeps its high-water mark.
    writeFile('gateway-off.yaml', offConfig);
    const off = startGateway('gateway', volume, 'gateway-off.yaml');
    await waitForGateway(off);
    const highWater = await fillWhileBackendDown(off);
    await drain(off);
    await Bun.sleep(12_000); // more than two default check intervals
    expect(fileSize(off, 'logs')).toBe(highWater);

    // 2. The default rendering (rebound only) compacts the bloated, drained
    //    file online within a few checks of starting.
    writeFile('gateway-default.yaml', gatewayConfig(renderedQueue(), ['logs']));
    const on = startGateway('gateway', volume, 'gateway-default.yaml');
    await waitForGateway(on);
    await waitFor('rebound compaction after a restart', () =>
      fileSize(on, 'logs') < 32 * MIB ? true : undefined
    );

    // 3. …and after the next outage drains, with no restart.
    await fillWhileBackendDown(on);
    await drain(on);
    await waitFor('online (rebound) compaction', () =>
      fileSize(on, 'logs') < 32 * MIB ? true : undefined
    );
    const logs = docker(['logs', on.name]);
    expect(`${logs.stdout}\n${logs.stderr}`).toContain('finished compaction');

    // 4. The explicit on-start opt-in compacts a bloated file as it opens it
    //    (rebound off, so nothing else can have shrunk it).
    const bloated = startGateway('gateway', volume, 'gateway-off.yaml');
    await waitForGateway(bloated);
    await fillWhileBackendDown(bloated);
    await drain(bloated);
    writeFile(
      'gateway-on-start.yaml',
      gatewayConfig(renderedQueue({ compaction: { onStart: true, onRebound: false } }), ['logs'])
    );
    const onStart = startGateway('gateway', volume, 'gateway-on-start.yaml');
    await waitForGateway(onStart);
    expect(fileSize(onStart, 'logs')).toBeLessThan(32 * MIB);
  });

  it('with sizer bytes, one signal at its bound does not stop another', async () => {
    const volume = createVolume();
    // 600Mi claim, one exporter: floor(600Mi / 2 / 3) = 100 MiB per signal queue.
    const queue = renderedQueue({ sizer: 'bytes', size: '600Mi' });
    expect(queue.sendingQueue.queue_size).toBe(100 * MIB);
    writeFile('gateway-bytes.yaml', gatewayConfig(queue, ['logs', 'metrics']));
    stopSink();
    const gateway = startGateway('gateway-bytes', volume, 'gateway-bytes.yaml');
    await waitForGateway(gateway);

    const logs = await send(gateway, 'logs', 400);
    // Each request is just over 512 KiB, so about 190 fit in 100 MiB.
    expect(logs.accepted).toBeGreaterThan(150);
    expect(logs.accepted).toBeLessThan(200);
    expect(logs.refused).toBe(400 - logs.accepted);
    // bbolt keeps somewhat more on disk than the sizer counts.
    expect(fileSize(gateway, 'logs')).toBeLessThan(1.5 * 100 * MIB);

    const metrics = await send(gateway, 'metrics', 20);
    expect(metrics).toEqual({ accepted: 20, refused: 0 });
  });
});
