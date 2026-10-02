// `TriggerAuthentication` and `ClusterTriggerAuthentication` factories
// (`keda.sh/v1alpha1`).

import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { KEDA_API_VERSION } from '../constants.js';
import type {
  TriggerAuthenticationConfig,
  TriggerAuthenticationSpec,
  TriggerAuthenticationStatus,
} from '../types.js';
import { triggerAuthenticationReadinessEvaluator } from './readiness.js';

function authentication(
  kind: 'TriggerAuthentication' | 'ClusterTriggerAuthentication',
  config: Composable<TriggerAuthenticationConfig>
): Enhanced<TriggerAuthenticationSpec, TriggerAuthenticationStatus> {
  const namespaced = kind === 'TriggerAuthentication';
  return createResource<TriggerAuthenticationSpec, TriggerAuthenticationStatus>(
    {
      apiVersion: KEDA_API_VERSION,
      kind,
      metadata: {
        name: config.name,
        ...(namespaced && config.namespace ? { namespace: config.namespace } : {}),
        ...(config.labels ? { labels: config.labels as Record<string, string> } : {}),
        ...(config.annotations
          ? { annotations: config.annotations as Record<string, string> }
          : {}),
      },
      spec: config.spec as TriggerAuthenticationSpec,
      ...(config.id ? { id: config.id } : {}),
    },
    namespaced ? {} : { scope: 'cluster' }
  ).withReadinessEvaluator(triggerAuthenticationReadinessEvaluator);
}

/**
 * Create a namespaced `TriggerAuthentication`: credentials for the triggers
 * that name it in `authenticationRef`.
 *
 * @example
 * ```typescript
 * triggerAuthentication({
 *   name: 'prometheus-auth',
 *   spec: { secretTargetRef: [{ parameter: 'bearerToken', name: 'prometheus-reader', key: 'token' }] },
 * });
 * ```
 */
export function triggerAuthentication(
  config: Composable<TriggerAuthenticationConfig>
): Enhanced<TriggerAuthenticationSpec, TriggerAuthenticationStatus> {
  return authentication('TriggerAuthentication', config);
}

/**
 * Create a cluster-scoped `ClusterTriggerAuthentication`. Its
 * `secretTargetRef`s read from the KEDA install namespace. Reference it with
 * `authenticationRef: { name, kind: 'ClusterTriggerAuthentication' }`.
 *
 * @example
 * ```typescript
 * // AWS scalers authenticate as the KEDA operator (IRSA or EKS Pod Identity).
 * clusterTriggerAuthentication({ name: 'aws-keda', spec: { podIdentity: { provider: 'aws' } } });
 * ```
 */
export function clusterTriggerAuthentication(
  config: Composable<TriggerAuthenticationConfig>
): Enhanced<TriggerAuthenticationSpec, TriggerAuthenticationStatus> {
  return authentication('ClusterTriggerAuthentication', config);
}
