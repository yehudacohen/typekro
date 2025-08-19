import type { V1Namespace } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NamespaceSpec = NonNullable<V1Namespace['spec']>;
export type V1NamespaceStatus = NonNullable<V1Namespace['status']>;

export interface NamespaceConfig extends V1Namespace {
  id?: string;
}

export function namespace(resource: NamespaceConfig): Enhanced<V1NamespaceSpec, V1NamespaceStatus> {
  return createResource({
    ...resource,
    ...(resource.id && { id: resource.id }),
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: resource.metadata ?? { name: 'unnamed-namespace' },
  }).withReadinessEvaluator((liveResource: V1Namespace) => {
    try {
      const status = liveResource.status;

      // Handle missing status gracefully
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'Namespace status not available yet',
        };
      }

      const phase = status.phase;

      // Namespace is ready when phase is Active
      const ready = phase === 'Active';

      if (ready) {
        return {
          ready: true,
          message: 'Namespace is active and ready',
        };
      } else {
        return {
          ready: false,
          reason: 'NotActive',
          message: `Namespace phase is ${phase || 'unknown'}, waiting for Active phase`,
          details: { phase },
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating namespace readiness: ${error}`,
        details: { error: String(error) },
      };
    }
  });
}
