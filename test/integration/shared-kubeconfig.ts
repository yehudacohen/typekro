import * as k8s from '@kubernetes/client-node';
import { isConflictError } from '../../src/core/deployment/k8s-helpers.js';
import {
  classifyNamespaceEmptiness,
  createClusterNamespaceInventory,
  type NamespaceInventory,
} from '../../src/core/deployment/kro-namespace-teardown.js';
import {
  createBunCompatibleApiextensionsV1Api,
  createBunCompatibleAppsV1Api,
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../../src/core/kubernetes/index.js';
import type {
  ResourceDeletionResult,
  ResourceFactoryDeleteOptions,
} from '../../src/core/types/deployment.js';

export interface ResourceIdentity {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
  };
}

export interface TestNamespaceLease {
  name: string;
  uid: string;
}

const testNamespaceLeases = new Map<string, TestNamespaceLease>();
export const TYPEKRO_TEST_NAMESPACE_LABEL = 'typekro.dev/integration-test';
const MIN_TEST_NAMESPACE_CONTROLLER_DRAIN_TIMEOUT_MS = 300_000;

export interface TestDeletableFactory {
  deleteInstance(
    instanceName: string,
    options?: ResourceFactoryDeleteOptions
  ): Promise<ResourceDeletionResult>;
}

export class TestFactoryCleanupRegistry {
  readonly #deployments: Array<{
    factory: TestDeletableFactory;
    instanceName: string;
    namespaceLeases: readonly TestNamespaceLease[];
  }> = [];
  readonly #postFactoryCleanups: Array<() => Promise<void>> = [];

  track(
    factory: TestDeletableFactory,
    instanceName: string,
    namespaceLeases: readonly TestNamespaceLease[] = []
  ): void {
    this.#deployments.push({ factory, instanceName, namespaceLeases });
  }

  trackResult(
    factory: TestDeletableFactory,
    result: { metadata?: { name?: unknown } },
    namespaceLeases: readonly TestNamespaceLease[] = []
  ): void {
    const instanceName = result.metadata?.name;
    if (typeof instanceName !== 'string' || instanceName.length === 0) {
      throw new Error('Cannot register a deployed factory result without metadata.name');
    }
    this.track(factory, instanceName, namespaceLeases);
  }

  /**
   * Register exact harness-owned or controller-generated cleanup that must run
   * only after normal TypeKro factory teardown has been attempted.
   */
  trackPostFactoryCleanup(cleanup: () => Promise<void>): void {
    this.#postFactoryCleanups.push(cleanup);
  }

  async cleanup(
    kc?: k8s.KubeConfig,
    timeoutMs = 30_000,
    deleteOptions: Omit<ResourceFactoryDeleteOptions, 'timeout'> = {}
  ): Promise<void> {
    const cleanupErrors: unknown[] = [];
    for (const deployment of this.#deployments.splice(0).reverse()) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          deployment.factory,
          deployment.instanceName,
          deployment.namespaceLeases,
          kc,
          timeoutMs,
          deleteOptions
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const cleanup of this.#postFactoryCleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up test factory deployments');
    }
  }
}

export class ResourceDeletionTimeoutError extends Error {}

export function assertTestNamespaceLease(
  namespace: { metadata?: { name?: string; uid?: string } },
  lease: TestNamespaceLease
): void {
  const liveName = namespace.metadata?.name;
  const liveUid = namespace.metadata?.uid;
  if (liveName !== lease.name || liveUid !== lease.uid) {
    throw new Error(
      `Refusing test namespace deletion for ${lease.name}: ownership lease does not match the live namespace`
    );
  }
}

export async function assertTestNamespaceEmpty(
  namespace: string,
  inventory: NamespaceInventory
): Promise<void> {
  const verdict = await classifyNamespaceEmptiness(inventory, namespace);
  if (!verdict.empty) {
    throw new Error(`Refusing namespace finalizer recovery for ${namespace}: ${verdict.reason}`);
  }
}

export async function waitForTestNamespaceEmpty(
  namespace: string,
  inventory: NamespaceInventory,
  timeoutMs: number,
  pollIntervalMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'namespace emptiness was not checked';
  do {
    const verdict = await classifyNamespaceEmptiness(inventory, namespace);
    if (verdict.empty) return;
    lastReason = verdict.reason;
    if (Date.now() >= deadline) break;
    await Bun.sleep(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
  } while (Date.now() <= deadline);

  throw new Error(
    `Refusing namespace finalizer recovery for ${namespace} after ${timeoutMs}ms: ${lastReason}`
  );
}

export function isNotFoundError(error: unknown): boolean {
  const candidate = error as {
    code?: number;
    statusCode?: number;
    body?: { code?: number; reason?: string };
  };
  return (
    candidate.statusCode === 404 ||
    candidate.code === 404 ||
    candidate.body?.code === 404 ||
    candidate.body?.reason === 'NotFound'
  );
}

/**
 * Get a properly configured KubeConfig for integration tests
 * This ensures consistent TLS configuration across all integration tests
 */
export function getIntegrationTestKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  // Configure to skip TLS verification for test environment
  const cluster = kc.getCurrentCluster();
  if (cluster) {
    (cluster as any).skipTLSVerify = true;
  }

  // Ensure we have a valid context
  if (!kc.getCurrentCluster()) {
    throw new Error(
      'No active Kubernetes cluster found. Make sure kubectl is configured and the test cluster is running. ' +
        'Run: bun run scripts/e2e-setup.ts to set up the test environment.'
    );
  }

  return kc;
}

/**
 * Create a CoreV1Api client for integration tests
 * Uses createBunCompatibleCoreV1Api which handles both Bun and Node.js
 * See: https://github.com/oven-sh/bun/issues/10642
 */
export function createCoreV1ApiClient(kc?: k8s.KubeConfig): k8s.CoreV1Api {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  return createBunCompatibleCoreV1Api(kubeConfig);
}

/**
 * Create an AppsV1Api client for integration tests
 * Uses createBunCompatibleAppsV1Api which handles both Bun and Node.js
 */
export function createAppsV1ApiClient(kc?: k8s.KubeConfig): k8s.AppsV1Api {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  return createBunCompatibleAppsV1Api(kubeConfig);
}

/**
 * Create a CustomObjectsApi client for integration tests
 * Uses createBunCompatibleCustomObjectsApi which handles both Bun and Node.js
 */
export function createCustomObjectsApiClient(kc?: k8s.KubeConfig): k8s.CustomObjectsApi {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  return createBunCompatibleCustomObjectsApi(kubeConfig);
}

/**
 * Create a KubernetesObjectApi client for integration tests
 * Uses createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
 */
export function createKubernetesObjectApiClient(kc?: k8s.KubeConfig): k8s.KubernetesObjectApi {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  return createBunCompatibleKubernetesObjectApi(kubeConfig);
}

export interface TestStorageClassReader {
  read(resource: {
    apiVersion: 'storage.k8s.io/v1';
    kind: 'StorageClass';
    metadata: { name: string };
  }): Promise<unknown>;
}

export interface TestStorageClassRequirement {
  kubeConfig?: k8s.KubeConfig;
  envVar?: string;
  environment?: Record<string, string | undefined>;
  reader?: TestStorageClassReader;
}

/**
 * Require explicit, cluster-verified storage evidence for a live integration.
 * Existing clusters must never inherit an arbitrary default StorageClass.
 */
