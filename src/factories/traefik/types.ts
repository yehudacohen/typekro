/**
 * Traefik type definitions.
 *
 * Two distinct layers live here:
 *
 * 1. **CRD spec types** — hand-typed against the `traefik.io/v1alpha1` CRDs
 *    shipped by chart 41.5.0 (Traefik v3.7.13). None of the Traefik CRDs has a
 *    `status` subresource, which is why the resource factories register an
 *    always-ready evaluator (see `resources/routing.ts`).
 * 2. **ArkType schemas** — the runtime spec/status contract of the bootstrap
 *    composition. Following the ClickStack convention, these carry only
 *    proxy-safe VALUES (names, namespaces, versions, ports, endpoints) that
 *    serialize cleanly as CEL refs in KRO mode. Choices that decide WHICH
 *    resources exist are build-time options on `makeTraefikBootstrap(...)`.
 *
 * @see https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/crd/
 */

import { type } from 'arktype';
import type { TypeKroChartValues } from '../../core/types/common.js';
import type { HelmReleaseCrdsPolicy } from '../helm/types.js';

const kubernetesName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 40');
const kubernetesDnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');
const kubernetesPort = type('number.integer >= 1').and('number <= 65535');

// ============================================================================
// Shared primitives
// ============================================================================

/**
 * A Traefik duration. The CRDs accept an integer (nanoseconds) or a Go
 * duration string such as `'90s'`; prefer the string form for readability.
 */
export type TraefikDuration = string | number;

/** A Kubernetes Service port: a number or a named port. */
export type TraefikPortValue = string | number;

/** How Traefik derives the client IP from proxy headers. */
export interface TraefikIpStrategy {
  /** Depth position in `X-Forwarded-For`, counted from the right. */
  readonly depth?: number;
  readonly excludedIPs?: readonly string[];
  /** Group IPv6 clients into a shared subnet before keying. */
  readonly ipv6Subnet?: number;
}

/**
 * What a `rateLimit` / `inFlightReq` middleware keys its counters on.
 *
 * Exactly one of these should be set; Traefik falls back to the client IP when
 * none is given.
 */
export interface TraefikSourceCriterion {
  /** Key on a request header, e.g. the principal emitted by `forwardAuth`. */
  readonly requestHeaderName?: string;
  readonly requestHost?: boolean;
  readonly ipStrategy?: TraefikIpStrategy;
}

/** Sticky-session cookie configuration for a load-balanced service. */
export interface TraefikStickyCookie {
  readonly cookie?: {
    readonly name?: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly sameSite?: 'none' | 'lax' | 'strict' | 'None' | 'Lax' | 'Strict';
    readonly maxAge?: number;
    readonly path?: string;
    readonly domain?: string;
  };
}

/** Active health check performed by Traefik against a service's servers. */
export interface TraefikHealthCheck {
  readonly path?: string;
  readonly host?: string;
  readonly hostname?: string;
  readonly scheme?: string;
  readonly mode?: string;
  readonly method?: string;
  readonly status?: number;
  readonly port?: number;
  readonly interval?: TraefikDuration;
  readonly unhealthyInterval?: TraefikDuration;
  readonly timeout?: TraefikDuration;
  readonly headers?: Readonly<Record<string, string>>;
  readonly followRedirects?: boolean;
}

/** A reference to a `Middleware` resource. */
export interface TraefikMiddlewareRef {
  readonly name: string;
  readonly namespace?: string;
}

/** Load-balancing strategy across a service's servers. */
export type TraefikLoadBalancerStrategy = 'wrr' | 'p2c' | 'hrw' | 'leasttime' | 'RoundRobin';

