// `VerticalPodAutoscaler` factory (`autoscaling.k8s.io/v1`) and the
// recommend-only shorthand.

import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { VPA_API_VERSION } from '../constants.js';
import type {
  VerticalPodAutoscalerConfig,
  VerticalPodAutoscalerSpec,
  VerticalPodAutoscalerStatus,
  VpaRecommendOnlyOptions,
  VpaTargetRef,
  VpaTargetResource,
} from '../types.js';
import {
  assertNoVpaErrors,
  findVpaAutoscalerConflicts,
  validateVerticalPodAutoscalerSpec,
  warnVpaIssues,
} from '../utils/validation.js';
import { vpaAcceptedReadinessEvaluator, vpaRecommendationReadinessEvaluator } from './readiness.js';

/**
 * Create a `VerticalPodAutoscaler`.
 *
 * Readiness waits for `RecommendationProvided=True` unless `readiness:
 * 'accepted'`. Throws on the errors {@link validateVerticalPodAutoscalerSpec}
 * reports, and warns when an HPA or ScaledObject in the same composition
 * scales the target on a resource this VPA sets.
 *
 * @example
 * ```typescript
 * verticalPodAutoscaler({
 *   name: 'api',
 *   spec: {
 *     targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api' },
 *     updatePolicy: { updateMode: 'InPlaceOrRecreate', minReplicas: 2 },
 *     resourcePolicy: {
 *       containerPolicies: [
 *         { containerName: '*', minAllowed: { cpu: '50m', memory: '64Mi' }, maxAllowed: { cpu: '2', memory: '4Gi' } },
 *       ],
 *     },
 *   },
 *   id: 'apiVpa',
 * });
 * ```
 */
export function verticalPodAutoscaler(
  config: Composable<VerticalPodAutoscalerConfig>
): Enhanced<VerticalPodAutoscalerSpec, VerticalPodAutoscalerStatus> {
  const spec = config.spec as VerticalPodAutoscalerSpec;
  const issues = validateVerticalPodAutoscalerSpec(spec);
  assertNoVpaErrors(config.name, issues);
  warnVpaIssues('verticalPodAutoscaler', [
    ...issues,
    ...findVpaAutoscalerConflicts(spec, config.namespace as string | undefined),
  ]);
  const evaluator =
    config.readiness === 'accepted'
      ? vpaAcceptedReadinessEvaluator
      : vpaRecommendationReadinessEvaluator;
  return createResource<VerticalPodAutoscalerSpec, VerticalPodAutoscalerStatus>({
    apiVersion: VPA_API_VERSION,
    kind: 'VerticalPodAutoscaler',
    metadata: {
      name: config.name,
      ...(config.namespace ? { namespace: config.namespace } : {}),
      ...(config.labels ? { labels: config.labels as Record<string, string> } : {}),
      ...(config.annotations ? { annotations: config.annotations as Record<string, string> } : {}),
    },
    spec,
    ...(config.id ? { id: config.id } : {}),
  }).withReadinessEvaluator(evaluator);
}

function isTargetResource(target: VpaTargetRef | VpaTargetResource): target is VpaTargetResource {
  return typeof (target as VpaTargetResource).metadata === 'object';
}

/**
 * A VPA in `updateMode: 'Off'`: it records recommendations and changes
 * nothing. Safe next to an HPA, and needs only the recommender installed.
 *
 * @param target - A `targetRef`, or the workload resource itself.
 *
 * @example
 * ```typescript
 * const api = simple.Deployment({ name: 'api', image: 'nginx', id: 'api' });
 * vpaRecommendOnly(api, { id: 'apiVpa' });
 * ```
 */
export function vpaRecommendOnly(
  target: VpaTargetRef | VpaTargetResource,
  options: VpaRecommendOnlyOptions = {}
): Enhanced<VerticalPodAutoscalerSpec, VerticalPodAutoscalerStatus> {
  const targetRef: VpaTargetRef = isTargetResource(target)
    ? {
        apiVersion: target.apiVersion,
        kind: target.kind,
        name: target.metadata.name as string,
      }
    : target;
  return verticalPodAutoscaler({
    name: options.name ?? targetRef.name,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    spec: {
      targetRef,
      updatePolicy: { updateMode: 'Off' },
      ...(options.containerPolicies
        ? { resourcePolicy: { containerPolicies: options.containerPolicies } }
        : {}),
    },
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.id ? { id: options.id } : {}),
  });
}
