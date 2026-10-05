import { isMergeableValuesObject } from '../../../core/aspects/values-merge.js';
import { ValidationError } from '../../../core/errors.js';
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

// Chart values the spec maps, named by their chart path, which is also the
// spec field that feeds them. Build-time `values` may not set these: a KRO
// instance's value is a schema reference the overlay could only replace, so
// an overlay would silently drop what the instance sets (an IRSA role
// annotation, a private image repository), in direct mode as well to keep the
// two modes alike. `podDisruptionBudget` is handled separately below.
const SPEC_MAPPED_VALUES: ReadonlySet<string> = new Set([
  'clusterName',
  'region',
  'vpcId',
  'replicaCount',
  'image',
  'serviceAccount.create',
  'serviceAccount.name',
  'serviceAccount.annotations',
  'topologySpreadConstraints',
  'enableServiceMutatorWebhook',
  'createIngressClassResource',
  'ingressClass',
  'defaultTargetType',
  'resources',
  'nodeSelector',
  'tolerations',
  'logLevel',
]);

// A section the mapper builds field by field. An overlay may add the fields
// the spec does not map (e.g. `serviceAccount.automountServiceAccountToken`).
const MAPPER_SECTION = 'serviceAccount';

function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * Reject build-time `values` that set a chart value the spec maps, at any
 * depth (`image.tag` falls under the spec's `image`).
 *
 * @throws {ValidationError} naming the spec field to use instead.
 */
export function assertAwsLoadBalancerControllerBuildTimeValues(
  values: Record<string, unknown> | undefined
): void {
  if (!values) return;
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (isUnsafeKey(key)) continue;
    if (key === MAPPER_SECTION) {
      if (!isMergeableValuesObject(value)) {
        conflicts.push(key);
        continue;
      }
      for (const field of Object.keys(value)) {
        if (SPEC_MAPPED_VALUES.has(`${key}.${field}`)) conflicts.push(`${key}.${field}`);
      }
    } else if (SPEC_MAPPED_VALUES.has(key)) {
      conflicts.push(key);
    }
  }
  if (conflicts.length === 0) return;
  const paths = conflicts.map((path) => `values.${path}`).join(', ');
  throw new ValidationError(
    `AWS Load Balancer Controller build-time ${paths} ${conflicts.length === 1 ? 'sets a chart value' : 'set chart values'} the spec maps. ` +
      'Set it through the spec instead (' +
      conflicts.map((path) => `spec.${path}`).join(', ') +
      "): build-time values cannot merge with an instance's spec, and replacing it would " +
      'drop what the instance sets, such as an IRSA role annotation or a private image repository.',
    'AwsLoadBalancerControllerBootstrap',
    'values',
    `values.${conflicts[0]}`,
    conflicts.map((path) => `Move values.${path} to spec.${path}.`)
  );
}

// Lay the checked overlay over the mapped values: new keys are added, and the
// service-account section takes the overlay's extra fields.
function applyOverlay(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isUnsafeKey(key)) continue;
    const current = merged[key];
    merged[key] =
      key === MAPPER_SECTION && isMergeableValuesObject(current) && isMergeableValuesObject(value)
        ? applyOverlay(current, value)
        : value;
  }
  return merged;
}

/**
 * Map the bootstrap spec to `aws-load-balancer-controller` chart values.
 *
 * Works on a concrete spec (direct mode) and on the schema proxy (KRO mode).
 * `values` is a concrete, build-time overlay for chart settings the spec does
 * not map; setting one the spec maps throws (see
 * {@link assertAwsLoadBalancerControllerBuildTimeValues}). Its
 * `podDisruptionBudget` replaces the TypeKro default PDB, and an instance's own
 * `spec.podDisruptionBudget` replaces either one whole, so its two exclusive
 * fields never combine. Both modes render the same result.
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
  assertAwsLoadBalancerControllerBuildTimeValues(values);
  const { podDisruptionBudget: overlayPdb, ...overlay } = values ?? {};
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
    // A build-time PDB (say a percentage, which the integer-only spec field
    // cannot express) replaces TypeKro's default; an instance's own PDB
    // replaces either one whole.
    podDisruptionBudget: Cel.default(
      config.podDisruptionBudget,
      (overlayPdb ?? { maxUnavailable: 1 }) as NonNullable<
        AwsLoadBalancerControllerBootstrapConfig['podDisruptionBudget']
      >
    ),
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
  return applyOverlay(pruned, overlay);
}
