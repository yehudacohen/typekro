import type { V1Namespace } from '@kubernetes/client-node';
import { ensureError } from '../../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1NamespaceSpec = NonNullable<V1Namespace['spec']>;
export type V1NamespaceStatus = NonNullable<V1Namespace['status']>;

export interface NamespaceConfig extends V1Namespace {
  id?: string;
}

const namespaceReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kubernetes.namespace',
  '1',
  (liveResource: V1Namespace) => {
    try {
      const status = liveResource.status;
      if (!status) {
        return {
          ready: false,
          reason: 'StatusMissing',
          message: 'Namespace status not available yet',
        };
      }
      const phase = status.phase;
      if (phase === 'Active') return { ready: true, message: 'Namespace is active and ready' };
      return {
        ready: false,
        reason: 'NotActive',
        message: `Namespace phase is ${phase || 'unknown'}, waiting for Active phase`,
        details: { phase },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating namespace readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }
);

/**
 * Creates a Kubernetes Namespace resource with phase-based readiness evaluation.
 *
 * @param resource - The Namespace configuration conforming to V1Namespace with an optional `id` field.
 * @returns An Enhanced Namespace resource that is ready when the namespace phase is Active.
 * @example
 * const ns = namespace({
 *   metadata: { name: 'my-namespace' },
 * });
 */
export function namespace(resource: NamespaceConfig): Enhanced<V1NamespaceSpec, V1NamespaceStatus> {
  return createResource(
    {
      ...resource,
      ...(resource.id && { id: resource.id }),
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: resource.metadata ?? { name: 'unnamed-namespace' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(namespaceReadinessEvaluator);
}
