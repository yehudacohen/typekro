import * as k8s from '@kubernetes/client-node';
import {
  createBunCompatibleCoreV1Api,
  createBunCompatibleAppsV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../../src/core/kubernetes/index.js';

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

    // Don't test connectivity here as it can cause TLS issues
    // Just check if we have a valid cluster configuration
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
    const deployment = await appsApi.readNamespacedDeployment({ name: 'kro', namespace: 'kro-system' });
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
export async function ensureNamespaceExists(namespace: string, kc?: k8s.KubeConfig): Promise<boolean> {
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
 * Delete a namespace if it exists
 */
export async function deleteNamespaceIfExists(namespace: string, kc?: k8s.KubeConfig): Promise<void> {
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

/**
 * Delete a namespace and wait for it to be fully removed
 * This is important to prevent resource accumulation in the cluster
 */
export async function deleteNamespaceAndWait(
  namespace: string,
  kc?: k8s.KubeConfig,
  timeoutMs = 60000
): Promise<void> {
  const kubeConfig = kc || getIntegrationTestKubeConfig();
  const coreApi = createCoreV1ApiClient(kubeConfig);
  const startTime = Date.now();

  try {
    // First, try to delete the namespace
    await coreApi.deleteNamespace({ name: namespace });
    console.log(`🗑️ Initiated deletion of test namespace: ${namespace}`);
  } catch (error: any) {
    // If namespace doesn't exist, we're done
    if (error.statusCode === 404 || error.body?.reason === 'NotFound') {
      console.log(`📦 Test namespace ${namespace} already deleted`);
      return;
    }
    // For other errors, log but continue to wait
    console.warn(`⚠️ Error initiating namespace deletion: ${error.message}`);
  }

  // Wait for namespace to be fully deleted
  while (Date.now() - startTime < timeoutMs) {
    try {
      await coreApi.readNamespace({ name: namespace });
      // Namespace still exists, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error: any) {
      // 404 means namespace is deleted
      if (error.statusCode === 404 || error.body?.reason === 'NotFound') {
        console.log(`✅ Test namespace ${namespace} fully deleted`);
        return;
      }
      // Other errors, log and continue waiting
      console.warn(`⚠️ Error checking namespace status: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.warn(`⚠️ Timeout waiting for namespace ${namespace} to be deleted`);
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

    console.log(`🧹 Found ${testNamespaces.length} test namespaces to clean up: ${testNamespaces.join(', ')}`);

    // Delete all matching namespaces in parallel
    await Promise.all(
      testNamespaces.map((ns) => deleteNamespaceAndWait(ns, kubeConfig, 30000))
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
  const resourceJson = (typeof (resource as any).toJSON === 'function' 
    ? (resource as any).toJSON() 
    : resource) as T;
  
  const resourceName = resourceJson.metadata?.name || 'unknown';
  const resourceKind = resourceJson.kind || 'Unknown';
  const resourceNamespace = resourceJson.metadata?.namespace;

  try {
    const created = await k8sApi.create(resourceJson);
    if (verbose) {
      console.log(`✅ Created ${resourceKind}/${resourceName}${resourceNamespace ? ` in ${resourceNamespace}` : ''}`);
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
        throw new Error(`Resource ${resourceKind}/${resourceName} already exists${resourceNamespace ? ` in namespace '${resourceNamespace}'` : ''}`);

      case 'warn':
        if (verbose) {
          console.log(`⚠️ ${resourceKind}/${resourceName} already exists, using existing resource`);
        }
        // Fetch and return the existing resource
        return await k8sApi.read({
          apiVersion: resourceJson.apiVersion!,
          kind: resourceJson.kind!,
          metadata: {
            name: resourceName,
            namespace: resourceNamespace || 'default',
          },
        }) as T;

      case 'patch':
        if (verbose) {
          console.log(`🔄 ${resourceKind}/${resourceName} already exists, patching...`);
        }
        return await k8sApi.patch(resourceJson) as T;

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
        return await k8sApi.create(resourceJson) as T;

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
  resource: k8s.KubernetesObject | { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } },
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
      console.log(`🗑️ Deleted ${resourceKind}/${resourceName}${resourceNamespace ? ` from ${resourceNamespace}` : ''}`);
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
