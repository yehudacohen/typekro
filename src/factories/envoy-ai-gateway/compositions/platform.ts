import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { singletonSpecFingerprintAnnotationValue } from '../../../core/deployment/singleton-owner-drift.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton, stableSerialize } from '../../../core/singleton/singleton.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_ENVOY_AI_GATEWAY_CLASS_NAME,
  DEFAULT_ENVOY_AI_GATEWAY_CONTROLLER_SERVICE,
  DEFAULT_ENVOY_AI_GATEWAY_NAMESPACE,
  DEFAULT_ENVOY_AI_GATEWAY_VERSION,
  DEFAULT_ENVOY_GATEWAY_NAMESPACE,
  DEFAULT_ENVOY_GATEWAY_VERSION,
  DEFAULT_ENVOY_PROXY_REPOSITORY_NAME,
  DEFAULT_ENVOY_PROXY_REPOSITORY_URL,
} from '../constants.js';
import { envoyGatewayClass } from '../resources/gateway.js';
import {
  envoyAIGatewayControllerHelmRelease,
  envoyAIGatewayCrdsHelmRelease,
  envoyGatewayHelmRelease,
} from '../resources/helm.js';
import {
  type EnvoyAIGatewayPlatformBuildOptions,
  type EnvoyAIGatewayPlatformInstallationSpec,
  EnvoyAIGatewayPlatformInstallationSpecSchema,
  type EnvoyAIGatewayPlatformReferenceSpec,
  EnvoyAIGatewayPlatformReferenceSpecSchema,
  EnvoyAIGatewayPlatformStatusSchema,
} from '../types.js';
import { envoyProxyHelmRepositoryBootstrap } from './repository.js';

/**
 * Build the explicit platform owner. Build-time options customize concrete
 * chart values; deploy-time spec controls identity and pinned versions.
 */
