// kubernetes-api.ts
import * as k8s from '@kubernetes/client-node';
import { getComponentLogger } from '../logging/index.js';
import { createKubernetesClientProvider, type KubernetesClientConfig } from './client-provider.js';

/**
 * Configuration for the Kubernetes API client, sourced from environment variables.
 */
interface KubernetesApiClientConfig {
  /**
   * Kubernetes API server URL.
   * Environment variable: KUBERNETES_API_SERVER
   */
  apiServer: string;
  /**
   * Kubernetes API token (Bearer token).
   * Environment variable: KUBERNETES_API_TOKEN
   */
  apiToken: string;
  /**
   * Kubernetes CA certificate (base64 encoded).
   * Environment variable: KUBERNETES_CA_CERT
   */
  caCert?: string; // This remains optional
  /**
   * SECURITY WARNING: Only set to true in non-production environments.
   * This disables TLS certificate verification and makes connections vulnerable
   * to man-in-the-middle attacks.
   * Environment variable: KUBERNETES_SKIP_TLS_VERIFY
   * 
   * @default false (secure by default)
   */
  skipTLSVerify?: boolean;
}

/**
 * A Kubernetes API client that reads configuration from environment variables.
 * This client provides basic apply, get, and delete operations for Kubernetes resources.
 */
export class KubernetesApi {
  private kc: k8s.KubeConfig;
  private k8sApi: k8s.KubernetesObjectApi;
  private logger = getComponentLogger('kubernetes-api');

  constructor() {
    const config = this.loadConfigFromEnv();
    
    // Use the centralized KubernetesClientProvider
    const clientConfig: KubernetesClientConfig = {
      cluster: {
        name: 'default-cluster',
        server: config.apiServer,
        skipTLSVerify: config.skipTLSVerify === true,
        ...(config.caCert && { caData: config.caCert }),
      },
      user: {
        name: 'default-user',
        token: config.apiToken,
      },
      context: 'default-context',
    };

    const clientProvider = createKubernetesClientProvider(clientConfig);
    this.kc = clientProvider.getKubeConfig();
    this.k8sApi = clientProvider.getKubernetesApi();
  }

  /**
   * Loads Kubernetes API configuration from environment variables.
   * @throws Error if KUBERNETES_API_SERVER or KUBERNETES_API_TOKEN are not set.
   */
  private loadConfigFromEnv(): KubernetesApiClientConfig {
    const apiServer = process.env.KUBERNETES_API_SERVER;
    const apiToken = process.env.KUBERNETES_API_TOKEN;
    const caCert = process.env.KUBERNETES_CA_CERT;
    const skipTLSVerify = process.env.KUBERNETES_SKIP_TLS_VERIFY === 'true';

    if (!apiServer) {
      throw new Error('KUBERNETES_API_SERVER environment variable is not set.');
    }
    if (!apiToken) {
      throw new Error('KUBERNETES_API_TOKEN environment variable is not set.');
    }

    // Log security warning when TLS is disabled
    if (skipTLSVerify) {
      this.logger.warn('TLS verification disabled via environment variable - this is insecure and should only be used in development', {
        component: 'kubernetes-api',
        security: 'tls-disabled',
        envVar: 'KUBERNETES_SKIP_TLS_VERIFY'
      });
    }

    // Validate TLS configuration
    this.validateTLSConfiguration(apiServer, caCert, skipTLSVerify);

    return {
      apiServer,
      apiToken,
      ...(caCert && { caCert }),
      skipTLSVerify,
    };
  }

  /**
   * Validate TLS configuration and provide actionable error messages
   */
  private validateTLSConfiguration(apiServer: string, caCert?: string, skipTLSVerify?: boolean): void {
    // Check if connecting to HTTPS endpoint without proper TLS configuration
    if (apiServer.startsWith('https://')) {
      if (skipTLSVerify && !caCert) {
        this.logger.warn('Connecting to HTTPS endpoint with TLS verification disabled and no CA certificate', {
          component: 'kubernetes-api',
          security: 'tls-configuration-warning',
          apiServer,
          recommendation: 'Provide KUBERNETES_CA_CERT environment variable for secure connections'
        });
      } else if (!skipTLSVerify && !caCert) {
        this.logger.info('Connecting to HTTPS endpoint without custom CA certificate - using system trust store', {
          component: 'kubernetes-api',
          security: 'tls-configuration-info',
          apiServer
        });
      } else if (!skipTLSVerify && caCert) {
        this.logger.info('Secure TLS connection configured with custom CA certificate', {
          component: 'kubernetes-api',
          security: 'tls-configuration-secure',
          apiServer
        });
      }
    } else if (apiServer.startsWith('http://')) {
      this.logger.warn('Connecting to HTTP endpoint - connection is not encrypted', {
        component: 'kubernetes-api',
        security: 'insecure-connection',
        apiServer,
        recommendation: 'Use HTTPS endpoint for secure connections'
      });
    }
  }

