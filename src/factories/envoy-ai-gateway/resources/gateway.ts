import { createAlwaysReadyEvaluator } from '../../../core/readiness/evaluator-factories.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import {
  ENVOY_AI_GATEWAY_API_VERSION,
  ENVOY_GATEWAY_API_VERSION,
  GATEWAY_API_TLS_POLICY_VERSION,
  GATEWAY_API_VERSION,
} from '../constants.js';
import type {
  AcceptedResourceStatus,
  AIGatewayRouteSpec,
  AIServiceBackendSpec,
  BackendSecurityPolicySpec,
  BackendTLSPolicySpec,
  BackendTrafficPolicySpec,
  EnvoyBackendSpec,
  GatewayClassSpec,
  GatewayConfigSpec,
  GatewayObservedStatus,
  GatewaySpec,
  KubernetesCondition,
  MCPRouteSpec,
} from '../types.js';

interface NamespacedResourceConfig<TSpec extends object> {
  readonly name: string;
  readonly namespace: string;
  readonly spec: TSpec;
  readonly id?: string;
}

interface ClusterResourceConfig<TSpec extends object> {
  readonly name: string;
  readonly spec: TSpec;
  readonly id?: string;
}

function conditionReadiness(
  liveResource: unknown,
  acceptedType: string,
  rejectedTypes: readonly string[]
): ResourceStatus {
  const resource = liveResource as
    | {
        readonly metadata?: {
          readonly generation?: number;
        };
        readonly status?: AcceptedResourceStatus;
      }
    | undefined;
  const conditions = resource?.status?.conditions ?? [];
  const generation = resource?.metadata?.generation;
  const rejected = conditions.find(
    (condition) =>
      rejectedTypes.includes(condition.type) &&
      condition.status === 'True' &&
      conditionIsCurrent(condition, generation)
  );
  if (rejected) {
    return {
      ready: false,
      reason: rejected.reason ?? rejected.type,
      message: rejected.message ?? `${rejected.type} is True`,
    };
  }
  const accepted = conditions.find((condition) => condition.type === acceptedType);
  const current = conditionIsCurrent(accepted, generation);
  if (accepted?.status === 'True' && current) {
    return {
      ready: true,
      reason: accepted.reason ?? acceptedType,
      message: accepted.message ?? `${acceptedType} is True`,
    };
  }
  return {
    ready: false,
    reason: accepted?.reason ?? 'Reconciling',
    message:
      accepted?.message ??
      `${acceptedType} has not been observed for the current resource generation`,
  };
}

function conditionIsCurrent(
  condition: KubernetesCondition | undefined,
  generation: number | undefined
): boolean {
  if (generation === undefined) return true;
  // Envoy AI Gateway v0.6 emits Condition-shaped entries without
  // observedGeneration on its v1beta1 resources. Preserve strict freshness
  // whenever the controller supplies it, while accepting the controller's
  // documented sparse condition shape when it cannot.
  return condition?.observedGeneration === undefined || condition.observedGeneration === generation;
}

export function envoyAIAcceptedReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return conditionReadiness(liveResource, 'Accepted', ['NotAccepted']);
}

export function envoyGatewayClassReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return conditionReadiness(liveResource, 'Accepted', []);
}

export function envoyGatewayReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as
    | {
        readonly metadata?: { readonly generation?: number };
        readonly status?: GatewayObservedStatus;
      }
    | undefined;
  const conditions = resource?.status?.conditions ?? [];
  const generation = resource?.metadata?.generation;
  const rejected = conditions.find(
    (condition) =>
      ['Accepted', 'Programmed'].includes(condition.type) &&
      condition.status === 'False' &&
      conditionIsCurrent(condition, generation)
  );
  if (rejected) {
    return {
      ready: false,
      reason: rejected.reason ?? `${rejected.type}False`,
      message: rejected.message ?? `${rejected.type} is False`,
    };
  }
  const accepted = conditions.find((condition) => condition.type === 'Accepted');
  const programmed = conditions.find((condition) => condition.type === 'Programmed');
  const ready =
    accepted?.status === 'True' &&
    programmed?.status === 'True' &&
    conditionIsCurrent(accepted, generation) &&
    conditionIsCurrent(programmed, generation);
  return ready
    ? {
        ready: true,
        reason: 'GatewayProgrammed',
        message: programmed.message ?? 'Gateway is accepted and programmed',
      }
    : {
        ready: false,
        reason: programmed?.reason ?? accepted?.reason ?? 'GatewayProgressing',
        message:
          programmed?.message ??
          accepted?.message ??
          'Gateway is waiting to be accepted and programmed',
      };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.envoy-ai-gateway.accepted',
  '1',
  envoyAIAcceptedReadinessEvaluator
);
registerPortableReadinessEvaluator(
  'typekro.readiness.envoy-ai-gateway.gateway-class',
  '1',
  envoyGatewayClassReadinessEvaluator
);
registerPortableReadinessEvaluator(
  'typekro.readiness.envoy-ai-gateway.gateway',
  '1',
  envoyGatewayReadinessEvaluator
);

