// `ScaledObject` factory (`keda.sh/v1alpha1`).

import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { KEDA_API_VERSION } from '../constants.js';
import type { ScaledObjectConfig, ScaledObjectSpec, ScaledObjectStatus } from '../types.js';
import {
  assertNoKedaErrors,
  findKedaAutoscalerConflicts,
  validateScaledObjectSpec,
  warnKedaIssues,
} from '../utils/validation.js';
import { scaledObjectReadinessEvaluator } from './readiness.js';

/**
 * Create a KEDA `ScaledObject`. KEDA creates and owns an HPA for the target;
 * the target must not have one of its own.
 *
 * Ready on `Ready=True`. Throws on the errors {@link validateScaledObjectSpec}
 * reports, and warns about an HPA, or a VPA setting the same resource, on the
 * target in the same composition.
 *
 * @example
 * ```typescript
 * scaledObject({
 *   name: 'worker',
 *   spec: {
 *     scaleTargetRef: { name: 'worker' },
 *     minReplicaCount: 0,
 *     maxReplicaCount: 20,
 *     triggers: [
 *       {
 *         type: 'aws-sqs-queue',
 *         metadata: { queueURL: 'https://sqs.us-east-1.amazonaws.com/111122223333/jobs', queueLength: '10', awsRegion: 'us-east-1' },
 *         authenticationRef: { name: 'aws-keda' },
 *       },
 *     ],
 *   },
 *   id: 'workerScaler',
 * });
 * ```
 */
export function scaledObject(
  config: Composable<ScaledObjectConfig>
): Enhanced<ScaledObjectSpec, ScaledObjectStatus> {
  const spec = config.spec as ScaledObjectSpec;
  const issues = validateScaledObjectSpec(spec);
  assertNoKedaErrors('ScaledObject', config.name, issues);
  warnKedaIssues('scaledObject', [
    ...issues,
    ...findKedaAutoscalerConflicts(spec, config.namespace as string | undefined),
  ]);
  return createResource<ScaledObjectSpec, ScaledObjectStatus>({
    apiVersion: KEDA_API_VERSION,
    kind: 'ScaledObject',
    metadata: {
      name: config.name,
      ...(config.namespace ? { namespace: config.namespace } : {}),
      ...(config.labels ? { labels: config.labels as Record<string, string> } : {}),
      ...(config.annotations ? { annotations: config.annotations as Record<string, string> } : {}),
    },
    spec,
    ...(config.id ? { id: config.id } : {}),
  }).withReadinessEvaluator(scaledObjectReadinessEvaluator);
}
