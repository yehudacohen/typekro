/**
 * Helm Values Mapper for Hyperspike Valkey Operator
 *
 * Maps ValkeyBootstrapConfig to Helm chart values for the valkey-operator chart.
 * The operator chart is simple — it deploys the controller only.
 *
 * @see https://github.com/hyperspike/valkey-operator
 */

import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { ValkeyBootstrapConfig } from '../types.js';

/** Helm values structure for the valkey-operator chart. */
export interface ValkeyHelmValues {
  [key: string]: unknown;
}

/** Plain values or a KRO runtime merge preserving graph-aware passthrough maps. */
export type ValkeyMappedHelmValues = ValkeyHelmValues | ValuesMergeExpression;

/** Proxy-safe subset consumed by the Helm values mapper. */
export type ValkeyHelmValuesInput = Partial<ValkeyBootstrapConfig>;

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
export function mapValkeyConfigToHelmValues(
  config: ValkeyHelmValuesInput
): ValkeyMappedHelmValues {
  let mapped: ValkeyMappedHelmValues = {};

  // Preserve the legacy alias first, then let the standard `values` API win.
  mapped = mergeOverride(mapped, config.customValues);
  mapped = mergeOverride(mapped, config.values);

  return mapped;
}

function mergeOverride(
  base: ValkeyMappedHelmValues,
  override: unknown
): ValkeyMappedHelmValues {
  if (override === undefined) return base;

  if (
    isKubernetesRef(override) ||
    isCelExpression(override) ||
    isValuesMergeExpression(override)
  ) {
    return mergeValuesExpression(base, override);
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    deepMerge(base, override);
  }

  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value) &&
    !isValuesMergeExpression(value)
  );
}

/** Deep merge plain objects; arrays and primitives replace, and dangerous keys are ignored. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (sourceValue === undefined) continue;

    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
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
