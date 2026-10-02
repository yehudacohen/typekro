// Readiness for Karpenter CRs. NodePool and EC2NodeClass both publish a
// `Ready` condition with a per-condition `observedGeneration`; a `Ready=True`
// left over from an earlier generation must not count, so a spec update is
// only ready once Karpenter has evaluated the new generation.

import { Cel } from '../../../core/references/cel.js';
import type { Enhanced, RefOrValue, ResourceStatus } from '../../../core/types/index.js';
import type { KarpenterCondition } from '../types.js';

interface KarpenterLiveResource {
  metadata?: { generation?: number };
  status?: { conditions?: KarpenterCondition[] };
}

/** Evaluate the `Ready` condition of a Karpenter resource of the given kind. */
export function evaluateKarpenterReadiness(kind: string, liveResource: unknown): ResourceStatus {
  const resource = liveResource as KarpenterLiveResource | null | undefined;
  const conditions = resource?.status?.conditions;
  if (!conditions || conditions.length === 0) {
    return { ready: false, reason: 'StatusMissing', message: `${kind} has no conditions yet` };
  }
  const ready = conditions.find((condition) => condition.type === 'Ready');
  if (!ready) {
    return {
      ready: false,
      reason: 'ReadyConditionMissing',
      message: `${kind} has no Ready condition`,
    };
  }
  const generation = resource?.metadata?.generation;
  if (
    generation !== undefined &&
    ready.observedGeneration !== undefined &&
    ready.observedGeneration < generation
  ) {
    return {
      ready: false,
      reason: 'StaleCondition',
      message: `${kind} Ready condition is from generation ${ready.observedGeneration}, current is ${generation}`,
    };
  }
  if (ready.status === 'True') {
    return { ready: true, reason: 'Ready', message: ready.message || `${kind} is ready` };
  }
  return {
    ready: false,
    reason: ready.reason || 'NotReady',
    message: ready.message || `${kind} is not ready`,
  };
}

type KarpenterResource = Enhanced<object, { conditions?: KarpenterCondition[] }>;

/**
 * A status expression that is `true` once every given `NodePool` or
 * `EC2NodeClass` has `Ready=True` for its current generation. Pass several
 * resources rather than joining calls with `&&`, which JavaScript evaluates
 * before TypeKro sees it.
 *
 * @example
 * ```typescript
 * return { ready: karpenterReady(nodeClass, pool), nodes: pool.status.nodes };
 * ```
 */
export function karpenterReady(...resources: [KarpenterResource, ...KarpenterResource[]]): boolean {
  const parts: RefOrValue<unknown>[] = [];
  resources.forEach((resource, index) => {
    if (index > 0) parts.push(' && ');
    parts.push(
      '(has(',
      resource.status.conditions,
      ') && ',
      resource.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True" && (has(c.observedGeneration) ? c.observedGeneration >= ',
      resource.metadata.generation,
      ' : true)))'
    );
  });
  return Cel.expr<boolean>(...parts);
}
