/**
 * APISix Helm Resources
 *
 * Factory functions for creating APISix HelmRepository and HelmRelease resources
 * following the same patterns as cert-manager.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import type { APISixHelmValues } from '../types.js';

/**
 * Configuration for APISix HelmRepository
 */
export interface APISixHelmRepositoryConfig {
  name: string;
  namespace?: string;
  url?: string;
  interval?: string;
  id?: string;
}

/**
 * Configuration for APISix HelmRelease
 */
export interface APISixHelmReleaseConfig {
  name: string;
  namespace?: string;
  targetNamespace?: string;
  chart?: string;
  version?: string;
  interval?: string;
  timeout?: string;
  values?: APISixHelmValues;
  repositoryName?: string; // Allow specifying the repository name

  id?: string;
}

/**
 * Creates an APISix HelmRepository resource
 *
 * @param config - HelmRepository configuration
 * @returns Enhanced HelmRepository resource
 */
/** APISix HelmRepository readiness evaluator (delegates to shared implementation) */
const apisixHelmRepositoryReadinessEvaluator = createHelmRepositoryReadinessEvaluator('APISix');

export function apisixHelmRepository(
  config: APISixHelmRepositoryConfig
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      url: config.url || 'https://charts.apiseven.com',
      interval: config.interval || '1h',
    },
  }).withReadinessEvaluator(apisixHelmRepositoryReadinessEvaluator);
}

/**
 * Creates an APISix HelmRelease resource
 *
 * @param config - HelmRelease configuration
 * @returns Enhanced HelmRelease resource
 */
export function apisixHelmRelease(
  config: APISixHelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Determine if values should be passed through raw or mapped
  // If values has 'config' key (ingress controller chart structure), pass through raw
  // Otherwise, map using APISix values mapper
  const rawValues = config.values as Record<string, unknown> | undefined;
  const isRawValues =
    rawValues && ('config' in rawValues || 'serviceAccount' in rawValues || 'rbac' in rawValues);
  const helmValues = isRawValues ? rawValues : mapAPISixConfigToHelmValues(config.values || {});

  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      interval: config.interval || '5m',
      timeout: config.timeout || '10m',
      chart: {
        spec: {
          chart: config.chart || 'apisix',
          version: config.version || '2.8.0',
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName || `${config.name.replace('-release', '')}-repo`,
            namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
          },
        },
      },
      targetNamespace: config.targetNamespace || config.namespace || 'apisix',
      install: {
        createNamespace: true,
        remediation: {
          retries: 3,
        },
      },
      upgrade: {
        remediation: {
          retries: 3,
        },
      },

      values: helmValues,
    },
  }).withReadinessEvaluator(apisixHelmReleaseReadinessEvaluator);
}

/**
 * Maps APISix configuration to Helm values for the HelmRelease
 * This is a simpler version that just passes through the values
 *
 * @param config - The APISix Helm values
 * @returns Helm values object for the APISix chart
 */
export function mapAPISixConfigToHelmValues(config: APISixHelmValues): Record<string, any> {
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

  // Gateway configuration
  if (config.gateway) {
    values.gateway = { ...config.gateway };
  }

  // Ingress Controller configuration
  if (config.ingressController) {
    values.ingressController = { ...config.ingressController };
  }

  // APISix configuration
  if (config.apisix) {
    values.apisix = { ...config.apisix };
  }

  // Dashboard configuration
  if (config.dashboard) {
    values.dashboard = { ...config.dashboard };
  }

  // etcd configuration
  if (config.etcd) {
    values.etcd = { ...config.etcd };
  }

  // Service Account configuration
  if (config.serviceAccount) {
    values.serviceAccount = { ...config.serviceAccount };
  }

  // RBAC configuration
  if (config.rbac) {
    values.rbac = { ...config.rbac };
  }

  // Add any additional custom values
  Object.keys(config).forEach((key) => {
    if (!values[key] && config[key] !== undefined) {
      values[key] = config[key];
    }
  });

  return values;
}

/**
 * Readiness evaluator for APISix HelmRelease (delegates to shared implementation).
 *
 * Exported for backward compatibility — prefer using the shared evaluator
 * from `../../helm/readiness-evaluators.js` directly.
 */
export const apisixHelmReleaseReadinessEvaluator = createLabeledHelmReleaseEvaluator('APISix');
