import { describe, expect, it } from 'bun:test';
import * as clickhouse from '../../../src/factories/clickhouse/index.js';

describe('ClickHouse public exports', () => {
  it('Import ClickHouse APIs from typekro/clickhouse through package metadata', async () => {
    const packageJson = (await Bun.file('package.json').json()) as {
      exports: Record<string, Record<string, string>>;
      files: string[];
    };

    expect(packageJson.exports['./clickhouse']).toEqual({
      import: './dist/factories/clickhouse/index.js',
      types: './dist/factories/clickhouse/index.d.ts',
    });
    expect(packageJson.files).toContain('dist');
  });

  it('Export factories, compositions, schemas, helpers, and constants', () => {
    expect(typeof clickhouse.clickHouseInstallation).toBe('function');
    expect(typeof clickhouse.clickHouseKeeperInstallation).toBe('function');
    expect(typeof clickhouse.clickhouseHelmRepository).toBe('function');
    expect(typeof clickhouse.clickhouseOperatorHelmRelease).toBe('function');
    expect(clickhouse.clickhouseOperatorBootstrap).toBeDefined();
    expect(clickhouse.clickhouseHelmRepositoryBootstrap).toBeDefined();
    expect(typeof clickhouse.mapClickHouseOperatorConfigToHelmValues).toBe('function');
    expect(typeof clickhouse.assignZonesRoundRobin).toBe('function');
    expect(typeof clickhouse.compileZonePinnedLayout).toBe('function');
    expect(clickhouse.ClickHouseOperatorBootstrapConfigSchema).toBeDefined();
    expect(clickhouse.ClickHouseOperatorBootstrapStatusSchema).toBeDefined();
    expect(clickhouse.ClickHouseInstallationConfigSchema).toBeDefined();
    expect(clickhouse.ClickHouseKeeperInstallationConfigSchema).toBeDefined();
    expect(clickhouse.DEFAULT_CLICKHOUSE_REPO_URL).toBe('https://helm.altinity.com');
    expect(clickhouse.DEFAULT_CLICKHOUSE_REPO_NAME).toBe('altinity');
    expect(clickhouse.CLICKHOUSE_OPERATOR_CHART_NAME).toBe('altinity-clickhouse-operator');
    expect(clickhouse.DEFAULT_CLICKHOUSE_OPERATOR_VERSION).toBe('0.27.1');
    expect(clickhouse.DEFAULT_CHI_CLUSTER_NAME).toBe('cluster');
    expect(clickhouse.ZONE_TOPOLOGY_KEY).toBe('topology.kubernetes.io/zone');
  });
});
