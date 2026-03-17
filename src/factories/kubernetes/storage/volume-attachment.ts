import type { V1VolumeAttachment } from '@kubernetes/client-node';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1VolumeAttachmentSpec = NonNullable<V1VolumeAttachment['spec']>;
export type V1VolumeAttachmentStatus = NonNullable<V1VolumeAttachment['status']>;

export function volumeAttachment(
  resource: V1VolumeAttachment & { id?: string }
): Enhanced<V1VolumeAttachmentSpec, V1VolumeAttachmentStatus> {
  return createResource({
    ...resource,
    apiVersion: 'storage.k8s.io/v1',
    kind: 'VolumeAttachment',
    metadata: resource.metadata ?? { name: 'unnamed-volumeattachment' },
  }).withReadinessEvaluator((liveResource: V1VolumeAttachment): ResourceStatus => {
    const attached = liveResource.status?.attached;
    if (attached === true) {
      return { ready: true, message: 'VolumeAttachment is attached' };
    }
    return {
      ready: false,
      reason: 'NotAttached',
      message: `VolumeAttachment is not yet attached (attached=${attached})`,
    };
  });
}
