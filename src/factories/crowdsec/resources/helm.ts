/**
 * CrowdSec Helm resources: the chart source and the release.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced, ReadinessEvaluator } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { helmReleaseLifecycle } from '../../helm/lifecycle.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type {
  HelmReleaseLifecycleOptions,
  HelmReleaseSpec,
  HelmReleaseStatus,
} from '../../helm/types.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_CROWDSEC_CHART_NAME,
  DEFAULT_CROWDSEC_CHART_VERSION,
  DEFAULT_CROWDSEC_NAMESPACE,
  DEFAULT_CROWDSEC_REPOSITORY_NAME,
  DEFAULT_CROWDSEC_REPOSITORY_URL,
} from '../constants.js';

/** Configuration of {@link crowdsecHelmRepository}. */
export interface CrowdsecHelmRepositoryConfig {
  name: string;
  /** @default the Flux namespace */
  namespace?: string;
  /** @default DEFAULT_CROWDSEC_REPOSITORY_URL */
  url?: string;
  id?: string;
}

/** Configuration of {@link crowdsecHelmRelease}. */
export interface CrowdsecHelmReleaseConfig extends HelmReleaseLifecycleOptions {
  /** Release name, pinned as Helm's `releaseName`. */
  name: string;
  /** Namespace of the HelmRelease object. @default the Flux namespace */
  namespace?: string;
  /** @default 'crowdsec' */
  targetNamespace?: string;
  /** @default DEFAULT_CROWDSEC_CHART_VERSION */
  version?: string;
  /** @default DEFAULT_CROWDSEC_REPOSITORY_NAME */
  repositoryName?: string;
  repositoryNamespace?: string;
  /** @default false */
  createNamespace?: boolean;
  values?: Record<string, unknown>;
  id?: string;
}

const repositoryReadiness = createHelmRepositoryReadinessEvaluator('CrowdSec');

/** CrowdSec `HelmRelease` readiness (the shared Flux evaluator). */
export const crowdsecHelmReleaseReadinessEvaluator: ReadinessEvaluator<unknown> =
  createLabeledHelmReleaseEvaluator('CrowdSec');

/**
 * Create the Flux `HelmRepository` for the official CrowdSec charts.
 *
 * @example
 * ```typescript
 * crowdsecHelmRepository({ name: 'crowdsec-repo', id: 'repository' });
 * ```
 */
export function crowdsecHelmRepository(
  config: Composable<CrowdsecHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: { name: config.name, namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE },
    spec: { url: config.url ?? DEFAULT_CROWDSEC_REPOSITORY_URL, interval: '1h' },
  }).withReadinessEvaluator(repositoryReadiness);
}

/**
 * Create the Flux `HelmRelease` installing CrowdSec.
 *
 * The chart ships no CRDs. Values are passed through unchanged; build them
 * with `mapCrowdsecConfigToHelmValues`.
 */
export function crowdsecHelmRelease(
  config: Composable<CrowdsecHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const namespace = config.namespace ?? DEFAULT_FLUX_NAMESPACE;
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: config.name, namespace },
    spec: {
      interval: '5m',
      // The registration Jobs and the hub downloads on first start are slow.
      timeout: '15m',
      chart: {
        spec: {
          chart: DEFAULT_CROWDSEC_CHART_NAME,
          version: config.version ?? DEFAULT_CROWDSEC_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_CROWDSEC_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_CROWDSEC_NAMESPACE,
      // Without it Flux composes `<targetNamespace>-<name>`, and every chart
      // resource name (`<release>-service`, ...) would change with it.
      releaseName: config.name,
      // The CrowdSec policy, through the shared lifecycle helper: caller
      // `install`, `upgrade` and `driftDetection` override it field by field.
      // Install and upgrade take their timeout from `spec.timeout`.
      ...helmReleaseLifecycle(config, {
        install: {
          createNamespace: config.createNamespace ?? false,
          remediation: { retries: 3 },
        },
        upgrade: {
          remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
        },
      }),
      ...(config.values ? { values: config.values as Record<string, unknown> } : {}),
    },
  }).withReadinessEvaluator(crowdsecHelmReleaseReadinessEvaluator);
}
