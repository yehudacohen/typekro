/**
 * Traefik routing resources: `IngressRoute`, `IngressRouteTCP`,
 * `TraefikService` and `ServersTransport`.
 *
 * Every one of these kinds is status-less; see
 * {@link traefikStatuslessReadinessEvaluator} for why they are registered as
 * always-ready rather than condition-based.
 */

import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { TRAEFIK_API_VERSION } from '../constants.js';
import type {
  TraefikIngressRouteSpec,
  TraefikIngressRouteTCPSpec,
  TraefikServersTransportSpec,
  TraefikServiceSpec,
} from '../types.js';
import {
  type TraefikResourceConfig,
  traefikResourceDefinition,
  traefikStatuslessReadinessEvaluator,
} from './common.js';

/** Traefik CRDs have no status subresource, so their status type is empty. */
export type TraefikNoStatus = Record<string, never>;

/**
 * Create a Traefik `IngressRoute`.
 *
 * The HTTP router: it binds rule expressions on one or more entrypoints to
 * backend services, with an ordered middleware chain and optional TLS.
 *
 * @example An authenticated, rate-limited API route terminating TLS
 * ```typescript
 * traefikIngressRoute({
 *   name: 'cost-api',
 *   namespace: 'edge',
 *   spec: {
 *     entryPoints: ['websecure'],
 *     routes: [
 *       {
 *         match: 'Host(`api.example.com`) && PathPrefix(`/v1`)',
 *         kind: 'Rule',
 *         middlewares: [{ name: 'cost-api-authz' }, { name: 'cost-api-rate-limit' }],
 *         services: [{ name: 'cost-api', port: 8080 }],
 *       },
 *     ],
 *     tls: { secretName: 'cost-api-tls' },
 *   },
 *   id: 'costApiRoute',
 * });
 * ```
 */
export function traefikIngressRoute(
  config: TraefikResourceConfig<TraefikIngressRouteSpec>
): Enhanced<TraefikIngressRouteSpec, TraefikNoStatus> {
  return createResource<TraefikIngressRouteSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'IngressRoute', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('IngressRoute'));
}

/**
 * Create a Traefik `IngressRouteTCP`.
 *
 * The TCP router, matched on SNI. Use `tls.passthrough` to hand the TLS
 * handshake to the backend instead of terminating it at the edge.
 *
 * @example
 * ```typescript
 * traefikIngressRouteTCP({
 *   name: 'postgres',
 *   namespace: 'edge',
 *   spec: {
 *     entryPoints: ['postgres'],
 *     routes: [{ match: 'HostSNI(`db.example.com`)', services: [{ name: 'pg-rw', port: 5432 }] }],
 *     tls: { passthrough: true },
 *   },
 *   id: 'postgresRoute',
 * });
 * ```
 */
export function traefikIngressRouteTCP(
  config: TraefikResourceConfig<TraefikIngressRouteTCPSpec>
): Enhanced<TraefikIngressRouteTCPSpec, TraefikNoStatus> {
  return createResource<TraefikIngressRouteTCPSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'IngressRouteTCP', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('IngressRouteTCP'));
}

/**
 * Create a Traefik `TraefikService`.
 *
 * A composed backend — weighted round-robin, mirroring, failover, or highest
 * random weight — referenced from a route with `kind: 'TraefikService'`.
 *
 * @example Canary split between two Deployments
 * ```typescript
 * traefikService({
 *   name: 'cost-api-canary',
 *   namespace: 'edge',
 *   spec: {
 *     weighted: {
 *       services: [
 *         { name: 'cost-api', port: 8080, weight: 9 },
 *         { name: 'cost-api-next', port: 8080, weight: 1 },
 *       ],
 *     },
 *   },
 *   id: 'costApiCanary',
 * });
 * ```
 */
export function traefikService(
  config: TraefikResourceConfig<TraefikServiceSpec>
): Enhanced<TraefikServiceSpec, TraefikNoStatus> {
  return createResource<TraefikServiceSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'TraefikService', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('TraefikService'));
}

/**
 * Create a Traefik `ServersTransport`.
 *
 * Controls how Traefik dials the upstream: TLS trust, connection pooling and
 * the forwarding timeouts. An edge fronting requests longer than Traefik's 60s
 * default must raise `forwardingTimeouts.responseHeaderTimeout` here as well
 * as the entrypoint's `respondingTimeouts`.
 *
 * @example
 * ```typescript
 * traefikServersTransport({
 *   name: 'cost-api-slow',
 *   namespace: 'edge',
 *   spec: { forwardingTimeouts: { responseHeaderTimeout: '120s', idleConnTimeout: '150s' } },
 *   id: 'costApiTransport',
 * });
 * ```
 */
export function traefikServersTransport(
  config: TraefikResourceConfig<TraefikServersTransportSpec>
): Enhanced<TraefikServersTransportSpec, TraefikNoStatus> {
  return createResource<TraefikServersTransportSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'ServersTransport', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('ServersTransport'));
}
