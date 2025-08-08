import type { V1ReplicationController } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource, processPodSpec } from '../../shared.js';

export type V1ReplicationControllerSpec = NonNullable<V1ReplicationController['spec']>;
export type V1ReplicationControllerStatus = NonNullable<V1ReplicationController['status']>;

export function replicationController(
  resource: V1ReplicationController
): Enhanced<V1ReplicationControllerSpec, V1ReplicationControllerStatus> {
  if (resource.spec?.template?.spec) {
    const processed = processPodSpec(resource.spec.template.spec);
    if (processed) {
      resource.spec.template.spec = processed;
    }
  }
  return createResource({
    ...resource,
    apiVersion: 'v1',
    kind: 'ReplicationController',
    metadata: resource.metadata ?? { name: 'unnamed-replicationcontroller' },
  });
}