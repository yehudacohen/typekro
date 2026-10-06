// Karpenter Helm resources: the shared OCI `HelmRepository` and the two
// `HelmRelease`s, `karpenter-crd` and `karpenter`.

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
  HelmReleaseCrdsPolicy,
  HelmReleaseSpec,
  HelmReleaseStatus,
} from '../../helm/types.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_KARPENTER_CHART_VERSION,
  DEFAULT_KARPENTER_NAMESPACE,
  DEFAULT_KARPENTER_REPOSITORY_NAME,
  DEFAULT_KARPENTER_REPOSITORY_URL,
  KARPENTER_CHART_NAME,
  KARPENTER_CRD_CHART_NAME,
} from '../constants.js';
import type { KarpenterHelmReleaseConfig, KarpenterHelmRepositoryConfig } from '../types.js';

/** Karpenter `HelmRelease` readiness (the shared Flux evaluator). */
export const karpenterHelmReleaseReadinessEvaluator: ReadinessEvaluator<unknown> =
  createLabeledHelmReleaseEvaluator('Karpenter');

/**
 * Create the Flux `HelmRepository` for the official Karpenter OCI registry.
 *
 * OCI repositories publish no `Ready` condition; readiness falls back to Flux
 * having accepted the object.
 *
 * @example
 * ```typescript
 * karpenterHelmRepository({ id: 'karpenterRepository' });
 * ```
 */
export function karpenterHelmRepository(
  config: Composable<KarpenterHelmRepositoryConfig> = {}
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name ?? DEFAULT_KARPENTER_REPOSITORY_NAME,
      namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      type: 'oci',
      url: config.url ?? DEFAULT_KARPENTER_REPOSITORY_URL,
      interval: config.interval ?? '1h',
    },
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('Karpenter'));
}

function karpenterRelease(
  chart: string,
  crds: HelmReleaseCrdsPolicy | undefined,
  config: Composable<KarpenterHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const namespace = config.namespace ?? DEFAULT_FLUX_NAMESPACE;
  return createResource<HelmReleaseSpec, HelmReleaseStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: { name: config.name, namespace },
    spec: {
      interval: '10m',
      timeout: '10m',
      chart: {
        spec: {
          chart,
          version: config.version ?? DEFAULT_KARPENTER_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_KARPENTER_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_KARPENTER_NAMESPACE,
      // Pinned so Flux does not compose `<targetNamespace>-<name>`.
      releaseName: config.name,
      // Karpenter's own policy, through the shared lifecycle helper: caller
      // `install`, `upgrade` and `driftDetection` override it field by field.
      // Install and upgrade take their timeout from `spec.timeout`.
      ...helmReleaseLifecycle(config, {
        install: {
          createNamespace: config.createNamespace ?? false,
          ...(crds ? { crds } : {}),
          remediation: { retries: 3 },
        },
        upgrade: {
          ...(crds ? { crds } : {}),
          remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
        },
        driftDetection: { mode: 'enabled' },
      }),
      ...(config.dependsOn
        ? { dependsOn: config.dependsOn as { name: string; namespace?: string }[] }
        : {}),
      ...(config.values ? { values: config.values as Record<string, unknown> } : {}),
    },
  }).withReadinessEvaluator(karpenterHelmReleaseReadinessEvaluator);
}

/**
 * Create the `HelmRelease` for the `karpenter-crd` chart.
 *
 * That chart ships the CRDs as templates, so Helm upgrades them with the
 * release. Upstream recommends it over the controller chart's `crds/`
 * directory, which Helm never upgrades.
 *
 * @example
 * ```typescript
 * karpenterCrdHelmRelease({ name: 'karpenter-crd', id: 'karpenterCrdRelease' });
 * ```
 */
export function karpenterCrdHelmRelease(
  config: Composable<KarpenterHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return karpenterRelease(KARPENTER_CRD_CHART_NAME, undefined, config);
}

/**
 * Create the `HelmRelease` for the Karpenter controller chart.
 *
 * The chart's `crds/` directory is skipped on install and upgrade: install the
 * CRDs with {@link karpenterCrdHelmRelease} or manage them elsewhere.
 *
 * @example
 * ```typescript
 * karpenterHelmRelease({
 *   name: 'karpenter',
 *   values: { settings: { clusterName: 'my-cluster' } },
 *   id: 'karpenterRelease',
 * });
 * ```
 */
export function karpenterHelmRelease(
  config: Composable<KarpenterHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return karpenterRelease(KARPENTER_CHART_NAME, 'Skip', config);
}
