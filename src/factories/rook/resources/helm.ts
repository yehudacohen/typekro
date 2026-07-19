/** Official Rook Ceph operator Helm resource factories. */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import {
  createHelmRepositoryReadinessEvaluator,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
  helmRepository,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type { RookCephHelmReleaseConfig, RookCephHelmRepositoryConfig } from '../types.js';

/** Official Rook release chart repository. */
export const DEFAULT_ROOK_CEPH_REPO_URL = 'https://charts.rook.io/release';

/** Shared Flux HelmRepository name. */
export const DEFAULT_ROOK_CEPH_REPO_NAME = 'rook-release';

/** Official Rook Ceph operator chart name. */
export const ROOK_CEPH_OPERATOR_CHART_NAME = 'rook-ceph';

/** Official chart that creates a CephCluster and optional storage resources. */
export const ROOK_CEPH_CLUSTER_CHART_NAME = 'rook-ceph-cluster';

/** Latest stable Rook Ceph operator chart verified on 2026-07-09. */
export const DEFAULT_ROOK_CEPH_VERSION = 'v1.20.2';

/** Create the shared Flux source for official Rook release charts. */
export function rookCephHelmRepository(
  config: Composable<RookCephHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  const repository = helmRepository({
    name: config.name ?? DEFAULT_ROOK_CEPH_REPO_NAME,
    namespace: config.namespace ?? DEFAULT_FLUX_NAMESPACE,
    url: config.url ?? DEFAULT_ROOK_CEPH_REPO_URL,
    interval: config.interval ?? '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('Rook Ceph')) as Enhanced<
    HelmRepositorySpec,
    HelmRepositoryStatus
  >;

  return repository;
}

/** Create a Flux HelmRelease for the official `rook-ceph` operator chart. */
export function rookCephOperatorHelmRelease(
  config: Composable<RookCephHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace ?? 'rook-ceph',
    chart: {
      repository: config.repositoryUrl ?? DEFAULT_ROOK_CEPH_REPO_URL,
      name: ROOK_CEPH_OPERATOR_CHART_NAME,
      version: config.version ?? DEFAULT_ROOK_CEPH_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_ROOK_CEPH_REPO_NAME,
      namespace: config.repositoryNamespace ?? DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    values: config.values ?? {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Rook Ceph')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}

/** Create a Flux HelmRelease for the official `rook-ceph-cluster` chart. */
export function rookCephClusterHelmRelease(
  config: Composable<RookCephHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace ?? 'rook-ceph',
    chart: {
      repository: config.repositoryUrl ?? DEFAULT_ROOK_CEPH_REPO_URL,
      name: ROOK_CEPH_CLUSTER_CHART_NAME,
      version: config.version ?? DEFAULT_ROOK_CEPH_VERSION,
    },
    sourceRef: {
      name: config.repositoryName ?? DEFAULT_ROOK_CEPH_REPO_NAME,
      namespace: config.repositoryNamespace ?? DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    values: config.values ?? {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(createLabeledHelmReleaseEvaluator('Rook Ceph cluster')) as Enhanced<
    HelmReleaseSpec,
    HelmReleaseStatus
  >;
}
