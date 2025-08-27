import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import { 
  KubernetesClientProvider,
  getCoreV1Api,
  getAppsV1Api,
  getCustomObjectsApi,
  getBatchV1Api,
  getNetworkingV1Api,
  getRbacAuthorizationV1Api,
  getStorageV1Api,
  isClusterAvailable,

  withRetry,
  type RetryOptions
} from '../../../src/core/kubernetes/client-provider.js';

describe('KubernetesClientProvider Extended API Support', () => {
  let provider: KubernetesClientProvider;

  // Helper function to create a working KubeConfig for tests
  function createTestKubeConfig(): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();
    kc.clusters = [{ name: 'test-cluster', server: 'https://test-server:6443', skipTLSVerify: true }];
    kc.users = [{ name: 'test-user', token: 'test-token' }];
    kc.contexts = [{ name: 'test-context', cluster: 'test-cluster', user: 'test-user' }];
    kc.setCurrentContext('test-context');
    return kc;
  }

  // Force reset singleton at the start of this test suite to avoid interference from other tests
  KubernetesClientProvider.reset();

  beforeEach(() => {
    // Reset singleton before each test
    KubernetesClientProvider.reset();
    provider = KubernetesClientProvider.createInstance();
  });

  afterEach(() => {
    KubernetesClientProvider.reset();
  });

  describe('API Client Creation', () => {
    it('should create CoreV1Api client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const coreApi = provider.getCoreV1Api();
      expect(coreApi).toBeInstanceOf(k8s.CoreV1Api);
    });

    it('should create AppsV1Api client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const appsApi = provider.getAppsV1Api();
      expect(appsApi).toBeInstanceOf(k8s.AppsV1Api);
    });

    it('should create CustomObjectsApi client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const customApi = provider.getCustomObjectsApi();
      expect(customApi).toBeInstanceOf(k8s.CustomObjectsApi);
    });

    it('should create BatchV1Api client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const batchApi = provider.getBatchV1Api();
      expect(batchApi).toBeInstanceOf(k8s.BatchV1Api);
    });

    it('should create NetworkingV1Api client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const networkingApi = provider.getNetworkingV1Api();
      expect(networkingApi).toBeInstanceOf(k8s.NetworkingV1Api);
    });

    it('should create RbacAuthorizationV1Api client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const rbacApi = provider.getRbacAuthorizationV1Api();
      expect(rbacApi).toBeInstanceOf(k8s.RbacAuthorizationV1Api);
    });

    it('should create StorageV1Api client', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());
      const storageApi = provider.getStorageV1Api();
      expect(storageApi).toBeInstanceOf(k8s.StorageV1Api);
    });
  });

  describe('Client Caching', () => {
    it('should cache API clients and return same instance', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      const coreApi1 = provider.getCoreV1Api();
      const coreApi2 = provider.getCoreV1Api();
      
      expect(coreApi1).toBe(coreApi2);
    });

    it('should cache different API client types separately', () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      const coreApi = provider.getCoreV1Api();
      const appsApi = provider.getAppsV1Api();
      
      expect(coreApi).not.toBe(appsApi);
      expect(coreApi).toBeInstanceOf(k8s.CoreV1Api);
      expect(appsApi).toBeInstanceOf(k8s.AppsV1Api);
    });
  });

  describe('Convenience Functions', () => {
    it('should provide convenience functions for all API types', () => {
      // For convenience functions, we need to use the initialize method with complete config
      // since they create their own provider instance
      const config = {
        loadFromDefault: false,
        cluster: {
          name: 'test-cluster',
          server: 'https://test-server:6443',
          skipTLSVerify: true,
        },
        user: {
          name: 'test-user',
          token: 'test-token',
        },
      };

      // Test that the convenience functions work (they may fail due to mock config, but should create instances)
      expect(() => getCoreV1Api(config)).not.toThrow();
      expect(() => getAppsV1Api(config)).not.toThrow();
      expect(() => getCustomObjectsApi(config)).not.toThrow();
      expect(() => getBatchV1Api(config)).not.toThrow();
      expect(() => getNetworkingV1Api(config)).not.toThrow();
      expect(() => getRbacAuthorizationV1Api(config)).not.toThrow();
      expect(() => getStorageV1Api(config)).not.toThrow();
      
      // Reset singleton after using convenience functions to avoid polluting other tests
      KubernetesClientProvider.reset();
    });
  });

  describe('Error Handling', () => {
    it('should throw error when accessing API clients before initialization', () => {
      expect(() => provider.getCoreV1Api()).toThrow('KubernetesClientProvider not initialized');
      expect(() => provider.getAppsV1Api()).toThrow('KubernetesClientProvider not initialized');
      expect(() => provider.getCustomObjectsApi()).toThrow('KubernetesClientProvider not initialized');
    });
  });

  describe('Cluster Availability', () => {
    it('should handle cluster availability check gracefully', async () => {
      const kc = createTestKubeConfig();
      if (kc.clusters[0]) {
        kc.clusters[0] = { ...kc.clusters[0], server: 'https://invalid-server:6443' };
      }
      provider.initializeWithKubeConfig(kc);

      // This should not throw, just return false
      const available = await provider.isClusterAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('should provide convenience function for cluster availability', async () => {
      const config = {
        loadFromDefault: false,
        cluster: {
          name: 'test-cluster',
          server: 'https://invalid-server:6443',
          skipTLSVerify: true,
        },
        user: {
          name: 'test-user',
          token: 'test-token',
        },
      };

      const available = await isClusterAvailable(config);
      expect(typeof available).toBe('boolean');
    });
  });

  describe('Retry Logic', () => {
    it('should execute operation with retry logic', async () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('ECONNREFUSED connection refused');
        }
        return 'success';
      };

      const result = await provider.withRetry(operation, { maxAttempts: 3 });
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should respect retry options', async () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      let attempts = 0;
      const operation = async () => {
        attempts++;
        throw new Error('ECONNREFUSED connection refused');
      };

      const options: RetryOptions = {
        maxAttempts: 2,
        baseDelay: 10, // Very short delay for testing
      };

      await expect(provider.withRetry(operation, options)).rejects.toThrow('ECONNREFUSED connection refused');
      expect(attempts).toBe(2);
    });

    it('should provide convenience function for retry logic', async () => {
      const config = {
        loadFromDefault: false,
        cluster: {
          name: 'test-cluster',
          server: 'https://test-server:6443',
          skipTLSVerify: true,
        },
        user: {
          name: 'test-user',
          token: 'test-token',
        },
      };

      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('ECONNREFUSED connection refused');
        }
        return 'success';
      };

      const result = await withRetry(operation, { maxAttempts: 3 }, config);
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should support custom retryable error function', async () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Custom retryable error');
        }
        return 'success';
      };

      const options: RetryOptions = {
        maxAttempts: 3,
        baseDelay: 10,
        retryableErrors: (error: Error) => error.message.includes('retryable'),
      };

      const result = await provider.withRetry(operation, options);
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });
  });

  describe('Retryable Error Detection', () => {
    it('should identify network errors as retryable', async () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('ECONNREFUSED connection refused');
        }
        return 'success';
      };

      const result = await provider.withRetry(operation, { maxAttempts: 2 });
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should not retry non-retryable errors', async () => {
      provider.initializeWithKubeConfig(createTestKubeConfig());

      let attempts = 0;
      const operation = async () => {
        attempts++;
        throw new Error('Authentication failed');
      };

      await expect(provider.withRetry(operation, { maxAttempts: 3 })).rejects.toThrow('Authentication failed');
      expect(attempts).toBe(1); // Should not retry
    });
  });
});