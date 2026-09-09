import { createAlwaysReadyEvaluator } from '../../../core/readiness/evaluator-factories.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Enhanced, ResourceStatus } from '../../../core/types/index.js';
import {
  createGatewayApiPolicyReadinessEvaluator,
  gatewayApiConditionIsCurrent,
  gatewayApiConditionReadiness,
  gatewayApiGatewayReadinessEvaluator,
} from '../../gateway-api/readiness.js';
import { createResource } from '../../shared.js';
import {
  DEFAULT_ENVOY_GATEWAY_CONTROLLER_NAME,
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
  GatewayPolicyObservedStatus,
  GatewaySpec,
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

/**
 * Envoy AI Gateway readiness contracts.
 *
 * The condition-freshness and Accepted/Programmed logic is upstream Gateway API
 * behavior and now lives in `src/factories/gateway-api/readiness.ts` (#176).
 * These wrappers keep the exported names and the original
 * `typekro.readiness.envoy-ai-gateway.*` portable-strategy identifiers so
 * previously serialized plans stay resolvable.
 */
const envoyGatewayPolicyReadiness = createGatewayApiPolicyReadinessEvaluator(
  DEFAULT_ENVOY_GATEWAY_CONTROLLER_NAME
);

/** Ready when the resource reports a current `Accepted=True` and no `NotAccepted=True`. */
export function envoyAIAcceptedReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return gatewayApiConditionReadiness(liveResource, 'Accepted', ['NotAccepted']);
}

/** Ready when Envoy Gateway has claimed the `GatewayClass` (`Accepted=True`). */
export function envoyGatewayClassReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return gatewayApiConditionReadiness(liveResource, 'Accepted', []);
}

/** Ready when the `Gateway` is both `Accepted` and `Programmed` for its current generation. */
export function envoyGatewayReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return gatewayApiGatewayReadinessEvaluator(liveResource);
}

/** Ready when the Envoy Gateway ancestor entry of a policy reports `Accepted=True`. */
export function envoyGatewayPolicyReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return envoyGatewayPolicyReadiness(liveResource);
}

/**
 * Re-exported for callers that inspected Envoy AI Gateway's condition-freshness
 * rule directly. Envoy AI Gateway v0.6 emits Condition-shaped entries without
 * `observedGeneration` on its v1beta1 resources, and the shared helper keeps
 * accepting that documented sparse shape.
 */
export const envoyConditionIsCurrent = gatewayApiConditionIsCurrent;

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
registerPortableReadinessEvaluator(
  'typekro.readiness.envoy-ai-gateway.policy',
  '1',
  envoyGatewayPolicyReadinessEvaluator
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
): Enhanced<BackendTLSPolicySpec, GatewayPolicyObservedStatus> {
  return createResource<BackendTLSPolicySpec, GatewayPolicyObservedStatus>(
    resourceDefinition('BackendTLSPolicy', GATEWAY_API_TLS_POLICY_VERSION, config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(envoyGatewayPolicyReadinessEvaluator);
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
): Enhanced<BackendTrafficPolicySpec, GatewayPolicyObservedStatus> {
  return createResource<BackendTrafficPolicySpec, GatewayPolicyObservedStatus>(
    resourceDefinition('BackendTrafficPolicy', ENVOY_GATEWAY_API_VERSION, config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(envoyGatewayPolicyReadinessEvaluator);
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
