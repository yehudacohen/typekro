import type { V1Service } from '@kubernetes/client-node';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { V1ServiceSpec, V1ServiceStatus } from '../types.js';

export function service(resource: V1Service): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  // Capture service type in closure for readiness evaluation
  // Handle the case where type might be a KubernetesRef (magic proxy) instead of a string
  const rawType = resource.spec?.type;
  const staticServiceType = typeof rawType === 'string' ? rawType : null;

  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'Service',
    metadata: resource.metadata ?? { name: 'unnamed-service' },
  }).withReadinessEvaluator((liveResource: V1Service): ResourceStatus => {
    // Use the live resource's spec.type if we don't have a static value
    // This handles the case where type was a KubernetesRef that got resolved during deployment
    const serviceType = staticServiceType ?? liveResource.spec?.type ?? 'ClusterIP';

    try {
      if (serviceType === 'LoadBalancer') {
        const ingress = liveResource.status?.loadBalancer?.ingress;
        const hasIngress = !!(
          ingress &&
          ingress.length > 0 &&
          (ingress[0]?.ip || ingress[0]?.hostname)
        );

        if (hasIngress) {
          return {
            ready: true,
            message: `LoadBalancer service has external endpoint: ${ingress?.[0]?.ip || ingress?.[0]?.hostname}`,
          };
        } else {
          return {
            ready: false,
            reason: 'LoadBalancerPending',
            message: 'Waiting for LoadBalancer to assign external IP or hostname',
            details: { serviceType, ingressStatus: ingress },
          };
        }
      } else if (serviceType === 'ExternalName') {
        const hasExternalName = !!liveResource.spec?.externalName;

        if (hasExternalName) {
          return {
            ready: true,
            message: `ExternalName service configured with: ${liveResource.spec?.externalName}`,
          };
        } else {
          return {
            ready: false,
            reason: 'ExternalNameMissing',
            message: 'ExternalName service missing externalName field',
            details: { serviceType },
          };
        }
      }

      // ClusterIP and NodePort services are ready when created
      return {
        ready: true,
        message: `${serviceType} service is ready`,
      };
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating service readiness: ${error}`,
        details: { serviceType, error: String(error) },
      };
    }
  });
}
