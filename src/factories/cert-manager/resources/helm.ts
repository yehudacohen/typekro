/**
 * Cert-Manager Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for cert-manager deployments. These functions wrap the generic Helm factories
 * from src/factories/helm/ and provide cert-manager-specific configuration interfaces
 * while reusing existing readiness evaluators.
 */

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
 *     installCRDs: false,
 *     replicaCount: 2,
 *     webhook: { enabled: true }
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

  // CRITICAL: Helm values MUST be static - they cannot contain KubernetesRef objects
  // from schema proxies because Kro/Flux cannot handle CEL expressions inside spec.values.
  // The HelmRelease spec.values field is an arbitrary object without a defined schema,
  // so any KubernetesRef objects will serialize incorrectly (as empty objects or strings).
  //
  // We set these critical values with sensible defaults to ensure cert-manager installs correctly:
  // 1. installCRDs: true — required for cert-manager to function
  // 2. startupapicheck.enabled: true — validates webhook readiness before marking ready
  //
  // NOTE: config.values may already be the result of mapCertManagerConfigToHelmValues()
  // from the bootstrap composition (see utils/helm-values-mapper.ts).
  // We just sanitize the values to remove any proxy references.
  // The bootstrap composition's startupapicheck settings take precedence via the spread.
  const baseValues = config.values ? sanitizeHelmValues(config.values) : {};
  const finalValues = {
    // Always install CRDs — required for cert-manager to function
    installCRDs: true,
    // Enable startupapicheck by default with increased timeout to ensure webhook is ready.
    // This prevents "webhook not found" errors when deploying cert-manager CRDs.
    startupapicheck: {
      enabled: true,
      timeout: '5m',
    },
    // Spread baseValues LAST so caller-provided values (including from the bootstrap
    // composition) take precedence over our defaults above
    ...baseValues,
  };

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

/**
 * Sanitizes Helm values by removing any KubernetesRef objects or other non-serializable values.
 * This is necessary because Helm values must be static - they cannot contain CEL expressions
 * or schema proxy references.
 *
 * @param values - The Helm values object to sanitize
 * @returns A sanitized copy of the values with only primitive types, arrays, and plain objects
 */
function sanitizeHelmValues(values: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(values, (_key, value) => {
      // Skip KubernetesRef objects — schema proxy references can't be used in Helm values
      if (isKubernetesRef(value)) {
        return undefined;
      }
      // Skip CelExpression objects — CEL expressions can't be used in Helm values
      if (isCelExpression(value)) {
        return undefined;
      }
      return value;
    })
  );
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

  // Note: installCRDs defaults to true for TypeKro comprehensive deployment
  // This ensures TypeKro can replace kubectl for complete deployments

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
