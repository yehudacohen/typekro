/**
 * Kubernetes Client Provider
 *
 * Single source of truth for all Kubernetes API interactions.
 * Manages KubeConfig loading and KubernetesObjectApi client instantiation
 * with consistent configuration across the entire application.
 *
 * This provider implements the singleton pattern and serves as the central
 * authority for all Kubernetes API client creation, ensuring consistent
 * configuration, security settings, and lifecycle management.
 */

import * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';

/**
 * Configuration options for the Kubernetes client provider
 */
export interface KubernetesClientConfig {
  /**
   * SECURITY WARNING: Only set to true in non-production environments.
   * This disables TLS certificate verification and makes connections vulnerable
   * to man-in-the-middle attacks.
   *
   * @default false (secure by default)
   */
  skipTLSVerify?: boolean;

  /**
   * Custom cluster server URL (optional)
   */
  server?: string;

  /**
   * Custom context name (optional)
   */
  context?: string;

  /**
   * Complete cluster configuration (optional)
   */
  cluster?: {
    name: string;
    server: string;
    skipTLSVerify?: boolean;
    caData?: string;
    caFile?: string;
  };

  /**
   * Complete user configuration (optional)
   */
  user?: {
    name: string;
    token?: string;
    certData?: string;
    certFile?: string;
    keyData?: string;
    keyFile?: string;
  };

  /**
   * Whether to load from default kubeconfig if no complete cluster/user config provided
   * @default true
   */
  loadFromDefault?: boolean;

  /**
   * Custom kubeconfig file path (optional)
   */
  kubeconfigPath?: string;
}

/**
 * Interface for components that need Kubernetes API access
 */
export interface KubernetesApiConsumer {
  /**
   * Set the Kubernetes API client instance
   */
  setKubernetesApi(api: k8s.KubernetesObjectApi): void;
}

/**
 * Interface for components that need KubeConfig access
 */
export interface KubeConfigConsumer {
  /**
   * Set the KubeConfig instance
   */
  setKubeConfig(config: k8s.KubeConfig): void;
}

/**
 * Kubernetes Client Provider - Single source of truth for Kubernetes API access
 *
 * This class implements the singleton pattern and serves as the central authority
 * for all Kubernetes API client creation. It ensures consistent configuration,
 * security settings, and lifecycle management across the entire application.
 */
export class KubernetesClientProvider {
  private static instance: KubernetesClientProvider | null = null;
  private kubeConfig: k8s.KubeConfig | null = null;
  private k8sApi: k8s.KubernetesObjectApi | null = null;
  private config: KubernetesClientConfig | null = null;
  private logger = getComponentLogger('kubernetes-client-provider');
  private initialized = false;

  private constructor() {}

  /**
   * Get the singleton instance of KubernetesClientProvider
   */
  static getInstance(): KubernetesClientProvider {
    if (!KubernetesClientProvider.instance) {
      KubernetesClientProvider.instance = new KubernetesClientProvider();
    }
    return KubernetesClientProvider.instance;
  }

  /**
   * Create a new instance for dependency injection (non-singleton)
   * Useful for testing or when you need multiple configurations
   */
  static createInstance(config?: KubernetesClientConfig): KubernetesClientProvider {
    const instance = new KubernetesClientProvider();
    if (config) {
      instance.initialize(config);
    }
    return instance;
  }

