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
  }).withReadinessEvaluator((liveResource: V1CustomResourceDefinition) => {
    const status = liveResource.status;
    
    if (!status) {
      return {
        ready: false,
        reason: 'StatusMissing',
        message: 'CustomResourceDefinition status not available yet',
      };
    }

    const conditions = status.conditions || [];
    
    // Check for Established condition
    const established = conditions.find(c => c.type === 'Established');
    const namesAccepted = conditions.find(c => c.type === 'NamesAccepted');
    
    const isEstablished = established?.status === 'True';
    const areNamesAccepted = namesAccepted?.status === 'True';
    
    const ready = isEstablished && areNamesAccepted;
    
    if (ready) {
      return {
        ready: true,
        message: 'CustomResourceDefinition is established and names are accepted',
      };
    } else {
      const reasons = [];
      if (!isEstablished) reasons.push('not established');
      if (!areNamesAccepted) reasons.push('names not accepted');
      
      return {
        ready: false,
        reason: 'ConditionsNotMet',
        message: `CustomResourceDefinition is not ready: ${reasons.join(', ')}`,
        details: { conditions },
      };
    }
  });
}