export function envoyGatewayClass(
  config: ClusterResourceConfig<GatewayClassSpec>
): Enhanced<GatewayClassSpec, AcceptedResourceStatus> {
  return createResource<GatewayClassSpec, AcceptedResourceStatus>(
    {
      apiVersion: GATEWAY_API_VERSION,
      kind: 'GatewayClass',
      metadata: {
        name: config.name,
        labels: managedLabels(config.name),
      },
      spec: config.spec,
      ...(config.id ? { id: config.id } : {}),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(envoyGatewayClassReadinessEvaluator);
}

export function envoyGatewayConfig(
  config: NamespacedResourceConfig<GatewayConfigSpec>
): Enhanced<GatewayConfigSpec, AcceptedResourceStatus> {
  return acceptedResource('GatewayConfig', ENVOY_AI_GATEWAY_API_VERSION, config);
}

export function envoyGateway(
  config: NamespacedResourceConfig<GatewaySpec>
): Enhanced<GatewaySpec, GatewayObservedStatus> {
  return createResource<GatewaySpec, GatewayObservedStatus>(
    {
      apiVersion: GATEWAY_API_VERSION,
      kind: 'Gateway',
      metadata: {
        name: config.name,
        namespace: config.namespace,
        labels: managedLabels(config.name),
        annotations: {
          'aigateway.envoyproxy.io/gateway-config': config.name,
        },
      },
      spec: config.spec,
      ...(config.id ? { id: config.id } : {}),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(envoyGatewayReadinessEvaluator);
}

export function envoyBackend(
  config: NamespacedResourceConfig<EnvoyBackendSpec>
): Enhanced<EnvoyBackendSpec, Record<string, never>> {
  return createResource<EnvoyBackendSpec, Record<string, never>>(
    resourceDefinition('Backend', ENVOY_GATEWAY_API_VERSION, config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator('Backend'));
}

export function envoyAIServiceBackend(
  config: NamespacedResourceConfig<AIServiceBackendSpec>
): Enhanced<AIServiceBackendSpec, AcceptedResourceStatus> {
  return acceptedResource('AIServiceBackend', ENVOY_AI_GATEWAY_API_VERSION, config);
}

export function envoyBackendSecurityPolicy(
  config: NamespacedResourceConfig<BackendSecurityPolicySpec>
): Enhanced<BackendSecurityPolicySpec, AcceptedResourceStatus> {
  return acceptedResource('BackendSecurityPolicy', ENVOY_AI_GATEWAY_API_VERSION, config);
}

export function envoyBackendTLSPolicy(
  config: NamespacedResourceConfig<BackendTLSPolicySpec>
): Enhanced<BackendTLSPolicySpec, Record<string, never>> {
  return createResource<BackendTLSPolicySpec, Record<string, never>>(
    resourceDefinition('BackendTLSPolicy', GATEWAY_API_TLS_POLICY_VERSION, config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator('BackendTLSPolicy'));
}

export function envoyAIGatewayRoute(
  config: NamespacedResourceConfig<AIGatewayRouteSpec>
): Enhanced<AIGatewayRouteSpec, AcceptedResourceStatus> {
  return acceptedResource('AIGatewayRoute', ENVOY_AI_GATEWAY_API_VERSION, config);
}

export function envoyMCPRoute(
  config: NamespacedResourceConfig<MCPRouteSpec>
): Enhanced<MCPRouteSpec, AcceptedResourceStatus> {
  return acceptedResource('MCPRoute', ENVOY_AI_GATEWAY_API_VERSION, config);
}

export function envoyBackendTrafficPolicy(
  config: NamespacedResourceConfig<BackendTrafficPolicySpec>
): Enhanced<BackendTrafficPolicySpec, Record<string, never>> {
  return createResource<BackendTrafficPolicySpec, Record<string, never>>(
    resourceDefinition('BackendTrafficPolicy', ENVOY_GATEWAY_API_VERSION, config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator('BackendTrafficPolicy'));
}

function acceptedResource<TSpec extends object>(
  kind: string,
  apiVersion: string,
  config: NamespacedResourceConfig<TSpec>
): Enhanced<TSpec, AcceptedResourceStatus> {
  return createResource<TSpec, AcceptedResourceStatus>(
    resourceDefinition(kind, apiVersion, config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(envoyAIAcceptedReadinessEvaluator);
}

function resourceDefinition<TSpec extends object>(
  kind: string,
  apiVersion: string,
  config: NamespacedResourceConfig<TSpec>
) {
  return {
    apiVersion,
    kind,
    metadata: {
      name: config.name,
      namespace: config.namespace,
      labels: managedLabels(config.name),
    },
    spec: config.spec,
    ...(config.id ? { id: config.id } : {}),
  };
}

function managedLabels(instance: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'envoy-ai-gateway',
    'app.kubernetes.io/instance': instance,
    'app.kubernetes.io/managed-by': 'typekro',
  };
}
