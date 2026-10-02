// KEDA Helm values mapping for the kedacore `keda` chart 2.21.0.
//
// Every spec field may be a schema reference in KRO mode, so the mapper only
// places values into the tree and never branches on them. Defaults go through
// `Cel.default`, never `??`: a schema proxy is a truthy object.
//
// The chart spreads each component's settings over several top-level maps
// (`resources.operator`, `podDisruptionBudget.metricServer`,
// `topologySpreadConstraints.webhooks`, `logging.*`), so the mapper gathers
// them back from the per-component spec.

import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { KEDA_DEFAULT_RESOURCES } from '../constants.js';
import type { KedaBootstrapConfig, KedaComponentConfig } from '../types.js';

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

function placement(config: KedaComponentConfig | undefined): Record<string, unknown> {
  return {
    replicaCount: Cel.default(config?.replicas, 1),
    nodeSelector: Cel.default(config?.nodeSelector, {}),
    tolerations: Cel.default(config?.tolerations, []),
    affinity: Cel.default(config?.affinity, {}),
  };
}

const resources = (config: KedaComponentConfig | undefined) =>
  Cel.default(config?.resources, {
    requests: { ...KEDA_DEFAULT_RESOURCES.requests },
    limits: { ...KEDA_DEFAULT_RESOURCES.limits },
  });

/**
 * Map the bootstrap spec onto kedacore `keda` chart values.
 *
 * @param config - The bootstrap spec. Any field may be a schema reference.
 * @param rawValues - Concrete chart values deep-merged over the result.
 * @param options - `keepCrds` (default true) annotates the CRDs with
 *   `helm.sh/resource-policy: keep`.
 *
 * @example
 * ```typescript
 * mapKedaConfigToHelmValues({
 *   name: 'keda',
 *   podIdentity: { awsIrsa: { enabled: true, roleArn: 'arn:aws:iam::111122223333:role/keda-operator' } },
 * });
 * ```
 */
export function mapKedaConfigToHelmValues(
  config: KedaBootstrapConfig,
  rawValues: Record<string, unknown> = {},
  options: { keepCrds?: boolean } = {}
): Record<string, unknown> {
  const { operator, metricsServer, webhooks } = config;
  const format = Cel.default(config.logFormat, 'console');
  const identity = config.podIdentity;

  const mapped: Record<string, unknown> = {
    // `keep` stops an uninstall from deleting the CRDs and, with them, every
    // ScaledObject and ScaledJob in the cluster.
    crds: {
      install: true,
      additionalAnnotations:
        options.keepCrds === false ? {} : { 'helm.sh/resource-policy': 'keep' },
    },
    watchNamespace: Cel.default(config.watchNamespace, ''),
    priorityClassName: Cel.default(config.priorityClassName, ''),
    operator: placement(operator),
    metricsServer: placement(metricsServer),
    webhooks: {
      ...placement(webhooks),
      enabled: Cel.default(webhooks?.enabled, true),
      failurePolicy: Cel.default(webhooks?.failurePolicy, 'Ignore'),
    },
    resources: {
      operator: resources(operator),
      metricServer: resources(metricsServer),
      webhooks: resources(webhooks),
    },
    podDisruptionBudget: {
      operator: Cel.default(operator?.podDisruptionBudget, {}),
      metricServer: Cel.default(metricsServer?.podDisruptionBudget, {}),
      webhooks: Cel.default(webhooks?.podDisruptionBudget, {}),
    },
    topologySpreadConstraints: {
      operator: Cel.default(operator?.topologySpreadConstraints, []),
      metricsServer: Cel.default(metricsServer?.topologySpreadConstraints, []),
      webhooks: Cel.default(webhooks?.topologySpreadConstraints, []),
    },
    logging: {
      operator: { level: Cel.default(operator?.logLevel, 'info'), format },
      metricServer: {
        zapLevel: Cel.default(metricsServer?.logLevel, 'info'),
        zapEncoder: format,
      },
      webhooks: { level: Cel.default(webhooks?.logLevel, 'info'), format },
    },
    serviceAccount: {
      operator: { annotations: Cel.default(operator?.serviceAccountAnnotations, {}) },
    },
    podIdentity: {
      aws: {
        irsa: {
          enabled: Cel.default(identity?.awsIrsa?.enabled, false),
          roleArn: Cel.default(identity?.awsIrsa?.roleArn, ''),
        },
      },
      azureWorkload: {
        enabled: Cel.default(identity?.azureWorkload?.enabled, false),
        clientId: Cel.default(identity?.azureWorkload?.clientId, ''),
        tenantId: Cel.default(identity?.azureWorkload?.tenantId, ''),
      },
      gcp: {
        enabled: Cel.default(identity?.gcp?.enabled, false),
        gcpIAMServiceAccount: Cel.default(identity?.gcp?.serviceAccount, ''),
      },
    },
    certificates: { certManager: { enabled: Cel.default(config.certManager, false) } },
  };
  return deepMerge(mapped, rawValues);
}