  /**
   * Initialize the provider with configuration
   * This method is idempotent - calling it multiple times with the same config is safe
   */
  initialize(config?: KubernetesClientConfig): void {
    // If already initialized with the same config, skip re-initialization
    if (this.initialized && this.isSameConfig(config)) {
      this.logger.debug('Provider already initialized with same configuration, skipping');
      return;
    }

    this.logger.debug('Initializing Kubernetes client provider', {
      hasConfig: !!config,
      skipTLSVerify: config?.skipTLSVerify,
      hasCluster: !!config?.cluster,
      hasUser: !!config?.user,
      loadFromDefault: config?.loadFromDefault,
      kubeconfigPath: config?.kubeconfigPath,
    });

    try {
      this.config = config || {};
      this.kubeConfig = this.createKubeConfig(this.config);
      this.k8sApi = this.kubeConfig.makeApiClient(k8s.KubernetesObjectApi);
      this.initialized = true;

      const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
      // Use debug level in test environments to reduce noise, info level in production
      const logLevel = isTestEnvironment ? 'debug' : 'info';
      this.logger[logLevel]('Kubernetes client provider initialized successfully', {
        currentContext: this.kubeConfig.getCurrentContext(),
        server: this.kubeConfig.getCurrentCluster()?.server,
        skipTLSVerify: this.kubeConfig.getCurrentCluster()?.skipTLSVerify,
        clusterName: this.kubeConfig.getCurrentCluster()?.name,
        userName: this.kubeConfig.getCurrentUser()?.name,
      });
    } catch (error) {
      this.logger.error('Failed to initialize Kubernetes client provider', error as Error);
      this.reset();
      const enhancedError = new Error(
        `Failed to initialize Kubernetes client provider: ${(error as Error).message}`
      );
      enhancedError.cause = error;
      throw enhancedError;
    }
  }

  /**
   * Initialize the provider with a pre-configured KubeConfig
   * Useful when you already have a KubeConfig instance
   */
  initializeWithKubeConfig(kubeConfig: k8s.KubeConfig): void {
    this.logger.debug('Initializing Kubernetes client provider with pre-configured KubeConfig');

    try {
      this.kubeConfig = kubeConfig;
      this.k8sApi = this.kubeConfig.makeApiClient(k8s.KubernetesObjectApi);
      this.initialized = true;
      this.config = null; // No config object when using pre-configured KubeConfig

      this.logger.info('Kubernetes client provider initialized with pre-configured KubeConfig', {
        currentContext: this.kubeConfig.getCurrentContext(),
        server: this.kubeConfig.getCurrentCluster()?.server,
        skipTLSVerify: this.kubeConfig.getCurrentCluster()?.skipTLSVerify,
      });
    } catch (error) {
      this.logger.error('Failed to initialize with pre-configured KubeConfig', error as Error);
      this.reset();
      const enhancedError = new Error(
        `Failed to initialize with pre-configured KubeConfig: ${(error as Error).message}`
      );
      enhancedError.cause = error;
      throw enhancedError;
    }
  }

  /**
   * Get the configured KubeConfig instance
   * @throws Error if provider is not initialized
   */
  getKubeConfig(): k8s.KubeConfig {
    this.ensureInitialized();
    return this.kubeConfig!;
  }

  /**
   * Get the configured KubernetesObjectApi instance
   * @throws Error if provider is not initialized
   */
  getKubernetesApi(): k8s.KubernetesObjectApi {
    this.ensureInitialized();
    return this.k8sApi!;
  }

  /**
   * Inject the Kubernetes API client into a consumer component
   */
  injectKubernetesApi(consumer: KubernetesApiConsumer): void {
    this.ensureInitialized();
    consumer.setKubernetesApi(this.k8sApi!);
    this.logger.debug('Injected Kubernetes API client into consumer', {
      consumerType: consumer.constructor.name,
    });
  }

  /**
   * Inject the KubeConfig into a consumer component
   */
  injectKubeConfig(consumer: KubeConfigConsumer): void {
    this.ensureInitialized();
    consumer.setKubeConfig(this.kubeConfig!);
    this.logger.debug('Injected KubeConfig into consumer', {
      consumerType: consumer.constructor.name,
    });
  }

  /**
   * Get current configuration (read-only)
   */
  getConfiguration(): Readonly<KubernetesClientConfig> | null {
    return this.config ? { ...this.config } : null;
  }

  /**
   * Create a new KubeConfig with the provided configuration
   */
  private createKubeConfig(config: KubernetesClientConfig): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();

