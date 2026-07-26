/**
 * Kro-generated CustomResourceDefinition factory
 */

import type { V1CustomResourceDefinition } from '@kubernetes/client-node';
import { ensureError } from '../../core/errors.js';
import { registerPortableReadinessEvaluator } from '../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../core/types/index.js';
import type {
  V1CustomResourceDefinitionSpec,
  V1CustomResourceDefinitionStatus,
} from '../kubernetes/types.js';
import { createResource } from '../shared.js';

const kroCustomResourceDefinitionReadinessEvaluator = registerPortableReadinessEvaluator(
  'typekro.readiness.kro.generated-crd',
  '1',
  (liveCRD: V1CustomResourceDefinition): ResourceStatus => {
    try {
      const conditions = liveCRD.status?.conditions || [];
      const establishedCondition = conditions.find((condition) => condition.type === 'Established');
      const namesAcceptedCondition = conditions.find(
        (condition) => condition.type === 'NamesAccepted'
      );
      const isEstablished = establishedCondition?.status === 'True';
      const namesAccepted = namesAcceptedCondition?.status === 'True';
      const isKroCRD = liveCRD.metadata?.name?.endsWith('.kro.run');

      if (isEstablished && namesAccepted && isKroCRD) {
        return {
          ready: true,
          message: `Kro-generated CRD ${liveCRD.metadata?.name} is established and ready for instances`,
        };
      }
      return {
        ready: false,
        reason: 'KroCRDNotReady',
        message: `Kro CRD not ready - Established: ${establishedCondition?.status || 'Unknown'}, NamesAccepted: ${namesAcceptedCondition?.status || 'Unknown'}`,
        details: { conditions, isKroCRD, crdName: liveCRD.metadata?.name },
      };
    } catch (error: unknown) {
      return {
        ready: false,
        reason: 'EvaluationError',
        message: `Error evaluating Kro CRD readiness: ${ensureError(error).message}`,
        details: { error: ensureError(error).message },
      };
    }
  }
);

/**
 * Kro-generated CustomResourceDefinition factory
 *
 * Creates an Enhanced CustomResourceDefinition with Kro-specific readiness logic
 * that checks for established condition and proper Kro naming convention.
 */
export function kroCustomResourceDefinition(
  crd: V1CustomResourceDefinition
): Enhanced<V1CustomResourceDefinitionSpec, V1CustomResourceDefinitionStatus> {
  return createResource(
    {
      ...crd,
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: crd.metadata ?? { name: 'unnamed-crd' },
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(kroCustomResourceDefinitionReadinessEvaluator);
}
