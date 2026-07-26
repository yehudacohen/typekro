import type { V1Ingress, V1IngressStatus } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import { registerFactory } from '../../../core/resources/factory-registry.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

// Self-register with semantic alias for fuzzy resource key matching.
registerFactory({
  factoryName: 'Ingress',
  kind: 'Ingress',
  apiVersion: 'networking.k8s.io/v1',
  semanticAliases: ['ingress'],
});

export type V1IngressSpec = NonNullable<V1Ingress['spec']>;

const ingressReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.ingress',
  '1',
  (liveResource: V1Ingress): ResourceStatus => {
    try {
      const status = liveResource.status;
      const metadata = liveResource.metadata;
      const ingresses = status?.loadBalancer?.ingress || [];
      if (ingresses.length > 0) {
        const hasEndpoint = ingresses.some((entry) => entry.ip || entry.hostname);
        if (hasEndpoint) {
          const endpoint = ingresses[0]?.ip || ingresses[0]?.hostname;
          return { ready: true, message: `Ingress has load balancer endpoint: ${endpoint}` };
        }
        return {
          ready: false,
          reason: 'LoadBalancerProvisioning',
          message: 'Load balancer ingress entries exist but no IP or hostname assigned yet',
        };
      }
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
  }
);

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
export function ingress(
  resource: V1Ingress & { id?: string }
): Enhanced<V1IngressSpec, V1IngressStatus> {
  return createResource({
    ...resource,
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: resource.metadata ?? { name: 'unnamed-ingress' },
  }).withReadinessEvaluator(ingressReadinessEvaluator);
}
