import type { V1Ingress, V1IngressStatus } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1IngressSpec = NonNullable<V1Ingress['spec']>;

/**
 * Creates a Kubernetes Ingress resource with multi-tier readiness evaluation.
 *
 * @param resource - The Ingress specification conforming to the Kubernetes V1Ingress API.
 * @returns An Enhanced Ingress resource that evaluates readiness by checking for load balancer endpoints first, then falling back to observedGeneration matching.
 * @example
 * const ing = ingress({
 *   metadata: { name: 'my-ingress' },
 *   spec: { rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'my-svc', port: { number: 80 } } } }] } }] },
 * });
 */
export function ingress(resource: V1Ingress): Enhanced<V1IngressSpec, V1IngressStatus> {
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
      // observedGeneration is set by some ingress controllers but not in the K8s client-node types
      const observedGeneration = (status as Record<string, unknown> | undefined)
        ?.observedGeneration as number | undefined;
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
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error checking Ingress status: ${ensureError(error).message}`,
      };
    }
  });
}
