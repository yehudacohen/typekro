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

import { AsyncLocalStorage } from 'node:async_hooks';
import type * as k8s from '@kubernetes/client-node';
import type { RequestContext } from '@kubernetes/client-node/dist/gen/http/http.js';
import type { AuthMethodsConfiguration } from '@kubernetes/client-node/dist/gen/auth/auth.js';
import type { Configuration } from '@kubernetes/client-node/dist/gen/configuration.js';
import { KubernetesClientError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import {
  BunCompatibleHttpLibrary,
  type HttpTimeoutConfig,
  isBunRuntime,
} from './bun-http-library.js';
import { getKubernetesClientNode } from './client-node-runtime.js';

const logger = getComponentLogger('bun-api-client');

// Re-export isBunRuntime and HttpTimeoutConfig for convenience
export { isBunRuntime, type HttpTimeoutConfig };

/**
 * Type for API client constructors — constrained to ApiType for
 * compatibility with KubeConfig.makeApiClient()
 */
type ApiClientConstructor<T extends k8s.ApiType> = new (configuration: Configuration) => T;

/**
 * Create a Kubernetes API client that works in Bun runtime.
 *
 * This function creates an API client using a custom HTTP library that
 * properly handles TLS certificates in Bun. If not running in Bun,
 * it falls back to the standard makeApiClient method.
 *
 * @param kubeConfig - The KubeConfig instance
 * @param apiClientClass - The API client class (e.g., k8s.CoreV1Api)
 * @param timeoutConfig - Optional HTTP timeout configuration for Bun runtime
 * @returns An instance of the API client
 */
export function createBunCompatibleApiClient<T extends k8s.ApiType>(
  kubeConfig: k8s.KubeConfig,
  apiClientClass: ApiClientConstructor<T>,
  timeoutConfig?: HttpTimeoutConfig
): T {
  // If not running in Bun, use standard makeApiClient
  if (!isBunRuntime()) {
    return kubeConfig.makeApiClient(apiClientClass);
  }

  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) {
    throw new KubernetesClientError('No active cluster in KubeConfig', 'configuration');
  }

  // Create configuration with Bun-compatible HTTP library
  // The KubeConfig is passed as the auth method, which ensures that:
  // - applyToRequest() is called on each request
  // - Tokens are refreshed automatically when expired
  // - OIDC/GKE/EKS/AKS token rotation is handled
  const authConfig: AuthMethodsConfiguration = {
    default: kubeConfig,
  };

  const clientNode = getKubernetesClientNode();
  const baseServerConfig = new clientNode.ServerConfiguration<Record<string, never>>(
    cluster.server,
    {}
  );

  const config = clientNode.createConfiguration({
    baseServer: baseServerConfig,
    authMethods: authConfig,
    httpApi: new BunCompatibleHttpLibrary(timeoutConfig),
  });

  logger.debug('Created Bun-compatible API client', {
    apiClient: apiClientClass.name,
    server: cluster.server,
    tokenRefresh: 'enabled via KubeConfig.applyToRequest()',
    hasCustomTimeouts: !!timeoutConfig,
  });

  return new apiClientClass(config);
}

/**
 * Create a CoreV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleCoreV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.CoreV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().CoreV1Api,
    timeoutConfig
  );
}

/**
 * Create an AppsV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleAppsV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.AppsV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().AppsV1Api,
    timeoutConfig
  );
}

/**
 * Create a CustomObjectsApi client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleCustomObjectsApi(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.CustomObjectsApi {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().CustomObjectsApi,
    timeoutConfig
  );
}

/**
 * Create a BatchV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleBatchV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.BatchV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().BatchV1Api,
    timeoutConfig
  );
}

/**
 * Create a NetworkingV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleNetworkingV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.NetworkingV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().NetworkingV1Api,
    timeoutConfig
  );
}

/**
 * Create an RbacAuthorizationV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleRbacAuthorizationV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.RbacAuthorizationV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().RbacAuthorizationV1Api,
    timeoutConfig
  );
}

/**
 * Create a StorageV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleStorageV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.StorageV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().StorageV1Api,
    timeoutConfig
  );
}

/**
 * Create an ApiextensionsV1Api client that works in Bun runtime.
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration
 */