    // If complete cluster/user configuration is provided, use it directly
    if (config.cluster && config.user) {
      this.logger.debug('Using complete cluster/user configuration');

      const contextName = config.context || 'typekro-context';

      kc.clusters = [
        {
          name: config.cluster.name,
          server: config.cluster.server,
          ...(config.cluster.skipTLSVerify !== undefined && {
            skipTLSVerify: config.cluster.skipTLSVerify,
          }),
          ...(config.cluster.caData && { caData: config.cluster.caData }),
          ...(config.cluster.caFile && { caFile: config.cluster.caFile }),
        },
      ];

      kc.users = [
        {
          name: config.user.name,
          ...(config.user.token && { token: config.user.token }),
          ...(config.user.certData && { certData: config.user.certData }),
          ...(config.user.certFile && { certFile: config.user.certFile }),
          ...(config.user.keyData && { keyData: config.user.keyData }),
          ...(config.user.keyFile && { keyFile: config.user.keyFile }),
        },
      ];

      kc.contexts = [
        {
          name: contextName,
          cluster: config.cluster.name,
          user: config.user.name,
        },
      ];

      kc.setCurrentContext(contextName);
    } else if (config.loadFromDefault !== false) {
      // Load from default kubeconfig and apply modifications
      this.logger.debug('Loading from default kubeconfig with modifications', {
        kubeconfigPath: config.kubeconfigPath,
      });

      try {
        if (config.kubeconfigPath) {
          kc.loadFromFile(config.kubeconfigPath);
        } else {
          kc.loadFromDefault();
        }

        // Apply configuration modifications if provided
        this.applyConfigModifications(kc, config);
      } catch (error) {
        // If loading from default fails (e.g., in test environments), create a minimal mock config
        this.logger.warn(
          'Failed to load kubeconfig, creating minimal mock configuration for testing',
          {
            error: (error as Error).message,
            isTestEnvironment: process.env.NODE_ENV === 'test' || process.env.VITEST === 'true',
          }
        );

        // Create a minimal mock configuration for testing
        kc.clusters = [
          {
            name: 'mock-cluster',
            server: 'https://mock-kubernetes-api:6443',
            skipTLSVerify: true,
          },
        ];

        kc.users = [
          {
            name: 'mock-user',
            token: 'mock-token',
          },
        ];

        kc.contexts = [
          {
            name: 'mock-context',
            cluster: 'mock-cluster',
            user: 'mock-user',
          },
        ];

        kc.setCurrentContext('mock-context');
      }
    } else {
      throw new Error(
        'Either complete cluster/user configuration must be provided, or loadFromDefault must be true'
      );
    }

    // Validate and log security configuration
    this.validateAndLogSecurityConfiguration(kc, config);

