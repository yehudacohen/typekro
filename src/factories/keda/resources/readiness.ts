// Readiness for `ScaledObject`s and `ScaledJob`s. KEDA publishes `Ready`
// (the scalers and the HPA are set up), `Active` (some trigger is above its
// activation threshold), `Fallback` and `Paused`. `Active=False` is the normal
// idle state of a workload scaled to zero, so readiness is `Ready=True` alone;
// the activity goes into the message.

import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import { Cel } from '../../../core/references/cel.js';
import type {
  Enhanced,
  ReadinessEvaluator,
  RefOrValue,
  ResourceStatus,
} from '../../../core/types/index.js';
import type { KedaCondition } from '../types.js';

interface KedaLiveResource {
  metadata?: { resourceVersion?: string };
  status?: { conditions?: KedaCondition[] };
}

/** Evaluate the `Ready` and `Active` conditions of a KEDA resource of the given kind. */
export function evaluateKedaReadiness(kind: string, liveResource: unknown): ResourceStatus {
  const conditions = (liveResource as KedaLiveResource | null | undefined)?.status?.conditions;
  const ready = conditions?.find((condition) => condition.type === 'Ready');
  if (!ready || ready.status === 'Unknown') {
    return {
      ready: false,
      reason: 'StatusMissing',
      message: `${kind} has no Ready condition yet; is the KEDA operator running?`,
    };
  }
  if (ready.status !== 'True') {
    return {
      ready: false,
      reason: ready.reason || 'NotReady',
      message: ready.message || `${kind} is not ready`,
    };
  }
  const is = (type: string) =>
    conditions?.some((condition) => condition.type === type && condition.status === 'True');
  const state = [
    is('Active') ? 'active' : 'idle',
    is('Fallback') && 'in fallback',
    is('Paused') && 'paused',
  ]
    .filter(Boolean)
    .join(', ');
  return { ready: true, reason: 'Ready', message: `${kind} is ready (${state})` };
}

/** `ScaledObject` readiness: `Ready=True`. */
export const scaledObjectReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator('typekro.readiness.keda.scaled-object', '1', (resource) =>
    evaluateKedaReadiness('ScaledObject', resource)
  );

/** `ScaledJob` readiness: `Ready=True`. */
export const scaledJobReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator('typekro.readiness.keda.scaled-job', '1', (resource) =>
    evaluateKedaReadiness('ScaledJob', resource)
  );

/** Trigger authentications have no conditions: ready once stored. */
export const triggerAuthenticationReadinessEvaluator: ReadinessEvaluator<unknown> =
  registerPortableReadinessEvaluator(
    'typekro.readiness.keda.trigger-authentication',
    '1',
    (resource) =>
      (resource as KedaLiveResource | null)?.metadata?.resourceVersion
        ? { ready: true, reason: 'Accepted', message: 'Trigger authentication stored' }
        : { ready: false, reason: 'Pending', message: 'Trigger authentication not stored yet' }
  );

type KedaResource = Enhanced<object, { conditions?: KedaCondition[] }>;

function conditionCheck(type: string, resources: readonly KedaResource[]): boolean {
  const parts: RefOrValue<unknown>[] = [];
  resources.forEach((resource, index) => {
    if (index > 0) parts.push(' && ');
    parts.push(
      '(has(',
      resource.status.conditions,
      ') && ',
      resource.status.conditions,
      `.exists(c, c.type == "${type}" && c.status == "True"))`
    );
  });
  return Cel.expr<boolean>(...parts);
}

/**
 * A status expression that is `true` once every given `ScaledObject` or
 * `ScaledJob` has `Ready=True`. Pass several resources rather than joining
 * calls with `&&`, which JavaScript evaluates before TypeKro sees it.
 *
 * @example
 * ```typescript
 * return { ready: kedaReady(apiScaler, workerScaler), active: kedaActive(apiScaler) };
 * ```
 */
export function kedaReady(...resources: [KedaResource, ...KedaResource[]]): boolean {
  return conditionCheck('Ready', resources);
}

/** A status expression that is `true` while every given resource has `Active=True`. */
export function kedaActive(...resources: [KedaResource, ...KedaResource[]]): boolean {
  return conditionCheck('Active', resources);
}