export function createBunCompatibleApiextensionsV1Api(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.ApiextensionsV1Api {
  return createBunCompatibleApiClient(
    kubeConfig,
    getKubernetesClientNode().ApiextensionsV1Api,
    timeoutConfig
  );
}

/**
 * Create a KubernetesObjectApi client that works in Bun runtime.
 *
 * Note: KubernetesObjectApi has a different constructor signature,
 * so we need special handling.
 *
 * @param kubeConfig - The KubeConfig instance
 * @param timeoutConfig - Optional HTTP timeout configuration for Bun runtime
 * @returns KubernetesObjectApi instance
 */
export function createBunCompatibleKubernetesObjectApi(
  kubeConfig: k8s.KubeConfig,
  timeoutConfig?: HttpTimeoutConfig
): k8s.KubernetesObjectApi {
  // The SDK's generated CRD model silently drops Kubernetes wire fields such
  // as `enum` and `x-kubernetes-validations`. SDK 1.4 removed the virtual
  // serialization-type hook, so preserve the raw CRD at the request boundary.
  // AsyncLocalStorage keeps concurrent object operations independent while the
  // SDK continues to own paths, query parameters, authentication and retries.
  class SchemaPreservingKubernetesObjectApi extends getKubernetesClientNode().KubernetesObjectApi {
    private readonly rawCrd = new AsyncLocalStorage<
      | {
          apiVersion?: string | undefined;
          kind?: string | undefined;
        }
      | undefined
    >();

    configureDefaultNamespace(config: k8s.KubeConfig): void {
      this.setDefaultNamespace(config);
    }

    private withRawCrd<T>(
      spec: { apiVersion?: string | undefined; kind?: string | undefined },
      operation: () => Promise<T>
    ): Promise<T> {
      const rawSpec =
        spec.apiVersion === 'apiextensions.k8s.io/v1' && spec.kind === 'CustomResourceDefinition'
          ? spec
          : undefined;
      return this.rawCrd.run(rawSpec, operation);
    }

    override create<T extends k8s.KubernetesObject>(
      spec: T,
      pretty?: string,
      dryRun?: string,
      fieldManager?: string,
      options?: Configuration
    ): Promise<T> {
      return this.withRawCrd(spec, () => super.create(spec, pretty, dryRun, fieldManager, options));
    }

    override patch<T extends k8s.KubernetesObject>(
      spec: T,
      pretty?: string,
      dryRun?: string,
      fieldManager?: string,
      force?: boolean,
      patchStrategy?: k8s.PatchStrategy,
      options?: Configuration
    ): Promise<T> {
      return this.withRawCrd(spec, () =>
        super.patch(spec, pretty, dryRun, fieldManager, force, patchStrategy, options)
      );
    }

    override replace<T extends k8s.KubernetesObject>(
      spec: T,
      pretty?: string,
      dryRun?: string,
      fieldManager?: string,
      options?: Configuration
    ): Promise<T> {
      return this.withRawCrd(spec, () =>
        super.replace(spec, pretty, dryRun, fieldManager, options)
      );
    }

    override read<T extends k8s.KubernetesObject>(
      spec: Pick<T, 'apiVersion' | 'kind'> & { metadata: { name: string; namespace?: string } },
      pretty?: string,
      exact?: boolean,
      exportt?: boolean,
      options?: Configuration
    ): Promise<T> {
      return this.withRawCrd(spec, () => super.read<T>(spec, pretty, exact, exportt, options));
    }

    override delete(
      spec: k8s.KubernetesObject,
      pretty?: string,
      dryRun?: string,
      gracePeriodSeconds?: number,
      orphanDependents?: boolean,
      propagationPolicy?: string,
      body?: k8s.V1DeleteOptions,
      options?: Configuration
    ): Promise<k8s.V1Status> {
      return this.rawCrd.run(undefined, () =>
        super.delete(
          spec,
          pretty,
          dryRun,
          gracePeriodSeconds,
          orphanDependents,
          propagationPolicy,
          body,
          options
        )
      );
    }

    override list<T extends k8s.KubernetesObject>(
      apiVersion: string,
      kind: string,
      namespace?: string,
      pretty?: string,
      exact?: boolean,
      exportt?: boolean,
      fieldSelector?: string,
      labelSelector?: string,
      limit?: number,
      continueToken?: string,
      options?: Configuration
    ): Promise<k8s.KubernetesListObject<T>> {
      return this.rawCrd.run(undefined, () =>
        super.list<T>(
          apiVersion,
          kind,
          namespace,
          pretty,
          exact,
          exportt,
          fieldSelector,
          labelSelector,
          limit,
          continueToken,
          options
        )
      );
    }

    protected override requestPromise<T extends k8s.KubernetesObject>(
      requestContext: RequestContext,
      type?: string,
      options?: Configuration
    ): Promise<T> {
      const spec = this.rawCrd.getStore();
      if (spec) {
        if (requestContext.getHttpMethod() !== 'GET') {
          requestContext.setBody(JSON.stringify(spec));
        }
        return super.requestPromise<T>(requestContext, 'object', options);
      }
      return super.requestPromise<T>(requestContext, type, options);
    }
  }

  // If not running in Bun, use standard method
  if (!isBunRuntime()) {
    const client = kubeConfig.makeApiClient(SchemaPreservingKubernetesObjectApi);
    client.configureDefaultNamespace(kubeConfig);
    return client;
  }

  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) {
    throw new KubernetesClientError('No active cluster in KubeConfig', 'configuration');
  }

  // Create configuration with Bun-compatible HTTP library
  const authConfig: AuthMethodsConfiguration = {
    default: kubeConfig,
  };

  const clientNode = getKubernetesClientNode();
  const baseServerConfig = new clientNode.ServerConfiguration<Record<string, never>>(
    cluster.server,
    {}
  );

  const config = clientNode.createConfiguration({
    baseServer: baseServerConfig,
    authMethods: authConfig,
    httpApi: new BunCompatibleHttpLibrary(timeoutConfig),
  });

  const client = new SchemaPreservingKubernetesObjectApi(config);
  client.configureDefaultNamespace(kubeConfig);
  return client;
}
