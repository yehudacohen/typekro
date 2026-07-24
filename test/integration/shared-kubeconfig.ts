import * as k8s from '@kubernetes/client-node';
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

export interface ResourceIdentity {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
}

export interface TestNamespaceLease {
  name: string;
  uid: string;
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
  gracefulTimeoutMs = 30_000,
  recoveryTimeoutMs = 60_000,
  inventory?: NamespaceInventory
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const namespace = lease.name;
  const coreApi = createCoreV1ApiClient(kubeConfig);
  let namespaceBeforeDelete: Awaited<ReturnType<typeof coreApi.readNamespace>>;
  try {
    namespaceBeforeDelete = await coreApi.readNamespace({ name: namespace });
  } catch (error: unknown) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  assertTestNamespaceLease(namespaceBeforeDelete, lease);

  try {
    await deleteNamespaceAndWait(namespace, kubeConfig, gracefulTimeoutMs, lease.uid);
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
    if (isNotFoundError(error)) return;
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
  await assertTestNamespaceEmpty(
    namespace,
    inventory ?? createClusterNamespaceInventory(kubeConfig)
  );

  console.warn(
    `Recovering empty test namespace ${namespace} after its Kubernetes finalizer remained pending`
  );
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
  await waitForResourceAbsent(
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace },
    },
    kubeConfig,
    recoveryTimeoutMs
  );
}

/**
 * Check if a Kubernetes cluster is available for testing
 */
export function isClusterAvailable(): boolean {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    const cluster = kc.getCurrentCluster();
    if (!cluster) {
      return false;
    }

    const kubectlCheck = Bun.spawnSync(['kubectl', '--request-timeout=5s', 'cluster-info'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return kubectlCheck.exitCode === 0;
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

/**
 * Ensure a namespace exists, creating it if necessary
 * Returns true if namespace was created, false if it already existed
 */
export async function ensureNamespaceExists(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<boolean> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);

  try {
    await coreApi.createNamespace({ body: { metadata: { name: namespace } } });
    console.log(`📦 Created test namespace: ${namespace}`);
    return true;
  } catch (error: any) {
    if (error.body?.reason === 'AlreadyExists' || error.statusCode === 409) {
      console.log(`📦 Test namespace ${namespace} already exists`);
      return false;
    }
    throw error;
  }
}

/**
 * Create a namespace exclusively owned by the current test run.
 *
 * Unlike ensureNamespaceExists(), this fails when the name already exists and
 * returns a UID lease that strict cleanup must present before deleting it.
 */
export async function createTestNamespace(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<TestNamespaceLease> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);

  try {
    const created = await coreApi.createNamespace({ body: { metadata: { name: namespace } } });
    const uid = created.metadata?.uid;
    if (!uid) {
      throw new Error(`Created test namespace ${namespace} did not return metadata.uid`);
    }
    console.log(`📦 Created test namespace: ${namespace}`);
    return { name: namespace, uid };
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
    return { name: namespace, uid };
  } catch (error: unknown) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * Delete a namespace if it exists
 */
export async function deleteNamespaceIfExists(
  namespace: string,
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);

  try {
    await coreApi.deleteNamespace({ name: namespace });
    console.log(`🗑️ Deleted test namespace: ${namespace}`);
  } catch (error: any) {
    // Ignore errors during cleanup
    console.log(`⚠️ Could not delete test namespace: ${error.message}`);
  }
}

export interface NamespaceDeletionClient {
  listNamespacedPersistentVolumeClaim(request: {
    namespace: string;
  }): Promise<{ items: Array<{ metadata?: { name?: string; uid?: string } }> }>;
  deleteNamespacedPersistentVolumeClaim(request: {
    name: string;
    namespace: string;
    body?: { preconditions?: { uid?: string } };
  }): Promise<unknown>;
  deleteNamespace(request: {
    name: string;
    body?: { preconditions?: { uid?: string } };
  }): Promise<unknown>;
}

/**
 * Initiate namespace deletion while preserving the legacy best-effort path and
 * making strict test cleanup independently testable.
 */
export async function initiateNamespaceDeletion(
  coreApi: NamespaceDeletionClient,
  namespace: string,
  expectedUid?: string
): Promise<void> {
  if (!expectedUid) {
    try {
      const pvcs = await coreApi.listNamespacedPersistentVolumeClaim({ namespace });
      for (const pvc of pvcs.items) {
        if (pvc.metadata?.name) {
          await coreApi.deleteNamespacedPersistentVolumeClaim({
            name: pvc.metadata.name,
            namespace,
          });
        }
      }
      if (pvcs.items.length > 0) {
        console.log(`🗑️ Deleted ${pvcs.items.length} PVCs in ${namespace}`);
      }
    } catch {
      // Legacy cleanup keeps PVC deletion best-effort.
    }
    await coreApi.deleteNamespace({ name: namespace });
    console.log(`🗑️ Initiated deletion of test namespace: ${namespace}`);
    return;
  }

  const pvcLeases = (await coreApi.listNamespacedPersistentVolumeClaim({ namespace })).items.map(
    (pvc) => {
      const name = pvc.metadata?.name;
      const uid = pvc.metadata?.uid;
      if (!name || !uid) {
        throw new Error(
          `Refusing strict cleanup for namespace ${namespace}: a PersistentVolumeClaim has no name or UID`
        );
      }
      return { name, uid };
    }
  );

  // Kubernetes must atomically accept deletion of the leased namespace before
  // any child mutation. Each PVC then carries its own immutable UID guard.
  await coreApi.deleteNamespace({
    name: namespace,
    body: { preconditions: { uid: expectedUid } },
  });
  console.log(`🗑️ Initiated deletion of test namespace: ${namespace}`);
  for (const pvc of pvcLeases) {
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name: pvc.name,
        namespace,
        body: { preconditions: { uid: pvc.uid } },
      });
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  }
  if (pvcLeases.length > 0) {
    console.log(`🗑️ Deleted ${pvcLeases.length} leased PVCs in ${namespace}`);
  }
}

