import { type } from 'arktype';
import type { TypeKroChartValue, TypeKroValue } from '../../core/types/common.js';
import type { HelmReleaseValuesFromSource } from '../helm/types.js';

const kubernetesName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 40');
const kubernetesDnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');
const kubernetesPort = type('number.integer >= 1').and('number <= 65535');

export const EnvoyAIGatewayPlatformInstallationSpecSchema = type({
  name: kubernetesName,
  'envoyGatewayNamespace?': kubernetesDnsLabel,
  'aiGatewayNamespace?': kubernetesDnsLabel,
  'envoyGatewayVersion?': 'string > 0',
  'aiGatewayVersion?': 'string > 0',
  'repositoryName?': kubernetesDnsLabel,
  'repositoryNamespace?': kubernetesDnsLabel,
  'gatewayClassName?': kubernetesDnsLabel,
  'configurationDigest?': 'string > 0',
});

export type EnvoyAIGatewayPlatformInstallationSpec =
  typeof EnvoyAIGatewayPlatformInstallationSpecSchema.infer;

export const EnvoyAIGatewayPlatformReferenceSpecSchema = type({
  name: kubernetesName,
});

export type EnvoyAIGatewayPlatformReferenceSpec =
  typeof EnvoyAIGatewayPlatformReferenceSpecSchema.infer;

export const EnvoyAIGatewayPlatformStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  envoyGatewayVersion: 'string',
  aiGatewayVersion: 'string',
  gatewayClassName: 'string',
  controllerService: 'string',
});

export type EnvoyAIGatewayPlatformStatus = typeof EnvoyAIGatewayPlatformStatusSchema.infer;

export const EnvoyProxyHelmRepositorySingletonSpecSchema = type({
  name: kubernetesDnsLabel,
  namespace: kubernetesDnsLabel,
  url: 'string > 0',
});

export const EnvoyProxyHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

export interface EnvoyAIGatewayPlatformBuildOptions {
  readonly name?: string;
  readonly envoyGatewayNamespace?: string;
  readonly aiGatewayNamespace?: string;
  readonly envoyGatewayVersion?: string;
  readonly aiGatewayVersion?: string;
  readonly repositoryName?: string;
  readonly repositoryNamespace?: string;
  readonly gatewayClassName?: string;
  /** Envoy Gateway global rate-limit service Redis endpoint, without a URL scheme. */
  readonly rateLimitRedisUrl?: string;
  /**
   * Secret-backed Envoy AI Gateway MCP session-encryption seed.
   *
   * The Secret must exist in the AI Gateway controller namespace. Production
   * profiles require this source so the upstream known default can never be
   * used accidentally.
   */
  readonly mcpSessionEncryptionSeedSecret?: {
    readonly name: string;
    /** Key containing an unpadded base64url seed. @default 'seed' */
    readonly key?: string;
  };
  /** Concrete build-time values merged before protected compatibility pins. */
  readonly envoyGatewayValues?: Record<string, unknown>;
  /** Concrete build-time values merged before protected compatibility pins. */
  readonly aiGatewayValues?: Record<string, unknown>;
  /** @default 'production' */
  readonly profile?: 'development' | 'production';
}

export interface EnvoyGatewayHelmReleaseConfig {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  readonly repositoryName: string;
  readonly repositoryNamespace: string;
  readonly values: TypeKroChartValue<Record<string, unknown>>;
  readonly valuesFrom?: TypeKroValue<HelmReleaseValuesFromSource>[];
  readonly id?: string;
}

export interface EnvoyAIProviderSecretRef {
  readonly name: string;
  readonly namespace?: string;
}