export async function requireTestStorageClass(
  requirement: TestStorageClassRequirement = {}
): Promise<string> {
  const envVar = requirement.envVar ?? 'TYPEKRO_TEST_STORAGE_CLASS';
  const environment = requirement.environment ?? process.env;
  const name = environment[envVar]?.trim();
  if (!name) {
    throw new Error(
      `Storage-backed integration tests require an explicit StorageClass. ` +
        `Set ${envVar}=<rwo-storage-class>; no cluster default will be selected implicitly.`
    );
  }

  const reader = requirement.reader ?? createKubernetesObjectApiClient(requirement.kubeConfig);
  try {
    await reader.read({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name },
    });
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      throw new Error(`Configured StorageClass does not exist: ${name}`, { cause: error });
    }
    throw new Error(`Failed to verify configured StorageClass ${name}`, { cause: error });
  }

  return name;
}

export interface TestPodOptions {
  namespace: string;
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: k8s.V1EnvVar[];
  envFrom?: k8s.V1EnvFromSource[];
  securityContext?: k8s.V1SecurityContext;
  volumeMounts?: k8s.V1VolumeMount[];
  volumes?: k8s.V1Volume[];
  timeoutMs?: number;
  containerName?: string;
}

/** Run an isolated probe Pod, return its logs, and delete it with a UID guard. */
export async function runTestPodAndReadLogs(
  options: TestPodOptions,
  kc?: k8s.KubeConfig
): Promise<string> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const containerName = options.containerName ?? 'probe';
  const created = await coreApi.createNamespacedPod({
    namespace: options.namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: options.name },
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: containerName,
            image: options.image,
            ...(options.command ? { command: options.command } : {}),
            ...(options.args ? { args: options.args } : {}),
            ...(options.env ? { env: options.env } : {}),
            ...(options.envFrom ? { envFrom: options.envFrom } : {}),
            ...(options.securityContext ? { securityContext: options.securityContext } : {}),
            ...(options.volumeMounts ? { volumeMounts: options.volumeMounts } : {}),
          },
        ],
        ...(options.volumes ? { volumes: options.volumes } : {}),
      },
    },
  });
  const uid = created.metadata?.uid;
  if (!uid) {
    throw new Error(
      `Created test Pod ${options.namespace}/${options.name} did not return metadata.uid`
    );
  }

  let logs: string | undefined;
  let operationError: unknown;
  try {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 180_000;
    while (Date.now() - startedAt < timeoutMs) {
      const pod = await coreApi.readNamespacedPod({
        namespace: options.namespace,
        name: options.name,
      });
      if (pod.status?.phase === 'Succeeded') {
        logs = await coreApi.readNamespacedPodLog({
          namespace: options.namespace,
          name: options.name,
          container: containerName,
        });
        break;
      }
      if (pod.status?.phase === 'Failed') {
        const logs = await coreApi
          .readNamespacedPodLog({
            namespace: options.namespace,
            name: options.name,
            container: containerName,
          })
          .catch(() => '');
        throw new Error(
          `Test Pod ${options.namespace}/${options.name} failed${logs ? `: ${logs}` : ''}`
        );
      }
      await Bun.sleep(1_000);
    }
    if (logs === undefined) {
      throw new Error(
        `Timed out waiting for test Pod ${options.namespace}/${options.name} to complete`
      );
    }
  } catch (error: unknown) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    try {
      await coreApi.deleteNamespacedPod({
        namespace: options.namespace,
        name: options.name,
        body: { preconditions: { uid } },
      });
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
    await waitForResourceAbsent(
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { namespace: options.namespace, name: options.name },
      },
      kubeConfig,
      30_000
    );
  } catch (error: unknown) {
    cleanupError = error;
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      `Test Pod ${options.namespace}/${options.name} failed and could not be cleaned up`
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return logs as string;
}

