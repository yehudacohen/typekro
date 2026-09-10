/**
 * Traefik type definitions.
 *
 * **ArkType is the single source of truth.** Every configuration type in this
 * file — the `traefik.io/v1alpha1` CRD specs, the middleware set, and the
 * bootstrap composition's spec — is INFERRED from the ArkType schema declared
 * next to it (`typeof XSchema.infer`), per `docs/advanced/integration-skill.md`
 * Step 2. One declaration then validates at runtime, generates the KRO
 * SimpleSchema, and types the factory, so the three cannot drift. Only STATUS
 * types stay hand-written: they describe what a controller publishes rather
 * than user input.
 *
 * Three layers live here:
 *
 * 1. **CRD spec schemas** — verified field-by-field against the
 *    `traefik.io/v1alpha1` CRDs shipped by chart 41.5.0 (Traefik v3.7.13), read
 *    back from a live API server with
 *    `kubectl get crd middlewares.traefik.io -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec}'`.
 *    None of the Traefik CRDs has a `status` subresource, which is why the
 *    resource factories register an always-ready evaluator (see
 *    `resources/routing.ts`). Where a schema is stricter than the CRD it is
 *    deliberate and noted inline.
 * 2. **Helm chart values** — {@link TraefikManagedHelmValues} is a CLOSED,
 *    precise description of the chart paths this factory maps, pins or reads
 *    back (verified against chart 41.5.0's `values.schema.json`). It carries no
 *    index signatures at any depth; {@link TraefikRawHelmValues} is the single,
 *    explicitly named raw-passthrough boundary for the rest of the chart.
 * 3. **Bootstrap contract** — the runtime spec/status of the bootstrap
 *    composition. Following the ClickStack convention these carry only
 *    proxy-safe VALUES (names, namespaces, versions, ports, endpoints) that
 *    serialize cleanly as CEL refs in KRO mode. Choices that decide WHICH
 *    resources exist are build-time options on `makeTraefikBootstrap(...)`.
 *
 * @see https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/crd/
 */

import { type } from 'arktype';
import type { TypeKroChartValues } from '../../core/types/common.js';
import type {
  Affinity,
  EnvVar,
  LabelSelector,
  SecurityContext,
  Toleration,
} from '../cert-manager/types.js';
import { gatewayApiClusterResourceMetadataShape } from '../gateway-api/types.js';
import type { HelmReleaseCrdsPolicy } from '../helm/types.js';
import { validateTraefikMiddlewareSpec } from './utils/middleware-validation.js';

const kubernetesName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 40');
const kubernetesDnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');
/** A published port. Bounded as the Service/container port range, 1-65535. */
const kubernetesPort = '1 <= number.integer <= 65535';

/** Make every key of an inferred all-optional schema present and non-nullable. */
type AllPresent<T> = { [K in keyof T]-?: NonNullable<T[K]> };

// ============================================================================
// Shared primitives
// ============================================================================

/**
 * ArkType definition of a Traefik duration.
 *
 * The CRDs accept an integer (nanoseconds) or a Go duration string such as
 * `'90s'`; prefer the string form for readability.
 *
 * The numeric branch is `number.integer`, not a bare `number`: these are
 * `x-kubernetes-int-or-string` fields whose integer branch the API server
 * enforces, so `interval: 1.5` is rejected at admission. KRO SimpleSchema
 * collapses a union to `object`, so ArkType is where that integrality is
 * caught — which is why it has to be declared here.
 */
const traefikDuration = 'string | number.integer';

/**
 * ArkType definition of a Traefik service port: a port number or a named port.
 *
 * Structurally identical to {@link traefikDuration} — both are
 * `x-kubernetes-int-or-string` with an integral numeric branch — but named
 * apart because a port and a duration are not interchangeable to a reader.
 */
const traefikPortValue = 'string | number.integer';

/** A Traefik duration: a Go duration string, or an integer of nanoseconds. */
export type TraefikDuration = string | number;

/** A Kubernetes Service port: a number or a named port. */
export type TraefikPortValue = string | number;

/** How Traefik derives the client IP from proxy headers. */
export const TraefikIpStrategySchema = type({
  /** Depth position in `X-Forwarded-For`, counted from the right. */
  'depth?': 'number.integer >= 0',
  'excludedIPs?': 'string[]',
  /** Group IPv6 clients into a shared subnet before keying. */
  'ipv6Subnet?': 'number.integer',
});

/** How Traefik derives the client IP from proxy headers. */
export type TraefikIpStrategy = typeof TraefikIpStrategySchema.infer;

/**
 * What a `rateLimit` / `inFlightReq` middleware keys its counters on.
 *
 * Exactly one of these should be set; Traefik falls back to the client IP when
 * none is given.
 */
export const TraefikSourceCriterionSchema = type({
  /** Key on a request header, e.g. the principal emitted by `forwardAuth`. */
  'requestHeaderName?': 'string',
  'requestHost?': 'boolean',
  'ipStrategy?': TraefikIpStrategySchema,
});

/** What a `rateLimit` / `inFlightReq` middleware keys its counters on. */
export type TraefikSourceCriterion = typeof TraefikSourceCriterionSchema.infer;

/** Sticky-session cookie configuration for a load-balanced service. */
export const TraefikStickyCookieSchema = type({
  'cookie?': {
    'name?': 'string',
    'secure?': 'boolean',
    'httpOnly?': 'boolean',
    'sameSite?': '"none" | "lax" | "strict" | "None" | "Lax" | "Strict"',
    'maxAge?': 'number.integer',
    'path?': 'string',
    'domain?': 'string',
  },
});

/** Sticky-session cookie configuration for a load-balanced service. */
export type TraefikStickyCookie = typeof TraefikStickyCookieSchema.infer;

/**
 * Active health check performed by Traefik against a service's servers.
 *
 * The CRD spells the Host override `hostname`; there is no `host` field.
 */
export const TraefikHealthCheckSchema = type({
  'path?': 'string',
  'hostname?': 'string',
  'scheme?': 'string',
  'mode?': 'string',
  'method?': 'string',
  'status?': 'number.integer',
  'port?': 'number.integer',
  'interval?': traefikDuration,
  'unhealthyInterval?': traefikDuration,
  'timeout?': traefikDuration,
  'headers?': 'Record<string, string>',
  'followRedirects?': 'boolean',
});

/** Active health check performed by Traefik against a service's servers. */
export type TraefikHealthCheck = typeof TraefikHealthCheckSchema.infer;

/** A reference to a `Middleware` resource. */
export const TraefikMiddlewareRefSchema = type({
  name: 'string',
  'namespace?': 'string',
});

/** A reference to a `Middleware` resource. */
export type TraefikMiddlewareRef = typeof TraefikMiddlewareRefSchema.infer;

/** ArkType definition of the load-balancing strategies the CRD enumerates. */
const traefikLoadBalancerStrategy = '"wrr" | "p2c" | "hrw" | "leasttime" | "RoundRobin"';

/** Load-balancing strategy across a service's servers. */
export type TraefikLoadBalancerStrategy = 'wrr' | 'p2c' | 'hrw' | 'leasttime' | 'RoundRobin';

/** One backend of an `IngressRoute` route or a `TraefikService`. */
export const TraefikServiceRefSchema = type({
  name: 'string',
  'namespace?': 'string',
  'kind?': '"Service" | "TraefikService"',
  /** Port number or named port — the CRD accepts either. */
  'port?': traefikPortValue,
  'scheme?': 'string',
  'weight?': 'number.integer >= 0',
  'strategy?': traefikLoadBalancerStrategy,
  'passHostHeader?': 'boolean',
  'nativeLB?': 'boolean',
  'nodePortLB?': 'boolean',
  'serversTransport?': 'string',
  'sticky?': TraefikStickyCookieSchema,
  'healthCheck?': TraefikHealthCheckSchema,
  'passiveHealthCheck?': {
    'failureWindow?': traefikDuration,
    'maxFailedAttempts?': 'number.integer',
  },
  'responseForwarding?': { 'flushInterval?': 'string' },
  'middlewares?': TraefikMiddlewareRefSchema.array(),
});

/** One backend of an `IngressRoute` route or a `TraefikService`. */
export type TraefikServiceRef = typeof TraefikServiceRefSchema.infer;

/** TLS configuration attached to a router. */
export const TraefikRouterTLSSchema = type({
  /** Secret holding the certificate, e.g. one written by cert-manager. */
  'secretName?': 'string',
  'options?': { name: 'string', 'namespace?': 'string' },
  'store?': { name: 'string', 'namespace?': 'string' },
  'certResolver?': 'string',
  'domains?': type({
    'main?': 'string',
    'sans?': 'string[]',
  }).array(),
});

/** TLS configuration attached to a router. */
export type TraefikRouterTLS = typeof TraefikRouterTLSSchema.infer;

