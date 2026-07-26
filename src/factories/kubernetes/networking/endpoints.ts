import type { V1Endpoints } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

const endpointsReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.endpoints',
  '1',
  (liveResource: V1Endpoints) => {
    try {
      const subsets = liveResource.subsets || [];
      const hasAddresses = subsets.some((subset) => (subset.addresses?.length ?? 0) > 0);
      if (hasAddresses) {
        const totalAddresses = subsets.reduce(
          (sum, subset) => sum + (subset.addresses?.length || 0),
          0
        );
        return {
          ready: true,
          message: `Endpoints is ready with ${totalAddresses} addresses across ${subsets.length} subsets`,
        };
      }
      return {
        ready: false,
        reason: 'NoAddresses',
        message: 'Endpoints has no addresses yet',
        details: { subsets: subsets.length },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Endpoints readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }
);

export function endpoints(
  resource: V1Endpoints & { id?: string }
): V1Endpoints & Enhanced<V1Endpoints, object> {
  return createResource<V1Endpoints, object>({
    ...resource,
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: resource.metadata ?? { name: 'unnamed-endpoints' },
  }).withReadinessEvaluator(endpointsReadinessEvaluator) as V1Endpoints &
    Enhanced<V1Endpoints, object>;
}
