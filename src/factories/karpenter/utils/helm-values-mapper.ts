// Karpenter Helm values mapping for the `karpenter` chart 1.14.1.
//
// Every spec field may be a schema reference in KRO mode, so the mapper only
// places values into the tree and never branches on them. Defaults go through
// `Cel.default`, never `??`: a schema proxy is a truthy object.

import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  KARPENTER_DEFAULT_RESOURCES,
  KARPENTER_DEFAULT_TOLERATIONS,
  KARPENTER_DEFAULT_TOPOLOGY_SPREAD_CONSTRAINTS,
} from '../constants.js';
import type { KarpenterBootstrapConfig } from '../types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value)
  );
}

// Plain objects merge key by key; lists, primitives and graph values replace.
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === undefined) continue;
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}

/**
 * Map the bootstrap spec onto `karpenter` chart values.
 *
 * Map values (`nodeSelector`, `affinity`, service account annotations) are
 * merged by Helm with the chart defaults; lists (`tolerations`,
 * `topologySpreadConstraints`) replace them, so their fallbacks restate the
 * chart defaults.
 *
 * @param config - The bootstrap spec. Any field may be a schema reference.
 * @param rawValues - Concrete chart values deep-merged over the result.
 *
 * @example
 * ```typescript
 * mapKarpenterConfigToHelmValues({
 *   name: 'karpenter',
 *   clusterName: 'my-cluster',
 *   interruptionQueue: 'my-cluster',
 *   serviceAccount: { annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::111122223333:role/KarpenterController' } },
 * });
 * ```
 */
export function mapKarpenterConfigToHelmValues(
  config: KarpenterBootstrapConfig,
  rawValues: Record<string, unknown> = {}
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    // Fixes the Deployment, ServiceAccount and RBAC names to the release name,
    // so an EKS Pod Identity association can name the ServiceAccount.
    fullnameOverride: config.name,
    replicas: Cel.default(config.replicas, 2),
    logLevel: Cel.default(config.logLevel, 'info'),
    dnsPolicy: Cel.default(config.dnsPolicy, 'ClusterFirst'),
    serviceAccount: {
      create: true,
      name: Cel.default(config.serviceAccount?.name, config.name),
      annotations: Cel.default(config.serviceAccount?.annotations, {}),
    },
    podDisruptionBudget: {
      maxUnavailable: Cel.default(config.podDisruptionBudget?.maxUnavailable, 1),
    },
    nodeSelector: Cel.default(config.nodeSelector, {}),
    affinity: Cel.default(config.affinity, {}),
    topologySpreadConstraints: Cel.default(config.topologySpreadConstraints, [
      ...KARPENTER_DEFAULT_TOPOLOGY_SPREAD_CONSTRAINTS.map((constraint) => ({ ...constraint })),
    ]),
    tolerations: Cel.default(config.tolerations, [
      ...KARPENTER_DEFAULT_TOLERATIONS.map((toleration) => ({ ...toleration })),
    ]),
    controller: {
      resources: Cel.default(config.resources, {
        requests: { ...KARPENTER_DEFAULT_RESOURCES.requests },
        limits: { ...KARPENTER_DEFAULT_RESOURCES.limits },
      }),
    },
    settings: {
      clusterName: config.clusterName,
      clusterEndpoint: Cel.default(config.clusterEndpoint, ''),
      interruptionQueue: Cel.default(config.interruptionQueue, ''),
    },
  };
  return deepMerge(mapped, rawValues);
}
