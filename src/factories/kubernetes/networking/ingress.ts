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
      const metadata = liveResource.metadata;

      // Ingress is considered ready if:
      // 1. It has load balancer ingress endpoints (traditional cloud LB), OR
      // 2. It has been processed by the ingress controller (has resourceVersion and generation)
      //
      // This is because some ingress controllers (like APISIX, nginx-ingress in some modes)
      // don't populate the loadBalancer.ingress field, but the Ingress is still functional.

      // Check for load balancer endpoints (preferred)
      const loadBalancer = status?.loadBalancer;
      const ingresses = loadBalancer?.ingress || [];
      if (ingresses.length > 0) {
        return {
          ready: true,
          reason: `Ingress has ${ingresses.length} load balancer endpoint(s)`,
        };
      }

      // Check if the resource has been processed (has resourceVersion and generation match)
      // This indicates the ingress controller has seen and processed the resource
      const hasBeenProcessed = metadata?.resourceVersion && metadata?.generation !== undefined;
      
      // Also check if observedGeneration matches generation (if available in status)
      // Some ingress controllers set this to indicate they've processed the resource
      const observedGeneration = (status as any)?.observedGeneration;
      const generationMatches = observedGeneration === undefined || observedGeneration === metadata?.generation;

      if (hasBeenProcessed && generationMatches) {
        // Give the ingress controller a moment to populate status
        // If we've been processed and no errors, consider it ready
        return {
          ready: true,
          reason: 'Ingress has been processed by the controller (no load balancer endpoints yet, but resource is active)',
        };
      }

      return {
        ready: false,
        reason: 'Waiting for ingress controller to process the resource',
      };
    } catch (error) {
      return {
        ready: false,
        reason: `Error checking Ingress status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
