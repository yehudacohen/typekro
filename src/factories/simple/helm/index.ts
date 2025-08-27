/**
 * Simple Helm Factory Functions
 */

import type { Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';

/**
 * Create a Helm chart release with simplified parameters
 *
 * @param name - Release name
 * @param repository - Helm repository URL or name
 * @param chart - Chart name
 * @param values - Helm values to override
 * @returns Enhanced HelmRelease resource
 */
export function HelmChart(
  name: string,
  repository: string,
  chart: string,
  values?: Record<string, any>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name,
    chart: { repository, name: chart },
    ...(values && { values }),
  });
}
