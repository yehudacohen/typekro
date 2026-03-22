import { describe, expect, it } from 'bun:test';
import { valkey } from '../../../src/factories/valkey/resources/valkey.js';

describe('Valkey Factory', () => {
  describe('resource creation', () => {
    it('should create a Valkey resource with minimal config', () => {
      const cache = valkey({
        name: 'test-cache',
        spec: {},
      });

      expect(cache).toBeDefined();
      expect(cache.kind).toBe('Valkey');
      expect(cache.apiVersion).toBe('hyperspike.io/v1');
      expect(cache.metadata.name).toBe('test-cache');
    });

    it('should create a namespaced resource', () => {
      const cache = valkey({
        name: 'test-cache',
        namespace: 'caching',
        spec: { shards: 3 },
      });

      expect(cache.metadata.namespace).toBe('caching');
    });

    it('should accept an id for composition references', () => {
      const cache = valkey({
        name: 'test-cache',
        spec: {},
        id: 'appCache',
      });

      expect(cache).toBeDefined();
    });

    it('should accept comprehensive configuration', () => {
      const cache = valkey({
        name: 'prod-cache',
        namespace: 'production',
        spec: {
          image: 'valkey:8.0',
          shards: 3,
          replicas: 1,
          tls: true,
          certIssuer: 'letsencrypt-prod',
          certIssuerType: 'ClusterIssuer',
          storage: {
            storageClassName: 'gp3',
            resources: { requests: { storage: '50Gi' } },
          },
          resources: {
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '2', memory: '4Gi' },
          },
          prometheus: true,
          serviceMonitor: true,
          nodeSelector: { 'node-type': 'cache' },
          externalAccess: {
            enabled: true,
            type: 'Proxy',
            proxy: {
              replicas: 2,
              hostname: 'valkey.example.com',
            },
          },
        },
        id: 'prodCache',
      });

      expect(cache.kind).toBe('Valkey');
      expect(cache.spec.shards).toBe(3);
      expect(cache.spec.replicas).toBe(1);
      expect(cache.spec.tls).toBe(true);
      expect(cache.spec.storage?.storageClassName).toBe('gp3');
      expect(cache.spec.prometheus).toBe(true);
      expect(cache.spec.externalAccess?.type).toBe('Proxy');
      expect(cache.spec.externalAccess?.proxy?.replicas).toBe(2);
    });

    it('should accept authentication configuration', () => {
      const cache = valkey({
        name: 'auth-cache',
        spec: {
          anonymousAuth: false,
          servicePassword: { name: 'valkey-secret', key: 'password' },
        },
      });

      expect(cache.spec.anonymousAuth).toBe(false);
      expect(cache.spec.servicePassword?.name).toBe('valkey-secret');
    });
  });

  describe('readiness evaluation', () => {
    it('should have a readiness evaluator', () => {
      const cache = valkey({ name: 'test', spec: {} });
      expect(cache.readinessEvaluator).toBeDefined();
    });

    it('should report ready when status.ready is true', () => {
      const cache = valkey({ name: 'ready-test', spec: {} });

      const status = cache.readinessEvaluator?.({
        status: {
          ready: true,
          conditions: [
            { type: 'Ready', status: 'True', reason: 'ClusterReady', message: 'All shards ready' },
          ],
        },
      });

      expect(status?.ready).toBe(true);
      expect(status?.reason).toBe('Ready');
    });

    it('should report not ready when status.ready is false with condition', () => {
      const cache = valkey({ name: 'not-ready-test', spec: {} });

      const status = cache.readinessEvaluator?.({
        status: {
          ready: false,
          conditions: [
            {
              type: 'Ready',
              status: 'False',
              reason: 'ShardsNotReady',
              message: 'Waiting for shards to join cluster',
            },
          ],
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('ShardsNotReady');
      expect(status?.message).toContain('shards');
    });

    it('should report not ready when status.ready is false without condition', () => {
      const cache = valkey({ name: 'no-condition-test', spec: {} });

      const status = cache.readinessEvaluator?.({
        status: { ready: false },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('NotReady');
    });

    it('should fall back to condition-based when ready field is absent', () => {
      const cache = valkey({ name: 'fallback-test', spec: {} });

      const status = cache.readinessEvaluator?.({
        status: {
          conditions: [
            { type: 'Ready', status: 'True', reason: 'OK', message: 'Ready' },
          ],
        },
      });

      expect(status?.ready).toBe(true);
    });

    it('should handle missing status gracefully', () => {
      const cache = valkey({ name: 'no-status-test', spec: {} });

      expect(cache.readinessEvaluator?.(null)?.ready).toBe(false);
      expect(cache.readinessEvaluator?.(null)?.reason).toBe('StatusMissing');

      expect(cache.readinessEvaluator?.({})?.ready).toBe(false);
      expect(cache.readinessEvaluator?.({})?.reason).toBe('StatusMissing');
    });
  });
});
