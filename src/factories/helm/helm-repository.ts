import type { Enhanced, KubernetesCondition, ReadinessEvaluator } from '../../core/types/index.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../core/config/defaults.js';
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
  /** @default '5m' */
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
export function createHelmRepositoryReadinessEvaluator(label?: string): ReadinessEvaluator<unknown> {
  const prefix = label ? `${label} ` : '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HelmRepository is a CRD without typed client
  return (resource: unknown) => {
    const liveResource = resource as {
      status?: { conditions?: KubernetesCondition[] };
      spec?: { type?: string };
      metadata?: { generation?: unknown; resourceVersion?: unknown };
    };
    // HelmRepository is ready when it has a Ready condition with status True
    const conditions = liveResource.status?.conditions || [];
    const readyCondition = conditions.find((c: KubernetesCondition) => c.type === 'Ready');

    // For OCI repositories, they may not have status conditions but are functional
    // if the resource exists and has been processed by Flux
    const isOciRepository = liveResource.spec?.type === 'oci';
    const hasBeenProcessed = liveResource.metadata?.generation && liveResource.metadata?.resourceVersion;

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
      namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
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
