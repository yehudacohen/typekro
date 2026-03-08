import type { V1Endpoints } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export function endpoints(resource: V1Endpoints): V1Endpoints & Enhanced<V1Endpoints, object> {
  return createResource<V1Endpoints, object>({
    ...resource,
    apiVersion: 'v1',
    kind: 'Endpoints',
    metadata: resource.metadata ?? { name: 'unnamed-endpoints' },
  }).withReadinessEvaluator((liveResource: V1Endpoints) => {
    try {
      const subsets = liveResource.subsets || [];

      // Endpoints are ready when they have at least one subset with addresses
      const hasAddresses = subsets.some(
        (subset) => subset.addresses && subset.addresses.length > 0
      );

      if (hasAddresses) {
        const totalAddresses = subsets.reduce(
          (sum, subset) => sum + (subset.addresses?.length || 0),
          0
        );
        return {
          ready: true,
          message: `Endpoints is ready with ${totalAddresses} addresses across ${subsets.length} subsets`,
        };
      } else {
        return {
          ready: false,
          reason: 'NoAddresses',
          message: 'Endpoints has no addresses yet',
          details: { subsets: subsets.length },
        };
      }
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Endpoints readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }) as V1Endpoints & Enhanced<V1Endpoints, object>;
}