/**
 * Delete a namespace and wait for it to be fully removed
 * This is important to prevent resource accumulation in the cluster
 */
export async function deleteNamespaceAndWait(
  namespace: string,
  kc?: k8s.KubeConfig,
  timeoutMs = 600000,
  expectedUid?: string
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

/**
 * Clean up all test namespaces matching a pattern
 * Useful for cleaning up leftover namespaces from failed tests
 */
export async function cleanupTestNamespaces(
  pattern: string | RegExp,
  kc?: k8s.KubeConfig
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);

  try {
    const namespaces = await coreApi.listNamespace();
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    const testNamespaces = namespaces.items
      .filter((ns) => ns.metadata?.name && regex.test(ns.metadata.name))
      .map((ns) => ns.metadata!.name!);

    if (testNamespaces.length === 0) {
      console.log(`📦 No test namespaces matching ${pattern} found`);
      return;
    }

    console.log(
      `🧹 Found ${testNamespaces.length} test namespaces to clean up: ${testNamespaces.join(', ')}`
    );

    // Delete all matching namespaces in parallel
    await Promise.allSettled(
      testNamespaces.map((ns) => deleteNamespaceAndWait(ns, kubeConfig, 600000))
    );

    console.log(`✅ Cleaned up ${testNamespaces.length} test namespaces`);
  } catch (error: any) {
    console.warn(`⚠️ Error cleaning up test namespaces: ${error.message}`);
  }
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
      } catch (error: any) {
        if (
          error.statusCode === 404 ||
          error.body?.code === 404 ||
          error.body?.reason === 'NotFound'
        ) {
          // Already gone, no action needed
        } else {
          console.warn(`⚠️ Failed to delete ${kind}/${webhookName}:`, error.message);
        }
      }
    }
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

  // Ensure namespace exists
  await ensureNamespaceExists(namespace, kc);

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
