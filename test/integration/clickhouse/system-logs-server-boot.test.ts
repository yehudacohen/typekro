/**
 * ClickHouse system-log configuration against a REAL server (#235).
 *
 * The #232 unit suite only checked the rendered CHI, so it could not see
 * that the Altinity operator's own `config.d` files give `query_log`,
 * `part_log` and `trace_log` a full `<engine>`. ClickHouse refuses to start
 * when an engine-bound log also gets `<ttl>`/`<storage_policy>`. This suite
 * catches that class of bug: it boots `clickhouse-server` with the
 * operator's default system-log files (vendored under `fixtures/`) plus the
 * configuration TypeKro renders, and reads back where every system log
 * actually landed.
 *
 * Docker-gated: the suite SKIPS when no Docker daemon is reachable. Set
 * REQUIRE_DOCKER_TESTS=true to make a missing daemon a failure (CI does).
 *
 * WHAT IT RENDERS, and the one substitution. The CHI's `configuration.settings`
 * are written as `chop-generated-settings.xml` the way the operator renders
 * them (path keys become nested elements), and its `configuration.files`
 * entries are written as-is — EXCEPT `config.d/storage.xml`, whose S3 disks
 * need a bucket. It is replaced by a local-disk policy with the SAME NAME, so
 * the server-wide `merge_tree/storage_policy` still points somewhere other
 * than `default`, which is the arrangement the system-log pins exist to undo.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { clickHouseInstallation } from '../../../src/factories/clickhouse/resources/installation.js';
import type { ClickHouseS3StorageOptions } from '../../../src/factories/clickhouse/types.js';
import { CHI_STORAGE_CONFIG_FILE } from '../../../src/factories/clickhouse/utils/s3-storage.js';
import {
  CHI_SYSTEM_LOGS_CONFIG_FILE,
  CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS,
  CLICKHOUSE_OPERATOR_REMOVED_SYSTEM_LOGS,
  CLICKHOUSE_OPERATOR_REPLACED_SYSTEM_LOGS,
  CLICKHOUSE_SYSTEM_LOG_TABLES,
} from '../../../src/factories/clickhouse/utils/system-logs.js';

setDefaultTimeout(240_000);

// Pinned to an exact build so the regression lane is reproducible; the
// override exists to try the suite against newer servers.
const DEFAULT_VERSION = '25.7.8.71';
const IMAGE = `clickhouse/clickhouse-server:${process.env.CLICKHOUSE_BOOT_TEST_VERSION ?? DEFAULT_VERSION}`;
const OPERATOR_CONFIG_D = join(import.meta.dir, 'fixtures', 'operator-0.27.1-config.d');

function docker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
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

const S3: ClickHouseS3StorageOptions = {
  mode: 's3',
  bucket: 'example-observability',
  prefix: 'clickhouse',
  region: 'us-east-2',
  cache: { size: '10Gi' },
  auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
};

type InstallationConfig = Parameters<typeof clickHouseInstallation>[0];

/** Render `configuration.settings` the way the operator does: path keys → nested elements. */
function renderChopGeneratedSettings(settings: Record<string, unknown>): string {
  interface Node {
    [key: string]: Node | string;
  }
  const tree: Node = {};
  for (const [path, value] of Object.entries(settings)) {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Node;
    }
    node[parts.at(-1) as string] = String(value);
  }
  const render = (node: Node, indent: string): string =>
    Object.keys(node)
      .sort()
      .map((key) => {
        const value = node[key] as Node | string;
        return typeof value === 'string'
          ? `${indent}<${key}>${value}</${key}>`
          : `${indent}<${key}>\n${render(value, `${indent}  `)}\n${indent}</${key}>`;
      })
      .join('\n');
  return `<clickhouse>\n${render(tree, '  ')}\n</clickhouse>\n`;
}

/** A local-disk stand-in for the S3 storage file, keeping the policy name. */
function localStorageStandIn(policyName: string): string {
  return `<clickhouse>
  <storage_configuration>
    <disks><stand_in><path>/var/lib/clickhouse/stand_in/</path></stand_in></disks>
    <policies><${policyName}><volumes><main><disk>stand_in</disk></main></volumes></${policyName}></policies>
  </storage_configuration>
</clickhouse>
`;
}

/** Write the full config.d a server under the operator would see. */
function renderConfigD(
  chi: ReturnType<typeof clickHouseInstallation>,
  {
    extraSettings = {},
    omitFiles = [],
  }: { extraSettings?: Record<string, string>; omitFiles?: string[] } = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'typekro-ch-boot-'));
  for (const file of readdirSync(OPERATOR_CONFIG_D).filter((name) => name.endsWith('.xml'))) {
    copyFileSync(join(OPERATOR_CONFIG_D, file), join(dir, file));
  }
  const settings = { ...(chi.spec.configuration?.settings ?? {}), ...extraSettings };
  writeFileSync(join(dir, 'chop-generated-settings.xml'), renderChopGeneratedSettings(settings));

  const policy = settings['merge_tree/storage_policy'];
  for (const [key, content] of Object.entries(chi.spec.configuration?.files ?? {})) {
    if (omitFiles.includes(key)) continue;
    const body =
      key === CHI_STORAGE_CONFIG_FILE && typeof policy === 'string'
        ? localStorageStandIn(policy)
        : content;
    writeFileSync(join(dir, basename(key)), body);
  }
  return dir;
}

