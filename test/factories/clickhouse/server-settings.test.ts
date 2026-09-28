/**
 * Caller-supplied ClickHouse settings: `serverSettings` and
 * `systemLogs.tables.<log>.settings`.
 *
 * Both compile into server configuration TEXT that the clickhouse-operator
 * writes unescaped, so the suite covers two things: what lands in the rendered
 * CHI (structurally, over `configuration.settings` / `configuration.files`),
 * and that every value that could break the server's XML — or quietly
 * override a setting another option owns — is refused at construction.
 */

import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';
import { makeClickHouseCluster } from '../../../src/factories/clickhouse/compositions/clickhouse-cluster.js';
import { clickHouseInstallation } from '../../../src/factories/clickhouse/resources/installation.js';
import type { ClickHouseS3StorageOptions } from '../../../src/factories/clickhouse/types.js';
import { MERGE_TREE_STORAGE_POLICY_SETTING } from '../../../src/factories/clickhouse/utils/s3-storage.js';
import {
  renderClickHouseSettingValue,
  resolveClickHouseServerSettings,
} from '../../../src/factories/clickhouse/utils/server-settings.js';
import {
  CHI_SYSTEM_LOGS_CONFIG_FILE,
  CLICKHOUSE_OPERATOR_REPLACED_SYSTEM_LOGS,
  operatorReplacedSystemLogEngine,
  resolveClickHouseSystemLogs,
} from '../../../src/factories/clickhouse/utils/system-logs.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

const IRSA_S3: ClickHouseS3StorageOptions = {
  mode: 's3',
  bucket: 'example-observability',
  prefix: 'clickhouse',
  region: 'us-east-2',
  cache: { size: '50Gi' },
  auth: { irsa: { roleArn: 'arn:aws:iam::123456789012:role/clickhouse-s3' } },
};

type InstallationConfig = Parameters<typeof clickHouseInstallation>[0];

function chi(overrides: Partial<InstallationConfig> = {}, s3 = true) {
  return clickHouseInstallation({
    name: 'test-ch',
    namespace: 'observability',
    version: '25.7.8.71',
    storage: s3 ? { ...IRSA_S3, size: '100Gi' } : { size: '100Gi' },
    ...overrides,
  } as InstallationConfig);
}

const settingsOf = (installation: ReturnType<typeof chi>) =>
  (installation.spec.configuration?.settings ?? {}) as Record<string, unknown>;
const filesOf = (installation: ReturnType<typeof chi>) =>
  (installation.spec.configuration?.files ?? {}) as Record<string, string>;

const WIDE_PART_OFF = '1099511627776';

