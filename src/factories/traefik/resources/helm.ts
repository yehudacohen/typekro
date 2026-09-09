/**
 * Traefik Helm resources.
 *
 * The factory owns both halves of the install — the chart source and the
 * release — so a consumer never hand-writes Flux objects. The bootstrap
 * composition owns the release and delegates the shared repository to a
 * singleton composition.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_TRAEFIK_CHART_NAME,
  DEFAULT_TRAEFIK_CHART_VERSION,
  DEFAULT_TRAEFIK_NAMESPACE,
  DEFAULT_TRAEFIK_REPOSITORY_NAME,
  DEFAULT_TRAEFIK_REPOSITORY_URL,
} from '../constants.js';
import type {
  TraefikHelmReleaseConfig,
  TraefikHelmRepositoryConfig,
  TraefikHelmValues,
} from '../types.js';

/** Traefik `HelmRepository` readiness (delegates to the shared Flux evaluator). */
const traefikHelmRepositoryReadinessEvaluator = createHelmRepositoryReadinessEvaluator('Traefik');

/**
 * Traefik `HelmRelease` readiness (delegates to the shared Flux evaluator).
 *
 * Exported so a consumer graph that adopts an externally created release can
 * reuse the same readiness contract.
 */
export const traefikHelmReleaseReadinessEvaluator = createLabeledHelmReleaseEvaluator('Traefik');

/**
 * Create the Flux `HelmRepository` for the official Traefik chart repository.
 *
 * This is a classic (non-OCI) Helm repository, so Flux publishes a normal
 * `Ready` condition for it.
 *
 * @example
 * ```typescript
 * traefikHelmRepository({ name: 'traefik-repo', id: 'repository' });
 * ```
 */
export function traefikHelmRepository(
  config: TraefikHelmRepositoryConfig
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return createResource<HelmRepositorySpec, HelmRepositoryStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'source.toolkit.fluxcd.io/v1',
    kind: 'HelmRepository',
    metadata: {
      name: config.name,
      namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    },
    spec: {
      url: config.url ?? DEFAULT_TRAEFIK_REPOSITORY_URL,
      interval: config.interval ?? '1h',
    },
  }).withReadinessEvaluator(traefikHelmRepositoryReadinessEvaluator);
}

/**
 * Create the Flux `HelmRelease` installing Traefik.
 *
 * Chart 41.5.0 ships the `traefik.io/v1alpha1` CRDs in its own `crds/`
 * directory, so this single release installs both the CRDs and the proxy — no
 * separate `traefik-crds` release is needed.
 *
 * Values are passed through unchanged. Build them with
 * `mapTraefikConfigToHelmValues`, which applies the security pins from #172.
 *
 * @example
 * ```typescript
 * traefikHelmRelease({
 *   name: 'traefik',
 *   targetNamespace: 'traefik',
 *   repositoryName: 'traefik-repo',
 *   values: mapTraefikConfigToHelmValues({ name: 'traefik' }),
 *   id: 'traefikHelmRelease',
 * });
 * ```
 */
export function traefikHelmRelease(
  config: TraefikHelmReleaseConfig
): Enhanced<HelmReleaseSpec<TraefikHelmValues>, HelmReleaseStatus> {
  const namespace = config.namespace ?? DEFAULT_FLUX_NAMESPACE;
  return createResource<HelmReleaseSpec<TraefikHelmValues>, HelmReleaseStatus>({
    ...(config.id ? { id: config.id } : {}),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      namespace,
    },
    spec: {
      interval: config.interval ?? '5m',
      timeout: config.timeout ?? '10m',
      chart: {
        spec: {
          chart: DEFAULT_TRAEFIK_CHART_NAME,
          version: config.version ?? DEFAULT_TRAEFIK_CHART_VERSION,
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: config.repositoryName ?? DEFAULT_TRAEFIK_REPOSITORY_NAME,
            namespace: config.repositoryNamespace ?? namespace,
          },
        },
      },
      targetNamespace: config.targetNamespace ?? DEFAULT_TRAEFIK_NAMESPACE,
      install: {
        createNamespace: config.createNamespace ?? false,
        remediation: { retries: 3 },
      },
      upgrade: {
        remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
      },
      ...(config.values ? { values: config.values } : {}),
    },
  }).withReadinessEvaluator(traefikHelmReleaseReadinessEvaluator);
}
