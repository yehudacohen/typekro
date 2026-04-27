/**
 * External-DNS Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for external-dns deployments. These functions wrap the generic Helm factories
 * from src/factories/helm/ and provide external-dns-specific configuration interfaces
 * while reusing existing readiness evaluators.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Enhanced } from '../../../core/types/index.js';
import { isCelExpression } from '../../../utils/type-guards.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import type {
  ExternalDnsHelmReleaseConfig,
  ExternalDnsHelmRepositoryConfig,
  ExternalDnsHelmValues,
} from '../types.js';

// =============================================================================
// EXTERNAL-DNS HELM REPOSITORY WRAPPER
// =============================================================================

/**
 * Wrapper function for creating External-DNS HelmRepository resources
 *
 * This function wraps the generic `helmRepository` factory and provides
 * external-dns-specific default configuration (official external-dns chart repository).
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - External-DNS HelmRepository configuration
 * @returns Enhanced HelmRepository resource with external-dns-specific settings
 *
 * @example
 * Basic external-dns repository:
 * ```typescript
 * const repo = externalDnsHelmRepository({
 *   name: 'external-dns',
 *   namespace: 'flux-system'
 * });
 * ```
 *
 * @example
 * Repository with custom settings:
 * ```typescript
 * const repo = externalDnsHelmRepository({
 *   name: 'external-dns-repo',
 *   namespace: 'flux-system',
 *   url: 'https://kubernetes-sigs.github.io/external-dns/',
 *   interval: '10m'
 * });
 * ```
 */

/** External-DNS HelmRepository readiness evaluator (delegates to shared implementation) */
const externalDnsHelmRepositoryReadinessEvaluator =
  createHelmRepositoryReadinessEvaluator('External-DNS');

export function externalDnsHelmRepository(
  config: ExternalDnsHelmRepositoryConfig
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
      url: config.url || 'https://kubernetes-sigs.github.io/external-dns/',
      interval: config.interval || '5m',
    },
    // Omit status template to avoid conflicts with Kro controller
  }).withReadinessEvaluator(externalDnsHelmRepositoryReadinessEvaluator);
}

// =============================================================================
// EXTERNAL-DNS HELM RELEASE WRAPPER
// =============================================================================

/**
 * Wrapper function for creating External-DNS HelmRelease resources
 *
 * This function wraps the generic `helmRelease` factory and provides
 * external-dns-specific default configuration (chart name, repository reference).
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - External-DNS HelmRelease configuration
 * @returns Enhanced HelmRelease resource with external-dns-specific configuration
 *
 * @example
 * Basic external-dns release:
 * ```typescript
 * const release = externalDnsHelmRelease({
 *   name: 'external-dns',
 *   namespace: 'external-dns',
 *   repositoryName: 'external-dns-repo'
 * });
 * ```
 *
 * @example
 * Release with custom values:
 * ```typescript
 * const release = externalDnsHelmRelease({
 *   name: 'external-dns',
 *   namespace: 'external-dns',
 *   repositoryName: 'external-dns-repo',
 *   values: {
 *     provider: 'aws',
 *     aws: { region: 'us-east-1' },
 *     domainFilters: ['example.com']
 *   }
 * });
 * ```
 */

/** External-DNS HelmRelease readiness evaluator (delegates to shared implementation) */
const externalDnsHelmReleaseReadinessEvaluator = createLabeledHelmReleaseEvaluator('External-DNS');

export function externalDnsHelmRelease(
  config: ExternalDnsHelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const values = config.values
    ? isCelExpression(config.values)
      ? (config.values as unknown as Record<string, unknown>)
      : mapExternalDnsConfigToHelmValues(config.values)
    : undefined;

  // Create a HelmRelease that properly references the HelmRepository by name
  // We need to use createResource directly to have full control over the sourceRef
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'external-dns',
    },
    spec: {
      interval: '5m',
      chart: {
        spec: {
          chart: 'external-dns',
          version: config.version || '*',
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName || 'external-dns-repo',
            namespace: DEFAULT_FLUX_NAMESPACE, // HelmRepositories are typically in flux-system
          },
        },
      },
      ...(values &&
        (isCelExpression(config.values) || Object.keys(values).length > 0) && {
          values,
        }),
    },
  }).withReadinessEvaluator(externalDnsHelmReleaseReadinessEvaluator);
}

// =============================================================================
// HELM VALUES MAPPING SYSTEM
// =============================================================================

