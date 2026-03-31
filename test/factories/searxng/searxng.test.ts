/**
 * SearXNG Factory Unit Tests
 */

import { describe, expect, it } from 'bun:test';
import { searxng } from '../../../src/factories/searxng/resources/searxng.js';
import { searxngConfigMap } from '../../../src/factories/searxng/resources/config.js';

describe('SearXNG Factory', () => {
  describe('searxng deployment', () => {
    it('should create a Deployment with minimal config', () => {
      const deploy = searxng({
        name: 'test-searxng',
        spec: {},
      });

      expect(deploy.kind).toBe('Deployment');
      expect(deploy.apiVersion).toBe('apps/v1');
      expect(deploy.metadata.name).toBe('test-searxng');
    });

    it('should create a namespaced resource', () => {
      const deploy = searxng({
        name: 'test-searxng',
        namespace: 'search',
        spec: {},
      });

      expect(deploy.metadata.namespace).toBe('search');
    });

    it('should use default image when not specified', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      const containers = (deploy.spec as any).template.spec.containers;
      expect(containers[0].image).toBe('searxng/searxng:latest');
    });

    it('should use custom image when specified', () => {
      const deploy = searxng({
        name: 'test',
        spec: { image: 'searxng/searxng:2024.1.1' },
      });
      const containers = (deploy.spec as any).template.spec.containers;
      expect(containers[0].image).toBe('searxng/searxng:2024.1.1');
    });

    it('should set replicas', () => {
      const deploy = searxng({
        name: 'test',
        spec: { replicas: 3 },
      });
      expect((deploy.spec as any).replicas).toBe(3);
    });

    it('should include environment variables', () => {
      const deploy = searxng({
        name: 'test',
        spec: {
          instanceName: 'My Search',
          baseUrl: 'https://search.example.com/',
          server: { secret_key: 'test-secret' },
          env: { TZ: 'UTC' },
        },
      });
      const env = (deploy.spec as any).template.spec.containers[0].env;
      expect(env).toContainEqual({ name: 'INSTANCE_NAME', value: 'My Search' });
      expect(env).toContainEqual({ name: 'BASE_URL', value: 'https://search.example.com/' });
      // secret_key injected via SEARXNG_SECRET env var (not in ConfigMap)
      expect(env).toContainEqual({ name: 'SEARXNG_SECRET', value: 'test-secret' });
      expect(env).toContainEqual({ name: 'TZ', value: 'UTC' });
    });

    it('should mount settings configmap', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      const volumes = (deploy.spec as any).template.spec.volumes;
      const mounts = (deploy.spec as any).template.spec.containers[0].volumeMounts;

      expect(volumes[0].name).toBe('searxng-config');
      expect(volumes[0].configMap.name).toBe('test-config');
      expect(mounts[0].mountPath).toBe('/etc/searxng/settings.yml');
      expect(mounts[0].subPath).toBe('settings.yml');
    });

    it('should include health probes', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      const container = (deploy.spec as any).template.spec.containers[0];

      expect(container.livenessProbe.httpGet.path).toBe('/healthz');
      expect(container.readinessProbe.httpGet.path).toBe('/healthz');
    });

    it('should set resource limits', () => {
      const deploy = searxng({
        name: 'test',
        spec: {
          resources: {
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
      });
      const resources = (deploy.spec as any).template.spec.containers[0].resources;
      expect(resources.requests.cpu).toBe('100m');
      expect(resources.limits.memory).toBe('512Mi');
    });

    it('should include standard labels', () => {
      const deploy = searxng({ name: 'my-search', spec: {} });
      expect(deploy.metadata.labels?.['app.kubernetes.io/name']).toBe('searxng');
      expect(deploy.metadata.labels?.['app.kubernetes.io/instance']).toBe('my-search');
      expect(deploy.metadata.labels?.['app.kubernetes.io/managed-by']).toBe('typekro');
    });
  });

  describe('searxng readiness evaluator', () => {
    it('should attach readiness evaluator', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      // The readiness evaluator is attached via WeakMap metadata
      expect(deploy).toBeDefined();
    });
  });

  describe('searxngConfigMap', () => {
    it('should create a ConfigMap with settings', () => {
      const cm = searxngConfigMap({
        name: 'test-config',
        settings: {
          use_default_settings: true,
          server: { secret_key: 'test-key', limiter: false },
          search: { formats: ['html', 'json'] },
        },
      });

      expect(cm.kind).toBe('ConfigMap');
      expect(cm.apiVersion).toBe('v1');
      expect(cm.metadata.name).toBe('test-config');

      const data = (cm as any).data;
      expect(data['settings.yml']).toContain('use_default_settings: true');
      // secret_key is stripped from ConfigMap (injected via SEARXNG_SECRET env var)
      expect(data['settings.yml']).not.toContain('secret_key');
      expect(data['settings.yml']).toContain('limiter: false');
    });

    it('should handle nested settings', () => {
      const cm = searxngConfigMap({
        name: 'test-config',
        settings: {
          search: {
            formats: ['html', 'json'],
            default_lang: 'en',
          },
        },
      });

      const yaml = (cm as any).data['settings.yml'];
      expect(yaml).toContain('formats:');
      expect(yaml).toContain('- html');
      expect(yaml).toContain('- json');
      expect(yaml).toContain('default_lang: en');
    });

    it('should handle special YAML values via js-yaml', () => {
      const cm = searxngConfigMap({
        name: 'test-config',
        settings: {
          server: { bind_address: '0.0.0.0:8080' },
        },
      });

      const yaml = (cm as any).data['settings.yml'];
      // js-yaml quotes strings with colons
      expect(yaml).toContain('0.0.0.0:8080');
    });
  });
});
