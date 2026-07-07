import { describe, expect, it } from 'bun:test';
import {
  CLICKHOUSE_OPERATOR_CHART_NAME,
  clickhouseHelmRepository,
  clickhouseOperatorHelmRelease,
  DEFAULT_CLICKHOUSE_OPERATOR_VERSION,
  DEFAULT_CLICKHOUSE_REPO_NAME,
  DEFAULT_CLICKHOUSE_REPO_URL,
} from '../../../src/factories/clickhouse/resources/helm.js';
import { isValuesMergeExpression } from '../../../src/core/aspects/values-merge.js';
import {
  type ClickHouseOperatorHelmValues,
  mapClickHouseOperatorConfigToHelmValues,
} from '../../../src/factories/clickhouse/utils/helm-values-mapper.js';
import { KUBERNETES_REF_BRAND } from '../../../src/shared/brands.js';

describe('ClickHouse Helm Resources', () => {
  describe('clickhouseHelmRepository', () => {
    it('should create a HelmRepository with Altinity defaults', () => {
      const repo = clickhouseHelmRepository({ id: 'clickhouseRepo' });

      expect(repo.kind).toBe('HelmRepository');
      expect(repo.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(repo.metadata.name).toBe('altinity');
      expect(repo.metadata.namespace).toBe('flux-system');
      expect(repo.spec.url).toBe('https://helm.altinity.com');
      expect(repo.spec.interval).toBe('5m');
    });

    it('should allow overriding defaults', () => {
      const repo = clickhouseHelmRepository({
        name: 'custom-repo',
        namespace: 'custom-ns',
        url: 'https://custom.charts.io',
        interval: '10m',
      });

      expect(repo.metadata.name).toBe('custom-repo');
      expect(repo.metadata.namespace).toBe('custom-ns');
      expect(repo.spec.url).toBe('https://custom.charts.io');
      expect(repo.spec.interval).toBe('10m');
    });

    it('should have a readiness evaluator', () => {
      const repo = clickhouseHelmRepository({ name: 'test-repo' });
      expect(repo.readinessEvaluator).toBeDefined();
    });
  });

  describe('clickhouseOperatorHelmRelease', () => {
    it('should create a HelmRelease with the official chart coordinates', () => {
      const release = clickhouseOperatorHelmRelease({
        name: 'clickhouse-operator',
        id: 'clickhouseOperatorRelease',
      });

      expect(release.kind).toBe('HelmRelease');
      expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
      expect(release.metadata.name).toBe('clickhouse-operator');
      expect(release.metadata.namespace).toBe('clickhouse-system');
      expect(release.spec.chart?.spec?.chart).toBe('altinity-clickhouse-operator');
      expect(release.spec.chart?.spec?.version).toBe('0.27.1');
      expect(release.spec.chart?.spec?.sourceRef?.name).toBe('altinity');
    });

    it('should expose the official defaults as constants', () => {
      expect(DEFAULT_CLICKHOUSE_REPO_URL).toBe('https://helm.altinity.com');
      expect(DEFAULT_CLICKHOUSE_REPO_NAME).toBe('altinity');
      expect(CLICKHOUSE_OPERATOR_CHART_NAME).toBe('altinity-clickhouse-operator');
      expect(DEFAULT_CLICKHOUSE_OPERATOR_VERSION).toBe('0.27.1');
    });

    it('should allow overriding version and namespace', () => {
      const release = clickhouseOperatorHelmRelease({
        name: 'clickhouse-operator',
        namespace: 'custom-ns',
        version: '0.28.0',
      });

      expect(release.metadata.namespace).toBe('custom-ns');
      expect(release.spec.chart?.spec?.version).toBe('0.28.0');
    });

    it('should have a readiness evaluator', () => {
      const release = clickhouseOperatorHelmRelease({ name: 'clickhouse-operator' });
      expect(release.readinessEvaluator).toBeDefined();
    });
  });
});

describe('ClickHouse Operator Helm Values Mapper', () => {
  /** Narrow the mapper result to plain values (concrete customValues path). */
  function plainValues(
    result: ReturnType<typeof mapClickHouseOperatorConfigToHelmValues>
  ): ClickHouseOperatorHelmValues {
    expect(isValuesMergeExpression(result)).toBe(false);
    return result as ClickHouseOperatorHelmValues;
  }

  it('should return empty values for minimal config (chart defaults win)', () => {
    const values = plainValues(mapClickHouseOperatorConfigToHelmValues({}));
    expect(values).toEqual({});
  });

  it('should map metrics and crdHook toggles', () => {
    const values = plainValues(
      mapClickHouseOperatorConfigToHelmValues({
        metrics: { enabled: false },
        crdHook: { enabled: true },
      })
    );
    expect(values.metrics).toEqual({ enabled: false });
    expect(values.crdHook).toEqual({ enabled: true });
  });

  it('should map operator resources', () => {
    const values = plainValues(
      mapClickHouseOperatorConfigToHelmValues({
        resources: { requests: { cpu: '100m', memory: '128Mi' } },
      })
    );
    expect(values.operator?.resources?.requests?.cpu).toBe('100m');
  });

  it('should deep-merge concrete custom values last (overrides win)', () => {
    const values = plainValues(
      mapClickHouseOperatorConfigToHelmValues({
        metrics: { enabled: true },
        customValues: { metrics: { enabled: false }, nodeSelector: { os: 'linux' } },
      })
    );
    expect(values.metrics).toEqual({ enabled: false });
    expect(values.nodeSelector).toEqual({ os: 'linux' });
  });

  it('should wrap ref-shaped custom values in a graph-aware runtime merge', () => {
    // In graph mode the bootstrap receives `customValues` as a schema proxy
    // ref. The mapper must route it through mergeValuesExpression (the core
    // runtime values-merge) instead of dropping it — that is what makes the
    // override land in the KRO-serialized HelmRelease values.
    const schemaRef = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: '__schema__',
      fieldPath: 'spec.customValues',
    };
    const result = mapClickHouseOperatorConfigToHelmValues({
      metrics: { enabled: true },
      customValues: schemaRef as never,
    });
    expect(isValuesMergeExpression(result)).toBe(true);
  });
});