  /**
   * Applies a Kubernetes manifest (YAML or JSON string) to the cluster.
   * This method handles both creation and updates of resources.
   * @param manifestString The Kubernetes YAML or JSON manifest as a string.
   */
  public async apply(manifestString: string): Promise<void> {
    // Parse the manifest string as a KubernetesObject
    const manifest = k8s.loadYaml(manifestString) as k8s.KubernetesObject;

    // Ensure metadata and name exist for proper application
    if (!manifest.metadata || !manifest.metadata.name) {
      throw new Error('Kubernetes manifest must have metadata.name defined.');
    }

    const resourceLogger = this.logger.child({
      kind: manifest.kind,
      name: manifest.metadata.name,
      namespace: manifest.metadata.namespace || 'default'
    });
    
    try {

      // V1ObjectMeta's namespace property is string, not string | undefined.
      // We must provide a string. Use a default if not present.
      const manifestNamespace = manifest.metadata.namespace || 'default';

      let existing: k8s.KubernetesObject | undefined;
      try {
        // Correctly access the body property from the response
        // The read method of KubernetesObjectApi expects KubernetesObjectHeader
        // Ensure that name and namespace are explicitly non-optional in the header
        const { body } = await this.k8sApi.read({
          metadata: { name: manifest.metadata.name, namespace: manifestNamespace },
        } as any);
        existing = body;
      } catch (e: any) {
        // If it's a 404, the resource doesn't exist, which is expected for creation
        if (e.statusCode !== 404) {
          resourceLogger.error('Error checking resource existence', e);
          throw e;
        }
      }

      if (existing) {
        // Resource exists, apply update using patch for safety
        // Patch only updates the fields we specify, preserving other fields
        await this.k8sApi.patch(manifest);
        resourceLogger.debug('Resource patched');
      } else {
        // Resource does not exist, create it
        await this.k8sApi.create(manifest);
        resourceLogger.debug('Resource created');
      }
    } catch (error: any) {
      resourceLogger.error('Error applying Kubernetes manifest', error);
      throw new Error(`Failed to apply Kubernetes manifest: ${error.message}`);
    }
  }

  /**
   * Retrieves a Kubernetes resource.
   * @param apiVersion The apiVersion of the resource (e.g., "apps/v1").
   * @param kind The kind of the resource (e.g., "Deployment").
   * @param name The name of the resource.
   * @param namespace The namespace of the resource.
   * @returns The retrieved resource object.
   */
  public async get(
    _apiVersion: string,
    kind: string,
    name: string,
    namespace: string = 'default'
  ): Promise<any> {
    const getLogger = this.logger.child({ kind, name, namespace });
    
    try {
      const { body } = await this.k8sApi.read({
        metadata: { name, namespace },
      } as any);
      return body;
    } catch (error: any) {
      getLogger.error('Error getting resource', error);
      throw new Error(`Failed to get Kubernetes resource: ${error.message}`);
    }
  }

  /**
   * Deletes a Kubernetes resource.
   * @param apiVersion The apiVersion of the resource (e.g., "apps/v1").
   * @param kind The kind of the resource (e.g., "Deployment").
   * @param name The name of the resource.
   * @param namespace The namespace of the resource.
   */
  public async delete(
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string = 'default'
  ): Promise<void> {
    const deleteLogger = this.logger.child({ kind, name, namespace });
    
    try {
      // The delete method of KubernetesObjectApi takes the object to delete first,
      // then an optional V1DeleteOptions object.
      await this.k8sApi.delete({
        apiVersion,
        kind,
        metadata: { name, namespace },
      } as any);
      deleteLogger.debug('Resource deleted');
    } catch (error: any) {
      // Don't throw if resource is already not found during deletion
      if (error.statusCode === 404) {
        deleteLogger.warn('Resource not found during deletion attempt, assuming already deleted');
        return;
      }
      deleteLogger.error('Error deleting resource', error);
      throw new Error(`Failed to delete Kubernetes resource: ${error.message}`);
    }
  }
}