/** One backend of an `IngressRoute` route or a `TraefikService`. */
export interface TraefikServiceRef {
  readonly name: string;
  readonly namespace?: string;
  readonly kind?: 'Service' | 'TraefikService';
  readonly port?: TraefikPortValue;
  readonly scheme?: string;
  readonly weight?: number;
  readonly strategy?: TraefikLoadBalancerStrategy;
  readonly passHostHeader?: boolean;
  readonly nativeLB?: boolean;
  readonly nodePortLB?: boolean;
  readonly serversTransport?: string;
  readonly sticky?: TraefikStickyCookie;
  readonly healthCheck?: TraefikHealthCheck;
  readonly passiveHealthCheck?: {
    readonly failureWindow?: TraefikDuration;
    readonly maxFailedAttempts?: number;
  };
  readonly responseForwarding?: { readonly flushInterval?: string };
  readonly middlewares?: readonly TraefikMiddlewareRef[];
}

/** TLS configuration attached to a router. */
export interface TraefikRouterTLS {
  /** Secret holding the certificate, e.g. one written by cert-manager. */
  readonly secretName?: string;
  readonly options?: { readonly name: string; readonly namespace?: string };
  readonly store?: { readonly name: string; readonly namespace?: string };
  readonly certResolver?: string;
  readonly domains?: readonly {
    readonly main?: string;
    readonly sans?: readonly string[];
  }[];
}

// ============================================================================
// IngressRoute / IngressRouteTCP
// ============================================================================

/** Per-route observability overrides. */
export interface TraefikRouteObservability {
  readonly accessLogs?: boolean;
  readonly metrics?: boolean;
  readonly tracing?: boolean;
  readonly traceVerbosity?: 'minimal' | 'detailed';
}

/** One `IngressRoute.spec.routes[]` entry. */
export interface TraefikIngressRouteRule {
  /** Traefik v3 rule expression, e.g. ``Host(`api.example.com`)``. */
  readonly match: string;
  readonly kind?: 'Rule';
  /** Higher priority wins; Traefik defaults to the rule length. */
  readonly priority?: number;
  readonly syntax?: string;
  readonly services?: readonly TraefikServiceRef[];
  readonly middlewares?: readonly TraefikMiddlewareRef[];
  readonly observability?: TraefikRouteObservability;
}

/** `IngressRoute.spec`. */
export interface TraefikIngressRouteSpec {
  readonly routes: readonly TraefikIngressRouteRule[];
  readonly entryPoints?: readonly string[];
  readonly ingressClassName?: string;
  readonly tls?: TraefikRouterTLS;
  readonly parentRefs?: readonly { readonly name: string; readonly namespace?: string }[];
}

/** One backend of an `IngressRouteTCP` route. */
export interface TraefikTCPServiceRef {
  readonly name: string;
  readonly port: TraefikPortValue;
  readonly namespace?: string;
  readonly weight?: number;
  readonly tls?: boolean;
  readonly nativeLB?: boolean;
  readonly nodePortLB?: boolean;
  readonly serversTransport?: string;
  readonly proxyProtocol?: { readonly version?: number };
}

/** One `IngressRouteTCP.spec.routes[]` entry. */
export interface TraefikIngressRouteTCPRule {
  /** TCP rule expression, e.g. ``HostSNI(`db.example.com`)``. */
  readonly match: string;
  readonly priority?: number;
  readonly syntax?: 'v3' | 'v2';
  readonly services?: readonly TraefikTCPServiceRef[];
  readonly middlewares?: readonly TraefikMiddlewareRef[];
}

/** `IngressRouteTCP.spec`. */
export interface TraefikIngressRouteTCPSpec {
  readonly routes: readonly TraefikIngressRouteTCPRule[];
  readonly entryPoints?: readonly string[];
  readonly ingressClassName?: string;
  readonly tls?: TraefikRouterTLS & { readonly passthrough?: boolean };
}

// ============================================================================
// TraefikService / ServersTransport
// ============================================================================

