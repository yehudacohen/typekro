/**
 * Traefik `Middleware` resources.
 *
 * One factory, {@link traefikMiddleware}, covers the whole OSS middleware set
 * through a discriminated union whose variants are mutually exclusive at the
 * type level. On top of it sit typed builders for the middlewares an edge
 * almost always needs, each of which carries the secure defaults from #172.
 */

import type { Composable, Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { TRAEFIK_API_VERSION } from '../constants.js';
import type {
  TraefikBufferingMiddleware,
  TraefikChainMiddleware,
  TraefikForwardAuthMiddleware,
  TraefikHeadersMiddleware,
  TraefikInFlightReqMiddleware,
  TraefikMiddlewareRef,
  TraefikMiddlewareSpec,
  TraefikRateLimitMiddleware,
  TraefikRateLimitRedis,
  TraefikRedirectSchemeMiddleware,
  TraefikSourceCriterion,
} from '../types.js';
import { assertTraefikMiddlewareSpec } from '../utils/middleware-validation.js';
import {
  type TraefikResourceConfig,
  traefikResourceDefinition,
  traefikStatuslessReadinessEvaluator,
} from './common.js';
import type { TraefikNoStatus } from './routing.js';

/** Identity of a `Middleware`, without its behavior. */
export interface TraefikMiddlewareMetadata {
  readonly name: string;
  readonly namespace: string;
  /** Extra labels merged onto the managed label set. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  /** Resource graph id. Required when `name` is a schema reference. */
  readonly id?: string;
}

function middlewareResource(
  metadata: Composable<TraefikMiddlewareMetadata>,
  spec: Composable<TraefikMiddlewareSpec>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  return traefikMiddleware({ ...metadata, spec });
}

/**
 * Create a Traefik `Middleware`.
 *
 * `spec` accepts exactly one middleware key. Setting two is a compile error,
 * and is re-checked here because Traefik resolves such an object by applying
 * one middleware and silently dropping the other.
 *
 * @throws {TypeKroError} `TRAEFIK_MIDDLEWARE_INVALID_SPEC` when the spec sets
 *   zero, several, or unknown middleware keys.
 *
 * @example
 * ```typescript
 * traefikMiddleware({
 *   name: 'strip-v1',
 *   namespace: 'edge',
 *   spec: { stripPrefix: { prefixes: ['/v1'] } },
 *   id: 'stripV1',
 * });
 * ```
 */
export function traefikMiddleware(
  config: Composable<TraefikResourceConfig<TraefikMiddlewareSpec>>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  assertTraefikMiddlewareSpec(config.spec, config.name);
  return createResource<TraefikMiddlewareSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'Middleware', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('Middleware'));
}

/** Configuration for {@link traefikForwardAuthMiddleware}. */
export interface TraefikForwardAuthMiddlewareConfig extends TraefikMiddlewareMetadata {
  /** Authorizer URL, e.g. `http://authorizer.edge.svc.cluster.local:8080/authorize`. */
  readonly address: string;
  /**
   * Headers copied from the authorizer's 2xx response onto the upstream
   * request. Required rather than optional: an implicit "copy everything"
   * would let an authorizer bug leak headers to the upstream, and a route with
   * no allowlist silently drops the principal the upstream expects.
   */
  readonly authResponseHeaders: readonly string[];
  /** Client headers forwarded to the authorizer. Omit to forward all of them. */
  readonly authRequestHeaders?: readonly string[];
  /**
   * @security Defaults to `false`. Only enable when every client reaching this
   * entrypoint is already behind a trusted proxy that rewrites
   * `X-Forwarded-*`; otherwise a caller can assert its own source address.
   */
  readonly trustForwardHeader?: boolean;
  readonly forwardBody?: boolean;
  readonly maxBodySize?: number;
  readonly tls?: TraefikForwardAuthMiddleware['tls'];
}

/**
 * Create a `forwardAuth` `Middleware` with the secure edge defaults.
 *
 * `trustForwardHeader` is `false` unless explicitly overridden, and
 * `authResponseHeaders` is an explicit allowlist.
 *
 * @example The Example orders-api authorizer, returning principal/tier/customer
 * ```typescript
 * traefikForwardAuthMiddleware({
 *   name: 'orders-api-authz',
 *   namespace: 'edge',
 *   address: 'http://orders-authorizer.edge.svc.cluster.local:8080/authorize',
 *   authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
 *   authRequestHeaders: ['Authorization', 'X-Edge-Api-Key'],
 *   id: 'ordersApiAuthz',
 * });
 * ```
 */
