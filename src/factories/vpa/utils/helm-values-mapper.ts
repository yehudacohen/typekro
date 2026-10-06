// Vertical Pod Autoscaler Helm values mapping for the Fairwinds `vpa` chart 5.1.0.
//
// Every spec field may be a schema reference in KRO mode, so the mapper only
// places values into the tree and never branches on them. Defaults go through
// `Cel.default`, never `??`: a schema proxy is a truthy object.
//
// The chart renders each component's `extraArgs` map as `--key=value`, and
// Helm merges that map with the chart's own (`v`, the two minimum-recommendation
// flags), so the typed flags below land there key by key.

import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  VPA_DEFAULT_RECOMMENDER_FLAGS,
  VPA_DEFAULT_RESOURCES,
  VPA_DEFAULT_UPDATER_FLAGS,
} from '../constants.js';
import type { VpaBootstrapConfig, VpaComponentConfig, VpaResourceRequirements } from '../types.js';

const VPA_DEFAULT_TLS_SECRET_NAME = '{{ include "vpa.fullname" . }}-tls-secret';

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

function component(
  config: VpaComponentConfig | undefined,
  defaultResources: VpaResourceRequirements
): Record<string, unknown> {
  return {
    enabled: Cel.default(config?.enabled, true),
    replicaCount: Cel.default(config?.replicas, 1),
    resources: Cel.default(config?.resources, {
      requests: { ...defaultResources.requests },
    }),
    podDisruptionBudget: Cel.default(config?.podDisruptionBudget, { maxUnavailable: 1 }),
    nodeSelector: Cel.default(config?.nodeSelector, {}),
    tolerations: Cel.default(config?.tolerations, []),
    affinity: Cel.default(config?.affinity, {}),
  };
}

/**
 * Map the bootstrap spec onto Fairwinds `vpa` chart values.
 *
 * @param config - The bootstrap spec. Any field may be a schema reference.
 * @param rawValues - Concrete chart values deep-merged over the result.
 *
 * @example
 * ```typescript
 * mapVpaConfigToHelmValues({
 *   name: 'vpa',
 *   updater: { enabled: false },
 *   admissionController: { enabled: false },
 * });
 * ```
 */
export function mapVpaConfigToHelmValues(
  config: VpaBootstrapConfig,
  rawValues: Record<string, unknown> = {}
): Record<string, unknown> {
  const recommender = config.recommender;
  const updater = config.updater;
  const admission = config.admissionController;
  const flags = VPA_DEFAULT_RECOMMENDER_FLAGS;

  const mapped: Record<string, unknown> = {
    // Fixes every object name to `<name>-<component>`, independent of the chart name.
    fullnameOverride: config.name,
    priorityClassName: Cel.default(config.priorityClassName, ''),
    serviceAccount: {
      create: true,
      annotations: Cel.default(config.serviceAccountAnnotations, {}),
    },
    recommender: {
      ...component(recommender, VPA_DEFAULT_RESOURCES.recommender),
      extraArgs: {
        v: Cel.default(recommender?.logLevel, 4),
        'pod-recommendation-min-cpu-millicores': Cel.default(
          recommender?.podRecommendationMinCpuMillicores,
          flags.podRecommendationMinCpuMillicores
        ),
        'pod-recommendation-min-memory-mb': Cel.default(
          recommender?.podRecommendationMinMemoryMb,
          flags.podRecommendationMinMemoryMb
        ),
        'target-cpu-percentile': Cel.default(
          recommender?.targetCpuPercentile,
          flags.targetCpuPercentile
        ),
        'target-memory-percentile': Cel.default(
          recommender?.targetMemoryPercentile,
          flags.targetMemoryPercentile
        ),
        'recommendation-margin-fraction': Cel.default(
          recommender?.recommendationMarginFraction,
          flags.recommendationMarginFraction
        ),
        'cpu-histogram-decay-half-life': Cel.default(
          recommender?.cpuHistogramDecayHalfLife,
          flags.cpuHistogramDecayHalfLife
        ),
        'memory-histogram-decay-half-life': Cel.default(
          recommender?.memoryHistogramDecayHalfLife,
          flags.memoryHistogramDecayHalfLife
        ),
        'memory-aggregation-interval': Cel.default(
          recommender?.memoryAggregationInterval,
          flags.memoryAggregationInterval
        ),
        'memory-aggregation-interval-count': Cel.default(
          recommender?.memoryAggregationIntervalCount,
          flags.memoryAggregationIntervalCount
        ),
        storage: Cel.default(recommender?.storage, flags.storage),
        'history-length': Cel.default(recommender?.historyLength, flags.historyLength),
        'prometheus-address': Cel.default(recommender?.prometheusAddress, flags.prometheusAddress),
        'recommender-name': Cel.default(recommender?.recommenderName, flags.recommenderName),
      },
    },
    updater: {
      ...component(updater, VPA_DEFAULT_RESOURCES.updater),
      extraArgs: {
        'min-replicas': Cel.default(updater?.minReplicas, VPA_DEFAULT_UPDATER_FLAGS.minReplicas),
        'eviction-tolerance': Cel.default(
          updater?.evictionTolerance,
          VPA_DEFAULT_UPDATER_FLAGS.evictionTolerance
        ),
      },
    },
    admissionController: {
      ...component(admission, VPA_DEFAULT_RESOURCES.admissionController),
      registerWebhook: false,
      generateCertificate: Cel.default(admission?.certificate?.generate, true),
      // The chart's own default, which it renders through `tpl`: `<name>-tls-secret`.
      secretName: Cel.default(admission?.certificate?.secretName, VPA_DEFAULT_TLS_SECRET_NAME),
      tlsSecretKeys: Cel.default(admission?.certificate?.secretKeys, []),
      mutatingWebhookConfiguration: {
        failurePolicy: Cel.default(admission?.webhook?.failurePolicy, 'Ignore'),
        timeoutSeconds: Cel.default(admission?.webhook?.timeoutSeconds, 5),
        namespaceSelector: Cel.default(admission?.webhook?.namespaceSelector, {}),
        objectSelector: Cel.default(admission?.webhook?.objectSelector, {}),
        annotations: Cel.default(admission?.webhook?.annotations, {}),
      },
    },
    'metrics-server': { enabled: Cel.default(config.metricsServer?.enabled, false) },
  };
  return deepMerge(mapped, rawValues);
}