/**
 * Maps External-DNS configuration to Helm values
 *
 * This function converts the TypeKro ExternalDnsHelmValues interface
 * to the format expected by the external-dns Helm chart.
 *
 * @param config - External-DNS configuration object
 * @returns Helm values object compatible with external-dns chart
 *
 * @example
 * ```typescript
 * const config = {
 *   provider: 'aws',
 *   aws: { region: 'us-east-1' },
 *   domainFilters: ['example.com']
 * };
 * const helmValues = mapExternalDnsConfigToHelmValues(config);
 * ```
 */
export function mapExternalDnsConfigToHelmValues(
  config: ExternalDnsHelmValues
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  // Provider configuration
  if (config.provider) {
    values.provider = config.provider;
  }

  // Provider-specific configuration
  if (config.aws) {
    values.aws = { ...config.aws };
  }

  if (config.azure) {
    values.azure = { ...config.azure };
  }

  if (config.cloudflare) {
    values.cloudflare = { ...config.cloudflare };
  }

  if (config.google) {
    values.google = { ...config.google };
  }

  if (config.digitalocean) {
    values.digitalocean = { ...config.digitalocean };
  }

  // Domain configuration
  if (config.domainFilters && config.domainFilters.length > 0) {
    values.domainFilters = [...config.domainFilters];
  }

  if (config.excludeDomains) {
    values.excludeDomains = [...config.excludeDomains];
  }

  if (config.regexDomainFilter) {
    values.regexDomainFilter = config.regexDomainFilter;
  }

  if (config.regexDomainExclusion) {
    values.regexDomainExclusion = config.regexDomainExclusion;
  }

  // Ownership configuration
  if (config.txtOwnerId) {
    values.txtOwnerId = config.txtOwnerId;
  }

  if (config.txtPrefix) {
    values.txtPrefix = config.txtPrefix;
  }

  if (config.txtSuffix) {
    values.txtSuffix = config.txtSuffix;
  }

  // Source configuration
  if (config.sources) {
    values.sources = [...config.sources];
  }

  // Policy configuration - default to 'upsert-only' for safety
  values.policy = config.policy || 'upsert-only';

  if (config.registry) {
    values.registry = config.registry;
  }

  // Sync configuration
  if (config.interval) {
    values.interval = config.interval;
  }

  if (config.triggerLoopOnEvent !== undefined) {
    values.triggerLoopOnEvent = config.triggerLoopOnEvent;
  }

  // Deployment configuration
  if (config.replicaCount !== undefined) {
    values.replicaCount = config.replicaCount;
  }

  if (config.image) {
    values.image = { ...config.image };
  }

  // Resource configuration
  if (config.resources) {
    values.resources = { ...config.resources };
  }

  if (config.nodeSelector) {
    values.nodeSelector = { ...config.nodeSelector };
  }

  if (config.tolerations) {
    values.tolerations = [...config.tolerations];
  }

  if (config.affinity) {
    values.affinity = { ...config.affinity };
  }

  // Security configuration
  if (config.securityContext) {
    values.securityContext = { ...config.securityContext };
  }

  if (config.containerSecurityContext) {
    values.containerSecurityContext = { ...config.containerSecurityContext };
  }

  if (config.podSecurityContext) {
    values.podSecurityContext = { ...config.podSecurityContext };
  }

  // Service account configuration
  if (config.serviceAccount) {
    values.serviceAccount = { ...config.serviceAccount };
  }

  // RBAC configuration
  if (config.rbac) {
    values.rbac = { ...config.rbac };
  }

  // Monitoring configuration
  if (config.metrics) {
    values.metrics = { ...config.metrics };
  }

  // Logging configuration
  if (config.logLevel) {
    values.logLevel = config.logLevel;
  }

  if (config.logFormat) {
    values.logFormat = config.logFormat;
  }

  // Advanced configuration
  if (config.dryRun !== undefined) {
    values.dryRun = config.dryRun;
  }

  if (config.annotationFilter) {
    values.annotationFilter = config.annotationFilter;
  }

  if (config.labelFilter) {
    values.labelFilter = config.labelFilter;
  }

  if (config.ingressClass) {
    values.ingressClass = config.ingressClass;
  }

  // Environment variables configuration (for credentials, etc.)
  if (config.env) {
    values.env = [...config.env];
  }

  // Include any additional custom values
  Object.keys(config).forEach((key) => {
    if (
      !Object.hasOwn(values, key) &&
      ![
        'provider',
        'aws',
        'azure',
        'cloudflare',
        'google',
        'digitalocean',
        'domainFilters',
        'excludeDomains',
        'regexDomainFilter',
        'regexDomainExclusion',
        'txtOwnerId',
        'txtPrefix',
        'txtSuffix',
        'sources',
        'policy',
        'registry',
        'interval',
        'triggerLoopOnEvent',
        'replicaCount',
        'image',
        'resources',
        'nodeSelector',
        'tolerations',
        'affinity',
        'securityContext',
        'containerSecurityContext',
        'podSecurityContext',
        'serviceAccount',
        'rbac',
        'metrics',
        'logLevel',
        'logFormat',
        'dryRun',
        'annotationFilter',
        'labelFilter',
        'ingressClass',
        'env',
      ].includes(key)
    ) {
      values[key] = (config as Record<string, unknown>)[key];
    }
  });

  return values;
}