export function traefikForwardAuthMiddleware(
  config: Composable<TraefikForwardAuthMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  const forwardAuth: Composable<TraefikForwardAuthMiddleware> = {
    address: config.address,
    // @security Never inherit the client's own X-Forwarded-* by default.
    trustForwardHeader: config.trustForwardHeader ?? false,
    authResponseHeaders: [...config.authResponseHeaders],
    ...(config.authRequestHeaders ? { authRequestHeaders: [...config.authRequestHeaders] } : {}),
    ...(config.forwardBody === undefined ? {} : { forwardBody: config.forwardBody }),
    ...(config.maxBodySize === undefined ? {} : { maxBodySize: config.maxBodySize }),
    ...(config.tls ? { tls: config.tls } : {}),
  };
  return middlewareResource(metadataOf(config), { forwardAuth });
}

/** Configuration for {@link traefikRateLimitMiddleware}. */
export interface TraefikRateLimitMiddlewareConfig extends TraefikMiddlewareMetadata {
  /** Sustained requests allowed per {@link period}. */
  readonly average: number;
  /** Requests absorbed above {@link average} before Traefik answers 429. */
  readonly burst: number;
  /** Window `average` is measured over. @default '1s' */
  readonly period?: string;
  /**
   * Request header the budget is keyed on — typically the principal or tenant
   * header a preceding `forwardAuth` produced. Mutually exclusive with
   * {@link sourceCriterion}.
   */
  readonly requestHeaderName?: string;
  /** Full source-criterion form, for IP-strategy or host keying. */
  readonly sourceCriterion?: TraefikSourceCriterion;
  /**
   * Shared Redis/Valkey backend. Without it each Traefik replica counts
   * independently, so the effective budget is `average × replicas`.
   */
  readonly redis?: TraefikRateLimitRedis;
}

/**
 * Create a `rateLimit` `Middleware`.
 *
 * @example Per-principal budget shared across replicas through Valkey
 * ```typescript
 * traefikRateLimitMiddleware({
 *   name: 'orders-api-rate-limit',
 *   namespace: 'edge',
 *   average: 50,
 *   burst: 100,
 *   period: '1s',
 *   requestHeaderName: 'X-Edge-Principal',
 *   redis: {
 *     endpoints: ['valkey-primary.edge.svc.cluster.local:6379'],
 *     secret: 'valkey-auth',
 *     db: 3,
 *   },
 *   id: 'ordersApiRateLimit',
 * });
 * ```
 */
export function traefikRateLimitMiddleware(
  config: Composable<TraefikRateLimitMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  const sourceCriterion =
    config.sourceCriterion ??
    (config.requestHeaderName === undefined
      ? undefined
      : { requestHeaderName: config.requestHeaderName });
  const rateLimit: Composable<TraefikRateLimitMiddleware> = {
    average: config.average,
    burst: config.burst,
    period: config.period ?? '1s',
    ...(sourceCriterion ? { sourceCriterion } : {}),
    ...(config.redis ? { redis: config.redis } : {}),
  };
  return middlewareResource(metadataOf(config), { rateLimit });
}

/** Configuration for {@link traefikInFlightReqMiddleware}. */
export interface TraefikInFlightReqMiddlewareConfig extends TraefikMiddlewareMetadata {
  /** Maximum requests handled concurrently per source. */
  readonly amount: number;
  /** Key the concurrency budget on a request header. */
  readonly requestHeaderName?: string;
  readonly sourceCriterion?: TraefikSourceCriterion;
}

/**
 * Create an `inFlightReq` `Middleware` — a concurrency cap that protects an
 * upstream from a slow-request pile-up that a rate limit alone would allow.
 *
 * @example
 * ```typescript
 * traefikInFlightReqMiddleware({
 *   name: 'orders-api-concurrency',
 *   namespace: 'edge',
 *   amount: 20,
 *   requestHeaderName: 'X-Edge-Customer',
 *   id: 'ordersApiConcurrency',
 * });
 * ```
 */
export function traefikInFlightReqMiddleware(
  config: Composable<TraefikInFlightReqMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  const sourceCriterion =
    config.sourceCriterion ??
    (config.requestHeaderName === undefined
      ? undefined
      : { requestHeaderName: config.requestHeaderName });
  const inFlightReq: Composable<TraefikInFlightReqMiddleware> = {
    amount: config.amount,
    ...(sourceCriterion ? { sourceCriterion } : {}),
  };
  return middlewareResource(metadataOf(config), { inFlightReq });
}

/** Configuration for {@link traefikHeadersMiddleware}. */
export interface TraefikHeadersMiddlewareConfig extends TraefikMiddlewareMetadata {
  readonly headers: TraefikHeadersMiddleware;
}

