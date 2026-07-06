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
 * Map bootstrap config to Helm chart values.
 *
 * Only explicitly-provided fields are emitted so chart defaults win
 * everywhere else; `customValues` spreads last for user overrides.
 */
export function mapClickHouseOperatorConfigToHelmValues(
  config: ClickHouseOperatorBootstrapConfig
): ClickHouseOperatorHelmValues {
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

  return {
    ...values,
    ...(config.customValues || {}),
  };
}