/** `TraefikService.spec` — exactly one composition mode should be set. */
export interface TraefikServiceSpec {
  readonly weighted?: {
    readonly services?: readonly TraefikServiceRef[];
    readonly sticky?: TraefikStickyCookie;
  };
  readonly mirroring?: TraefikServiceRef & {
    readonly maxBodySize?: number;
    readonly mirrorBody?: boolean;
    readonly mirrors?: readonly (TraefikServiceRef & { readonly percent?: number })[];
  };
  readonly failover?: {
    readonly service: TraefikServiceRef;
    readonly fallback: TraefikServiceRef;
    readonly errors?: {
      readonly status?: readonly string[];
      readonly maxRequestBodyBytes?: number;
    };
  };
  readonly highestRandomWeight?: {
    readonly services?: readonly TraefikServiceRef[];
  };
}

/** `ServersTransport.spec` — how Traefik dials upstream servers. */
export interface TraefikServersTransportSpec {
  readonly serverName?: string;
  readonly insecureSkipVerify?: boolean;
  readonly rootCAsSecrets?: readonly string[];
  readonly rootCAs?: readonly {
    readonly secret?: string;
    readonly configMap?: string;
  }[];
  readonly certificatesSecrets?: readonly string[];
  readonly maxIdleConnsPerHost?: number;
  readonly disableHTTP2?: boolean;
  readonly peerCertURI?: string;
  readonly minVersion?: string;
  readonly maxVersion?: string;
  readonly cipherSuites?: readonly string[];
  readonly spiffe?: {
    readonly ids?: readonly string[];
    readonly trustDomain?: string;
  };
  /**
   * Upstream timeouts. An edge fronting long-running requests must raise
   * `responseHeaderTimeout` above the default 60s alongside the entrypoint's
   * `respondingTimeouts`.
   */
  readonly forwardingTimeouts?: {
    readonly dialTimeout?: TraefikDuration;
    readonly responseHeaderTimeout?: TraefikDuration;
    readonly idleConnTimeout?: TraefikDuration;
    readonly readIdleTimeout?: TraefikDuration;
    readonly pingTimeout?: TraefikDuration;
  };
}

// ============================================================================
// TLSOption / TLSStore
// ============================================================================

/** Mutual-TLS behavior of a `TLSOption`. */
export interface TraefikClientAuth {
  readonly secretNames?: readonly string[];
  readonly clientAuthType?:
    | 'NoClientCert'
    | 'RequestClientCert'
    | 'RequireAnyClientCert'
    | 'VerifyClientCertIfGiven'
    | 'RequireAndVerifyClientCert';
}

/** `TLSOption.spec`. */
export interface TraefikTLSOptionSpec {
  readonly minVersion?: 'VersionTLS10' | 'VersionTLS11' | 'VersionTLS12' | 'VersionTLS13';
  readonly maxVersion?: 'VersionTLS10' | 'VersionTLS11' | 'VersionTLS12' | 'VersionTLS13';
  readonly cipherSuites?: readonly string[];
  readonly curvePreferences?: readonly string[];
  /** Reject connections whose SNI does not match a configured certificate. */
  readonly sniStrict?: boolean;
  readonly alpnProtocols?: readonly string[];
  readonly disableSessionTickets?: boolean;
  readonly clientAuth?: TraefikClientAuth;
}

/** `TLSStore.spec`. */
export interface TraefikTLSStoreSpec {
  /**
   * Default certificate served when SNI matches no router certificate. Point
   * this at the Secret a cert-manager `Certificate` writes.
   */
  readonly defaultCertificate?: { readonly secretName: string };
  /** ACME resolver used to generate the default certificate instead. */
  readonly defaultGeneratedCert?: {
    readonly resolver?: string;
    readonly domain?: {
      readonly main?: string;
      readonly sans?: readonly string[];
    };
  };
  readonly certificates?: readonly { readonly secretName: string }[];
}

// ============================================================================
// Middleware — the OSS middleware set as a discriminated union
// ============================================================================

