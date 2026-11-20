/**
 * Barman Cloud plugin HelmRelease, from the official `plugin-barman-cloud` chart in the
 * CloudNativePG chart repository (the same repository as the operator, so `cnpgHelmRepository`
 * serves both).
 *
 * The chart installs the `ObjectStore` CRD (kept on uninstall), the plugin Deployment and the
 * `barman-cloud` Service the operator discovers it by, and cert-manager `Certificate`s for the
 * plugin's TLS. cert-manager must be running first, and the release must be in the operator's
 * namespace, which must run CloudNativePG 1.30.0 or later: `operatorVersion` is required and an
 * older version is refused.
 *
 * `crds.create` and `service.name` are fixed. The `ObjectStore` CRD comes from this chart, and
 * the chart says the service name must not change, because the plugin's TLS certificates are
 * issued for it. Concrete raw values that change either are refused
 * (`CNPG_BARMAN_CLOUD_RESERVED_CHART_VALUE`), and both are applied after the caller's values,
 * so values only known per instance can't change them either.
 */

import {
  isMergeableValuesObject,
  materializeValuesMergeExpressions,
  mergeValuesExpression,
  withChartValueDefaults,
} from '../../../core/aspects/values-merge.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { TypeKroError } from '../../../core/errors.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import { helmReleaseLifecycle } from '../../helm/lifecycle.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import {
  BARMAN_CLOUD_PLUGIN_CHART_NAME,
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  BARMAN_CLOUD_PLUGIN_SERVICE_NAME,
  CNPG_CHART_REPOSITORY_URL,
  DEFAULT_CNPG_NAMESPACE,
  DEFAULT_CNPG_REPOSITORY_NAME,
} from '../constants.js';
import type { BarmanCloudPluginHelmReleaseConfig } from '../types.js';
import { BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT } from '../utils/barman-cloud-constraints.js';

/** The chart values the factory owns, as dotted paths. */
export const BARMAN_CLOUD_PLUGIN_RESERVED_CHART_VALUES = ['crds.create', 'service.name'] as const;

const RESERVED_VALUES = {
  crds: { create: true },
  service: { name: BARMAN_CLOUD_PLUGIN_SERVICE_NAME },
} as const;

/**
 * Throws when concrete caller `values` set a reserved chart value to anything else. Values only
 * known per instance are not checked here; the reserved values are merged over them instead.
 */
function assertNoReservedOverrides(values: unknown): void {
  if (!isMergeableValuesObject(values)) return;
  const conflicts: string[] = [];
  for (const [section, key] of [
    ['crds', 'create'],
    ['service', 'name'],
  ] as const) {
    if (!(section in values)) continue;
    const given = values[section];
    if (!isMergeableValuesObject(given)) {
      conflicts.push(section);
    } else if (
      key in given &&
      given[key] !== (RESERVED_VALUES[section] as Record<string, unknown>)[key]
    ) {
      conflicts.push(`${section}.${key}`);
    }
  }
  if (conflicts.length > 0) {
    throw new TypeKroError(
      `Barman Cloud plugin chart values can't override ${conflicts.join(', ')}. The chart must ` +
        `install the ObjectStore CRD (crds.create: true), and its service must be named ` +
        `"${BARMAN_CLOUD_PLUGIN_SERVICE_NAME}": the plugin's TLS certificates are issued for that ` +
        'name. Other keys under crds and service, such as service.port, may be set.',
      'CNPG_BARMAN_CLOUD_RESERVED_CHART_VALUE',
      { conflicts }
    );
  }
}

/** Caller values, with the reserved values applied last. Resolved now when all are concrete. */
function pluginChartValues(values: unknown): Record<string, unknown> {
  assertNoReservedOverrides(values);
  const layered = mergeValuesExpression(withChartValueDefaults({}, values), RESERVED_VALUES);
  return (
    isMergeableValuesObject(layered.base) && layered.overlays.every(isMergeableValuesObject)
      ? materializeValuesMergeExpressions(layered)
      : layered
  ) as Record<string, unknown>;
}

/**
 * Create the HelmRelease that installs the Barman Cloud plugin.
 *
 * @example
 * ```typescript
 * const plugin = barmanCloudPluginHelmRelease({
 *   name: 'barman-cloud',
 *   namespace: 'cnpg-system',
 *   operatorVersion: '1.30.2',
 *   id: 'barmanCloudPluginHelmRelease',
 * });
 * ```
 */
export function barmanCloudPluginHelmRelease(
  config: Composable<BarmanCloudPluginHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT.enforce(config.operatorVersion);
  return helmRelease({
    name: config.name,
    namespace: config.namespace ?? DEFAULT_CNPG_NAMESPACE,
    chart: {
      repository: CNPG_CHART_REPOSITORY_URL,
      name: BARMAN_CLOUD_PLUGIN_CHART_NAME,
      version: config.version ?? BARMAN_CLOUD_PLUGIN_CHART_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_CNPG_REPOSITORY_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    ...helmReleaseLifecycle(config, { driftDetection: { mode: 'enabled' } }),
    values: pluginChartValues(config.values),
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Barman Cloud plugin')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}