describe('serverSettings', () => {
  it('renders top-level and path-keyed settings into configuration.settings', () => {
    const settings = settingsOf(
      chi({
        serverSettings: {
          memory_worker_correct_memory_tracker: true,
          max_concurrent_queries: 150,
          max_server_memory_usage_to_ram_ratio: 0.85,
          'merge_tree/max_suspicious_broken_parts': '5',
        },
      })
    );
    expect(settings.memory_worker_correct_memory_tracker).toBe('1');
    expect(settings.max_concurrent_queries).toBe('150');
    expect(settings.max_server_memory_usage_to_ram_ratio).toBe('0.85');
    expect(settings['merge_tree/max_suspicious_broken_parts']).toBe('5');
  });

  it('leaves the settings TypeKro renders itself unchanged', () => {
    const without = settingsOf(chi());
    const withSettings = settingsOf(chi({ serverSettings: { max_concurrent_queries: 150 } }));
    const { max_concurrent_queries: added, ...rest } = withSettings;
    expect(added).toBe('150');
    expect(rest).toEqual(without);
  });

  it('renders false as 0 and emits nothing for an empty map', () => {
    expect(settingsOf(chi({ serverSettings: { async_load_databases: false } }))).toMatchObject({
      async_load_databases: '0',
    });
    expect(settingsOf(chi({ serverSettings: {} }))).toEqual(settingsOf(chi()));
  });

  it('works in PVC mode, where TypeKro renders no storage settings', () => {
    const settings = settingsOf(
      chi({ serverSettings: { memory_worker_correct_memory_tracker: true } }, false)
    );
    expect(settings.memory_worker_correct_memory_tracker).toBe('1');
    expect(settings[MERGE_TREE_STORAGE_POLICY_SETTING]).toBeUndefined();
  });

  describe('rejects', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        'an XML-special character in a value',
        { x_setting: 'a<b' },
        /must not contain '<', '>' or '&'/,
      ],
      ['an ampersand in a value', { x_setting: 'a&b' }, /must not contain/],
      ['a control character in a value', { x_setting: 'a\u0001b' }, /XML 1\.0/],
      ['a key with a space', { 'bad key': 1 }, /setting name "bad key" is not valid/],
      ['a key with markup', { 'a><b': 1 }, /is not valid/],
      ['a key with a leading digit', { '1st': 1 }, /is not valid/],
      ['an empty path segment', { 'merge_tree//x': 1 }, /is not valid/],
      ['a non-finite number', { x_setting: Number.POSITIVE_INFINITY }, /finite number/],
      ['an exponent-form number', { x_setting: 1e21 }, /plain decimal/],
      ['an object value', { x_setting: { nested: 1 } }, /must be a string, a number or a boolean/],
      ['the server-wide storage policy', { 'merge_tree/storage_policy': 'x' }, /collides with/],
      ['a system log section', { 'metric_log/ttl': 'x' }, /configured through `systemLogs`/],
      [
        'a system log TypeKro leaves alone',
        { 'session_log/x': 1 },
        /configured through `systemLogs`/,
      ],
      [
        'the storage configuration in S3 mode',
        { 'storage_configuration/disks/x': 1 },
        /through `storage`/,
      ],
      [
        'the keeper section',
        { 'zookeeper/session_timeout_ms': 1 },
        /rendered from the `keeper` option/,
      ],
      ['an operator-generated section', { 'remote_servers/x': 1 }, /clickhouse-operator generates/],
      ['a key and its own child', { a_section: 1, 'a_section/child': 2 }, /conflict/],
    ];
    for (const [label, serverSettings, message] of cases) {
      it(label, () => {
        expect(() => chi({ serverSettings } as Partial<InstallationConfig>)).toThrow(message);
      });
    }

    it('a schema reference, naming the nested path', () => {
      expect(() =>
        chi({
          serverSettings: {
            max_concurrent_queries: {
              [KUBERNETES_REF_BRAND]: true,
              resourceId: '__schema__',
              fieldPath: 'spec.x',
            } as unknown as number,
          },
        })
      ).toThrow(/'serverSettings\.max_concurrent_queries' is a BUILD-TIME topology field/);
    });
  });

  it('allows storage_configuration in PVC mode, where TypeKro renders none', () => {
    expect(() =>
      chi({ serverSettings: { 'storage_configuration/disks/extra/path': '/data/' } }, false)
    ).not.toThrow();
  });

  it('checks prefixes against the generated keys in both directions', () => {
    expect(() =>
      resolveClickHouseServerSettings(
        't',
        { merge_tree: 'x' },
        { generated: { 'merge_tree/storage_policy': 's3_main' }, ownedSections: {} }
      )
    ).toThrow(/collides with the 'merge_tree\/storage_policy' setting/);
    expect(() =>
      resolveClickHouseServerSettings(
        't',
        { 'merge_tree/storage_policy/x': 'y' },
        { generated: { 'merge_tree/storage_policy': 's3_main' }, ownedSections: {} }
      )
    ).toThrow(/collides with/);
  });

  it('renders values the way ClickHouse reads them back', () => {
    expect(renderClickHouseSettingValue('t', true)).toBe('1');
    expect(renderClickHouseSettingValue('t', false)).toBe('0');
    expect(renderClickHouseSettingValue('t', 1099511627776)).toBe('1099511627776');
    expect(renderClickHouseSettingValue('t', 0.5)).toBe('0.5');
    expect(renderClickHouseSettingValue('t', "it's")).toBe("it's");
  });
});

