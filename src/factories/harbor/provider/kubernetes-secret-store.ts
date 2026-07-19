import type { V1ConfigMap, V1Secret } from '@kubernetes/client-node';

import {
  createKubernetesClientProvider,
  type KubernetesClientConfig,
} from '../../../core/kubernetes/client-provider.js';

/** Narrow Kubernetes boundary used by Harbor preparation and straightforward to fake in tests. */
export interface HarborKubernetesStore {
  readSecret(namespace: string, name: string): Promise<V1Secret | undefined>;
  readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined>;
  upsertSecret(secret: V1Secret): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
}

/** Create a deployment-scoped Kubernetes store for one selected context. */
export function createHarborKubernetesStore(
  config: KubernetesClientConfig = {}
): HarborKubernetesStore {
  const api = createKubernetesClientProvider(config).getCoreV1Api();
  return {
    async readSecret(namespace, name) {
      try {
        return await api.readNamespacedSecret({ namespace, name });
      } catch (error: unknown) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async readConfigMap(namespace, name) {
      try {
        return await api.readNamespacedConfigMap({ namespace, name });
      } catch (error: unknown) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async upsertSecret(secret) {
      const namespace = requiredMetadata(secret.metadata?.namespace, 'Secret namespace');
      const name = requiredMetadata(secret.metadata?.name, 'Secret name');
      let existing: V1Secret | undefined;
      try {
        existing = await api.readNamespacedSecret({ namespace, name });
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
      }
      if (!existing) {
        await api.createNamespacedSecret({ namespace, body: secret });
        return;
      }
      await api.replaceNamespacedSecret({
        namespace,
        name,
        body: {
          ...secret,
          metadata: {
            ...secret.metadata,
            ...(existing.metadata?.resourceVersion
              ? { resourceVersion: existing.metadata.resourceVersion }
              : {}),
          },
        },
      });
    },
    async deleteSecret(namespace, name) {
      try {
        await api.deleteNamespacedSecret({ namespace, name });
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

function requiredMetadata(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number; status?: number };
    body?: { code?: number };
  };
  return (
    candidate.code === 404 ||
    candidate.statusCode === 404 ||
    candidate.response?.statusCode === 404 ||
    candidate.response?.status === 404 ||
    candidate.body?.code === 404
  );
}
