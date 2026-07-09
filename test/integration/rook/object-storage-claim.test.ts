/**
 * Opt-in live proof for the app-owned Rook object-storage slice.
 *
 * Prerequisites:
 * - a reachable cluster with KRO for the KRO case;
 * - a healthy Rook object store and bucket StorageClass;
 * - `RUN_ROOK_INTEGRATION=true`;
 * - `TYPEKRO_ROOK_STORAGE_CLASS=<name>` (use reclaimPolicy Delete for tests).
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCoreV1Api } from '../../../src/core/kubernetes/index.js';
import { rookObjectStorageClaim } from '../../../src/factories/rook/index.js';
import {
  deleteNamespaceAndWait,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const runRequested = process.env.RUN_ROOK_INTEGRATION === 'true';
const clusterAvailable = isClusterAvailable();
const describeOrSkip = runRequested && clusterAvailable ? describe : describe.skip;
const storageClassName = process.env.TYPEKRO_ROOK_STORAGE_CLASS;
const namespace = 'typekro-rook-object-storage';

setDefaultTimeout(600000);

describeOrSkip('Rook ObjectBucketClaim live integration', () => {
  const kubeConfig = getKubeConfig({ skipTLSVerify: true });

  afterAll(async () => {
    await deleteNamespaceAndWait(namespace, kubeConfig).catch((error: unknown) => {
      console.error('Rook integration namespace cleanup failed:', error);
    });
  });

  it('binds an OBC and creates the documented Secret and ConfigMap in direct mode', async () => {
    if (!storageClassName) {
      throw new Error('TYPEKRO_ROOK_STORAGE_CLASS is required when RUN_ROOK_INTEGRATION=true');
    }

    await ensureNamespaceExists(namespace, kubeConfig);
    const factory = rookObjectStorageClaim.factory('direct', {
      namespace,
      waitForReady: true,
      timeout: 300000,
      kubeConfig,
    });

    const name = 'direct-bucket';
    try {
      const instance = await factory.deploy({
        name,
        namespace,
        storageClassName,
        generateBucketName: 'typekro-direct',
        maxObjects: '1000',
        maxSize: '1G',
      });

      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Bound');

      const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
      const secret = await coreApi.readNamespacedSecret({ name, namespace });
      const configMap = await coreApi.readNamespacedConfigMap({ name, namespace });

      expect(secret.data?.AWS_ACCESS_KEY_ID).toBeDefined();
      expect(secret.data?.AWS_SECRET_ACCESS_KEY).toBeDefined();
      expect(configMap.data?.BUCKET_HOST).toBeDefined();
      expect(configMap.data?.BUCKET_PORT).toBeDefined();
      expect(configMap.data?.BUCKET_NAME).toBeDefined();
    } finally {
      await factory.deleteInstance(name).catch((error: unknown) => {
        console.error('Direct OBC cleanup failed:', error);
      });
    }
  });

  it('projects Bound readiness and binding names onto the live KRO instance', async () => {
    if (!storageClassName) {
      throw new Error('TYPEKRO_ROOK_STORAGE_CLASS is required when RUN_ROOK_INTEGRATION=true');
    }

    await ensureNamespaceExists(namespace, kubeConfig);
    const factory = rookObjectStorageClaim.factory('kro', {
      namespace,
      waitForReady: true,
      timeout: 300000,
      kubeConfig,
    });

    const name = 'kro-bucket';
    try {
      const instance = await factory.deploy({
        name,
        namespace,
        storageClassName,
        generateBucketName: 'typekro-kro',
      });

      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Bound');
      expect(instance.status.claimName).toBe(name);
      expect(instance.status.credentialsSecretName).toBe(name);
      expect(instance.status.connectionConfigMapName).toBe(name);
      expect(instance.status.storageClassName).toBe(storageClassName);

      const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
      const secret = await coreApi.readNamespacedSecret({ name, namespace });
      const configMap = await coreApi.readNamespacedConfigMap({ name, namespace });
      expect(secret.data?.AWS_ACCESS_KEY_ID).toBeDefined();
      expect(configMap.data?.BUCKET_NAME).toBeDefined();
    } finally {
      await factory.deleteInstance(name).catch((error: unknown) => {
        console.error('KRO OBC cleanup failed:', error);
      });
    }
  });
});
