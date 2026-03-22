import { describe, expect, it } from 'bun:test';
import {
  inngestHelmRepository,
  inngestHelmRelease,
  DEFAULT_INNGEST_REPO_URL,
  DEFAULT_INNGEST_REPO_NAME,
  DEFAULT_INNGEST_VERSION,
} from '../../../src/factories/inngest/resources/helm.js';
import { mapInngestConfigToHelmValues } from '../../../src/factories/inngest/utils/helm-values-mapper.js';

describe('Inngest Helm Resources', () => {
  describe('inngestHelmRepository', () => {
    it('should create HelmRepository with OCI registry defaults', () => {
      const repo = inngestHelmRepository({ id: 'inngestRepo' });

      expect(repo.kind).toBe('HelmRepository');
      expect(repo.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(repo.metadata.name).toBe(DEFAULT_INNGEST_REPO_NAME);
      expect(repo.metadata.namespace).toBe('flux-system');
      expect(repo.spec.url).toBe(DEFAULT_INNGEST_REPO_URL);
      expect(repo.spec.interval).toBe('5m');
    });

    it('should allow overriding defaults', () => {
      const repo = inngestHelmRepository({
        name: 'custom-repo',
        namespace: 'custom-ns',
        url: 'oci://custom.registry.io/inngest',
      });

      expect(repo.metadata.name).toBe('custom-repo');
      expect(repo.metadata.namespace).toBe('custom-ns');
    });

    it('should have a readiness evaluator', () => {
      const repo = inngestHelmRepository({});
      expect(repo.readinessEvaluator).toBeDefined();
    });
  });

  describe('inngestHelmRelease', () => {
    it('should create HelmRelease with Inngest defaults', () => {
      const release = inngestHelmRelease({
        name: 'inngest',
        id: 'inngestRelease',
      });

      expect(release.kind).toBe('HelmRelease');
      expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
      expect(release.metadata.name).toBe('inngest');
      expect(release.metadata.namespace).toBe('inngest');
    });

    it('should pass through sanitized values', () => {
      const release = inngestHelmRelease({
        name: 'inngest',
        values: {
          inngest: { eventKey: 'abc', signingKey: 'def' },
          replicaCount: 2,
        },
      });

      expect(release.spec.values?.replicaCount).toBe(2);
      expect((release.spec.values?.inngest as any)?.eventKey).toBe('abc');
    });

    it('should have a readiness evaluator', () => {
      const release = inngestHelmRelease({ name: 'inngest' });
      expect(release.readinessEvaluator).toBeDefined();
    });

    it('should allow overriding version and namespace', () => {
      const release = inngestHelmRelease({
        name: 'inngest',
        namespace: 'custom-ns',
        version: '0.4.0',
      });

      expect(release.metadata.namespace).toBe('custom-ns');
      // Version is embedded in the chart spec
      expect(release.spec.chart?.spec?.version).toBe('0.4.0');
    });
  });

  describe('sanitizeHelmValues (tested indirectly via inngestHelmRelease)', () => {
    it('should pass through plain values intact', () => {
      const release = inngestHelmRelease({
        name: 'inngest',
        values: {
          stringVal: 'hello',
          numberVal: 42,
          boolVal: true,
          nested: { deep: 'value' },
          array: [1, 2, 3],
        },
      });

      expect(release.spec.values?.stringVal).toBe('hello');
      expect(release.spec.values?.numberVal).toBe(42);
      expect(release.spec.values?.boolVal).toBe(true);
      expect((release.spec.values?.nested as any)?.deep).toBe('value');
      expect(release.spec.values?.array).toEqual([1, 2, 3]);
    });

    it('should strip KubernetesRef-branded objects from values', () => {
      // Construct a mock object matching the KubernetesRef brand check.
      // isKubernetesRef uses Reflect.get(obj, KUBERNETES_REF_BRAND) === true
      const KUBERNETES_REF_BRAND = Symbol.for('TypeKro.KubernetesRef');
      const mockRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'someResource',
        fieldPath: 'status.ready',
      };

      const release = inngestHelmRelease({
        name: 'inngest',
        values: {
          safe: 'keep-me',
          dangerous: mockRef as any,
          nested: { alsoSafe: true, ref: mockRef as any },
        },
      });

      expect(release.spec.values?.safe).toBe('keep-me');
      // The branded ref should be stripped (undefined → omitted from JSON)
      expect(release.spec.values?.dangerous).toBeUndefined();
      expect((release.spec.values?.nested as any)?.alsoSafe).toBe(true);
      expect((release.spec.values?.nested as any)?.ref).toBeUndefined();
    });

    it('should strip CelExpression-branded objects from values', () => {
      const CEL_EXPRESSION_BRAND = Symbol.for('TypeKro.CelExpression');
      const mockCel = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'resource.status.ready',
      };

      const release = inngestHelmRelease({
        name: 'inngest',
        values: {
          keep: 'this',
          celValue: mockCel as any,
        },
      });

      expect(release.spec.values?.keep).toBe('this');
      expect(release.spec.values?.celValue).toBeUndefined();
    });

    it('should handle mixed plain and branded values', () => {
      const KUBERNETES_REF_BRAND = Symbol.for('TypeKro.KubernetesRef');
      const CEL_EXPRESSION_BRAND = Symbol.for('TypeKro.CelExpression');

      const release = inngestHelmRelease({
        name: 'inngest',
        values: {
          replicaCount: 3,
          ref: { [KUBERNETES_REF_BRAND]: true, resourceId: 'x', fieldPath: 'status.ready' } as any,
          cel: { [CEL_EXPRESSION_BRAND]: true, expression: 'y' } as any,
          inngest: { eventKey: 'abc', signingKey: 'def' },
        },
      });

      expect(release.spec.values?.replicaCount).toBe(3);
      expect(release.spec.values?.ref).toBeUndefined();
      expect(release.spec.values?.cel).toBeUndefined();
      expect((release.spec.values?.inngest as any)?.eventKey).toBe('abc');
    });

    it('should return empty values when no values provided', () => {
      const release = inngestHelmRelease({ name: 'inngest' });
      expect(release.spec.values).toBeDefined();
    });
  });
});

