/**
 * Shared Gateway API readiness evaluators.
 *
 * Every Gateway API controller publishes the same condition vocabulary
 * (`Accepted`, `Programmed`, `ResolvedRefs`) with `observedGeneration`, so the
 * freshness logic belongs in one place rather than once per implementation.
 *
 * Extracted from `src/factories/envoy-ai-gateway/resources/gateway.ts` (#176).
 * The envoy-ai-gateway evaluators now delegate here and keep their original
 * portable-strategy identifiers so existing plans stay resolvable.
 */

import {
  identifyPortableReadinessEvaluator,
  registerPortableReadinessEvaluator,
  registerPortableReadinessStrategy,
} from '../../core/readiness/index.js';
import {
  readinessConfiguration,
  readinessLiteral,
  requiredReadinessString,
} from '../../core/readiness/strategy-configuration.js';
import type { ReadinessEvaluator, ResourceStatus } from '../../core/types/index.js';
import {
  GATEWAY_API_ACCEPTED_CONDITION,
  GATEWAY_API_PROGRAMMED_CONDITION,
  GATEWAY_API_RESOLVED_REFS_CONDITION,
} from './constants.js';
import type {
  AcceptedResourceStatus,
  GatewayObservedStatus,
  GatewayPolicyObservedStatus,
  KubernetesCondition,
  RouteObservedStatus,
} from './types.js';

const READINESS_REVISION = '1';
const ACCEPTED_STRATEGY = 'typekro.readiness.gateway-api.accepted';
const GATEWAY_CLASS_STRATEGY = 'typekro.readiness.gateway-api.gateway-class';
const GATEWAY_STRATEGY = 'typekro.readiness.gateway-api.gateway';
const ROUTE_STRATEGY = 'typekro.readiness.gateway-api.route';
const POLICY_STRATEGY = 'typekro.readiness.gateway-api.policy';

/**
 * Whether a condition describes the resource's current generation.
 *
 * Some controllers (notably Envoy AI Gateway v0.6 on its v1beta1 resources)
 * emit Condition-shaped entries without `observedGeneration`. Preserve strict
 * freshness whenever the controller supplies it, while accepting the
 * controller's documented sparse condition shape when it cannot.
 */
export function gatewayApiConditionIsCurrent(
  condition: KubernetesCondition | undefined,
  generation: number | undefined
): boolean {
  if (generation === undefined) return true;
  return condition?.observedGeneration === undefined || condition.observedGeneration === generation;
}

/**
 * Generic condition readiness for Gateway API resources.
 *
 * @param liveResource - The observed cluster resource.
 * @param acceptedType - Condition type that must be `True` for readiness.
 * @param rejectedTypes - Condition types whose `True` state is a hard rejection.
 */
export function gatewayApiConditionReadiness(
  liveResource: unknown,
  acceptedType: string,
  rejectedTypes: readonly string[]
): ResourceStatus {
  const resource = liveResource as
    | {
        readonly metadata?: { readonly generation?: number };
        readonly status?: AcceptedResourceStatus;
      }
    | undefined;
  const conditions = resource?.status?.conditions ?? [];
  const generation = resource?.metadata?.generation;
  const rejected = conditions.find(
    (condition) =>
      rejectedTypes.includes(condition.type) &&
      condition.status === 'True' &&
      gatewayApiConditionIsCurrent(condition, generation)
  );
  if (rejected) {
    return {
      ready: false,
      reason: rejected.reason ?? rejected.type,
      message: rejected.message ?? `${rejected.type} is True`,
    };
  }
  const accepted = conditions.find((condition) => condition.type === acceptedType);
  const current = gatewayApiConditionIsCurrent(accepted, generation);
  if (accepted?.status === 'True' && current) {
    return {
      ready: true,
      reason: accepted.reason ?? acceptedType,
      message: accepted.message ?? `${acceptedType} is True`,
    };
  }
  return {
    ready: false,
    reason: accepted?.reason ?? 'Reconciling',
    message:
      accepted?.message ??
      `${acceptedType} has not been observed for the current resource generation`,
  };
}

