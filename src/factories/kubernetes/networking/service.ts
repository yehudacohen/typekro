import type { V1Service } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../../core/readiness/portable-strategies.js';
import {
  optionalReadinessString,
  readinessConfiguration,
  readinessLiteral,
} from '../../../core/readiness/strategy-configuration.js';
import { registerFactory } from '../../../core/resources/factory-registry.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type { V1ServiceSpec, V1ServiceStatus } from '../types.js';

// Self-register with semantic aliases for fuzzy resource key matching.
registerFactory({
  factoryName: 'Service',
  kind: 'Service',
  apiVersion: 'v1',
  semanticAliases: ['service', 'svc'],
});

const SERVICE_READINESS_STRATEGY = 'typekro.readiness.kubernetes.service';
const SERVICE_READINESS_REVISION = '1';

function createServiceReadinessEvaluator(
  staticServiceType?: string
): (liveResource: unknown) => ResourceStatus {
  const evaluator = (input: unknown): ResourceStatus => {
    const liveResource = input as V1Service;
    const serviceType = staticServiceType ?? liveResource.spec?.type ?? 'ClusterIP';

    try {
      if (serviceType === 'LoadBalancer') {
        const ingress = liveResource.status?.loadBalancer?.ingress;
        const hasIngress = !!(
          ingress &&
          ingress.length > 0 &&
          (ingress[0]?.ip || ingress[0]?.hostname)
        );

        return hasIngress
          ? {
              ready: true,
              message: `LoadBalancer service has external endpoint: ${ingress?.[0]?.ip || ingress?.[0]?.hostname}`,
            }
          : {
              ready: false,
              reason: 'LoadBalancerPending',
              message: 'Waiting for LoadBalancer to assign external IP or hostname',
              details: { serviceType, ingressStatus: ingress },
            };
      }

      if (serviceType === 'ExternalName') {
        const hasExternalName = !!liveResource.spec?.externalName;
        return hasExternalName
          ? {
              ready: true,
              message: `ExternalName service configured with: ${liveResource.spec?.externalName}`,
            }
          : {
              ready: false,
              reason: 'ExternalNameMissing',
              message: 'ExternalName service missing externalName field',
              details: { serviceType },
            };
      }

      return {
        ready: true,
        message: `${serviceType} service is ready`,
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating service readiness: ${ensureError(error).message}`,
        details: { serviceType, error: ensureError(error).message },
      };
    }
  };

  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: SERVICE_READINESS_STRATEGY,
    revision: SERVICE_READINESS_REVISION,
    configuration: readinessConfiguration({
      serviceType:
        staticServiceType === undefined ? undefined : readinessLiteral(staticServiceType),
    }),
  });
}

registerPortableReadinessStrategy(
  SERVICE_READINESS_STRATEGY,
  SERVICE_READINESS_REVISION,
  (configuration) =>
    createServiceReadinessEvaluator(optionalReadinessString(configuration, 'serviceType'))
);

/**
 * Creates a Kubernetes Service resource with type-aware readiness evaluation.
 *
 * @param resource - The Service specification conforming to the Kubernetes V1Service API.
 * @returns An Enhanced Service resource that evaluates readiness based on service type (LoadBalancer waits for an external endpoint; ClusterIP and NodePort are ready immediately).
 * @example
 * const svc = service({
 *   metadata: { name: 'my-svc' },
 *   spec: { type: 'ClusterIP', ports: [{ port: 80 }], selector: { app: 'my-app' } },
 * });
 */
export function service(
  resource: V1Service & { id?: string }
): Enhanced<V1ServiceSpec, V1ServiceStatus> {
  // Capture service type in closure for readiness evaluation
  // Handle the case where type might be a KubernetesRef (magic proxy) instead of a string
  const rawType = resource.spec?.type;
  const staticServiceType = typeof rawType === 'string' ? rawType : null;

  return createResource(
    {
      ...resource,
      apiVersion: 'v1',
      kind: 'Service',
      metadata: resource.metadata ?? { name: 'unnamed-service' },
    },
    { dnsAddressable: true }
  ).withReadinessEvaluator(createServiceReadinessEvaluator(staticServiceType ?? undefined));
}
