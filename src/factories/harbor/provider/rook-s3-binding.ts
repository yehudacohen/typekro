import type { V1Secret } from '@kubernetes/client-node';

import type { KubernetesClientConfig } from '../../../core/kubernetes/client-provider.js';
import {
  createHarborKubernetesStore,
  type HarborKubernetesStore,
} from './kubernetes-secret-store.js';

export interface PrepareHarborRookS3BindingOptions {
  sourceNamespace: string;
  claimName: string;
  targetNamespace: string;
  targetSecretName: string;
  secure?: boolean;
  endpointOverride?: string;
  regionOverride?: string;
  rootDirectory?: string;
  kubeConfig?: KubernetesClientConfig;
  store?: HarborKubernetesStore;
}

export interface PreparedHarborRookS3Binding {
  bucket: string;
  region: string;
  regionEndpoint: string;
  existingSecret: string;
  secure: boolean;
  rootDirectory?: string;
}

/**
 * Adapt a bound Rook OBC Secret to Harbor's official S3 Secret contract.
 *
 * Encoded credential bytes are copied directly between Kubernetes Secrets. They are never decoded,
 * returned, logged, or inserted into a TypeKro graph.
 */
export async function prepareHarborRookS3Binding(
  options: PrepareHarborRookS3BindingOptions
): Promise<PreparedHarborRookS3Binding> {
  const store = options.store ?? createHarborKubernetesStore(options.kubeConfig);
  const [credentials, connection] = await Promise.all([
    store.readSecret(options.sourceNamespace, options.claimName),
    store.readConfigMap(options.sourceNamespace, options.claimName),
  ]);
  if (!credentials) {
    throw new Error(
      `Rook OBC credential Secret ${options.sourceNamespace}/${options.claimName} is not available.`
    );
  }
  if (!connection) {
    throw new Error(
      `Rook OBC connection ConfigMap ${options.sourceNamespace}/${options.claimName} is not available.`
    );
  }
  const accessKey = requiredSecretKey(credentials, 'AWS_ACCESS_KEY_ID');
  const secretKey = requiredSecretKey(credentials, 'AWS_SECRET_ACCESS_KEY');
  const bucket = requiredConfig(connection.data, 'BUCKET_NAME');
  const secure = options.secure ?? false;
  const host = requiredConfig(connection.data, 'BUCKET_HOST');
  const port = connection.data?.BUCKET_PORT;
  const regionEndpoint =
    options.endpointOverride ?? `${secure ? 'https' : 'http'}://${host}${port ? `:${port}` : ''}`;
  const configuredRegion = options.regionOverride ?? connection.data?.BUCKET_REGION;
  // Rook emits BUCKET_REGION as an empty string for RGW installations without
  // an explicit zonegroup region. Harbor's distribution registry rejects an
  // empty region, so normalize both missing and blank provider values to the
  // conventional S3 default.
  const region = configuredRegion?.trim() || 'us-east-1';

  const adapted: V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: options.targetSecretName,
      namespace: options.targetNamespace,
      labels: {
        'app.kubernetes.io/name': 'harbor',
        'app.kubernetes.io/component': 'registry-storage',
        'app.kubernetes.io/managed-by': 'typekro',
        'typekro.dev/source-obc': options.claimName,
      },
    },
    type: 'Opaque',
    data: {
      REGISTRY_STORAGE_S3_ACCESSKEY: accessKey,
      REGISTRY_STORAGE_S3_SECRETKEY: secretKey,
    },
  };
  await store.upsertSecret(adapted);

  return {
    bucket,
    region,
    regionEndpoint,
    existingSecret: options.targetSecretName,
    secure,
    ...(options.rootDirectory ? { rootDirectory: options.rootDirectory } : {}),
  };
}

function requiredSecretKey(secret: V1Secret, key: string): string {
  const value = secret.data?.[key];
  if (!value) throw new Error(`Rook OBC credential Secret is missing required key ${key}.`);
  return value;
}

function requiredConfig(data: Record<string, string> | undefined, key: string): string {
  const value = data?.[key];
  if (!value) throw new Error(`Rook OBC connection ConfigMap is missing required key ${key}.`);
  return value;
}
