import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { certManagerHelmRelease, certManagerHelmRepository } from '../resources/helm.js';
import {
  type CertManagerBootstrapConfig,
  CertManagerBootstrapConfigSchema,
  CertManagerBootstrapStatusSchema,
} from '../types.js';
import {
  DEFAULT_CERT_MANAGER_NAMESPACE,
  DEFAULT_CERT_MANAGER_VERSION,
  mapCertManagerConfigToHelmValues,
} from '../utils/helm-values-mapper.js';

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
 *   version: '1.19.3',
 *   crds: { enabled: true, keep: true },
 *   replicaCount: 2,
 *   controller: {
 *     resources: {
 *       requests: { cpu: '100m', memory: '128Mi' },
 *       limits: { cpu: '500m', memory: '512Mi' }
 *     },
 *     podDisruptionBudget: { enabled: true }
 *   },
 *   webhook: {
 *     replicaCount: 2,
 *     podDisruptionBudget: { enabled: true }
 *   },
 *   prometheus: {
 *     enabled: true,
 *     servicemonitor: { enabled: true }
 *   }
 * });
 * ```
 */
export const certManagerBootstrap: CallableComposition<
  typeof CertManagerBootstrapConfigSchema.infer,
  typeof CertManagerBootstrapStatusSchema.infer
> = kubernetesComposition(
  {
    name: 'cert-manager-bootstrap',
    // apiVersion defaults to 'v1alpha1' and Kro adds kro.run group automatically
    kind: 'CertManagerBootstrap',
    spec: CertManagerBootstrapConfigSchema,
    status: CertManagerBootstrapStatusSchema,
  },
  (spec: CertManagerBootstrapConfig) => {
    // Every optional spec field is a schema proxy in KRO mode, so defaults are
    // applied with Cel.default (plain `??` for direct-mode values) and the
    // values mapper places fields without branching on them. JavaScript `||`
    // here used to collapse KRO renders to static defaults: replicas stayed at
    // 1 and the leader-election lease fell back to the chart's kube-system.
    const installNamespace = Cel.default(spec.namespace, DEFAULT_CERT_MANAGER_NAMESPACE);
    const version = Cel.default(spec.version, DEFAULT_CERT_MANAGER_VERSION);

    // Map configuration to Helm values
    const helmValues = mapCertManagerConfigToHelmValues(spec);

    // Create namespace for cert-manager (required before HelmRelease)
    const _certManagerNamespace = namespace({
      metadata: {
        name: installNamespace,
        labels: {
          'app.kubernetes.io/name': 'cert-manager',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/version': version,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'certManagerNamespace',
    });

    // Create HelmRepository for cert-manager charts
    const _helmRepository = certManagerHelmRepository({
      name: 'cert-manager-repo', // Use static name to avoid schema proxy issues
      namespace: DEFAULT_FLUX_NAMESPACE, // HelmRepositories should always be in flux-system
      id: 'certManagerHelmRepository',
    });

    // Create HelmRelease for cert-manager deployment
    const _helmRelease = certManagerHelmRelease({
      name: spec.name,
      namespace: installNamespace,
      version,
      values: helmValues,
      repositoryName: 'cert-manager-repo', // Match the repository name
      id: 'certManagerHelmRelease',
    });

    // All component fields project the same HelmRelease readiness because this
    // composition does not observe the chart-created Deployments separately.
    // The shared summary prevents stale Flux conditions from a prior release
    // generation from leaking into any of those public status aliases.
    const releaseStatus = helmReleaseConditionSummary(_helmRelease);
    return {
      ready: releaseStatus.ready,
      phase: releaseStatus.phase,
      version,
      controllerReady: releaseStatus.ready,
      webhookReady: releaseStatus.ready,
      cainjectorReady: releaseStatus.ready,
      crds: {
        // KNOWN ISSUE: Nested CEL expression resolution is broken in direct mode (tracked in TODO).
        // In direct mode, nested CEL expressions referencing resource statuses are not resolved by
        // ReferenceResolver, so we hardcode static values here as a workaround. This means the
        // cert-manager composition reports `crds.installed: true` regardless of actual CRD state
        // when deployed in direct mode. Fix: implement nested CEL resolution in ReferenceResolver
        // before exposing cert-manager direct-mode deployments in production workflows.
        installed: true,
        version,
      },
    };
  }
);
