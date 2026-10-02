// `ScaledObject` factory (`keda.sh/v1alpha1`).

import type { Composable, Enhanced, KubernetesResource } from '../../../core/types/index.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { createResource } from '../../shared.js';
import { KEDA_API_VERSION } from '../constants.js';
import type {
  KedaScaleTargetRef,
  KedaScaleTargetResource,
  ScaledObjectConfig,
  ScaledObjectSpec,
  ScaledObjectStatus,
} from '../types.js';
import {
  assertNoKedaErrors,
  findKedaAutoscalerConflicts,
  validateScaledObjectSpec,
  warnKedaIssues,
} from '../utils/validation.js';
import { scaledObjectReadinessEvaluator } from './readiness.js';

function isTargetResource(
  target: KedaScaleTargetRef | KedaScaleTargetResource
): target is KedaScaleTargetResource {
  return typeof (target as KedaScaleTargetResource).metadata === 'object';
}

/**
 * Create a KEDA `ScaledObject`. KEDA creates and owns an HPA for the target;
 * the target must not have one of its own. Pass the workload resource as
 * `scaleTargetRef` to also order the ScaledObject after it.
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
 *     scaleTargetRef: worker, // the Deployment resource, or { name: 'worker' }
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
  const input = config.spec as ScaledObjectConfig['spec'];
  const target = isKubernetesRef(input) ? undefined : input.scaleTargetRef;
  const targetResource = target && isTargetResource(target) ? target : undefined;
  const spec = (
    targetResource
      ? {
          ...input,
          scaleTargetRef: {
            apiVersion: targetResource.apiVersion,
            kind: targetResource.kind,
            name: targetResource.metadata.name as string,
          },
        }
      : input
  ) as ScaledObjectSpec;
  const issues = validateScaledObjectSpec(spec);
  assertNoKedaErrors('ScaledObject', config.name, issues);
  warnKedaIssues('scaledObject', [
    ...issues,
    ...findKedaAutoscalerConflicts(spec, config.namespace as string | undefined),
  ]);
  const scaler = createResource<ScaledObjectSpec, ScaledObjectStatus>({
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
  // KEDA's webhook rejects a ScaledObject whose target does not exist yet.
  if (
    targetResource &&
    typeof (targetResource as { dependsOn?: unknown }).dependsOn === 'function'
  ) {
    scaler.dependsOn(targetResource as unknown as KubernetesResource);
  }
  return scaler;
}
