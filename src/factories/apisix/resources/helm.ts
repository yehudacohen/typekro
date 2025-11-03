/**
 * APISix Helm Resources
 * 
 * Factory functions for creating APISix HelmRepository and HelmRelease resources
 * following the same patterns as cert-manager.
 */

import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type { APISixHelmValues } from '../types.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../../helm/helm-repository.js';

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
/**
 * Readiness evaluator for APISix HelmRepository resources
 * HelmRepository is ready when it has a Ready condition with status True
 */
function apisixHelmRepositoryReadinessEvaluator(resource: any) {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';

  return {
    ready: isReady,
    message: isReady ? 'APISix HelmRepository is ready' : 'APISix HelmRepository is not ready',
  };
}

export function apisixHelmRepository(config: APISixHelmRepositoryConfig): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'flux-system',
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
export function apisixHelmRelease(config: APISixHelmReleaseConfig): Enhanced<any, any> {
  return createResource<any, any>({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'flux-system',
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
            namespace: config.namespace || 'flux-system'
          }
        }
      },
      targetNamespace: config.targetNamespace || config.namespace || 'apisix',
      install: {
        createNamespace: true,
        remediation: {
          retries: 3
        }
      },
      upgrade: {
        remediation: {
          retries: 3
        }
      },

      values: mapAPISixConfigToHelmValues(config.values || {}),
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
  Object.keys(config).forEach(key => {
    if (!values[key] && config[key] !== undefined) {
      values[key] = config[key];
    }
  });

  return values;
}

/**
 * Readiness evaluator for APISix HelmRelease
 * Checks if the HelmRelease is ready and all components are deployed
 */
export function apisixHelmReleaseReadinessEvaluator(resource: any) {
  const status = resource?.status;
  
  if (!status) {
    return {
      ready: false,
      message: 'APISix HelmRelease status not available',
    };
  }

  // Check if HelmRelease is ready
  const conditions = status.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  
  if (!readyCondition || readyCondition.status !== 'True') {
    return {
      ready: false,
      message: 'APISix HelmRelease is not ready',
    };
  }

  return {
    ready: true,
    message: 'APISix HelmRelease is ready',
  };
}