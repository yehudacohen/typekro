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
  TraefikBufferingMiddlewareConfig,
  TraefikChainMiddleware,
  TraefikChainMiddlewareConfig,
  TraefikForwardAuthMiddleware,
  TraefikForwardAuthMiddlewareConfig,
  TraefikHeadersMiddlewareConfig,
  TraefikInFlightReqMiddleware,
  TraefikInFlightReqMiddlewareConfig,
  TraefikMiddlewareMetadata,
  TraefikMiddlewareSpec,
  TraefikPluginMiddlewareConfig,
  TraefikRateLimitMiddleware,
  TraefikRateLimitMiddlewareConfig,
  TraefikRedirectSchemeMiddleware,
  TraefikRedirectSchemeMiddlewareConfig,
} from '../types.js';
import { TypeKroError } from '../../../core/errors.js';
import { assertTraefikMiddlewareSpec } from '../utils/middleware-validation.js';
import {
  type TraefikResourceConfig,
  traefikResourceDefinition,
  traefikStatuslessReadinessEvaluator,
} from './common.js';
import type { TraefikNoStatus } from './routing.js';

/**
 * The builders' configuration types.
 *
 * They are DECLARED in `../types.js`, next to the ArkType schemas they are
 * inferred from — the guide keeps every schema in one file — and re-exported
 * here so the public import path stays `resources/middleware.js`.
 */
export type {
  TraefikBufferingMiddlewareConfig,
  TraefikChainMiddlewareConfig,
  TraefikForwardAuthMiddlewareConfig,
  TraefikHeadersMiddlewareConfig,
  TraefikInFlightReqMiddlewareConfig,
  TraefikMiddlewareMetadata,
  TraefikRateLimitMiddlewareConfig,
  TraefikRedirectSchemeMiddlewareConfig,
} from '../types.js';

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

/**
 * A `Middleware` that runs a plugin declared on the bootstrap.
 *
 * @example
 * ```typescript
 * traefikPluginMiddleware({
 *   name: 'crowdsec-bouncer',
 *   namespace: 'edge',
 *   plugin: 'crowdsec',
 *   config: { enabled: true, crowdsecLapiKey: traefikSecretValue('crowdsec-bouncer', 'api-key') },
 *   id: 'crowdsecBouncer',
 * });
 * ```
 */
export function traefikPluginMiddleware(
  config: Composable<TraefikPluginMiddlewareConfig>
): Enhanced<TraefikMiddlewareSpec, TraefikNoStatus> {
  // The plugin name is a map KEY in the spec, so it must be concrete.
  return middlewareResource(metadataOf(config), {
    plugin: { [config.plugin as string]: config.config },
  });
}

/** The three Middlewares {@link traefikForwardAuthSecurePair} creates. */
export interface TraefikForwardAuthSecurePair {
  /** Removes `authResponseHeaders` from the client's request. */
  readonly stripIdentityHeaders: Enhanced<TraefikMiddlewareSpec, TraefikNoStatus>;
  readonly forwardAuth: Enhanced<TraefikMiddlewareSpec, TraefikNoStatus>;
  /** Strip, then authorize. Reference this one from routes. */
  readonly chain: Enhanced<TraefikMiddlewareSpec, TraefikNoStatus>;
}

/**
 * `forwardAuth` paired with a `headers` Middleware that strips the identity
 * headers from the client's request first, chained under `name`.
 *
 * The strip runs as `<name>-strip-identity`, the authorizer as
 * `<name>-forward-auth`. Header names must be concrete.
 *
 * @throws {TypeKroError} `TRAEFIK_FORWARD_AUTH_INVALID` when `authRequestHeaders`
 *   forwards one of the `authResponseHeaders`.
 */
export function traefikForwardAuthSecurePair(
  config: Composable<TraefikForwardAuthMiddlewareConfig>
): TraefikForwardAuthSecurePair {
  // Traefik 3.7 already replaces each `authResponseHeaders` entry with the
  // authorizer's value (or removes it) on success, so the upstream never sees
  // the client's. It does NOT stop the client's value reaching the authorizer:
  // without an `authRequestHeaders` allowlist every client header is forwarded,
  // and an authorizer that reads, logs or echoes `X-Auth-User` can be fooled.
  // Stripping first closes that, and also holds for older Traefik releases and
  // for anything a later middleware in the chain does with those headers.
  const responseHeaders = [...config.authResponseHeaders];
  const lower = new Set(responseHeaders.map((header) => header.toLowerCase()));
  const forwarded = (config.authRequestHeaders ?? []).filter((header) =>
    lower.has(header.toLowerCase())
  );
  if (forwarded.length > 0) {
    throw new TypeKroError(
      `forwardAuth "${String(config.name)}" forwards ${forwarded.join(', ')} to the authorizer, ` +
        'but those are identity headers it returns. They are stripped from the client request.',
      'TRAEFIK_FORWARD_AUTH_INVALID',
      { forwarded }
    );
  }

  const metadata = metadataOf(config);
  const id = config.id;
  const stripIdentityHeaders = traefikHeadersMiddleware({
    ...metadata,
    name: `${config.name}-strip-identity`,
    // An empty value removes the header.
    headers: {
      customRequestHeaders: Object.fromEntries(responseHeaders.map((header) => [header, ''])),
    },
    ...(id ? { id: `${id}StripIdentity` } : {}),
  });
  const forwardAuth = traefikForwardAuthMiddleware({
    ...config,
    name: `${config.name}-forward-auth`,
    ...(id ? { id: `${id}ForwardAuth` } : {}),
  });
  const ref = (name: string) => ({ name, namespace: config.namespace });
  const chain = traefikChainMiddleware({
    ...metadata,
    middlewares: [ref(`${config.name}-strip-identity`), ref(`${config.name}-forward-auth`)],
  });
  chain.dependsOn(stripIdentityHeaders);
  chain.dependsOn(forwardAuth);
  return { stripIdentityHeaders, forwardAuth, chain };
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
