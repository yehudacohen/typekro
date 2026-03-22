/**
 * Helm Values Mapper for CloudNativePG Operator
 *
 * Maps CnpgBootstrapConfig to Helm chart values for the cloudnative-pg operator chart.
 * The operator chart is simpler than cert-manager — it deploys the controller only.
 *
 * @see https://cloudnative-pg.github.io/charts
 */

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
 * Map CnpgBootstrapConfig to Helm chart values.
 *
 * @param config - Resolved CNPG bootstrap configuration with defaults applied
 * @returns Helm values object compatible with the cloudnative-pg chart
 */
export function mapCnpgConfigToHelmValues(config: CnpgBootstrapConfig): CnpgHelmValues {
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

  // Spread custom values last for user overrides
  if (config.customValues) {
    Object.assign(values, config.customValues);
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
