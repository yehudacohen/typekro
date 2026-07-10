import { describe, expect, it } from 'bun:test';

import { isValuesMergeExpression } from '../../../src/core/aspects/values-merge.js';
import { Cel } from '../../../src/core/references/cel.js';
import {
  DEFAULT_ROOK_CEPH_REPO_NAME,
  DEFAULT_ROOK_CEPH_REPO_URL,
  DEFAULT_ROOK_CEPH_VERSION,
  mapRookCephOperatorConfigToHelmValues,
  ROOK_CEPH_OPERATOR_CHART_NAME,
  rookCephHelmRepository,
  rookCephOperatorHelmRelease,
} from '../../../src/factories/rook/index.js';

describe('Rook Helm integration', () => {
  it('uses current official chart coordinates', () => {
    const repository = rookCephHelmRepository({});
    const release = rookCephOperatorHelmRelease({ name: 'rook-ceph' });

    expect(repository.spec.url).toBe(DEFAULT_ROOK_CEPH_REPO_URL);
    expect(repository.metadata.name).toBe(DEFAULT_ROOK_CEPH_REPO_NAME);
    expect(release.spec.chart.spec.chart).toBe(ROOK_CEPH_OPERATOR_CHART_NAME);
    expect(release.spec.chart.spec.version).toBe(DEFAULT_ROOK_CEPH_VERSION);
    expect(release.spec.chart.spec.sourceRef.name).toBe(DEFAULT_ROOK_CEPH_REPO_NAME);
  });

  it('maps typed chart options and deep-merges raw values last', () => {
    const values = mapRookCephOperatorConfigToHelmValues({
      logLevel: 'DEBUG',
      enableOBCWatchOperatorNamespace: false,
      obcProvisionerNamePrefix: 'platform',
      obcAllowAdditionalConfigFields: 'maxObjects,maxSize,bucketLifecycle',
      resources: { requests: { cpu: '200m', memory: '128Mi' } },
      values: {
        resources: { requests: { cpu: '500m' }, limits: { memory: '512Mi' } },
        monitoring: { enabled: true },
      },
    });

    expect(values).toEqual({
      logLevel: 'DEBUG',
      enableOBCWatchOperatorNamespace: false,
      obcProvisionerNamePrefix: 'platform',
      obcAllowAdditionalConfigFields: 'maxObjects,maxSize,bucketLifecycle',
      resources: {
        requests: { cpu: '500m', memory: '128Mi' },
        limits: { memory: '512Mi' },
      },
      monitoring: { enabled: true },
    });
    expect(values).not.toHaveProperty('name');
    expect(values).not.toHaveProperty('namespace');
    expect(values).not.toHaveProperty('version');
  });

  it('replaces arrays and guards prototype keys during raw values merge', () => {
    const values = mapRookCephOperatorConfigToHelmValues({
      logLevel: undefined,
      enableOBCWatchOperatorNamespace: undefined,
      obcProvisionerNamePrefix: undefined,
      obcAllowAdditionalConfigFields: undefined,
      resources: undefined,
      values: JSON.parse('{"tolerations":[{"key":"storage"}],"__proto__":{"polluted":true}}'),
    });

    expect(values).toEqual({ tolerations: [{ key: 'storage' }] });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('preserves a whole-map graph value as a runtime values merge', () => {
    const graphValues = Cel.expr<Record<string, unknown>>('schema.spec.values');
    const values = mapRookCephOperatorConfigToHelmValues({
      logLevel: 'INFO',
      enableOBCWatchOperatorNamespace: undefined,
      obcProvisionerNamePrefix: undefined,
      obcAllowAdditionalConfigFields: undefined,
      resources: undefined,
      values: graphValues,
    });

    expect(isValuesMergeExpression(values)).toBe(true);
  });
});
