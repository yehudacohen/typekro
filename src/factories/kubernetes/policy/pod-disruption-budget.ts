import type { V1PodDisruptionBudget } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1PdbSpec = NonNullable<V1PodDisruptionBudget['spec']>;
export type V1PdbStatus = NonNullable<V1PodDisruptionBudget['status']>;

export function podDisruptionBudget(
  resource: V1PodDisruptionBudget
): Enhanced<V1PdbSpec, V1PdbStatus> {
  return createResource({
    ...resource,
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: resource.metadata ?? { name: 'unnamed-pdb' },
  });
}