/**
 * Delegate authentication and authorization to an in-cluster authorizer.
 *
 * @security `trustForwardHeader` defaults to `false` in
 * {@link TRAEFIK_FORWARD_AUTH_SECURE_DEFAULTS}: trusting `X-Forwarded-*` from
 * an untrusted client lets a caller spoof its own identity. `authResponseHeaders`
 * is an explicit allowlist — only the listed headers are copied from the
 * authorizer response onto the upstream request.
 */
export interface TraefikForwardAuthMiddleware {
  /** URL of the authorizer, e.g. `http://authorizer.edge.svc.cluster.local:8080/auth`. */
  readonly address: string;
  /** Copy `X-Forwarded-*` from the client to the authorizer. Keep `false` at an edge. */
  readonly trustForwardHeader?: boolean;
  /** Headers copied from the authorizer's response onto the upstream request. */
  readonly authResponseHeaders?: readonly string[];
  /** Regex alternative to {@link authResponseHeaders}. Prefer the explicit list. */
  readonly authResponseHeadersRegex?: string;
  /** Client headers forwarded to the authorizer. Empty means all of them. */
  readonly authRequestHeaders?: readonly string[];
  readonly addAuthCookiesToResponse?: readonly string[];
  readonly authSigninURL?: string;
  readonly forwardBody?: boolean;
  readonly maxBodySize?: number;
  readonly maxResponseBodySize?: number;
  readonly headerField?: string;
  readonly preserveLocationHeader?: boolean;
  readonly preserveRequestMethod?: boolean;
  readonly tls?: {
    readonly caSecret?: string;
    readonly certSecret?: string;
    readonly insecureSkipVerify?: boolean;
  };
}

/** Redis (or Valkey) backend making a rate limit shared across Traefik replicas. */
export interface TraefikRateLimitRedis {
  readonly endpoints: readonly string[];
  /** Secret holding `username` / `password` keys. */
  readonly secret?: string;
  readonly db?: number;
  readonly poolSize?: number;
  readonly minIdleConns?: number;
  readonly maxActiveConns?: number;
  readonly dialTimeout?: TraefikDuration;
  readonly readTimeout?: TraefikDuration;
  readonly writeTimeout?: TraefikDuration;
  readonly tls?: {
    readonly caSecret?: string;
    readonly certSecret?: string;
    readonly insecureSkipVerify?: boolean;
  };
}

/**
 * Token-bucket rate limit.
 *
 * Without {@link TraefikRateLimitMiddleware.redis} each Traefik replica keeps
 * its own counters, so the effective limit is `average × replicas`. Supply the
 * Redis backend whenever the budget must hold for the whole edge.
 */
export interface TraefikRateLimitMiddleware {
  /** Sustained requests allowed per {@link period}. */
  readonly average?: number;
  /** Requests absorbed above {@link average} before Traefik answers 429. */
  readonly burst?: number;
  /** Window {@link average} is measured over. Defaults to one second. */
  readonly period?: TraefikDuration;
  readonly sourceCriterion?: TraefikSourceCriterion;
  readonly redis?: TraefikRateLimitRedis;
}

/** Cap on requests being handled concurrently, per source. */
export interface TraefikInFlightReqMiddleware {
  readonly amount?: number;
  readonly sourceCriterion?: TraefikSourceCriterion;
}

/** CORS and browser security headers. */
export interface TraefikHeadersMiddleware {
  readonly customRequestHeaders?: Readonly<Record<string, string>>;
  readonly customResponseHeaders?: Readonly<Record<string, string>>;
  readonly accessControlAllowCredentials?: boolean;
  readonly accessControlAllowHeaders?: readonly string[];
  readonly accessControlAllowMethods?: readonly string[];
  readonly accessControlAllowOriginList?: readonly string[];
  readonly accessControlAllowOriginListRegex?: readonly string[];
  readonly accessControlExposeHeaders?: readonly string[];
  readonly accessControlMaxAge?: number;
  readonly addVaryHeader?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly hostsProxyHeaders?: readonly string[];
  readonly sslProxyHeaders?: Readonly<Record<string, string>>;
  readonly stsSeconds?: number;
  readonly stsIncludeSubdomains?: boolean;
  readonly stsPreload?: boolean;
  readonly forceSTSHeader?: boolean;
  readonly frameDeny?: boolean;
  readonly customFrameOptionsValue?: string;
  readonly contentTypeNosniff?: boolean;
  readonly browserXssFilter?: boolean;
  readonly customBrowserXSSValue?: string;
  readonly contentSecurityPolicy?: string;
  readonly contentSecurityPolicyReportOnly?: string;
  readonly publicKey?: string;
  readonly referrerPolicy?: string;
  readonly permissionsPolicy?: string;
  readonly featurePolicy?: string;
  /** Relaxes header enforcement for local development. Never enable in production. */
  readonly isDevelopment?: boolean;
}