interface BootedServer {
  name: string;
  started: boolean;
  logs: string;
}

const containers: string[] = [];
const dirs: string[] = [];

async function boot(configD: string, label: string): Promise<BootedServer> {
  const name = `typekro-ch-boot-${label}-${process.pid}`;
  docker(['rm', '-f', name]);
  const mounts = readdirSync(configD).flatMap((file) => [
    '-v',
    `${join(configD, file)}:/etc/clickhouse-server/config.d/${file}:ro`,
  ]);
  const run = docker(['run', '-d', '--name', name, ...mounts, IMAGE]);
  if (!run.ok) throw new Error(`docker run failed: ${run.stderr}`);
  containers.push(name);

  for (let attempt = 0; attempt < 90; attempt++) {
    if (docker(['exec', name, 'clickhouse-client', '-q', 'SELECT 1']).ok) {
      return { name, started: true, logs: '' };
    }
    const state = docker(['inspect', '-f', '{{.State.Running}}', name]).stdout;
    if (state === 'false') break;
    await Bun.sleep(1000);
  }
  // The server logs to files, not the console, so the reason it died is in
  // its error log inside the (stopped) container.
  const errLog = join(configD, '..', `${basename(configD)}.err.log`);
  docker(['cp', `${name}:/var/log/clickhouse-server/clickhouse-server.err.log`, errLog]);
  const logs = existsSync(errLog) ? readFileSync(errLog, 'utf8') : docker(['logs', name]).stderr;
  rmSync(errLog, { force: true });
  return { name, started: false, logs };
}

function query(server: BootedServer, sql: string): string {
  const result = docker(['exec', server.name, 'clickhouse-client', '-q', sql]);
  if (!result.ok) throw new Error(`query failed: ${sql}\n${result.stderr}`);
  return result.stdout;
}

