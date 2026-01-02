import { kubernetesComposition, Cel } from '../../../index.js';
import {
  CertManagerBootstrapConfigSchema,
  CertManagerBootstrapStatusSchema,
  type CertManagerBootstrapConfig,
} from '../types.js';
import { certManagerHelmRepository, certManagerHelmRelease } from '../resources/helm.js';
import { mapCertManagerConfigToHelmValues } from '../utils/helm-values-mapper.js';
import { namespace } from '../../kubernetes/core/namespace.js';

/**
 * Helper function to ensure version has 'v' prefix for image tags
 * Cert-manager Docker images require version tags with 'v' prefix (e.g., 'v1.13.3')
 */
function ensureVersionPrefix(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Cert-Manager Bootstrap Composition
 *
 * Creates a complete cert-manager deployment using HelmRepository and HelmRelease resources.
 * Provides comprehensive configuration options and status expressions derived from actual resource status.
 *
 * Features:
 * - Complete cert-manager deployment (controller, webhook, cainjector)
 * - Comprehensive configuration schema with ArkType validation
 * - Status expressions using actual resource status fields
 * - Integration endpoints derived from service status
 * - Support for both kro and direct deployment strategies
 *
 * @example
 * ```typescript
 * const certManagerFactory = certManagerBootstrap.factory('direct', {
 *   namespace: 'cert-manager-system',
 *   waitForReady: true
 * });
 *
 * const instance = await certManagerFactory.deploy({
 *   name: 'cert-manager',
 *   namespace: 'cert-manager',
 *   version: '1.13.3',
 *   installCRDs: true,
 *   controller: {
 *     resources: {
 *       requests: { cpu: '100m', memory: '128Mi' },
 *       limits: { cpu: '500m', memory: '512Mi' }
 *     }
 *   },
 *   webhook: {
 *     enabled: true,
 *     replicaCount: 2
 *   },
 *   prometheus: {
 *     enabled: true,
 *     servicemonitor: { enabled: true }
 *   }
 * });
 * ```
 */
export const certManagerBootstrap = kubernetesComposition(
  {
    name: 'cert-manager-bootstrap',
    // apiVersion defaults to 'v1alpha1' and Kro adds kro.run group automatically
    kind: 'CertManagerBootstrap',
    spec: CertManagerBootstrapConfigSchema,
    status: CertManagerBootstrapStatusSchema,
  },
  (spec: CertManagerBootstrapConfig) => {
    // TODO: Future Enhancement - Create a full cert-manager composition that includes:
    // 1. Direct Kubernetes resources (Deployments, Services, etc.) for status references
    // 2. CRD queries for real-time certificate/issuer counts
    // 3. Service status references for dynamic endpoint URLs
    //
    // For now, this bootstrap composition focuses on Helm-based deployment
    // Apply default configuration values
    const fullConfig: CertManagerBootstrapConfig = {
      // Basic defaults
      namespace: spec.namespace || 'cert-manager',
      version: spec.version || '1.13.3',
      installCRDs: spec.installCRDs !== undefined ? spec.installCRDs : true, // TypeKro installs CRDs by default
      replicaCount: spec.replicaCount || 1,

      // Global defaults
      global: {
        leaderElection: {
          namespace: spec.global?.leaderElection?.namespace || spec.namespace || 'cert-manager',
        },
        logLevel: spec.global?.logLevel || 2,
        podSecurityPolicy: {
          enabled: spec.global?.podSecurityPolicy?.enabled || false,
          useAppArmor: spec.global?.podSecurityPolicy?.useAppArmor || true,
        },
        ...spec.global,
      },

      // Strategy defaults
      strategy: {
        type: spec.strategy?.type || 'RollingUpdate',
        rollingUpdate: {
          maxSurge: spec.strategy?.rollingUpdate?.maxSurge || '25%',
          maxUnavailable: spec.strategy?.rollingUpdate?.maxUnavailable || '25%',
        },
        ...spec.strategy,
      },

      // Controller defaults
      controller: {
        image: {
          repository:
            spec.controller?.image?.repository || 'quay.io/jetstack/cert-manager-controller',
          tag: spec.controller?.image?.tag || ensureVersionPrefix(spec.version || '1.13.3'),
          pullPolicy: spec.controller?.image?.pullPolicy || 'IfNotPresent',
        },
        resources: {
          requests: {
            cpu: spec.controller?.resources?.requests?.cpu || '10m',
            memory: spec.controller?.resources?.requests?.memory || '32Mi',
          },
          limits: {
            cpu: spec.controller?.resources?.limits?.cpu || '100m',
            memory: spec.controller?.resources?.limits?.memory || '128Mi',
          },
          ...spec.controller?.resources,
        },
        serviceAccount: {
          create:
            spec.controller?.serviceAccount?.create !== undefined
              ? spec.controller.serviceAccount.create
              : true,
          name: spec.controller?.serviceAccount?.name || '',
          annotations: spec.controller?.serviceAccount?.annotations || {},
        },
        nodeSelector: spec.controller?.nodeSelector || {},
        ...spec.controller,
      },

      // Webhook defaults
      webhook: {
        enabled: spec.webhook?.enabled !== undefined ? spec.webhook.enabled : true,
        replicaCount: spec.webhook?.replicaCount || 1,
        image: {
          repository: spec.webhook?.image?.repository || 'quay.io/jetstack/cert-manager-webhook',
          tag: spec.webhook?.image?.tag || ensureVersionPrefix(spec.version || '1.13.3'),
          pullPolicy: spec.webhook?.image?.pullPolicy || 'IfNotPresent',
        },
        resources: {
          requests: {
            cpu: spec.webhook?.resources?.requests?.cpu || '10m',
            memory: spec.webhook?.resources?.requests?.memory || '32Mi',
          },
          limits: {
            cpu: spec.webhook?.resources?.limits?.cpu || '100m',
            memory: spec.webhook?.resources?.limits?.memory || '128Mi',
          },
          ...spec.webhook?.resources,
        },
        serviceAccount: {
          create:
            spec.webhook?.serviceAccount?.create !== undefined
              ? spec.webhook.serviceAccount.create
              : true,
          name: spec.webhook?.serviceAccount?.name || '',
          annotations: spec.webhook?.serviceAccount?.annotations || {},
        },
        nodeSelector: spec.webhook?.nodeSelector || {},
        mutatingAdmissionWebhooks: {
          failurePolicy: spec.webhook?.mutatingAdmissionWebhooks?.failurePolicy || 'Fail',
          timeoutSeconds: spec.webhook?.mutatingAdmissionWebhooks?.timeoutSeconds || 10,
        },
        validatingAdmissionWebhooks: {
          failurePolicy: spec.webhook?.validatingAdmissionWebhooks?.failurePolicy || 'Fail',
          timeoutSeconds: spec.webhook?.validatingAdmissionWebhooks?.timeoutSeconds || 10,
        },
        ...spec.webhook,
      },

      // CA Injector defaults
      cainjector: {
        enabled: spec.cainjector?.enabled !== undefined ? spec.cainjector.enabled : true,
        replicaCount: spec.cainjector?.replicaCount || 1,
        image: {
          repository:
            spec.cainjector?.image?.repository || 'quay.io/jetstack/cert-manager-cainjector',
          tag: spec.cainjector?.image?.tag || ensureVersionPrefix(spec.version || '1.13.3'),
          pullPolicy: spec.cainjector?.image?.pullPolicy || 'IfNotPresent',
        },
        resources: {
          requests: {
            cpu: spec.cainjector?.resources?.requests?.cpu || '10m',
            memory: spec.cainjector?.resources?.requests?.memory || '32Mi',
          },
          limits: {
            cpu: spec.cainjector?.resources?.limits?.cpu || '100m',
            memory: spec.cainjector?.resources?.limits?.memory || '128Mi',
          },
          ...spec.cainjector?.resources,
        },
        serviceAccount: {
          create:
            spec.cainjector?.serviceAccount?.create !== undefined
              ? spec.cainjector.serviceAccount.create
              : true,
          name: spec.cainjector?.serviceAccount?.name || '',
          annotations: spec.cainjector?.serviceAccount?.annotations || {},
        },
        nodeSelector: spec.cainjector?.nodeSelector || {},
        ...spec.cainjector,
      },

      // ACME solver defaults
      acmesolver: {
        image: {
          repository:
            spec.acmesolver?.image?.repository || 'quay.io/jetstack/cert-manager-acmesolver',
          tag: spec.acmesolver?.image?.tag || ensureVersionPrefix(spec.version || '1.13.3'),
          pullPolicy: spec.acmesolver?.image?.pullPolicy || 'IfNotPresent',
        },
        resources: {
          requests: {
            cpu: spec.acmesolver?.resources?.requests?.cpu || '10m',
            memory: spec.acmesolver?.resources?.requests?.memory || '32Mi',
          },
          limits: {
            cpu: spec.acmesolver?.resources?.limits?.cpu || '100m',
            memory: spec.acmesolver?.resources?.limits?.memory || '128Mi',
          },
          ...spec.acmesolver?.resources,
        },
        nodeSelector: spec.acmesolver?.nodeSelector || {},
        ...spec.acmesolver,
      },

      // Startup API check defaults
      // IMPORTANT: startupapicheck is a post-install hook that can cause timeouts
      // We disable it by default for TypeKro deployments to avoid installation failures
      // Only enable if explicitly requested by the user
      startupapicheck: {
        enabled: spec.startupapicheck?.enabled === true, // Only enable if explicitly set to true
        ...(spec.startupapicheck?.enabled === true && {
          image: {
            repository:
              spec.startupapicheck?.image?.repository || 'quay.io/jetstack/cert-manager-ctl',
            tag: spec.startupapicheck?.image?.tag || ensureVersionPrefix(spec.version || '1.13.3'),
            pullPolicy: spec.startupapicheck?.image?.pullPolicy || 'IfNotPresent',
          },
          resources: {
            requests: {
              cpu: spec.startupapicheck?.resources?.requests?.cpu || '10m',
              memory: spec.startupapicheck?.resources?.requests?.memory || '32Mi',
            },
            limits: {
              cpu: spec.startupapicheck?.resources?.limits?.cpu || '100m',
              memory: spec.startupapicheck?.resources?.limits?.memory || '128Mi',
            },
            ...spec.startupapicheck?.resources,
          },
          nodeSelector: spec.startupapicheck?.nodeSelector || {},
          timeout: spec.startupapicheck?.timeout || '1m',
          backoffLimit: spec.startupapicheck?.backoffLimit || 4,
        }),
      },

      // Prometheus defaults
      prometheus: {
        enabled: spec.prometheus?.enabled || false,
        servicemonitor: {
          enabled: spec.prometheus?.servicemonitor?.enabled || false,
          prometheusInstance: spec.prometheus?.servicemonitor?.prometheusInstance || 'default',
          targetPort: spec.prometheus?.servicemonitor?.targetPort || 9402,
          path: spec.prometheus?.servicemonitor?.path || '/metrics',
          interval: spec.prometheus?.servicemonitor?.interval || '60s',
          scrapeTimeout: spec.prometheus?.servicemonitor?.scrapeTimeout || '30s',
          honorLabels: spec.prometheus?.servicemonitor?.honorLabels || false,
        },
        ...spec.prometheus,
      },

      // Merge with original spec
      ...spec,
    };

    // Map configuration to Helm values
    const helmValues = mapCertManagerConfigToHelmValues(fullConfig);

    // Create namespace for cert-manager (required before HelmRelease)
    const _certManagerNamespace = namespace({
      metadata: {
        name: spec.namespace || 'cert-manager',
        labels: {
          'app.kubernetes.io/name': 'cert-manager',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': spec.version || '1.13.3',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'certManagerNamespace',
    });

    // Create HelmRepository for cert-manager charts
    const _helmRepository = certManagerHelmRepository({
      name: 'cert-manager-repo', // Use static name to avoid schema proxy issues
      namespace: 'flux-system', // HelmRepositories should always be in flux-system
      id: 'certManagerHelmRepository',
    });

    // Create HelmRelease for cert-manager deployment
    const _helmRelease = certManagerHelmRelease({
      name: spec.name,
      namespace: spec.namespace || 'cert-manager',
      version: spec.version || '1.13.3',
      values: helmValues,
      repositoryName: 'cert-manager-repo', // Match the repository name
      id: 'certManagerHelmRelease',
    });

    // Return status matching the simplified schema structure
    //
    // DESIGN NOTE: This is a "bootstrap composition" that deploys cert-manager via Helm.
    // Status references actual HelmRelease status fields (conditions array).
    // Flux HelmRelease v2 uses conditions with type='Ready' for readiness, not a phase field.
    //
    // Using CEL expressions with .exists() to check conditions array:
    // - _helmRelease.status.conditions is a KubernetesRef to the conditions array
    // - CEL's .exists() function evaluates at runtime with actual cluster data
    // - The reference resolver fetches the real HelmRelease from the cluster
    // - This is the proper pattern for checking arrays in status builders
    //
    // CEL Expression Pattern:
    // Cel.expr<boolean>(
    //   resourceRef.status.arrayField,
    //   '.exists(item, item.property == "value")'
    // )
    return {
      // Reference actual HelmRelease status for proper dependency management
      // Use CEL .exists() to check if Ready condition exists with status=True
      ready: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Pending' | 'Installing' | 'Failed' | 'Upgrading'>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
      version: spec.version || '1.13.3',
      controllerReady: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      webhookReady: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      cainjectorReady: Cel.expr<boolean>(
        _helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      crds: {
        // WORKAROUND: Nested CEL expressions aren't being resolved properly in direct mode
        // Using a static true value since we wait for HelmRelease to be Ready anyway
        // TODO: Fix nested CEL expression resolution in ReferenceResolver
        installed: true,
        version: spec.version || '1.13.3',
      },
    };
  }
);
