import type { V1CustomResourceDefinition } from '@kubernetes/client-node';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';

export type V1CustomResourceDefinitionSpec = NonNullable<V1CustomResourceDefinition['spec']>;
export type V1CustomResourceDefinitionStatus = NonNullable<V1CustomResourceDefinition['status']>;

export function customResourceDefinition(
  resource: V1CustomResourceDefinition
): Enhanced<V1CustomResourceDefinitionSpec, V1CustomResourceDefinitionStatus> {
  return createResource({
    ...resource,
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: resource.metadata ?? { name: 'unnamed-crd' },
  });
}