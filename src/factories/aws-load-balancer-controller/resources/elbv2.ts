// Typed `elbv2.k8s.aws/v1beta1` resources served by the controller.

import { ValidationError } from '../../../core/errors.js';
import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type {
  Composable,
  Enhanced,
  ReadinessEvaluator,
  ResourceStatus,
} from '../../../core/types/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { createResource } from '../../shared.js';
import { AWS_LBC_ELBV2_API_VERSION } from '../constants.js';
import type {
  IngressClassParamsConfig,
  IngressClassParamsSpec,
  TargetGroupBindingConfig,
  TargetGroupBindingSpec,
  TargetGroupBindingStatus,
} from '../types.js';

/**
 * A `TargetGroupBinding` is ready once the controller has reconciled its
 * current generation and reports no failing condition.
 */
export const targetGroupBindingReadinessEvaluator: ReadinessEvaluator<unknown> = (
  live: unknown
): ResourceStatus => {
  const resource = live as {
    metadata?: { generation?: number };
    status?: TargetGroupBindingStatus;
  } | null;
  const observed = resource?.status?.observedGeneration;
  const generation = resource?.metadata?.generation ?? 1;
  if (observed === undefined || observed < generation) {
    return {
      ready: false,
      reason: 'NotReconciled',
      message: 'TargetGroupBinding not yet reconciled by the AWS Load Balancer Controller',
    };
  }
  const failing = resource?.status?.conditions?.find((c) => c.status === 'False');
  if (failing) {
    return {
      ready: false,
      reason: failing.reason ?? failing.type,
      message: failing.message ?? `TargetGroupBinding condition ${failing.type} is False`,
    };
  }
  return { ready: true, message: 'TargetGroupBinding reconciled' };
};

/** A value only known per instance: a schema or resource reference, or CEL. */
function isGraphValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

/**
 * Reject a binding that names no target group. The CRD accepts one, but the
 * controller's webhook refuses it ("either TargetGroupARN or TargetGroupName"
 * is required, and an empty string counts as unset), so it would never
 * reconcile. A reference or CEL value is only known per instance, so it counts
 * as set here; the webhook still checks the resolved value.
 */
function assertTargetGroup(config: Composable<TargetGroupBindingConfig>): void {
  const spec: unknown = config.spec;
  if (isGraphValue(spec)) return;
  const { targetGroupARN, targetGroupName } = (spec ?? {}) as {
    targetGroupARN?: unknown;
    targetGroupName?: unknown;
  };
  const isSet = (value: unknown) =>
    isGraphValue(value) || (typeof value === 'string' && value.length > 0);
  if (isSet(targetGroupARN) || isSet(targetGroupName)) return;
  const name = typeof config.name === 'string' ? config.name : '<reference>';
  throw new ValidationError(
    `TargetGroupBinding '${name}' names no target group: set spec.targetGroupARN or ` +
      'spec.targetGroupName (a non-empty string). The AWS Load Balancer Controller rejects a ' +
      'binding without one.',
    'TargetGroupBinding',
    name,
    'spec.targetGroupARN',
    [
      'Set spec.targetGroupARN to the ARN of an existing target group.',
      'Or set spec.targetGroupName; the controller looks the ARN up by name.',
    ]
  );
}

/**
 * Register a Service's endpoints with an existing ELBv2 target group.
 *
 * @example
 * ```typescript
 * targetGroupBinding({
 *   name: 'web',
 *   namespace: 'apps',
 *   spec: {
 *     serviceRef: { name: 'web', port: 80 },
 *     targetGroupARN: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/web/0123456789abcdef',
 *     targetType: 'ip',
 *   },
 *   id: 'webTargets',
 * });
 * ```
 *
 * @throws {ValidationError} when neither `targetGroupARN` nor `targetGroupName`
 * is set (or both are empty strings).
 */
export function targetGroupBinding(
  config: Composable<TargetGroupBindingConfig>
): Enhanced<TargetGroupBindingSpec, TargetGroupBindingStatus> {
  assertTargetGroup(config);
  return createResource<TargetGroupBindingSpec, TargetGroupBindingStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: AWS_LBC_ELBV2_API_VERSION,
    kind: 'TargetGroupBinding',
    metadata: {
      name: config.name,
      ...(config.namespace ? { namespace: config.namespace } : {}),
    },
    spec: config.spec as TargetGroupBindingSpec,
  }).withReadinessEvaluator(targetGroupBindingReadinessEvaluator);
}

/**
 * Create a cluster-scoped `IngressClassParams`, the settings an `IngressClass`
 * applies to every Ingress that uses it.
 *
 * @example
 * ```typescript
 * ingressClassParams({
 *   name: 'internal',
 *   spec: { scheme: 'internal', group: { name: 'internal' }, targetType: 'ip' },
 * });
 * ```
 */
export function ingressClassParams(
  config: Composable<IngressClassParamsConfig>
): Enhanced<IngressClassParamsSpec, object> {
  return createResource<IngressClassParamsSpec, object>(
    {
      ...(config.id ? { id: config.id } : {}),
      apiVersion: AWS_LBC_ELBV2_API_VERSION,
      kind: 'IngressClassParams',
      metadata: { name: config.name },
      spec: (config.spec ?? {}) as IngressClassParamsSpec,
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator('IngressClassParams'));
}