// ============================================================================
// IngressRoute / IngressRouteTCP
// ============================================================================

/** Per-route observability overrides. */
export const TraefikRouteObservabilitySchema = type({
  'accessLogs?': 'boolean',
  'metrics?': 'boolean',
  'tracing?': 'boolean',
  'traceVerbosity?': '"minimal" | "detailed"',
});

/** Per-route observability overrides. */
export type TraefikRouteObservability = typeof TraefikRouteObservabilitySchema.infer;

/** One `IngressRoute.spec.routes[]` entry. */
export const TraefikIngressRouteRuleSchema = type({
  /** Traefik v3 rule expression, e.g. ``Host(`api.example.com`)``. */
  match: 'string',
  'kind?': '"Rule"',
  /** Higher priority wins; Traefik defaults to the rule length. */
  'priority?': 'number.integer',
  'syntax?': 'string',
  'services?': TraefikServiceRefSchema.array(),
  'middlewares?': TraefikMiddlewareRefSchema.array(),
  'observability?': TraefikRouteObservabilitySchema,
});

/** One `IngressRoute.spec.routes[]` entry. */
export type TraefikIngressRouteRule = typeof TraefikIngressRouteRuleSchema.infer;

/** `IngressRoute.spec`. */
export const TraefikIngressRouteSpecSchema = type({
  routes: TraefikIngressRouteRuleSchema.array(),
  'entryPoints?': 'string[]',
  'ingressClassName?': 'string',
  'tls?': TraefikRouterTLSSchema,
  'parentRefs?': type({ name: 'string', 'namespace?': 'string' }).array(),
});

/** `IngressRoute.spec`. */
export type TraefikIngressRouteSpec = typeof TraefikIngressRouteSpecSchema.infer;

/** One backend of an `IngressRouteTCP` route. */
export const TraefikTCPServiceRefSchema = type({
  name: 'string',
  port: traefikPortValue,
  'namespace?': 'string',
  'weight?': 'number.integer >= 0',
  'tls?': 'boolean',
  'nativeLB?': 'boolean',
  'nodePortLB?': 'boolean',
  'serversTransport?': 'string',
  /** PROXY protocol version. The CRD admits only 1 or 2. */
  'proxyProtocol?': { 'version?': '1 <= number.integer <= 2' },
});

/** One backend of an `IngressRouteTCP` route. */
export type TraefikTCPServiceRef = typeof TraefikTCPServiceRefSchema.infer;

/** One `IngressRouteTCP.spec.routes[]` entry. */
export const TraefikIngressRouteTCPRuleSchema = type({
  /** TCP rule expression, e.g. ``HostSNI(`db.example.com`)``. */
  match: 'string',
  'priority?': 'number.integer',
  'syntax?': '"v3" | "v2"',
  'services?': TraefikTCPServiceRefSchema.array(),
  'middlewares?': TraefikMiddlewareRefSchema.array(),
});

/** One `IngressRouteTCP.spec.routes[]` entry. */
export type TraefikIngressRouteTCPRule = typeof TraefikIngressRouteTCPRuleSchema.infer;

/** `IngressRouteTCP.spec`. */
export const TraefikIngressRouteTCPSpecSchema = type({
  routes: TraefikIngressRouteTCPRuleSchema.array(),
  'entryPoints?': 'string[]',
  'ingressClassName?': 'string',
  'tls?': TraefikRouterTLSSchema.and({ 'passthrough?': 'boolean' }),
});

/** `IngressRouteTCP.spec`. */
export type TraefikIngressRouteTCPSpec = typeof TraefikIngressRouteTCPSpecSchema.infer;

// ============================================================================
// TraefikService / ServersTransport
// ============================================================================

/**
 * `TraefikService.spec` — exactly one composition mode should be set.
 *
 * `failover.errors` is required because the CRD requires it alongside
 * `service` and `fallback`.
 */
export const TraefikServiceSpecSchema = type({
  'weighted?': {
    'services?': TraefikServiceRefSchema.array(),
    'sticky?': TraefikStickyCookieSchema,
  },
  'mirroring?': TraefikServiceRefSchema.and({
    'maxBodySize?': 'number.integer',
    'mirrorBody?': 'boolean',
    'mirrors?': TraefikServiceRefSchema.and({ 'percent?': 'number.integer' }).array(),
  }),
  'failover?': {
    service: TraefikServiceRefSchema,
    fallback: TraefikServiceRefSchema,
    errors: {
      'status?': 'string[]',
      'maxRequestBodyBytes?': 'number.integer',
    },
  },
  'highestRandomWeight?': {
    'services?': TraefikServiceRefSchema.array(),
  },
});

/** `TraefikService.spec`. */
export type TraefikServiceSpec = typeof TraefikServiceSpecSchema.infer;

/** `ServersTransport.spec` — how Traefik dials upstream servers. */
export const TraefikServersTransportSpecSchema = type({
  'serverName?': 'string',
  'insecureSkipVerify?': 'boolean',
  'rootCAsSecrets?': 'string[]',
  'rootCAs?': type({
    'secret?': 'string',
    'configMap?': 'string',
  }).array(),
  'certificatesSecrets?': 'string[]',
  /** `-1` disables the pool; the CRD's own minimum. */
  'maxIdleConnsPerHost?': 'number.integer >= -1',
  'disableHTTP2?': 'boolean',
  'peerCertURI?': 'string',
  'minVersion?': 'string',
  'maxVersion?': 'string',
  'cipherSuites?': 'string[]',
  'spiffe?': {
    'ids?': 'string[]',
    'trustDomain?': 'string',
  },
  /**
   * Upstream timeouts. An edge fronting long-running requests must raise
   * `responseHeaderTimeout` above the default 60s alongside the entrypoint's
   * `respondingTimeouts`.
   */
  'forwardingTimeouts?': {
    'dialTimeout?': traefikDuration,
    'responseHeaderTimeout?': traefikDuration,
    'idleConnTimeout?': traefikDuration,
    'readIdleTimeout?': traefikDuration,
    'pingTimeout?': traefikDuration,
  },
});

/** `ServersTransport.spec`. */
export type TraefikServersTransportSpec = typeof TraefikServersTransportSpecSchema.infer;

// ============================================================================
// TLSOption / TLSStore
// ============================================================================

/** Mutual-TLS behavior of a `TLSOption`. */
export const TraefikClientAuthSchema = type({
  'secretNames?': 'string[]',
  'clientAuthType?':
    '"NoClientCert" | "RequestClientCert" | "RequireAnyClientCert" | "VerifyClientCertIfGiven" | "RequireAndVerifyClientCert"',
});

/** Mutual-TLS behavior of a `TLSOption`. */
export type TraefikClientAuth = typeof TraefikClientAuthSchema.infer;

/**
 * `TLSOption.spec`.
 *
 * `minVersion`/`maxVersion` are narrower than the CRD's bare string: those four
 * are the values Traefik accepts, so a typo is caught here instead of by the
 * proxy at runtime. The CRD's deprecated `preferServerCipherSuites` is
 * deliberately absent — Traefik v3 ignores it.
 */
export const TraefikTLSOptionSpecSchema = type({
  'minVersion?': '"VersionTLS10" | "VersionTLS11" | "VersionTLS12" | "VersionTLS13"',
  'maxVersion?': '"VersionTLS10" | "VersionTLS11" | "VersionTLS12" | "VersionTLS13"',
  'cipherSuites?': 'string[]',
  'curvePreferences?': 'string[]',
  /** Reject connections whose SNI does not match a configured certificate. */
  'sniStrict?': 'boolean',
  'alpnProtocols?': 'string[]',
  'disableSessionTickets?': 'boolean',
  'clientAuth?': TraefikClientAuthSchema,
});

/** `TLSOption.spec`. */
export type TraefikTLSOptionSpec = typeof TraefikTLSOptionSpecSchema.infer;

/** `TLSStore.spec`. */
export const TraefikTLSStoreSpecSchema = type({
  /**
   * Default certificate served when SNI matches no router certificate. Point
   * this at the Secret a cert-manager `Certificate` writes.
   */
  'defaultCertificate?': { secretName: 'string' },
  /** ACME resolver used to generate the default certificate instead. */
  'defaultGeneratedCert?': {
    'resolver?': 'string',
    'domain?': {
      'main?': 'string',
      'sans?': 'string[]',
    },
  },
  'certificates?': type({ secretName: 'string' }).array(),
});

/** `TLSStore.spec`. */
export type TraefikTLSStoreSpec = typeof TraefikTLSStoreSpecSchema.infer;

// ============================================================================
// Middleware — the OSS middleware set as a discriminated union
// ============================================================================

