/**
 * Cert-Manager Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for cert-manager deployments. These functions wrap the generic Helm factories
 * from src/factories/helm/ and provide cert-manager-specific configuration interfaces
 * while reusing existing readiness evaluators.
 */

import { withChartValueDefaults } from '../../../core/aspects/values-merge.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Enhanced } from '../../../core/types/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import type {
  CertManagerHelmReleaseConfig,
  CertManagerHelmRepositoryConfig,
  CertManagerHelmValues,
} from '../types.js';

// =============================================================================
// CERT-MANAGER HELM REPOSITORY WRAPPER
// =============================================================================

/**
 * Wrapper function for creating Cert-Manager HelmRepository resources
 *
 * This function wraps the generic `helmRepository` factory and provides
 * cert-manager-specific default configuration (official cert-manager chart repository).
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - Cert-Manager HelmRepository configuration
 * @returns Enhanced HelmRepository resource with cert-manager-specific settings
 *
 * @example
 * Basic cert-manager repository:
 * ```typescript
 * const repo = certManagerHelmRepository({
 *   name: 'cert-manager',
 *   namespace: 'flux-system'
 * });
 * ```
 *
 * @example
 * Repository with custom settings:
 * ```typescript
 * const repo = certManagerHelmRepository({
 *   name: 'cert-manager-repo',
 *   namespace: 'flux-system',
 *   url: 'https://charts.jetstack.io',
 *   interval: '10m'
 * });
 * ```
 */

/** Cert-Manager HelmRepository readiness evaluator (delegates to shared implementation) */
const certManagerHelmRepositoryReadinessEvaluator =
  createHelmRepositoryReadinessEvaluator('Cert-Manager');

export function certManagerHelmRepository(
  config: CertManagerHelmRepositoryConfig
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  // For Kro deployments, we need to avoid status expectations that conflict with actual Flux status
  // Create the resource directly without status template to avoid Kro controller conflicts
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      url: config.url || 'https://charts.jetstack.io',
      interval: config.interval || '5m',
    },
    // Omit status template to avoid conflicts with Kro controller
  }).withReadinessEvaluator(certManagerHelmRepositoryReadinessEvaluator);
}

// =============================================================================
// CERT-MANAGER HELM RELEASE WRAPPER
// =============================================================================

/**
 * Wrapper function for creating Cert-Manager HelmRelease resources
 *
 * This function wraps the generic `helmRelease` factory and provides
 * cert-manager-specific default configuration (chart name, repository reference).
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - Cert-Manager HelmRelease configuration
 * @returns Enhanced HelmRelease resource with cert-manager-specific configuration
 *
 * @example
 * Basic cert-manager release:
 * ```typescript
 * const release = certManagerHelmRelease({
 *   name: 'cert-manager',
 *   namespace: 'cert-manager',
 *   repositoryName: 'cert-manager-repo'
 * });
 * ```
 *
 * @example
 * Release with custom values:
 * ```typescript
 * const release = certManagerHelmRelease({
 *   name: 'cert-manager',
 *   namespace: 'cert-manager',
 *   repositoryName: 'cert-manager-repo',
 *   values: {
 *     crds: { enabled: false },
 *     replicaCount: 2,
 *     webhook: { replicaCount: 2 }
 *   }
 * });
 * ```
 */

/** Cert-Manager HelmRelease readiness evaluator (delegates to shared implementation) */
const certManagerHelmReleaseReadinessEvaluator = createLabeledHelmReleaseEvaluator('Cert-Manager');

