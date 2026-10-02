// `ScaledJob` factory (`keda.sh/v1alpha1`).

import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { KEDA_API_VERSION } from '../constants.js';
import type { ScaledJobConfig, ScaledJobSpec, ScaledJobStatus } from '../types.js';
import { assertNoKedaErrors, validateScaledJobSpec, warnKedaIssues } from '../utils/validation.js';
import { scaledJobReadinessEvaluator } from './readiness.js';

/**
 * Create a KEDA `ScaledJob`: KEDA starts Jobs from `jobTargetRef` as the
 * triggers demand, up to `maxReplicaCount` at once. Ready on `Ready=True`.
 *
 * @example
 * ```typescript
 * scaledJob({
 *   name: 'transcode',
 *   spec: {
 *     jobTargetRef: {
 *       template: { spec: { restartPolicy: 'Never', containers: [{ name: 'transcode', image: 'transcoder:1.4' }] } },
 *     },
 *     maxReplicaCount: 10,
 *     triggers: [{ type: 'redis', metadata: { address: 'redis.queues.svc:6379', listName: 'transcode', listLength: '1' } }],
 *   },
 *   id: 'transcodeJobs',
 * });
 * ```
 */
export function scaledJob(
  config: Composable<ScaledJobConfig>
): Enhanced<ScaledJobSpec, ScaledJobStatus> {
  const spec = config.spec as ScaledJobSpec;
  const issues = validateScaledJobSpec(spec);
  assertNoKedaErrors('ScaledJob', config.name, issues);
  warnKedaIssues('scaledJob', issues);
  return createResource<ScaledJobSpec, ScaledJobStatus>({
    apiVersion: KEDA_API_VERSION,
    kind: 'ScaledJob',
    metadata: {
      name: config.name,
      ...(config.namespace ? { namespace: config.namespace } : {}),
      ...(config.labels ? { labels: config.labels as Record<string, string> } : {}),
      ...(config.annotations ? { annotations: config.annotations as Record<string, string> } : {}),
    },
    spec,
    ...(config.id ? { id: config.id } : {}),
  }).withReadinessEvaluator(scaledJobReadinessEvaluator);
}
