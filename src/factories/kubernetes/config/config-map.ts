import type { V1ConfigMap } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1ConfigMapData = NonNullable<V1ConfigMap['data']>;

// ConfigMap spec type - ConfigMaps don't have a traditional spec, they have data
// We use an empty spec type since ConfigMaps don't have a spec field in Kubernetes
type ConfigMapSpec = {};

// ConfigMap status type - ConfigMaps don't have status
type ConfigMapStatus = {};

/**
 * Creates a Kubernetes ConfigMap resource that is considered ready immediately upon creation.
 *
 * @param resource - The ConfigMap specification conforming to the Kubernetes V1ConfigMap API.
 * @returns An Enhanced ConfigMap resource. ConfigMaps have no spec or status fields; readiness is always true.
 * @example
 * const cfg = configMap({
 *   metadata: { name: 'app-config' },
 *   data: { DATABASE_HOST: 'db.example.com', LOG_LEVEL: 'info' },
 * });
 */
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
  }).withReadinessEvaluator(createAlwaysReadyEvaluator<V1ConfigMap>('ConfigMap'));
}