afterAll(() => {
  for (const name of containers) docker(['rm', '-f', name]);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describeOrSkip('ClickHouse system logs on a real server under the operator defaults (#235)', () => {
  const s3Installation = () =>
    clickHouseInstallation({
      name: 'boot',
      namespace: 'test',
      version: '25.7.8.71',
      storage: { ...S3, size: '10Gi' },
    } as InstallationConfig);
  const LEGACY_SETTING = { 'query_log/ttl': 'event_date + INTERVAL 14 DAY DELETE' };

  it('CONTROL: the harness reproduces the 0.37.0 crash', async () => {
    // 0.37.0's arrangement: a path-keyed setting for an operator-bound log and
    // no replacing file. If the harness did not reproduce the exit-36 crash,
    // the passing tests below would prove nothing.
    const dir = renderConfigD(s3Installation(), {
      extraSettings: LEGACY_SETTING,
      omitFiles: [CHI_SYSTEM_LOGS_CONFIG_FILE],
    });
    dirs.push(dir);
    const server = await boot(dir, 'control');
    expect(server.started).toBe(false);
    expect(server.logs).toContain("If 'engine' is specified for system table");
  });

  it('the replacing file wins even over a stray setting for the same log', async () => {
    // system-logs.xml sorts after chop-generated-settings.xml and replaces
    // the section wholesale, so a leftover `query_log/ttl` (from a caller's
    // own settings, say) is discarded instead of crashing the server.
    const dir = renderConfigD(s3Installation(), { extraSettings: LEGACY_SETTING });
    dirs.push(dir);
    const server = await boot(dir, 'stray');
    expect(server.logs).toBe('');
    expect(server.started).toBe(true);
  });

  it('boots, pins every system log to the local disk, and leaves user tables on the server-wide policy', async () => {
    const dir = renderConfigD(s3Installation());
    dirs.push(dir);
    const server = await boot(dir, 's3');
    expect(server.logs).toBe('');
    expect(server.started).toBe(true);

    // System log tables are created on first flush; force it.
    query(server, 'SYSTEM FLUSH LOGS');
    const rows = query(
      server,
      "SELECT name, storage_policy, engine_full LIKE '%TTL event_date + toIntervalDay(14)%' " +
        "FROM system.tables WHERE database = 'system' AND name LIKE '%\\_log' ORDER BY name FORMAT TSV"
    )
      .split('\n')
      .map((line) => line.split('\t'));
    const byName = new Map(rows.map(([name, policy, hasTtl]) => [name, { policy, hasTtl }]));

    for (const table of ['query_log', 'part_log', 'trace_log', 'metric_log', 'text_log']) {
      expect(byName.get(table)).toEqual({ policy: 'default', hasTtl: '1' });
    }
    // Every log TypeKro configures is pinned and trimmed. Scoped to the known
    // lists rather than every `*_log`, so a server newer than 25.7 (see
    // CLICKHOUSE_BOOT_TEST_VERSION) is not failed for logs it added later.
    const configured = [
      ...CLICKHOUSE_SYSTEM_LOG_TABLES,
      ...CLICKHOUSE_OPERATOR_REPLACED_SYSTEM_LOGS,
    ];
    const unpinned = rows.filter(
      ([name, policy, hasTtl]) =>
        (configured as readonly string[]).includes(name as string) &&
        (policy !== 'default' || hasTtl !== '1')
    );
    expect(unpinned).toEqual([]);
    // ...and on 25.7 that is every default-enabled log bar the engine-bound one.
    if (IMAGE.endsWith(`:${DEFAULT_VERSION}`)) {
      const leftover = rows
        .map(([name]) => name as string)
        .filter(
          (name) =>
            !(configured as readonly string[]).includes(name) &&
            !(CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS as readonly string[]).includes(name)
        );
      expect(leftover).toEqual([]);
    }
    // The operator switched query_thread_log off, and it stays off.
    for (const table of CLICKHOUSE_OPERATOR_REMOVED_SYSTEM_LOGS) {
      expect(byName.has(table)).toBe(false);
    }

    // User data still follows the server-wide default.
    query(server, 'CREATE TABLE default.probe (x UInt8) ENGINE = MergeTree ORDER BY x');
    expect(
      query(
        server,
        "SELECT storage_policy FROM system.tables WHERE database = 'default' AND name = 'probe'"
      )
    ).toBe('s3_main');
  });

  it('boots in PVC mode with the operator-bound logs trimmed but not re-pinned', async () => {
    const chi = clickHouseInstallation({
      name: 'boot',
      namespace: 'test',
      version: '25.7.8.71',
      storage: { size: '10Gi' },
    } as InstallationConfig);
    const dir = renderConfigD(chi);
    dirs.push(dir);
    const server = await boot(dir, 'pvc');
    expect(server.logs).toBe('');
    expect(server.started).toBe(true);

    query(server, 'SYSTEM FLUSH LOGS');
    expect(
      query(
        server,
        "SELECT engine_full FROM system.tables WHERE database = 'system' AND name = 'query_log'"
      )
    ).toContain('TTL event_date + toIntervalDay(14)');
  });

  /**
   * `ttl: false` means "TypeKro does not manage retention": every log keeps
   * whatever TTL ClickHouse or the operator already gives it. The three
   * configurations below reach that through different code paths — the
   * replacing file is written in the first (for the storage pin) and not in
   * the other two — and must all land in the same place.
   */
  const ttlFalseCases: { label: string; config: Partial<InstallationConfig>; policy: string }[] = [
    {
      label: 's3-ttl-false',
      config: { storage: { ...S3, size: '10Gi' }, systemLogs: { ttl: false } },
      policy: 'default',
    },
    {
      label: 'pvc-ttl-false',
      config: { storage: { size: '10Gi' }, systemLogs: { ttl: false } },
      policy: 'default',
    },
    {
      label: 's3-both-false',
      config: {
        storage: { ...S3, size: '10Gi' },
        systemLogs: { storagePolicy: false, ttl: false },
      },
      policy: 's3_main',
    },
  ];
  for (const { label, config, policy } of ttlFalseCases) {
    it(`ttl: false delegates retention to the upstream defaults (${label})`, async () => {
      const chi = clickHouseInstallation({
        name: 'boot',
        namespace: 'test',
        version: '25.7.8.71',
        ...config,
      } as InstallationConfig);
      const dir = renderConfigD(chi);
      dirs.push(dir);
      const server = await boot(dir, label);
      expect(server.logs).toBe('');
      expect(server.started).toBe(true);

      query(server, 'SYSTEM FLUSH LOGS');
      const engines = new Map(
        query(
          server,
          "SELECT name, storage_policy, engine_full FROM system.tables WHERE database = 'system' " +
            "AND name IN ('query_log', 'part_log', 'trace_log', 'metric_log', 'processors_profile_log') FORMAT TSV"
        )
          .split('\n')
          .map((line) => line.split('\t'))
          .map(([name, storagePolicy, engine]) => [name, { storagePolicy, engine: engine ?? '' }])
      );
      // The operator's 30-day TTL on the three logs it defines...
      for (const table of CLICKHOUSE_OPERATOR_REPLACED_SYSTEM_LOGS) {
        expect(engines.get(table)?.engine).toContain('TTL event_date + toIntervalDay(30)');
        expect(engines.get(table)?.storagePolicy).toBe(policy);
      }
      // ...ClickHouse's own TTL where it ships one...
      expect(engines.get('processors_profile_log')?.engine).toContain(
        'TTL event_date + toIntervalDay(30)'
      );
      // ...and no TTL where ClickHouse ships none.
      expect(engines.get('metric_log')?.engine).not.toContain('TTL');
    });
  }
});
