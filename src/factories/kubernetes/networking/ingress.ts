import type { V1Ingress } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1IngressSpec = NonNullable<V1Ingress['spec']>;

export function ingress(resource: V1Ingress): Enhanced<V1IngressSpec, any> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: resource.metadata ?? { name: 'unnamed-ingress' },
  }).withReadinessEvaluator((liveResource: V1Ingress) => {
    try {
      const status = liveResource.status;

      if (!status) {
        return { ready: false, reason: 'No status available' };
      }

      // Ingress is ready when it has load balancer ingress
      const loadBalancer = status.loadBalancer;
      const ingresses = loadBalancer?.ingress || [];

      const ready = ingresses.length > 0;

      return {
        ready,
        reason: ready
          ? `Ingress has ${ingresses.length} load balancer endpoint(s)`
          : 'Waiting for load balancer to assign endpoints',
      };
    } catch (error) {
      return {
        ready: false,
        reason: `Error checking Ingress status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
