/**
 * ClickStack Helm Resource Factories
 *
 * Wrappers around the generic Flux Helm factories with ClickStack- and
 * OpenTelemetry-specific defaults (build-around: we wrap the OFFICIAL charts,
 * never hand-rolled manifests).
 *
 * Charts:
 * - `clickstack` from https://clickhouse.github.io/ClickStack-helm-charts
 *   (classic Helm repo, MIT). NOT the archived hyperdxio/helm-charts repo and
 *   NOT the deprecated `hdx-oss-v2` chart.
 * - `opentelemetry-collector` from
 *   https://open-telemetry.github.io/opentelemetry-helm-charts (the stock
 *   chart used by the documented ClickStack k8s ingestion pattern; it is also
 *   the clickstack chart's only dependency, vendored as alias `otel-collector`).
 *
 * Both chart repositories are cluster-level Flux sources shared by every
 * consumer, so the bootstrap compositions deploy them via `singleton(...)`
 * (see compositions/*-helm-repository.ts). NOTE from the clickhouse family:
 * direct-mode `toYaml()` omits singleton-owned resources — tests must assert
 * repository URLs on the KRO instance bundle instead.
 */

import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { setMetadataField } from '../../../core/metadata/resource-metadata.js';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/helm-repository.js';
import { createLabeledHelmReleaseEvaluator } from '../../helm/readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import type {
  ClickStackHelmReleaseConfig,
  ClickStackHelmRepositoryConfig,
  OtelCollectorHelmReleaseConfig,
} from '../types.js';

/** Official ClickStack Helm chart repository URL (classic repo, not OCI). */
export const DEFAULT_CLICKSTACK_REPO_URL = 'https://clickhouse.github.io/ClickStack-helm-charts';

/** Default Flux HelmRepository name for the ClickStack chart repository. */
export const DEFAULT_CLICKSTACK_REPO_NAME = 'clickstack';

/** Official ClickStack chart name. */
export const CLICKSTACK_CHART_NAME = 'clickstack';

/**
 * Default clickstack chart version (verified against the live repo index on
 * 2026-07-06: 3.0.1, appVersion 2.29.0).
 */
export const DEFAULT_CLICKSTACK_VERSION = '3.0.1';

/** Official OpenTelemetry Helm chart repository URL. */
export const DEFAULT_OTEL_REPO_URL = 'https://open-telemetry.github.io/opentelemetry-helm-charts';

/** Default Flux HelmRepository name for the OpenTelemetry chart repository. */
export const DEFAULT_OTEL_REPO_NAME = 'open-telemetry';

/** Stock collector chart name. */
export const OTEL_COLLECTOR_CHART_NAME = 'opentelemetry-collector';

/**
 * Default stock opentelemetry-collector chart version for the k8s telemetry
 * collectors. Pinned to the same minor the clickstack chart declares for its
 * gateway subchart dependency (`~0.146.0`; 0.146.1 verified on the live repo
 * index 2026-07-06) so gateway and edge collectors stay aligned.
 */
export const DEFAULT_OTEL_COLLECTOR_VERSION = '0.146.1';

// Chart port facts (values.yaml `hyperdx.ports` and `otel-collector.ports`,
// chart 3.0.1) — the bootstrap status contract is built on these defaults.

/** HyperDX UI port (`hyperdx.ports.app`). */
export const CLICKSTACK_APP_PORT = 3000;

/** HyperDX API port (`hyperdx.ports.api`). */
export const CLICKSTACK_API_PORT = 8000;

/** Gateway collector OTLP/HTTP servicePort (`otel-collector.ports.otlp-http`). */
export const CLICKSTACK_OTLP_HTTP_PORT = 4318;

/** Gateway collector OTLP/gRPC servicePort (`otel-collector.ports.otlp`). */
export const CLICKSTACK_OTLP_GRPC_PORT = 4317;

/** Suffix the chart appends to `.Release.Name` for the gateway collector Service. */
export const CLICKSTACK_GATEWAY_NAME_SUFFIX = '-otel-collector';

/**
 * Create a Flux HelmRepository for the official ClickStack chart repository.
 */
export function clickstackHelmRepository(
  config: Composable<ClickStackHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  const repo = helmRepository({
    name: config.name || DEFAULT_CLICKSTACK_REPO_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_CLICKSTACK_REPO_URL,
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('ClickStack')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;

  // One cluster-level Flux source shared by every consumer — never torn down
  // with an individual instance.
  setMetadataField(repo, 'scopes', ['cluster']);

  return repo;
}

/**
 * Create a Flux HelmRepository for the official OpenTelemetry chart repository.
 */
export function otelHelmRepository(
  config: Composable<ClickStackHelmRepositoryConfig>
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  const repo = helmRepository({
    name: config.name || DEFAULT_OTEL_REPO_NAME,
    namespace: config.namespace || DEFAULT_FLUX_NAMESPACE,
    url: config.url || DEFAULT_OTEL_REPO_URL,
    interval: config.interval || '5m',
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createHelmRepositoryReadinessEvaluator('OpenTelemetry')
  ) as Enhanced<HelmRepositorySpec, HelmRepositoryStatus>;

  setMetadataField(repo, 'scopes', ['cluster']);

  return repo;
}

/**
 * Create a Flux HelmRelease for ClickStack using the official chart defaults.
 */
export function clickstackHelmRelease(
  config: Composable<ClickStackHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'clickstack',
    chart: {
      repository: DEFAULT_CLICKSTACK_REPO_URL,
      name: CLICKSTACK_CHART_NAME,
      version: config.version || DEFAULT_CLICKSTACK_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || DEFAULT_CLICKSTACK_REPO_NAME,
      namespace: config.repositoryNamespace || DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    ...(config.valuesFrom && { valuesFrom: config.valuesFrom }),
    values: config.values || {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('ClickStack')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}

/**
 * Create a Flux HelmRelease for a stock opentelemetry-collector instance
 * (daemonset or deployment mode is decided by the supplied values).
 */
export function otelCollectorHelmRelease(
  config: Composable<OtelCollectorHelmReleaseConfig>
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  return helmRelease({
    name: config.name,
    namespace: config.namespace || 'clickstack-telemetry',
    chart: {
      repository: DEFAULT_OTEL_REPO_URL,
      name: OTEL_COLLECTOR_CHART_NAME,
      version: config.version || DEFAULT_OTEL_COLLECTOR_VERSION,
    },
    sourceRef: {
      name: config.repositoryName || DEFAULT_OTEL_REPO_NAME,
      namespace: config.repositoryNamespace || DEFAULT_FLUX_NAMESPACE,
      kind: 'HelmRepository',
    },
    driftDetection: { mode: 'enabled' },
    values: config.values || {},
    ...(config.id && { id: config.id }),
  }).withReadinessEvaluator(
    createLabeledHelmReleaseEvaluator('OtelCollector')
  ) as Enhanced<HelmReleaseSpec, HelmReleaseStatus>;
}
