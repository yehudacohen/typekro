import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { getInnerCelPath } from '../../../core/serialization/cel-references.js';
import type { CelExpression } from '../../../core/types/common.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  externalDnsHelmRelease,
  externalDnsHelmRepository,
} from '../resources/helm.js';
import {
  ExternalDnsBootstrapConfigSchema,
  ExternalDnsBootstrapStatusSchema,
  type ExternalDnsHelmValues,
} from '../types.js';

type ExternalDnsHelmValueInput = ExternalDnsHelmValues | CelExpression<Record<string, unknown>>;

function containsDynamicValue(value: unknown): boolean {
  if (isKubernetesRef(value) || isCelExpression(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsDynamicValue);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsDynamicValue);
  }
  return false;
}

function celLiteral(value: unknown): string {
  if (isKubernetesRef(value)) {
    return getInnerCelPath(value);
  }
  if (isCelExpression(value)) {
    return value.expression;
  }
  if (Array.isArray(value)) {
    return `[${value.map(celLiteral).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => `${JSON.stringify(key)}: ${celLiteral(entryValue)}`);
    return `{${entries.join(', ')}}`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return 'null';
}

function celWithDefault(value: unknown, fallback: unknown): string {
  if (value === undefined) {
    return celLiteral(fallback);
  }
  if (isKubernetesRef(value)) {
    const path = getInnerCelPath(value);
    return `has(${path}) ? ${path} : ${celLiteral(fallback)}`;
  }
  if (isCelExpression(value)) {
    return value.expression;
  }
  return celLiteral(value);
}

function awsCredentialsEnv(): NonNullable<ExternalDnsHelmValues['env']> {
  return [
    {
      name: 'AWS_ACCESS_KEY_ID',
      valueFrom: {
        secretKeyRef: {
          name: 'aws-route53-credentials',
          key: 'access-key-id',
        },
      },
    },
    {
      name: 'AWS_SECRET_ACCESS_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'aws-route53-credentials',
          key: 'secret-access-key',
        },
      },
    },
    {
      name: 'AWS_DEFAULT_REGION',
      value: 'us-east-1',
    },
    {
      name: 'AWS_SESSION_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: 'aws-route53-credentials',
          key: 'session-token',
          optional: true,
        },
      },
    },
  ];
}

function buildHelmValues(config: ExternalDnsHelmValues): ExternalDnsHelmValueInput {
  if (!containsDynamicValue(config)) {
    return config;
  }

  const entries = [
    `"provider": ${celLiteral(config.provider)}`,
    `"policy": ${celWithDefault(config.policy, 'upsert-only')}`,
    `"dryRun": ${celWithDefault(config.dryRun, false)}`,
    `"domainFilters": ${celWithDefault(config.domainFilters, [])}`,
  ];

  if (config.txtOwnerId !== undefined) {
    entries.push(`"txtOwnerId": ${celWithDefault(config.txtOwnerId, '')}`);
  }
  if (config.interval !== undefined) {
    entries.push(`"interval": ${celWithDefault(config.interval, '1m')}`);
  }
  if (config.logLevel !== undefined) {
    entries.push(`"logLevel": ${celWithDefault(config.logLevel, 'info')}`);
  }

  if (config.provider === 'aws') {
    entries.push(`"env": ${celLiteral(awsCredentialsEnv())}`);
  } else if (isKubernetesRef(config.provider) || isCelExpression(config.provider)) {
    entries.push(
      `"env": ${celLiteral(config.provider)} == "aws" ? ${celLiteral(awsCredentialsEnv())} : []`
    );
  }

  return Cel.expr<Record<string, unknown>>(`{${entries.join(', ')}}`);
}

/**
 * External-DNS Bootstrap Composition
 *
 * Creates a complete external-dns deployment using HelmRepository and HelmRelease resources.
 * Provides comprehensive configuration options and status expressions derived from actual resource status.
 *
 * Features:
 * - Complete external-dns deployment with DNS provider configuration
 * - Comprehensive configuration schema with ArkType validation
 * - Status expressions using actual resource status fields
 * - Integration endpoints derived from service status
 * - Support for both kro and direct deployment strategies
 *
 * @example
 * ```typescript
 * const externalDnsFactory = externalDnsBootstrap.factory('direct', {
 *   namespace: 'external-dns-system',
 *   waitForReady: true
 * });
 *
 * const instance = await externalDnsFactory.deploy({
 *   name: 'external-dns',
 *   namespace: 'external-dns',
 *   provider: 'aws',
 *   domainFilters: ['example.com'],
 *   policy: 'upsert-only',
 *   dryRun: false
 * });
 * ```
 */
export const externalDnsBootstrap = kubernetesComposition(
  {
    name: 'external-dns-bootstrap',
    // apiVersion defaults to 'v1alpha1' and Kro adds kro.run group automatically
    kind: 'ExternalDnsBootstrap',
    spec: ExternalDnsBootstrapConfigSchema,
    status: ExternalDnsBootstrapStatusSchema,
  },
  (spec) => {
    // Apply default configuration values
    const fullConfig = {
      // Merge with original spec first
      ...spec,
      // Then apply defaults for undefined values
      namespace: spec.namespace || 'external-dns',
      domainFilters: spec.domainFilters || [],
      policy: spec.policy || 'upsert-only',
      dryRun: spec.dryRun !== undefined ? spec.dryRun : false,
      txtOwnerId: spec.txtOwnerId,
      interval: spec.interval,
      logLevel: spec.logLevel,
    };

    // Create namespace for external-dns (required before HelmRelease)
    const _externalDnsNamespace = namespace({
      metadata: {
        name: spec.namespace || 'external-dns',
        labels: {
          'app.kubernetes.io/name': 'external-dns',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/component': 'dns-controller',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'externalDnsNamespace',
    });

    // Create HelmRepository for external-dns charts
    const _helmRepository = externalDnsHelmRepository({
      name: 'external-dns-repo', // Use static name to avoid schema proxy issues
      namespace: DEFAULT_FLUX_NAMESPACE, // HelmRepositories should always be in flux-system
      id: 'externalDnsHelmRepository',
    });

    // Create HelmRelease for external-dns deployment. When any value is dynamic,
    // put one CEL object expression at spec.values instead of nested CEL refs at
    // spec.values.*. Kro can schema-check spec.values but not arbitrary nested
    // Helm chart keys such as spec.values.domainFilters.
    const policy = fullConfig.policy ?? 'upsert-only';
    const dryRun = fullConfig.dryRun ?? false;
    const helmValuesConfig: ExternalDnsHelmValues = {
      provider: fullConfig.provider,
      policy,
      dryRun,
    };

    if (fullConfig.txtOwnerId) {
      helmValuesConfig.txtOwnerId = fullConfig.txtOwnerId;
    }
    if (fullConfig.interval) {
      helmValuesConfig.interval = fullConfig.interval;
    }
    if (fullConfig.logLevel) {
      helmValuesConfig.logLevel = fullConfig.logLevel;
    }

    const isConcreteAwsProvider =
      typeof fullConfig.provider === 'string' && fullConfig.provider === 'aws';
    if (isConcreteAwsProvider) {
      // AWS credentials configuration via environment variables. Other
      // providers need provider-specific credential wiring outside this bootstrap.
      helmValuesConfig.env = awsCredentialsEnv();
    }

    // Only add domainFilters if it's defined and non-empty
    const domainFilters = fullConfig.domainFilters as ExternalDnsHelmValues['domainFilters'] | undefined;
    if (domainFilters !== undefined && (!Array.isArray(domainFilters) || domainFilters.length > 0)) {
      helmValuesConfig.domainFilters = domainFilters;
    }

    const helmValues = buildHelmValues(helmValuesConfig);

    const helmRelease = externalDnsHelmRelease({
      name: spec.name,
      namespace: spec.namespace || 'external-dns',
      repositoryName: 'external-dns-repo', // Match the repository name
      values: helmValues,
      id: 'externalDnsHelmRelease',
    });

    // Return status matching the schema structure
    //
    // DESIGN NOTE: This is a "bootstrap composition" that deploys external-dns via Helm.
    // Readiness is derived from the HelmRelease so nested compositions can
    // propagate a real cross-composition status reference to parent RGDs.
    return {
      ready: Cel.expr<boolean>(
        helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Pending' | 'Installing' | 'Failed' | 'Upgrading'>(
        helmRelease.status.conditions,
        '.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),

      // DNS management status - derived from configuration
      dnsProvider: fullConfig.provider,
      domainFilters: fullConfig.domainFilters,
      policy: fullConfig.policy,
      dryRun: fullConfig.dryRun,

      // Integration endpoints - constructed from known external-dns service naming patterns
      endpoints: {
        metrics: `http://${spec.name}.${spec.namespace || 'external-dns'}.svc.cluster.local:7979/metrics`,
        healthz: `http://${spec.name}.${spec.namespace || 'external-dns'}.svc.cluster.local:7979/healthz`,
      },

      // DNS record management status - static for bootstrap composition
      records: {
        managed: 0,
        total: 0,
        errors: 0,
      },
    };
  }
);