/** TLS client config shared by `forwardAuth` and the `rateLimit` Redis backend. */
const middlewareClientTlsShape = {
  'caSecret?': 'string',
  'certSecret?': 'string',
  'insecureSkipVerify?': 'boolean',
} as const;

/**
 * Delegate authentication and authorization to an in-cluster authorizer.
 *
 * `address` is required although the CRD allows it to be absent: a
 * `forwardAuth` with no authorizer fails every request.
 *
 * @security `trustForwardHeader` defaults to `false` in
 * {@link TRAEFIK_FORWARD_AUTH_SECURE_DEFAULTS}: trusting `X-Forwarded-*` from
 * an untrusted client lets a caller spoof its own identity. `authResponseHeaders`
 * is an explicit allowlist — only the listed headers are copied from the
 * authorizer response onto the upstream request.
 */
export const TraefikForwardAuthMiddlewareSchema = type({
  /** URL of the authorizer, e.g. `http://authorizer.edge.svc.cluster.local:8080/auth`. */
  address: 'string',
  /** Copy `X-Forwarded-*` from the client to the authorizer. Keep `false` at an edge. */
  'trustForwardHeader?': 'boolean',
  /** Headers copied from the authorizer's response onto the upstream request. */
  'authResponseHeaders?': 'string[]',
  /** Regex alternative to `authResponseHeaders`. Prefer the explicit list. */
  'authResponseHeadersRegex?': 'string',
  /** Client headers forwarded to the authorizer. Empty means all of them. */
  'authRequestHeaders?': 'string[]',
  'addAuthCookiesToResponse?': 'string[]',
  'authSigninURL?': 'string',
  'forwardBody?': 'boolean',
  'maxBodySize?': 'number.integer',
  'maxResponseBodySize?': 'number.integer',
  'headerField?': 'string',
  'preserveLocationHeader?': 'boolean',
  'preserveRequestMethod?': 'boolean',
  'tls?': middlewareClientTlsShape,
});

/** Delegate authentication and authorization to an in-cluster authorizer. */
export type TraefikForwardAuthMiddleware = typeof TraefikForwardAuthMiddlewareSchema.infer;

/** Redis (or Valkey) backend making a rate limit shared across Traefik replicas. */
export const TraefikRateLimitRedisSchema = type({
  endpoints: 'string[]',
  /** Secret holding `username` / `password` keys. */
  'secret?': 'string',
  'db?': 'number.integer',
  'poolSize?': 'number.integer',
  'minIdleConns?': 'number.integer',
  'maxActiveConns?': 'number.integer',
  'dialTimeout?': traefikDuration,
  'readTimeout?': traefikDuration,
  'writeTimeout?': traefikDuration,
  'tls?': middlewareClientTlsShape,
});

/** Redis (or Valkey) backend making a rate limit shared across Traefik replicas. */
export type TraefikRateLimitRedis = typeof TraefikRateLimitRedisSchema.infer;

/**
 * Token-bucket rate limit.
 *
 * Without `redis` each Traefik replica keeps its own counters, so the effective
 * limit is `average × replicas`. Supply the Redis backend whenever the budget
 * must hold for the whole edge.
 */
export const TraefikRateLimitMiddlewareSchema = type({
  /** Sustained requests allowed per `period`. */
  'average?': 'number.integer >= 0',
  /** Requests absorbed above `average` before Traefik answers 429. */
  'burst?': 'number.integer >= 0',
  /** Window `average` is measured over. Defaults to one second. */
  'period?': traefikDuration,
  'sourceCriterion?': TraefikSourceCriterionSchema,
  'redis?': TraefikRateLimitRedisSchema,
});

/** Token-bucket rate limit. */
export type TraefikRateLimitMiddleware = typeof TraefikRateLimitMiddlewareSchema.infer;

/** Cap on requests being handled concurrently, per source. */
export const TraefikInFlightReqMiddlewareSchema = type({
  'amount?': 'number.integer >= 0',
  'sourceCriterion?': TraefikSourceCriterionSchema,
});

/** Cap on requests being handled concurrently, per source. */
export type TraefikInFlightReqMiddleware = typeof TraefikInFlightReqMiddlewareSchema.infer;

/**
 * CORS and browser security headers.
 *
 * The CRD's `sslRedirect`, `sslTemporaryRedirect`, `sslHost` and `sslForceHost`
 * are deliberately absent: Traefik v3 dropped them in favour of the
 * `redirectScheme` middleware, and the CRD keeps them only for v2 manifests.
 */
export const TraefikHeadersMiddlewareSchema = type({
  'customRequestHeaders?': 'Record<string, string>',
  'customResponseHeaders?': 'Record<string, string>',
  'accessControlAllowCredentials?': 'boolean',
  'accessControlAllowHeaders?': 'string[]',
  'accessControlAllowMethods?': 'string[]',
  'accessControlAllowOriginList?': 'string[]',
  'accessControlAllowOriginListRegex?': 'string[]',
  'accessControlExposeHeaders?': 'string[]',
  'accessControlMaxAge?': 'number.integer',
  'addVaryHeader?': 'boolean',
  'allowedHosts?': 'string[]',
  'hostsProxyHeaders?': 'string[]',
  'sslProxyHeaders?': 'Record<string, string>',
  'stsSeconds?': 'number.integer >= 0',
  'stsIncludeSubdomains?': 'boolean',
  'stsPreload?': 'boolean',
  'forceSTSHeader?': 'boolean',
  'frameDeny?': 'boolean',
  'customFrameOptionsValue?': 'string',
  'contentTypeNosniff?': 'boolean',
  'browserXssFilter?': 'boolean',
  'customBrowserXSSValue?': 'string',
  'contentSecurityPolicy?': 'string',
  'contentSecurityPolicyReportOnly?': 'string',
  'publicKey?': 'string',
  'referrerPolicy?': 'string',
  'permissionsPolicy?': 'string',
  'featurePolicy?': 'string',
  /** Relaxes header enforcement for local development. Never enable in production. */
  'isDevelopment?': 'boolean',
});

/** CORS and browser security headers. */
export type TraefikHeadersMiddleware = typeof TraefikHeadersMiddlewareSchema.infer;

/** Redirect a request to another scheme, e.g. `web` → `websecure`. */
export const TraefikRedirectSchemeMiddlewareSchema = type({
  scheme: '"http" | "https"',
  'port?': 'string',
  'permanent?': 'boolean',
});

/** Redirect a request to another scheme. */
export type TraefikRedirectSchemeMiddleware = typeof TraefikRedirectSchemeMiddlewareSchema.infer;

/** Regex-based redirect. */
export const TraefikRedirectRegexMiddlewareSchema = type({
  regex: 'string',
  replacement: 'string',
  'permanent?': 'boolean',
});

/** Regex-based redirect. */
export type TraefikRedirectRegexMiddleware = typeof TraefikRedirectRegexMiddlewareSchema.infer;

/** Remove one of `prefixes` from the request path before forwarding. */
export const TraefikStripPrefixMiddlewareSchema = type({
  prefixes: 'string[]',
  'forceSlash?': 'boolean',
});

/** Remove one of `prefixes` from the request path before forwarding. */
export type TraefikStripPrefixMiddleware = typeof TraefikStripPrefixMiddlewareSchema.infer;

/** Remove a regex-matched prefix from the request path. */
export const TraefikStripPrefixRegexMiddlewareSchema = type({
  regex: 'string[]',
});

/** Remove a regex-matched prefix from the request path. */
export type TraefikStripPrefixRegexMiddleware =
  typeof TraefikStripPrefixRegexMiddlewareSchema.infer;

/** Prepend a prefix to the request path. */
export const TraefikAddPrefixMiddlewareSchema = type({
  prefix: 'string',
});

/** Prepend a prefix to the request path. */
export type TraefikAddPrefixMiddleware = typeof TraefikAddPrefixMiddlewareSchema.infer;

/** Replace the whole request path. */
export const TraefikReplacePathMiddlewareSchema = type({
  path: 'string',
});

/** Replace the whole request path. */
export type TraefikReplacePathMiddleware = typeof TraefikReplacePathMiddlewareSchema.infer;

/** Replace a regex-matched request path. */
export const TraefikReplacePathRegexMiddlewareSchema = type({
  regex: 'string',
  replacement: 'string',
});

/** Replace a regex-matched request path. */
export type TraefikReplacePathRegexMiddleware =
  typeof TraefikReplacePathRegexMiddlewareSchema.infer;

/**
 * Body buffering and size limits.
 *
 * `maxRequestBodyBytes` is the request-size cap an edge needs so an upstream
 * cannot be flooded; a `retryExpression` requires buffering to be able to
 * replay the body.
 */
export const TraefikBufferingMiddlewareSchema = type({
  'maxRequestBodyBytes?': 'number.integer',
  'memRequestBodyBytes?': 'number.integer',
  'maxResponseBodyBytes?': 'number.integer',
  'memResponseBodyBytes?': 'number.integer',
  'retryExpression?': 'string',
});

