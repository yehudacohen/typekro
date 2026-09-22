/**
 * ClickHouse system log tables: where they live, and how long they live.
 *
 * REGRESSION SUITE for #232. The composition sets the S3 storage policy as the
 * SERVER-WIDE MergeTree default so that tooling outside TypeKro creates its
 * tables on object storage with no per-table DDL — deliberate, and it stays.
 * What must NOT happen is ClickHouse's OWN `system.*_log` tables being dragged
 * onto object storage by that same default: they write constantly, nothing
 * reads them, and their object-store metadata is walked at every boot until
 * the server can no longer start.
 *
 * Every assertion here is STRUCTURAL — over the rendered CHI's
 * `configuration.settings` map, not over a string-matched YAML blob — so a
 * setting that silently changes shape fails the test rather than passing it.
 */

import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';
import { clickHouseInstallation } from '../../../src/factories/clickhouse/resources/installation.js';
import { makeClickHouseCluster } from '../../../src/factories/clickhouse/compositions/clickhouse-cluster.js';
import type { ClickHouseS3StorageOptions } from '../../../src/factories/clickhouse/types.js';
import {
  CLICKHOUSE_DEFAULT_STORAGE_POLICY,
  CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS,
  CLICKHOUSE_SYSTEM_LOG_TABLES,
  DEFAULT_SYSTEM_LOG_RETENTION_DAYS,
  clickHouseSystemLogSettings,
  defaultSystemLogTtl,
  resolveClickHouseSystemLogs,
} from '../../../src/factories/clickhouse/utils/system-logs.js';
import { MERGE_TREE_STORAGE_POLICY_SETTING } from '../../../src/factories/clickhouse/utils/s3-storage.js';
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

function s3Chi(overrides: Partial<InstallationConfig> = {}) {
  return clickHouseInstallation({
    name: 'test-ch',
    namespace: 'observability',
    version: '25.7.8.71',
    storage: { ...IRSA_S3, size: '100Gi' },
    ...overrides,
  } as InstallationConfig);
}

function settingsOf(chi: ReturnType<typeof clickHouseInstallation>): Record<string, unknown> {
  return (chi.spec.configuration?.settings ?? {}) as Record<string, unknown>;
}

