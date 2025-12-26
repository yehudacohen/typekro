/**
 * Bun-compatible Kubernetes API Client Factory
 * 
 * This module provides helper functions to create Kubernetes API clients
 * that work correctly in Bun runtime by using a custom HTTP library that
 * properly handles TLS certificates.
 * 
 * ## Token Refresh Handling
 * 
 * The authentication is handled by passing the KubeConfig instance as the
 * auth method. The kubernetes client library calls `applyToRequest()` on
 * each request, which ensures that:
 * 
 * 1. OIDC tokens are refreshed when expired
 * 2. GKE/EKS/AKS tokens are rotated automatically
 * 3. Service account tokens are re-read from disk if changed
 * 
 * This means long-running processes (>1 hour) will automatically get
 * fresh tokens without any additional configuration.
 * 
 * Use these functions instead of kubeConfig.makeApiClient() when running in Bun.
 * 
 * @example
 * ```typescript
 * import { createBunCompatibleApiClient } from './bun-api-client.js';
 * import * as k8s from '@kubernetes/client-node';
 * 
 * const kc = new k8s.KubeConfig();
 * kc.loadFromDefault();
 * 
 * // Create a CoreV1Api client that works in Bun
 * const coreApi = createBunCompatibleApiClient(kc, k8s.CoreV1Api);
 * const namespaces = await coreApi.listNamespace();
 * ```
 */

import * as k8s from '@kubernetes/client-node';
import { createConfiguration } from '@kubernetes/client-node/dist/gen/configuration.js';
import { ServerConfiguration } from '@kubernetes/client-node/dist/gen/servers.js';
import type { Configuration } from '@kubernetes/client-node/dist/gen/configuration.js';
import type { AuthMethodsConfiguration } from '@kubernetes/client-node/dist/gen/auth/auth.js';
import { BunCompatibleHttpLibrary, isBunRuntime } from './bun-http-library.js';
import { getComponentLogger } from '../logging/index.js';

const logger = getComponentLogger('bun-api-client');

// Re-export isBunRuntime for convenience
export { isBunRuntime };

/**
 * Type for API client constructors
 */
type ApiClientConstructor<T> = new (configuration: Configuration) => T;

/**
 * Create a Kubernetes API client that works in Bun runtime.
 * 
 * This function creates an API client using a custom HTTP library that
 * properly handles TLS certificates in Bun. If not running in Bun,
 * it falls back to the standard makeApiClient method.
 * 
 * @param kubeConfig - The KubeConfig instance
 * @param apiClientClass - The API client class (e.g., k8s.CoreV1Api)
 * @returns An instance of the API client
 */
export function createBunCompatibleApiClient<T>(
  kubeConfig: k8s.KubeConfig,
  apiClientClass: ApiClientConstructor<T>
): T {
  // If not running in Bun, use standard makeApiClient
  if (!isBunRuntime()) {
    return kubeConfig.makeApiClient(apiClientClass as any) as T;
  }

  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) {
    throw new Error('No active cluster in KubeConfig');
  }

  // Create configuration with Bun-compatible HTTP library
  // The KubeConfig is passed as the auth method, which ensures that:
  // - applyToRequest() is called on each request
  // - Tokens are refreshed automatically when expired
  // - OIDC/GKE/EKS/AKS token rotation is handled
  const authConfig: AuthMethodsConfiguration = {
    default: kubeConfig,
  };
  
  const baseServerConfig = new ServerConfiguration<{}>(cluster.server, {});
  
  const config = createConfiguration({
    baseServer: baseServerConfig,
    authMethods: authConfig,
    httpApi: new BunCompatibleHttpLibrary(),
  });

  logger.debug('Created Bun-compatible API client', {
    apiClient: apiClientClass.name,
    server: cluster.server,
    tokenRefresh: 'enabled via KubeConfig.applyToRequest()',
  });

  return new apiClientClass(config);
}

/**
 * Create a CoreV1Api client that works in Bun runtime.
 */
export function createBunCompatibleCoreV1Api(kubeConfig: k8s.KubeConfig): k8s.CoreV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.CoreV1Api);
}

/**
 * Create an AppsV1Api client that works in Bun runtime.
 */
export function createBunCompatibleAppsV1Api(kubeConfig: k8s.KubeConfig): k8s.AppsV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.AppsV1Api);
}

/**
 * Create a CustomObjectsApi client that works in Bun runtime.
 */
export function createBunCompatibleCustomObjectsApi(kubeConfig: k8s.KubeConfig): k8s.CustomObjectsApi {
  return createBunCompatibleApiClient(kubeConfig, k8s.CustomObjectsApi);
}

/**
 * Create a BatchV1Api client that works in Bun runtime.
 */
export function createBunCompatibleBatchV1Api(kubeConfig: k8s.KubeConfig): k8s.BatchV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.BatchV1Api);
}

/**
 * Create a NetworkingV1Api client that works in Bun runtime.
 */
export function createBunCompatibleNetworkingV1Api(kubeConfig: k8s.KubeConfig): k8s.NetworkingV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.NetworkingV1Api);
}

/**
 * Create an RbacAuthorizationV1Api client that works in Bun runtime.
 */
export function createBunCompatibleRbacAuthorizationV1Api(kubeConfig: k8s.KubeConfig): k8s.RbacAuthorizationV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.RbacAuthorizationV1Api);
}

/**
 * Create a StorageV1Api client that works in Bun runtime.
 */
export function createBunCompatibleStorageV1Api(kubeConfig: k8s.KubeConfig): k8s.StorageV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.StorageV1Api);
}

/**
 * Create an ApiextensionsV1Api client that works in Bun runtime.
 */
export function createBunCompatibleApiextensionsV1Api(kubeConfig: k8s.KubeConfig): k8s.ApiextensionsV1Api {
  return createBunCompatibleApiClient(kubeConfig, k8s.ApiextensionsV1Api);
}

/**
 * Create a KubernetesObjectApi client that works in Bun runtime.
 * 
 * Note: KubernetesObjectApi has a different constructor signature,
 * so we need special handling.
 */
export function createBunCompatibleKubernetesObjectApi(kubeConfig: k8s.KubeConfig): k8s.KubernetesObjectApi {
  // If not running in Bun, use standard method
  if (!isBunRuntime()) {
    return k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
  }

  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) {
    throw new Error('No active cluster in KubeConfig');
  }

  // Create configuration with Bun-compatible HTTP library
  const authConfig: AuthMethodsConfiguration = {
    default: kubeConfig,
  };
  
  const baseServerConfig = new ServerConfiguration<{}>(cluster.server, {});
  
  const config = createConfiguration({
    baseServer: baseServerConfig,
    authMethods: authConfig,
    httpApi: new BunCompatibleHttpLibrary(),
  });

  return new k8s.KubernetesObjectApi(config);
}
