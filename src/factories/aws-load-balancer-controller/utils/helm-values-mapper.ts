import { isMergeableValuesObject } from '../../../core/aspects/values-merge.js';
import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { DEFAULT_AWS_LBC_NAME } from '../constants.js';
import type { AwsLoadBalancerControllerBootstrapConfig } from '../types.js';

// In KRO mode every optional spec field is a schema proxy, and a proxy is
// truthy, never `undefined`. So the mapper never branches on a spec value and
// never spreads one. It places each field into the values tree as-is: the
// serializer renders an unset optional field as `omit()`, which leaves the
// chart's own default in place. Where TypeKro's default differs from the
// chart's, `Cel.default` applies it (plain `??` for concrete direct values).

// Drop `undefined` leaves and empty objects from a concrete tree. Graph values
// (schema references and CEL expressions) are kept whole.
function prune(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    isKubernetesRef(value) ||
    isCelExpression(value)
  ) {
    return value;
  }
  const pruned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = prune(child);
    if (next !== undefined) pruned[key] = next;
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

// Plain objects merge key by key; arrays, primitives and graph values replace.
function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = merged[key];
    merged[key] =
      isMergeableValuesObject(current) && isMergeableValuesObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return merged;
}

/**
 * Map the bootstrap spec to `aws-load-balancer-controller` chart values.
 *
 * Works on a concrete spec (direct mode) and on the schema proxy (KRO mode).
 * `values` is a concrete, build-time overlay, deep-merged last.
 *
 * @example
 * ```typescript
 * mapAwsLoadBalancerControllerConfigToHelmValues({ name: 'lbc', clusterName: 'prod' });
 * // { clusterName: 'prod', defaultTargetType: 'ip', keepTLSSecret: true, ... }
 * ```
 */
export function mapAwsLoadBalancerControllerConfigToHelmValues(
  config: AwsLoadBalancerControllerBootstrapConfig,
  values?: Record<string, unknown>
): Record<string, unknown> {
  const mapped = {
    clusterName: config.clusterName,
    region: config.region,
    vpcId: config.vpcId,
    replicaCount: config.replicaCount,
    image: config.image,
    serviceAccount: {
      create: Cel.default(config.serviceAccount?.create, true),
      // Pinned rather than derived from the release name, so the IRSA trust
      // policy or Pod Identity association has a name that cannot drift.
      name: Cel.default(config.serviceAccount?.name, DEFAULT_AWS_LBC_NAME),
      annotations: config.serviceAccount?.annotations,
    },
    // The chart renders a PDB only above one replica, and its default is none.
    podDisruptionBudget: Cel.default(config.podDisruptionBudget, { maxUnavailable: 1 }),
    topologySpreadConstraints: config.topologySpreadConstraints,
    // Off by default: the webhook makes this controller claim every new
    // `type: LoadBalancer` Service, including ones another controller owns.
    enableServiceMutatorWebhook: Cel.default(config.enableServiceMutatorWebhook, false),
    createIngressClassResource: config.createIngressClassResource,
    ingressClass: config.ingressClass,
    // `ip` targets pods directly (VPC CNI); the chart's `instance` default
    // routes through NodePorts.
    defaultTargetType: Cel.default(config.defaultTargetType, 'ip'),
    resources: config.resources,
    nodeSelector: config.nodeSelector,
    tolerations: config.tolerations,
    logLevel: config.logLevel,
    // The chart regenerates the self-signed webhook certificate on every
    // upgrade unless told to keep it, which briefly breaks the webhooks while
    // the new CA bundle propagates.
    keepTLSSecret: true,
  };
  const pruned = (prune(mapped) ?? {}) as Record<string, unknown>;
  return values ? deepMerge(pruned, values) : pruned;
}