export function makeEnvoyAIGatewayPlatformInstallation(
  options: EnvoyAIGatewayPlatformBuildOptions = {}
) {
  const profile = options.profile ?? 'production';
  const mcpSessionEncryptionSeedSecret = validateMcpSessionEncryptionSeedSecret(options, profile);
  return kubernetesComposition(
    {
      name: 'envoy-ai-gateway-platform-installation',
      kind: 'EnvoyAIGatewayPlatformInstallation',
      spec: EnvoyAIGatewayPlatformInstallationSpecSchema,
      status: EnvoyAIGatewayPlatformStatusSchema,
    },
    (spec: EnvoyAIGatewayPlatformInstallationSpec) => {
      const graphMode = isKubernetesRef(spec.name);
      const envoyGatewayNamespace = defaultString(
        spec.envoyGatewayNamespace,
        DEFAULT_ENVOY_GATEWAY_NAMESPACE
      );
      const aiGatewayNamespace = defaultString(
        spec.aiGatewayNamespace,
        DEFAULT_ENVOY_AI_GATEWAY_NAMESPACE
      );
      const envoyGatewayVersion = defaultString(
        spec.envoyGatewayVersion,
        DEFAULT_ENVOY_GATEWAY_VERSION
      );
      const aiGatewayVersion = defaultString(
        spec.aiGatewayVersion,
        DEFAULT_ENVOY_AI_GATEWAY_VERSION
      );
      const repositoryName = defaultString(
        spec.repositoryName,
        DEFAULT_ENVOY_PROXY_REPOSITORY_NAME
      );
      const repositoryNamespace = defaultString(spec.repositoryNamespace, DEFAULT_FLUX_NAMESPACE);
      const rateLimitRedisUrl = options.rateLimitRedisUrl;
      const defaultNamespaceOwnership = options.namespaceOwnership ?? 'owned';
      const ownsNamespaces = graphMode
        ? Cel.expr<boolean>(
            `has(schema.spec.namespaceOwnership) ? ` +
              `schema.spec.namespaceOwnership == "owned" : ` +
              `${defaultNamespaceOwnership === 'owned'}`
          )
        : (spec.namespaceOwnership ?? defaultNamespaceOwnership) !== 'external';

      namespace({
        metadata: {
          name: envoyGatewayNamespace,
          labels: platformLabels('envoy-gateway'),
        },
        id: 'envoyGatewayNamespace',
      }).withIncludeWhen(ownsNamespaces);
      namespace({
        metadata: {
          name: aiGatewayNamespace,
          labels: platformLabels('envoy-ai-gateway'),
        },
        id: 'aiGatewayNamespace',
      }).withIncludeWhen(ownsNamespaces);
      configMap({
        metadata: {
          name: `${spec.name}-platform-contract`,
          namespace: aiGatewayNamespace,
          labels: platformLabels('contract'),
        },
        data: {
          gatewayClassName: defaultString(
            spec.gatewayClassName,
            DEFAULT_ENVOY_AI_GATEWAY_CLASS_NAME
          ),
        },
        id: 'platformContract',
      });
      const repository = singleton(envoyProxyHelmRepositoryBootstrap, {
        id: 'envoyproxy-helm',
        spec: {
          name: repositoryName,
          namespace: repositoryNamespace,
          url: DEFAULT_ENVOY_PROXY_REPOSITORY_URL,
        },
      });

      const envoyRelease = envoyGatewayHelmRelease({
        name: 'envoy-gateway',
        namespace: envoyGatewayNamespace,
        version: envoyGatewayVersion,
        repositoryName,
        repositoryNamespace,
        values: protectedEnvoyGatewayValues(
          aiGatewayNamespace,
          profile,
          options.envoyGatewayValues,
          rateLimitRedisUrl
        ),
        id: 'envoyGatewayRelease',
      });
      const crdsRelease = envoyAIGatewayCrdsHelmRelease({
        name: 'envoy-ai-gateway-crds',
        namespace: aiGatewayNamespace,
        version: aiGatewayVersion,
        repositoryName,
        repositoryNamespace,
        values: {},
        id: 'aiGatewayCrdsRelease',
      });
      const controllerRelease = envoyAIGatewayControllerHelmRelease({
        name: 'envoy-ai-gateway',
        namespace: aiGatewayNamespace,
        version: aiGatewayVersion,
        repositoryName,
        repositoryNamespace,
        values: protectedAIGatewayValues(envoyGatewayNamespace, profile, options.aiGatewayValues),
        ...(mcpSessionEncryptionSeedSecret
          ? {
              valuesFrom: [
                {
                  kind: 'Secret' as const,
                  name: mcpSessionEncryptionSeedSecret.name,
                  valuesKey: mcpSessionEncryptionSeedSecret.key,
                  targetPath: 'controller.mcp.sessionEncryption.seed',
                },
              ],
            }
          : {}),
        id: 'aiGatewayControllerRelease',
      });
      controllerRelease.dependsOn(crdsRelease);
      controllerRelease.dependsOn(envoyRelease);

      const repositoryReady = Cel.expr<boolean>(repository.status.ready);
      const failed = Cel.expr<boolean>(
        `${releaseFailed('envoyGatewayRelease')} || ` +
          `${releaseFailed('aiGatewayCrdsRelease')} || ` +
          `${releaseFailed('aiGatewayControllerRelease')}`
      );
      const ready = Cel.expr<boolean>(
        `(${repositoryReady.expression}) && ` +
          `${releaseReady('envoyGatewayRelease')} && ` +
          `${releaseReady('aiGatewayCrdsRelease')} && ` +
          `${releaseReady('aiGatewayControllerRelease')}`
      );
      return {
        ready,
        failed,
        phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
          `${failed.expression} ? "Failed" : (${ready.expression} ? "Ready" : "Installing")`
        ),
        envoyGatewayVersion: envoyRelease.spec.chart.spec.version,
        aiGatewayVersion: controllerRelease.spec.chart.spec.version,
        gatewayClassName: Cel.expr<string>('platformContract.data.gatewayClassName'),
        controllerService: Cel.expr<string>(
          `"${DEFAULT_ENVOY_AI_GATEWAY_CONTROLLER_SERVICE}." + ` +
            'string(aiGatewayControllerRelease.metadata.namespace) + ".svc.cluster.local"'
        ),
      };
    }
  );
}

/**
 * Explicitly owned installation. Deleting an instance uninstalls the platform;
 * application graphs should consume the singleton bootstrap below.
 */
export const envoyAIGatewayPlatformInstallation = makeEnvoyAIGatewayPlatformInstallation({
  profile: 'development',
});

