import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import type {
  DirectResourceFactory,
  KroResourceFactory,
  PublicFactoryOptions,
} from '../../../core/types/deployment.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { apisixHelmRelease, apisixHelmRepository } from '../resources/helm.js';
import {
  type APISixBootstrapConfig,
  type APISixBootstrapStatus,
  APISixBootstrapConfigSchema,
  APISixBootstrapStatusSchema,
} from '../types.js';
import { resolveAdminCredentials } from '../utils/admin-credentials.js';
import { mapAPISixConfigToHelmValues } from '../utils/helm-values-mapper.js';

/**
 * APISix Bootstrap Composition
 *
 * Creates a complete APISIX gateway deployment using HelmRepository and HelmRelease resources.
 * Uses chart v2.13.0 for the APISIX gateway and etcd. The chart's ingress-controller
 * subchart is intentionally disabled to avoid its duplicate ServiceAccount template conflict.
 *
 * Features:
 * - Complete APISIX deployment (gateway and etcd)
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
function createApisixBootstrap(requireDefinitionCredentials = false) {
  return kubernetesComposition(
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

    // Ingress config compatibility defaults. The chart subchart remains disabled below.
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

      ...(spec.apisix && { apisix: { ...spec.apisix } }),
      ...(spec.dashboard && { dashboard: { ...spec.dashboard } }),
      ...(spec.customValues && { customValues: { ...spec.customValues } }),
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
    //   3. Test-environment-only defaults for unit tests
    //
    // For production deployments, always provide credentials via the spec or
    // environment variables.
    if (!helmValues.apisix) {
      helmValues.apisix = {};
    }
    /** @security Resolved admin credentials — never log these values. */
    // Never opt into development defaults during schema-proxy definition.
    // KRO reconciliation cannot read this process' env vars later, so omitted
    // credentials are resolved now from APISIX_* env vars or fail early.
    const ctx = getCurrentCompositionContext();
    const definitionCredentials = {
      admin: fullConfig.gateway?.adminCredentials?.admin as string | undefined,
      viewer: fullConfig.gateway?.adminCredentials?.viewer as string | undefined,
    };
    const hasDefinitionCredentials =
      typeof definitionCredentials.admin === 'string' &&
      definitionCredentials.admin.length > 0 &&
      typeof definitionCredentials.viewer === 'string' &&
      definitionCredentials.viewer.length > 0;
    const shouldRequireDefinitionCredentials =
      requireDefinitionCredentials || (ctx?.isNestedCall === true && !ctx.isReExecution);
    const adminCredentials = shouldRequireDefinitionCredentials
      ? hasDefinitionCredentials
        ? { admin: definitionCredentials.admin, viewer: definitionCredentials.viewer }
        : resolveAdminCredentials(undefined, { allowTestDefaults: false })
      : resolveAdminCredentials(fullConfig.gateway?.adminCredentials);
    (helmValues.apisix as Record<string, unknown>).admin = {
      enabled: true,
      type: 'ClusterIP',
      credentials: {
        admin: adminCredentials.admin,
        viewer: adminCredentials.viewer,
      },
    };

    // Enable SSL in APISix
    (helmValues.apisix as Record<string, unknown>).ssl = {
      enabled: true,
      containerPort: 9443,
    };

    // In chart v2.13.0, the ingress controller is available as a subchart.
    // However, enabling it causes a duplicate ServiceAccount conflict because both
    // the parent chart and subchart generate a SA with the same name (the subchart
    // template uses .Release.Name directly, not a fullname helper).
    //
    // The ingress controller subchart is needed for both APISIX CRD-based routing
    // and standard Kubernetes Ingress reconciliation. Deploy an ingress controller
    // separately if this bootstrap should serve Kubernetes Ingress resources.
    //
    // We explicitly disable the subchart to avoid the ServiceAccount conflict.
    (helmValues as Record<string, unknown>)['ingress-controller'] = {
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
    const repositoryName = 'apisix-repo';
    const _helmRepository = apisixHelmRepository({
      name: repositoryName,
      namespace: DEFAULT_FLUX_NAMESPACE,
      url: 'https://charts.apiseven.com',
      interval: '1h',
      id: 'apisixHelmRepository',
    });

    // Create single HelmRelease for APISIX (gateway + etcd). The ingress-controller
    // dependency is explicitly disabled in the chart values above.
    const helmRelease = apisixHelmRelease({
      name: actualName,
      namespace: DEFAULT_FLUX_NAMESPACE,
      targetNamespace: actualNamespace,
      chart: 'apisix',
      version: actualVersion,
      interval: '5m',
      timeout: '10m',
      values: helmValues,
      repositoryName,
      id: 'apisixHelmRelease',
    });

    // Return status with CEL expressions referencing HelmRelease conditions
    // Flux HelmRelease v2 uses conditions array (not a phase field).
    // We use CEL .exists() to check for the Ready condition.
    const helmReady = Cel.expr<boolean>(
      helmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );
    const helmFailed = Cel.expr<boolean>(
      helmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "False")'
    );
    const helmReconciling = Cel.expr<boolean>(
      helmRelease.status.conditions,
      '.exists(c, c.type == "Reconciling" && c.status == "True")'
    );
    const gatewayServicePorts: NonNullable<APISixBootstrapStatus['gatewayService']>['ports'] = [];
    if (fullConfig.gateway?.http?.enabled !== false) {
      gatewayServicePorts.push({
        name: 'http',
        port: fullConfig.gateway?.http?.servicePort || 80,
        targetPort: fullConfig.gateway?.http?.containerPort || 9080,
        protocol: 'TCP',
      });
    }
    if (fullConfig.gateway?.https?.enabled !== false) {
      gatewayServicePorts.push({
        name: 'https',
        port: fullConfig.gateway?.https?.servicePort || 443,
        targetPort: fullConfig.gateway?.https?.containerPort || 9443,
        protocol: 'TCP',
      });
    }

    return {
      ready: helmReady,
      phase: Cel.expr<'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading'>(
        helmReady,
        ' ? "Ready" : ',
        helmFailed,
        ' ? "Failed" : ',
        helmReconciling,
        ' ? "Upgrading" : "Installing"'
      ),
      gatewayReady: helmReady,
      // The APISIX ingress-controller subchart is intentionally disabled above,
      // so this bootstrap does not reconcile standard Kubernetes Ingress by itself.
      standardIngressReady: false,
      dashboardReady: fullConfig.dashboard?.enabled === false ? true : helmReady,
      etcdReady: fullConfig.etcd?.enabled === false ? true : helmReady,
      gatewayService: {
        name: `${actualName}-gateway`,
        namespace: actualNamespace,
        type: fullConfig.gateway?.type || 'NodePort',
        ports: gatewayServicePorts,
      },
    };
  }
  );
}

