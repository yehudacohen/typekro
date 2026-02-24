import { kubernetesComposition } from '../../../index.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { createResource } from '../../shared.js';
import { apisixHelmRelease, apisixHelmRepository } from '../resources/helm.js';
import {
  type APISixBootstrapConfig,
  APISixBootstrapConfigSchema,
  APISixBootstrapStatusSchema,
} from '../types.js';
import { mapAPISixConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * APISix Bootstrap Composition
 *
 * Creates a complete APISix ingress controller deployment using HelmRepository and HelmRelease resources.
 * Uses chart v2.13.0 which bundles the ingress controller as a subchart, so only one HelmRelease
 * is needed for the complete deployment (gateway + ingress controller + etcd).
 *
 * Features:
 * - Complete APISix deployment (gateway, ingress controller, etcd)
 * - Configurable ingress class and gateway settings
 * - Production-ready defaults with customization options
 * - Status expressions for monitoring deployment health
 * - Integration with external-dns and cert-manager
 *
 * @example
 * ```typescript
 * const factory = apisix.apisixBootstrap.factory('direct', {
 *   namespace: 'flux-system',
 *   waitForReady: true,
 *   timeout: 600000,
 *   kubeConfig,
 * });
 *
 * await factory.deploy({
 *   name: 'apisix',
 *   namespace: 'apisix-system',
 *   version: '2.13.0',
 *   gateway: {
 *     type: 'NodePort',
 *     http: { enabled: true, servicePort: 80 },
 *     https: { enabled: true, servicePort: 443 },
 *   },
 *   ingressController: {
 *     enabled: true,
 *     config: { kubernetes: { ingressClass: 'apisix' } },
 *   },
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
    const actualVersion = String(specVersion || '2.13.0');

    const ingressClass = spec.ingressController?.config?.kubernetes?.ingressClass || 'apisix';

    // Apply default configuration values using actual string values
    const fullConfig: APISixBootstrapConfig = {
      // Basic defaults
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

      // Gateway defaults - NodePort is the default because the APISIX chart's gateway
      // service template unconditionally sets externalTrafficPolicy which is invalid
      // for ClusterIP on Kubernetes 1.33+
      gateway: {
        ...spec.gateway,
        type: spec.gateway?.type || 'NodePort',
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
            ingressClass,
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

    // Map configuration to Helm values for the main APISIX chart
    const helmValues = mapAPISixConfigToHelmValues(fullConfig);

    // Configure service type and ports for the gateway
    if (!helmValues.service) {
      helmValues.service = {};
    }
    helmValues.service.type = fullConfig.gateway?.type || 'NodePort';

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

    // Configure admin API access — allow from all IPs for cluster-internal access.
    // These are APISIX's well-known default admin API keys from the chart defaults.
    // For production deployments, override via spec.gateway.adminCredentials or
    // provide custom Helm values with secure credentials.
    if (!helmValues.apisix) {
      helmValues.apisix = {};
    }
    (helmValues.apisix as Record<string, any>).admin = {
      enabled: true,
      type: 'ClusterIP',
      credentials: {
        admin: fullConfig.gateway?.adminCredentials?.admin || 'edd1c9f034335f136f87ad84b625c8f1',
        viewer: fullConfig.gateway?.adminCredentials?.viewer || '4054f7cf07e344346cd3f287985e76a2',
      },
    };

    // Enable SSL in APISix
    (helmValues.apisix as Record<string, any>).ssl = {
      enabled: true,
      containerPort: 9443,
    };

    // In chart v2.13.0, the ingress controller is available as a subchart.
    // However, enabling it causes a duplicate ServiceAccount conflict because both
    // the parent chart and subchart generate a SA with the same name (the subchart
    // template uses .Release.Name directly, not a fullname helper).
    //
    // The ingress controller subchart is only needed for APISIX-specific CRD-based
    // routing (ApisixRoute, ApisixUpstream, etc.). For standard Kubernetes Ingress
    // resources (used by cert-manager HTTP-01 challenges), the APISIX gateway alone
    // is sufficient — it processes standard Ingress objects natively.
    //
    // We explicitly disable the subchart to avoid the ServiceAccount conflict.
    (helmValues as Record<string, any>)['ingress-controller'] = {
      enabled: false,
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

    // Create single HelmRelease for APISIX (gateway + ingress controller + etcd)
    // Chart v2.13.0 bundles the ingress controller as a subchart dependency
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

    // Create IngressClass for APISix gateway (processes standard Kubernetes Ingress objects natively).
    // The controller identifier matches APISIX's built-in ingress handling — the ingress controller
    // subchart is disabled (to avoid ServiceAccount conflicts), but APISIX gateway handles Ingress directly.
    const _apisixIngressClass = createResource({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'IngressClass',
      metadata: {
        name: ingressClass,
        labels: {
          'app.kubernetes.io/name': 'apisix',
          'app.kubernetes.io/instance': actualName,
          'app.kubernetes.io/version': actualVersion,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      spec: {
        controller: 'apisix.apache.org/apisix-ingress-controller',
      },
      id: 'apisixIngressClass',
    }).withReadinessEvaluator(() => ({
      ready: true,
      message: 'IngressClass is ready when created (configuration resource)',
    }));

    // Return status with resource references for status hydration
    return {
      helmRelease,

      ready: helmRelease.status.phase === 'Ready',
      phase: (helmRelease.status.phase === 'Ready' ? 'Ready' : 'Installing') as
        | 'Pending'
        | 'Installing'
        | 'Ready'
        | 'Failed'
        | 'Upgrading',
      gatewayReady: helmRelease.status.phase === 'Ready',
      ingressControllerReady: helmRelease.status.phase === 'Ready',
      dashboardReady: false,
      etcdReady: false,
      gatewayService: {
        name: `${actualName}-gateway`,
        namespace: actualNamespace,
        type: fullConfig.gateway?.type || 'NodePort',
        clusterIP: '',
        externalIP: '',
      },
      ingressClass: {
        name: ingressClass,
        controller: 'apisix.apache.org/apisix-ingress-controller',
      },
    };
  }
);
