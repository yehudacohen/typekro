/**
 * Traefik Helm resources.
 *
 * The factory owns both halves of the install — the chart source and the
 * release — so a consumer never hand-writes Flux objects. The bootstrap
 * composition owns the release and delegates the shared repository to a
 * singleton composition.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
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
  DEFAULT_TRAEFIK_CRDS_POLICY,
  DEFAULT_TRAEFIK_NAMESPACE,
  DEFAULT_TRAEFIK_REPOSITORY_NAME,
  DEFAULT_TRAEFIK_REPOSITORY_URL,
} from '../constants.js';
import type {
  TraefikHelmReleaseConfig,
  TraefikHelmRepositoryConfig,
  TraefikHelmValues,
  TraefikMappedHelmValues,
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
  config: Composable<TraefikHelmRepositoryConfig>
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
 * separate `traefik-crds` release is needed. Because Flux SKIPS `crds/` on
 * upgrade by default, `install.crds` and `upgrade.crds` are both set from
 * `config.crds` (default `CreateReplace`) so a chart bump moves the CRDs too.
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
  config: Composable<TraefikHelmReleaseConfig>
): Enhanced<HelmReleaseSpec<TraefikHelmValues>, HelmReleaseStatus> {
  const namespace = config.namespace ?? DEFAULT_FLUX_NAMESPACE;
  // Flux's own defaults are `install.crds: Create` and `upgrade.crds: Skip`.
  // `Skip` on upgrade is the dangerous half: the chart carries its CRDs in
  // `crds/`, so a version bump would install a newer proxy against the CRD
  // schemas the release was FIRST created with. Both actions are set from one
  // policy so they cannot drift apart.
  const crds = config.crds ?? DEFAULT_TRAEFIK_CRDS_POLICY;
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
      // Pinned to the same `name` the values mapper pins as the chart's
      // `fullnameOverride`. Left unset, Flux's `GetReleaseName()` composes
      // `<targetNamespace>-<name>` — this factory always sets
      // `targetNamespace`, so the install namespace would spend part of Helm's
      // 53-character release-name budget and a `name` at exactly the schema's
      // limit would fail the install. Pinning it makes the release name `name`
      // itself, so that limit binds on `name` alone. It also stops the release
      // name from moving when a caller changes the install namespace, which
      // Helm treats as a different release entirely.
      releaseName: config.name,
      install: {
        createNamespace: config.createNamespace ?? false,
        crds,
        remediation: { retries: 3 },
      },
      upgrade: {
        crds,
        remediation: { retries: 3, remediateLastFailure: true, strategy: 'rollback' },
      },
      // The mapper's output is a graph-aware value tree — refs and CEL
      // expressions live inside it — so it is handed to Flux as-is. The cast
      // re-states that: `Composable<>` widens every optional branch of the
      // values tree, which `TypeKroChartValues` models as its own recursive
      // union rather than as optional properties.
      ...(config.values ? { values: config.values as TraefikMappedHelmValues } : {}),
    },
  }).withReadinessEvaluator(traefikHelmReleaseReadinessEvaluator);
}
