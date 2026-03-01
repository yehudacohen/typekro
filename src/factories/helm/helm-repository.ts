import type { Enhanced, ReadinessEvaluator } from '../../core/types/index.js';
import { createResource } from '../shared.js';

export interface HelmRepositorySpec {
  url: string;
  interval?: string;
  type?: 'default' | 'oci';
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
  type?: 'default' | 'oci';
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
 * Create a readiness evaluator for HelmRepository resources.
 *
 * Checks Flux CD conditions for `Ready: True`, with an OCI repository fallback
 * for repositories that may not report conditions but have been processed by Flux.
 *
 * @param label - Optional label prefix for log messages (e.g., `'Cert-Manager'`).
 *   Defaults to no prefix (`'HelmRepository'`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRepository is a CRD without typed client
export function createHelmRepositoryReadinessEvaluator(label?: string): ReadinessEvaluator<any> {
  const prefix = label ? `${label} ` : '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRepository is a CRD without typed client
  return (resource: any) => {
    // HelmRepository is ready when it has a Ready condition with status True
    const conditions = resource.status?.conditions || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- conditions array items are untyped CRD fields
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
          ? `${prefix}OCI HelmRepository is functional`
          : `${prefix}HelmRepository is ready`
        : `${prefix}HelmRepository is not ready`,
    };
  };
}

/** Default (unlabeled) HelmRepository readiness evaluator */
const helmRepositoryReadinessEvaluator = createHelmRepositoryReadinessEvaluator();

export function helmRepository(
  config: HelmRepositoryConfig
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
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
      ...(config.type && { type: config.type }),
    },
    status: {
      conditions: [],
      url: config.url,
    },
  }).withReadinessEvaluator(helmRepositoryReadinessEvaluator);
}
