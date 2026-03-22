/**
 * Helm Values Mapper for Hyperspike Valkey Operator
 *
 * Maps ValkeyBootstrapConfig to Helm chart values for the valkey-operator chart.
 * The operator chart is simple — it deploys the controller only.
 *
 * @see https://github.com/hyperspike/valkey-operator
 */

import type { ValkeyBootstrapConfig } from '../types.js';

/** Helm values structure for the valkey-operator chart. */
export interface ValkeyHelmValues {
  [key: string]: unknown;
}

/**
 * Map ValkeyBootstrapConfig to Helm chart values.
 *
 * The Hyperspike operator chart has minimal configuration — most settings
 * are on the Valkey CRD itself, not the operator. Custom values are passed
 * through directly for any operator-level overrides.
 *
 * @param config - Resolved Valkey bootstrap configuration
 * @returns Helm values object compatible with the valkey-operator chart
 */
export function mapValkeyConfigToHelmValues(config: ValkeyBootstrapConfig): ValkeyHelmValues {
  const values: ValkeyHelmValues = {};

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
 * Get advisory warnings for Valkey operator Helm values configuration.
 *
 * @param _config - Bootstrap configuration to check
 * @returns Array of warning messages (empty if configuration looks good)
 */
export function getValkeyHelmValueWarnings(_config: ValkeyBootstrapConfig): string[] {
  // The Hyperspike operator chart has minimal configuration.
  // Most settings are on the Valkey CRD, not the operator.
  return [];
}