export function certManagerHelmRelease(
  config: CertManagerHelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Create a HelmRelease that properly references the HelmRepository by name
  // We need to use createResource directly to have full control over the sourceRef

  // Values are graph-aware: schema references and CEL expressions in them are
  // serialized by the core proxy system, so a KRO-mode bootstrap keeps every
  // per-instance setting. (They used to be stripped here, which rendered KRO
  // instances with the chart's defaults: 1 replica, a kube-system lease.)
  //
  // Defaults sit UNDER the caller's values:
  // - `crds: { enabled: true, keep: true }` installs the CRDs cert-manager
  //   needs. It replaces the deprecated `installCRDs: true`; chart v1.17+
  //   refuses both at once, so it is left out when the caller still sets
  //   `installCRDs` themselves.
  // - the startup API check gates readiness on the webhook answering, which
  //   prevents "webhook not found" errors for resources applied right after.
  const callerSetsInstallCRDs =
    typeof config.values === 'object' &&
    config.values !== null &&
    !isKubernetesRef(config.values) &&
    !isCelExpression(config.values) &&
    Object.hasOwn(config.values, 'installCRDs');
  const finalValues = withChartValueDefaults(
    {
      ...(callerSetsInstallCRDs ? {} : { crds: { enabled: true, keep: true } }),
      startupapicheck: { enabled: true, timeout: '5m' },
    },
    config.values
  ) as HelmReleaseSpec['values'];

  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'cert-manager',
    },
    spec: {
      interval: '5m',
      chart: {
        spec: {
          chart: 'cert-manager',
          version: config.version || '*',
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName || 'cert-manager-repo',
            namespace: DEFAULT_FLUX_NAMESPACE, // HelmRepositories are typically in flux-system
          },
        },
      },
      values: finalValues,
    },
  }).withReadinessEvaluator(certManagerHelmReleaseReadinessEvaluator);
}

// =============================================================================
// HELM VALUES MAPPING SYSTEM
// =============================================================================

/**
 * Validates Cert-Manager Helm values configuration
 *
 * This function validates that the generated Helm values are compatible
 * with the cert-manager Helm chart requirements.
 *
 * @param values - Helm values to validate
 * @returns Validation result with any errors found
 *
 * @example
 * ```typescript
 * const values = mapCertManagerConfigToHelmValues(config);
 * const validation = validateCertManagerHelmValues(values);
 * if (!validation.valid) {
 *   console.error('Validation errors:', validation.errors);
 * }
 * ```
 */
export function validateCertManagerHelmValues(values: CertManagerHelmValues): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (values.installCRDs === true && values.crds?.enabled === true) {
    errors.push('installCRDs and crds.enabled cannot both be true (cert-manager chart v1.17+)');
  }

  // Validate replica counts
  if (values.replicaCount !== undefined && values.replicaCount < 1) {
    errors.push('replicaCount must be at least 1');
  }

  if (values.webhook?.replicaCount !== undefined && values.webhook.replicaCount < 1) {
    errors.push('webhook.replicaCount must be at least 1');
  }

  if (values.cainjector?.replicaCount !== undefined && values.cainjector.replicaCount < 1) {
    errors.push('cainjector.replicaCount must be at least 1');
  }

  // Validate resource requirements format
  const validateResources = (
    resources: { limits?: Record<string, unknown>; requests?: Record<string, unknown> },
    component: string
  ) => {
    if (resources) {
      if (resources.limits) {
        if (resources.limits.cpu && typeof resources.limits.cpu !== 'string') {
          errors.push(`${component}.resources.limits.cpu must be a string`);
        }
        if (resources.limits.memory && typeof resources.limits.memory !== 'string') {
          errors.push(`${component}.resources.limits.memory must be a string`);
        }
      }
      if (resources.requests) {
        if (resources.requests.cpu && typeof resources.requests.cpu !== 'string') {
          errors.push(`${component}.resources.requests.cpu must be a string`);
        }
        if (resources.requests.memory && typeof resources.requests.memory !== 'string') {
          errors.push(`${component}.resources.requests.memory must be a string`);
        }
      }
    }
  };

  if (values.controller?.resources) {
    validateResources(values.controller.resources, 'controller');
  }

  if (values.webhook?.resources) {
    validateResources(values.webhook.resources, 'webhook');
  }

  if (values.cainjector?.resources) {
    validateResources(values.cainjector.resources, 'cainjector');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
