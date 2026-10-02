// Typed `elbv2.k8s.aws/v1beta1` resources served by the controller.

import { createAlwaysReadyEvaluator } from '../../../core/readiness/index.js';
import type {
  Composable,
  Enhanced,
  ReadinessEvaluator,
  ResourceStatus,
} from '../../../core/types/index.js';
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
 */
export function targetGroupBinding(
  config: Composable<TargetGroupBindingConfig>
): Enhanced<TargetGroupBindingSpec, TargetGroupBindingStatus> {
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