export type EnvoyAIProvider =
  | {
      readonly name: string;
      readonly kind: 'openai';
      readonly hostname?: string;
      readonly port?: number;
      readonly tls?: boolean;
      readonly prefix?: string;
      readonly credential: EnvoyAIProviderSecretRef;
    }
  | {
      readonly name: string;
      readonly kind: 'anthropic';
      readonly hostname?: string;
      readonly port?: number;
      readonly tls?: boolean;
      readonly credential: EnvoyAIProviderSecretRef;
    }
  | {
      readonly name: string;
      readonly kind: 'aws-bedrock';
      readonly region: string;
      readonly api?: 'bedrock' | 'anthropic';
      readonly credential?:
        | {
            readonly source: 'secret';
            readonly secret: EnvoyAIProviderSecretRef;
            readonly profile?: string;
          }
        | {
            readonly source: 'workload-identity';
          };
    }
  | {
      readonly name: string;
      readonly kind: 'openai-compatible';
      readonly hostname: string;
      readonly port?: number;
      readonly tls?: boolean;
      readonly prefix?: string;
      readonly credential?: EnvoyAIProviderSecretRef;
    };

export interface EnvoyAIModelTarget {
  readonly provider: string;
  readonly model?: string;
  /** Weighted balancing within one priority. @default 1 */
  readonly weight?: number;
  /** Lower values are attempted first. @default 0 */
  readonly priority?: number;
}

export interface EnvoyAIModelRoute {
  readonly model: string;
  readonly targets: readonly EnvoyAIModelTarget[];
  /** Gateway API duration. @default '60s' */
  readonly requestTimeout?: string;
  readonly modelsOwnedBy?: string;
}

export interface EnvoyAIRetryPolicy {
  /** @default 1 */
  readonly attemptsPerPriority?: number;
  /** @default provider count */
  readonly retries?: number;
  /** @default '30s' */
  readonly perRetryTimeout?: string;
  readonly retryStatusCodes?: readonly number[];
  readonly triggers?: readonly (
    | 'connect-failure'
    | 'retriable-status-codes'
    | 'reset'
    | 'reset-before-request'
  )[];
}

export type EnvoyAILLMRequestCostType =
  | 'InputToken'
  | 'OutputToken'
  | 'TotalToken'
  | 'CachedInputToken'
  | 'CacheCreationInputToken'
  | 'ReasoningToken';

export type EnvoyAILLMRequestCost =
  | {
      readonly metadataKey: string;
      readonly type: EnvoyAILLMRequestCostType;
    }
  | {
      readonly metadataKey: string;
      readonly type: 'CEL';
      readonly cel: string;
    };

export type EnvoyAIRateLimitUnit = 'Second' | 'Minute' | 'Hour' | 'Day';

export type EnvoyAITokenCost =
  | 'input-tokens'
  | 'output-tokens'
  | 'total-tokens'
  | 'cached-input-tokens'
  | 'cache-creation-input-tokens'
  | 'reasoning-tokens';

export interface EnvoyAIRateLimitRule {
  /** Distinct budget key. Omit for a gateway-wide shared budget. */
  readonly identityHeader?: string;
  readonly requests: number;
  readonly unit: EnvoyAIRateLimitUnit;
  /** @default 'total-tokens' */
  readonly cost?: EnvoyAITokenCost | 'request';
}

export interface EnvoyAIRateLimit {
  /** Envoy Gateway rate-limit service Redis endpoint, without a URL scheme. */
  readonly redisUrl: string;
  readonly rules: readonly EnvoyAIRateLimitRule[];
}

export interface EnvoyAIGatewayTelemetry {
  readonly environment?: Readonly<Record<string, string>>;
  readonly resources?: {
    readonly requests?: Readonly<Record<string, string>>;
    readonly limits?: Readonly<Record<string, string>>;
  };
}

export interface EnvoyAIGatewayBuildOptions {
  readonly providers: readonly EnvoyAIProvider[];
  readonly models: readonly EnvoyAIModelRoute[];
  readonly retry?: EnvoyAIRetryPolicy | false;
  readonly rateLimit?: EnvoyAIRateLimit | false;
  /** Defaults capture the common provider token-usage dimensions. */
  readonly requestCosts?: readonly EnvoyAILLMRequestCost[];
  readonly telemetry?: EnvoyAIGatewayTelemetry;
  readonly platform?: EnvoyAIGatewayPlatformBuildOptions;
  /** @default 'production' */
  readonly profile?: 'development' | 'production';
}

