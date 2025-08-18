import { createResource } from '../shared.js';
import type { Enhanced } from '../../core/types/index.js';

export interface HelmRepositorySpec {
  url: string;
  interval?: string;
}

export interface HelmRepositoryStatus {
  conditions?: Array<{
    type: string;
    status: string;
    message?: string;
  }>;
  url: string;
}

export interface HelmRepositoryConfig {
  name: string;
  namespace?: string;
  url: string;
  interval?: string;
  id?: string;
}

/**
 * Create a Helm repository resource for Flux CD
 * 
 * @param config - Configuration for the HelmRepository
 * 
 * @example
 * ```typescript
 * helmRepository({
 *   name: 'bitnami',
 *   url: 'https://charts.bitnami.com/bitnami',
 *   interval: '5m'
 * })
 * ```
 */
/**
 * Default readiness evaluator for HelmRepository resources
 */
function helmRepositoryReadinessEvaluator(resource: any) {
  // HelmRepository is ready when it has a Ready condition with status True
  const conditions = resource.status?.conditions || [];
  const readyCondition = conditions.find((c: any) => c.type === 'Ready');
  const isReady = readyCondition?.status === 'True';
  
  return {
    ready: isReady,
    message: isReady ? 'HelmRepository is ready' : 'HelmRepository is not ready',
  };
}

export function helmRepository(config: HelmRepositoryConfig): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      url: config.url,
      interval: config.interval || '5m',
    },
    status: {
      conditions: [],
      url: config.url,
    },
  }).withReadinessEvaluator(helmRepositoryReadinessEvaluator);
}