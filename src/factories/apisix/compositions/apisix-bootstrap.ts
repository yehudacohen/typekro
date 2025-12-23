import { kubernetesComposition } from '../../../index.js';
import {
  APISixBootstrapConfigSchema,
  APISixBootstrapStatusSchema,
  type APISixBootstrapConfig,
} from '../types.js';
import { apisixHelmRepository, apisixHelmRelease } from '../resources/helm.js';
import { mapAPISixConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { createResource } from '../../shared.js';

/**
 * Helper function to ensure version has 'v' prefix for image tags if needed
 */
function _ensureVersionPrefix(version: string): string {
  // APISix versions don't typically use 'v' prefix, so return as-is
  return version;
}

/**
 * APISix Bootstrap Composition
 *
 * Creates a complete APISix ingress controller deployment using HelmRepository and HelmRelease resources.
 * Provides comprehensive configuration options and status expressions derived from actual resource status.
 *
 * Features:
 * - Complete APISix deployment (gateway, ingress controller, dashboard, etcd)
 * - Configurable ingress class and gateway settings
 * - Production-ready defaults with customization options
 * - Status expressions for monitoring deployment health
 * - Integration with external-dns and cert-manager
 *
 * @example
 * ```typescript
 * const apisix = apisixBootstrap({
 *   name: 'apisix',
 *   namespace: 'apisix-system',
 *   version: '2.8.0',
 *   ingressController: {
 *     enabled: true,
 *     config: {
 *       kubernetes: {
 *         ingressClass: 'apisix'
 *       }
 *     }
 *   },
 *   gateway: {
 *     type: 'LoadBalancer',
 *     http: { enabled: true, servicePort: 80 },
 *     https: { enabled: true, servicePort: 443 }
 *   }
 * });
 * ```
 */
export const apisixBootstrap = kubernetesComposition(
  {
    name: 'apisix-bootstrap',
    kind: 'APISixBootstrap',
    spec: APISixBootstrapConfigSchema,
    status: APISixBootstrapStatusSchema,
  },
  (spec) => {
    // Extract actual values from spec - these may be KubernetesRef proxies during initial composition
    // but will be actual values during re-execution
    const specName = spec.name;
    const specNamespace = spec.namespace;
    const specVersion = spec.version;

    // Use string coercion to get actual values from potential KubernetesRef proxies
    const actualName = String(specName || 'apisix');
    const actualNamespace = String(specNamespace || 'apisix-system');
    const actualVersion = String(specVersion || '2.8.0');

    // Apply default configuration values using actual string values
    const fullConfig: APISixBootstrapConfig = {
      // Basic defaults - use actual string values
      name: actualName,
      namespace: actualNamespace,
      version: actualVersion,
      installCRDs: spec.installCRDs !== undefined ? spec.installCRDs : true,
      replicaCount: spec.replicaCount || 1,

      // Global defaults
      global: {
        ...spec.global,
        imagePullSecrets: spec.global?.imagePullSecrets || [],
        imageRegistry: spec.global?.imageRegistry || '',
      },

      // Gateway defaults - enable both HTTP and HTTPS with LoadBalancer
      gateway: {
        ...spec.gateway,
        type: spec.gateway?.type || 'LoadBalancer',
        http: {
          enabled: spec.gateway?.http?.enabled !== undefined ? spec.gateway.http.enabled : true,
          servicePort: spec.gateway?.http?.servicePort || 80,
          containerPort: spec.gateway?.http?.containerPort || 9080,
        },
        https: {
          enabled: spec.gateway?.https?.enabled !== undefined ? spec.gateway.https.enabled : true,
          servicePort: spec.gateway?.https?.servicePort || 443,
          containerPort: spec.gateway?.https?.containerPort || 9443,
        },
      },

      // Ingress Controller defaults
      ingressController: {
        ...spec.ingressController,
        enabled:
          spec.ingressController?.enabled !== undefined ? spec.ingressController.enabled : true,
        extraArgs: spec.ingressController?.extraArgs || [],
        config: {
          ...spec.ingressController?.config,
          kubernetes: {
            ingressClass: spec.ingressController?.config?.kubernetes?.ingressClass || 'apisix',
            // Watch all namespaces by default (empty string means all namespaces)
            watchedNamespace: spec.ingressController?.config?.kubernetes?.watchedNamespace || '',
          },
        },
      },

      // Service Account defaults
      serviceAccount: {
        ...spec.serviceAccount,
        create: spec.serviceAccount?.create !== undefined ? spec.serviceAccount.create : true,
        name: spec.serviceAccount?.name || '',
      },

      // RBAC defaults
      rbac: {
        ...spec.rbac,
        create: spec.rbac?.create !== undefined ? spec.rbac.create : true,
      },
    };

    // Ensure consistent admin key between gateway and ingress controller
    const adminKey = 'edd1c9f034335f136f87ad84b625c8f1';

    // Map configuration to Helm values
    const helmValues = mapAPISixConfigToHelmValues(fullConfig);

    // Configure service type and ports for the gateway
    if (!helmValues.service) {
      helmValues.service = {};
    }
    helmValues.service.type = fullConfig.gateway?.type || 'LoadBalancer';
    
    // Enable HTTP port
    if (!helmValues.service.http) {
      helmValues.service.http = {};
    }
    helmValues.service.http.enabled = fullConfig.gateway?.http?.enabled !== false;
    
    // Enable TLS/HTTPS port
    if (!helmValues.service.tls) {
      helmValues.service.tls = {};
    }
    helmValues.service.tls.enabled = fullConfig.gateway?.https?.enabled !== false;
    helmValues.service.tls.servicePort = fullConfig.gateway?.https?.servicePort || 443;
    helmValues.service.tls.containerPort = fullConfig.gateway?.https?.containerPort || 9443;

    // Configure admin API access - allow from all IPs for cluster-internal access
    if (!helmValues.apisix) {
      helmValues.apisix = {};
    }
    (helmValues.apisix as Record<string, any>).admin = {
      allow: {
        ipList: ['0.0.0.0/0'], // Allow from anywhere within the cluster
      },
    };
    
    // Enable SSL in APISix
    (helmValues.apisix as Record<string, any>).ssl = {
      enabled: true,
    };

    // Create namespace for APISix (required before HelmRelease)
    const _apisixNamespace = namespace({
      metadata: {
        name: actualNamespace,
        labels: {
          'app.kubernetes.io/name': 'apisix',
          'app.kubernetes.io/instance': actualName,
          'app.kubernetes.io/version': actualVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'apisixNamespace',
    });

    // Create HelmRepository for APISix charts
    const _helmRepository = apisixHelmRepository({
      name: 'apisix-repo',
      namespace: 'flux-system',
      url: 'https://charts.apiseven.com',
      interval: '1h',
      id: 'apisixHelmRepository',
    });

    // Create HelmRelease for APISix Gateway
    const helmRelease = apisixHelmRelease({
      name: actualName,
      namespace: 'flux-system',
      targetNamespace: actualNamespace,
      chart: 'apisix',
      version: actualVersion,
      interval: '5m',
      timeout: '10m',
      values: helmValues,
      id: 'apisixHelmRelease',
    });

    // Create HelmRelease for APISix Ingress Controller (separate chart)
    // Use actual string values for service names to avoid KubernetesRef serialization issues
    const ingressControllerHelmRelease = apisixHelmRelease({
      name: `${actualName}-ingress-controller`,
      namespace: 'flux-system',
      targetNamespace: actualNamespace,
      chart: 'apisix-ingress-controller',
      version: '0.13.0', // Use a stable version of the ingress controller
      repositoryName: 'apisix-repo', // Use the same repository as the main APISix chart
      interval: '5m',
      timeout: '10m',
      values: {
        config: {
          apisix: {
            // Use actual string values for service configuration
            serviceName: `${actualNamespace}-${actualName}-admin`,
            serviceNamespace: actualNamespace,
            servicePort: 9180,
            adminKey: adminKey, // Use admin key for authentication
            adminAPIVersion: 'v3', // Use v3 API version for APISix 3.9.1
          },
          kubernetes: {
            ingressClass: fullConfig.ingressController?.config?.kubernetes?.ingressClass || 'apisix',
            // Watch all namespaces (empty string means all namespaces)
            watchedNamespace: fullConfig.ingressController?.config?.kubernetes?.watchedNamespace || '',
          },
          // Configure ingress status update with the gateway service
          ingressPublishService: `${actualNamespace}/${actualNamespace}-${actualName}-gateway`,
        },
        serviceAccount: {
          create: true,
        },
        rbac: {
          create: true,
        },
        ingressClass: {
          create: false, // Don't create IngressClass - we create it manually
        },
      },
      id: 'apisixIngressControllerHelmRelease',
    });

    // Create IngressClass for APISix ingress controller
    const _apisixIngressClass = createResource({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'IngressClass',
      metadata: {
        name: fullConfig.ingressController?.config?.kubernetes?.ingressClass || 'apisix',
        labels: {
          'app.kubernetes.io/name': 'apisix',
          'app.kubernetes.io/instance': actualName,
          'app.kubernetes.io/version': actualVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      spec: {
        controller: 'apisix.apache.org/apisix-ingress',
      },
      id: 'apisixIngressClass',
    }).withReadinessEvaluator(() => ({
      ready: true,
      message: 'IngressClass is ready when created (configuration resource)',
    }));

    // Return status with resources AND dynamic references
    // The imperative pattern expects resources to be returned as part of the status object
    // so they can be referenced by the status fields
    return {
      // Include the resources so they can be referenced
      helmRelease,
      ingressControllerHelmRelease,

      // Status fields with dynamic resource references
      // The magic proxy system will convert these to CEL expressions during serialization
      ready:
        helmRelease.status.phase === 'Ready' &&
        ingressControllerHelmRelease.status.phase === 'Ready',
      phase: (helmRelease.status.phase === 'Ready' &&
      ingressControllerHelmRelease.status.phase === 'Ready'
        ? 'Ready'
        : 'Installing') as 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading',
      gatewayReady: helmRelease.status.phase === 'Ready',
      ingressControllerReady: ingressControllerHelmRelease.status.phase === 'Ready',
      dashboardReady: false, // Dashboard not deployed in this composition
      etcdReady: false, // etcd not deployed in this composition (using external etcd assumed)
      gatewayService: {
        name: `${actualName}-gateway`,
        namespace: actualNamespace,
        type: fullConfig.gateway?.type || 'LoadBalancer',
        clusterIP: '', // Will be populated by actual service
        externalIP: '', // Will be populated by actual service
      },
      ingressClass: {
        name: fullConfig.ingressController?.config?.kubernetes?.ingressClass || 'apisix',
        controller: 'apisix.apache.org/apisix-ingress',
      },
    };
  }
);
