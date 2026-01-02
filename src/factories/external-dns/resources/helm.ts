/**
 * External-DNS Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for external-dns deployments. These functions wrap the generic Helm factories
 * from src/factories/helm/ and provide external-dns-specific configuration interfaces
 * while reusing existing readiness evaluators.
 */

import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type {
  ExternalDnsHelmRepositoryConfig,
  ExternalDnsHelmReleaseConfig,
  ExternalDnsHelmValues,
} from '../types.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../../helm/helm-repository.js';

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

/**
 * Readiness evaluator for external-dns HelmRepository resources
 * HelmRepository is ready when it has a Ready condition with status True
 */
function externalDnsHelmRepositoryReadinessEvaluator(resource: any) {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';
  
  return {
    ready: isReady,
    message: isReady ? 'External-DNS HelmRepository is ready' : 'External-DNS HelmRepository is not ready',
  };
}

export function externalDnsHelmRepository(config: ExternalDnsHelmRepositoryConfig): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
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

/**
 * Readiness evaluator for external-dns HelmRelease resources
 * HelmRelease is ready when it has a Ready phase
 */
function externalDnsHelmReleaseReadinessEvaluator(resource: any) {
  const status = resource.status;
  
  if (!status) {
    return {
      ready: false,
      message: 'External-DNS HelmRelease status not available yet',
    };
  }
  
  if (status.phase === 'Ready') {
    return {
      ready: true,
      message: `External-DNS HelmRelease is ready (revision ${status.revision || 'unknown'})`,
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
        ? `External-DNS HelmRelease is ready (revision ${status.revision || 'unknown'})`
        : readyCondition.message || 'External-DNS HelmRelease is not ready',
    };
  }
  
  return {
    ready: false,
    message: `External-DNS HelmRelease phase: ${status.phase || 'unknown'}`,
  };
}

export function externalDnsHelmRelease(config: ExternalDnsHelmReleaseConfig): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
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
            namespace: 'flux-system', // HelmRepositories are typically in flux-system
          },
        },
      },
      ...(config.values && Object.keys(config.values).length > 0 && { values: mapExternalDnsConfigToHelmValues(config.values) }),
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
export function mapExternalDnsConfigToHelmValues(config: ExternalDnsHelmValues): Record<string, any> {
  const values: Record<string, any> = {};

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
  Object.keys(config).forEach(key => {
    if (!Object.hasOwn(values, key) && 
        !['provider', 'aws', 'azure', 'cloudflare', 'google', 'digitalocean',
          'domainFilters', 'excludeDomains', 'regexDomainFilter', 'regexDomainExclusion',
          'txtOwnerId', 'txtPrefix', 'txtSuffix', 'sources', 'policy', 'registry',
          'interval', 'triggerLoopOnEvent', 'replicaCount', 'image', 'resources',
          'nodeSelector', 'tolerations', 'affinity', 'securityContext', 
          'containerSecurityContext', 'podSecurityContext', 'serviceAccount', 'rbac',
          'metrics', 'logLevel', 'logFormat', 'dryRun', 'annotationFilter', 
          'labelFilter', 'ingressClass', 'env'].includes(key)) {
      values[key] = (config as any)[key];
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
    const validProviders = ['aws', 'azure', 'cloudflare', 'google', 'digitalocean', 'linode', 'rfc2136', 'webhook', 'akamai', 'ns1', 'plural'];
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

  if (values.resources) {
    validateResources(values.resources, 'external-dns');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}