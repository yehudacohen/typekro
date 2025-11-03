/**
 * Cert-Manager Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for cert-manager deployments. These functions wrap the generic Helm factories
 * from src/factories/helm/ and provide cert-manager-specific configuration interfaces
 * while reusing existing readiness evaluators.
 */

import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type {
  CertManagerHelmRepositoryConfig,
  CertManagerHelmReleaseConfig,
  CertManagerHelmValues,
} from '../types.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../../helm/helm-repository.js';

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

/**
 * Readiness evaluator for cert-manager HelmRepository resources
 * HelmRepository is ready when it has a Ready condition with status True
 * For OCI repositories, they may not have status conditions but are functional
 */
function certManagerHelmRepositoryReadinessEvaluator(resource: any) {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');

  // For OCI repositories, they may not have status conditions but are functional
  // if the resource exists and has been processed by Flux
  const isOciRepository = resource.spec?.type === 'oci';
  const hasBeenProcessed = resource.metadata?.generation && resource.metadata?.resourceVersion;

  const isReady = readyCondition?.status === 'True' || (isOciRepository && !!hasBeenProcessed);

  return {
    ready: isReady,
    message: isReady
      ? isOciRepository && !readyCondition
        ? 'Cert-Manager OCI HelmRepository is functional'
        : 'Cert-Manager HelmRepository is ready'
      : 'Cert-Manager HelmRepository is not ready',
  };
}

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
      namespace: config.namespace || 'flux-system',
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

/**
 * Readiness evaluator for cert-manager HelmRelease resources
 * HelmRelease is ready when it has a Ready phase
 */
function certManagerHelmReleaseReadinessEvaluator(resource: any) {
  const status = resource.status;

  if (!status) {
    return {
      ready: false,
      message: 'Cert-Manager HelmRelease status not available yet',
    };
  }

  if (status.phase === 'Ready') {
    return {
      ready: true,
      message: `Cert-Manager HelmRelease is ready (revision ${status.revision || 'unknown'})`,
    };
  }

  // Check conditions for more detailed status
  const conditions = status.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');

  if (readyCondition) {
    const isReady = readyCondition.status === 'True';
    return {
      ready: isReady,
      message: isReady
        ? `Cert-Manager HelmRelease is ready (revision ${status.revision || 'unknown'})`
        : readyCondition.message || 'Cert-Manager HelmRelease is not ready',
    };
  }

  return {
    ready: false,
    message: `Cert-Manager HelmRelease phase: ${status.phase || 'unknown'}`,
  };
}

export function certManagerHelmRelease(
  config: CertManagerHelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Create a HelmRelease that properly references the HelmRepository by name
  // We need to use createResource directly to have full control over the sourceRef
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
            namespace: 'flux-system', // HelmRepositories are typically in flux-system
          },
        },
      },
      values: mapCertManagerConfigToHelmValues(config.values || {}),
    },
  }).withReadinessEvaluator(certManagerHelmReleaseReadinessEvaluator);
}

// =============================================================================
// HELM VALUES MAPPING SYSTEM
// =============================================================================

/**
 * Maps Cert-Manager configuration to Helm values
 *
 * This function converts the TypeKro CertManagerHelmValues interface
 * to the format expected by the cert-manager Helm chart.
 *
 * @param config - Cert-Manager configuration object
 * @returns Helm values object compatible with cert-manager chart
 *
 * @example
 * ```typescript
 * const config = {
 *   installCRDs: false,
 *   replicaCount: 2,
 *   webhook: { enabled: true }
 * };
 * const helmValues = mapCertManagerConfigToHelmValues(config);
 * ```
 */
export function mapCertManagerConfigToHelmValues(
  config: CertManagerHelmValues
): Record<string, any> {
  const values: Record<string, any> = {
    // Installation configuration - default to true for TypeKro comprehensive deployment
    installCRDs: config.installCRDs ?? true,
  };

  // Global configuration
  if (config.global) {
    values.global = { ...config.global };
  }

  // Replica configuration
  if (config.replicaCount !== undefined) {
    values.replicaCount = config.replicaCount;
  }

  // Deployment strategy
  if (config.strategy) {
    values.strategy = { ...config.strategy };
  }

  // Image configuration
  if (config.image) {
    values.image = { ...config.image };
  }

  // Controller configuration
  if (config.controller) {
    values.controller = { ...config.controller };
  }

  // Webhook configuration
  if (config.webhook) {
    values.webhook = { ...config.webhook };
  }

  // CA Injector configuration
  if (config.cainjector) {
    values.cainjector = { ...config.cainjector };
  }

  // ACME solver configuration
  if (config.acmesolver) {
    values.acmesolver = { ...config.acmesolver };
  }

  // Startup API check configuration
  if (config.startupapicheck) {
    values.startupapicheck = { ...config.startupapicheck };
  }

  // Monitoring configuration
  if (config.prometheus) {
    values.prometheus = { ...config.prometheus };
  }

  // Include any additional custom values
  Object.keys(config).forEach((key) => {
    if (
      !Object.hasOwn(values, key) &&
      key !== 'installCRDs' &&
      key !== 'global' &&
      key !== 'replicaCount' &&
      key !== 'strategy' &&
      key !== 'image' &&
      key !== 'controller' &&
      key !== 'webhook' &&
      key !== 'cainjector' &&
      key !== 'acmesolver' &&
      key !== 'startupapicheck' &&
      key !== 'prometheus'
    ) {
      values[key] = (config as any)[key];
    }
  });

  return values;
}

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
  const validateResources = (resources: any, component: string) => {
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
