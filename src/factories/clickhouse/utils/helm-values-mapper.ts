/**
 * Maps ClickHouseOperatorBootstrapConfig to altinity-clickhouse-operator
 * Helm chart values.
 *
 * Chart: `altinity-clickhouse-operator` 0.27.x from https://helm.altinity.com
 * (Apache-2.0). Values of note:
 * - `metrics.enabled` — metrics exporter sidecar (chart default: true)
 * - `crdHook.enabled` — CRDs installed via a Helm hook. CAVEAT: under Flux,
 *   helm-controller applies its own CRD policy (`install.crds`/`upgrade.crds`),
 *   so hook-managed CRD upgrades across operator versions deserve explicit
 *   review rather than blind chart bumps.
 * - `operator.resources` — controller pod resources
 */

import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { ClickHouseOperatorBootstrapConfig } from '../types.js';

/** Chart values shape (subset we map; the chart accepts more via customValues). */
export interface ClickHouseOperatorHelmValues {
  metrics?: { enabled?: boolean };
  crdHook?: { enabled?: boolean };
  operator?: {
    resources?: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
    };
  };
  [key: string]: unknown;
}

/**
 * Mapper result: plain values, or a graph-aware runtime merge when
 * `customValues` arrives as a schema reference / CEL expression (KRO then
 * merges the override map into the mapped values at reconcile time).
 */
export type ClickHouseOperatorMappedHelmValues =
  | ClickHouseOperatorHelmValues
  | ValuesMergeExpression;

/**
 * Fields the mapper consumes. The bootstrap passes them EXPLICITLY (never a
 * spread of the schema proxy — spreading enumerates proxy keys and leaks
 * `__typekroSchemaKey` marker garbage into the rendered values).
 */
export type ClickHouseOperatorHelmValuesInput = {
  [K in keyof Pick<
    ClickHouseOperatorBootstrapConfig,
    'metrics' | 'crdHook' | 'resources' | 'customValues'
  >]: ClickHouseOperatorBootstrapConfig[K] | undefined;
};

/**
 * Map bootstrap config to Helm chart values.
 *
 * Only explicitly-provided fields are emitted so chart defaults win
 * everywhere else. `customValues` merges LAST so user overrides always win:
 * - concrete object → deep-merged at build time (works in both modes);
 * - schema reference / CEL expression → wrapped in the graph-aware runtime
 *   values merge (`mergeValuesExpression`), which the serializer compiles to
 *   a KRO runtime map-merge — the same path the Dagster factory uses. This is
 *   what makes `customValues` WORK in kro mode instead of being silently
 *   dropped from the serialized HelmRelease values.
 */
export function mapClickHouseOperatorConfigToHelmValues(
  config: ClickHouseOperatorHelmValuesInput
): ClickHouseOperatorMappedHelmValues {
  const values: ClickHouseOperatorHelmValues = {};

  if (config.metrics !== undefined) {
    values.metrics = config.metrics;
  }

  if (config.crdHook !== undefined) {
    values.crdHook = config.crdHook;
  }

  if (config.resources !== undefined) {
    values.operator = { resources: config.resources };
  }

  return mergeCustomValuesLast(values, config.customValues);
}

/**
 * Merge `customValues` last — build-time deep merge for concrete objects,
 * graph-aware runtime merge for refs / CEL / merge expressions.
 */
function mergeCustomValuesLast(
  base: ClickHouseOperatorHelmValues,
  customValues: unknown
): ClickHouseOperatorMappedHelmValues {
  if (customValues === undefined) return base;

  if (
    isKubernetesRef(customValues) ||
    isCelExpression(customValues) ||
    isValuesMergeExpression(customValues)
  ) {
    return mergeValuesExpression(base, customValues);
  }

  if (isPlainObject(customValues)) {
    deepMerge(base, customValues);
  }

  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value) &&
    !isValuesMergeExpression(value)
  );
}

/** Minimal deep merge (objects only; arrays/scalars replace), proto-safe. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}
