import type { V1Ingress } from '@kubernetes/client-node';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1IngressSpec = NonNullable<V1Ingress['spec']>;

export function ingress(resource: V1Ingress): Enhanced<V1IngressSpec, any> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: resource.metadata ?? { name: 'unnamed-ingress' },
  }).withReadinessEvaluator((liveResource: V1Ingress): ResourceStatus => {
    try {
      const status = liveResource.status;
      const metadata = liveResource.metadata;

      // Tier 1: Check for load balancer endpoints with actual ip or hostname
      // This is the primary readiness signal for cloud-provisioned ingress controllers
      const ingresses = status?.loadBalancer?.ingress || [];
      if (ingresses.length > 0) {
        const hasEndpoint = ingresses.some((entry) => entry.ip || entry.hostname);
        if (hasEndpoint) {
          const endpoint = ingresses[0]?.ip || ingresses[0]?.hostname;
          return {
            ready: true,
            message: `Ingress has load balancer endpoint: ${endpoint}`,
          };
        }
        // LB ingress entries exist but have no ip/hostname — still provisioning
        return {
          ready: false,
          reason: 'LoadBalancerProvisioning',
          message: 'Load balancer ingress entries exist but no IP or hostname assigned yet',
        };
      }

      // Tier 2: Check if the ingress controller has acknowledged the resource
      // via status.observedGeneration. This handles controllers that don't populate
      // loadBalancer status (e.g., some APISIX/nginx modes).
      // NOTE: metadata.resourceVersion and metadata.generation are set by the API server
      // on creation — they do NOT indicate controller processing. Only a controller-written
      // status.observedGeneration reliably indicates the controller has seen the resource.
      const observedGeneration = (status as any)?.observedGeneration;
      if (observedGeneration !== undefined && observedGeneration === metadata?.generation) {
        return {
          ready: true,
          message:
            'Ingress controller has processed the resource (observedGeneration matches generation)',
        };
      }

      return {
        ready: false,
        reason: 'WaitingForController',
        message: 'Waiting for ingress controller to process the resource',
        details: {
          generation: metadata?.generation,
          observedGeneration,
          hasLoadBalancer: !!status?.loadBalancer,
        },
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error checking Ingress status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
