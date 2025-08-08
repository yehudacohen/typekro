/**
 * Kro-generated CustomResourceDefinition factory
 */

import type { V1CustomResourceDefinition } from '@kubernetes/client-node';
import type { Enhanced, ResourceStatus } from '../../core/types/index.js';
import { createResource } from '../shared.js';
import type { V1CustomResourceDefinitionSpec, V1CustomResourceDefinitionStatus } from '../kubernetes/types.js';

/**
 * Kro-generated CustomResourceDefinition factory
 * 
 * Creates an Enhanced CustomResourceDefinition with Kro-specific readiness logic
 * that checks for established condition and proper Kro naming convention.
 */
export function kroCustomResourceDefinition(crd: V1CustomResourceDefinition): Enhanced<V1CustomResourceDefinitionSpec, V1CustomResourceDefinitionStatus> {
  return createResource({
    ...crd,
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: crd.metadata ?? { name: 'unnamed-crd' },
  }).withReadinessEvaluator((liveCRD: V1CustomResourceDefinition): ResourceStatus => {
    try {
      const status = liveCRD.status;
      const conditions = status?.conditions || [];
      
      const establishedCondition = conditions.find(c => c.type === 'Established');
      const namesAcceptedCondition = conditions.find(c => c.type === 'NamesAccepted');
      
      const isEstablished = establishedCondition?.status === 'True';
      const namesAccepted = namesAcceptedCondition?.status === 'True';
      const isKroCRD = liveCRD.metadata?.name?.endsWith('.kro.run');
      
      if (isEstablished && namesAccepted && isKroCRD) {
        return {
          ready: true,
          message: `Kro-generated CRD ${liveCRD.metadata?.name} is established and ready for instances`
        };
      } else {
        return {
          ready: false,
          reason: 'KroCRDNotReady',
          message: `Kro CRD not ready - Established: ${establishedCondition?.status || 'Unknown'}, NamesAccepted: ${namesAcceptedCondition?.status || 'Unknown'}`,
          details: { conditions, isKroCRD, crdName: liveCRD.metadata?.name }
        };
      }
    } catch (error) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Kro CRD readiness: ${error}`,
        details: { error: String(error) }
      };
    }
  });
}