/** Body buffering and size limits. */
export type TraefikBufferingMiddleware = typeof TraefikBufferingMiddlewareSchema.infer;

/** Retry a request against the next available server. */
export const TraefikRetryMiddlewareSchema = type({
  'attempts?': 'number.integer >= 0',
  'initialInterval?': traefikDuration,
  'timeout?': traefikDuration,
  'status?': 'string[]',
  /** `-1` means unlimited, which is the CRD's own minimum. */
  'maxRequestBodyBytes?': 'number.integer >= -1',
  'disableRetryOnNetworkError?': 'boolean',
  'retryNonIdempotentMethod?': 'boolean',
});

/** Retry a request against the next available server. */
export type TraefikRetryMiddleware = typeof TraefikRetryMiddlewareSchema.infer;

/** Trip a circuit when the guard expression evaluates true. */
export const TraefikCircuitBreakerMiddlewareSchema = type({
  'expression?': 'string',
  'checkPeriod?': traefikDuration,
  'fallbackDuration?': traefikDuration,
  'recoveryDuration?': traefikDuration,
  'responseCode?': '100 <= number.integer <= 599',
});

/** Trip a circuit when the guard expression evaluates true. */
export type TraefikCircuitBreakerMiddleware = typeof TraefikCircuitBreakerMiddlewareSchema.infer;

/** Allow only the listed source ranges. */
export const TraefikIpAllowListMiddlewareSchema = type({
  sourceRange: 'string[]',
  'ipStrategy?': TraefikIpStrategySchema,
  'rejectStatusCode?': 'number.integer',
});

/** Allow only the listed source ranges. */
export type TraefikIpAllowListMiddleware = typeof TraefikIpAllowListMiddlewareSchema.infer;

/** HTTP basic or digest auth backed by a Secret of htpasswd users. */
export const TraefikCredentialAuthMiddlewareSchema = type({
  /** Secret containing a `users` key in htpasswd format. */
  secret: 'string',
  'realm?': 'string',
  'removeHeader?': 'boolean',
  'headerField?': 'string',
});

/** HTTP basic or digest auth backed by a Secret of htpasswd users. */
export type TraefikCredentialAuthMiddleware = typeof TraefikCredentialAuthMiddlewareSchema.infer;

/** Response compression. */
export const TraefikCompressMiddlewareSchema = type({
  'encodings?': 'string[]',
  'defaultEncoding?': 'string',
  'includedContentTypes?': 'string[]',
  'excludedContentTypes?': 'string[]',
  'minResponseBodyBytes?': 'number.integer >= 0',
});

/** Response compression. */
export type TraefikCompressMiddleware = typeof TraefikCompressMiddlewareSchema.infer;

/**
 * Serve custom error pages from another service.
 *
 * `service` is required although the CRD allows it to be absent: without a
 * backend there is nothing to serve the error page from.
 */
export const TraefikErrorsMiddlewareSchema = type({
  'status?': 'string[]',
  /** Rewrites are HTTP status codes, which the CRD types as integers. */
  'statusRewrites?': 'Record<string, number.integer>',
  'query?': 'string',
  service: TraefikServiceRefSchema,
  /** Client headers forwarded to the error-page service. */
  'errorRequestHeaders?': 'string[]',
});

/** Serve custom error pages from another service. */
export type TraefikErrorsMiddleware = typeof TraefikErrorsMiddlewareSchema.infer;

/** Apply an ordered list of other middlewares. */
export const TraefikChainMiddlewareSchema = type({
  middlewares: TraefikMiddlewareRefSchema.array(),
});

/** Apply an ordered list of other middlewares. */
export type TraefikChainMiddleware = typeof TraefikChainMiddlewareSchema.infer;

/** Forward client-certificate information to the upstream. */
export const TraefikPassTLSClientCertMiddlewareSchema = type({
  'pem?': 'boolean',
  'info?': {
    'notAfter?': 'boolean',
    'notBefore?': 'boolean',
    'sans?': 'boolean',
    'serialNumber?': 'boolean',
    'subject?': {
      'commonName?': 'boolean',
      'country?': 'boolean',
      'domainComponent?': 'boolean',
      'locality?': 'boolean',
      'organization?': 'boolean',
      'organizationalUnit?': 'boolean',
      'province?': 'boolean',
      'serialNumber?': 'boolean',
    },
    /** The CRD's issuer block has no `organizationalUnit`. */
    'issuer?': {
      'commonName?': 'boolean',
      'country?': 'boolean',
      'domainComponent?': 'boolean',
      'locality?': 'boolean',
      'organization?': 'boolean',
      'province?': 'boolean',
      'serialNumber?': 'boolean',
    },
  },
});

/** Forward client-certificate information to the upstream. */
export type TraefikPassTLSClientCertMiddleware =
  typeof TraefikPassTLSClientCertMiddlewareSchema.infer;

/** Auto-detect the response `Content-Type` when the upstream omits it. */
export const TraefikContentTypeMiddlewareSchema = type({
  'autoDetect?': 'boolean',
});

/** Auto-detect the response `Content-Type` when the upstream omits it. */
export type TraefikContentTypeMiddleware = typeof TraefikContentTypeMiddlewareSchema.infer;

/** Allow otherwise-rejected percent-encoded characters in the request path. */
export const TraefikEncodedCharactersMiddlewareSchema = type({
  'allowEncodedSlash?': 'boolean',
  'allowEncodedBackSlash?': 'boolean',
  'allowEncodedNullCharacter?': 'boolean',
  'allowEncodedSemicolon?': 'boolean',
  'allowEncodedPercent?': 'boolean',
  'allowEncodedQuestionMark?': 'boolean',
  'allowEncodedHash?': 'boolean',
});

/** Allow otherwise-rejected percent-encoded characters in the request path. */
export type TraefikEncodedCharactersMiddleware =
  typeof TraefikEncodedCharactersMiddlewareSchema.infer;

/** Bridge gRPC-Web clients to a gRPC upstream. */
export const TraefikGrpcWebMiddlewareSchema = type({
  'allowOrigins?': 'string[]',
});

/** Bridge gRPC-Web clients to a gRPC upstream. */
export type TraefikGrpcWebMiddleware = typeof TraefikGrpcWebMiddlewareSchema.infer;

/**
 * A Traefik plugin middleware.
 *
 * Keyed by the plugin name declared in `experimental.plugins`; the value shape
 * belongs to the plugin itself. This is one of the boundaries where `unknown`
 * is correct rather than lazy — the CRD marks it
 * `x-kubernetes-preserve-unknown-fields`, so there is no schema to model.
 */
export const TraefikPluginMiddlewareSchema = type('Record<string, unknown>');

/** A Traefik plugin middleware, keyed by plugin name. */
export type TraefikPluginMiddleware = typeof TraefikPluginMiddlewareSchema.infer;

/**
 * Every OSS middleware keyed by its CRD field name, all keys optional.
 *
 * A `Middleware` object carries exactly one of them, which
 * {@link TraefikMiddlewareSpecSchema} enforces with `.narrow()` while keeping
 * this base object shape intact so KRO SimpleSchema generation can still
 * discover the fields.
 */
const TraefikMiddlewareSpecMapSchema = type({
  'addPrefix?': TraefikAddPrefixMiddlewareSchema,
  'basicAuth?': TraefikCredentialAuthMiddlewareSchema,
  'buffering?': TraefikBufferingMiddlewareSchema,
  'chain?': TraefikChainMiddlewareSchema,
  'circuitBreaker?': TraefikCircuitBreakerMiddlewareSchema,
  'compress?': TraefikCompressMiddlewareSchema,
  'contentType?': TraefikContentTypeMiddlewareSchema,
  'digestAuth?': TraefikCredentialAuthMiddlewareSchema,
  'encodedCharacters?': TraefikEncodedCharactersMiddlewareSchema,
  'errors?': TraefikErrorsMiddlewareSchema,
  'forwardAuth?': TraefikForwardAuthMiddlewareSchema,
  'grpcWeb?': TraefikGrpcWebMiddlewareSchema,
  'headers?': TraefikHeadersMiddlewareSchema,
  'inFlightReq?': TraefikInFlightReqMiddlewareSchema,
  'ipAllowList?': TraefikIpAllowListMiddlewareSchema,
  'passTLSClientCert?': TraefikPassTLSClientCertMiddlewareSchema,
  'plugin?': TraefikPluginMiddlewareSchema,
  'rateLimit?': TraefikRateLimitMiddlewareSchema,
  'redirectRegex?': TraefikRedirectRegexMiddlewareSchema,
  'redirectScheme?': TraefikRedirectSchemeMiddlewareSchema,
  'replacePath?': TraefikReplacePathMiddlewareSchema,
  'replacePathRegex?': TraefikReplacePathRegexMiddlewareSchema,
  'retry?': TraefikRetryMiddlewareSchema,
  'stripPrefix?': TraefikStripPrefixMiddlewareSchema,
  'stripPrefixRegex?': TraefikStripPrefixRegexMiddlewareSchema,
});

