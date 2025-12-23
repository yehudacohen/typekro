import type { V1ConfigMap } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ConfigMapData = NonNullable<V1ConfigMap['data']>;

// ConfigMap spec type - ConfigMaps don't have a traditional spec, they have data
// We use an empty spec type since ConfigMaps don't have a spec field in Kubernetes
type ConfigMapSpec = {}

// ConfigMap status type - ConfigMaps don't have status
type ConfigMapStatus = {}

export function configMap(resource: V1ConfigMap): Enhanced<ConfigMapSpec, ConfigMapStatus> {
  // ConfigMaps don't have a spec field in Kubernetes - data, binaryData, and immutable
  // are at the root level. We must NOT create a synthetic spec field or Kro will fail
  // with "schema not found for field spec" error.
  return createResource<ConfigMapSpec, ConfigMapStatus>({
    ...resource,
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: resource.metadata ?? { name: 'unnamed-configmap' },
    // Note: No spec field - ConfigMaps have data/binaryData/immutable at root level
  }).withReadinessEvaluator((_liveResource: V1ConfigMap) => {
    // ConfigMaps are ready when they exist - they're just data storage
    return {
      ready: true,
      message: 'ConfigMap is ready when created',
    };
  });
}
