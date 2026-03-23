/**
 * Inngest Helm Resource Factories
 *
 * Wrappers around the generic Helm factories with Inngest-specific defaults.
 * The official Inngest Helm chart is published as an OCI artifact.
 *
 * @see https://github.com/inngest/inngest-helm
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { helmRelease } from '../../helm/helm-release.js';
import type { InngestHelmReleaseConfig, InngestHelmRepositoryConfig } from '../types.js';

/** Default OCI registry URL for the Inngest Helm chart. */
export const DEFAULT_INNGEST_REPO_URL = 'oci://ghcr.io/inngest/inngest-helm';

/** Default chart version. */
export const DEFAULT_INNGEST_VERSION = '0.3.1';

/** Default HelmRepository resource name. */
export const DEFAULT_INNGEST_REPO_NAME = 'inngest-repo';

/**
 * Create a HelmRepository for the Inngest OCI chart registry.
 *
 * @param config - Repository configuration with Inngest-specific defaults
 * @returns Enhanced HelmRepository resource
 *
 * @example
 * ```typescript
 * const repo = inngestHelmRepository({
 *   name: 'inngest-repo',
 *   id: 'inngestHelmRepository',
 * });
 * ```
 */
export function inngestHelmRepository(
  config: Composable<InngestHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name || DEFAULT_INNGEST_REPO_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_INNGEST_REPO_URL,
    type: 'oci',
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('Inngest')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;
}

/**
 * Create a HelmRelease for the Inngest deployment.
 *
 * @param config - Release configuration with Inngest-specific defaults
 * @returns Enhanced HelmRelease resource
 *
 * @example
 * ```typescript
 * const release = inngestHelmRelease({
 *   name: 'inngest',
 *   namespace: 'inngest',
 *   values: {
 *     inngest: { eventKey: 'abc123', signingKey: 'def456' },
 *   },
 *   id: 'inngestHelmRelease',
 * });
 * ```
 */
export function inngestHelmRelease(
  config: Composable<InngestHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Pass values directly to helmRelease — the core proxy system handles
  // serialization of KubernetesRef and CelExpression objects correctly.
  // Do NOT sanitize/strip proxy references here.
  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'inngest',
    chart: {
      repository: DEFAULT_INNGEST_REPO_URL,
      name: 'inngest',
      version: config.version || DEFAULT_INNGEST_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || DEFAULT_INNGEST_REPO_NAME,
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    values: config.values || {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('Inngest')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
