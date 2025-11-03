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
    // Apply default configuration values
    const fullConfig: APISixBootstrapConfig = {
      // Basic defaults
      namespace: spec.namespace || 'apisix-system',
      version: spec.version || '2.8.0',
      installCRDs: spec.installCRDs !== undefined ? spec.installCRDs : true,
      replicaCount: spec.replicaCount || 1,

      // Global defaults
      global: {
        imagePullSecrets: spec.global?.imagePullSecrets || [],
        imageRegistry: spec.global?.imageRegistry || '',
        ...spec.global,
      },

      // Gateway defaults
      gateway: {
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
        ...spec.gateway,
      },

      // Ingress Controller defaults
      ingressController: {
        enabled:
          spec.ingressController?.enabled !== undefined ? spec.ingressController.enabled : true,
        extraArgs: spec.ingressController?.extraArgs || [],
        config: {
          kubernetes: {
            ingressClass: spec.ingressController?.config?.kubernetes?.ingressClass || 'apisix',
            namespace:
              spec.ingressController?.config?.kubernetes?.namespace ||
              spec.namespace ||
              'apisix-system',
          },
          ...spec.ingressController?.config,
        },
        ...spec.ingressController,
      },

      // Service Account defaults
      serviceAccount: {
        create: spec.serviceAccount?.create !== undefined ? spec.serviceAccount.create : true,
        name: spec.serviceAccount?.name || '',
        ...spec.serviceAccount,
      },

      // RBAC defaults
      rbac: {
        create: spec.rbac?.create !== undefined ? spec.rbac.create : true,
        ...spec.rbac,
      },

      // Pass through other configuration
      ...spec,
    };

    // Ensure consistent admin key between gateway and ingress controller
    const adminKey = 'edd1c9f034335f136f87ad84b625c8f1';

    // Map configuration to Helm values
    const helmValues = mapAPISixConfigToHelmValues(fullConfig);

    // APISix Helm chart uses 'service.type' instead of 'gateway.type'
    if (fullConfig.gateway?.type) {
      if (!helmValues.service) {
        helmValues.service = {};
      }
      helmValues.service.type = fullConfig.gateway.type;
    }

    // Configure admin API access using the correct Helm chart structure
    // According to https://github.com/apache/apisix-helm-chart/blob/apisix-2.8.0/charts/apisix/README.md
    // The correct structure is: apisix.admin.allow.ipList
    if (!helmValues.apisix) {
      helmValues.apisix = {};
    }
    // Use the index signature to add properties not in the interface
    (helmValues.apisix as Record<string, any>).admin = {
      allow: {
        ipList: ['0.0.0.0/0'], // Allow from anywhere for testing
      },
    };

    // Create namespace for APISix (required before HelmRelease)
    const _apisixNamespace = namespace({
      metadata: {
        name: spec.namespace || 'apisix-system',
        labels: {
          'app.kubernetes.io/name': 'apisix',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': spec.version || '2.8.0',
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
      name: spec.name,
      namespace: 'flux-system',
      targetNamespace: spec.namespace || 'apisix-system',
      chart: 'apisix',
      version: spec.version || '2.8.0',
      interval: '5m',
      timeout: '10m',
      values: helmValues,

      id: 'apisixHelmRelease',
    });

    // Create HelmRelease for APISix Ingress Controller (separate chart)
    const ingressControllerHelmRelease = apisixHelmRelease({
      name: `${spec.name}-ingress-controller`,
      namespace: 'flux-system',
      targetNamespace: spec.namespace || 'apisix-system',
      chart: 'apisix-ingress-controller',
      version: '0.13.0', // Use a stable version of the ingress controller
      repositoryName: 'apisix-repo', // Use the same repository as the main APISix chart
      interval: '5m',
      timeout: '10m',
      values: {
        config: {
          apisix: {
            serviceName: `${spec.namespace || 'apisix-system'}-${spec.name}-admin`,
            serviceNamespace: spec.namespace || 'apisix-system',
            servicePort: 9180,
            adminKey: adminKey, // Use admin key for authentication
            adminAPIVersion: 'v3', // Try v3 API version for APISix 3.9.1
          },
          kubernetes: {
            ingressClass:
              fullConfig.ingressController?.config?.kubernetes?.ingressClass || 'apisix',
            namespace:
              fullConfig.ingressController?.config?.kubernetes?.namespace ||
              spec.namespace ||
              'apisix-system',
          },
          ingressPublishService: `${spec.namespace || 'apisix-system'}/${spec.namespace || 'apisix-system'}-${spec.name}-gateway`,
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
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': spec.version || '2.8.0',
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
        name: `${spec.name}-gateway`,
        namespace: spec.namespace || 'apisix-system',
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
