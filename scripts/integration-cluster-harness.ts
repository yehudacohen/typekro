#!/usr/bin/env bun

import type * as k8s from '@kubernetes/client-node';
import * as yaml from 'js-yaml';
import { isConflictError } from '../src/core/deployment/k8s-helpers.js';
import type { KubernetesResource } from '../src/core/types/kubernetes.js';
import {
  createAppsV1ApiClient,
  createKubernetesObjectApiClient,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../test/integration/shared-kubeconfig.js';

const LOCAL_PATH_MANIFEST =
  'https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml';

type StorageClassResource = KubernetesResource & {
  metadata: KubernetesResource['metadata'] & {
    annotations?: Record<string, string>;
  };
};

function resourceIdentity(resource: KubernetesResource): KubernetesResource {
  const name = resource.metadata?.name;
  if (!name) {
    throw new Error(`${resource.apiVersion}/${resource.kind} manifest has no metadata.name`);
  }
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name,
      ...(resource.metadata.namespace ? { namespace: resource.metadata.namespace } : {}),
    },
  };
}

async function createOrReplace(
  objectApi: k8s.KubernetesObjectApi,
  manifest: KubernetesResource
): Promise<void> {
  try {
    await objectApi.create(manifest);
  } catch (error: unknown) {
    if (!isConflictError(error)) throw error;
    const live = await objectApi.read(resourceIdentity(manifest));
    await objectApi.replace({
      ...manifest,
      metadata: {
        ...manifest.metadata,
        resourceVersion: live.metadata?.resourceVersion,
      },
    });
  }
}

async function waitForDeploymentReady(
  namespace: string,
  name: string,
  kubeConfig: k8s.KubeConfig,
  timeoutMs = 180_000
): Promise<void> {
  const appsApi = createAppsV1ApiClient(kubeConfig);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = await appsApi.readNamespacedDeployment({ namespace, name });
    const desired = deployment.spec?.replicas ?? 1;
    if (
      deployment.status?.observedGeneration === deployment.metadata?.generation &&
      (deployment.status?.availableReplicas ?? 0) >= desired
    ) {
      return;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for Deployment ${namespace}/${name}`);
}

async function installLocalPathProvisioner(kubeConfig: k8s.KubeConfig): Promise<void> {
  const response = await fetch(LOCAL_PATH_MANIFEST);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch local-path provisioner manifest: ${response.status} ${response.statusText}`
    );
  }
  const documents = yaml
    .loadAll(await response.text(), undefined, { schema: yaml.JSON_SCHEMA })
    .filter((document): document is KubernetesResource =>
      Boolean(
        document && typeof document === 'object' && 'apiVersion' in document && 'kind' in document
      )
    );
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  for (const manifest of documents) {
    await createOrReplace(objectApi, manifest);
  }
  await waitForDeploymentReady('local-path-storage', 'local-path-provisioner', kubeConfig, 180_000);
}

async function listStorageClasses(kubeConfig: k8s.KubeConfig): Promise<StorageClassResource[]> {
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  const response = await objectApi.list('storage.k8s.io/v1', 'StorageClass');
  return response.items as StorageClassResource[];
}

function defaultStorageClass(resources: StorageClassResource[]): string | undefined {
  return resources.find((resource) => {
    const annotations = resource.metadata?.annotations ?? {};
    return (
      annotations['storageclass.kubernetes.io/is-default-class'] === 'true' ||
      annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
    );
  })?.metadata?.name;
}

async function resolveStorageClass(
  requested: string | undefined,
  allowInstall: boolean
): Promise<string> {
  const kubeConfig = getIntegrationTestKubeConfig();
  let storageClasses = await listStorageClasses(kubeConfig);
  if (requested) {
    if (!storageClasses.some((resource) => resource.metadata?.name === requested)) {
      throw new Error(`Configured StorageClass does not exist: ${requested}`);
    }
    return requested;
  }

  const currentDefault = defaultStorageClass(storageClasses);
  if (currentDefault) return currentDefault;
  if (!allowInstall) {
    throw new Error(
      'Existing cluster has no default StorageClass. Set TYPEKRO_NATS_STORAGE_CLASS to an existing RWO-capable class.'
    );
  }

  console.error('Installing local-path StorageClass in the harness-created cluster...');
  await installLocalPathProvisioner(kubeConfig);
  storageClasses = await listStorageClasses(kubeConfig);
  if (!storageClasses.some((resource) => resource.metadata?.name === 'local-path')) {
    throw new Error('local-path provisioner became ready without creating its StorageClass');
  }
  return 'local-path';
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'cluster-ready') {
    process.exit((await isClusterAvailable()) ? 0 : 1);
  }
  if (command === 'current-context') {
    console.log(getIntegrationTestKubeConfig().getCurrentContext());
    return;
  }
  if (command === 'storage-class') {
    const requested = process.argv[3]?.trim() || undefined;
    console.log(await resolveStorageClass(requested, process.env.CREATE_CLUSTER === 'true'));
    return;
  }
  throw new Error(
    'Usage: integration-cluster-harness.ts <cluster-ready|current-context|storage-class> [name]'
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