describe('systemLogs.tables.<log>.settings', () => {
  it("renders a settings-configured log's settings as its <settings> element", () => {
    const settings = settingsOf(
      chi({
        systemLogs: {
          tables: {
            metric_log: { settings: { min_bytes_for_wide_part: WIDE_PART_OFF } },
            query_metric_log: {
              settings: { min_bytes_for_wide_part: 1099511627776, index_granularity: 4096 },
            },
          },
        },
      })
    );
    expect(settings['metric_log/settings']).toBe(`min_bytes_for_wide_part = '${WIDE_PART_OFF}'`);
    expect(settings['query_metric_log/settings']).toBe(
      'min_bytes_for_wide_part = 1099511627776, index_granularity = 4096'
    );
    // The pin and TTL are unaffected, and no other log gains a settings key.
    expect(settings['metric_log/storage_policy']).toBe('default');
    expect(settings['metric_log/ttl']).toBe('event_date + INTERVAL 14 DAY DELETE');
    expect(
      Object.keys(settings)
        .filter((key) => key.endsWith('/settings'))
        .sort()
    ).toEqual(['metric_log/settings', 'query_metric_log/settings']);
  });

  it("writes an operator-replaced log's settings inside its engine, after the policy", () => {
    const files = filesOf(
      chi({ systemLogs: { tables: { query_log: { settings: { index_granularity: 4096 } } } } })
    );
    const file = files[CHI_SYSTEM_LOGS_CONFIG_FILE] as string;
    expect(file).toContain(
      '<engine>ENGINE = MergeTree PARTITION BY event_date ORDER BY event_time ' +
        'TTL event_date + INTERVAL 14 DAY DELETE ' +
        "SETTINGS storage_policy = 'default', index_granularity = 4096</engine>"
    );
    // Only query_log carries the extra settings.
    expect(file.match(/index_granularity/g)).toHaveLength(1);
    expect(
      settingsOf(
        chi({ systemLogs: { tables: { query_log: { settings: { index_granularity: 4096 } } } } })
      )['query_log/settings']
    ).toBeUndefined();
  });

  it('replaces only the operator sections that carry settings when policy and TTL are off', () => {
    const files = filesOf(
      chi({
        systemLogs: {
          storagePolicy: false,
          ttl: false,
          tables: { trace_log: { settings: { index_granularity: 4096 } } },
        },
      })
    );
    const file = files[CHI_SYSTEM_LOGS_CONFIG_FILE] as string;
    expect(file).toContain('<trace_log replace="1">');
    expect(file).not.toContain('<query_log');
    expect(file).not.toContain('<part_log');
    // The operator's own TTL is kept, and no storage policy is invented.
    expect(file).toContain(
      'TTL event_date + interval 30 day SETTINGS index_granularity = 4096</engine>'
    );
  });

  it('emits no system-logs file for policy and TTL off with no operator-log settings', () => {
    const files = filesOf(
      chi({
        systemLogs: {
          storagePolicy: false,
          ttl: false,
          tables: { metric_log: { settings: { min_bytes_for_wide_part: WIDE_PART_OFF } } },
        },
      })
    );
    expect(files[CHI_SYSTEM_LOGS_CONFIG_FILE]).toBeUndefined();
  });

  it('quotes string values as SQL literals, escaping quotes and backslashes', () => {
    const resolved = resolveClickHouseSystemLogs(
      't',
      { tables: { part_log: { settings: { some_setting: "a'b\\c", flag: true } } } },
      undefined
    );
    expect(resolved.tableSettings).toEqual({ part_log: "some_setting = 'a\\'b\\\\c', flag = 1" });
    expect(operatorReplacedSystemLogEngine(resolved, 'part_log')).toEndWith(
      "SETTINGS some_setting = 'a\\'b\\\\c', flag = 1"
    );
    // Without a table, the engine is exactly what it was before.
    expect(operatorReplacedSystemLogEngine(resolved)).not.toContain('SETTINGS');
  });

  it('covers every operator-replaced log', () => {
    for (const table of CLICKHOUSE_OPERATOR_REPLACED_SYSTEM_LOGS) {
      const file = filesOf(
        chi({ systemLogs: { tables: { [table]: { settings: { index_granularity: 1024 } } } } })
      )[CHI_SYSTEM_LOGS_CONFIG_FILE] as string;
      expect(file).toContain(`<table>${table}</table>`);
      expect(file).toContain('index_granularity = 1024');
    }
  });

  describe('rejects', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        'an unknown log',
        { not_a_log: { settings: { x: 1 } } },
        /not a system log TypeKro configures/,
      ],
      [
        'the operator-disabled log',
        { query_thread_log: { settings: { x: 1 } } },
        /switches this log off/,
      ],
      [
        'the engine-bound log',
        { opentelemetry_span_log: { settings: { x: 1 } } },
        /its own <engine>/,
      ],
      [
        'the disabled-by-default log',
        { session_log: { settings: { x: 1 } } },
        /ships this log disabled/,
      ],
      [
        'storage_policy',
        { metric_log: { settings: { storage_policy: 'x' } } },
        /use `systemLogs.storagePolicy`/,
      ],
      ['a path-shaped setting name', { metric_log: { settings: { 'a/b': 1 } } }, /is not valid/],
      [
        'an SQL-injection-shaped name',
        { metric_log: { settings: { 'x = 1, y': 1 } } },
        /is not valid/,
      ],
      ['an XML-special value', { metric_log: { settings: { x: '<y>' } } }, /must not contain/],
      ['a non-object entry', { metric_log: 'x' }, /must be an object/],
    ];
    for (const [label, tables, message] of cases) {
      it(label, () => {
        expect(() => chi({ systemLogs: { tables } } as Partial<InstallationConfig>)).toThrow(
          message
        );
      });
    }
  });
});

