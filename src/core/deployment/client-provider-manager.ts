/**
 * Kubernetes Client Provider Manager
 *
 * Lazy-initializing wrapper around KubernetesClientProvider that is shared
 * by both KroResourceFactory and DirectResourceFactory. Centralizes client
 * creation so configuration logic is defined once.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  createKubernetesClientProvider,
  createKubernetesClientProviderWithKubeConfig,
  type KubernetesClientConfig,
  type KubernetesClientProviderDebugState,
  type KubernetesClientProvider,
} from '../kubernetes/client-provider.js';
import type { FactoryOptions } from '../types/deployment.js';

/**
 * Manages lazy initialization of Kubernetes client providers.
 *
 * Construct once per factory, then call getter methods as needed.
 * The underlying KubernetesClientProvider and API clients are created
 * on first access and cached for the lifetime of the manager.
 */
export class KubernetesClientManager {
  private clientProvider: KubernetesClientProvider | undefined;
  private cachedCustomObjectsApi: k8s.CustomObjectsApi | undefined;

  constructor(private readonly factoryOptions: FactoryOptions) {}

  /**
   * Get or create the KubernetesClientProvider (lazy initialization).
   */
  getClientProvider(): KubernetesClientProvider {
    if (!this.clientProvider) {
      this.clientProvider = this.createClientProvider(this.factoryOptions);
    }
    return this.clientProvider;
  }

  /**
   * Get the KubeConfig from the centralized provider.
   */
  getKubeConfig(): k8s.KubeConfig {
    return this.getClientProvider().getKubeConfig();
  }

  /**
   * Get or create a CustomObjectsApi client (lazy, cached).
   */
  getCustomObjectsApi(): k8s.CustomObjectsApi {
    if (!this.cachedCustomObjectsApi) {
      this.cachedCustomObjectsApi = this.getClientProvider().getCustomObjectsApi();
    }
    return this.cachedCustomObjectsApi;
  }

  getDebugState(): {
    hasClientProvider: boolean;
    hasCachedCustomObjectsApi: boolean;
    provider?: KubernetesClientProviderDebugState;
  } {
    return {
      hasClientProvider: !!this.clientProvider,
      hasCachedCustomObjectsApi: !!this.cachedCustomObjectsApi,
      ...(this.clientProvider ? { provider: this.clientProvider.getDebugState() } : {}),
    };
  }

  dispose(): void {
    this.cachedCustomObjectsApi = undefined;
    this.clientProvider?.dispose();
    this.clientProvider = undefined;
  }

  /**
   * Create and configure the KubernetesClientProvider from factory options.
   */
  private createClientProvider(options: FactoryOptions): KubernetesClientProvider {
    // If a pre-configured kubeConfig is provided, use it directly
    if (options.kubeConfig) {
      return createKubernetesClientProviderWithKubeConfig(options.kubeConfig);
    }

    // Create client provider with configuration from factory options
    const clientConfig: KubernetesClientConfig = {
      ...(options.skipTLSVerify !== undefined && { skipTLSVerify: options.skipTLSVerify }),
      ...(options.httpTimeouts && { httpTimeouts: options.httpTimeouts }),
    };

    return createKubernetesClientProvider(clientConfig);
  }
}