/**
 * Readiness for any Gateway API resource that publishes a top-level `Accepted`
 * condition and signals rejection with `NotAccepted`.
 */
export const gatewayApiAcceptedReadinessEvaluator = registerPortableReadinessEvaluator(
  ACCEPTED_STRATEGY,
  READINESS_REVISION,
  (liveResource: unknown): ResourceStatus =>
    gatewayApiConditionReadiness(liveResource, GATEWAY_API_ACCEPTED_CONDITION, ['NotAccepted'])
);

/**
 * Readiness for `GatewayClass`: the controller sets `Accepted=True` once it has
 * claimed the class. There is no negative condition type in the spec.
 */
export const gatewayApiGatewayClassReadinessEvaluator = registerPortableReadinessEvaluator(
  GATEWAY_CLASS_STRATEGY,
  READINESS_REVISION,
  (liveResource: unknown): ResourceStatus =>
    gatewayApiConditionReadiness(liveResource, GATEWAY_API_ACCEPTED_CONDITION, [])
);

/**
 * Readiness for `Gateway`: both `Accepted` (configuration is valid) and
 * `Programmed` (the data plane serves it) must be `True` for the current
 * generation. Either condition reported `False` is a not-ready answer with the
 * controller's own reason.
 */
export const gatewayApiGatewayReadinessEvaluator = registerPortableReadinessEvaluator(
  GATEWAY_STRATEGY,
  READINESS_REVISION,
  (liveResource: unknown): ResourceStatus => {
    const resource = liveResource as
      | {
          readonly metadata?: { readonly generation?: number };
          readonly status?: GatewayObservedStatus;
        }
      | undefined;
    const conditions = resource?.status?.conditions ?? [];
    const generation = resource?.metadata?.generation;
    const rejected = conditions.find(
      (condition) =>
        [GATEWAY_API_ACCEPTED_CONDITION, GATEWAY_API_PROGRAMMED_CONDITION].includes(
          condition.type
        ) &&
        condition.status === 'False' &&
        gatewayApiConditionIsCurrent(condition, generation)
    );
    if (rejected) {
      return {
        ready: false,
        reason: rejected.reason ?? `${rejected.type}False`,
        message: rejected.message ?? `${rejected.type} is False`,
      };
    }
    const accepted = conditions.find(
      (condition) => condition.type === GATEWAY_API_ACCEPTED_CONDITION
    );
    const programmed = conditions.find(
      (condition) => condition.type === GATEWAY_API_PROGRAMMED_CONDITION
    );
    const ready =
      accepted?.status === 'True' &&
      programmed?.status === 'True' &&
      gatewayApiConditionIsCurrent(accepted, generation) &&
      gatewayApiConditionIsCurrent(programmed, generation);
    return ready
      ? {
          ready: true,
          reason: 'GatewayProgrammed',
          message: programmed.message ?? 'Gateway is accepted and programmed',
        }
      : {
          ready: false,
          reason: programmed?.reason ?? accepted?.reason ?? 'GatewayProgressing',
          message:
            programmed?.message ??
            accepted?.message ??
            'Gateway is waiting to be accepted and programmed',
        };
  }
);

/**
 * Readiness for `HTTPRoute` / `GRPCRoute`: at least one claimed parent must
 * report `Accepted=True` and `ResolvedRefs` must not be `False`.
 *
 * A route with no `parents` entry has not been picked up by any controller yet,
 * which is not-ready rather than ready.
 */