/** Delete one deliberately faulted test Pod without racing a replacement. */
export async function deleteTestPodAndWait(
  namespace: string,
  name: string,
  kc?: k8s.KubeConfig,
  timeoutMs = 30_000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  let pod: Awaited<ReturnType<typeof coreApi.readNamespacedPod>>;
  try {
    pod = await coreApi.readNamespacedPod({ namespace, name });
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const uid = pod.metadata?.uid;
  if (!uid) throw new Error(`Test Pod ${namespace}/${name} has no metadata.uid`);
  await coreApi.deleteNamespacedPod({
    namespace,
    name,
    body: { preconditions: { uid } },
  });
  await waitForResourceAbsent(
    { apiVersion: 'v1', kind: 'Pod', metadata: { namespace, name } },
    kubeConfig,
    timeoutMs
  );
}

/** Delete one exact test Secret with an immutable UID precondition. */
export async function deleteTestSecretAndWait(
  namespace: string,
  name: string,
  kc?: k8s.KubeConfig,
  timeoutMs = 30_000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  let secret: k8s.V1Secret;
  try {
    secret = await coreApi.readNamespacedSecret({ namespace, name });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const uid = secret.metadata?.uid;
  if (!uid) {
    throw new Error(`Refusing cleanup for Secret ${namespace}/${name}: metadata.uid is missing`);
  }
  await coreApi.deleteNamespacedSecret({
    namespace,
    name,
    body: { preconditions: { uid } },
  });
  await waitForResourceAbsent(
    { apiVersion: 'v1', kind: 'Secret', metadata: { namespace, name } },
    kubeConfig,
    timeoutMs
  );
}

/** Delete one exact test ConfigMap with an immutable UID precondition. */
export async function deleteTestConfigMapAndWait(
  namespace: string,
  name: string,
  kc?: k8s.KubeConfig,
  timeoutMs = 30_000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  let configMap: k8s.V1ConfigMap;
  try {
    configMap = await coreApi.readNamespacedConfigMap({ namespace, name });
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const uid = configMap.metadata?.uid;
  if (!uid) {
    throw new Error(`Refusing cleanup for ConfigMap ${namespace}/${name}: metadata.uid is missing`);
  }
  await coreApi.deleteNamespacedConfigMap({
    namespace,
    name,
    body: { preconditions: { uid } },
  });
  await waitForResourceAbsent(
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace, name } },
    kubeConfig,
    timeoutMs
  );
}

/** Delete one exact Kubernetes resource with an immutable UID precondition. */
export async function deleteTestResourceAndWait(
  resource: ResourceIdentity,
  kc?: k8s.KubeConfig,
  timeoutMs = 30_000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  let live: k8s.KubernetesObject;
  try {
    live = await objectApi.read(resource);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const uid = live.metadata?.uid;
  if (!uid) {
    throw new Error(
      `Refusing cleanup for ${resource.kind} ${resource.metadata.namespace ? `${resource.metadata.namespace}/` : ''}${resource.metadata.name}: metadata.uid is missing`
    );
  }
  if (resource.metadata.uid && resource.metadata.uid !== uid) {
    throw new Error(
      `Refusing cleanup for ${resource.kind} ${resource.metadata.namespace ? `${resource.metadata.namespace}/` : ''}${resource.metadata.name}: expected uid ${resource.metadata.uid}, found ${uid}`
    );
  }
  await objectApi.delete(live, undefined, undefined, undefined, undefined, 'Foreground', {
    preconditions: { uid },
  });
  await waitForResourceAbsent(resource, kubeConfig, timeoutMs);
}

/**
 * Explicitly orphan the installed Helm release owned by a suspended Flux
 * HelmRelease. This is only for tests that must remove the Flux API object
 * while deliberately retaining its installed workloads.
 */
export async function prepareTestHelmReleaseForOrphanedDeletion(
  namespace: string,
  name: string,
  kc?: k8s.KubeConfig,
  expectedOwner?: { factoryName: string; instanceName: string }
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  const identity: ResourceIdentity = {
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { namespace, name },
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let live: k8s.KubernetesObject & {
      spec?: { suspend?: boolean };
    };
    try {
      await objectApi.patch(
        { ...identity, spec: { suspend: true } },
        undefined,
        undefined,
        undefined,
        undefined,
        'application/merge-patch+json'
      );
      live = (await objectApi.read(identity)) as typeof live;
      if (live.spec?.suspend !== true) {
        throw new Error(`Refusing to orphan HelmRelease ${namespace}/${name}: it is not suspended`);
      }
      if (expectedOwner) {
        const annotations = live.metadata?.annotations ?? {};
        if (
          annotations['typekro.io/factory-name'] !== expectedOwner.factoryName ||
          annotations['typekro.io/instance-name'] !== expectedOwner.instanceName
        ) {
          throw new Error(
            `Refusing to orphan HelmRelease ${namespace}/${name}: TypeKro ownership does not match`
          );
        }
      }

      const finalizers = (live.metadata?.finalizers ?? []).filter(
        (finalizer) => finalizer !== 'finalizers.fluxcd.io'
      );
      if (finalizers.length === (live.metadata?.finalizers ?? []).length) return;
      await objectApi.replace({
        ...live,
        metadata: {
          ...live.metadata,
          finalizers,
        },
      });
      return;
    } catch (error) {
      if (isNotFoundError(error)) return;
      if (isConflictError(error) && attempt < 5) {
        await Bun.sleep(attempt * 100);
        continue;
      }
      throw error;
    }
  }
}

/** Delete the exact Flux HelmChart generated for one orphaned HelmRelease. */
export async function deleteTestFluxHelmReleaseArtifacts(
  releaseNamespace: string,
  releaseName: string,
  sourceNamespace: string,
  kc?: k8s.KubeConfig
): Promise<void> {
  await deleteTestResourceAndWait(
    {
      apiVersion: 'source.toolkit.fluxcd.io/v1',
      kind: 'HelmChart',
      metadata: {
        namespace: sourceNamespace,
        name: `${releaseNamespace}-${releaseName}`,
      },
    },
    kc
  );
}

/**
 * Delete Helm hook resources for exact releases after their factory teardown.
 *
 * Helm deliberately retains hooks whose policy is only
 * `before-hook-creation`. Cleanup is fail-closed on the hook annotation and
 * exact release instance label. Top-level hooks also require Helm's manager
 * label; hook Pods require the exact Kubernetes Job-name label because Helm
 * does not propagate the manager label to their Pod templates.
 */
export async function deleteTestHelmHookResources(
  namespace: string,
  releaseNames: readonly string[],
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  const releases = new Set(releaseNames);
  const configMaps = await coreApi.listNamespacedConfigMap({ namespace });
  const secrets = await coreApi.listNamespacedSecret({ namespace });
  const serviceAccounts = await coreApi.listNamespacedServiceAccount({ namespace });
  const pods = await coreApi.listNamespacedPod({ namespace });
  const jobs = (await objectApi.list('batch/v1', 'Job', namespace)) as {
    items: k8s.KubernetesObject[];
  };
  const matchingHookRelease = (resource: k8s.KubernetesObject): string | undefined => {
    const metadata = resource.metadata;
    if (!metadata?.name || !metadata.annotations?.['helm.sh/hook']) return undefined;
    const releaseName = metadata.labels?.['app.kubernetes.io/instance'];
    return releaseName && releases.has(releaseName) ? releaseName : undefined;
  };
  const isMatchingManagedHook = (resource: k8s.KubernetesObject): boolean => {
    return (
      matchingHookRelease(resource) !== undefined &&
      resource.metadata?.labels?.['app.kubernetes.io/managed-by'] === 'Helm'
    );
  };
  const isMatchingHookPod = (resource: k8s.KubernetesObject): boolean => {
    const releaseName = matchingHookRelease(resource);
    if (!releaseName) return false;
    const jobName =
      resource.metadata?.labels?.['batch.kubernetes.io/job-name'] ??
      resource.metadata?.labels?.['job-name'];
    return typeof jobName === 'string' && jobName.startsWith(`${releaseName}-`);
  };
  const matchingJobs: ResourceIdentity[] = jobs.items.filter(isMatchingManagedHook).map((job) => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { namespace, name: job.metadata?.name ?? '' },
  }));
  const matchingPods: ResourceIdentity[] = pods.items.filter(isMatchingHookPod).map((pod) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { namespace, name: pod.metadata?.name ?? '' },
  }));
  const matchingConfigMaps: ResourceIdentity[] = configMaps.items
    .filter(isMatchingManagedHook)
    .map((configMap) => ({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { namespace, name: configMap.metadata?.name ?? '' },
    }));
  const matchingSecrets: ResourceIdentity[] = secrets.items
    .filter(isMatchingManagedHook)
    .map((secret) => ({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { namespace, name: secret.metadata?.name ?? '' },
    }));
  const matchingServiceAccounts: ResourceIdentity[] = serviceAccounts.items
    .filter(isMatchingManagedHook)
    .map((serviceAccount) => ({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { namespace, name: serviceAccount.metadata?.name ?? '' },
    }));

  const failures: unknown[] = [];
  for (const resources of [
    matchingJobs,
    matchingPods,
    matchingConfigMaps,
    matchingSecrets,
    matchingServiceAccounts,
  ]) {
    const results = await Promise.allSettled(
      resources.map((resource) => deleteTestResourceAndWait(resource, kubeConfig, 60_000))
    );
    failures.push(
      ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to clean Helm hook resources in ${namespace}`);
  }
}

/**
 * Delete only Secrets explicitly named by the test or owned by one exact
 * cert-manager Certificate. This runs after the Certificate factory teardown.
 */
export async function deleteTestCertificateSecrets(
  namespace: string,
  certificateName: string,
  explicitSecretNames: readonly string[],
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const secrets = await coreApi.listNamespacedSecret({ namespace });
  const explicitNames = new Set(explicitSecretNames);
  const matchingNames = secrets.items.flatMap((secret) => {
    const name = secret.metadata?.name;
    if (!name) return [];
    const ownedByCertificate = secret.metadata?.ownerReferences?.some(
      (owner) =>
        owner.apiVersion === 'cert-manager.io/v1' &&
        owner.kind === 'Certificate' &&
        owner.name === certificateName
    );
    return explicitNames.has(name) || ownedByCertificate ? [name] : [];
  });

  const cleanupErrors: unknown[] = [];
  for (const name of matchingNames) {
    try {
      await deleteTestSecretAndWait(namespace, name, kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Failed to clean up Secrets generated for Certificate ${namespace}/${certificateName}`
    );
  }
}

/**
 * Delete ACME account Secrets a test-local cert-manager controller generated
 * for live ClusterIssuers. The target names come from the issuer specs rather
 * than a broad Secret selector, and deletion remains UID-preconditioned.
 */
export async function deleteTestClusterIssuerAccountSecrets(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
  const response = (await customApi.listClusterCustomObject({
    group: 'cert-manager.io',
    version: 'v1',
    plural: 'clusterissuers',
  })) as unknown as {
    items?: Array<{
      spec?: {
        acme?: {
          privateKeySecretRef?: {
            name?: unknown;
          };
        };
      };
    }>;
  };
  const secretNames = new Set(
    (response.items ?? []).flatMap((issuer) => {
      const name = issuer.spec?.acme?.privateKeySecretRef?.name;
      return typeof name === 'string' && name.length > 0 ? [name] : [];
    })
  );

  const cleanupResults = await Promise.allSettled(
    [...secretNames].map((name) => deleteTestSecretAndWait(namespace, name, kubeConfig))
  );
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Failed to clean ClusterIssuer ACME account Secrets in ${namespace}`
    );
  }
}

/**
 * Delete controller-generated artifacts left after uninstalling one
 * cert-manager release from a test-owned namespace.
 */
export async function deleteTestCertManagerControllerArtifacts(
  namespace: string,
  releaseName: string,
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  const leases = (await objectApi.list(
    'coordination.k8s.io/v1',
    'Lease',
    namespace
  )) as unknown as {
    items?: Array<{ metadata?: { name?: string } }>;
  };
  const leaseNames = (leases.items ?? []).flatMap((lease) => {
    const name = lease.metadata?.name;
    return name?.startsWith('cert-manager-') ? [name] : [];
  });

  const cleanupTasks: Promise<void>[] = [
    cleanupCertManagerWebhooks(releaseName, kubeConfig),
    deleteTestSecretAndWait(namespace, `${releaseName}-webhook-ca`, kubeConfig),
    deleteTestSecretAndWait(namespace, `${releaseName}-cert-manager-webhook-ca`, kubeConfig),
    deleteTestClusterIssuerAccountSecrets(namespace, kubeConfig),
    ...leaseNames.map((name) =>
      deleteTestResourceAndWait(
        {
          apiVersion: 'coordination.k8s.io/v1',
          kind: 'Lease',
          metadata: { namespace, name },
        },
        kubeConfig
      )
    ),
  ];
  const cleanupResults = await Promise.allSettled(cleanupTasks);
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Failed to clean cert-manager controller artifacts in ${namespace}`
    );
  }
}