/** Every OSS middleware keyed by its CRD field name. */
export type TraefikMiddlewareSpecMap = AllPresent<typeof TraefikMiddlewareSpecMapSchema.infer>;

/** The name of one middleware kind. */
export type TraefikMiddlewareKind = keyof TraefikMiddlewareSpecMap;

/**
 * `Middleware.spec` — exactly one middleware kind.
 *
 * The exactly-one invariant is a schema-level `.narrow()` rather than only a
 * factory guard, per `integration-skill.md` ("Schema invariants"): two keys in
 * one object is not a merge — Traefik applies one and silently drops the other.
 * The narrow delegates to {@link validateTraefikMiddlewareSpec} so the rule has
 * exactly one runtime implementation.
 */
export const TraefikMiddlewareSpecSchema = TraefikMiddlewareSpecMapSchema.narrow((data, ctx) => {
  const issues = validateTraefikMiddlewareSpec(data);
  return issues.length === 0 ? true : ctx.mustBe(issues.join(' '));
});

/**
 * Exactly one key of `TMap`, with every other key typed `never`.
 *
 * The compile-time counterpart to the schema's `.narrow()`: this is what makes
 * `{ forwardAuth: ..., rateLimit: ... }` a compile error.
 */
type ExactlyOne<TMap> = {
  [K in keyof TMap]: { readonly [P in K]: TMap[P] } & {
    readonly [P in Exclude<keyof TMap, K>]?: never;
  };
}[keyof TMap];

/** `Middleware.spec` — exactly one middleware kind. */
export type TraefikMiddlewareSpec = ExactlyOne<TraefikMiddlewareSpecMap>;

/**
 * Secure `forwardAuth` defaults applied by
 * `traefikForwardAuthMiddleware` (#172).
 *
 * @security `trustForwardHeader: false` means Traefik does not pass the
 * client's own `X-Forwarded-*` headers to the authorizer, so a caller cannot
 * assert its own identity or source address.
 */
export const TRAEFIK_FORWARD_AUTH_SECURE_DEFAULTS = {
  trustForwardHeader: false,
} as const;

// ============================================================================
// Resource configuration
//
// The identity half of every namespaced Traefik CRD factory's config. `spec`
// is the only part that varies by kind, so it stays a type parameter (see
// `resources/common.ts`) while everything a caller actually types by hand is
// declared once, here, and inferred from.
// ============================================================================

/**
 * Identity of a namespaced Traefik CRD, without its behaviour.
 *
 * Extracted as a shape rather than re-declared per factory so the middleware
 * builders' configs and {@link TraefikResourceConfig} cannot drift apart.
 *
 * These schemas are the source of truth for the TYPES and the target of the
 * schema tests; the factories do not run them over their input, because inside
 * a composition `name` may be a `KubernetesRef` proxy rather than a string and
 * every one of these constraints would reject it.
 */
export const traefikResourceMetadataShape = {
  name: kubernetesName,
  namespace: kubernetesDnsLabel,
  /** Extra labels merged onto the managed label set. */
  'labels?': 'Record<string, string>',
  'annotations?': 'Record<string, string>',
  /** Resource graph id. Required when `name` is a schema reference. */
  'id?': 'string > 0',
} as const;

/** Identity of a namespaced Traefik CRD, without its behaviour. */
export const TraefikResourceMetadataSchema = type(traefikResourceMetadataShape);

/** Identity of a namespaced Traefik CRD, without its behaviour. */
export type TraefikResourceMetadata = typeof TraefikResourceMetadataSchema.infer;

/**
 * Configuration for `traefikGatewayClass`.
 *
 * A `GatewayClass` is cluster-scoped, and its spec is pinned to Traefik's
 * controller by the factory rather than supplied by the caller, so this config
 * is the shared Gateway API identity shape plus one Traefik-specific field —
 * fully inferred, with no `spec` to parameterise.
 */
export const TraefikGatewayClassConfigSchema = type({
  ...gatewayApiClusterResourceMetadataShape,
  /** Optional description recorded on the class. */
  'description?': 'string > 0',
});

/** Configuration for `traefikGatewayClass`. */
export type TraefikGatewayClassConfig = typeof TraefikGatewayClassConfigSchema.infer;

/** Identity of a `Middleware`, without its behavior. */
export const TraefikMiddlewareMetadataSchema = TraefikResourceMetadataSchema;

/** Identity of a `Middleware`, without its behavior. */
export type TraefikMiddlewareMetadata = TraefikResourceMetadata;

/**
 * Configuration for `traefikForwardAuthMiddleware`.
 *
 * `authResponseHeaders` is REQUIRED here although the CRD leaves it optional:
 * an implicit "copy everything" would let an authorizer bug leak headers to
 * the upstream, and a route with no allowlist silently drops the principal the
 * upstream expects.
 */
export const TraefikForwardAuthMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  /** Authorizer URL, e.g. `http://authorizer.edge.svc.cluster.local:8080/authorize`. */
  address: 'string > 0',
  /** Headers copied from the authorizer's 2xx response onto the upstream request. */
  authResponseHeaders: 'string[]',
  /** Client headers forwarded to the authorizer. Omit to forward all of them. */
  'authRequestHeaders?': 'string[]',
  /**
   * @security Defaults to `false`. Only enable when every client reaching this
   * entrypoint is already behind a trusted proxy that rewrites
   * `X-Forwarded-*`; otherwise a caller can assert its own source address.
   */
  'trustForwardHeader?': 'boolean',
  'forwardBody?': 'boolean',
  'maxBodySize?': 'number.integer',
  'tls?': middlewareClientTlsShape,
});

/** Configuration for `traefikForwardAuthMiddleware`. */
export type TraefikForwardAuthMiddlewareConfig =
  typeof TraefikForwardAuthMiddlewareConfigSchema.infer;

/** Every way a rate/concurrency budget can be keyed. Exactly one, or none. */
const middlewareBudgetKeyShape = {
  /**
   * Request header the budget is keyed on — typically the principal or tenant
   * header a preceding `forwardAuth` produced. Mutually exclusive with
   * `sourceCriterion`.
   */
  'requestHeaderName?': 'string > 0',
  /** Full source-criterion form, for IP-strategy or host keying. */
  'sourceCriterion?': TraefikSourceCriterionSchema,
} as const;

/**
 * Reject a config that keys its budget two ways at once.
 *
 * `requestHeaderName` is sugar for `sourceCriterion.requestHeaderName`, so
 * setting both is not a merge: the builder keeps `sourceCriterion` and
 * silently drops the header name, which is the kind of quiet substitution the
 * exactly-one middleware narrow exists to prevent. The rule was prose until
 * now; the schema is where it belongs.
 */
function narrowBudgetKey(
  data: { requestHeaderName?: string | undefined; sourceCriterion?: unknown },
  ctx: { mustBe: (expected: string) => false }
): boolean {
  if (data.requestHeaderName !== undefined && data.sourceCriterion !== undefined) {
    return ctx.mustBe(
      'keyed either by requestHeaderName or by sourceCriterion, not both ' +
        '(requestHeaderName is shorthand for sourceCriterion.requestHeaderName)'
    );
  }
  return true;
}

/** Configuration for `traefikRateLimitMiddleware`. */
export const TraefikRateLimitMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  ...middlewareBudgetKeyShape,
  /** Sustained requests allowed per `period`. */
  average: 'number.integer >= 0',
  /** Requests absorbed above `average` before Traefik answers 429. */
  burst: 'number.integer >= 0',
  /** Window `average` is measured over. @default '1s' */
  'period?': 'string > 0',
  /**
   * Shared Redis/Valkey backend. Without it each Traefik replica counts
   * independently, so the effective budget is `average x replicas`.
   */
  'redis?': TraefikRateLimitRedisSchema,
}).narrow(narrowBudgetKey);

/** Configuration for `traefikRateLimitMiddleware`. */
export type TraefikRateLimitMiddlewareConfig = typeof TraefikRateLimitMiddlewareConfigSchema.infer;

/** Configuration for `traefikInFlightReqMiddleware`. */
export const TraefikInFlightReqMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  ...middlewareBudgetKeyShape,
  /** Maximum requests handled concurrently per source. */
  amount: 'number.integer >= 0',
}).narrow(narrowBudgetKey);

/** Configuration for `traefikInFlightReqMiddleware`. */
export type TraefikInFlightReqMiddlewareConfig =
  typeof TraefikInFlightReqMiddlewareConfigSchema.infer;

