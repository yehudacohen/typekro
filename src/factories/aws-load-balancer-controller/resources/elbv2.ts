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

/** The VPC ID format the controller's webhook accepts (v3.5.0). */
const VPC_ID_PATTERN = /^(?:vpc-[0-9a-f]{8}|vpc-[0-9a-f]{17}|vpc-[0-9a-f]{32})$/;

/** A concrete, non-empty string; `undefined` for a graph value or anything else. */
function concreteString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reject at build time the TargetGroupBindings the controller's validating
 * webhook (v3.5.0) would reject on static grounds alone, so the mistake shows
 * up in the composition rather than as a failed apply. Checks that need the
 * AWS target group (protocol, IP address type and VPC matching it) stay with
 * the webhook. A reference or CEL value is only known per instance, so a check
 * that involves one is skipped; the webhook still checks the resolved value.
 */
function validateTargetGroupBinding(config: Composable<TargetGroupBindingConfig>): void {
  const spec: unknown = config.spec;
  // A whole spec given as a graph value: nothing is known until an instance.
  if (isGraphValue(spec)) return;
  const fields = (spec ?? {}) as Record<string, unknown>;
  const name = typeof config.name === 'string' ? config.name : '<reference>';
  const fail = (message: string, field: string, suggestions: string[]): never => {
    throw new ValidationError(
      `TargetGroupBinding '${name}': ${message}`,
      'TargetGroupBinding',
      name,
      field,
      suggestions
    );
  };

  // The CRD accepts a binding with neither, but the webhook refuses it, and
  // it treats an empty string as unset.
  const isSet = (value: unknown) => isGraphValue(value) || concreteString(value) !== undefined;
  if (!isSet(fields.targetGroupARN) && !isSet(fields.targetGroupName)) {
    fail(
      'names no target group: set spec.targetGroupARN or spec.targetGroupName (a non-empty ' +
        'string). The AWS Load Balancer Controller rejects a binding without one.',
      'spec.targetGroupARN',
      [
        'Set spec.targetGroupARN to the ARN of an existing target group.',
        'Or set spec.targetGroupName; the controller looks the ARN up by name.',
      ]
    );
  }

  const targetType = concreteString(fields.targetType);
  if (
    targetType === 'ip' &&
    fields.nodeSelector !== undefined &&
    !isGraphValue(fields.nodeSelector)
  ) {
    fail(
      'spec.nodeSelector only applies to instance targets, and targetType is ip.',
      'spec.nodeSelector',
      ["Remove spec.nodeSelector, or use targetType 'instance'."]
    );
  }
  if (targetType === 'instance' && concreteString(fields.iamRoleArnToAssume) !== undefined) {
    fail(
      'a cross-account binding (spec.iamRoleArnToAssume) needs ip targets, and targetType is instance.',
      'spec.targetType',
      ["Use targetType 'ip' with spec.iamRoleArnToAssume."]
    );
  }
  const protocol = concreteString(fields.targetGroupProtocol);
  if (targetType === 'instance' && (protocol === 'QUIC' || protocol === 'TCP_QUIC')) {
    fail(`${protocol} target groups do not support instance targets.`, 'spec.targetType', [
      "Use targetType 'ip' for a QUIC or TCP_QUIC target group.",
    ]);
  }
  const vpcID = concreteString(fields.vpcID);
  if (vpcID !== undefined && !VPC_ID_PATTERN.test(vpcID)) {
    fail(
      `spec.vpcID '${vpcID}' is not a VPC ID: it must be 'vpc-' followed by 8, 17 or 32 ` +
        'lowercase hex characters.',
      'spec.vpcID',
      ['Leave spec.vpcID unset to let the controller read it from the target group.']
    );
  }
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
 * is set (or both are empty strings), or when concrete values break a static
 * rule of the controller's webhook: `nodeSelector` with `ip` targets,
 * `iamRoleArnToAssume` or a QUIC / TCP_QUIC protocol with `instance` targets, or
 * a malformed `vpcID`.
 */
export function targetGroupBinding(
  config: Composable<TargetGroupBindingConfig>
): Enhanced<TargetGroupBindingSpec, TargetGroupBindingStatus> {
  validateTargetGroupBinding(config);
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