export async function waitForResourceAbsent(
  resource: ResourceIdentity,
  kc?: k8s.KubeConfig,
  timeoutMs = 30_000
): Promise<void> {
  const objectApi = createKubernetesObjectApiClient(kc);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await objectApi.read(resource);
    } catch (error: unknown) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    await Bun.sleep(1_000);
  }

  const namespace = resource.metadata.namespace
    ? ` in namespace ${resource.metadata.namespace}`
    : '';
  throw new ResourceDeletionTimeoutError(
    `Timed out after ${timeoutMs}ms waiting for ${resource.kind}/${resource.metadata.name}${namespace} to be deleted`
  );
}

/**
 * Prove an exact fixture resource is absent before a test is allowed to
 * create it. Fixed-name cluster fixtures must fail closed rather than delete
 * an object that may belong to another stack.
 */
export async function assertTestResourceAbsent(
  resource: ResourceIdentity,
  kc?: k8s.KubeConfig
): Promise<void> {
  const objectApi = createKubernetesObjectApiClient(kc);
  try {
    const live = await objectApi.read(resource);
    const qualifiedName = resource.metadata.namespace
      ? `${resource.metadata.namespace}/${resource.metadata.name}`
      : resource.metadata.name;
    throw new Error(
      `Refusing to adopt existing ${resource.kind} ${qualifiedName} (uid ${live.metadata?.uid ?? 'unknown'})`
    );
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

/**
 * Delete a test-owned generated CRD after proving no custom resources remain.
 * OrbStack can occasionally leave the standard apiextensions cleanup finalizer
 * pending even after the CRD is empty, so the narrowly bounded recovery below
 * removes only that known finalizer.
 */
export async function deleteGeneratedCrdAndWait(
  crd: ResourceIdentity,
  instanceApiVersion: string,
  instanceKind: string,
  kc?: k8s.KubeConfig,
  gracefulTimeoutMs = 30_000,
  recoveryTimeoutMs = 60_000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const objectApi = createKubernetesObjectApiClient(kubeConfig);

  try {
    await objectApi.delete(crd);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  try {
    await waitForResourceAbsent(crd, kubeConfig, gracefulTimeoutMs);
    return;
  } catch (error: unknown) {
    if (!(error instanceof ResourceDeletionTimeoutError)) throw error;
  }

  let remainingInstances: Awaited<ReturnType<typeof objectApi.list>>;
  try {
    remainingInstances = await objectApi.list(instanceApiVersion, instanceKind);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  if (remainingInstances.items.length > 0) {
    throw new Error(
      `Refusing CRD finalizer recovery for ${crd.metadata.name}: ${remainingInstances.items.length} instance(s) remain`
    );
  }

  let liveCrd: Awaited<ReturnType<typeof objectApi.read>>;
  try {
    liveCrd = await objectApi.read(crd);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  if (!liveCrd.metadata?.deletionTimestamp) {
    throw new Error(
      `Refusing CRD finalizer recovery for ${crd.metadata.name}: deletion was not accepted`
    );
  }
  const finalizers = liveCrd.metadata.finalizers ?? [];
  if (finalizers.some((finalizer) => finalizer !== 'customresourcecleanup.apiextensions.k8s.io')) {
    throw new Error(
      `Refusing CRD finalizer recovery for ${crd.metadata.name}: unexpected finalizers ${finalizers.join(', ')}`
    );
  }

  console.warn(
    `Recovering test-owned CRD ${crd.metadata.name} after its empty custom-resource cleanup finalizer remained pending`
  );
  const apiextensionsApi = createBunCompatibleApiextensionsV1Api(kubeConfig);
  await apiextensionsApi.patchCustomResourceDefinition({
    name: crd.metadata.name,
    body: [{ op: 'replace', path: '/metadata/finalizers', value: [] }],
  });
  await waitForResourceAbsent(crd, kubeConfig, recoveryTimeoutMs);
}

/**
 * Delete a test namespace and recover only the known empty-namespace
 * Kubernetes finalizer stall observed on persistent OrbStack clusters.
 */
export async function deleteTestNamespaceAndWait(
  lease: TestNamespaceLease,
  kc?: k8s.KubeConfig,
  gracefulTimeoutMs = 5_000,
  recoveryTimeoutMs = MIN_TEST_NAMESPACE_CONTROLLER_DRAIN_TIMEOUT_MS,
  inventory?: NamespaceInventory
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const namespace = lease.name;
  const coreApi = createCoreV1ApiClient(kubeConfig);
  let namespaceBeforeDelete: Awaited<ReturnType<typeof coreApi.readNamespace>>;
  try {
    namespaceBeforeDelete = await coreApi.readNamespace({ name: namespace });
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      testNamespaceLeases.delete(namespace);
      return;
    }
    throw error;
  }
  assertTestNamespaceLease(namespaceBeforeDelete, lease);

  try {
    await deleteNamespaceWithUidAndWait(namespace, lease.uid, kubeConfig, gracefulTimeoutMs);
    return;
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith(`Timed out after ${gracefulTimeoutMs}ms`)
    ) {
      throw error;
    }
  }

  let liveNamespace: Awaited<ReturnType<typeof coreApi.readNamespace>>;
  try {
    liveNamespace = await coreApi.readNamespace({ name: namespace });
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      testNamespaceLeases.delete(namespace);
      return;
    }
    throw error;
  }
  assertTestNamespaceLease(liveNamespace, lease);
  if (!liveNamespace.metadata?.deletionTimestamp) {
    throw new Error(
      `Refusing namespace finalizer recovery for ${namespace}: deletion was not accepted`
    );
  }
  const finalizers = liveNamespace.spec?.finalizers ?? [];
  if (finalizers.some((finalizer) => finalizer !== 'kubernetes')) {
    throw new Error(
      `Refusing namespace finalizer recovery for ${namespace}: unexpected finalizers ${finalizers.join(', ')}`
    );
  }
  await waitForTestNamespaceEmpty(
    namespace,
    inventory ?? createClusterNamespaceInventory(kubeConfig),
    recoveryTimeoutMs
  );

  console.warn(
    `Recovering empty test namespace ${namespace} after its Kubernetes finalizer remained pending`
  );
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      liveNamespace = await coreApi.readNamespace({ name: namespace });
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        testNamespaceLeases.delete(namespace);
        return;
      }
      throw error;
    }
    assertTestNamespaceLease(liveNamespace, lease);
    if (!liveNamespace.metadata?.deletionTimestamp) {
      throw new Error(
        `Refusing namespace finalizer recovery for ${namespace}: deletion was no longer pending`
      );
    }
    const currentFinalizers = liveNamespace.spec?.finalizers ?? [];
    if (currentFinalizers.some((finalizer) => finalizer !== 'kubernetes')) {
      throw new Error(
        `Refusing namespace finalizer recovery for ${namespace}: unexpected finalizers ${currentFinalizers.join(', ')}`
      );
    }
    try {
      await coreApi.replaceNamespaceFinalize({
        name: namespace,
        body: {
          ...liveNamespace,
          spec: {
            ...liveNamespace.spec,
            finalizers: [],
          },
        },
      });
      break;
    } catch (error: unknown) {
      if (!isConflictError(error) || attempt === 5) throw error;
      await Bun.sleep(attempt * 100);
    }
  }
  await waitForResourceAbsent(
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace },
    },
    kubeConfig,
    recoveryTimeoutMs
  );
  testNamespaceLeases.delete(namespace);
}