    return kc;
  }

  /**
   * Apply configuration modifications to an existing KubeConfig
   */
  private applyConfigModifications(kc: k8s.KubeConfig, config: KubernetesClientConfig): void {
    const cluster = kc.getCurrentCluster();

    // Apply skipTLSVerify modification with security validation
    if (config.skipTLSVerify !== undefined && cluster) {
      if (config.skipTLSVerify === true) {
        // Keep TLS warnings at warn level - these are important security notices
        this.logger.warn('Explicitly disabling TLS verification - this is insecure', {
          server: cluster.server,
          recommendation: 'Only use skipTLSVerify in development environments',
        });
      }

      const modifiedCluster = { ...cluster, skipTLSVerify: config.skipTLSVerify };
      kc.clusters = kc.clusters.map((c) => (c === cluster ? modifiedCluster : c));

      this.logger.debug('Applied skipTLSVerify modification', {
        skipTLSVerify: config.skipTLSVerify,
      });
    }

    // Apply server modification
    if (config.server && cluster) {
      const updatedCluster = { ...cluster, server: config.server };
      kc.clusters = kc.clusters.map((c) => (c === cluster ? updatedCluster : c));

      this.logger.debug('Applied server modification', {
        server: config.server,
      });
    }

    // Apply context modification
    if (config.context) {
      try {
        kc.setCurrentContext(config.context);
        this.logger.debug('Applied context modification', {
          context: config.context,
        });
      } catch (error) {
        this.logger.error('Failed to set context', error as Error, {
          requestedContext: config.context,
          availableContexts: kc.getContexts().map((c) => c.name),
        });
        throw new Error(`Context '${config.context}' not found in kubeconfig`);
      }
    }
  }

  /**
   * Validate and log security configuration
   */
  private validateAndLogSecurityConfiguration(
    kc: k8s.KubeConfig,
    config: KubernetesClientConfig
  ): void {
    const cluster = kc.getCurrentCluster();

    if (cluster?.skipTLSVerify) {
      const isExplicitlySet =
        config.skipTLSVerify === true || config.cluster?.skipTLSVerify === true;

      // Keep TLS warnings at warn level - these are important security notices
      this.logger.warn(
        'TLS verification disabled - this is insecure and should only be used in development',
        {
          server: cluster.server,
          explicitlySet: isExplicitlySet,
          fromClusterConfig: !isExplicitlySet,
          recommendation: 'Update cluster configuration to enable TLS verification',
          securityRisk: 'Connections are vulnerable to man-in-the-middle attacks',
        }
      );
    } else {
      this.logger.debug('TLS verification enabled - secure configuration', {
        server: cluster?.server,
      });
    }

    // Validate server URL
    if (cluster?.server) {
      try {
        new URL(cluster.server);
      } catch (error) {
        this.logger.warn('Invalid server URL format', {
          server: cluster.server,
          error: (error as Error).message,
        });
      }
    }
  }

  /**
   * Check if two configurations are the same
   */
  private isSameConfig(config?: KubernetesClientConfig): boolean {
    if (!this.config && !config) return true;
    if (!this.config || !config) return false;

    return JSON.stringify(this.config) === JSON.stringify(config);
  }

  /**
   * Ensure the provider is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.kubeConfig || !this.k8sApi) {
      throw new Error('KubernetesClientProvider not initialized. Call initialize() first.');
    }
  }

  /**
   * Reset the provider instance (useful for testing)
   */
  private reset(): void {
    this.kubeConfig = null;
    this.k8sApi = null;
    this.config = null;
    this.initialized = false;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static reset(): void {
    if (KubernetesClientProvider.instance) {
      KubernetesClientProvider.instance.reset();
    }
    KubernetesClientProvider.instance = null;
  }

  /**
   * Check if the provider is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.kubeConfig !== null && this.k8sApi !== null;
  }

  /**
   * Get connection status information
   */
  getConnectionInfo(): {
    initialized: boolean;
    currentContext?: string;
    server?: string;
    skipTLSVerify?: boolean;
    clusterName?: string;
    userName?: string;
  } {
    if (!this.initialized || !this.kubeConfig) {
      return { initialized: false };
    }

    const cluster = this.kubeConfig.getCurrentCluster();
    const user = this.kubeConfig.getCurrentUser();

    return {
      initialized: true,
      ...(this.kubeConfig.getCurrentContext() && {
        currentContext: this.kubeConfig.getCurrentContext(),
      }),
      ...(cluster?.server && { server: cluster.server }),
      ...(cluster?.skipTLSVerify !== undefined && { skipTLSVerify: cluster.skipTLSVerify }),
      ...(cluster?.name && { clusterName: cluster.name }),
      ...(user?.name && { userName: user.name }),
    };
  }
}

/**
 * Convenience function to get the singleton instance
 */
export function getKubernetesClientProvider(): KubernetesClientProvider {
  return KubernetesClientProvider.getInstance();
}

/**
 * Factory function to create and initialize a provider instance
 */
export function createKubernetesClientProvider(
  config?: KubernetesClientConfig
): KubernetesClientProvider {
  const provider = KubernetesClientProvider.createInstance();
  if (config) {
    provider.initialize(config);
  }
  return provider;
}

/**
 * Factory function to create a provider with a pre-configured KubeConfig
 */
export function createKubernetesClientProviderWithKubeConfig(
  kubeConfig: k8s.KubeConfig
): KubernetesClientProvider {
  const provider = KubernetesClientProvider.createInstance();
  provider.initializeWithKubeConfig(kubeConfig);
  return provider;
}

/**
 * Convenience function to get a configured Kubernetes API client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getKubernetesApi(config?: KubernetesClientConfig): k8s.KubernetesObjectApi {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getKubernetesApi();
}

/**
 * Convenience function to get a configured KubeConfig
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getKubeConfig(config?: KubernetesClientConfig): k8s.KubeConfig {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getKubeConfig();
}
