/**
 * Hyperspike Valkey Operator Helm Resource Factories
 *
 * Wrappers around the generic Helm factories with Valkey-specific defaults.
 * Used by the valkeyBootstrap composition to install the operator.
 *
 * Note: The Hyperspike operator uses an OCI registry (ghcr.io), not a
 * traditional Helm chart repository. Flux HelmRepository supports OCI
 * via `type: oci` in the spec.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Enhanced } from '../../../core/types/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { helmRelease } from '../../helm/helm-release.js';
import type { ValkeyHelmReleaseConfig, ValkeyHelmRepositoryConfig } from '../types.js';

/** Default OCI registry URL for the Hyperspike charts. */
export const DEFAULT_VALKEY_REPO_URL = 'oci://ghcr.io/hyperspike';

/** Default chart version (Hyperspike uses 'v{version}-chart' tag format). */
export const DEFAULT_VALKEY_VERSION = 'v0.0.61-chart';

/** Default HelmRepository resource name. */
export const DEFAULT_VALKEY_REPO_NAME = 'valkey-operator-repo';

/**
 * Sanitize Helm values by removing non-serializable objects.
 *
 * Strips KubernetesRef proxies and CelExpression objects via JSON round-trip.
 * Note: this also drops Date objects, functions, Infinity, and NaN — custom
 * values must be JSON-serializable primitives, arrays, and plain objects.
 */
function sanitizeHelmValues(values: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(values, (_key, value) => {
      if (isKubernetesRef(value)) {
        return undefined;
      }
      if (isCelExpression(value)) {
        return undefined;
      }
      return value;
    })
  );
}

/**
 * Create a HelmRepository for the Hyperspike Valkey operator OCI registry.
 *
 * @param config - Repository configuration with Valkey-specific defaults
 * @returns Enhanced HelmRepository resource
 *
 * @example
 * ```typescript
 * const repo = valkeyHelmRepository({
 *   name: 'valkey-operator-repo',
 *   namespace: 'flux-system',
 *   id: 'valkeyHelmRepository',
 * });
 * ```
 */
export function valkeyHelmRepository(
  config: ValkeyHelmRepositoryConfig
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    name: config.name || 'valkey-operator-repo',
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_VALKEY_REPO_URL,
    type: 'oci',
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('Valkey')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;
}

/**
 * Create a HelmRelease for the Hyperspike Valkey operator.
 *
 * @param config - Release configuration with Valkey-specific defaults
 * @returns Enhanced HelmRelease resource
 *
 * @example
 * ```typescript
 * const release = valkeyHelmRelease({
 *   name: 'valkey-operator',
 *   namespace: 'valkey-operator-system',
 *   id: 'valkeyHelmRelease',
 * });
 * ```
 */
export function valkeyHelmRelease(
  config: ValkeyHelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  const sanitizedValues = config.values ? sanitizeHelmValues(config.values) : {};

  // chart.repository is used for chart identification; sourceRef is what Flux
  // actually uses to resolve the chart. Both are required by the helmRelease factory.
  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'valkey-operator-system',
    chart: {
      repository: DEFAULT_VALKEY_REPO_URL,
      name: 'valkey-operator',
      version: config.version || DEFAULT_VALKEY_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || 'valkey-operator-repo',
      namespace: DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    values: sanitizedValues,
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('Valkey')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