/** Configuration for `traefikHeadersMiddleware`. */
export const TraefikHeadersMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  headers: TraefikHeadersMiddlewareSchema,
});

/** Configuration for `traefikHeadersMiddleware`. */
export type TraefikHeadersMiddlewareConfig = typeof TraefikHeadersMiddlewareConfigSchema.infer;

/** Configuration for `traefikRedirectSchemeMiddleware`. */
export const TraefikRedirectSchemeMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  /** @default 'https' */
  'scheme?': '"http" | "https"',
  /** @default true */
  'permanent?': 'boolean',
  'port?': 'string > 0',
});

/** Configuration for `traefikRedirectSchemeMiddleware`. */
export type TraefikRedirectSchemeMiddlewareConfig =
  typeof TraefikRedirectSchemeMiddlewareConfigSchema.infer;

/** Configuration for `traefikBufferingMiddleware`. */
export const TraefikBufferingMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  buffering: TraefikBufferingMiddlewareSchema,
});

/** Configuration for `traefikBufferingMiddleware`. */
export type TraefikBufferingMiddlewareConfig = typeof TraefikBufferingMiddlewareConfigSchema.infer;

/** Configuration for `traefikChainMiddleware`. */
export const TraefikChainMiddlewareConfigSchema = type({
  ...traefikResourceMetadataShape,
  /** Middlewares applied in order. */
  middlewares: TraefikMiddlewareRefSchema.array(),
});

/** Configuration for `traefikChainMiddleware`. */
export type TraefikChainMiddlewareConfig = typeof TraefikChainMiddlewareConfigSchema.infer;

// ============================================================================
// Helm chart values
//
// `TraefikManagedHelmValues` is CLOSED: no index signatures, at any depth. It
// describes exactly the chart paths this factory maps, pins or reads back,
// verified against chart 41.5.0's `values.schema.json`. Everything else in the
// chart's surface reaches Helm through the ONE named raw boundary,
// `TraefikRawHelmValues` — the escape hatch `integration-skill.md` permits for
// raw passthrough.
// ============================================================================

/** Kubernetes Service type usable for the Traefik entrypoint Service. */
export type TraefikServiceType = 'LoadBalancer' | 'NodePort' | 'ClusterIP';

/** A pod or container seccomp profile. */
export interface TraefikSeccompProfile {
  type: 'RuntimeDefault' | 'Unconfined' | 'Localhost';
  localhostProfile?: string;
}

/**
 * Pod-level security context (chart `podSecurityContext`).
 *
 * Extends the repository's shared {@link SecurityContext} with the seccomp
 * profile the chart exposes and this factory pins.
 */
export interface TraefikPodSecurityContext extends SecurityContext {
  seccompProfile?: TraefikSeccompProfile;
}

/**
 * Container-level security context (chart `securityContext`).
 *
 * Extends the shared {@link SecurityContext} with the container-only fields
 * this factory pins: no privilege escalation, a read-only root filesystem, and
 * all capabilities dropped.
 */
export interface TraefikContainerSecurityContext extends SecurityContext {
  allowPrivilegeEscalation?: boolean;
  readOnlyRootFilesystem?: boolean;
  privileged?: boolean;
  capabilities?: {
    add?: string[];
    drop?: string[];
  };
  seccompProfile?: TraefikSeccompProfile;
}

/** One `topologySpreadConstraints[]` entry as the chart forwards it. */
export interface TraefikTopologySpreadConstraint {
  maxSkew: number;
  topologyKey: string;
  whenUnsatisfiable: 'DoNotSchedule' | 'ScheduleAnyway';
  labelSelector?: LabelSelector;
  minDomains?: number;
  matchLabelKeys?: string[];
  nodeAffinityPolicy?: 'Honor' | 'Ignore';
  nodeTaintsPolicy?: 'Honor' | 'Ignore';
}

/** TLS material an OTLP exporter presents to the collector. */
export interface TraefikOtlpTlsValues {
  ca?: string;
  cert?: string;
  key?: string;
  insecureSkipVerify?: boolean;
}

/** OTLP exporter shape shared by the chart's log/accessLog/metrics/tracing keys. */
export interface TraefikOtlpValues {
  enabled?: boolean;
  serviceName?: string;
  resourceAttributes?: Record<string, string>;
  http?: {
    enabled?: boolean;
    endpoint?: string;
    headers?: Record<string, string>;
    tls?: TraefikOtlpTlsValues;
  };
  grpc?: {
    enabled?: boolean;
    endpoint?: string;
    insecure?: boolean;
    tls?: TraefikOtlpTlsValues;
  };
}

/** One entry of the chart's `ports` map (an entrypoint). */
export interface TraefikPortValues {
  port?: number;
  exposedPort?: number;
  containerPort?: number;
  targetPort?: TraefikPortValue;
  nodePort?: number;
  protocol?: 'TCP' | 'UDP';
  asDefault?: boolean;
  expose?: { default?: boolean };
  http?: {
    redirections?: {
      entryPoint?: {
        to?: string;
        scheme?: 'http' | 'https';
        permanent?: boolean;
        priority?: number;
      };
    };
    middlewares?: string[];
    maxHeaderBytes?: number;
    sanitizePath?: boolean;
    /**
     * TLS termination for the entrypoint. Nested under `http`, which is where
     * chart 41.5.0's `values.schema.json` puts it — `ports.<name>.tls` is
     * rejected by the schema (`additionalProperties 'tls' not allowed`).
     */
    tls?: {
      enabled?: boolean;
      options?: string;
      certResolver?: string;
      domains?: { main?: string; sans?: string[] }[];
    };
  };
  forwardedHeaders?: {
    trustedIPs?: string[];
    insecure?: boolean;
    notAppendXForwardedFor?: boolean;
  };
  proxyProtocol?: { trustedIPs?: string[]; insecure?: boolean };
  /** Entrypoint-level timeouts. Raise these for requests longer than 60s. */
  transport?: {
    respondingTimeouts?: {
      readTimeout?: TraefikDuration;
      writeTimeout?: TraefikDuration;
      idleTimeout?: TraefikDuration;
    };
    lifeCycle?: {
      requestAcceptGraceTimeout?: TraefikDuration;
      graceTimeOut?: TraefikDuration;
    };
    keepAliveMaxRequests?: number;
    keepAliveMaxTime?: TraefikDuration;
  };
}

/**
 * Plugin declarations for `experimental.plugins`.
 *
 * Each plugin owns its own value shape, so this stays an `unknown` map by
 * necessity — the same boundary as {@link TraefikPluginMiddleware}.
 */
export const TraefikPluginChartConfigSchema = type('Record<string, unknown>');

/** Plugin declarations for `experimental.plugins`, keyed by plugin name. */
export type TraefikPluginChartConfig = typeof TraefikPluginChartConfigSchema.infer;

/**
 * The chart values this factory maps, pins, or reads back — a CLOSED type.
 *
 * Nothing here has an index signature: if a chart path is not listed, this
 * factory does not model it and it belongs in {@link TraefikRawHelmValues}.
 * That is what makes `applyTraefikSecurityPins`' precedence auditable — every
 * pinned path is a named field with a known type, so a pin that stopped
 * matching the chart would be a compile error rather than a silent no-op.
 *
 * Note the shapes that changed in the 3x chart line and are easy to get wrong:
 * the Service type lives under `service.spec.type` (not `service.type`), and
 * the Gateway API provider is `providers.kubernetesGateway`.
 */