export const EnvoyAIGatewaySpecSchema = type({
  name: kubernetesName,
  namespace: kubernetesDnsLabel,
  'lifecycle?': '"owned" | "external"',
  'listenerPort?': kubernetesPort,
});

export type EnvoyAIGatewaySpec = typeof EnvoyAIGatewaySpecSchema.infer;

export const EnvoyAIGatewayStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  endpoint: 'string',
  gatewayClassName: 'string',
  providerCount: 'number.integer >= 0',
  acceptedProviderCount: 'number.integer >= 0',
  routeAccepted: 'boolean',
  gatewayProgrammed: 'boolean',
  aiGatewayVersion: 'string',
});

export type EnvoyAIGatewayStatus = typeof EnvoyAIGatewayStatusSchema.infer;

export interface KubernetesCondition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly observedGeneration?: number;
}

export interface AcceptedResourceStatus {
  readonly conditions?: readonly KubernetesCondition[];
}

export interface GatewayObservedStatus {
  readonly addresses?: readonly {
    readonly type?: string;
    readonly value: string;
  }[];
  readonly conditions?: readonly KubernetesCondition[];
}

export interface GatewayPolicyObservedStatus {
  readonly ancestors?: readonly {
    readonly controllerName?: string;
    readonly conditions?: readonly KubernetesCondition[];
  }[];
}

export interface GatewayConfigSpec {
  readonly extProc?: {
    readonly kubernetes?: {
      readonly env?: readonly {
        readonly name: string;
        readonly value: string;
      }[];
      readonly resources?: {
        readonly requests?: Readonly<Record<string, string>>;
        readonly limits?: Readonly<Record<string, string>>;
      };
    };
  };
  readonly globalLLMRequestCosts?: readonly EnvoyAILLMRequestCost[];
}

export interface GatewayClassSpec {
  readonly controllerName: 'gateway.envoyproxy.io/gatewayclass-controller';
}

export interface GatewaySpec {
  readonly gatewayClassName: string;
  readonly listeners: readonly {
    readonly name: string;
    readonly protocol: 'HTTP' | 'HTTPS';
    readonly port: number;
  }[];
}

export interface EnvoyBackendSpec {
  readonly endpoints: readonly {
    readonly fqdn: {
      readonly hostname: string;
      readonly port: number;
    };
  }[];
}

export type EnvoyAIBackendSchema = 'OpenAI' | 'Anthropic' | 'AWSBedrock' | 'AWSAnthropic';

export interface AIServiceBackendSpec {
  readonly schema: {
    readonly name: EnvoyAIBackendSchema;
    readonly prefix?: string;
  };
  readonly backendRef: {
    readonly name: string;
    readonly kind: 'Backend';
    readonly group: 'gateway.envoyproxy.io';
  };
}

export type BackendSecurityPolicySpec =
  | {
      readonly targetRefs: readonly [
        {
          readonly group: 'aigateway.envoyproxy.io';
          readonly kind: 'AIServiceBackend';
          readonly name: string;
        },
      ];
      readonly type: 'APIKey';
      readonly apiKey: { readonly secretRef: EnvoyAIProviderSecretRef };
    }
  | {
      readonly targetRefs: readonly [
        {
          readonly group: 'aigateway.envoyproxy.io';
          readonly kind: 'AIServiceBackend';
          readonly name: string;
        },
      ];
      readonly type: 'AnthropicAPIKey';
      readonly anthropicAPIKey: { readonly secretRef: EnvoyAIProviderSecretRef };
    }
  | {
      readonly targetRefs: readonly [
        {
          readonly group: 'aigateway.envoyproxy.io';
          readonly kind: 'AIServiceBackend';
          readonly name: string;
        },
      ];
      readonly type: 'AWSCredentials';
      readonly awsCredentials: {
        readonly region: string;
        readonly credentialsFile?: {
          readonly secretRef: EnvoyAIProviderSecretRef;
          readonly profile: string;
        };
      };
    };