/**
 * Exercise normal factory teardown first. The only accepted incomplete result
 * is a terminating, empty Namespace covered by a captured test lease. Recover
 * that known Kubernetes finalizer stall, then retry so retained KRO definitions
 * and other lifecycle records are also proven gone.
 */
export async function deleteTestFactoryInstanceAndRecoverNamespaces(
  factory: TestDeletableFactory,
  instanceName: string,
  namespaceLeases: readonly TestNamespaceLease[],
  kc?: k8s.KubeConfig,
  timeoutMs = 30_000,
  deleteOptions: Omit<ResourceFactoryDeleteOptions, 'timeout'> = {}
): Promise<ResourceDeletionResult> {
  const leasedNames = new Set(namespaceLeases.map((lease) => lease.name));
  const kubeConfig = namespaceLeases.length > 0 ? kc || getIntegrationTestKubeConfig() : undefined;
  // StatefulSet and operator descendants can outlive their parent briefly after
  // normal factory teardown, especially on a persistent OrbStack cluster. Give
  // Kubernetes a bounded controller-drain window without deleting those children
  // from the harness. Finalizer recovery still requires a proven-empty namespace.
  const namespaceDrainTimeoutMs = Math.max(
    timeoutMs,
    MIN_TEST_NAMESPACE_CONTROLLER_DRAIN_TIMEOUT_MS
  );
  let namespaceRecoveryPerformed = false;
  let attempts = 0;
  let result: ResourceDeletionResult;

  while (true) {
    attempts += 1;
    result = await factory.deleteInstance(instanceName, {
      ...deleteOptions,
      timeout: timeoutMs,
    });
    if (result.status === 'complete') break;

    const unrelatedRemaining = result.remaining.filter(
      (resource) => resource.kind !== 'Namespace' || !leasedNames.has(resource.name)
    );
    const unrelatedBlockers = result.blockers.filter((blocker) => {
      if (blocker.resource) {
        return blocker.resource.kind !== 'Namespace' || !leasedNames.has(blocker.resource.name);
      }
      return !namespaceLeases.some(
        (lease) =>
          blocker.message.includes(`namespace ${lease.name}`) ||
          blocker.message.includes(`Namespace ${lease.name}`)
      );
    });

    if (unrelatedRemaining.length > 0 || unrelatedBlockers.length > 0) {
      const canRetry =
        attempts < 3 &&
        result.retry.safe &&
        unrelatedBlockers.every((blocker) => blocker.retryable);
      if (canRetry) {
        await Bun.sleep(Math.min(Math.max(result.retry.afterMs ?? 1_000, 0), 5_000));
        continue;
      }
      throw new Error(
        `Factory deletion for ${instanceName} was incomplete for reasons other than a leased Namespace finalizer: ${JSON.stringify(
          {
            status: result.status,
            remaining: unrelatedRemaining,
            blockers: unrelatedBlockers,
            attempts,
          }
        )}`
      );
    }
    if (namespaceLeases.length === 0) {
      throw new Error(
        `Factory deletion for ${instanceName} was incomplete and no test-owned Namespace lease was available for recovery`
      );
    }
    if (namespaceRecoveryPerformed) {
      throw new Error(
        `Factory deletion for ${instanceName} remained ${result.status} after leased Namespace recovery: ${JSON.stringify(
          {
            remaining: result.remaining,
            blockers: result.blockers,
            attempts,
          }
        )}`
      );
    }

    for (const lease of namespaceLeases) {
      await deleteTestNamespaceAndWait(lease, kubeConfig, 5_000, namespaceDrainTimeoutMs);
    }
    namespaceRecoveryPerformed = true;
  }

  for (const lease of namespaceLeases) {
    // A factory may report complete after issuing Namespace deletion while the
    // Kubernetes namespace controller is still finalizing it. Route final
    // verification through the lease-guarded helper so a known empty-namespace
    // stall is recovered without broad or identity-free cleanup.
    await deleteTestNamespaceAndWait(lease, kubeConfig, 5_000, namespaceDrainTimeoutMs);
  }
  return result;
}

/**
 * Check if a Kubernetes cluster is available for testing
 */
export async function isClusterAvailable(): Promise<boolean> {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    if (!kc.getCurrentCluster()) return false;
    const coreApi = createBunCompatibleCoreV1Api(kc, { default: 5_000 });
    await coreApi.readNamespace({ name: 'default' });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Check if the Kro controller is healthy and ready
 */
export async function isKroControllerHealthy(): Promise<boolean> {
  try {
    const kc = getIntegrationTestKubeConfig();
    const appsApi = createAppsV1ApiClient(kc);

    // Check if Kro deployment exists and is ready
    const deployment = await appsApi.readNamespacedDeployment({
      name: 'kro',
      namespace: 'kro-system',
    });
    const status = deployment.status;

    return status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0;
  } catch (error) {
    console.warn('Kro controller health check failed:', error);
    // Don't fail the test if health check fails, just warn
    return true; // Assume healthy to avoid blocking tests
  }
}

/** Ensure a shared prerequisite namespace exists; this helper never owns or deletes it. */
export async function ensureSharedPrerequisiteNamespace(
  namespace: string,
  kc: k8s.KubeConfig
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kc);
  try {
    await coreApi.readNamespace({ name: namespace });
    return;
  } catch (error: unknown) {
    if (!isNotFoundError(error)) throw error;
  }

  try {
    await coreApi.createNamespace({ body: { metadata: { name: namespace } } });
  } catch (error: unknown) {
    const candidate = error as { body?: { reason?: string }; statusCode?: number; code?: number };
    if (
      candidate.body?.reason !== 'AlreadyExists' &&
      candidate.statusCode !== 409 &&
      candidate.code !== 409
    ) {
      throw error;
    }
  }
}

/**
 * Create a namespace exclusively owned by the current test run.
 *
 * This fails when the name already exists and returns a UID lease that strict
 * cleanup must present before deleting it.
 */
export async function createTestNamespace(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<TestNamespaceLease> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);

  try {
    const created = await coreApi.createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: {
            [TYPEKRO_TEST_NAMESPACE_LABEL]: 'owned',
          },
        },
      },
    });
    const uid = created.metadata?.uid;
    if (!uid) {
      throw new Error(`Created test namespace ${namespace} did not return metadata.uid`);
    }
    const lease = { name: namespace, uid };
    testNamespaceLeases.set(namespace, lease);
    console.log(`📦 Created test namespace: ${namespace}`);
    return lease;
  } catch (error: unknown) {
    const candidate = error as {
      body?: { code?: number; reason?: string };
      code?: number;
      statusCode?: number;
    };
    const status = candidate.statusCode ?? candidate.code ?? candidate.body?.code;
    if (candidate.body?.reason === 'AlreadyExists' || status === 409) {
      throw new Error(
        `Refusing to adopt existing namespace ${namespace} for an exclusive integration test`
      );
    }
    throw error;
  }
}