/**
 * Create a `headers` `Middleware` for CORS and browser security headers.
 *
 * @example
 * ```typescript
 * traefikHeadersMiddleware({
 *   name: 'orders-api-headers',
 *   namespace: 'edge',
 *   headers: {
 *     accessControlAllowOriginList: ['https://console.example.com'],
 *     accessControlAllowMethods: ['GET', 'POST', 'OPTIONS'],
 *     accessControlAllowHeaders: ['authorization', 'content-type'],
 *     accessControlAllowCredentials: true,
 *     accessControlMaxAge: 600,
 *     addVaryHeader: true,
 *     frameDeny: true,
 *     contentTypeNosniff: true,
 *     referrerPolicy: 'strict-origin-when-cross-origin',
 *     stsSeconds: 31_536_000,
 *     stsIncludeSubdomains: true,
 *   },
 *   id: 'ordersApiHeaders',
 * });
 * ```
 */
export function traefikHeadersMiddleware(
  config: Composable<TraefikHeadersMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  return middlewareResource(metadataOf(config), { headers: config.headers });
}

/** Configuration for {@link traefikRedirectSchemeMiddleware}. */
export interface TraefikRedirectSchemeMiddlewareConfig extends TraefikMiddlewareMetadata {
  /** @default 'https' */
  readonly scheme?: 'http' | 'https';
  /** @default true */
  readonly permanent?: boolean;
  readonly port?: string;
}

/**
 * Create a `redirectScheme` `Middleware`, the route-level counterpart to the
 * entrypoint-level `web` → `websecure` redirect.
 *
 * Prefer the entrypoint redirect (`entrypoints.web.redirectToWebsecure` on the
 * bootstrap spec) for a blanket policy; use this middleware when only some
 * routes should redirect.
 */
export function traefikRedirectSchemeMiddleware(
  config: Composable<TraefikRedirectSchemeMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  const redirectScheme: Composable<TraefikRedirectSchemeMiddleware> = {
    scheme: config.scheme ?? 'https',
    permanent: config.permanent ?? true,
    ...(config.port === undefined ? {} : { port: config.port }),
  };
  return middlewareResource(metadataOf(config), { redirectScheme });
}

/** Configuration for {@link traefikBufferingMiddleware}. */
export interface TraefikBufferingMiddlewareConfig extends TraefikMiddlewareMetadata {
  readonly buffering: TraefikBufferingMiddleware;
}

/**
 * Create a `buffering` `Middleware` enforcing request/response body limits.
 *
 * @example A 1 MiB request-body cap
 * ```typescript
 * traefikBufferingMiddleware({
 *   name: 'orders-api-body-limit',
 *   namespace: 'edge',
 *   buffering: { maxRequestBodyBytes: 1_048_576, memRequestBodyBytes: 262_144 },
 *   id: 'ordersApiBodyLimit',
 * });
 * ```
 */
export function traefikBufferingMiddleware(
  config: Composable<TraefikBufferingMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  return middlewareResource(metadataOf(config), { buffering: config.buffering });
}

/** Configuration for {@link traefikChainMiddleware}. */
export interface TraefikChainMiddlewareConfig extends TraefikMiddlewareMetadata {
  /** Middlewares applied in order. */
  readonly middlewares: readonly TraefikMiddlewareRef[];
}

/**
 * Create a `chain` `Middleware` bundling an ordered middleware list into one
 * reference, so several routes can share the same edge policy.
 *
 * @example
 * ```typescript
 * traefikChainMiddleware({
 *   name: 'orders-api-edge',
 *   namespace: 'edge',
 *   middlewares: [
 *     { name: 'orders-api-headers' },
 *     { name: 'orders-api-authz' },
 *     { name: 'orders-api-rate-limit' },
 *     { name: 'orders-api-concurrency' },
 *     { name: 'orders-api-body-limit' },
 *   ],
 *   id: 'ordersApiEdgeChain',
 * });
 * ```
 */
export function traefikChainMiddleware(
  config: Composable<TraefikChainMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  const chain: Composable<TraefikChainMiddleware> = { middlewares: [...config.middlewares] };
  return middlewareResource(metadataOf(config), { chain });
}

function metadataOf(
  config: Composable<TraefikMiddlewareMetadata>
): Composable<TraefikMiddlewareMetadata> {
  return {
    name: config.name,
    namespace: config.namespace,
    ...(config.labels ? { labels: config.labels } : {}),
    ...(config.annotations ? { annotations: config.annotations } : {}),
    ...(config.id ? { id: config.id } : {}),
  };
}