/**
 * Validates External-DNS Helm values configuration
 *
 * This function validates that the generated Helm values are compatible
 * with the external-dns Helm chart requirements.
 *
 * @param values - Helm values to validate
 * @returns Validation result with any errors found
 *
 * @example
 * ```typescript
 * const values = mapExternalDnsConfigToHelmValues(config);
 * const validation = validateExternalDnsHelmValues(values);
 * if (!validation.valid) {
 *   console.error('Validation errors:', validation.errors);
 * }
 * ```
 */
export function validateExternalDnsHelmValues(values: ExternalDnsHelmValues): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Validate provider
  if (!values.provider) {
    errors.push('provider is required');
  } else {
    const validProviders = [
      'aws',
      'azure',
      'cloudflare',
      'google',
      'digitalocean',
      'linode',
      'rfc2136',
      'webhook',
      'akamai',
      'ns1',
      'plural',
    ];
    if (!validProviders.includes(values.provider)) {
      errors.push(`provider must be one of: ${validProviders.join(', ')}`);
    }
  }

  // Validate domain filters
  if (values.domainFilters && values.domainFilters.length === 0) {
    errors.push('domainFilters cannot be empty');
  }

  // Validate policy
  if (values.policy) {
    const validPolicies = ['sync', 'upsert-only', 'create-only'];
    if (!validPolicies.includes(values.policy)) {
      errors.push(`policy must be one of: ${validPolicies.join(', ')}`);
    }
  }

  // Validate registry
  if (values.registry) {
    const validRegistries = ['txt', 'aws-sd', 'noop'];
    if (!validRegistries.includes(values.registry)) {
      errors.push(`registry must be one of: ${validRegistries.join(', ')}`);
    }
  }

  // Validate replica count
  if (values.replicaCount !== undefined && values.replicaCount < 1) {
    errors.push('replicaCount must be at least 1');
  }

  // Validate log level
  if (values.logLevel) {
    const validLogLevels = ['panic', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'];
    if (!validLogLevels.includes(values.logLevel)) {
      errors.push(`logLevel must be one of: ${validLogLevels.join(', ')}`);
    }
  }

  // Validate log format
  if (values.logFormat) {
    const validLogFormats = ['text', 'json'];
    if (!validLogFormats.includes(values.logFormat)) {
      errors.push(`logFormat must be one of: ${validLogFormats.join(', ')}`);
    }
  }

  // Validate resource requirements format
  const validateResources = (resources: unknown, component: string) => {
    const resourceRequirements = resources as {
      limits?: { cpu?: unknown; memory?: unknown };
      requests?: { cpu?: unknown; memory?: unknown };
    } | undefined;

    if (resourceRequirements) {
      if (resourceRequirements.limits) {
        if (resourceRequirements.limits.cpu && typeof resourceRequirements.limits.cpu !== 'string') {
          errors.push(`${component}.resources.limits.cpu must be a string`);
        }
        if (resourceRequirements.limits.memory && typeof resourceRequirements.limits.memory !== 'string') {
          errors.push(`${component}.resources.limits.memory must be a string`);
        }
      }
      if (resourceRequirements.requests) {
        if (resourceRequirements.requests.cpu && typeof resourceRequirements.requests.cpu !== 'string') {
          errors.push(`${component}.resources.requests.cpu must be a string`);
        }
        if (resourceRequirements.requests.memory && typeof resourceRequirements.requests.memory !== 'string') {
          errors.push(`${component}.resources.requests.memory must be a string`);
        }
      }
    }
  };

  if (values.resources) {
    validateResources(values.resources, 'external-dns');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