/** Redirect a request to another scheme, e.g. `web` → `websecure`. */
export interface TraefikRedirectSchemeMiddleware {
  readonly scheme: 'http' | 'https';
  readonly port?: string;
  readonly permanent?: boolean;
}

/** Regex-based redirect. */
export interface TraefikRedirectRegexMiddleware {
  readonly regex: string;
  readonly replacement: string;
  readonly permanent?: boolean;
}

/** Remove one of `prefixes` from the request path before forwarding. */
export interface TraefikStripPrefixMiddleware {
  readonly prefixes: readonly string[];
  readonly forceSlash?: boolean;
}

/** Remove a regex-matched prefix from the request path. */
export interface TraefikStripPrefixRegexMiddleware {
  readonly regex: readonly string[];
}

/** Prepend a prefix to the request path. */
export interface TraefikAddPrefixMiddleware {
  readonly prefix: string;
}

/** Replace the whole request path. */
export interface TraefikReplacePathMiddleware {
  readonly path: string;
}

/** Replace a regex-matched request path. */
export interface TraefikReplacePathRegexMiddleware {
  readonly regex: string;
  readonly replacement: string;
}

/**
 * Body buffering and size limits.
 *
 * `maxRequestBodyBytes` is the request-size cap an edge needs so an upstream
 * cannot be flooded; a `retryExpression` requires buffering to be able to
 * replay the body.
 */
export interface TraefikBufferingMiddleware {
  readonly maxRequestBodyBytes?: number;
  readonly memRequestBodyBytes?: number;
  readonly maxResponseBodyBytes?: number;
  readonly memResponseBodyBytes?: number;
  readonly retryExpression?: string;
}

/** Retry a request against the next available server. */
export interface TraefikRetryMiddleware {
  readonly attempts?: number;
  readonly initialInterval?: TraefikDuration;
  readonly timeout?: TraefikDuration;
  readonly status?: readonly string[];
  readonly maxRequestBodyBytes?: number;
  readonly disableRetryOnNetworkError?: boolean;
  readonly retryNonIdempotentMethod?: boolean;
}

/** Trip a circuit when the guard expression evaluates true. */
export interface TraefikCircuitBreakerMiddleware {
  readonly expression?: string;
  readonly checkPeriod?: TraefikDuration;
  readonly fallbackDuration?: TraefikDuration;
  readonly recoveryDuration?: TraefikDuration;
  readonly responseCode?: number;
}

/** Allow only the listed source ranges. */
export interface TraefikIpAllowListMiddleware {
  readonly sourceRange: readonly string[];
  readonly ipStrategy?: TraefikIpStrategy;
  readonly rejectStatusCode?: number;
}

/** HTTP basic or digest auth backed by a Secret of htpasswd users. */
export interface TraefikCredentialAuthMiddleware {
  /** Secret containing a `users` key in htpasswd format. */
  readonly secret: string;
  readonly realm?: string;
  readonly removeHeader?: boolean;
  readonly headerField?: string;
}

/** Response compression. */
export interface TraefikCompressMiddleware {
  readonly encodings?: readonly string[];
  readonly defaultEncoding?: string;
  readonly includedContentTypes?: readonly string[];
  readonly excludedContentTypes?: readonly string[];
  readonly minResponseBodyBytes?: number;
}

