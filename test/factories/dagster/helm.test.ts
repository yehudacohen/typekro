import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DAGSTER_REPO_NAME,
  DEFAULT_DAGSTER_REPO_URL,
  DEFAULT_DAGSTER_VERSION,
  dagsterHelmRelease,
  dagsterHelmRepository,
} from '../../../src/factories/dagster/resources/helm.js';
import {
  CEL_EXPRESSION_BRAND,
  KUBERNETES_REF_BRAND,
} from '../../../src/core/constants/brands.js';
import type { CelExpression, KubernetesRef } from '../../../src/core/types/common.js';

describe('Dagster Helm wrappers', () => {
  describe('dagsterHelmRepository', () => {
    it('Create Dagster HelmRepository resources with official chart defaults', () => {
      const repository = dagsterHelmRepository({ id: 'dagsterHelmRepository' });

      expect(repository.id).toBe('dagsterHelmRepository');
      expect(repository.kind).toBe('HelmRepository');
      expect(repository.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
      expect(repository.metadata.name).toBe(DEFAULT_DAGSTER_REPO_NAME);
      expect(repository.metadata.namespace).toBe('flux-system');
      expect(repository.spec.url).toBe(DEFAULT_DAGSTER_REPO_URL);
      expect(repository.spec.url).toBe('https://dagster-io.github.io/helm');
      expect(repository.spec.interval).toBe('5m');
      expect(repository.readinessEvaluator).toBeDefined();
    });

    it('Create Dagster HelmRepository resources with explicit repository overrides', () => {
      const repository = dagsterHelmRepository({
        id: 'customDagsterRepository',
        name: 'dagster-custom',
        namespace: 'platform-flux',
        url: 'https://example.invalid/dagster/charts',
        interval: '15m',
      });

      expect(repository.id).toBe('customDagsterRepository');
      expect(repository.metadata.name).toBe('dagster-custom');
      expect(repository.metadata.namespace).toBe('platform-flux');
      expect(repository.spec.url).toBe('https://example.invalid/dagster/charts');
      expect(repository.spec.interval).toBe('15m');
    });
  });

  describe('dagsterHelmRelease', () => {
    it('Create Dagster HelmRelease resources with official chart defaults', () => {
      const release = dagsterHelmRelease({
        id: 'dagsterHelmRelease',
        name: 'dagster',
      });

      expect(release.id).toBe('dagsterHelmRelease');
      expect(release.kind).toBe('HelmRelease');
      expect(release.apiVersion).toBe('helm.toolkit.fluxcd.io/v2');
      expect(release.metadata.name).toBe('dagster');
      expect(release.metadata.namespace).toBe('dagster');
      expect(release.spec.chart.spec.chart).toBe('dagster');
      expect(release.spec.chart.spec.version).toBe(DEFAULT_DAGSTER_VERSION);
      expect(release.spec.chart.spec.version).toBe('1.13.8');
      expect(release.spec.chart.spec.sourceRef.name).toBe(DEFAULT_DAGSTER_REPO_NAME);
      expect(release.spec.chart.spec.sourceRef.namespace).toBe('flux-system');
      expect(release.readinessEvaluator).toBeDefined();
    });

    it('Create Dagster HelmRelease resources with explicit release overrides', () => {
      const release = dagsterHelmRelease({
        id: 'dagsterProdHelmRelease',
        name: 'dagster-prod',
        namespace: 'data-platform',
        repositoryName: 'dagster-prod-source',
        repositoryNamespace: 'platform-flux',
        version: '1.13.7',
        values: {
          dagsterWebserver: { replicaCount: 2 },
        },
      });

      expect(release.id).toBe('dagsterProdHelmRelease');
      expect(release.metadata.name).toBe('dagster-prod');
      expect(release.metadata.namespace).toBe('data-platform');
      expect(release.spec.chart.spec.chart).toBe('dagster');
      expect(release.spec.chart.spec.version).toBe('1.13.7');
      expect(release.spec.chart.spec.sourceRef.name).toBe('dagster-prod-source');
      expect(release.spec.chart.spec.sourceRef.namespace).toBe('platform-flux');
      expect(release.spec.values?.dagsterWebserver).toEqual({ replicaCount: 2 });
    });

    it('Preserve TypeKro magic-proxy refs and CEL values inside nested Helm values', () => {
      const userImageRef = {
        [KUBERNETES_REF_BRAND]: true,
        resourceId: 'imageConfig',
        fieldPath: 'status.repository',
      } satisfies KubernetesRef<string>;
      const tagExpression = {
        [CEL_EXPRESSION_BRAND]: true,
        expression: 'schema.spec.version',
      } satisfies CelExpression<string>;

      const release = dagsterHelmRelease({
        id: 'dagsterGraphAwareValues',
        name: 'dagster',
        values: {
          'dagster-user-deployments': {
            deployments: [
              {
                name: 'repo',
                image: {
                  repository: userImageRef,
                  tag: tagExpression,
                },
              },
            ],
          },
        },
      });

      const userDeployments = release.spec.values?.['dagster-user-deployments'] as
        | {
            deployments?: Array<{
              image?: { repository?: unknown; tag?: unknown };
            }>;
          }
        | undefined;
      expect(userDeployments).toBeDefined();
      expect(userDeployments?.deployments?.[0]?.image?.repository).toBe(userImageRef);
      expect(userDeployments?.deployments?.[0]?.image?.tag).toBe(tagExpression);
    });
  });
});