export interface BackendTLSPolicySpec {
  readonly targetRefs: readonly [
    {
      readonly group: 'gateway.envoyproxy.io';
      readonly kind: 'Backend';
      readonly name: string;
    },
  ];
  readonly validation: {
    readonly wellKnownCACertificates: 'System';
    readonly hostname: string;
  };
}

export interface AIGatewayRouteSpec {
  readonly parentRefs: readonly [
    {
      readonly name: string;
      readonly kind: 'Gateway';
      readonly group: 'gateway.networking.k8s.io';
    },
  ];
  readonly rules: readonly {
    readonly matches: readonly [
      {
        readonly headers: readonly [
          {
            readonly type: 'Exact';
            readonly name: 'x-ai-eg-model';
            readonly value: string;
          },
        ];
      },
    ];
    readonly backendRefs: readonly {
      readonly name: string;
      readonly modelNameOverride?: string;
      readonly weight?: number;
      readonly priority?: number;
    }[];
    readonly timeouts?: {
      readonly request?: string;
    };
    readonly modelsOwnedBy?: string;
  }[];
  readonly llmRequestCosts?: readonly EnvoyAILLMRequestCost[];
}

export interface BackendTrafficPolicySpec {
  readonly targetRefs: readonly [
    {
      readonly group: 'gateway.networking.k8s.io';
      readonly kind: 'HTTPRoute' | 'Gateway';
      readonly name: string;
    },
  ];
  readonly retry?: {
    readonly numAttemptsPerPriority: number;
    readonly numRetries: number;
    readonly perRetry: {
      readonly timeout: string;
      readonly backOff: {
        readonly baseInterval: string;
        readonly maxInterval: string;
      };
    };
    readonly retryOn: {
      readonly httpStatusCodes: readonly number[];
      readonly triggers: readonly string[];
    };
  };
  readonly rateLimit?: {
    readonly type: 'Global';
    readonly global: {
      readonly rules: readonly {
        readonly clientSelectors?: readonly {
          readonly headers: readonly {
            readonly name: string;
            readonly type: 'Distinct';
          }[];
        }[];
        readonly limit: {
          readonly requests: number;
          readonly unit: EnvoyAIRateLimitUnit;
        };
        readonly cost?: {
          readonly request: {
            readonly from: 'Number';
            readonly number: number;
          };
          readonly response: {
            readonly from: 'Metadata';
            readonly metadata: {
              readonly namespace: 'io.envoy.ai_gateway';
              readonly key: string;
            };
          };
        };
      }[];
    };
  };
}

export interface MCPRouteSpec {
  readonly parentRefs: readonly {
    readonly name: string;
    readonly kind: 'Gateway';
    readonly group: 'gateway.networking.k8s.io';
  }[];
  readonly path?: string;
  readonly headers?: readonly {
    readonly name: string;
    readonly type: 'Exact' | 'RegularExpression';
    readonly value: string;
  }[];
  readonly backendRefs: readonly {
    readonly name: string;
    readonly group: 'gateway.envoyproxy.io';
    readonly kind: 'Backend';
    readonly path?: string;
    readonly toolSelector?: {
      readonly include?: readonly string[];
      readonly includeRegex?: readonly string[];
      readonly exclude?: readonly string[];
      readonly excludeRegex?: readonly string[];
    };
    readonly securityPolicy?: {
      readonly apiKey: {
        readonly secretRef: EnvoyAIProviderSecretRef;
        readonly header?: string;
        readonly queryParam?: string;
      };
    };
    readonly forwardHeaders?: readonly {
      readonly name: string;
      readonly backendHeader?: string;
    }[];
  }[];
}