/** Fail setup if a composition-owned test namespace already exists. */
export async function assertTestNamespaceAbsent(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<void> {
  const coreApi = createCoreV1ApiClient(kc);
  try {
    await coreApi.readNamespace({ name: namespace });
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  throw new Error(
    `Refusing to run an exclusive integration test because namespace ${namespace} already exists`
  );
}

/**
 * Capture the immutable UID of a namespace whose absence was proven at setup
 * and which the composition subsequently created. Call this immediately after
 * successful creation and retain the lease through teardown; never reacquire a
 * lease during cleanup.
 */
export async function captureTestNamespaceLease(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<TestNamespaceLease | undefined> {
  const coreApi = createCoreV1ApiClient(kc);
  try {
    const live = await coreApi.readNamespace({ name: namespace });
    const uid = live.metadata?.uid;
    if (!uid) throw new Error(`Test namespace ${namespace} has no metadata.uid`);
    const lease = { name: namespace, uid };
    testNamespaceLeases.set(namespace, lease);
    return lease;
  } catch (error: unknown) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * Run an operation that is expected to create test-owned Namespaces.
 *
 * Absence is proven before the operation. Every Namespace that exists after
 * the attempt has its UID retained, even when the operation throws, so partial
 * deployments remain safely recoverable. A successful operation must create
 * every expected Namespace.
 */
export async function runWithExpectedTestNamespaces<T>(
  namespaces: readonly string[],
  kc: k8s.KubeConfig,
  retainLease: (lease: TestNamespaceLease) => void,
  operation: () => Promise<T>
): Promise<T> {
  await Promise.all(namespaces.map((namespace) => assertTestNamespaceAbsent(namespace, kc)));

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  const captureResults = await Promise.allSettled(
    namespaces.map((namespace) => captureTestNamespaceLease(namespace, kc))
  );
  const captureErrors: unknown[] = [];
  const missingAfterSuccess: string[] = [];
  captureResults.forEach((capture, index) => {
    if (capture.status === 'rejected') {
      captureErrors.push(capture.reason);
      return;
    }
    if (capture.value) {
      retainLease(capture.value);
    } else if (operationError === undefined) {
      missingAfterSuccess.push(namespaces[index] ?? '<unknown>');
    }
  });

  if (missingAfterSuccess.length > 0) {
    captureErrors.push(
      new Error(
        `Operation completed without creating expected test namespace(s): ${missingAfterSuccess.join(', ')}`
      )
    );
  }
  if (operationError !== undefined) {
    if (captureErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...captureErrors],
        'Operation failed and test namespace ownership could not be retained'
      );
    }
    throw operationError;
  }
  if (captureErrors.length > 0) {
    throw new AggregateError(captureErrors, 'Failed to retain expected test namespace ownership');
  }
  return result as T;
}

/** Single-Namespace convenience wrapper for runWithExpectedTestNamespaces. */
export async function runWithExpectedTestNamespace<T>(
  namespace: string,
  kc: k8s.KubeConfig,
  retainLease: (lease: TestNamespaceLease) => void,
  operation: () => Promise<T>
): Promise<T> {
  return runWithExpectedTestNamespaces([namespace], kc, retainLease, operation);
}

export interface NamespaceDeletionClient {
  deleteNamespace(request: {
    name: string;
    body?: { preconditions?: { uid?: string } };
  }): Promise<unknown>;
}

/**
 * Initiate deletion of one immutable namespace lease.
 *
 * Child resources are deliberately not mutated here. Factory teardown must
 * remove graph-owned resources, and the namespace controller owns ordinary
 * namespace cascading. Any remaining child blocks fail-closed finalizer
 * recovery with exact resource evidence.
 */
export async function initiateNamespaceDeletion(
  coreApi: NamespaceDeletionClient,
  namespace: string,
  expectedUid: string
): Promise<void> {
  await coreApi.deleteNamespace({
    name: namespace,
    body: { preconditions: { uid: expectedUid } },
  });
  console.log(`🗑️ Initiated deletion of test namespace: ${namespace}`);
}

/** Delete one exact namespace UID and wait for full removal. */
async function deleteNamespaceWithUidAndWait(
  namespace: string,
  expectedUid: string,
  kc?: k8s.KubeConfig,
  timeoutMs = 600000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const startTime = Date.now();

  try {
    await initiateNamespaceDeletion(coreApi, namespace, expectedUid);
  } catch (error: any) {
    // If namespace doesn't exist, we're done
    if (isNotFoundError(error)) {
      console.log(`📦 Test namespace ${namespace} already deleted`);
      testNamespaceLeases.delete(namespace);
      return;
    }
    // An initiation failure is not evidence that cleanup is in progress. Surface
    // it so a green integration run can never leave an active namespace behind.
    throw new Error(
      `Failed to initiate deletion of test namespace ${namespace}: ${error.message}`,
      {
        cause: error,
      }
    );
  }

  // Wait for namespace to be fully deleted
  while (Date.now() - startTime < timeoutMs) {
    try {
      await coreApi.readNamespace({ name: namespace });
      // Namespace still exists, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error: any) {
      // 404 means namespace is deleted
      if (isNotFoundError(error)) {
        console.log(`✅ Test namespace ${namespace} fully deleted`);
        testNamespaceLeases.delete(namespace);
        return;
      }
      // Other errors, log and continue waiting
      console.warn(`⚠️ Error checking namespace status: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for test namespace ${namespace} to be deleted`
  );
}

// =============================================================================
// CONFLICT HANDLING UTILITIES
// =============================================================================

/**
 * Strategy for handling resource conflicts (409 AlreadyExists errors)
 * - 'warn': Log warning and return existing resource (default)
 * - 'fail': Throw error on conflict
 * - 'patch': Attempt to patch the existing resource
 * - 'replace': Delete and recreate the resource
 */
export type ConflictStrategy = 'warn' | 'fail' | 'patch' | 'replace';

/**
 * Options for creating resources with conflict handling
 */
export interface CreateResourceOptions {
  /** Strategy for handling 409 conflicts (default: 'warn') */
  conflictStrategy?: ConflictStrategy;
  /** Whether to log operations (default: true) */
  verbose?: boolean;
}

/**
 * Create a Kubernetes resource with conflict handling
 * This wraps k8sApi.create() with proper 409 error handling
 *
 * @param k8sApi - The KubernetesObjectApi client
 * @param resource - The resource to create (can be a proxy with toJSON method)
 * @param options - Options for conflict handling
 * @returns The created or existing resource
 */
export async function createResourceWithConflictHandling<T extends k8s.KubernetesObject>(
  k8sApi: k8s.KubernetesObjectApi,
  resource: T | { toJSON?: () => T },
  options: CreateResourceOptions = {}
): Promise<T> {
  const { conflictStrategy = 'warn', verbose = true } = options;

  // Convert proxy to plain object if needed
  const resourceJson = (
    typeof (resource as any).toJSON === 'function' ? (resource as any).toJSON() : resource
  ) as T;

  const resourceName = resourceJson.metadata?.name || 'unknown';
  const resourceKind = resourceJson.kind || 'Unknown';
  const resourceNamespace = resourceJson.metadata?.namespace;

  try {
    const created = await k8sApi.create(resourceJson);
    if (verbose) {
      console.log(
        `✅ Created ${resourceKind}/${resourceName}${resourceNamespace ? ` in ${resourceNamespace}` : ''}`
      );
    }
    return created as T;
  } catch (error: any) {
    // Check for 409 Conflict errors
    const is409 =
      error.statusCode === 409 ||
      error.response?.statusCode === 409 ||
      error.body?.code === 409 ||
      (typeof error.message === 'string' && error.message.includes('HTTP-Code: 409'));

    if (!is409) {
      throw error;
    }

    // Handle based on conflict strategy
    switch (conflictStrategy) {
      case 'fail':
        throw new Error(
          `Resource ${resourceKind}/${resourceName} already exists${resourceNamespace ? ` in namespace '${resourceNamespace}'` : ''}`
        );

      case 'warn':
        if (verbose) {
          console.log(`⚠️ ${resourceKind}/${resourceName} already exists, using existing resource`);
        }
        // Fetch and return the existing resource
        return (await k8sApi.read({
          apiVersion: resourceJson.apiVersion!,
          kind: resourceJson.kind!,
          metadata: {
            name: resourceName,
            namespace: resourceNamespace || 'default',
          },
        })) as T;

      case 'patch':
        if (verbose) {
          console.log(`🔄 ${resourceKind}/${resourceName} already exists, patching...`);
        }
        return (await k8sApi.patch(resourceJson)) as T;

      case 'replace':
        if (verbose) {
          console.log(`🔄 ${resourceKind}/${resourceName} already exists, replacing...`);
        }
        // Delete and recreate
        await k8sApi.delete({
          apiVersion: resourceJson.apiVersion!,
          kind: resourceJson.kind!,
          metadata: {
            name: resourceName,
            namespace: resourceNamespace || 'default',
          },
        });
        // Wait a moment for deletion to propagate
        await new Promise((resolve) => setTimeout(resolve, 500));
        return (await k8sApi.create(resourceJson)) as T;

      default:
        throw new Error(`Unknown conflict strategy: ${conflictStrategy}`);
    }
  }
}

/**
 * Delete a resource if it exists, ignoring 404 errors
 * Useful for cleanup in tests
 */
export async function deleteResourceIfExists(
  k8sApi: k8s.KubernetesObjectApi,
  resource:
    | k8s.KubernetesObject
    | { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } },
  verbose = true
): Promise<boolean> {
  const resourceName = resource.metadata?.name || 'unknown';
  const resourceKind = resource.kind || 'Unknown';
  const resourceNamespace = resource.metadata?.namespace;

  try {
    await k8sApi.delete({
      apiVersion: resource.apiVersion!,
      kind: resource.kind!,
      metadata: {
        name: resourceName,
        namespace: resourceNamespace || 'default',
      },
    });
    if (verbose) {
      console.log(
        `🗑️ Deleted ${resourceKind}/${resourceName}${resourceNamespace ? ` from ${resourceNamespace}` : ''}`
      );
    }
    return true;
  } catch (error: any) {
    // Ignore 404 errors
    if (error.statusCode === 404 || error.body?.code === 404 || error.body?.reason === 'NotFound') {
      if (verbose) {
        console.log(`📦 ${resourceKind}/${resourceName} not found, nothing to delete`);
      }
      return false;
    }
    throw error;
  }
}

// =============================================================================
// INFRASTRUCTURE ENSURE UTILITIES
// =============================================================================

/**
 * Check if cert-manager is installed and ready in a specific namespace
 */
async function isCertManagerReady(
  namespace = 'cert-manager',
  kc?: k8s.KubeConfig
): Promise<boolean> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const appsApi = createAppsV1ApiClient(kubeConfig);

  try {
    // Check if the cert-manager controller deployment exists and is ready
    const deployment = await appsApi.readNamespacedDeployment({
      name: 'cert-manager',
      namespace,
    });

    const status = deployment.status;
    return status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0;
  } catch (error: any) {
    if (error.statusCode === 404 || error.body?.code === 404) {
      return false;
    }
    // For other errors, log but don't fail - assume not ready
    console.warn('Error checking cert-manager readiness:', error.message);
    return false;
  }
}

/**
 * Clean up cert-manager webhook configurations created by test installations.
 *
 * When cert-manager is deployed to a test namespace (e.g., 'nested-test-cm'),
 * it creates cluster-scoped MutatingWebhookConfiguration and ValidatingWebhookConfiguration
 * resources. If the test namespace is deleted without cleaning up these webhooks,
 * they will intercept all cert-manager resource creation (Certificates, ClusterIssuers, etc.)
 * and route to the now-deleted webhook service, causing HTTP 500 errors.
 *
 * The cert-manager Helm chart names webhooks based on its fullname template:
 * - If release name contains "cert-manager": webhook = `{releaseName}-webhook`
 * - Otherwise: webhook = `{releaseName}-cert-manager-webhook`
 *
 * This function tries both patterns to ensure cleanup.
 *
 * @param releaseName The Helm release name used for cert-manager (e.g., 'nested-test-cm')
 * @param kc KubeConfig to use
 */
export async function cleanupCertManagerWebhooks(
  releaseName: string,
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const k8sApi = createKubernetesObjectApiClient(kubeConfig);
  const cleanupErrors: unknown[] = [];

  // The cert-manager chart's fullname template produces different names depending
  // on whether the release name contains "cert-manager"
  const webhookNames = releaseName.includes('cert-manager')
    ? [`${releaseName}-webhook`]
    : [`${releaseName}-cert-manager-webhook`, `${releaseName}-webhook`];

  for (const webhookName of webhookNames) {
    for (const kind of ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration']) {
      try {
        await k8sApi.delete({
          apiVersion: 'admissionregistration.k8s.io/v1',
          kind,
          metadata: { name: webhookName },
        });
        console.log(`🗑️ Deleted ${kind}/${webhookName}`);
      } catch (error: unknown) {
        if (!isNotFoundError(error)) cleanupErrors.push(error);
      }
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Failed to clean up cert-manager webhooks for release ${releaseName}`
    );
  }
}

/**
 * Options for ensuring cert-manager is installed
 */
export interface EnsureCertManagerOptions {
  /** Namespace to install cert-manager in (default: 'cert-manager') */
  namespace?: string;
  /** Cert-manager version (default: '1.19.3') */
  version?: string;
  /** Timeout for waiting for cert-manager to be ready (default: 300000ms) */
  timeout?: number;
  /** KubeConfig to use */
  kubeConfig?: k8s.KubeConfig;
  /** Whether to log verbose output (default: true) */
  verbose?: boolean;
}

/**
 * Ensure cert-manager is installed and ready
 *
 * This is an idempotent operation that:
 * - Checks if cert-manager is already running and ready
 * - If not, deploys cert-manager using the bootstrap composition with installCRDs: true
 * - Waits for cert-manager to be ready before returning
 * - Can be called multiple times safely
 *
 * CRDs are installed by the Helm chart (installCRDs: true) as part of the HelmRelease.
 * Tests that deploy additional cert-manager instances to test-specific namespaces should
 * use installCRDs: false to avoid CRD ownership conflicts, and must NEVER call
 * deleteInstance() on the shared cert-manager installation.
 *
 * @example
 * ```typescript
 * beforeAll(async () => {
 *   await ensureCertManagerInstalled({ namespace: 'cert-manager' });
 * });
 * ```
 */
export async function ensureCertManagerInstalled(
  options: EnsureCertManagerOptions = {}
): Promise<void> {
  const {
    namespace = 'cert-manager',
    version = '1.19.3',
    timeout = 300000,
    kubeConfig,
    verbose = true,
  } = options;

  const kc = kubeConfig || getIntegrationTestKubeConfig();

  // Check if cert-manager is already ready
  if (verbose) {
    console.log('Checking if cert-manager is already installed...');
  }

  const isReady = await isCertManagerReady(namespace, kc);

  if (isReady) {
    if (verbose) {
      console.log(`Cert-manager already installed and ready in namespace '${namespace}'`);
    }
    return;
  }

  // Deploy cert-manager via the bootstrap composition.
  // installCRDs: true tells the Helm chart to include CRD manifests in the release.
  // The HelmRelease factory hardcodes installCRDs: true, so CRDs are always installed.
  if (verbose) {
    console.log(`Deploying cert-manager ${version} to namespace '${namespace}'...`);
  }

  const { certManagerBootstrap } = await import(
    '../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js'
  );

  await ensureSharedPrerequisiteNamespace(namespace, kc);

  const factory = certManagerBootstrap.factory('direct', {
    namespace,
    timeout,
    waitForReady: true,
    kubeConfig: kc,
  });

  await factory.deploy({
    name: 'cert-manager',
    namespace,
    version,
    installCRDs: true,
    // Disable startupapicheck to avoid post-install hook timeouts.
    // The startupapicheck job validates the webhook API, but it often times out
    // in CI/test environments due to slow pod scheduling. Instead, we rely on
    // the HelmRelease readiness check which validates the same thing.
    startupapicheck: { enabled: false },
  });

  if (verbose) {
    console.log(`Cert-manager ${version} deployed and ready in namespace '${namespace}'`);
  }
}

/**
 * Check if Flux controllers are installed and ready
 */
async function isFluxReady(namespace = 'flux-system', kc?: k8s.KubeConfig): Promise<boolean> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const appsApi = createAppsV1ApiClient(kubeConfig);

  try {
    // Check key Flux controllers
    const controllers = ['source-controller', 'helm-controller', 'kustomize-controller'];

    for (const controller of controllers) {
      const deployment = await appsApi.readNamespacedDeployment({
        name: controller,
        namespace,
      });

      const status = deployment.status;
      const isControllerReady =
        status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0;

      if (!isControllerReady) {
        return false;
      }
    }

    return true;
  } catch (error: any) {
    if (error.statusCode === 404 || error.body?.code === 404) {
      return false;
    }
    console.warn('Error checking Flux readiness:', error.message);
    return false;
  }
}

/**
 * Options for ensuring Flux is installed
 */
export interface EnsureFluxOptions {
  /** Namespace to install Flux in (default: 'flux-system') */
  namespace?: string;
  /** Flux version (default: 'v2.7.5') */
  version?: string;
  /** Timeout for waiting for Flux to be ready (default: 300000ms) */
  timeout?: number;
  /** KubeConfig to use */
  kubeConfig?: k8s.KubeConfig;
  /** Whether to log verbose output (default: true) */
  verbose?: boolean;
}

/**
 * Ensure Flux controllers are installed and ready
 *
 * This is an idempotent operation that:
 * - Checks if Flux is already running and ready
 * - If not, deploys Flux using the runtime bootstrap
 * - Waits for Flux to be ready before returning
 * - Can be called multiple times safely
 */
export async function ensureFluxInstalled(options: EnsureFluxOptions = {}): Promise<void> {
  const {
    namespace = 'flux-system',
    version = 'v2.7.5',
    timeout = 300000,
    kubeConfig,
    verbose = true,
  } = options;

  const kc = kubeConfig || getIntegrationTestKubeConfig();

  // Check if Flux is already ready
  if (verbose) {
    console.log('🔍 Checking if Flux is already installed...');
  }

  const isReady = await isFluxReady(namespace, kc);

  if (isReady) {
    if (verbose) {
      console.log(`✅ Flux already installed and ready in namespace '${namespace}'`);
    }
    return;
  }

  // Deploy Flux (via TypeKro runtime bootstrap)
  if (verbose) {
    console.log(`📦 Deploying Flux ${version} to namespace '${namespace}'...`);
  }

  const { typeKroRuntimeBootstrap } = await import('../../src/index.js');

  // typeKroRuntimeBootstrap is a function that returns a composition
  const runtimeComposition = typeKroRuntimeBootstrap({
    namespace,
    fluxVersion: version,
    kroVersion: '0.9.2',
  });

  const factory = runtimeComposition.factory('direct', {
    namespace,
    timeout,
    waitForReady: true,
    kubeConfig: kc,
  });

  await factory.deploy({
    namespace,
  });

  if (verbose) {
    console.log(`✅ Flux ${version} deployed and ready in namespace '${namespace}'`);
  }
}

// =============================================================================
// APISIX ENSURE UTILITY
// =============================================================================

/**
 * Check if APISIX is installed and ready
 */
async function isApisixReady(namespace = 'apisix-system', kc?: k8s.KubeConfig): Promise<boolean> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const appsApi = createAppsV1ApiClient(kubeConfig);

  try {
    // Check if the APISIX gateway deployment exists and is ready
    const deployments = await appsApi.listNamespacedDeployment({ namespace });
    const apisixDeployments = deployments.items.filter((d) => d.metadata?.name?.includes('apisix'));

    if (apisixDeployments.length === 0) {
      return false;
    }

    // All APISIX deployments must be ready
    for (const deployment of apisixDeployments) {
      const status = deployment.status;
      const isDeploymentReady =
        status?.readyReplicas === status?.replicas && (status?.replicas ?? 0) > 0;
      if (!isDeploymentReady) {
        return false;
      }
    }

    return true;
  } catch (error: any) {
    if (error.statusCode === 404 || error.body?.code === 404) {
      return false;
    }
    console.warn('Error checking APISIX readiness:', error.message);
    return false;
  }
}

/**
 * Options for ensuring APISIX is installed
 */
export interface EnsureApisixOptions {
  /** Namespace to install APISIX in (default: 'apisix-system') */
  namespace?: string;
  /** APISIX chart version (default: '2.13.0') */
  version?: string;
  /** Timeout for waiting for APISIX to be ready (default: 600000ms) */
  timeout?: number;
  /** KubeConfig to use */
  kubeConfig?: k8s.KubeConfig;
  /** Whether to log verbose output (default: true) */
  verbose?: boolean;
  /** Gateway service type (default: 'ClusterIP') */
  gatewayType?: 'NodePort' | 'LoadBalancer' | 'ClusterIP';
}

/**
 * Ensure APISIX ingress controller is installed and ready
 *
 * This is an idempotent operation that:
 * - Checks if APISIX is already running and ready
 * - If not, deploys APISIX using the apisixBootstrap composition
 * - Waits for APISIX to be ready before returning
 * - Can be called multiple times safely
 *
 * @example
 * ```typescript
 * beforeAll(async () => {
 *   await ensureApisixInstalled({ namespace: 'apisix-system' });
 * });
 * ```
 */
export async function ensureApisixInstalled(options: EnsureApisixOptions = {}): Promise<void> {
  const {
    namespace = 'apisix-system',
    version = '2.13.0',
    timeout = 600000,
    kubeConfig,
    verbose = true,
    gatewayType = 'NodePort',
  } = options;

  const kc = kubeConfig || getIntegrationTestKubeConfig();

  // Check if APISIX is already ready
  if (verbose) {
    console.log('Checking if APISIX is already installed...');
  }

  const isReady = await isApisixReady(namespace, kc);

  if (isReady) {
    if (verbose) {
      console.log(`APISIX already installed and ready in namespace '${namespace}'`);
    }
    return;
  }

  // Deploy APISIX via the bootstrap composition
  if (verbose) {
    console.log(`Deploying APISIX ${version} to namespace '${namespace}'...`);
  }

  const { apisixBootstrap } = await import(
    '../../src/factories/apisix/compositions/apisix-bootstrap.js'
  );

  const factory = apisixBootstrap.factory('direct', {
    namespace: 'flux-system', // HelmReleases go to flux-system
    timeout,
    waitForReady: true,
    hydrateStatus: false, // Composition status hydration has un-timed K8s API calls
    kubeConfig: kc,
  });

  await factory.deploy({
    name: 'apisix',
    namespace,
    version,
    replicaCount: 1,
    gateway: {
      type: gatewayType,
      http: { enabled: true, servicePort: 80 },
      https: { enabled: true, servicePort: 443 },
    },
    ingressController: {
      enabled: true,
      config: {
        kubernetes: {
          ingressClass: 'apisix',
        },
      },
    },
  });

  if (verbose) {
    console.log(`APISIX ${version} deployed and ready in namespace '${namespace}'`);
  }
}
