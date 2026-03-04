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
import {
  DEFAULT_BACKOFF_MULTIPLIER,
  DEFAULT_CLUSTER_READY_TIMEOUT,
  DEFAULT_FAST_POLL_INTERVAL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_READINESS_MAX_BACKOFF,
  DEFAULT_RETRY_BASE_DELAY,
} from '../config/defaults.js';
import { isTestEnvironment } from '../config/index.js';
import { ensureError, KubernetesClientError } from '../errors.js';
import { getComponentLogger } from '../logging/index.js';
import {
  createBunCompatibleApiClient,
  createBunCompatibleKubernetesObjectApi,
  type HttpTimeoutConfig,
  isBunRuntime,
} from './bun-api-client.js';

/**
 * Retry configuration options for operations with exponential backoff
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Base delay between retries in milliseconds
   * @default 1000
   */
  baseDelay?: number;

  /**
   * Maximum delay between retries in milliseconds
   * @default 10000
   */
  maxDelay?: number;

  /**
   * Backoff multiplier for exponential backoff
   * @default 2
   */
  backoffFactor?: number;

  /**
   * Function to determine if an error is retryable
   * @param error - The error to check
   * @returns true if the error is retryable, false otherwise
   */
  retryableErrors?: (error: Error) => boolean;
}

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
    /** @security Disables TLS verification for this cluster. Only use in development/testing. */
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

  /**
   * HTTP request timeout configuration for Bun runtime
   * Configures timeouts for different types of Kubernetes API operations
   */
  httpTimeouts?: HttpTimeoutConfig;
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

  // Client cache to avoid recreating clients unnecessarily
  private clientCache = new Map<string, any>();

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
      // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
      // This works around Bun's fetch TLS issues (https://github.com/oven-sh/bun/issues/10642)
      // Pass HTTP timeout configuration if provided
      this.k8sApi = createBunCompatibleKubernetesObjectApi(this.kubeConfig, config?.httpTimeouts);
      this.initialized = true;

      const isTest = isTestEnvironment();
      // Use debug level in test environments to reduce noise, info level in production
      const logLevel = isTest ? 'debug' : 'info';
      this.logger[logLevel]('Kubernetes client provider initialized successfully', {
        currentContext: this.kubeConfig.getCurrentContext(),
        server: this.kubeConfig.getCurrentCluster()?.server,
        skipTLSVerify: this.kubeConfig.getCurrentCluster()?.skipTLSVerify,
        clusterName: this.kubeConfig.getCurrentCluster()?.name,
        userName: this.kubeConfig.getCurrentUser()?.name,
      });
    } catch (error: unknown) {
      this.logger.error('Failed to initialize Kubernetes client provider', ensureError(error));
      this.reset();
      throw new KubernetesClientError(
        `Failed to initialize Kubernetes client provider: ${ensureError(error).message}`,
        'initialization',
        error instanceof Error ? error : new Error(String(error))
      );
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
      // Use createBunCompatibleKubernetesObjectApi which handles both Bun and Node.js
      // This works around Bun's fetch TLS issues (https://github.com/oven-sh/bun/issues/10642)
      this.k8sApi = createBunCompatibleKubernetesObjectApi(this.kubeConfig);
      this.initialized = true;
      this.config = null; // No config object when using pre-configured KubeConfig

      this.logger.info('Kubernetes client provider initialized with pre-configured KubeConfig', {
        currentContext: this.kubeConfig.getCurrentContext(),
        server: this.kubeConfig.getCurrentCluster()?.server,
        skipTLSVerify: this.kubeConfig.getCurrentCluster()?.skipTLSVerify,
        runtime: isBunRuntime() ? 'bun' : 'node',
      });
    } catch (error: unknown) {
      this.logger.error('Failed to initialize with pre-configured KubeConfig', ensureError(error));
      this.reset();
      throw new KubernetesClientError(
        `Failed to initialize with pre-configured KubeConfig: ${ensureError(error).message}`,
        'initialization',
        error instanceof Error ? error : new Error(String(error))
      );
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
   * Get a CoreV1Api client instance with consistent configuration
   * Handles core Kubernetes resources like Pods, Services, Namespaces, ConfigMaps, Secrets, etc.
   *
   * @returns CoreV1Api client instance
   * @throws Error if provider is not initialized
   */
  getCoreV1Api(): k8s.CoreV1Api {
    this.ensureInitialized();
    return this.getCachedClient('CoreV1Api', k8s.CoreV1Api);
  }

  /**
   * Get an AppsV1Api client instance with consistent configuration
   * Handles application resources like Deployments, ReplicaSets, StatefulSets, DaemonSets, etc.
   *
   * @returns AppsV1Api client instance
   * @throws Error if provider is not initialized
   */
  getAppsV1Api(): k8s.AppsV1Api {
    this.ensureInitialized();
    return this.getCachedClient('AppsV1Api', k8s.AppsV1Api);
  }

  /**
   * Get a CustomObjectsApi client instance with consistent configuration
   * Handles custom resources and CRDs (Custom Resource Definitions)
   *
   * @returns CustomObjectsApi client instance
   * @throws Error if provider is not initialized
   */
  getCustomObjectsApi(): k8s.CustomObjectsApi {
    this.ensureInitialized();
    return this.getCachedClient('CustomObjectsApi', k8s.CustomObjectsApi);
  }

  /**
   * Get a BatchV1Api client instance with consistent configuration
   * Handles batch resources like Jobs and CronJobs
   *
   * @returns BatchV1Api client instance
   * @throws Error if provider is not initialized
   */
  getBatchV1Api(): k8s.BatchV1Api {
    this.ensureInitialized();
    return this.getCachedClient('BatchV1Api', k8s.BatchV1Api);
  }

  /**
   * Get a NetworkingV1Api client instance with consistent configuration
   * Handles networking resources like Ingress, NetworkPolicy, etc.
   *
   * @returns NetworkingV1Api client instance
   * @throws Error if provider is not initialized
   */
  getNetworkingV1Api(): k8s.NetworkingV1Api {
    this.ensureInitialized();
    return this.getCachedClient('NetworkingV1Api', k8s.NetworkingV1Api);
  }

  /**
   * Get an RbacAuthorizationV1Api client instance with consistent configuration
   * Handles RBAC resources like Roles, RoleBindings, ClusterRoles, ClusterRoleBindings, ServiceAccounts, etc.
   *
   * @returns RbacAuthorizationV1Api client instance
   * @throws Error if provider is not initialized
   */
  getRbacAuthorizationV1Api(): k8s.RbacAuthorizationV1Api {
    this.ensureInitialized();
    return this.getCachedClient('RbacAuthorizationV1Api', k8s.RbacAuthorizationV1Api);
  }

  /**
   * Get a StorageV1Api client instance with consistent configuration
   * Handles storage resources like StorageClass, VolumeAttachment, CSIDriver, CSINode, etc.
   *
   * @returns StorageV1Api client instance
   * @throws Error if provider is not initialized
   */
  getStorageV1Api(): k8s.StorageV1Api {
    this.ensureInitialized();
    return this.getCachedClient('StorageV1Api', k8s.StorageV1Api);
  }

  /**
   * Get ApiExtensionsV1Api client
   * @returns ApiExtensionsV1Api client instance
   * @throws Error if provider is not initialized
   */
  getApiExtensionsV1Api(): k8s.ApiextensionsV1Api {
    this.ensureInitialized();
    return this.getCachedClient('ApiextensionsV1Api', k8s.ApiextensionsV1Api);
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
   * Check if the Kubernetes cluster is available and accessible
   * Performs a lightweight connectivity test to the cluster
   *
   * @returns Promise<boolean> - true if cluster is available, false otherwise
   */
  async isClusterAvailable(): Promise<boolean> {
    try {
      this.ensureInitialized();

      // Perform a lightweight API call to check connectivity
      const coreApi = this.getCoreV1Api();
      await coreApi.getAPIResources();

      this.logger.debug('Cluster availability check successful');
      return true;
    } catch (error: unknown) {
      this.logger.debug('Cluster availability check failed', {
        error: ensureError(error).message,
      });
      return false;
    }
  }

  /**
   * Wait for the cluster to become ready with timeout and retry logic
   * Useful for test environments where the cluster might be starting up
   *
   * @param timeout - Maximum time to wait in milliseconds (default: 30000ms)
   * @param retryInterval - Interval between retry attempts in milliseconds (default: 1000ms)
   * @throws Error if cluster doesn't become available within timeout
   */
  async waitForClusterReady(
    timeout: number = DEFAULT_CLUSTER_READY_TIMEOUT,
    retryInterval: number = DEFAULT_FAST_POLL_INTERVAL
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await this.isClusterAvailable()) {
        this.logger.debug('Cluster is ready', {
          waitTime: Date.now() - startTime,
        });
        return;
      }

      this.logger.debug('Waiting for cluster to become ready', {
        elapsed: Date.now() - startTime,
        timeout,
      });

      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }

    throw new KubernetesClientError(
      `Cluster did not become available within ${timeout}ms timeout`,
      'cluster-availability'
    );
  }

  /**
   * Execute an operation with retry logic and exponential backoff
   * Useful for handling transient network issues and API server unavailability
   *
   * @param operation - The async operation to execute
   * @param options - Retry configuration options
   * @returns Promise<T> - Result of the operation
   * @throws Error if all retry attempts fail
   */
  async withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const {
      maxAttempts = DEFAULT_MAX_RETRIES,
      baseDelay = DEFAULT_RETRY_BASE_DELAY,
      maxDelay = DEFAULT_READINESS_MAX_BACKOFF,
      backoffFactor = DEFAULT_BACKOFF_MULTIPLIER,
      retryableErrors = this.defaultRetryableErrorCheck,
    } = options;

    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await operation();

        if (attempt > 1) {
          this.logger.debug('Operation succeeded after retry', {
            attempt,
            maxAttempts,
          });
        }

        return result;
      } catch (error: unknown) {
        lastError = ensureError(error);

        if (attempt === maxAttempts || !retryableErrors(lastError)) {
          this.logger.error('Operation failed after all retry attempts', lastError, {
            attempt,
            maxAttempts,
            retryable: retryableErrors(lastError),
          });
          throw lastError;
        }

        const delay = Math.min(baseDelay * backoffFactor ** (attempt - 1), maxDelay);

        this.logger.warn('Operation failed, retrying', {
          error: lastError.message,
          attempt,
          maxAttempts,
          retryDelay: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  /**
   * Get a cached API client instance or create a new one
   * This method implements client caching to avoid recreating clients unnecessarily
   *
   * When running in Bun, uses a custom HTTP library that properly handles
   * TLS certificates (workaround for https://github.com/oven-sh/bun/issues/10642)
   *
   * @param clientType - String identifier for the client type
   * @param clientClass - The API client class constructor
   * @returns Cached or new API client instance
   */
  private getCachedClient<T extends k8s.ApiType>(
    clientType: string,
    clientClass: new (config: k8s.Configuration) => T
  ): T {
    // Check if we have a cached client
    if (this.clientCache.has(clientType)) {
      this.logger.debug('Using cached API client', { clientType });
      return this.clientCache.get(clientType);
    }

    let client: T;

    try {
      // Use Bun-compatible client creation when running in Bun
      // This works around Bun's fetch TLS issues
      if (isBunRuntime() && this.kubeConfig) {
        client = createBunCompatibleApiClient(
          this.kubeConfig,
          clientClass,
          this.config?.httpTimeouts
        );
        this.logger.debug('Created API client using Bun-compatible HTTP library', {
          clientType,
          runtime: 'bun',
          hasCustomTimeouts: !!this.config?.httpTimeouts,
        });
      } else {
        // Use the standard makeApiClient approach for Node.js
        client = this.kubeConfig?.makeApiClient(clientClass) as T;
        this.logger.debug('Created API client using makeApiClient', {
          clientType,
          runtime: 'node',
        });
      }
    } catch (error: unknown) {
      // Log detailed information about why client creation failed
      this.logger.error('API client creation failed', ensureError(error), {
        clientType,
        clientClassName: clientClass?.name,
        isBun: isBunRuntime(),
        kubeConfigValid: !!this.kubeConfig,
        currentCluster: this.kubeConfig?.getCurrentCluster()?.name,
        currentUser: this.kubeConfig?.getCurrentUser()?.name,
      });

      // Re-throw the error instead of falling back
      throw new KubernetesClientError(
        `Failed to create ${clientType} API client: ${ensureError(error).message}`,
        'client-creation',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    // Cache the client for future use
    this.clientCache.set(clientType, client);

    this.logger.debug('Created and cached new API client', { clientType });
    return client;
  }

  /**
   * Default function to determine if an error is retryable
   * Considers network errors, timeouts, and temporary API server issues as retryable
   *
   * @param error - The error to check
   * @returns true if the error is retryable, false otherwise
   */
  private defaultRetryableErrorCheck(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Network connectivity issues
    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('etimedout') ||
      message.includes('network error')
    ) {
      return true;
    }

    // HTTP status codes that are typically retryable
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    const statusCodeMatch = message.match(/status code (\d+)/);
    if (statusCodeMatch?.[1]) {
      const statusCode = parseInt(statusCodeMatch[1], 10);
      return retryableStatusCodes.includes(statusCode);
    }

    // Kubernetes API server temporary issues
    if (
      message.includes('too many requests') ||
      message.includes('service unavailable') ||
      message.includes('internal server error') ||
      message.includes('bad gateway') ||
      message.includes('gateway timeout')
    ) {
      return true;
    }

    return false;
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
          skipTLSVerify: config.cluster.skipTLSVerify ?? false,
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
      } catch (error: unknown) {
        /**
         * @security Mock credentials are only used in test environments.
         * In production, kubeconfig loading failures are fatal to prevent
         * accidentally connecting with mock/insecure credentials.
         */
        const isTestEnv = isTestEnvironment();

        if (!isTestEnv) {
          this.logger.error(
            'Failed to load kubeconfig in non-test environment, re-throwing',
            ensureError(error)
          );
          throw error;
        }

        this.logger.warn(
          'Failed to load kubeconfig, creating minimal mock configuration for testing',
          {
            error: ensureError(error).message,
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
      throw new KubernetesClientError(
        'Either complete cluster/user configuration must be provided, or loadFromDefault must be true',
        'configuration'
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
      } catch (error: unknown) {
        this.logger.error('Failed to set context', ensureError(error), {
          requestedContext: config.context,
          availableContexts: kc.getContexts().map((c) => c.name),
        });
        throw new KubernetesClientError(
          `Context '${config.context}' not found in kubeconfig`,
          'configuration',
          error instanceof Error ? error : new Error(String(error))
        );
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
      } catch (error: unknown) {
        this.logger.warn('Invalid server URL format', {
          server: cluster.server,
          error: ensureError(error).message,
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
      throw new KubernetesClientError(
        'KubernetesClientProvider not initialized. Call initialize() first.',
        'initialization'
      );
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
    this.clientCache.clear();
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

/**
 * Convenience function to get a configured CoreV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getCoreV1Api(config?: KubernetesClientConfig): k8s.CoreV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getCoreV1Api();
}

/**
 * Convenience function to get a configured AppsV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getAppsV1Api(config?: KubernetesClientConfig): k8s.AppsV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getAppsV1Api();
}

/**
 * Convenience function to get a configured CustomObjectsApi client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getCustomObjectsApi(config?: KubernetesClientConfig): k8s.CustomObjectsApi {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getCustomObjectsApi();
}

/**
 * Convenience function to get a configured BatchV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getBatchV1Api(config?: KubernetesClientConfig): k8s.BatchV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getBatchV1Api();
}

/**
 * Convenience function to get a configured NetworkingV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getNetworkingV1Api(config?: KubernetesClientConfig): k8s.NetworkingV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getNetworkingV1Api();
}

/**
 * Convenience function to get a configured RbacAuthorizationV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getRbacAuthorizationV1Api(
  config?: KubernetesClientConfig
): k8s.RbacAuthorizationV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getRbacAuthorizationV1Api();
}

/**
 * Convenience function to get a configured StorageV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getStorageV1Api(config?: KubernetesClientConfig): k8s.StorageV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getStorageV1Api();
}

/**
 * Convenience function to get a configured ApiExtensionsV1Api client
 * Uses the singleton provider and initializes it with default config if needed
 */
export function getApiExtensionsV1Api(config?: KubernetesClientConfig): k8s.ApiextensionsV1Api {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.getApiExtensionsV1Api();
}

/**
 * Convenience function to check cluster availability
 * Uses the singleton provider and initializes it with default config if needed
 */
export async function isClusterAvailable(config?: KubernetesClientConfig): Promise<boolean> {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.isClusterAvailable();
}

/**
 * Convenience function to wait for cluster readiness
 * Uses the singleton provider and initializes it with default config if needed
 */
export async function waitForClusterReady(
  timeout?: number,
  retryInterval?: number,
  config?: KubernetesClientConfig
): Promise<void> {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.waitForClusterReady(timeout, retryInterval);
}

/**
 * Convenience function to execute operations with retry logic
 * Uses the singleton provider and initializes it with default config if needed
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions,
  config?: KubernetesClientConfig
): Promise<T> {
  const provider = getKubernetesClientProvider();
  if (!provider.isInitialized()) {
    provider.initialize(config);
  }
  return provider.withRetry(operation, options);
}