/** Serve custom error pages from another service. */
export interface TraefikErrorsMiddleware {
  readonly status?: readonly string[];
  readonly statusRewrites?: Readonly<Record<string, number>>;
  readonly query?: string;
  readonly service: TraefikServiceRef;
}

/** Apply an ordered list of other middlewares. */
export interface TraefikChainMiddleware {
  readonly middlewares: readonly TraefikMiddlewareRef[];
}

/** Forward client-certificate information to the upstream. */
export interface TraefikPassTLSClientCertMiddleware {
  readonly pem?: boolean;
  readonly info?: {
    readonly notAfter?: boolean;
    readonly notBefore?: boolean;
    readonly sans?: boolean;
    readonly serialNumber?: boolean;
    readonly subject?: {
      readonly commonName?: boolean;
      readonly country?: boolean;
      readonly domainComponent?: boolean;
      readonly locality?: boolean;
      readonly organization?: boolean;
      readonly organizationalUnit?: boolean;
      readonly province?: boolean;
      readonly serialNumber?: boolean;
    };
    readonly issuer?: {
      readonly commonName?: boolean;
      readonly country?: boolean;
      readonly domainComponent?: boolean;
      readonly locality?: boolean;
      readonly organization?: boolean;
      readonly province?: boolean;
      readonly serialNumber?: boolean;
    };
  };
}

/** Auto-detect the response `Content-Type` when the upstream omits it. */
export interface TraefikContentTypeMiddleware {
  readonly autoDetect?: boolean;
}

/** Allow otherwise-rejected percent-encoded characters in the request path. */
export interface TraefikEncodedCharactersMiddleware {
  readonly allowEncodedSlash?: boolean;
  readonly allowEncodedBackSlash?: boolean;
  readonly allowEncodedNullCharacter?: boolean;
  readonly allowEncodedSemicolon?: boolean;
  readonly allowEncodedPercent?: boolean;
  readonly allowEncodedQuestionMark?: boolean;
  readonly allowEncodedHash?: boolean;
}

/** Bridge gRPC-Web clients to a gRPC upstream. */
export interface TraefikGrpcWebMiddleware {
  readonly allowOrigins?: readonly string[];
}

/**
 * A Traefik plugin middleware.
 *
 * Keyed by the plugin name declared in `experimental.plugins`; the value shape
 * is defined by the plugin itself, so it stays `unknown` rather than `any`.
 */
export type TraefikPluginMiddleware = Readonly<Record<string, unknown>>;

/** Every OSS middleware keyed by its CRD field name. */
export interface TraefikMiddlewareSpecMap {
  addPrefix: TraefikAddPrefixMiddleware;
  basicAuth: TraefikCredentialAuthMiddleware;
  buffering: TraefikBufferingMiddleware;
  chain: TraefikChainMiddleware;
  circuitBreaker: TraefikCircuitBreakerMiddleware;
  compress: TraefikCompressMiddleware;
  contentType: TraefikContentTypeMiddleware;
  digestAuth: TraefikCredentialAuthMiddleware;
  encodedCharacters: TraefikEncodedCharactersMiddleware;
  errors: TraefikErrorsMiddleware;
  forwardAuth: TraefikForwardAuthMiddleware;
  grpcWeb: TraefikGrpcWebMiddleware;
  headers: TraefikHeadersMiddleware;
  inFlightReq: TraefikInFlightReqMiddleware;
  ipAllowList: TraefikIpAllowListMiddleware;
  passTLSClientCert: TraefikPassTLSClientCertMiddleware;
  plugin: TraefikPluginMiddleware;
  rateLimit: TraefikRateLimitMiddleware;
  redirectRegex: TraefikRedirectRegexMiddleware;
  redirectScheme: TraefikRedirectSchemeMiddleware;
  replacePath: TraefikReplacePathMiddleware;
  replacePathRegex: TraefikReplacePathRegexMiddleware;
  retry: TraefikRetryMiddleware;
  stripPrefix: TraefikStripPrefixMiddleware;
  stripPrefixRegex: TraefikStripPrefixRegexMiddleware;
}

