/**
 * Helm Values Mapper for CloudNativePG Operator
 *
 * Maps CnpgBootstrapConfig to Helm chart values for the cloudnative-pg operator chart.
 * The operator chart is simpler than cert-manager — it deploys the controller only.
 *
 * @see https://cloudnative-pg.github.io/charts
 */

import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { CnpgBootstrapConfig } from '../types.js';

/** Helm values structure for the cloudnative-pg chart. */
export interface CnpgHelmValues {
  replicaCount?: number;
  image?: {
    repository?: string;
    tag?: string;
    pullPolicy?: string;
  };
  imagePullSecrets?: Array<{ name: string }>;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{
    key?: string;
    operator?: string;
    value?: string;
    effect?: string;
  }>;
  affinity?: Record<string, unknown>;
  monitoring?: {
    podMonitorEnabled?: boolean;
    grafanaDashboard?: { create?: boolean; namespace?: string };
  };
  serviceAccount?: {
    create?: boolean;
    name?: string;
    annotations?: Record<string, string>;
  };
  crds?: {
    create?: boolean;
  };
  [key: string]: unknown;
}

/**
 * Mapper result: plain values, or a graph-aware runtime merge when
 * `customValues` arrives as a schema reference / CEL expression (KRO then
 * merges the override map into the mapped values at reconcile time).
 */
export type CnpgMappedHelmValues = CnpgHelmValues | ValuesMergeExpression;

/**
 * Map CnpgBootstrapConfig to Helm chart values.
 *
 * `customValues` merges LAST so user overrides always win:
 * - concrete object → deep-merged at build time (works in both modes);
 * - schema reference / CEL expression → wrapped in the graph-aware runtime
 *   values merge, which the serializer compiles to a KRO runtime map-merge.
 *   Enumerating the reference here instead (`Object.assign(values, ref)`) asks
 *   the schema proxy for keys that only exist per instance, so the RGD carried
 *   one `__typekroSchemaKey` placeholder and the instance's real overrides were
 *   dropped (issue #190).
 *
 * @param config - Resolved CNPG bootstrap configuration with defaults applied
 * @returns Helm values compatible with the cloudnative-pg chart, or a runtime
 *   merge node when the overrides are only known per instance
 */
export function mapCnpgConfigToHelmValues(config: CnpgBootstrapConfig): CnpgMappedHelmValues {
  const values: CnpgHelmValues = {};

  if (config.replicaCount !== undefined) {
    values.replicaCount = config.replicaCount;
  }

  if (config.resources) {
    values.resources = config.resources;
  }

  if (config.monitoring?.enabled !== undefined) {
    values.monitoring = {
      podMonitorEnabled: config.monitoring.enabled,
    };
  }

  values.crds = {
    create: config.installCRDs !== false,
  };

  // Merge custom values last for user overrides.
  const customValues = config.customValues;
  if (
    isKubernetesRef(customValues) ||
    isCelExpression(customValues) ||
    isValuesMergeExpression(customValues)
  ) {
    return mergeValuesExpression(removeUndefinedValues(values), customValues);
  }
  if (customValues) {
    Object.assign(values, customValues);
  }

  return removeUndefinedValues(values);
}

/**
 * Recursively remove undefined values from an object.
 * Helm doesn't handle undefined well — only include explicitly set values.
 */
function removeUndefinedValues<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const cleaned = removeUndefinedValues(value as Record<string, unknown>);
      if (Object.keys(cleaned).length > 0) {
        result[key] = cleaned;
      }
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Get advisory warnings for CNPG Helm values configuration.
 *
 * @param config - Bootstrap configuration to check
 * @returns Array of warning messages (empty if configuration looks good)
 */
export function getCnpgHelmValueWarnings(config: CnpgBootstrapConfig): string[] {
  const warnings: string[] = [];

  if (config.installCRDs === false) {
    warnings.push(
      'installCRDs is false — CRDs must be installed manually before creating Cluster resources.'
    );
  }

  if (!config.resources?.requests) {
    warnings.push(
      'No resource requests specified for the CNPG operator. ' +
      'Consider setting requests for production deployments.'
    );
  }

  if ((config.replicaCount ?? 1) < 2) {
    warnings.push(
      'Operator replicaCount is less than 2. ' +
      'Consider running multiple replicas for high availability.'
    );
  }

  return warnings;
}