describe('makeClickHouseCluster', () => {
  const chiSpecOf = (yaml: string) => {
    const rgd = load(yaml) as {
      spec: { resources: { template: { kind?: string; spec?: Record<string, unknown> } }[] };
    };
    return rgd.spec.resources.find(
      (resource) => resource.template?.kind === 'ClickHouseInstallation'
    )?.template.spec as {
      configuration?: { settings?: Record<string, string>; files?: Record<string, string> };
    };
  };

  it('carries both options into the rendered RGD', () => {
    const spec = chiSpecOf(
      makeClickHouseCluster({
        storage: IRSA_S3,
        serverSettings: { memory_worker_correct_memory_tracker: true },
        systemLogs: {
          tables: { metric_log: { settings: { min_bytes_for_wide_part: WIDE_PART_OFF } } },
        },
      }).toYaml()
    );
    expect(spec.configuration?.settings?.memory_worker_correct_memory_tracker).toBe('1');
    expect(spec.configuration?.settings?.['metric_log/settings']).toBe(
      `min_bytes_for_wide_part = '${WIDE_PART_OFF}'`
    );
  });

  it('renders nothing new when neither option is set', () => {
    const settings = chiSpecOf(makeClickHouseCluster({ storage: IRSA_S3 }).toYaml()).configuration
      ?.settings;
    expect(Object.keys(settings ?? {}).some((key) => key.endsWith('/settings'))).toBe(false);
    expect(settings?.memory_worker_correct_memory_tracker).toBeUndefined();
  });

  it('rejects a schema reference in serverSettings at construction', () => {
    expect(() =>
      makeClickHouseCluster({
        serverSettings: {
          max_concurrent_queries: {
            [KUBERNETES_REF_BRAND]: true,
            resourceId: '__schema__',
            fieldPath: 'spec.x',
          } as unknown as number,
        },
      })
    ).toThrow(/build-time option `serverSettings` contains a schema\/resource reference/);
  });
});
