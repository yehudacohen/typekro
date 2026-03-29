import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists, deleteNamespaceAndWait } from '../shared-kubeconfig.js';
import { valkey } from '../../../src/factories/valkey/resources/valkey.js';

describe('Valkey Resource Integration Tests', () => {
  let kubeConfig: any;
  const testNs = 'valkey-resource-test';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await ensureNamespaceExists(testNs, kubeConfig);
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    await deleteNamespaceAndWait(testNs, kubeConfig).catch(() => {});
  });

  describe('Valkey', () => {
    it('should create typed resource with correct apiVersion and kind', () => {
      const cache = valkey({
        name: 'test-valkey',
        namespace: testNs,
        spec: {
          shards: 3,
          replicas: 1,
          volumePermissions: true,
          storage: {
            spec: {
              accessModes: ['ReadWriteOnce'],
              storageClassName: 'standard',
              resources: { requests: { storage: '10Gi' } },
            },
          },
          resources: {
            requests: { cpu: '250m', memory: '512Mi' },
            limits: { cpu: '1', memory: '2Gi' },
          },
        },
        id: 'testCache',
      });

      expect(cache.kind).toBe('Valkey');
      expect(cache.apiVersion).toBe('hyperspike.io/v1');
      expect(cache.metadata.name).toBe('test-valkey');
      expect(cache.metadata.namespace).toBe(testNs);

      // Typed spec access
      expect((cache.spec as Record<string, unknown>).nodes).toBe(3);
      expect(cache.spec.replicas).toBe(1);
      expect(cache.spec.volumePermissions).toBe(true);
      expect(cache.spec.storage?.spec?.storageClassName).toBe('standard');
      expect(cache.spec.resources?.requests?.cpu).toBe('250m');
    });

    it('should create minimal Valkey resource', () => {
      const cache = valkey({
        name: 'minimal-valkey',
        namespace: testNs,
        spec: { volumePermissions: true },
      });

      expect(cache.kind).toBe('Valkey');
      expect(cache.metadata.name).toBe('minimal-valkey');
    });

    it('should create Valkey with TLS and monitoring', () => {
      const cache = valkey({
        name: 'secure-valkey',
        namespace: testNs,
        spec: {
          tls: true,
          certIssuer: 'letsencrypt-prod',
          certIssuerType: 'ClusterIssuer',
          prometheus: true,
          serviceMonitor: true,
          prometheusLabels: { prometheus: 'kube-prometheus' },
        },
      });

      expect(cache.spec.tls).toBe(true);
      expect(cache.spec.certIssuer).toBe('letsencrypt-prod');
      expect(cache.spec.prometheus).toBe(true);
      expect(cache.spec.serviceMonitor).toBe(true);
    });

    it('should create Valkey with external access', () => {
      const cache = valkey({
        name: 'external-valkey',
        namespace: testNs,
        spec: {
          externalAccess: {
            enabled: true,
            type: 'Proxy',
            proxy: {
              replicas: 2,
              hostname: 'valkey.example.com',
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
              },
            },
          },
        },
      });

      expect(cache.spec.externalAccess?.enabled).toBe(true);
      expect(cache.spec.externalAccess?.type).toBe('Proxy');
      expect(cache.spec.externalAccess?.proxy?.replicas).toBe(2);
      expect(cache.spec.externalAccess?.proxy?.hostname).toBe('valkey.example.com');
    });

    it('should evaluate readiness for ready cluster', () => {
      const cache = valkey({ name: 'ready-test', spec: {} });

      const status = cache.readinessEvaluator?.({
        status: { ready: true },
      });

      expect(status?.ready).toBe(true);
      expect(status?.reason).toBe('Ready');
    });

    it('should evaluate readiness for not-ready cluster', () => {
      const cache = valkey({ name: 'not-ready-test', spec: {} });

      const status = cache.readinessEvaluator?.({
        status: {
          ready: false,
          conditions: [{
            type: 'Ready',
            status: 'False',
            reason: 'Initializing',
            message: 'Cluster is starting up',
            lastTransitionTime: '2024-01-15T10:00:00Z',
          }],
        },
      });

      expect(status?.ready).toBe(false);
      expect(status?.reason).toBe('Initializing');
    });

    it('should handle missing status', () => {
      const cache = valkey({ name: 'no-status-test', spec: {} });

      expect(cache.readinessEvaluator?.(null)?.ready).toBe(false);
      expect(cache.readinessEvaluator?.(null)?.reason).toBe('StatusMissing');
      expect(cache.readinessEvaluator?.({})?.ready).toBe(false);
    });
  });
});
