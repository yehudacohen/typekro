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

// Sections the mapper builds itself, field by field and the same way in both
// modes. An overlay merges into these one field at a time.
const MAPPER_SECTIONS: ReadonlySet<string> = new Set(['serviceAccount']);

function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

// Lay the build-time overlay over the mapped values. Every other key the
// overlay sets replaces the mapped value as a whole. A spec-derived value is a
// schema reference in KRO mode, which the overlay can only replace, so direct
// mode does the same; merging there would also combine keys a chart object
// allows only one of, e.g. a spec `podDisruptionBudget.maxUnavailable` with an
// overlay `minAvailable`, which the PDB API rejects.
function applyOverlay(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  sections: ReadonlySet<string>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isUnsafeKey(key)) continue;
    const current = merged[key];
    merged[key] =
      sections.has(key) && isMergeableValuesObject(current) && isMergeableValuesObject(value)
        ? applyOverlay(current, value, new Set())
        : value;
  }
  return merged;
}

/**
 * Map the bootstrap spec to `aws-load-balancer-controller` chart values.
 *
 * Works on a concrete spec (direct mode) and on the schema proxy (KRO mode).
 * `values` is a concrete, build-time overlay applied last. A key it sets
 * replaces the mapped value as a whole, except `serviceAccount`, which merges
 * field by field; both modes render the same result.
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
  return values ? applyOverlay(pruned, values, MAPPER_SECTIONS) : pruned;
}