export function makeEnvoyAIGatewayPlatformBootstrap(
  options: EnvoyAIGatewayPlatformBuildOptions = {}
) {
  const installationGraph = makeEnvoyAIGatewayPlatformInstallation(options);
  const installation: EnvoyAIGatewayPlatformInstallationSpec = {
    name: options.name ?? 'envoy-ai-gateway',
    envoyGatewayNamespace: options.envoyGatewayNamespace ?? DEFAULT_ENVOY_GATEWAY_NAMESPACE,
    aiGatewayNamespace: options.aiGatewayNamespace ?? DEFAULT_ENVOY_AI_GATEWAY_NAMESPACE,
    envoyGatewayVersion: options.envoyGatewayVersion ?? DEFAULT_ENVOY_GATEWAY_VERSION,
    aiGatewayVersion: options.aiGatewayVersion ?? DEFAULT_ENVOY_AI_GATEWAY_VERSION,
    repositoryName: options.repositoryName ?? DEFAULT_ENVOY_PROXY_REPOSITORY_NAME,
    repositoryNamespace: options.repositoryNamespace ?? DEFAULT_FLUX_NAMESPACE,
    namespaceOwnership: options.namespaceOwnership ?? 'owned',
    gatewayClassName: options.gatewayClassName ?? DEFAULT_ENVOY_AI_GATEWAY_CLASS_NAME,
    configurationDigest: platformConfigurationDigest(options),
  };
  return kubernetesComposition(
    {
      name: 'envoy-ai-gateway-platform-bootstrap',
      kind: 'EnvoyAIGatewayPlatformBootstrap',
      spec: EnvoyAIGatewayPlatformReferenceSpecSchema,
      status: EnvoyAIGatewayPlatformStatusSchema,
    },
    (_spec: EnvoyAIGatewayPlatformReferenceSpec) => {
      const owner = singleton(installationGraph, {
        id: 'envoy-ai-gateway-platform',
        spec: installation,
      });
      const gatewayClassName = options.gatewayClassName ?? DEFAULT_ENVOY_AI_GATEWAY_CLASS_NAME;
      const gatewayClass = envoyGatewayClass({
        name: gatewayClassName,
        spec: {
          controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
        },
        id: 'gatewayClass',
      });
      gatewayClass.withIncludeWhen(Cel.expr<boolean>(owner.status.ready));
      const ownerReady = Cel.expr<boolean>(owner.status.ready);
      const ownerFailed = Cel.expr<boolean>(owner.status.failed);
      const gatewayClassReady = Cel.expr<boolean>(
        'gatewayClass.status.conditions.exists(c, c.type == "Accepted" && ' +
          'c.status == "True" && c.observedGeneration == gatewayClass.metadata.generation)'
      );
      const gatewayClassFailed = Cel.expr<boolean>(
        'gatewayClass.status.conditions.exists(c, c.type == "Accepted" && ' +
          'c.status == "False" && c.observedGeneration == gatewayClass.metadata.generation)'
      );
      const failed = Cel.expr<boolean>(
        `(${ownerFailed.expression}) || (${gatewayClassFailed.expression})`
      );
      const ready = Cel.expr<boolean>(
        `(${ownerReady.expression}) && (${gatewayClassReady.expression})`
      );
      return {
        ready,
        failed,
        phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
          `${failed.expression} ? "Failed" : (${ready.expression} ? "Ready" : "Installing")`
        ),
        envoyGatewayVersion: owner.status.envoyGatewayVersion,
        aiGatewayVersion: owner.status.aiGatewayVersion,
        gatewayClassName: Cel.expr<string>('gatewayClass.metadata.name'),
        controllerService: owner.status.controllerService,
      };
    }
  );
}

export const envoyAIGatewayPlatformBootstrap = makeEnvoyAIGatewayPlatformBootstrap({
  profile: 'development',
});

function defaultString(value: string | undefined, fallback: string): string {
  return isKubernetesRef(value) ? (Cel.default(value, fallback) as string) : (value ?? fallback);
}

function protectedEnvoyGatewayValues(
  aiGatewayNamespace: string,
  profile: 'development' | 'production',
  customValues?: Record<string, unknown>,
  rateLimitRedisUrl?: string
): Record<string, unknown> {
  const defaults =
    profile === 'production'
      ? {
          deployment: {
            replicas: 2,
            envoyGateway: {
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
            },
          },
        }
      : {};
  return mergeObjects(mergeObjects(defaults, customValues), {
    config: {
      envoyGateway: {
        gateway: {
          controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
        },
        provider: { type: 'Kubernetes' },
        ...(rateLimitRedisUrl
          ? {
              rateLimit: {
                backend: {
                  type: 'Redis',
                  redis: { url: rateLimitRedisUrl },
                },
              },
            }
          : {}),
        extensionApis: {
          enableEnvoyPatchPolicy: true,
          enableBackend: true,
        },
        extensionManager: {
          hooks: {
            xdsTranslator: {
              translation: {
                listener: { includeAll: true },
                route: { includeAll: true },
                cluster: { includeAll: true },
                secret: { includeAll: true },
              },
              post: ['Translation', 'Cluster', 'Route'],
            },
          },
          service: {
            fqdn: {
              hostname: serviceHostname(aiGatewayNamespace),
              port: 1063,
            },
          },
        },
      },
    },
  });
}

