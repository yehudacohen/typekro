import type { TypeKroChartValue } from '../../../core/types/common.js';
import type { Enhanced } from '../../../core/types/index.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
  type HelmRepositoryConfig,
  type HelmRepositorySpec,
  type HelmRepositoryStatus,
} from '../../helm/index.js';
import { helmRelease } from '../../helm/helm-release.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../../helm/types.js';
import { DEFAULT_ENVOY_PROXY_REPOSITORY_URL } from '../constants.js';
import type { EnvoyGatewayHelmReleaseConfig } from '../types.js';

export function envoyProxyHelmRepository(
  config: Omit<HelmRepositoryConfig, 'url' | 'type'> & { readonly url?: string }
): Enhanced<HelmRepositorySpec, HelmRepositoryStatus> {
  return helmRepository({
    ...config,
    url: config.url ?? DEFAULT_ENVOY_PROXY_REPOSITORY_URL,
    type: 'oci',
  }).withReadinessEvaluator(createHelmRepositoryReadinessEvaluator('Envoy'));
}

export function envoyGatewayHelmRelease(
  config: EnvoyGatewayHelmReleaseConfig
): Enhanced<HelmReleaseSpec<Record<string, unknown>>, HelmReleaseStatus> {
  return envoyHelmRelease(config, 'gateway-helm');
}

export function envoyAIGatewayCrdsHelmRelease(
  config: EnvoyGatewayHelmReleaseConfig
): Enhanced<HelmReleaseSpec<Record<string, unknown>>, HelmReleaseStatus> {
  return envoyHelmRelease(config, 'ai-gateway-crds-helm');
}

export function envoyAIGatewayControllerHelmRelease(
  config: EnvoyGatewayHelmReleaseConfig
): Enhanced<HelmReleaseSpec<Record<string, unknown>>, HelmReleaseStatus> {
  return envoyHelmRelease(config, 'ai-gateway-helm');
}

function envoyHelmRelease(
  config: EnvoyGatewayHelmReleaseConfig,
  chart: string
): Enhanced<HelmReleaseSpec<Record<string, unknown>>, HelmReleaseStatus> {
  return helmRelease<Record<string, unknown>>({
    name: config.name,
    namespace: config.namespace,
    chart: {
      repository: DEFAULT_ENVOY_PROXY_REPOSITORY_URL,
      name: chart,
      version: config.version,
    },
    sourceRef: {
      name: config.repositoryName,
      namespace: config.repositoryNamespace,
    },
    values: config.values as TypeKroChartValue<Record<string, unknown>>,
    ...(config.valuesFrom ? { valuesFrom: config.valuesFrom } : {}),
    install: {
      timeout: '15m',
      remediation: {
        retries: 3,
        remediateLastFailure: true,
      },
    },
    upgrade: {
      timeout: '15m',
      remediation: {
        retries: 3,
        remediateLastFailure: true,
        strategy: 'rollback',
      },
    },
    driftDetection: { mode: 'enabled' },
    ...(config.id ? { id: config.id } : {}),
  });
}
