/**
 * Pebble ACME Test Server Helm Integration Resources
 *
 * This module provides wrapper functions for creating Helm resources specifically
 * configured for Pebble ACME test server deployments. These functions wrap the generic Helm factories
 * and provide Pebble-specific configuration interfaces while reusing existing readiness evaluators.
 */

import { createResource } from '../../shared.js';
import type { Enhanced } from '../../../core/types/index.js';
import type {
  PebbleHelmRepositoryConfig,
  PebbleHelmReleaseConfig,
} from '../types.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../../helm/helm-repository.js';

// =============================================================================
// PEBBLE HELM REPOSITORY WRAPPER
// =============================================================================

/**
 * Readiness evaluator for Pebble HelmRepository resources
 * HelmRepository is ready when it has a Ready condition with status True
 */
function pebbleHelmRepositoryReadinessEvaluator(resource: any) {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';
  
  return {
    ready: isReady,
    message: isReady ? 'Pebble HelmRepository is ready' : 'Pebble HelmRepository is not ready',
  };
}

/**
 * Wrapper function for creating Pebble HelmRepository resources
 *
 * This function wraps the generic `helmRepository` factory and provides
 * Pebble-specific default configuration (JupyterHub Pebble Helm chart repository).
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - Pebble HelmRepository configuration
 * @returns Enhanced HelmRepository resource with Pebble-specific settings
 *
 * @example
 * Basic Pebble repository:
 * ```typescript
 * const repo = pebbleHelmRepository({
 *   name: 'pebble',
 *   namespace: 'flux-system'
 * });
 * ```
 *
 * @example
 * Repository with custom settings:
 * ```typescript
 * const repo = pebbleHelmRepository({
 *   name: 'pebble-repo',
 *   namespace: 'flux-system',
 *   url: 'https://jupyterhub.github.io/helm-chart/',
 *   interval: '10m'
 * });
 * ```
 */
export function pebbleHelmRepository(config: PebbleHelmRepositoryConfig): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'flux-system',
    },
    spec: {
      url: config.url || 'https://jupyterhub.github.io/helm-chart/',
      interval: config.interval || '5m',
    },
  }).withReadinessEvaluator(pebbleHelmRepositoryReadinessEvaluator);
}

// =============================================================================
// PEBBLE HELM RELEASE WRAPPER
// =============================================================================

/**
 * Readiness evaluator for Pebble HelmRelease resources
 * HelmRelease is ready when it has a Ready condition with status True
 */
function pebbleHelmReleaseReadinessEvaluator(resource: any) {
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';
  
  return {
    ready: isReady,
    message: isReady ? 'Pebble HelmRelease is ready' : 'Pebble HelmRelease is not ready',
  };
}

/**
 * Wrapper function for creating Pebble HelmRelease resources
 *
 * This function wraps the generic `helmRelease` factory and provides
 * Pebble-specific default configuration (chart name, repository reference).
 * It reuses the existing Helm readiness evaluator.
 *
 * @param config - Pebble HelmRelease configuration
 * @returns Enhanced HelmRelease resource with Pebble-specific settings
 *
 * @example
 * Basic Pebble release:
 * ```typescript
 * const release = pebbleHelmRelease({
 *   name: 'pebble',
 *   namespace: 'pebble-system',
 *   repositoryRef: { name: 'pebble' },
 *   values: {
 *     pebble: {
 *       env: [
 *         { name: 'PEBBLE_VA_NOSLEEP', value: '1' },
 *         { name: 'PEBBLE_WFE_NONCEREJECT', value: '0' }
 *       ]
 *     }
 *   }
 * });
 * ```
 *
 * @example
 * Pebble release with custom DNS configuration:
 * ```typescript
 * const release = pebbleHelmRelease({
 *   name: 'pebble-acme',
 *   namespace: 'testing',
 *   repositoryRef: { name: 'pebble-repo' },
 *   values: {
 *     pebble: {
 *       config: {
 *         pebble: {
 *           httpPort: 5002,
 *           tlsPort: 5001
 *         }
 *       }
 *     },
 *     coredns: {
 *       corefileSegment: `
 *         template ANY ANY test {
 *           answer "{{ .Name }} 60 IN CNAME mysvc.{$PEBBLE_NAMESPACE}.svc.cluster.local"
 *         }
 *       `
 *     }
 *   }
 * });
 * ```
 */
export function pebbleHelmRelease(config: PebbleHelmReleaseConfig): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      namespace: config.namespace || 'default',
    },
    spec: {
      chart: {
        spec: {
          chart: config.chart?.name || 'pebble',
          version: config.chart?.version || '*',
          sourceRef: {
            kind: 'HelmRepository',
            name: config.repositoryRef?.name || 'pebble-repo',
            namespace: config.repositoryRef?.namespace || 'flux-system',
          },
        },
      },
      interval: config.interval || '5m',
      ...(config.values && { values: config.values }),
    },
  }).withReadinessEvaluator(pebbleHelmReleaseReadinessEvaluator);
}