/** The name of one middleware kind. */
export type TraefikMiddlewareKind = keyof TraefikMiddlewareSpecMap;

/**
 * Exactly one key of `TMap`, with every other key typed `never`.
 *
 * This is what makes `{ forwardAuth: ..., rateLimit: ... }` a compile error: a
 * `Middleware` configures a single behavior, and two keys in one object is a
 * silent misconfiguration that Traefik resolves by picking one.
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
// Helm chart values (typed subset of the official chart's values.yaml)
// ============================================================================

/** OTLP exporter shape shared by the chart's log/accessLog/metrics/tracing keys. */
export interface TraefikOtlpValues {
  enabled?: boolean;
  serviceName?: string;
  resourceAttributes?: Record<string, string>;
  http?: {
    enabled?: boolean;
    endpoint?: string;
    headers?: Record<string, string>;
    tls?: Record<string, unknown>;
  };
  grpc?: {
    enabled?: boolean;
    endpoint?: string;
    insecure?: boolean;
    tls?: Record<string, unknown>;
  };
  [key: string]: unknown;
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
  expose?: { default?: boolean; [key: string]: unknown };
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
    [key: string]: unknown;
  };
  forwardedHeaders?: { trustedIPs?: string[]; insecure?: boolean; [key: string]: unknown };
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
  observability?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Typed subset of the official `traefik` chart values this factory maps or
 * pins (verified against chart 41.5.0). The index signature keeps the rest of
 * the chart's surface reachable through the build-time values passthrough.
 *
 * Note the shapes that changed in the 3x chart line and are easy to get wrong:
 * the Service type lives under `service.spec.type` (not `service.type`), and
 * the Gateway API provider is `providers.kubernetesGateway`.
 */
