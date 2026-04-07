import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import { Cel } from '../../../core/references/cel.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { createResource } from '../../shared.js';
import { apisixHelmRelease, apisixHelmRepository } from '../resources/helm.js';
import {
  type APISixBootstrapConfig,
  APISixBootstrapConfigSchema,
  APISixBootstrapStatusSchema,
} from '../types.js';
import { resolveAdminCredentials } from '../utils/admin-credentials.js';
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

      // etcd defaults — single replica to avoid scheduling issues on
      // single-node clusters and reduce resource usage for dev/test.
      // Production users should explicitly set etcd.replicaCount: 3.
      etcd: {
        ...spec.etcd,
        enabled: spec.etcd?.enabled !== undefined ? spec.etcd.enabled : true,
        replicaCount: spec.etcd?.replicaCount || 1,
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
    //
    // @security Credentials are resolved in priority order:
    //   1. Explicit spec values (gateway.adminCredentials)
    //   2. APISIX_ADMIN_KEY / APISIX_VIEWER_KEY environment variables
    //   3. Development-only chart defaults (a warning is logged)
    //
    // For production deployments, always provide credentials via the spec or
    // environment variables.
    if (!helmValues.apisix) {
      helmValues.apisix = {};
    }
    /** @security Resolved admin credentials — never log these values. */
    // Allow defaults during composition definition (proxy execution) and
    // when the user hasn't provided explicit credentials. The real
    // enforcement happens at the APISIX server itself — if it starts with
    // dev defaults in production, the operator is responsible for the
    // security posture, not the composition.
    const adminCredentials = resolveAdminCredentials(
      fullConfig.gateway?.adminCredentials,
      { allowDefaults: true }
    );
    (helmValues.apisix as Record<string, any>).admin = {
      enabled: true,
      type: 'ClusterIP',
      credentials: {
        admin: adminCredentials.admin,
        viewer: adminCredentials.viewer,
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
      namespace: DEFAULT_FLUX_NAMESPACE,
      url: 'https://charts.apiseven.com',
      interval: '1h',
      id: 'apisixHelmRepository',
    });

    // Create single HelmRelease for APISIX (gateway + ingress controller + etcd)
    // Chart v2.13.0 bundles the ingress controller as a subchart dependency
    const helmRelease = apisixHelmRelease({
      name: actualName,
      namespace: DEFAULT_FLUX_NAMESPACE,
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
    }).withReadinessEvaluator(createAlwaysReadyEvaluator('IngressClass'));

    // Return status with CEL expressions referencing HelmRelease conditions
    // Flux HelmRelease v2 uses conditions array (not a phase field).
    // We use CEL .exists() to check for the Ready condition.
    return {
      helmRelease,

      ready: Cel.expr<boolean>(
        helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading'>(
        helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      gatewayReady: Cel.expr<boolean>(
        helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      ingressControllerReady: Cel.expr<boolean>(
        helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
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
