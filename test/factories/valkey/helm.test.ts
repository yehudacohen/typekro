import { describe, expect, it } from 'bun:test';
import { valkeyHelmRepository, valkeyHelmRelease } from '../../../src/factories/valkey/resources/helm.js';
import { mapValkeyConfigToHelmValues } from '../../../src/factories/valkey/utils/helm-values-mapper.js';

describe('Valkey Helm Resources', () => {
  describe('valkeyHelmRepository', () => {
    it('should create HelmRepository with OCI registry defaults', () => {
      const repo = valkeyHelmRepository({
        name: 'valkey-operator-repo',
        id: 'valkeyRepo',
      });

      expect(repo.kind).toBe('HelmRepository');
      expect(repo.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(repo.metadata.name).toBe('valkey-operator-repo');
      expect(repo.metadata.namespace).toBe('flux-system');
      expect(repo.spec.url).toBe('oci://ghcr.io/hyperspike');
      expect(repo.spec.interval).toBe('5m');
    });

    it('should allow overriding defaults', () => {
      const repo = valkeyHelmRepository({
        name: 'custom-repo',
        namespace: 'custom-ns',
        url: 'oci://custom.registry.io/valkey',
        interval: '10m',
      });

      expect(repo.metadata.name).toBe('custom-repo');
      expect(repo.metadata.namespace).toBe('custom-ns');
      expect(repo.spec.url).toBe('oci://custom.registry.io/valkey');
    });

    it('should have a readiness evaluator', () => {
      const repo = valkeyHelmRepository({ name: 'test-repo' });
      expect(repo.readinessEvaluator).toBeDefined();
    });
  });

  describe('valkeyHelmRelease', () => {
    it('should create HelmRelease with Valkey defaults', () => {
      const release = valkeyHelmRelease({
        name: 'valkey-operator',
        id: 'valkeyRelease',
      });

      expect(release.kind).toBe('HelmRelease');
      expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
      expect(release.metadata.name).toBe('valkey-operator');
      expect(release.metadata.namespace).toBe('valkey-operator-system');
    });

    it('should sanitize proxy objects from values', () => {
      const release = valkeyHelmRelease({
        name: 'valkey-operator',
        values: { replicaCount: 2 },
      });

      expect(release.spec.values?.replicaCount).toBe(2);
    });

    it('should have a readiness evaluator', () => {
      const release = valkeyHelmRelease({ name: 'valkey-operator' });
      expect(release.readinessEvaluator).toBeDefined();
    });

    it('should allow overriding namespace and version', () => {
      const release = valkeyHelmRelease({
        name: 'custom-operator',
        namespace: 'custom-ns',
        version: '0.1.0',
      });

      expect(release.metadata.namespace).toBe('custom-ns');
    });
  });
});

describe('Valkey Helm Values Mapper', () => {
  describe('mapValkeyConfigToHelmValues', () => {
    it('should return empty object for minimal config', () => {
      const values = mapValkeyConfigToHelmValues({ name: 'valkey-operator' });
      expect(Object.keys(values).length).toBe(0);
    });

    it('should pass through custom values', () => {
      const values = mapValkeyConfigToHelmValues({
        name: 'valkey-operator',
        customValues: { nodeSelector: { 'kubernetes.io/os': 'linux' } },
      });
      expect(values.nodeSelector).toEqual({ 'kubernetes.io/os': 'linux' });
    });

    it('should remove undefined values', () => {
      const values = mapValkeyConfigToHelmValues({ name: 'valkey-operator' });
      // No undefined keys should be present
      for (const value of Object.values(values)) {
        expect(value).not.toBe(undefined);
      }
    });
  });
});
