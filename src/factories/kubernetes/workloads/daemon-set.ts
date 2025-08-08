import type { V1DaemonSet } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource, processPodSpec } from '../../shared.js';

export type V1DaemonSetSpec = NonNullable<V1DaemonSet['spec']>;
export type V1DaemonSetStatus = NonNullable<V1DaemonSet['status']>;

export function daemonSet(resource: V1DaemonSet): Enhanced<V1DaemonSetSpec, V1DaemonSetStatus> {
  if (resource.spec?.template?.spec) {
    const processed = processPodSpec(resource.spec.template.spec);
    if (processed) {
      resource.spec.template.spec = processed;
    }
  }
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: resource.metadata ?? { name: 'unnamed-daemonset' },
  });
}