export interface TraefikHelmValues {
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
    [key: string]: unknown;
  };
  /** @security Pinned off by the values mapper. */
  api?: {
    dashboard?: boolean;
    insecure?: boolean;
    debug?: boolean;
    basePath?: string;
    [key: string]: unknown;
  };
  /** @security Pinned off by the values mapper. */
  ingressRoute?: {
    dashboard?: { enabled?: boolean; [key: string]: unknown };
    healthcheck?: { enabled?: boolean; [key: string]: unknown };
    [key: string]: unknown;
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
      [key: string]: unknown;
    };
    kubernetesIngress?: {
      enabled?: boolean;
      ingressClass?: string;
      /**
       * Service whose address Traefik copies onto `Ingress.status`. The chart
       * emits the flag only when it created the Service itself OR when
       * `pathOverride` names one — this factory owns the Service, so the mapper
       * always sets `pathOverride`.
       */
      publishedService?: { enabled?: boolean; pathOverride?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    kubernetesGateway?: {
      enabled?: boolean;
      experimentalChannel?: boolean;
      namespaces?: string[];
      statusAddress?: Record<string, unknown>;
      [key: string]: unknown;
    };
    file?: { enabled?: boolean; watch?: boolean; content?: Record<string, unknown> };
    [key: string]: unknown;
  };
  gateway?: { enabled?: boolean; [key: string]: unknown };
  gatewayClass?: { enabled?: boolean; name?: string; [key: string]: unknown };
  log?: { level?: string; format?: string; otlp?: TraefikOtlpValues; [key: string]: unknown };
  accessLog?: {
    enabled?: boolean;
    format?: string;
    addInternals?: boolean;
    fields?: Record<string, unknown>;
    filters?: Record<string, unknown>;
    otlp?: TraefikOtlpValues;
    [key: string]: unknown;
  };
  metrics?: {
    addInternals?: boolean;
    prometheus?: Record<string, unknown> | null;
    otlp?: TraefikOtlpValues;
    [key: string]: unknown;
  };
  tracing?: {
    addInternals?: boolean;
    serviceName?: string;
    sampleRate?: number;
    otlp?: TraefikOtlpValues;
    [key: string]: unknown;
  };
  experimental?: { otlpLogs?: boolean; plugins?: Record<string, unknown>; [key: string]: unknown };
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
    spec?: { type?: TraefikServiceType; [key: string]: unknown };
    [key: string]: unknown;
  };
  tlsOptions?: Record<string, unknown>;
  tlsStore?: Record<string, unknown>;
  rbac?: { enabled?: boolean; namespaced?: boolean; [key: string]: unknown };
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
  securityContext?: Record<string, unknown>;
  /** @security Pinned to a non-root profile. */
  podSecurityContext?: Record<string, unknown>;
  additionalArguments?: string[];
  env?: Record<string, unknown>[];
  nodeSelector?: Record<string, string>;
  tolerations?: Record<string, unknown>[];
  affinity?: Record<string, unknown>;
  topologySpreadConstraints?: Record<string, unknown>[];
  priorityClassName?: string;
  global?: { checkNewVersion?: boolean; sendAnonymousUsage?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

/** Kubernetes Service type usable for the Traefik entrypoint Service. */
export type TraefikServiceType = 'LoadBalancer' | 'NodePort' | 'ClusterIP';

/** Chart values accepted by {@link TraefikHelmReleaseConfig}. */
export type TraefikMappedHelmValues = TypeKroChartValues<TraefikHelmValues>;

// ============================================================================
// Helm resource configuration
// ============================================================================

/** Configuration for the Traefik `HelmRepository`. */
export interface TraefikHelmRepositoryConfig {
  readonly name: string;
  /** Flux namespace holding the repository. Defaults to the Flux namespace. */
  readonly namespace?: string;
  /** @default DEFAULT_TRAEFIK_REPOSITORY_URL */
  readonly url?: string;
  /** @default '1h' */
  readonly interval?: string;
  readonly id?: string;
}

/** Configuration for the Traefik `HelmRelease`. */
export interface TraefikHelmReleaseConfig {
  readonly name: string;
  /** Namespace of the HelmRelease object. Defaults to the Flux namespace. */
  readonly namespace?: string;
  /** Namespace Traefik itself is installed into. */
  readonly targetNamespace?: string;
  /** @default DEFAULT_TRAEFIK_CHART_VERSION */
  readonly version?: string;
  /** @default DEFAULT_TRAEFIK_REPOSITORY_NAME */
  readonly repositoryName?: string;
  readonly repositoryNamespace?: string;
  /** @default '5m' */
  readonly interval?: string;
  /** @default '10m' */
  readonly timeout?: string;
  /** Whether Flux should create `targetNamespace`. @default false */
  readonly createNamespace?: boolean;
  /**
   * CRD policy applied to BOTH `install.crds` and `upgrade.crds`.
   *
   * Flux defaults `upgrade.crds` to `Skip`, which would leave the CRDs of the
   * first-installed chart version in place across a chart bump.
   *
   * @default DEFAULT_TRAEFIK_CRDS_POLICY (`'CreateReplace'`)
   */
  readonly crds?: HelmReleaseCrdsPolicy;
  readonly values?: TraefikMappedHelmValues;
  readonly id?: string;
}

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
    /** Cloud load-balancer annotations, e.g. the AWS NLB set. */
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
 * EVERY field here is a projection of a resource this composition owns, so it
 * hydrates identically in direct and KRO mode. That rules out literals: KRO
 * drops literal status fields, so declaring one would require a field the
 * instance never carries. The entrypoint NAMES are therefore not in this
 * contract — they are fixed by this composition and exported as
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
   * Concrete chart values merged BEFORE the security pins, which always win.
   * Use for chart surface this factory does not model.
   */
  readonly values?: TraefikHelmValues;
}