export const gatewayApiRouteReadinessEvaluator = registerPortableReadinessEvaluator(
  ROUTE_STRATEGY,
  READINESS_REVISION,
  (liveResource: unknown): ResourceStatus => {
    const resource = liveResource as
      | {
          readonly metadata?: { readonly generation?: number };
          readonly status?: RouteObservedStatus;
        }
      | undefined;
    const generation = resource?.metadata?.generation;
    const parents = resource?.status?.parents ?? [];
    const conditions = parents.flatMap((parent) => parent.conditions ?? []);
    const rejected = conditions.find(
      (condition) =>
        (condition.type === GATEWAY_API_ACCEPTED_CONDITION ||
          condition.type === GATEWAY_API_RESOLVED_REFS_CONDITION) &&
        condition.status === 'False' &&
        gatewayApiConditionIsCurrent(condition, generation)
    );
    if (rejected) {
      return {
        ready: false,
        reason: rejected.reason ?? `${rejected.type}False`,
        message: rejected.message ?? `${rejected.type} is False`,
      };
    }
    const accepted = conditions.find(
      (condition) =>
        condition.type === GATEWAY_API_ACCEPTED_CONDITION &&
        condition.status === 'True' &&
        gatewayApiConditionIsCurrent(condition, generation)
    );
    return accepted
      ? {
          ready: true,
          reason: accepted.reason ?? GATEWAY_API_ACCEPTED_CONDITION,
          message: accepted.message ?? 'Route is accepted by its parent Gateway',
        }
      : {
          ready: false,
          reason: 'Reconciling',
          message: 'Route has not been accepted for the current resource generation',
        };
  }
);

function policyReadiness(liveResource: unknown, controllerName: string): ResourceStatus {
  const resource = liveResource as
    | {
        readonly metadata?: { readonly generation?: number };
        readonly status?: GatewayPolicyObservedStatus;
      }
    | undefined;
  const generation = resource?.metadata?.generation;
  const conditions = (resource?.status?.ancestors ?? [])
    .filter((ancestor) => ancestor.controllerName === controllerName)
    .flatMap((ancestor) => ancestor.conditions ?? []);
  const rejected = conditions.find(
    (condition) =>
      ((condition.type === GATEWAY_API_ACCEPTED_CONDITION && condition.status === 'False') ||
        (condition.type === GATEWAY_API_RESOLVED_REFS_CONDITION && condition.status === 'False')) &&
      gatewayApiConditionIsCurrent(condition, generation)
  );
  if (rejected) {
    return {
      ready: false,
      terminal: true,
      reason: rejected.reason ?? `${rejected.type}False`,
      message: rejected.message ?? `${rejected.type} is False`,
    };
  }
  const accepted = conditions.find(
    (condition) =>
      condition.type === GATEWAY_API_ACCEPTED_CONDITION &&
      condition.status === 'True' &&
      gatewayApiConditionIsCurrent(condition, generation)
  );
  return accepted
    ? {
        ready: true,
        reason: accepted.reason ?? GATEWAY_API_ACCEPTED_CONDITION,
        message: accepted.message ?? 'Policy is accepted',
      }
    : {
        ready: false,
        reason: 'Reconciling',
        message: 'Policy has not been accepted for the current resource generation',
      };
}

/**
 * Build a readiness evaluator for a Gateway API policy attachment.
 *
 * Policies report conditions per ancestor, and a cluster can run several
 * Gateway API controllers, so only the ancestors claimed by `controllerName`
 * are considered.
 *
 * @param controllerName - The `GatewayClass.spec.controllerName` whose
 *   ancestor conditions are authoritative for this policy.
 */
export function createGatewayApiPolicyReadinessEvaluator(
  controllerName: string
): ReadinessEvaluator<unknown> {
  const evaluator: ReadinessEvaluator<unknown> = (liveResource: unknown) =>
    policyReadiness(liveResource, controllerName);
  return identifyPortableReadinessEvaluator(evaluator, {
    kind: 'registered',
    id: POLICY_STRATEGY,
    revision: READINESS_REVISION,
    configuration: readinessConfiguration({
      controllerName: readinessLiteral(controllerName),
    }),
  });
}

registerPortableReadinessStrategy(POLICY_STRATEGY, READINESS_REVISION, (configuration) =>
  createGatewayApiPolicyReadinessEvaluator(requiredReadinessString(configuration, 'controllerName'))
);
