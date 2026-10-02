// Readiness for `VerticalPodAutoscaler`s. The recommender reports progress
// through conditions: `RecommendationProvided` once it has a recommendation,
// `NoPodsMatched` while the target has no pods, `ConfigUnsupported` when the
// spec is unusable. The conditions carry no observedGeneration.

import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import { Cel } from '../../../core/references/cel.js';
import type {
  Enhanced,
  ReadinessEvaluator,
  RefOrValue,
  ResourceStatus,
} from '../../../core/types/index.js';
import type { VpaCondition } from '../types.js';

interface VpaLiveResource {
  metadata?: { resourceVersion?: string };
  status?: { conditions?: VpaCondition[] };
}

function isTrue(conditions: VpaCondition[], type: string): VpaCondition | undefined {
  return conditions.find((condition) => condition.type === type && condition.status === 'True');
}

/** Evaluate a VPA's `RecommendationProvided` condition. */
export function evaluateVpaRecommendation(liveResource: unknown): ResourceStatus {
  const conditions = (liveResource as VpaLiveResource | null | undefined)?.status?.conditions;
  if (!conditions || conditions.length === 0) {
    return {
      ready: false,
      reason: 'StatusMissing',
      message: 'VerticalPodAutoscaler has no conditions yet; is the recommender running?',
    };
  }
  const unsupported = isTrue(conditions, 'ConfigUnsupported');
  if (unsupported) {
    return {
      ready: false,
      reason: 'ConfigUnsupported',
      message: unsupported.message || 'VerticalPodAutoscaler configuration is unsupported',
    };
  }
  if (isTrue(conditions, 'RecommendationProvided')) {
    return { ready: true, reason: 'RecommendationProvided', message: 'Recommendation provided' };
  }
  const noPods = isTrue(conditions, 'NoPodsMatched');
  return {
    ready: false,
    reason: noPods ? 'NoPodsMatched' : 'RecommendationPending',
    message: noPods?.message || 'Waiting for the recommender to provide a recommendation',
  };
}

/** `VerticalPodAutoscaler` readiness: `RecommendationProvided=True`. */
export const vpaRecommendationReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator('typekro.readiness.vpa.recommendation', '1', (resource) =>
    evaluateVpaRecommendation(resource)
  );

/** `VerticalPodAutoscaler` readiness when nothing waits for a recommendation. */
export const vpaAcceptedReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator('typekro.readiness.vpa.accepted', '1', (resource) => {
    const accepted = Boolean((resource as VpaLiveResource | null)?.metadata?.resourceVersion);
    return accepted
      ? { ready: true, reason: 'Accepted', message: 'VerticalPodAutoscaler stored' }
      : { ready: false, reason: 'Pending', message: 'VerticalPodAutoscaler not stored yet' };
  });

type VpaResource = Enhanced<object, { conditions?: VpaCondition[] }>;

/**
 * A status expression that is `true` once every given VPA has
 * `RecommendationProvided=True`. Pass several resources rather than joining
 * calls with `&&`, which JavaScript evaluates before TypeKro sees it.
 *
 * @example
 * ```typescript
 * return { recommended: vpaRecommendationProvided(webVpa, workerVpa) };
 * ```
 */
export function vpaRecommendationProvided(...resources: [VpaResource, ...VpaResource[]]): boolean {
  const parts: RefOrValue<unknown>[] = [];
  resources.forEach((resource, index) => {
    if (index > 0) parts.push(' && ');
    parts.push(
      '(has(',
      resource.status.conditions,
      ') && ',
      resource.status.conditions,
      '.exists(c, c.type == "RecommendationProvided" && c.status == "True"))'
    );
  });
  return Cel.expr<boolean>(...parts);
}
