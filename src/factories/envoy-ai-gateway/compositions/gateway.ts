import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { setIncludeWhen } from '../../../core/metadata/resource-metadata.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_ENVOY_AI_GATEWAY_CLASS_NAME,
  DEFAULT_ENVOY_AI_GATEWAY_LISTENER_PORT,
  DEFAULT_ENVOY_AI_GATEWAY_VERSION,
} from '../constants.js';
import {
  envoyAIGatewayRoute,
  envoyAIServiceBackend,
  envoyBackend,
  envoyBackendSecurityPolicy,
  envoyBackendTLSPolicy,
  envoyBackendTrafficPolicy,
  envoyGateway,
  envoyGatewayConfig,
} from '../resources/gateway.js';
import type {
  AcceptedResourceStatus,
  EnvoyAIGatewayPlatformBuildOptions,
  BackendSecurityPolicySpec,
  EnvoyAIGatewayBuildOptions,
  EnvoyAIGatewaySpec,
  EnvoyAIGatewayStatus,
  EnvoyAIProvider,
  EnvoyAILLMRequestCost,
  EnvoyAIRateLimit,
  EnvoyAITokenCost,
} from '../types.js';
import {
  EnvoyAIGatewaySpecSchema,
  EnvoyAIGatewayStatusSchema,
} from '../types.js';
import { makeEnvoyAIGatewayPlatformBootstrap } from './platform.js';

interface ResolvedProvider {
  readonly name: string;
  readonly hostname: string;
  readonly port: number;
  readonly tls: boolean;
  readonly schema: 'OpenAI' | 'Anthropic' | 'AWSBedrock' | 'AWSAnthropic';
  readonly prefix?: string;
  readonly security:
    | { readonly type: 'none' }
    | {
        readonly type: 'api-key';
        readonly secretName: string;
        readonly secretNamespace?: string;
      }
    | {
        readonly type: 'anthropic-api-key';
        readonly secretName: string;
        readonly secretNamespace?: string;
      }
    | {
        readonly type: 'aws';
        readonly region: string;
        readonly secretName?: string;
        readonly secretNamespace?: string;
        readonly profile: string;
      };
}

interface ProviderResource {
  readonly name: string;
  readonly status: AcceptedResourceStatus;
  readonly resourceId: string;
}

/**
 * Build one OpenAI-compatible internal gateway over a fixed, type-safe provider
 * and logical-model topology. Provider graph shape is build-time; instance
 * identity, namespace lifecycle, and listener port remain deploy-time values.
 */