export interface TraefikManagedHelmValues {
  image?: { registry?: string; repository?: string; tag?: string; pullPolicy?: string };
  commonLabels?: Record<string, string>;
  deployment?: {
    enabled?: boolean;
    kind?: 'Deployment' | 'DaemonSet';
    replicas?: number;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    podAnnotations?: Record<string, string>;
    podLabels?: Record<string, string>;
    terminationGracePeriodSeconds?: number;
    minReadySeconds?: number;
    revisionHistoryLimit?: number;
  };
  /** @security Pinned off by the values mapper. */
  api?: {
    dashboard?: boolean;
    insecure?: boolean;
    debug?: boolean;
    basePath?: string;
    disableDashboardAd?: boolean;
  };
  /** @security Pinned off by the values mapper. */
  ingressRoute?: {
    dashboard?: { enabled?: boolean };
    healthcheck?: { enabled?: boolean };
  };
  ingressClass?: { enabled?: boolean; isDefaultClass?: boolean; name?: string };
  providers?: {
    kubernetesCRD?: {
      enabled?: boolean;
      ingressClass?: string;
      namespaces?: string[];
      allowCrossNamespace?: boolean;
      allowExternalNameServices?: boolean;
      allowEmptyServices?: boolean;
      nativeLBByDefault?: boolean;
      defaultTLSResourcesNamespace?: string;
    };
    kubernetesIngress?: {
      enabled?: boolean;
      ingressClass?: string;
      namespaces?: string[];
      allowExternalNameServices?: boolean;
      allowEmptyServices?: boolean;
      /**
       * Service whose address Traefik copies onto `Ingress.status`. The chart
       * emits the flag only when it created the Service itself OR when
       * `pathOverride` names one — this factory owns the Service, so the mapper
       * always sets `pathOverride`.
       */
      publishedService?: { enabled?: boolean; pathOverride?: string };
    };
    kubernetesGateway?: {
      enabled?: boolean;
      experimentalChannel?: boolean;
      namespaces?: string[];
      statusAddress?: {
        service?: { name?: string; namespace?: string };
        ip?: string;
        hostname?: string;
      };
    };
    file?: { enabled?: boolean; watch?: boolean; content?: string };
  };
  gateway?: { enabled?: boolean; name?: string; namespace?: string };
  gatewayClass?: { enabled?: boolean; name?: string; labels?: Record<string, string> };
  log?: { level?: string; format?: string; filePath?: string; otlp?: TraefikOtlpValues };
  accessLog?: {
    enabled?: boolean;
    format?: string;
    filePath?: string;
    addInternals?: boolean;
    bufferingSize?: number;
    otlp?: TraefikOtlpValues;
  };
  metrics?: {
    addInternals?: boolean;
    otlp?: TraefikOtlpValues;
  };
  tracing?: {
    addInternals?: boolean;
    serviceName?: string;
    sampleRate?: number;
    otlp?: TraefikOtlpValues;
  };
  experimental?: { otlpLogs?: boolean; plugins?: TraefikPluginChartConfig };
  ports?: Record<string, TraefikPortValues>;
  service?: {
    /**
     * Pinned OFF by the values mapper: the bootstrap composition OWNS the
     * entrypoint Service so its address can be projected without reading an
     * unmanaged resource before anything has been applied.
     */
    enabled?: boolean;
    single?: boolean;
    nameOverride?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    /** The Service type lives here in chart 3x, not at `service.type`. */
    spec?: { type?: TraefikServiceType };
  };
  rbac?: { enabled?: boolean; namespaced?: boolean };
  /**
   * Pinned to the release name by the values mapper so the resource-name anchor
   * — and therefore the name of the Service this factory owns — is
   * deterministic instead of depending on the chart's fullname template.
   */
  fullnameOverride?: string;
  /**
   * Pinned to `TRAEFIK_POD_NAME_LABEL_VALUE`. Feeds the chart's
   * `app.kubernetes.io/name` pod label, which the owned Service selects on.
   */
  nameOverride?: string;
  /**
   * Pinned to the release name. Feeds the chart's `app.kubernetes.io/instance`
   * pod label — otherwise derived from the Helm release name, which Flux
   * composes from the HelmRelease name and target namespace — so the owned
   * Service's selector is exact and stable.
   */
  instanceLabelOverride?: string;
  serviceAccount?: { name?: string };
  serviceAccountAnnotations?: Record<string, string>;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  /** @security Pinned to a non-root, read-only-root-filesystem profile. */
  securityContext?: TraefikContainerSecurityContext;
  /** @security Pinned to a non-root profile. */
  podSecurityContext?: TraefikPodSecurityContext;
  additionalArguments?: string[];
  env?: EnvVar[];
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  affinity?: Affinity;
  topologySpreadConstraints?: TraefikTopologySpreadConstraint[];
  priorityClassName?: string;
  global?: { checkNewVersion?: boolean; sendAnonymousUsage?: boolean };
}

/**
 * The single raw Helm-values escape hatch.
 *
 * Chart surface this factory does not model reaches Helm through here
 * unchanged. `unknown` is correct at this boundary and nowhere else in the
 * values types: the shape belongs to whichever chart version is installed, so
 * TypeKro has nothing to validate it against.
 */
export type TraefikRawHelmValues = Record<string, unknown>;

/**
 * Chart values as they leave the mapper: the closed managed surface plus the
 * one raw passthrough boundary.
 *
 * Reading a managed path (`values.api?.dashboard`, `values.ports?.web`) is
 * fully typed; an unmodelled chart key is accepted but carries no type, which
 * is precisely the trade this split makes explicit.
 */
export type TraefikHelmValues = TraefikManagedHelmValues & TraefikRawHelmValues;

/** Chart values accepted by {@link TraefikHelmReleaseConfig}. */
export type TraefikMappedHelmValues = TypeKroChartValues<TraefikHelmValues>;

// ============================================================================
// Helm resource configuration
// ============================================================================

/**
 * A Go duration as Flux's helm-controller parses it: one or more
 * `<number><unit>` segments, e.g. `'1h'`, `'5m'`, `'90s'`, `'1h30m'`.
 *
 * Encoded as a schema constraint rather than a bare `string` because Flux
 * rejects a malformed interval at ADMISSION — the HelmRelease is created and
 * then never reconciles, which reads in the cluster as "Flux is broken"
 * rather than as a typo.
 */
const fluxDuration = type(/^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h))+$/);

/**
 * CRD policy accepted by the Flux helm-controller.
 *
 * Kept as a literal union in the schema and re-stated as
 * {@link HelmReleaseCrdsPolicy} in `factories/helm/types.ts`; the assertion
 * below is what keeps the two from drifting.
 */
const helmReleaseCrdsPolicy = '"Skip" | "Create" | "CreateReplace"';

/** Configuration for the Traefik `HelmRepository`. */
export const TraefikHelmRepositoryConfigSchema = type({
  name: kubernetesName,
  /** Flux namespace holding the repository. Defaults to the Flux namespace. */
  'namespace?': kubernetesDnsLabel,
  /** @default DEFAULT_TRAEFIK_REPOSITORY_URL */
  'url?': 'string > 0',
  /** @default '1h' */
  'interval?': fluxDuration,
  'id?': 'string > 0',
});

/** Configuration for the Traefik `HelmRepository`. */
export type TraefikHelmRepositoryConfig = typeof TraefikHelmRepositoryConfigSchema.infer;

/**
 * Configuration for the Traefik `HelmRelease`, minus `values`.
 *
 * @see TraefikHelmReleaseConfig for why `values` is declared separately.
 */
export const TraefikHelmReleaseConfigSchema = type({
  name: kubernetesName,
  /** Namespace of the HelmRelease object. Defaults to the Flux namespace. */
  'namespace?': kubernetesDnsLabel,
  /** Namespace Traefik itself is installed into. */
  'targetNamespace?': kubernetesDnsLabel,
  /** @default DEFAULT_TRAEFIK_CHART_VERSION */
  'version?': 'string > 0',
  /** @default DEFAULT_TRAEFIK_REPOSITORY_NAME */
  'repositoryName?': kubernetesDnsLabel,
  'repositoryNamespace?': kubernetesDnsLabel,
  /** @default '5m' */
  'interval?': fluxDuration,
  /** @default '10m' */
  'timeout?': fluxDuration,
  /** Whether Flux should create `targetNamespace`. @default false */
  'createNamespace?': 'boolean',
  /**
   * CRD policy applied to BOTH `install.crds` and `upgrade.crds`.
   *
   * Flux defaults `upgrade.crds` to `Skip`, which would leave the CRDs of the
   * first-installed chart version in place across a chart bump.
   *
   * @default DEFAULT_TRAEFIK_CRDS_POLICY (`'CreateReplace'`)
   */
  'crds?': helmReleaseCrdsPolicy,
  'id?': 'string > 0',
});

/**
 * Configuration for the Traefik `HelmRelease`.
 *
 * **Accepted exception to schema-first inference, for `values` only.** Every
 * other field is inferred from {@link TraefikHelmReleaseConfigSchema}. `values`
 * is typed {@link TraefikMappedHelmValues}, which is
 * `TypeKroChartValues<TraefikHelmValues>` — a union of the chart values with
 * `KubernetesRef`/`CelExpression` PROXY types. Those describe graph wiring
 * that exists only at build time, not data an ArkType schema could validate at
 * runtime: by the time this object reaches Flux the refs are resolved, and
 * while it is being built the tree is deliberately not plain JSON. A schema
 * field here could only be `unknown`, which would erase the typed chart
 * surface the mapper exists to provide. The values themselves ARE schema-
 * checked — one level down, by {@link TraefikManagedHelmValues} and the
 * mapper's own tests.
 */
export type TraefikHelmReleaseConfig = typeof TraefikHelmReleaseConfigSchema.infer & {
  readonly values?: TraefikMappedHelmValues;
};

// ============================================================================
// Bootstrap composition contract (ArkType)
// ============================================================================

const traefikServiceTypeSchema = '"LoadBalancer" | "NodePort" | "ClusterIP"';