describe('ClickHouse system log tables (#232)', () => {
  describe('the table list', () => {
    it('is the DEFAULT-ENABLED set from ClickHouse 25.7 config.xml', () => {
      // Source: the `<*_log>` sections of ClickHouse's own shipped
      // programs/server/config.xml at v25.7.1.3997-stable. Pinned literally,
      // because the whole point of the list is that it was READ rather than
      // guessed — a change to it should be a deliberate edit with a source.
      expect([...CLICKHOUSE_SYSTEM_LOG_TABLES]).toEqual([
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
      ]);
    });

    it('omits session_log, whose section ClickHouse ships COMMENTED OUT', () => {
      // A system log exists if and only if its config section exists
      // (createSystemLog() in src/Interpreters/SystemLog.cpp returns early on
      // a missing section). Emitting `<session_log><storage_policy>` would
      // therefore ENABLE a log the server does not run today — a storage fix
      // that quietly starts recording every login is not a storage fix.
      expect(CLICKHOUSE_SYSTEM_LOG_TABLES).not.toContain('session_log' as never);
    });

    it('omits opentelemetry_span_log, which declares its own <engine>', () => {
      // SystemLog.cpp throws BAD_ARGUMENTS at STARTUP when a log declares both
      // <engine> and <storage_policy>/<ttl>. Pinning it would turn a storage
      // fix into a server that refuses to boot.
      expect([...CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS]).toEqual(['opentelemetry_span_log']);
      for (const table of CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS) {
        expect(CLICKHOUSE_SYSTEM_LOG_TABLES).not.toContain(table as never);
      }
    });
  });

  describe('rendered CHI settings in S3 mode', () => {
    it('pins every system log table to the local default disk', () => {
      const settings = settingsOf(s3Chi());
      for (const table of CLICKHOUSE_SYSTEM_LOG_TABLES) {
        expect(settings[`${table}/storage_policy`]).toBe(CLICKHOUSE_DEFAULT_STORAGE_POLICY);
      }
    });

    it('gives every system log table the default retention TTL', () => {
      const settings = settingsOf(s3Chi());
      expect(DEFAULT_SYSTEM_LOG_RETENTION_DAYS).toBe(14);
      for (const table of CLICKHOUSE_SYSTEM_LOG_TABLES) {
        expect(settings[`${table}/ttl`]).toBe('event_date + INTERVAL 14 DAY DELETE');
      }
    });

    it('REGRESSION: the server-wide MergeTree default no longer reaches system tables', () => {
      // The two halves of the fix, asserted against each other. The server-wide
      // default is UNCHANGED — it is what makes externally-created tables land
      // on object storage — and every system log table now names a DIFFERENT
      // policy, so the default cannot reach them. Structural: no setting whose
      // key is a system log's storage_policy may carry the S3 policy name.
      const settings = settingsOf(s3Chi());
      expect(settings[MERGE_TREE_STORAGE_POLICY_SETTING]).toBe('s3_main');

      const onObjectStorage = Object.entries(settings).filter(
        ([key, value]) => key.endsWith('/storage_policy') && value === 's3_main'
      );
      expect(onObjectStorage.map(([key]) => key)).toEqual([MERGE_TREE_STORAGE_POLICY_SETTING]);
    });

    it("leaves a caller's own storage policy for created tables untouched", () => {
      // The route NOT taken: scoping the policy to the created tables would
      // have moved where USER data lands. It must not have moved.
      const chi = s3Chi({ storage: { ...IRSA_S3, policyName: 'telemetry_s3', size: '100Gi' } });
      const settings = settingsOf(chi);
      expect(settings[MERGE_TREE_STORAGE_POLICY_SETTING]).toBe('telemetry_s3');
      expect(settings['query_log/storage_policy']).toBe(CLICKHOUSE_DEFAULT_STORAGE_POLICY);
      // The rendered storage_configuration still declares that policy.
      expect(chi.spec.configuration?.files?.['config.d/storage.xml']).toContain('telemetry_s3');
    });

    it('emits no settings key outside the server-wide default and the per-log pins', () => {
      const settings = settingsOf(s3Chi());
      const unexpected = Object.keys(settings).filter(
        (key) =>
          key !== MERGE_TREE_STORAGE_POLICY_SETTING &&
          !CLICKHOUSE_SYSTEM_LOG_TABLES.some(
            (table) => key === `${table}/storage_policy` || key === `${table}/ttl`
          )
      );
      expect(unexpected).toEqual([]);
    });
  });

  describe('rendered CHI settings in PVC mode', () => {
    const pvc = clickHouseInstallation({
      name: 'test-ch',
      version: '25.7.8.71',
      storage: { size: '10Gi' },
    });

    it('still applies retention — unbounded growth is disk-independent', () => {
      const settings = settingsOf(pvc);
      for (const table of CLICKHOUSE_SYSTEM_LOG_TABLES) {
        expect(settings[`${table}/ttl`]).toBe('event_date + INTERVAL 14 DAY DELETE');
      }
    });

    it('pins nothing: there is no server-wide policy to pin away from', () => {
      const settings = settingsOf(pvc);
      expect(settings[MERGE_TREE_STORAGE_POLICY_SETTING]).toBeUndefined();
      expect(Object.keys(settings).filter((key) => key.endsWith('/storage_policy'))).toEqual([]);
    });
  });

  describe('configurability', () => {
    it('honours a custom retention window', () => {
      const settings = settingsOf(s3Chi({ systemLogs: { retentionDays: 3 } }));
      expect(settings['query_log/ttl']).toBe('event_date + INTERVAL 3 DAY DELETE');
    });

    it('honours a verbatim TTL expression over retentionDays', () => {
      const settings = settingsOf(
        s3Chi({ systemLogs: { ttl: 'event_date + INTERVAL 2 WEEK DELETE', retentionDays: 3 } })
      );
      expect(settings['metric_log/ttl']).toBe('event_date + INTERVAL 2 WEEK DELETE');
    });

    it('emits no TTL at all for `ttl: false`', () => {
      const settings = settingsOf(s3Chi({ systemLogs: { ttl: false } }));
      expect(Object.keys(settings).filter((key) => key.endsWith('/ttl'))).toEqual([]);
      // ...and the storage pin is untouched by that choice.
      expect(settings['query_log/storage_policy']).toBe(CLICKHOUSE_DEFAULT_STORAGE_POLICY);
    });

    it('pins to a named policy when one is given', () => {
      const settings = settingsOf(s3Chi({ systemLogs: { storagePolicy: 'local_ssd' } }));
      expect(settings['trace_log/storage_policy']).toBe('local_ssd');
    });

    it('emits no pin at all for `storagePolicy: false`', () => {
      const settings = settingsOf(s3Chi({ systemLogs: { storagePolicy: false } }));
      expect(
        CLICKHOUSE_SYSTEM_LOG_TABLES.filter(
          (table) => settings[`${table}/storage_policy`] !== undefined
        )
      ).toEqual([]);
      // Opting out restores exactly the pre-fix arrangement — the server-wide
      // default, reaching everything — which is what `false` promises.
      expect(settings[MERGE_TREE_STORAGE_POLICY_SETTING]).toBe('s3_main');
    });

    it('rejects a nonsensical retention window loudly', () => {
      expect(() => s3Chi({ systemLogs: { retentionDays: 0 } })).toThrow(
        /systemLogs\.retentionDays must be a positive integer/
      );
    });
  });

  describe('resolveClickHouseSystemLogs', () => {
    it('pins only when the installation sets a server-wide policy', () => {
      expect(resolveClickHouseSystemLogs('t', undefined, undefined).storagePolicy).toBeUndefined();
      expect(resolveClickHouseSystemLogs('t', undefined, 's3_main').storagePolicy).toBe('default');
    });

    it('emits nothing when both halves are disabled', () => {
      const resolved = resolveClickHouseSystemLogs(
        't',
        { storagePolicy: false, ttl: false },
        's3_main'
      );
      expect(clickHouseSystemLogSettings(resolved)).toEqual({});
    });

    it('builds the default TTL expression from the retention window', () => {
      expect(defaultSystemLogTtl(30)).toBe('event_date + INTERVAL 30 DAY DELETE');
    });
  });

  /**
   * The build-time contract has TWO public doors, and the docs state it without
   * naming one: "a schema reference in either is rejected at construction".
   * `makeClickHouseCluster` walked `systemLogs` recursively; the low-level
   * `clickHouseInstallation` only tested whether the WHOLE object was a
   * reference. A nested one — the realistic mistake — went through, and
   * `storagePolicy` was the bad case: the raw marker object landed in the
   * rendered `query_log/storage_policy` setting with no error at all.
   */
  describe('nested schema references through clickHouseInstallation', () => {
    const schemaRef = (fieldPath: string) =>
      ({
        [KUBERNETES_REF_BRAND]: true,
        resourceId: '__schema__',
        fieldPath,
      }) as unknown as string;

    it('rejects a reference in systemLogs.storagePolicy rather than rendering it', () => {
      expect(() =>
        s3Chi({
          systemLogs: { storagePolicy: schemaRef('spec.storagePolicy') },
        } as unknown as Partial<InstallationConfig>)
      ).toThrow(
        /'systemLogs\.storagePolicy' is a BUILD-TIME topology field and received a schema reference or CEL expression/
      );
    });

    it('rejects a reference in systemLogs.ttl with an explanatory message', () => {
      let message = '';
      try {
        s3Chi({
          systemLogs: { ttl: schemaRef('spec.ttl') },
        } as unknown as Partial<InstallationConfig>);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('systemLogs.ttl');
      expect(message).toContain('ClickHouse server configuration TEXT');
      expect(message).toContain('makeClickHouseCluster({ systemLogs })');
      // The OLD failure mode: the ref reached the TTL string handling and blew
      // up as `ttl.trim is not a function`, which named neither cause nor fix.
      expect(message).not.toMatch(/is not a function/);
    });

    it('rejects a reference in systemLogs.retentionDays', () => {
      expect(() =>
        s3Chi({
          systemLogs: { retentionDays: schemaRef('spec.retentionDays') },
        } as unknown as Partial<InstallationConfig>)
      ).toThrow(/'systemLogs\.retentionDays' is a BUILD-TIME topology field/);
    });

    it('still rejects a reference as the whole systemLogs object', () => {
      expect(() =>
        s3Chi({
          systemLogs: schemaRef('spec.systemLogs'),
        } as unknown as Partial<InstallationConfig>)
      ).toThrow(/'systemLogs' is a BUILD-TIME topology field/);
    });

    it('leaves a concrete systemLogs untouched', () => {
      expect(() => s3Chi({ systemLogs: { retentionDays: 30 } })).not.toThrow();
    });
  });

  describe('makeClickHouseCluster', () => {
    it('carries the per-log settings into the rendered RGD', () => {
      const yaml = makeClickHouseCluster({ storage: IRSA_S3 }).toYaml();
      const rgd = load(yaml) as {
        spec: { resources: { template: { kind?: string; spec?: Record<string, never> } }[] };
      };
      const chi = rgd.spec.resources.find(
        (resource) => resource.template?.kind === 'ClickHouseInstallation'
      );
      const settings = (
        chi?.template.spec as unknown as {
          configuration?: { settings?: Record<string, string> };
        }
      )?.configuration?.settings;

      expect(settings?.[MERGE_TREE_STORAGE_POLICY_SETTING]).toBe('s3_main');
      for (const table of CLICKHOUSE_SYSTEM_LOG_TABLES) {
        expect(settings?.[`${table}/storage_policy`]).toBe(CLICKHOUSE_DEFAULT_STORAGE_POLICY);
        expect(settings?.[`${table}/ttl`]).toBe('event_date + INTERVAL 14 DAY DELETE');
      }
    });

    it('passes a topology override through to the installation', () => {
      const yaml = makeClickHouseCluster({
        storage: IRSA_S3,
        systemLogs: { retentionDays: 7 },
      }).toYaml();
      expect(yaml).toContain('query_log/ttl: event_date + INTERVAL 7 DAY DELETE');
    });

    it('rejects a schema reference in the build-time option', () => {
      expect(() =>
        makeClickHouseCluster({
          systemLogs: {
            ttl: {
              [KUBERNETES_REF_BRAND]: true,
              resourceId: '__schema__',
              fieldPath: 'spec.ttl',
            } as unknown as string,
          },
        })
      ).toThrow(/build-time option `systemLogs` contains a schema\/resource reference/);
    });
  });
});