export function makeEnvoyAIGateway(
  options: EnvoyAIGatewayBuildOptions,
): CallableComposition<EnvoyAIGatewaySpec, EnvoyAIGatewayStatus> {
  const providers = validateAndResolveProviders(options.providers);
  validateModels(options, providers);
  const rateLimit = validateRateLimit(options.rateLimit);
  const requestCosts = validateRequestCosts(
    options.requestCosts ?? defaultRequestCosts(),
  );
  const platformOptions = platformOptionsForGateway(options.platform, rateLimit);
  const platform = makeEnvoyAIGatewayPlatformBootstrap(platformOptions);
  const profile = options.profile ?? 'production';
  const gatewayClassName =
    platformOptions.gatewayClassName ?? DEFAULT_ENVOY_AI_GATEWAY_CLASS_NAME;
  const aiGatewayVersion =
    platformOptions.aiGatewayVersion ?? DEFAULT_ENVOY_AI_GATEWAY_VERSION;

  return kubernetesComposition(
    {
      name: 'envoy-ai-gateway',
      kind: 'EnvoyAIGateway',
      spec: EnvoyAIGatewaySpecSchema,
      status: EnvoyAIGatewayStatusSchema,
    },
    (spec: EnvoyAIGatewaySpec) => {
      const lifecycle = spec.lifecycle ?? 'owned';
      const listenerPort = spec.listenerPort ?? DEFAULT_ENVOY_AI_GATEWAY_LISTENER_PORT;
      const gatewayNamespace = namespace({
        metadata: {
          name: spec.namespace,
          labels: {
            'app.kubernetes.io/name': 'envoy-ai-gateway',
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
        id: 'gatewayNamespace',
      });
      if (isKubernetesRef(spec.name)) {
        setIncludeWhen(gatewayNamespace, [
          Cel.expr<boolean>(
            '!has(schema.spec.lifecycle) || schema.spec.lifecycle == "owned"',
          ),
        ]);
      } else if (lifecycle === 'external') {
        setIncludeWhen(gatewayNamespace, [false]);
      }
      configMap({
        metadata: {
          name: `${spec.name}-gateway-contract`,
          namespace: spec.namespace,
          labels: {
            'app.kubernetes.io/name': 'envoy-ai-gateway',
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/component': 'contract',
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
        data: {
          gatewayClassName,
          providerCount: String(providers.length),
          aiGatewayVersion,
        },
        id: 'gatewayContract',
      });

      const platformOwner = singleton(platform, {
        id: 'envoy-ai-gateway-platform',
        spec: { name: 'envoy-ai-gateway-platform' },
      });
      const gatewayConfig = envoyGatewayConfig({
        name: spec.name,
        namespace: spec.namespace,
        spec: gatewayConfigSpec(
          options,
          profile,
          aiGatewayVersion,
          requestCosts,
        ),
        id: 'gatewayConfig',
      });

      const gateway = envoyGateway({
        name: spec.name,
        namespace: spec.namespace,
        spec: {
          gatewayClassName,
          listeners: [
            {
              name: 'http',
              protocol: 'HTTP',
              port: listenerPort,
            },
          ],
        },
        id: 'gateway',
      });
      gateway.dependsOn(gatewayConfig);

      const backendResources = new Map<
        string,
        ReturnType<typeof envoyAIServiceBackend>
      >();
      const providerResources: ProviderResource[] = [];
      const readinessResources: ProviderResource[] = [];
      for (const provider of providers) {
        const resourceId = providerResourceId(provider.name);
        const backendName = `${spec.name}-${provider.name}`;
        const backend = envoyBackend({
          name: backendName,
          namespace: spec.namespace,
          spec: {
            endpoints: [
              {
                fqdn: {
                  hostname: provider.hostname,
                  port: provider.port,
                },
              },
            ],
          },
          id: `${resourceId}Backend`,
        });

        const aiBackend = envoyAIServiceBackend({
          name: backendName,
          namespace: spec.namespace,
          spec: {
            schema: {
              name: provider.schema,
              ...(provider.prefix ? { prefix: provider.prefix } : {}),
            },
            backendRef: {
              name: backendName,
              kind: 'Backend',
              group: 'gateway.envoyproxy.io',
            },
          },
          id: `${resourceId}AIServiceBackend`,
        });
        aiBackend.dependsOn(backend);
        backendResources.set(provider.name, aiBackend);
        const providerResource = {
          name: backendName,
          status: aiBackend.status,
          resourceId: `${resourceId}AIServiceBackend`,
        };
        providerResources.push(providerResource);
        readinessResources.push(providerResource);

        const securityPolicy = providerSecurityPolicy(
          provider,
          spec.namespace,
          backendName,
          `${resourceId}SecurityPolicy`,
        );
        if (securityPolicy) {
          securityPolicy.dependsOn(aiBackend);
          readinessResources.push({
            name: backendName,
            status: securityPolicy.status,
            resourceId: `${resourceId}SecurityPolicy`,
          });
        }
        if (provider.tls) {
          const tlsPolicy = envoyBackendTLSPolicy({
            name: backendName,
            namespace: spec.namespace,
            spec: {
              targetRefs: [
                {
                  group: 'gateway.envoyproxy.io',
                  kind: 'Backend',
                  name: backendName,
                },
              ],
              validation: {
                wellKnownCACertificates: 'System',
                hostname: provider.hostname,
              },
            },
            id: `${resourceId}TLSPolicy`,
          });
          tlsPolicy.dependsOn(backend);
        }
      }

      const route = envoyAIGatewayRoute({
        name: spec.name,
        namespace: spec.namespace,
        spec: {
          parentRefs: [
            {
              name: spec.name,
              kind: 'Gateway',
              group: 'gateway.networking.k8s.io',
            },
          ],
          rules: options.models.map((model) => ({
            matches: [
              {
                headers: [
                  {
                    type: 'Exact',
                    name: 'x-ai-eg-model',
                    value: model.model,
                  },
                ],
              },
            ],
            backendRefs: model.targets.map((target) => {
              const backend = backendResources.get(target.provider);
              if (!backend) {
                throw new Error(
                  `Envoy AI Gateway model ${model.model} references unknown provider ${target.provider}.`,
                );
              }
              return {
                name: `${spec.name}-${target.provider}`,
                ...(target.model ? { modelNameOverride: target.model } : {}),
                ...(target.weight !== undefined ? { weight: target.weight } : {}),
                ...(target.priority !== undefined ? { priority: target.priority } : {}),
              };
            }),
            timeouts: {
              request: model.requestTimeout ?? '60s',
            },
            ...(model.modelsOwnedBy ? { modelsOwnedBy: model.modelsOwnedBy } : {}),
          })),
        },
        id: 'route',
      });
      route.dependsOn(gateway);
      for (const backend of backendResources.values()) route.dependsOn(backend);

      if (options.retry !== false) {
        const retry = options.retry ?? {};
        const policy = envoyBackendTrafficPolicy({
          name: spec.name,
          namespace: spec.namespace,
          spec: {
            targetRefs: [
              {
                group: 'gateway.networking.k8s.io',
                kind: 'HTTPRoute',
                name: spec.name,
              },
            ],
            retry: {
              numAttemptsPerPriority: retry.attemptsPerPriority ?? 1,
              numRetries: retry.retries ?? Math.max(1, providers.length),
              perRetry: {
                timeout: retry.perRetryTimeout ?? '30s',
                backOff: {
                  baseInterval: '100ms',
                  maxInterval: '10s',
                },
              },
              retryOn: {
                httpStatusCodes: [...(retry.retryStatusCodes ?? [429, 500, 502, 503, 504])],
                triggers: [
                  ...(retry.triggers ?? [
                    'connect-failure',
                    'retriable-status-codes',
                    'reset',
                  ]),
                ],
              },
            },
          },
          id: 'retryPolicy',
        });
        policy.dependsOn(route);
      }
      if (rateLimit) {
        const policy = envoyBackendTrafficPolicy({
          name: `${spec.name}-rate-limit`,
          namespace: spec.namespace,
          spec: {
            targetRefs: [
              {
                group: 'gateway.networking.k8s.io',
                kind: 'Gateway',
                name: spec.name,
              },
            ],
            rateLimit: {
              type: 'Global',
              global: {
                rules: rateLimit.rules.map((rule) => ({
                  ...(rule.identityHeader
                    ? {
                        clientSelectors: [
                          {
                            headers: [
                              {
                                name: rule.identityHeader,
                                type: 'Distinct',
                              },
                            ],
                          },
                        ],
                      }
                    : {}),
                  limit: {
                    requests: rule.requests,
                    unit: rule.unit,
                  },
                  ...(rule.cost && rule.cost !== 'request'
                    ? {
                        cost: {
                          request: {
                            from: 'Number',
                            number: 0,
                          },
                          response: {
                            from: 'Metadata',
                            metadata: {
                              namespace: 'io.envoy.ai_gateway',
                              key: metadataKeyForTokenCost(rule.cost),
                            },
                          },
                        },
                      }
                    : {}),
                })),
              },
            },
          },
          id: 'rateLimitPolicy',
        });
        policy.dependsOn(gateway);
      }

      const gatewayConfigAccepted = acceptedExpression('gatewayConfig');
      const routeAccepted = acceptedExpression('route');
      const gatewayProgrammed = Cel.expr<boolean>(
        'gateway.status.conditions.exists(c, c.type == "Accepted" && c.status == "True" && ' +
          'c.observedGeneration == gateway.metadata.generation) && ' +
          'gateway.status.conditions.exists(c, c.type == "Programmed" && c.status == "True" && ' +
          'c.observedGeneration == gateway.metadata.generation)',
      );
      const readinessExpressions = readinessResources.map((resource) =>
        acceptedExpressionFor(resource),
      );
      const allProvidersAccepted = Cel.expr<boolean>(
        readinessExpressions.length === 0
          ? 'true'
          : readinessExpressions.map(({ expression }) => `(${expression})`).join(' && '),
      );
      const anyProviderFailed = Cel.expr<boolean>(
        readinessResources.length === 0
          ? 'false'
          : readinessResources
              .map(
                (resource) =>
                  `${resourceIdForStatus(resource)}.status.conditions.exists(c, ` +
                  '((c.type == "NotAccepted" && c.status == "True") || ' +
                  '(c.type == "Accepted" && c.status == "False")))',
              )
              .map((expression) => `(${expression})`)
              .join(' || '),
      );
      const gatewayFailed = Cel.expr<boolean>(
        'gateway.status.conditions.exists(c, ' +
          '(c.type == "Accepted" || c.type == "Programmed") && c.status == "False" && ' +
          'c.observedGeneration == gateway.metadata.generation)',
      );
      const routeFailed = Cel.expr<boolean>(
        'route.status.conditions.exists(c, ' +
          '((c.type == "NotAccepted" && c.status == "True") || ' +
          '(c.type == "Accepted" && c.status == "False")))',
      );
      const platformReady = Cel.expr<boolean>(platformOwner.status.ready);
      const platformFailed = Cel.expr<boolean>(platformOwner.status.failed);
      const failed = Cel.expr<boolean>(
        `(${platformFailed.expression}) || (${gatewayFailed.expression}) || ` +
          `(${routeFailed.expression}) || (${anyProviderFailed.expression})`,
      );
      const ready = Cel.expr<boolean>(
        `(${platformReady.expression}) && (${gatewayConfigAccepted.expression}) && ` +
          `(${gatewayProgrammed.expression}) && (${routeAccepted.expression}) && ` +
          `(${allProvidersAccepted.expression})`,
      );
      const acceptedProviderCount = Cel.expr<number>(
        providerResources
          .map((resource) => acceptedExpressionFor(resource))
          .map(({ expression }) => `(${expression} ? 1 : 0)`)
          .join(' + '),
      );
      return {
        ready,
        failed,
        phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
          `${failed.expression} ? "Failed" : (${ready.expression} ? "Ready" : "Installing")`,
        ),
        endpoint: Cel.expr<string>(
          'has(gateway.status.addresses) && size(gateway.status.addresses) > 0 ? "http://" + ' +
            'string(gateway.status.addresses[0].value) + ":" + ' +
            'string(gateway.spec.listeners[0].port) : ""',
        ),
        gatewayClassName: Cel.expr<string>(
          'gatewayContract.data.gatewayClassName',
        ),
        providerCount: Cel.expr<number>(
          'int(gatewayContract.data.providerCount)',
        ),
        acceptedProviderCount,
        routeAccepted,
        gatewayProgrammed,
        aiGatewayVersion: Cel.expr<string>(
          'gatewayContract.data.aiGatewayVersion',
        ),
      };
    },
  ) as CallableComposition<EnvoyAIGatewaySpec, EnvoyAIGatewayStatus>;
}

function acceptedExpression(resourceId: string): ReturnType<typeof Cel.expr<boolean>> {
  return Cel.expr<boolean>(
    `${resourceId}.status.conditions.exists(c, c.type == "Accepted" && c.status == "True")`,
  );
}

function acceptedExpressionFor(
  resource: ProviderResource,
): ReturnType<typeof Cel.expr<boolean>> {
  return acceptedExpression(resourceIdForStatus(resource));
}

function resourceIdForStatus(resource: ProviderResource): string {
  return resource.resourceId;
}

function providerSecurityPolicy(
  provider: ResolvedProvider,
  namespace: string,
  backendName: string,
  id: string,
) {
  const targetRefs = [
    {
      group: 'aigateway.envoyproxy.io' as const,
      kind: 'AIServiceBackend' as const,
      name: backendName,
    },
  ] as const;
  let spec: BackendSecurityPolicySpec;
  if (provider.security.type === 'none') return undefined;
  if (provider.security.type === 'api-key') {
    spec = {
      targetRefs,
      type: 'APIKey',
      apiKey: {
        secretRef: {
          name: provider.security.secretName,
          namespace: provider.security.secretNamespace ?? namespace,
        },
      },
    };
  } else if (provider.security.type === 'anthropic-api-key') {
    spec = {
      targetRefs,
      type: 'AnthropicAPIKey',
      anthropicAPIKey: {
        secretRef: {
          name: provider.security.secretName,
          namespace: provider.security.secretNamespace ?? namespace,
        },
      },
    };
  } else {
    spec = {
      targetRefs,
      type: 'AWSCredentials',
      awsCredentials: {
        region: provider.security.region,
        ...(provider.security.secretName
          ? {
              credentialsFile: {
                secretRef: {
                  name: provider.security.secretName,
                  namespace: provider.security.secretNamespace ?? namespace,
                },
                profile: provider.security.profile,
              },
            }
          : {}),
      },
    };
  }
  return envoyBackendSecurityPolicy({
    name: backendName,
    namespace,
    spec,
    id,
  });
}

function gatewayConfigSpec(
  options: EnvoyAIGatewayBuildOptions,
  profile: 'development' | 'production',
  platformVersion: string,
  requestCosts: readonly EnvoyAILLMRequestCost[],
) {
  const environment = [
    {
      name: 'TYPEKRO_ENVOY_AI_GATEWAY_VERSION',
      value: platformVersion,
    },
    ...Object.entries(options.telemetry?.environment ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  ];
  return {
    extProc: {
      kubernetes: {
        ...(environment.length > 0 ? { env: environment } : {}),
        resources:
          options.telemetry?.resources ??
          (profile === 'production'
            ? {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '1', memory: '512Mi' },
              }
            : {}),
      },
    },
    globalLLMRequestCosts: requestCosts,
  };
}

function platformOptionsForGateway(
  platform: EnvoyAIGatewayPlatformBuildOptions | undefined,
  rateLimit: EnvoyAIRateLimit | undefined,
): EnvoyAIGatewayPlatformBuildOptions {
  if (
    rateLimit &&
    platform?.rateLimitRedisUrl &&
    platform.rateLimitRedisUrl !== rateLimit.redisUrl
  ) {
    throw new Error(
      'Envoy AI Gateway rateLimit.redisUrl conflicts with platform.rateLimitRedisUrl.',
    );
  }
  return {
    ...platform,
    ...(rateLimit ? { rateLimitRedisUrl: rateLimit.redisUrl } : {}),
  };
}

function defaultRequestCosts(): readonly EnvoyAILLMRequestCost[] {
  return [
    { metadataKey: 'llm_input_token', type: 'InputToken' },
    { metadataKey: 'llm_output_token', type: 'OutputToken' },
    { metadataKey: 'llm_total_token', type: 'TotalToken' },
    { metadataKey: 'llm_cached_input_token', type: 'CachedInputToken' },
    {
      metadataKey: 'llm_cache_creation_input_token',
      type: 'CacheCreationInputToken',
    },
    { metadataKey: 'llm_reasoning_token', type: 'ReasoningToken' },
  ];
}

function validateRequestCosts(
  costs: readonly EnvoyAILLMRequestCost[],
): readonly EnvoyAILLMRequestCost[] {
  if (costs.length > 36) {
    throw new Error('Envoy AI Gateway supports at most 36 request-cost dimensions.');
  }
  const metadataKeys = new Set<string>();
  for (const cost of costs) {
    if (
      cost.metadataKey.length === 0 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(cost.metadataKey)
    ) {
      throw new Error(
        `Envoy AI Gateway request-cost metadata key ${JSON.stringify(cost.metadataKey)} must be a non-empty identifier.`,
      );
    }
    if (metadataKeys.has(cost.metadataKey)) {
      throw new Error(
        `Duplicate Envoy AI Gateway request-cost metadata key ${cost.metadataKey}.`,
      );
    }
    metadataKeys.add(cost.metadataKey);
    if (cost.type === 'CEL' && cost.cel.trim().length === 0) {
      throw new Error(
        `Envoy AI Gateway CEL request cost ${cost.metadataKey} requires a non-empty expression.`,
      );
    }
  }
  return costs.map((cost) => ({ ...cost }));
}

function validateRateLimit(
  rateLimit: EnvoyAIGatewayBuildOptions['rateLimit'],
): EnvoyAIRateLimit | undefined {
  if (!rateLimit) return undefined;
  if (
    rateLimit.redisUrl.trim().length === 0 ||
    rateLimit.redisUrl.includes('://')
  ) {
    throw new Error(
      'Envoy AI Gateway rateLimit.redisUrl must be a non-empty host:port endpoint without a URL scheme.',
    );
  }
  if (rateLimit.rules.length === 0) {
    throw new Error('Envoy AI Gateway rate limiting requires at least one rule.');
  }
  if (rateLimit.rules.length > 64) {
    throw new Error('Envoy AI Gateway supports at most 64 rate-limit rules.');
  }
  for (const rule of rateLimit.rules) {
    if (!Number.isSafeInteger(rule.requests) || rule.requests <= 0) {
      throw new Error(
        'Envoy AI Gateway rate-limit requests must be positive safe integers.',
      );
    }
    if (rule.identityHeader !== undefined && rule.identityHeader.trim().length === 0) {
      throw new Error(
        'Envoy AI Gateway rate-limit identityHeader must be non-empty when supplied.',
      );
    }
  }
  return {
    redisUrl: rateLimit.redisUrl,
    rules: rateLimit.rules.map((rule) => ({ ...rule })),
  };
}

function metadataKeyForTokenCost(cost: EnvoyAITokenCost): string {
  switch (cost) {
    case 'input-tokens':
      return 'llm_input_token';
    case 'output-tokens':
      return 'llm_output_token';
    case 'total-tokens':
      return 'llm_total_token';
    case 'cached-input-tokens':
      return 'llm_cached_input_token';
    case 'cache-creation-input-tokens':
      return 'llm_cache_creation_input_token';
    case 'reasoning-tokens':
      return 'llm_reasoning_token';
  }
}

function validateAndResolveProviders(
  providers: readonly EnvoyAIProvider[],
): readonly ResolvedProvider[] {
  if (providers.length === 0) {
    throw new Error('makeEnvoyAIGateway requires at least one provider.');
  }
  if (providers.length > 32) {
    throw new Error('makeEnvoyAIGateway supports at most 32 providers per gateway.');
  }
  const names = new Set<string>();
  return providers.map((provider) => {
    assertTopologyName('provider', provider.name, 20);
    if (names.has(provider.name)) {
      throw new Error(`Duplicate Envoy AI Gateway provider name ${provider.name}.`);
    }
    names.add(provider.name);
    if (provider.kind === 'openai') {
      return {
        name: provider.name,
        hostname: provider.hostname ?? 'api.openai.com',
        port: provider.port ?? 443,
        tls: provider.tls ?? true,
        schema: 'OpenAI',
        ...(provider.prefix ? { prefix: provider.prefix } : {}),
        security: {
          type: 'api-key',
          secretName: provider.credential.name,
          ...(provider.credential.namespace
            ? { secretNamespace: provider.credential.namespace }
            : {}),
        },
      };
    }
    if (provider.kind === 'anthropic') {
      return {
        name: provider.name,
        hostname: provider.hostname ?? 'api.anthropic.com',
        port: provider.port ?? 443,
        tls: provider.tls ?? true,
        schema: 'Anthropic',
        security: {
          type: 'anthropic-api-key',
          secretName: provider.credential.name,
          ...(provider.credential.namespace
            ? { secretNamespace: provider.credential.namespace }
            : {}),
        },
      };
    }
    if (provider.kind === 'aws-bedrock') {
      if (provider.region.length === 0) {
        throw new Error(`AWS Bedrock provider ${provider.name} requires a non-empty region.`);
      }
      return {
        name: provider.name,
        hostname: `bedrock-runtime.${provider.region}.amazonaws.com`,
        port: 443,
        tls: true,
        schema: provider.api === 'anthropic' ? 'AWSAnthropic' : 'AWSBedrock',
        security:
          provider.credential?.source === 'secret'
            ? {
                type: 'aws',
                region: provider.region,
                secretName: provider.credential.secret.name,
                ...(provider.credential.secret.namespace
                  ? { secretNamespace: provider.credential.secret.namespace }
                  : {}),
                profile: provider.credential.profile ?? 'default',
              }
            : {
                type: 'aws',
                region: provider.region,
                profile: 'default',
              },
      };
    }
    return {
      name: provider.name,
      hostname: provider.hostname,
      port: provider.port ?? (provider.tls === false ? 80 : 443),
      tls: provider.tls ?? true,
      schema: 'OpenAI',
      ...(provider.prefix ? { prefix: provider.prefix } : {}),
      security: provider.credential
        ? {
            type: 'api-key',
            secretName: provider.credential.name,
            ...(provider.credential.namespace
              ? { secretNamespace: provider.credential.namespace }
              : {}),
          }
        : { type: 'none' },
    };
  });
}

function validateModels(
  options: EnvoyAIGatewayBuildOptions,
  providers: readonly ResolvedProvider[],
): void {
  if (options.models.length === 0) {
    throw new Error('makeEnvoyAIGateway requires at least one logical model.');
  }
  if (options.models.length > 128) {
    throw new Error('makeEnvoyAIGateway supports at most 128 logical models.');
  }
  const providerNames = new Set(providers.map(({ name }) => name));
  const modelNames = new Set<string>();
  for (const model of options.models) {
    if (model.model.length === 0) {
      throw new Error('Envoy AI Gateway logical model names must be non-empty.');
    }
    if (modelNames.has(model.model)) {
      throw new Error(`Duplicate Envoy AI Gateway logical model ${model.model}.`);
    }
    modelNames.add(model.model);
    if (model.targets.length === 0) {
      throw new Error(`Envoy AI Gateway model ${model.model} requires at least one target.`);
    }
    for (const target of model.targets) {
      if (!providerNames.has(target.provider)) {
        throw new Error(
          `Envoy AI Gateway model ${model.model} references unknown provider ${target.provider}.`,
        );
      }
      if (
        target.weight !== undefined &&
        (!Number.isSafeInteger(target.weight) || target.weight < 0)
      ) {
        throw new Error(
          `Envoy AI Gateway model ${model.model} target weights must be non-negative integers.`,
        );
      }
      if (
        target.priority !== undefined &&
        (!Number.isSafeInteger(target.priority) || target.priority < 0)
      ) {
        throw new Error(
          `Envoy AI Gateway model ${model.model} target priorities must be non-negative integers.`,
        );
      }
    }
  }
}

function assertTopologyName(label: string, value: string, maximumLength: number): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(value)
  ) {
    throw new Error(
      `Envoy AI Gateway ${label} name ${JSON.stringify(value)} must be a DNS-1123 label no longer than ${maximumLength} characters.`,
    );
  }
}

function providerResourceId(name: string): string {
  return `provider${name
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')}`;
}
