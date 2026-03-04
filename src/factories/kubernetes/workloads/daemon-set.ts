import type { V1DaemonSet } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1DaemonSetSpec = NonNullable<V1DaemonSet['spec']>;
export type V1DaemonSetStatus = NonNullable<V1DaemonSet['status']>;

/**
 * Creates a Kubernetes DaemonSet resource with node-level readiness evaluation.
 *
 * @param resource - The DaemonSet specification conforming to the Kubernetes V1DaemonSet API.
 * @returns An Enhanced DaemonSet resource that is ready when all desired pods across nodes are in the ready state.
 * @example
 * const agent = daemonSet({
 *   metadata: { name: 'log-agent' },
 *   spec: { selector: { matchLabels: { app: 'log-agent' } }, template: { ... } },
 * });
 */
export function daemonSet(resource: V1DaemonSet): Enhanced<V1DaemonSetSpec, V1DaemonSetStatus> {
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: resource.metadata ?? { name: 'unnamed-daemonset' },
  }).withReadinessEvaluator((liveResource: V1DaemonSet) => {
    try {
      const status = liveResource.status;
      if (!status) {
        return { ready: false, reason: 'No status available' };
      }

      const desiredNumberScheduled = status.desiredNumberScheduled || 0;
      const numberReady = status.numberReady || 0;

      const ready = desiredNumberScheduled > 0 && numberReady === desiredNumberScheduled;

      return {
        ready,
        reason: ready
          ? `All ${desiredNumberScheduled} pods are ready`
          : `${numberReady}/${desiredNumberScheduled} pods ready`,
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: `Error checking DaemonSet status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
