import type { V1RuntimeClass } from '@kubernetes/client-node';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/evaluator-factories.js';
import { createResource } from '../../shared.js';

export type V1RuntimeClassHandler = V1RuntimeClass;

export function runtimeClass(resource: V1RuntimeClass) {
  return createResource({
    ...resource,
    apiVersion: 'node.k8s.io/v1',
    kind: 'RuntimeClass',
    metadata: resource.metadata ?? { name: 'unnamed-runtimeclass' },
  }).withReadinessEvaluator(createAlwaysReadyEvaluator('RuntimeClass'));
}
