/**
 * Upstream Gateway API resource factories.
 *
 * Vendor-neutral by design: the only implementation-specific input is the
 * `GatewayClass.spec.controllerName` a caller supplies. Envoy AI Gateway and
 * Traefik both build on these (#176).
 */

import { createAlwaysReadyEvaluator } from '../../../core/readiness/evaluator-factories.js';
import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import {
  GATEWAY_API_REFERENCE_GRANT_VERSION,
  GATEWAY_API_TLS_POLICY_VERSION,
  GATEWAY_API_VERSION,
} from '../constants.js';
import {
  createGatewayApiPolicyReadinessEvaluator,
  gatewayApiGatewayClassReadinessEvaluator,
  gatewayApiGatewayReadinessEvaluator,
  gatewayApiRouteReadinessEvaluator,
} from '../readiness.js';
import type {
  AcceptedResourceStatus,
  BackendTLSPolicySpec,
  GatewayClassSpec,
  GatewayObservedStatus,
  GatewayPolicyObservedStatus,
  GatewaySpec,
  GRPCRouteSpec,
  HTTPRouteSpec,
  ReferenceGrantSpec,
  RouteObservedStatus,
} from '../types.js';

/** Configuration for a namespaced Gateway API resource. */
export interface GatewayApiNamespacedResourceConfig<TSpec extends object> {
  readonly name: string;
  readonly namespace: string;
  readonly spec: TSpec;
  /** Extra labels merged onto `metadata.labels`. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Extra annotations merged onto `metadata.annotations`. */
  readonly annotations?: Readonly<Record<string, string>>;
  /** Resource graph id. Required when `name` is a schema reference. */
  readonly id?: string;
}

/** Configuration for a cluster-scoped Gateway API resource. */
export interface GatewayApiClusterResourceConfig<TSpec extends object> {
  readonly name: string;
  readonly spec: TSpec;
  /** Extra labels merged onto `metadata.labels`. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Extra annotations merged onto `metadata.annotations`. */
  readonly annotations?: Readonly<Record<string, string>>;
  /** Resource graph id. Required when `name` is a schema reference. */
  readonly id?: string;
}

function namespacedDefinition<TSpec extends object>(
  apiVersion: string,
  kind: string,
  config: GatewayApiNamespacedResourceConfig<TSpec>
) {
  return {
    apiVersion,
    kind,
    metadata: {
      name: config.name,
      namespace: config.namespace,
      ...(config.labels ? { labels: { ...config.labels } } : {}),
      ...(config.annotations ? { annotations: { ...config.annotations } } : {}),
    },
    spec: config.spec,
    ...(config.id ? { id: config.id } : {}),
  };
}

/**
 * Create a cluster-scoped Gateway API `GatewayClass`.
 *
 * Ready once the controller named by `spec.controllerName` reports
 * `Accepted=True` for the current generation.
 *
 * @example
 * ```typescript
 * gatewayClass({
 *   name: 'traefik',
 *   spec: { controllerName: 'traefik.io/gateway-controller' },
 * });
 * ```
 */
export function gatewayClass<TController extends string = string>(
  config: GatewayApiClusterResourceConfig<GatewayClassSpec<TController>>
): Enhanced<GatewayClassSpec<TController>, AcceptedResourceStatus> {
  return createResource<GatewayClassSpec<TController>, AcceptedResourceStatus>(
    {
      apiVersion: GATEWAY_API_VERSION,
      kind: 'GatewayClass',
      metadata: {
        name: config.name,
        ...(config.labels ? { labels: { ...config.labels } } : {}),
        ...(config.annotations ? { annotations: { ...config.annotations } } : {}),
      },
      spec: config.spec,
      ...(config.id ? { id: config.id } : {}),
    },
    { scope: 'cluster' }
  ).withReadinessEvaluator(gatewayApiGatewayClassReadinessEvaluator);
}

/**
 * Create a Gateway API `Gateway`.
 *
 * Ready once the controller reports both `Accepted=True` and `Programmed=True`
 * for the current generation.
 */
export function gateway(
  config: GatewayApiNamespacedResourceConfig<GatewaySpec>
): Enhanced<GatewaySpec, GatewayObservedStatus> {
  return createResource<GatewaySpec, GatewayObservedStatus>(
    namespacedDefinition(GATEWAY_API_VERSION, 'Gateway', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(gatewayApiGatewayReadinessEvaluator);
}

/**
 * Create a Gateway API `HTTPRoute`.
 *
 * Ready once at least one claimed parent reports `Accepted=True` and no parent
 * reports `ResolvedRefs=False`.
 */
export function httpRoute(
  config: GatewayApiNamespacedResourceConfig<HTTPRouteSpec>
): Enhanced<HTTPRouteSpec, RouteObservedStatus> {
  return createResource<HTTPRouteSpec, RouteObservedStatus>(
    namespacedDefinition(GATEWAY_API_VERSION, 'HTTPRoute', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(gatewayApiRouteReadinessEvaluator);
}

/**
 * Create a Gateway API `GRPCRoute`.
 *
 * Shares the route readiness contract with {@link httpRoute}.
 */
export function grpcRoute(
  config: GatewayApiNamespacedResourceConfig<GRPCRouteSpec>
): Enhanced<GRPCRouteSpec, RouteObservedStatus> {
  return createResource<GRPCRouteSpec, RouteObservedStatus>(
    namespacedDefinition(GATEWAY_API_VERSION, 'GRPCRoute', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(gatewayApiRouteReadinessEvaluator);
}

/**
 * Create a Gateway API `ReferenceGrant`.
 *
 * `ReferenceGrant` carries no `status` subresource — it is pure authorization
 * data consumed by controllers — so it is registered as always-ready rather
 * than waiting forever for conditions that will never appear.
 */
export function referenceGrant(
  config: GatewayApiNamespacedResourceConfig<ReferenceGrantSpec>
): Enhanced<ReferenceGrantSpec, Record<string, never>> {
  return createResource<ReferenceGrantSpec, Record<string, never>>(
    namespacedDefinition(GATEWAY_API_REFERENCE_GRANT_VERSION, 'ReferenceGrant', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(createAlwaysReadyEvaluator('ReferenceGrant'));
}

/** Configuration for {@link backendTLSPolicy}. */
export interface BackendTLSPolicyConfig
  extends GatewayApiNamespacedResourceConfig<BackendTLSPolicySpec> {
  /**
   * The `GatewayClass.spec.controllerName` whose ancestor conditions decide
   * readiness. A cluster can run several Gateway API controllers, and each one
   * publishes its own ancestor entry.
   */
  readonly controllerName: string;
}

/**
 * Create a Gateway API `BackendTLSPolicy`.
 *
 * Ready once the ancestor entry belonging to `controllerName` reports
 * `Accepted=True`; an explicit `Accepted=False` / `ResolvedRefs=False` is
 * terminal because a rejected policy will not self-heal.
 */
export function backendTLSPolicy(
  config: BackendTLSPolicyConfig
): Enhanced<BackendTLSPolicySpec, GatewayPolicyObservedStatus> {
  return createResource<BackendTLSPolicySpec, GatewayPolicyObservedStatus>(
    namespacedDefinition(GATEWAY_API_TLS_POLICY_VERSION, 'BackendTLSPolicy', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(createGatewayApiPolicyReadinessEvaluator(config.controllerName));
}
