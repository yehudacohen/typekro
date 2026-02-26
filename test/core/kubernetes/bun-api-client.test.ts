import { describe, expect, it } from 'bun:test';
import * as k8s from '@kubernetes/client-node';
import {
  createBunCompatibleApiClient,
  createBunCompatibleApiextensionsV1Api,
  createBunCompatibleAppsV1Api,
  createBunCompatibleBatchV1Api,
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
  createBunCompatibleNetworkingV1Api,
  createBunCompatibleRbacAuthorizationV1Api,
  createBunCompatibleStorageV1Api,
} from '../../../src/core/kubernetes/bun-api-client.js';

/**
 * Helper to create a KubeConfig with a valid cluster for testing.
 * This KubeConfig won't actually connect to anything — it just has
 * enough structure to pass the "has cluster" check.
 */
function createTestKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [
      {
        name: 'test-cluster',
        server: 'https://127.0.0.1:6443',
        skipTLSVerify: true,
      },
    ],
    users: [{ name: 'test-user', token: 'test-token' }],
    contexts: [
      {
        name: 'test-context',
        cluster: 'test-cluster',
        user: 'test-user',
      },
    ],
    currentContext: 'test-context',
  });
  return kc;
}

/**
 * Helper to create a KubeConfig with no cluster (empty config).
 */
function createEmptyKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [],
    users: [],
    contexts: [],
    currentContext: '',
  });
  return kc;
}

describe('bun-api-client', () => {
  // =========================================================================
  // createBunCompatibleApiClient (generic factory)
  // =========================================================================
  describe('createBunCompatibleApiClient', () => {
    it('creates a CoreV1Api client with valid KubeConfig', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiClient(kc, k8s.CoreV1Api);
      expect(client).toBeDefined();
    });

    it('creates an AppsV1Api client with valid KubeConfig', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiClient(kc, k8s.AppsV1Api);
      expect(client).toBeDefined();
    });

    it('throws KubernetesClientError when no cluster is configured', () => {
      const kc = createEmptyKubeConfig();
      expect(() => createBunCompatibleApiClient(kc, k8s.CoreV1Api)).toThrow(/No active cluster/);
    });

    it('accepts custom timeout configuration', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiClient(kc, k8s.CoreV1Api, {
        default: 5000,
        watch: 60000,
      });
      expect(client).toBeDefined();
    });
  });

  // =========================================================================
  // Convenience wrapper functions
  // =========================================================================
  describe('convenience wrappers', () => {
    it('createBunCompatibleCoreV1Api returns CoreV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleCoreV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleAppsV1Api returns AppsV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleAppsV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleCustomObjectsApi returns CustomObjectsApi', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleCustomObjectsApi(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleBatchV1Api returns BatchV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleBatchV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleNetworkingV1Api returns NetworkingV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleNetworkingV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleRbacAuthorizationV1Api returns RbacAuthorizationV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleRbacAuthorizationV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleStorageV1Api returns StorageV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleStorageV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleApiextensionsV1Api returns ApiextensionsV1Api', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleApiextensionsV1Api(kc);
      expect(client).toBeDefined();
    });

    it('createBunCompatibleKubernetesObjectApi returns KubernetesObjectApi', () => {
      const kc = createTestKubeConfig();
      const client = createBunCompatibleKubernetesObjectApi(kc);
      expect(client).toBeDefined();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('error handling', () => {
    it('all convenience wrappers throw on empty KubeConfig', () => {
      const kc = createEmptyKubeConfig();

      expect(() => createBunCompatibleCoreV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleAppsV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleCustomObjectsApi(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleBatchV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleNetworkingV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleRbacAuthorizationV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleStorageV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleApiextensionsV1Api(kc)).toThrow(/No active cluster/);
      expect(() => createBunCompatibleKubernetesObjectApi(kc)).toThrow(/No active cluster/);
    });
  });
});