const apisixBootstrapBase = createApisixBootstrap(false);

const originalFactory = apisixBootstrapBase.factory.bind(apisixBootstrapBase);
function apisixBootstrapFactory(
  mode: 'kro',
  options?: PublicFactoryOptions
): KroResourceFactory<APISixBootstrapConfig, APISixBootstrapStatus>;
function apisixBootstrapFactory(
  mode: 'direct',
  options?: PublicFactoryOptions
): DirectResourceFactory<APISixBootstrapConfig, APISixBootstrapStatus>;
function apisixBootstrapFactory(
  mode: 'kro' | 'direct',
  options?: PublicFactoryOptions
):
  | KroResourceFactory<APISixBootstrapConfig, APISixBootstrapStatus>
  | DirectResourceFactory<APISixBootstrapConfig, APISixBootstrapStatus> {
  if (mode === 'kro') {
    const factory = createApisixBootstrap(false).factory('kro', options);
    const originalToYaml = factory.toYaml.bind(factory);
    (factory as { toYaml: (spec?: APISixBootstrapConfig) => string }).toYaml = (
      spec?: APISixBootstrapConfig
    ) => {
      if (spec !== undefined) {
        return originalToYaml(spec);
      }
      return createApisixBootstrap(true).factory('kro', options).toYaml();
    };
    return factory;
  }
  return originalFactory(mode, options);
}

(apisixBootstrapBase as { factory: typeof apisixBootstrapBase.factory }).factory =
  apisixBootstrapFactory;

// Keep module imports side-effect safe, but require concrete credentials when
// generating a KRO definition so omitted CR fields do not become chart defaults.
(apisixBootstrapBase as { toYaml: (spec?: APISixBootstrapConfig) => string }).toYaml = (
  spec?: APISixBootstrapConfig
) => {
  if (spec !== undefined) {
    return createApisixBootstrap(false).factory('kro').toYaml(spec);
  }
  return createApisixBootstrap(true).toYaml();
};

export const apisixBootstrap = apisixBootstrapBase;
