import { createResource } from '../shared.js';
import type { Enhanced } from '../../core/types/index.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from './types.js';
import { helmReleaseReadinessEvaluator } from './readiness-evaluators.js';

export interface HelmReleaseConfig {
  name: string;
  namespace?: string;
  interval?: string;
  chart: {
    repository: string;
    name: string;
    version?: string;
  };
  values?: Record<string, any>;
  id?: string;
}

/**
 * Deploy a Helm chart using Flux CD's HelmRelease
 *
 * Creates a HelmRelease resource that integrates with TypeKro's magic proxy system,
 * allowing schema references and CEL expressions in Helm values.
 *
 * @param config - Configuration for the HelmRelease
 *
 * @example
 * Basic Helm release:
 * ```typescript
 * helmRelease({
 *   name: 'nginx',
 *   chart: {
 *     repository: 'https://charts.bitnami.com/bitnami',
 *     name: 'nginx',
 *     version: '13.2.23'
 *   }
 * })
 * ```
 *
 * @example
 * With TypeKro schema references:
 * ```typescript
 * helmRelease({
 *   name: 'webapp',
 *   namespace: 'production',
 *   chart: {
 *     repository: 'https://charts.bitnami.com/bitnami',
 *     name: 'nginx',
 *     version: '13.2.23'
 *   },
 *   values: {
 *     service: { type: 'LoadBalancer' },
 *     replicaCount: schema.spec.replicas,
 *     image: {
 *       repository: schema.spec.image,
 *       tag: schema.spec.version
 *     },
 *     ingress: {
 *       enabled: true,
 *       hostname: schema.spec.hostname
 *     }
 *   }
 * })
 * ```
 *
 * @example
 * With cross-resource references:
 * ```typescript
 * const secret = secret({ name: 'app-secrets', data: { ... } });
 *
 * helmRelease({
 *   name: 'database',
 *   chart: {
 *     repository: 'https://charts.bitnami.com/bitnami',
 *     name: 'postgresql'
 *   },
 *   values: {
 *     auth: {
 *       existingSecret: secret.metadata.name,
 *       database: schema.spec.dbName
 *     }
 *   }
 * })
 * ```
 */
export function helmRelease(
  config: HelmReleaseConfig
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  // Extract repository name from URL for sourceRef
  let repoName = 'helm-repo';
  if (config.chart.repository.includes('bitnami')) {
    repoName = 'bitnami';
  } else if (config.chart.repository.startsWith('oci://')) {
    // For OCI repositories, use a more descriptive name based on the chart name
    repoName = `${config.name}-helm-repo`;
  } else {
    repoName =
      config.chart.repository
        .split('/')
        .pop()
        ?.replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase() || 'helm-repo';
  }

  return createResource({
    ...(config.id && { id: config.id }),
    apiVersion: 'helm.toolkit.fluxcd.io/v2',
    kind: 'HelmRelease',
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
    },
    spec: {
      interval: config.interval || '5m',
      chart: {
        spec: {
          chart: config.chart.name,
          ...(config.chart.version && { version: config.chart.version }),
          sourceRef: {
            kind: 'HelmRepository' as const,
            name: repoName,
            namespace: 'flux-system', // HelmRepositories are typically in flux-system
          },
        },
      },
      ...(config.values && { values: config.values }),
    },
    status: {
      phase: 'Pending' as const,
      revision: undefined,
      lastDeployed: undefined,
    },
  }).withReadinessEvaluator(helmReleaseReadinessEvaluator);
}

/**
 * Simplified Helm chart factory for common use cases
 *
 * This function provides a streamlined way to deploy Helm charts with TypeKro's
 * magic proxy system support for schema references and CEL expressions.
 *
 * @param name - The name of the HelmRelease resource
 * @param repository - The Helm chart repository URL
 * @param chart - The chart name within the repository
 * @param values - Optional values to override chart defaults (supports TypeKro references)
 *
 * @example
 * Basic usage:
 * ```typescript
 * simpleHelmChart('nginx', 'https://charts.bitnami.com/bitnami', 'nginx')
 * ```
 *
 * @example
 * With static values:
 * ```typescript
 * simpleHelmChart('redis', 'https://charts.bitnami.com/bitnami', 'redis', {
 *   auth: { enabled: false },
 *   replica: { replicaCount: 3 }
 * })
 * ```
 *
 * @example
 * With TypeKro schema references:
 * ```typescript
 * simpleHelmChart('database', 'https://charts.bitnami.com/bitnami', 'postgresql', {
 *   auth: {
 *     postgresPassword: schema.spec.dbPassword,
 *     database: schema.spec.dbName
 *   },
 *   primary: {
 *     persistence: {
 *       size: schema.spec.storageSize
 *     }
 *   }
 * })
 * ```
 *
 * @example
 * With cross-resource references:
 * ```typescript
 * const configMap = configMap({ name: 'app-config', data: { ... } });
 *
 * simpleHelmChart('app', 'https://charts.example.com', 'my-app', {
 *   config: {
 *     configMapName: configMap.metadata.name,
 *     replicas: schema.spec.replicas
 *   }
 * })
 * ```
 */
export function simpleHelmChart(
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
