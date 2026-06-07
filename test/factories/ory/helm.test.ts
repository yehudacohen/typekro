import { describe, expect, it } from 'bun:test';
import {
  hydraHelmRelease,
  ketoHelmRelease,
  kratosHelmRelease,
  oathkeeperHelmRelease,
  oryHelmRepository,
} from '../../../src/factories/ory/resources/helm.js';

describe('Ory Helm wrappers', () => {
  describe('oryHelmRepository', () => {
    it('Install the official Ory Helm repository through a Flux HelmRepository resource', () => {
      const repository = oryHelmRepository({ id: 'oryHelmRepository' });

      expect(repository.id).toBe('oryHelmRepository');
      expect(repository.kind).toBe('HelmRepository');
      expect(repository.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(repository.metadata.name).toBe('ory');
      expect(repository.metadata.namespace).toBe('flux-system');
      expect(repository.spec.url).toBe('https://k8s.ory.sh/helm/charts');
      expect(repository.spec.interval).toBe('5m');
      expect(repository.readinessEvaluator).toBeDefined();
    });

    it('Install the official Ory Helm repository with explicit repository overrides', () => {
      const repository = oryHelmRepository({
        id: 'customOryRepository',
        name: 'ory-custom',
        namespace: 'platform-flux',
        url: 'https://example.invalid/ory/charts',
        interval: '15m',
      });

      expect(repository.id).toBe('customOryRepository');
      expect(repository.metadata.name).toBe('ory-custom');
      expect(repository.metadata.namespace).toBe('platform-flux');
      expect(repository.spec.url).toBe('https://example.invalid/ory/charts');
      expect(repository.spec.interval).toBe('15m');
    });
  });

  describe('hydraHelmRelease', () => {
    it('Install the official Ory hydra Helm chart through a Flux HelmRelease resource', () => {
      const release = hydraHelmRelease({
        id: 'hydraHelmRelease',
        name: 'hydra',
        namespace: 'ory-system',
        values: {
          replicaCount: 2,
          hydra: { dev: false },
          maester: { enabled: true },
        },
      });

      expect(release.id).toBe('hydraHelmRelease');
      expect(release.kind).toBe('HelmRelease');
      expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
      expect(release.metadata.name).toBe('hydra');
      expect(release.metadata.namespace).toBe('ory-system');
      expect(release.spec.chart.spec.chart).toBe('hydra');
      expect(release.spec.chart.spec.version).toBe('0.62.0');
      expect(release.spec.chart.spec.sourceRef.name).toBe('ory');
      expect(release.spec.values).toMatchObject({
        replicaCount: 2,
        hydra: { dev: false },
        maester: { enabled: true },
      });
      expect(release.readinessEvaluator).toBeDefined();
    });
  });

  describe('kratosHelmRelease', () => {
    it('Install the official Ory kratos Helm chart through a Flux HelmRelease resource', () => {
      const release = kratosHelmRelease({
        id: 'kratosHelmRelease',
        name: 'kratos',
        namespace: 'ory-system',
        repositoryName: 'ory-prod',
        repositoryNamespace: 'flux-system',
        values: {
          replicaCount: 2,
          kratos: { development: false },
        },
      });

      expect(release.id).toBe('kratosHelmRelease');
      expect(release.kind).toBe('HelmRelease');
      expect(release.spec.chart.spec.chart).toBe('kratos');
      expect(release.spec.chart.spec.version).toBe('0.62.0');
      expect(release.spec.chart.spec.sourceRef.name).toBe('ory-prod');
      expect(release.spec.chart.spec.sourceRef.namespace).toBe('flux-system');
      expect(release.spec.values).toMatchObject({
        replicaCount: 2,
        kratos: { development: false },
      });
      expect(release.readinessEvaluator).toBeDefined();
    });
  });

  describe('ketoHelmRelease', () => {
    it('Install the official Ory keto Helm chart through a Flux HelmRelease resource', () => {
      const release = ketoHelmRelease({
        id: 'ketoHelmRelease',
        name: 'keto',
        namespace: 'ory-system',
        values: {
          replicaCount: 2,
          keto: {
            config: {
              namespaces: [{ id: 1, name: 'documents' }],
            },
          },
        },
      });

      expect(release.id).toBe('ketoHelmRelease');
      expect(release.kind).toBe('HelmRelease');
      expect(release.spec.chart.spec.chart).toBe('keto');
      expect(release.spec.chart.spec.version).toBe('0.62.0');
      expect(release.spec.values).toMatchObject({
        replicaCount: 2,
        keto: { config: { namespaces: [{ id: 1, name: 'documents' }] } },
      });
      expect(release.readinessEvaluator).toBeDefined();
    });
  });

  describe('oathkeeperHelmRelease', () => {
    it('Install the official Ory oathkeeper Helm chart through a Flux HelmRelease resource', () => {
      const release = oathkeeperHelmRelease({
        id: 'oathkeeperHelmRelease',
        name: 'oathkeeper',
        namespace: 'ory-system',
        version: '0.62.0',
        values: {
          replicaCount: 2,
          oathkeeper: { managedAccessRules: true },
          maester: { enabled: true },
        },
      });

      expect(release.id).toBe('oathkeeperHelmRelease');
      expect(release.kind).toBe('HelmRelease');
      expect(release.spec.chart.spec.chart).toBe('oathkeeper');
      expect(release.spec.chart.spec.version).toBe('0.62.0');
      expect(release.spec.values).toMatchObject({
        replicaCount: 2,
        oathkeeper: { managedAccessRules: true },
        maester: { enabled: true },
      });
      expect(release.readinessEvaluator).toBeDefined();
    });
  });
});
