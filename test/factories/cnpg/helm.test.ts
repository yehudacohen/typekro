import { describe, expect, it } from 'bun:test';
import { cnpgHelmRepository, cnpgHelmRelease } from '../../../src/factories/cnpg/resources/helm.js';
import {
  mapCnpgConfigToHelmValues,
  getCnpgHelmValueWarnings,
} from '../../../src/factories/cnpg/utils/helm-values-mapper.js';

describe('CNPG Helm Resources', () => {
  describe('cnpgHelmRepository', () => {
    it('should create a HelmRepository with CNPG defaults', () => {
      const repo = cnpgHelmRepository({
        name: 'cnpg-repo',
        id: 'cnpgRepo',
      });

      expect(repo.kind).toBe('HelmRepository');
      expect(repo.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(repo.metadata.name).toBe('cnpg-repo');
      expect(repo.metadata.namespace).toBe('flux-system');
      expect(repo.spec.url).toBe('https://cloudnative-pg.github.io/charts');
      expect(repo.spec.interval).toBe('5m');
    });

    it('should allow overriding defaults', () => {
      const repo = cnpgHelmRepository({
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
      const repo = cnpgHelmRepository({ name: 'test-repo' });
      expect(repo.readinessEvaluator).toBeDefined();
    });
  });

  describe('cnpgHelmRelease', () => {
    it('should create a HelmRelease with CNPG defaults', () => {
      const release = cnpgHelmRelease({
        name: 'cnpg',
        id: 'cnpgRelease',
      });

      expect(release.kind).toBe('HelmRelease');
      expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
      expect(release.metadata.name).toBe('cnpg');
      expect(release.metadata.namespace).toBe('cnpg-system');
    });

    it('should include CRD creation in default values', () => {
      const release = cnpgHelmRelease({ name: 'cnpg' });
      expect(release.spec.values?.crds?.create).toBe(true);
    });

    it('should sanitize proxy objects from values', () => {
      // Values with plain objects should pass through
      const release = cnpgHelmRelease({
        name: 'cnpg',
        values: {
          replicaCount: 2,
          monitoring: { podMonitorEnabled: true },
        },
      });

      expect(release.spec.values?.replicaCount).toBe(2);
      expect(release.spec.values?.crds?.create).toBe(true);
    });

    it('should have a readiness evaluator', () => {
      const release = cnpgHelmRelease({ name: 'cnpg' });
      expect(release.readinessEvaluator).toBeDefined();
    });

    it('should allow overriding version and namespace', () => {
      const release = cnpgHelmRelease({
        name: 'cnpg-custom',
        namespace: 'custom-ns',
        version: '0.24.0',
      });

      expect(release.metadata.namespace).toBe('custom-ns');
    });
  });
});

describe('CNPG Helm Values Mapper', () => {
  describe('mapCnpgConfigToHelmValues', () => {
    it('should return empty object for minimal config', () => {
      const values = mapCnpgConfigToHelmValues({ name: 'cnpg' });
      expect(values.crds).toEqual({ create: true });
    });

    it('should map replicaCount', () => {
      const values = mapCnpgConfigToHelmValues({
        name: 'cnpg',
        replicaCount: 3,
      });
      expect(values.replicaCount).toBe(3);
    });

    it('should map resources', () => {
      const values = mapCnpgConfigToHelmValues({
        name: 'cnpg',
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
          limits: { cpu: '500m', memory: '512Mi' },
        },
      });
      expect(values.resources?.requests?.cpu).toBe('100m');
      expect(values.resources?.limits?.memory).toBe('512Mi');
    });

    it('should map monitoring', () => {
      const values = mapCnpgConfigToHelmValues({
        name: 'cnpg',
        monitoring: { enabled: true },
      });
      expect(values.monitoring?.podMonitorEnabled).toBe(true);
    });

    it('should set installCRDs to false when specified', () => {
      const values = mapCnpgConfigToHelmValues({
        name: 'cnpg',
        installCRDs: false,
      });
      expect(values.crds?.create).toBe(false);
    });

    it('should spread custom values last', () => {
      const values = mapCnpgConfigToHelmValues({
        name: 'cnpg',
        customValues: {
          nodeSelector: { 'kubernetes.io/os': 'linux' },
        },
      });
      expect(values.nodeSelector).toEqual({ 'kubernetes.io/os': 'linux' });
    });

    it('should remove undefined values', () => {
      // Test that the mapper doesn't include fields that weren't set
      const values = mapCnpgConfigToHelmValues({ name: 'cnpg' });
      expect('replicaCount' in values).toBe(false);
      expect('resources' in values).toBe(false);
    });
  });

  describe('getCnpgHelmValueWarnings', () => {
    it('should warn when installCRDs is false', () => {
      const warnings = getCnpgHelmValueWarnings({
        name: 'cnpg',
        installCRDs: false,
      });
      expect(warnings.some((w) => w.includes('installCRDs'))).toBe(true);
    });

    it('should warn when no resource requests', () => {
      const warnings = getCnpgHelmValueWarnings({ name: 'cnpg' });
      expect(warnings.some((w) => w.includes('resource requests'))).toBe(true);
    });

    it('should warn when replicaCount is 1', () => {
      const warnings = getCnpgHelmValueWarnings({
        name: 'cnpg',
        replicaCount: 1,
      });
      expect(warnings.some((w) => w.includes('replicaCount'))).toBe(true);
    });

    it('should return no warnings for well-configured deployment', () => {
      const warnings = getCnpgHelmValueWarnings({
        name: 'cnpg',
        replicaCount: 2,
        installCRDs: true,
        resources: {
          requests: { cpu: '100m', memory: '128Mi' },
        },
      });
      expect(warnings).toEqual([]);
    });
  });
});
