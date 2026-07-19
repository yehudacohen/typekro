import {
  DEFAULT_FLUX_NAMESPACE,
  WELL_KNOWN_HELM_REPOSITORIES,
} from '../../core/config/defaults.js';
import { getComponentLogger } from '../../core/logging/index.js';
import type { Enhanced } from '../../core/types/index.js';
import type { TypeKroChartValue, TypeKroValueTreeObject } from '../../core/types/common.js';
import { createResource } from '../shared.js';
import { helmReleaseReadinessEvaluator } from './readiness-evaluators.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from './types.js';

type HelmReleaseAuthoringSpec<TValues extends object> = Omit<HelmReleaseSpec<TValues>, 'values'> & {
  values?: TypeKroChartValue<TValues>;
};

export interface HelmReleaseConfig<TValues extends object = TypeKroValueTreeObject> {
  name: string;
  namespace?: string;
  /** @default '5m' */
  interval?: string;
  chart: {
    repository: string;
    name: string;
    version?: string;
  };
  /**
   * Override the auto-detected HelmRepository sourceRef.
   * By default, the factory infers sourceRef.name from the chart repository URL.
   * Use this to point at a specific HelmRepository resource.
   */
  sourceRef?: {
    name: string;
    /** @default 'flux-system' */
    namespace?: string;
    /** @default 'HelmRepository' */
    kind?: 'HelmRepository';
  };
  /**
   * Graph-aware Helm values. TypeKro serializes nested refs, CEL expressions,
   * mixed-template strings, arrays, and plain objects recursively.
   */
  values?: TypeKroChartValue<TValues>;
  /**
   * Flux install policy. The supplied fields override TypeKro's bounded retry
   * defaults; nested remediation fields are merged rather than replaced.
   */
  install?: HelmReleaseSpec['install'];
  /**
   * Flux upgrade policy. Stateful charts can disable automatic remediation
   * when rolling back across a database migration would be unsafe.
   */
  upgrade?: HelmReleaseSpec['upgrade'];
  driftDetection?: HelmReleaseSpec['driftDetection'];
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
export function helmRelease<TValues extends object = TypeKroValueTreeObject>(
  config: HelmReleaseConfig<TValues>
): Enhanced<HelmReleaseSpec<TValues>, HelmReleaseStatus> {
  // Determine sourceRef — use explicit config or auto-detect from repository URL
  let sourceRefName: string;
  let sourceRefNamespace: string;

  if (config.sourceRef) {
    sourceRefName = config.sourceRef.name;
    sourceRefNamespace = config.sourceRef.namespace || DEFAULT_FLUX_NAMESPACE;
  } else {
    // Auto-detect repository name from URL
    sourceRefNamespace = DEFAULT_FLUX_NAMESPACE;

    // Check well-known repositories first
    let wellKnownMatch: string | undefined;
    for (const [pattern, name] of WELL_KNOWN_HELM_REPOSITORIES) {
      if (config.chart.repository.includes(pattern)) {
        wellKnownMatch = name;
        break;
      }
    }

    if (wellKnownMatch) {
      sourceRefName = wellKnownMatch;
    } else if (config.chart.repository.startsWith('oci://')) {
      sourceRefName = `${config.name}-helm-repo`;
    } else {
      sourceRefName =
        config.chart.repository
          .split('/')
          .pop()
          ?.replace(/[^a-z0-9-]/gi, '-')
          .toLowerCase() || 'helm-repo';
    }
  }

  return createResource<HelmReleaseAuthoringSpec<TValues>, HelmReleaseStatus>({
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
            name: sourceRefName,
            namespace: sourceRefNamespace,
          },
        },
      },
      // Retry on failed installs — required for charts that depend on external
      // resources (e.g., Inngest waiting for Postgres/Redis to be ready).
      install: {
        timeout: config.install?.timeout ?? '10m',
        remediation: {
          retries: config.install?.remediation?.retries ?? 3,
          ...(config.install?.remediation?.remediateLastFailure !== undefined && {
            remediateLastFailure: config.install.remediation.remediateLastFailure,
          }),
          ...(config.install?.remediation?.ignoreTestFailures !== undefined && {
            ignoreTestFailures: config.install.remediation.ignoreTestFailures,
          }),
        },
        ...(config.install?.createNamespace !== undefined && {
          createNamespace: config.install.createNamespace,
        }),
      },
      upgrade: {
        timeout: config.upgrade?.timeout ?? '10m',
        remediation: {
          retries: config.upgrade?.remediation?.retries ?? 3,
          ...(config.upgrade?.remediation?.remediateLastFailure !== undefined && {
            remediateLastFailure: config.upgrade.remediation.remediateLastFailure,
          }),
          ...(config.upgrade?.remediation?.ignoreTestFailures !== undefined && {
            ignoreTestFailures: config.upgrade.remediation.ignoreTestFailures,
          }),
          ...(config.upgrade?.remediation?.strategy && {
            strategy: config.upgrade.remediation.strategy,
          }),
        },
      },
      ...(config.driftDetection && { driftDetection: config.driftDetection }),
      ...(config.values && { values: config.values }),
    },
  }).withReadinessEvaluator(helmReleaseReadinessEvaluator) as Enhanced<
    HelmReleaseSpec<TValues>,
    HelmReleaseStatus
  >;
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
 * simple.HelmChart('nginx', 'https://charts.bitnami.com/bitnami', 'nginx')
 * ```
 *
 * @example
 * With static values:
 * ```typescript
 * simple.HelmChart('redis', 'https://charts.bitnami.com/bitnami', 'redis', {
 *   auth: { enabled: false },
 *   replica: { replicaCount: 3 }
 * })
 * ```
 *
 * @example
 * With TypeKro schema references:
 * ```typescript
 * simple.HelmChart('database', 'https://charts.bitnami.com/bitnami', 'postgresql', {
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
 * simple.HelmChart('app', 'https://charts.example.com', 'my-app', {
 *   config: {
 *     configMapName: configMap.metadata.name,
 *     replicas: schema.spec.replicas
 *   }
 * })
 * ```
 */
/**
 * @deprecated Use simple.HelmChart() instead - import { simple } from 'typekro'; simple.HelmChart(...)
 */
export function simpleHelmChart(
  name: string,
  repository: string,
  chart: string,
  values?: TypeKroValueTreeObject
): Enhanced<HelmReleaseSpec, HelmReleaseStatus> {
  getComponentLogger('helm-release').warn(
    "simpleHelmChart() is deprecated. Use simple.HelmChart() instead — import { simple } from 'typekro'"
  );
  return helmRelease({
    name,
    chart: { repository, name: chart },
    ...(values && { values }),
  });
}
