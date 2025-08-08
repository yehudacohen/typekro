import type { V1ReplicaSet } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource, processPodSpec } from '../../shared.js';

export type V1ReplicaSetSpec = NonNullable<V1ReplicaSet['spec']>;
export type V1ReplicaSetStatus = NonNullable<V1ReplicaSet['status']>;

export function replicaSet(resource: V1ReplicaSet): Enhanced<V1ReplicaSetSpec, V1ReplicaSetStatus> {
  if (resource.spec?.template?.spec) {
    const processed = processPodSpec(resource.spec.template.spec);
    if (processed) {
      resource.spec.template.spec = processed;
    }
  }
  return createResource({
    ...resource,
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: resource.metadata ?? { name: 'unnamed-replicaset' },
  });
}