describe('Inngest Helm Values Mapper', () => {
  const minimalConfig = {
    name: 'inngest',
    inngest: { eventKey: 'abc', signingKey: 'def' },
  };

  describe('mapInngestConfigToHelmValues', () => {
    it('should map required inngest fields', () => {
      const values = mapInngestConfigToHelmValues(minimalConfig);

      expect(values.inngest?.eventKey).toBe('abc');
      expect(values.inngest?.signingKey).toBe('def');
    });

    it('should map external database URIs', () => {
      const values = mapInngestConfigToHelmValues({
        ...minimalConfig,
        inngest: {
          ...minimalConfig.inngest,
          postgres: { uri: 'postgresql://host:5432/db' },
          redis: { uri: 'redis://host:6379' },
        },
      });

      expect(values.inngest?.postgres?.uri).toBe('postgresql://host:5432/db');
      expect(values.inngest?.redis?.uri).toBe('redis://host:6379');
    });

    it('should disable bundled databases', () => {
      const values = mapInngestConfigToHelmValues({
        ...minimalConfig,
        postgresql: { enabled: false },
        redis: { enabled: false },
      });

      expect(values.postgresql?.enabled).toBe(false);
      expect(values.redis?.enabled).toBe(false);
    });

    it('should map replicas and resources', () => {
      const values = mapInngestConfigToHelmValues({
        ...minimalConfig,
        replicaCount: 3,
        resources: {
          requests: { cpu: '500m', memory: '1Gi' },
          limits: { cpu: '2', memory: '4Gi' },
        },
      });

      expect(values.replicaCount).toBe(3);
      expect(values.resources?.requests?.cpu).toBe('500m');
    });

    it('should map ingress and keda config', () => {
      const values = mapInngestConfigToHelmValues({
        ...minimalConfig,
        ingress: {
          enabled: true,
          className: 'nginx',
          hosts: [{ host: 'inngest.example.com' }],
        },
        keda: { enabled: true, maxReplicas: 20 },
      });

      expect(values.ingress?.enabled).toBe(true);
      expect(values.keda?.maxReplicas).toBe(20);
    });

    it('should not include bootstrap-only fields', () => {
      const values = mapInngestConfigToHelmValues({
        ...minimalConfig,
        namespace: 'inngest',
        version: 'v0.3.1',
      });

      // namespace and version are bootstrap fields, not chart values
      expect('namespace' in values).toBe(false);
      expect('version' in values).toBe(false);
      expect('name' in values).toBe(false);
    });

    it('should spread custom values last', () => {
      const values = mapInngestConfigToHelmValues({
        ...minimalConfig,
        customValues: { extra: 'value' },
      });

      expect(values.extra).toBe('value');
    });
  });
});
