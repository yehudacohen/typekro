/**
 * SearXNG Factory Unit Tests
 */

import { describe, expect, it } from 'bun:test';
import { searxngBootstrap } from '../../../src/factories/searxng/compositions/searxng-bootstrap.js';
import { searxng } from '../../../src/factories/searxng/resources/searxng.js';

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
      expect(containers[0].image).toBe('searxng/searxng:2026.3.29-7ac4ff39f');
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

    it('should inject secret_key via SEARXNG_SECRET env var', () => {
      const deploy = searxng({
        name: 'test',
        spec: {
          server: { secret_key: 'my-secret' },
        },
      });
      const env = (deploy.spec as any).template.spec.containers[0].env;
      expect(env).toContainEqual({ name: 'SEARXNG_SECRET', value: 'my-secret' });
    });

    it('should include environment variables from spec', () => {
      const deploy = searxng({
        name: 'test',
        spec: {
          instanceName: 'My Search',
          baseUrl: 'https://search.example.com/',
          env: { TZ: 'UTC' },
        },
      });
      const env = (deploy.spec as any).template.spec.containers[0].env;
      expect(env).toContainEqual({ name: 'INSTANCE_NAME', value: 'My Search' });
      expect(env).toContainEqual({ name: 'BASE_URL', value: 'https://search.example.com/' });
      expect(env).toContainEqual({ name: 'TZ', value: 'UTC' });
    });

    it('should use default configMapName when not specified', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      const volumes = (deploy.spec as any).template.spec.volumes;
      expect(volumes[0].configMap.name).toBe('test-config');
    });

    it('should use custom configMapName when specified', () => {
      const deploy = searxng({ name: 'test', spec: { configMapName: 'custom-settings' } });
      const volumes = (deploy.spec as any).template.spec.volumes;
      expect(volumes[0].configMap.name).toBe('custom-settings');
    });

    it('should mount settings at /etc/searxng/settings.yml', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      const mounts = (deploy.spec as any).template.spec.containers[0].volumeMounts;
      expect(mounts[0].mountPath).toBe('/etc/searxng/settings.yml');
      expect(mounts[0].subPath).toBe('settings.yml');
      expect(mounts[0].readOnly).toBe(true);
    });

    it('should include startup, liveness, and readiness probes', () => {
      const deploy = searxng({ name: 'test', spec: {} });
      const container = (deploy.spec as any).template.spec.containers[0];
      expect(container.startupProbe.httpGet.path).toBe('/healthz');
      expect(container.livenessProbe.httpGet.path).toBe('/healthz');
      expect(container.readinessProbe.httpGet.path).toBe('/healthz');
      expect(container.startupProbe.failureThreshold).toBe(6);
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

  describe('bootstrap settings', () => {
    it('emits documented concrete settings fields in direct YAML', () => {
      const yaml = searxngBootstrap.toYaml({
        name: 'search',
        server: {
          limiter: true,
          bind_address: '0.0.0.0:8080',
          method: 'POST',
        },
        search: {
          formats: ['html', 'json', 'rss'],
          default_lang: 'en',
          autocomplete: 'duckduckgo',
          safe_search: 2,
        },
      });

      expect(yaml).toContain('bind_address: 0.0.0.0:8080');
      expect(yaml).toContain('method: POST');
      expect(yaml).toContain('default_lang: en');
      expect(yaml).toContain('autocomplete: duckduckgo');
      expect(yaml).toContain('safe_search: 2');
      expect(yaml).toContain('- rss');
    });
  });
});