/**
 * Runtime spec of the `traefikBootstrap` composition.
 *
 * Only proxy-safe values live here. `dashboard` is typed as the literal
 * `false`: the dashboard and the insecure API are not switchable through this
 * contract, and the values mapper pins them off regardless (#172).
 */
export const TraefikBootstrapConfigSchema = type({
  name: kubernetesName,
  'namespace?': kubernetesDnsLabel,
  'chartVersion?': 'string > 0',
  'replicas?': 'number.integer >= 1',
  'ingressClass?': kubernetesDnsLabel,
  'service?': {
    'type?': traefikServiceTypeSchema,
    /** Cloud load-balancer annotations. */
    'annotations?': 'Record<string, string>',
  },
  /**
   * Published ports and timeouts of the two entrypoints this edge exposes.
   *
   * Both are always published by the Service this composition owns: whether a
   * port EXISTS is structural, so it cannot come from a runtime value that may
   * be a schema reference. Use the build-time `values` passthrough for a
   * chart-level entrypoint this factory does not model.
   */
  'entrypoints?': {
    'web?': {
      'exposedPort?': kubernetesPort,
    },
    'websecure?': {
      'exposedPort?': kubernetesPort,
      /** Entrypoint responding timeouts, for requests longer than 60s. */
      'readTimeout?': 'string > 0',
      'writeTimeout?': 'string > 0',
      'idleTimeout?': 'string > 0',
    },
  },
  'providers?': {
    'crd?': 'boolean',
    'gatewayApi?': 'boolean',
    'kubernetesIngress?': 'boolean',
  },
  'accessLogs?': 'boolean',
  'logLevel?': '"TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" | "PANIC"',
  'otlp?': {
    /**
     * OTLP gRPC endpoint, `host:port`. Its presence is what enables metrics
     * and tracing export; omit the whole block to disable both.
     */
    endpoint: 'string > 0',
    /**
     * Send OTLP without TLS. Defaults to `true` because the collector is
     * normally a same-cluster Service reached over the pod network; set it to
     * `false` for a collector that terminates TLS.
     */
    'insecure?': 'boolean',
    'serviceName?': 'string > 0',
  },
  /** @security Only `false` is representable. */
  'dashboard?': 'false',
});

/** Inferred runtime spec of {@link TraefikBootstrapConfigSchema}. */
export type TraefikBootstrapConfig = typeof TraefikBootstrapConfigSchema.infer;

/**
 * Status contract of the `traefikBootstrap` composition.
 *
 * `loadBalancer` mirrors the entrypoint Service's
 * `status.loadBalancer.ingress[0]` and stays empty for `ClusterIP` /
 * `NodePort` services or while a cloud controller is still provisioning an
 * address.
 *
 * `version` is the chart version Flux actually installed, read back from the
 * owned `HelmRelease`'s `status.history[]` — an OBSERVED value rather than the
 * requested one, so a pinned-but-unavailable version can never be reported as
 * though it were live. It is empty until Flux records its first release.
 *
 * EVERY field here is a projection of a resource this composition owns, so it
 * hydrates identically in direct and KRO mode. That rules out literals: KRO
 * drops literal status fields, so declaring one would require a field the
 * instance never carries (#188). The entrypoint NAMES are therefore not in
 * this contract — they are fixed by this composition and exported as
 * `TRAEFIK_WEB_ENTRYPOINT` / `TRAEFIK_WEBSECURE_ENTRYPOINT` instead. Read the
 * live port names off the Service named by `serviceName` if a consumer needs
 * them at runtime.
 */
export const TraefikBootstrapStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  loadBalancer: {
    hostname: 'string',
    ip: 'string',
  },
  serviceName: 'string',
  version: 'string',
});

/** Inferred status of {@link TraefikBootstrapStatusSchema}. */
export type TraefikBootstrapStatus = typeof TraefikBootstrapStatusSchema.infer;

/** Spec of the shared `HelmRepository` singleton composition. */
export const TraefikHelmRepositorySingletonSpecSchema = type({
  name: kubernetesDnsLabel,
  namespace: kubernetesDnsLabel,
  url: 'string > 0',
});

/** Status of the shared `HelmRepository` singleton composition. */
export const TraefikHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

// ============================================================================
// Build-time options (construction, NOT runtime spec)
// ============================================================================

/** A default `TLSOption` owned by the bootstrap composition. */
export interface TraefikDefaultTlsOptionOptions {
  /** @default TRAEFIK_DEFAULT_TLS_OPTION_NAME */
  readonly name?: string;
  /** @default 'VersionTLS12' */
  readonly minVersion?: TraefikTLSOptionSpec['minVersion'];
  /** @default true */
  readonly sniStrict?: boolean;
  readonly cipherSuites?: readonly string[];
  readonly curvePreferences?: readonly string[];
  readonly clientAuth?: TraefikClientAuth;
}

/**
 * A default `TLSStore` owned by the bootstrap composition, so a cert-manager
 * `Certificate` can supply the certificate served when SNI matches nothing.
 */
export interface TraefikDefaultTlsStoreOptions {
  /** Secret written by a cert-manager `Certificate`. */
  readonly defaultCertificateSecretName: string;
  /** @default TRAEFIK_DEFAULT_TLS_STORE_NAME */
  readonly name?: string;
}

/**
 * Build-time options for {@link makeTraefikBootstrap}.
 *
 * These decide WHICH resources the graph contains or how the values tree is
 * shaped, so they must be concrete at construction time. Plain JavaScript
 * branches on them are safe; branching on the runtime spec is not.
 */
export interface TraefikBootstrapBuildOptions {
  /** Composition name. @default 'traefik-bootstrap' */
  readonly name?: string;
  /** KRO kind. @default 'TraefikBootstrap' */
  readonly kind?: string;
  /**
   * Lifecycle of the install namespace. Use `external` when a parent graph
   * already establishes it. @default 'owned'
   */
  readonly namespaceOwnership?: 'owned' | 'external';
  /**
   * Emit a permanent `web` → `websecure` redirect on the `web` entrypoint.
   *
   * Build-time rather than runtime spec because the chart disables the
   * redirect by the ABSENCE of `ports.web.http.redirections.entryPoint`, not by
   * a boolean — so it decides which configuration exists rather than what a
   * value is, and a schema reference could not express "no redirect".
   *
   * @default true
   */
  readonly redirectWebToWebsecure?: boolean;
  /** Create a cluster-default `TLSOption` alongside the release. */
  readonly defaultTlsOption?: TraefikDefaultTlsOptionOptions;
  /** Create a cluster-default `TLSStore` fed by a cert-manager Secret. */
  readonly defaultTlsStore?: TraefikDefaultTlsStoreOptions;
  /**
   * Flux CRD policy for the release, applied to `install.crds` AND
   * `upgrade.crds`.
   *
   * The default replaces the chart's `crds/` on every reconcile, which is what
   * keeps the `traefik.io/v1alpha1` CRDs in lockstep with the chart version.
   * Set `'Skip'` only when the CRDs are managed by something else — a
   * cluster-wide CRD pipeline, say — and accept that a chart bump then needs a
   * separate CRD rollout.
   *
   * @default DEFAULT_TRAEFIK_CRDS_POLICY (`'CreateReplace'`)
   */
  readonly crds?: HelmReleaseCrdsPolicy;
  /**
   * Raw chart values, merged BEFORE the mapped values and the security pins —
   * both of which win.
   *
   * This is the raw boundary, so it is typed as {@link TraefikRawHelmValues}
   * rather than as the managed surface: an override often has to reach a
   * SIBLING of a path TypeKro maps (`metrics.prometheus` next to the mapped
   * `metrics.otlp`, say), which a closed type would reject. Type safety on
   * this side of the boundary would be a fiction anyway — the shape belongs to
   * whichever chart version is installed. What TypeKro writes is checked
   * precisely; what a caller passes through is not, and the security pins
   * still overwrite it.
   *
   * **Build-time only, on purpose.** The guide's per-instance passthrough
   * pattern (a `spec.values` field serialized as
   * `json.unmarshal(json.marshal(schema.spec.values))` and merged last) does
   * not apply to this composition, because KRO's `map.merge()` is SHALLOW:
   * - merging raw values LAST would let any KRO instance re-enable
   *   `api.dashboard` / `api.insecure` or hand the entrypoint Service back to
   *   the chart, which this factory's contract (#172) forbids; and
   * - merging the pins last to prevent that would replace whole top-level
   *   sections, silently discarding a user's sibling keys under `api`,
   *   `ingressRoute`, `securityContext`, `podSecurityContext`, `service` and
   *   `global`.
   *
   * A values contract with non-negotiable pins therefore has to resolve
   * precedence at build time, where the merge can be deep and auditable. Pass
   * chart surface this factory does not model here, at construction.
   */
  readonly values?: TraefikRawHelmValues;
}