function platformConfigurationDigest(options: EnvoyAIGatewayPlatformBuildOptions): string {
  return singletonSpecFingerprintAnnotationValue(
    stableSerialize({
      profile: options.profile ?? 'production',
      envoyGatewayValues: options.envoyGatewayValues ?? {},
      aiGatewayValues: options.aiGatewayValues ?? {},
      rateLimitRedisUrl: options.rateLimitRedisUrl ?? null,
      namespaceOwnership: options.namespaceOwnership ?? 'owned',
      mcpSessionEncryptionSeedSecret: options.mcpSessionEncryptionSeedSecret ?? null,
    })
  );
}

function protectedAIGatewayValues(
  envoyGatewayNamespace: string,
  profile: 'development' | 'production',
  customValues?: Record<string, unknown>
): Record<string, unknown> {
  const defaults = {
    extProc: {
      enableRedaction: profile === 'production',
    },
    controller: {
      replicaCount: profile === 'production' ? 2 : 1,
      leaderElection: { enabled: true },
      resources:
        profile === 'production'
          ? {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1', memory: '512Mi' },
            }
          : {},
    },
  };
  return mergeObjects(mergeObjects(defaults, customValues), {
    ...(profile === 'production' ? { extProc: { enableRedaction: true } } : {}),
    controller: {
      fullnameOverride: DEFAULT_ENVOY_AI_GATEWAY_CONTROLLER_SERVICE,
    },
    envoyGateway: {
      namespace: envoyGatewayNamespace,
    },
  });
}

function validateMcpSessionEncryptionSeedSecret(
  options: EnvoyAIGatewayPlatformBuildOptions,
  profile: 'development' | 'production'
): { readonly name: string; readonly key: string } | undefined {
  const source = options.mcpSessionEncryptionSeedSecret;
  const configuredSeed = readNestedValue(options.aiGatewayValues, [
    'controller',
    'mcp',
    'sessionEncryption',
    'seed',
  ]);
  if (profile === 'production' && configuredSeed !== undefined) {
    throw new Error(
      'Production Envoy AI Gateway MCP sessionEncryption.seed must come from mcpSessionEncryptionSeedSecret, not inline chart values.'
    );
  }
  if (!source) {
    if (profile === 'production') {
      throw new Error(
        'Production Envoy AI Gateway requires mcpSessionEncryptionSeedSecret so MCP session encryption never uses the upstream known default.'
      );
    }
    return undefined;
  }
  if (
    source.name.length === 0 ||
    source.name.length > 253 ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/u.test(source.name)
  ) {
    throw new Error(
      `Envoy AI Gateway MCP seed Secret name ${JSON.stringify(source.name)} must be a valid Kubernetes object name.`
    );
  }
  const key = source.key ?? 'seed';
  if (key.length === 0 || key.length > 253 || !/^[-._a-zA-Z0-9]+$/u.test(key)) {
    throw new Error(
      'Envoy AI Gateway MCP seed Secret key must be a valid Kubernetes Secret data key.'
    );
  }
  return { name: source.name, key };
}

function readNestedValue(
  value: Record<string, unknown> | undefined,
  path: readonly string[]
): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function mergeObjects(
  base: Record<string, unknown>,
  overlay?: Record<string, unknown>
): Record<string, unknown> {
  const result = cloneObject(base);
  if (!overlay) return result;
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? mergeObjects(current, value)
        : cloneValue(value);
  }
  return result;
}

function cloneObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function cloneValue(value: unknown): unknown {
  if (isCelExpression(value) || isKubernetesRef(value)) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) return cloneObject(value);
  return value;
}

function serviceHostname(namespaceName: string): string {
  if (isCelExpression(namespaceName)) {
    return Cel.expr<string>(
      `"${DEFAULT_ENVOY_AI_GATEWAY_CONTROLLER_SERVICE}." + ` +
        `string(${namespaceName.expression}) + ".svc.cluster.local"`
    ) as string;
  }
  return `${DEFAULT_ENVOY_AI_GATEWAY_CONTROLLER_SERVICE}.${namespaceName}.svc.cluster.local`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !isCelExpression(value) &&
      !isKubernetesRef(value)
  );
}

function platformLabels(component: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'envoy-ai-gateway',
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/managed-by': 'typekro',
  };
}

function releaseReady(resourceId: string): string {
  return (
    `${resourceId}.status.conditions.exists(c, c.type == "Ready" && ` +
    `c.status == "True" && c.observedGeneration == ${resourceId}.metadata.generation)`
  );
}

function releaseFailed(resourceId: string): string {
  return (
    `${resourceId}.status.conditions.exists(c, c.type == "Ready" && ` +
    `c.status == "False" && c.observedGeneration == ${resourceId}.metadata.generation)`
  );
}
