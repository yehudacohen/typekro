/**
 * Traefik's Gateway API surface.
 *
 * Traefik v3 implements upstream Gateway API, so there is no Traefik-specific
 * copy of `Gateway`/`HTTPRoute`/`GRPCRoute` here: these are thin wrappers over
 * the shared `src/factories/gateway-api` factories (#176) that pin Traefik's
 * controller name and stamp the Traefik managed labels.
 *
 * Enable the provider with `providers: { gatewayApi: true }` on the bootstrap
 * spec. Traefik middlewares attach to a Gateway API route through an
 * `ExtensionRef` filter — see {@link traefikMiddlewareFilter}.
 */

import type { Enhanced } from '../../../core/types/index.js';
import {
  gateway as gatewayApiGateway,
  gatewayClass as gatewayApiGatewayClass,
  type GatewayApiClusterResourceConfig,
  type GatewayApiNamespacedResourceConfig,
  grpcRoute as gatewayApiGrpcRoute,
  httpRoute as gatewayApiHttpRoute,
} from '../../gateway-api/index.js';
import type {
  AcceptedResourceStatus,
  GatewayClassSpec,
  GatewayObservedStatus,
  GatewaySpec,
  GRPCRouteSpec,
  HTTPRouteFilter,
  HTTPRouteSpec,
  RouteObservedStatus,
} from '../../gateway-api/types.js';
import { TRAEFIK_API_VERSION, TRAEFIK_GATEWAY_CONTROLLER_NAME } from '../constants.js';
import { traefikManagedLabels } from './common.js';

/** `GatewayClass.spec` pinned to Traefik's controller. */
export type TraefikGatewayClassSpec = GatewayClassSpec<typeof TRAEFIK_GATEWAY_CONTROLLER_NAME>;

/** Configuration for {@link traefikGatewayClass}. */
export type TraefikGatewayClassConfig = Omit<
  GatewayApiClusterResourceConfig<TraefikGatewayClassSpec>,
  'spec'
> & {
  /** Optional description recorded on the class. */
  readonly description?: string;
};

/**
 * Create a `GatewayClass` claimed by Traefik.
 *
 * The Helm chart can create one itself (`gatewayClass.enabled`), which the
 * bootstrap composition leaves alone. Use this factory when a consumer graph
 * owns the class — for instance to run a second, differently named class
 * alongside the chart's.
 *
 * @example
 * ```typescript
 * traefikGatewayClass({ name: 'traefik-edge', id: 'traefikGatewayClass' });
 * ```
 */
export function traefikGatewayClass(
  config: TraefikGatewayClassConfig
): Enhanced<TraefikGatewayClassSpec, AcceptedResourceStatus> {
  return gatewayApiGatewayClass<typeof TRAEFIK_GATEWAY_CONTROLLER_NAME>({
    name: config.name,
    labels: { ...traefikManagedLabels(config.name), ...config.labels },
    ...(config.annotations ? { annotations: config.annotations } : {}),
    ...(config.id ? { id: config.id } : {}),
    spec: {
      controllerName: TRAEFIK_GATEWAY_CONTROLLER_NAME,
      ...(config.description === undefined ? {} : { description: config.description }),
    },
  });
}

/**
 * Create a Gateway API `Gateway` served by Traefik.
 *
 * `spec.gatewayClassName` must name a class Traefik has claimed.
 */
export function traefikGateway(
  config: GatewayApiNamespacedResourceConfig<GatewaySpec>
): Enhanced<GatewaySpec, GatewayObservedStatus> {
  return gatewayApiGateway({
    ...config,
    labels: { ...traefikManagedLabels(config.name), ...config.labels },
  });
}

/**
 * Create a Gateway API `HTTPRoute` served by Traefik.
 *
 * @example A route attaching a Traefik `Middleware` through an ExtensionRef
 * ```typescript
 * traefikHTTPRoute({
 *   name: 'cost-api',
 *   namespace: 'edge',
 *   spec: {
 *     parentRefs: [{ name: 'traefik-gateway', namespace: 'traefik' }],
 *     hostnames: ['api.example.com'],
 *     rules: [
 *       {
 *         matches: [{ path: { type: 'PathPrefix', value: '/v1' } }],
 *         filters: [traefikMiddlewareFilter('cost-api-authz')],
 *         backendRefs: [{ name: 'cost-api', port: 8080 }],
 *         timeouts: { request: '120s' },
 *       },
 *     ],
 *   },
 *   id: 'costApiHttpRoute',
 * });
 * ```
 */
export function traefikHTTPRoute(
  config: GatewayApiNamespacedResourceConfig<HTTPRouteSpec>
): Enhanced<HTTPRouteSpec, RouteObservedStatus> {
  return gatewayApiHttpRoute({
    ...config,
    labels: { ...traefikManagedLabels(config.name), ...config.labels },
  });
}

/** Create a Gateway API `GRPCRoute` served by Traefik. */
export function traefikGRPCRoute(
  config: GatewayApiNamespacedResourceConfig<GRPCRouteSpec>
): Enhanced<GRPCRouteSpec, RouteObservedStatus> {
  return gatewayApiGrpcRoute({
    ...config,
    labels: { ...traefikManagedLabels(config.name), ...config.labels },
  });
}

/**
 * Build the `ExtensionRef` filter that attaches a Traefik `Middleware` to a
 * Gateway API route rule.
 *
 * Gateway API has no vendor-neutral filter for `forwardAuth` or `rateLimit`,
 * so an implementation-specific extension is the supported way to reference
 * one from an `HTTPRoute`.
 *
 * @param name - Name of a `Middleware` in the route's namespace.
 */
export function traefikMiddlewareFilter(name: string): HTTPRouteFilter {
  return {
    type: 'ExtensionRef',
    extensionRef: {
      group: TRAEFIK_API_VERSION.split('/')[0] ?? 'traefik.io',
      kind: 'Middleware',
      name,
    },
  };
}
