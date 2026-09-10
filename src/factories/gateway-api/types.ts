/**
 * Shared upstream Gateway API type definitions.
 *
 * Extracted from `src/factories/envoy-ai-gateway` (see #176) so that every
 * Gateway API implementation in TypeKro — Envoy Gateway, Traefik v3, and any
 * future controller — describes `GatewayClass`, `Gateway`, `HTTPRoute`,
 * `GRPCRoute`, `ReferenceGrant` and `BackendTLSPolicy` with one set of types.
 *
 * Vendor-specific policy CRDs (`BackendTrafficPolicy`, `AIGatewayRoute`,
 * Traefik `Middleware`, ...) deliberately stay in their own factory packages.
 *
 * **ArkType is the single source of truth for the SPEC types here.** Every
 * `*Spec` / config type below is inferred from the schema next to it
 * (`typeof XSchema.infer`), which is the repository's integration contract: one
 * definition validates at runtime, generates KRO SimpleSchema, and types the
 * factory. The shapes were verified field-by-field against the CRDs installed
 * by the Gateway API v1.2.1 experimental channel, read back from a live API
 * server with `kubectl get crd <name> -o jsonpath='{.spec.versions[*].schema.openAPIV3Schema}'`.
 *
 * STATUS types stay hand-written interfaces: they describe what a controller
 * publishes, never user input, so there is nothing to validate or generate.
 *
 * Where a schema is narrower than the CRD it is deliberate and noted inline
 * (for example `listeners[].protocol`, which the CRD types as a bare string).
 */

import { type } from 'arktype';

// ============================================================================
// Status types — hand-written: these describe controller output, not input
// ============================================================================

/** A `metav1.Condition` as published by Gateway API controllers. */
export interface KubernetesCondition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly observedGeneration?: number;
}

/** Status shape of any Gateway API resource that only publishes conditions. */
export interface AcceptedResourceStatus {
  readonly conditions?: readonly KubernetesCondition[];
}

/** `Gateway.status`: assigned addresses plus Accepted/Programmed conditions. */
export interface GatewayObservedStatus {
  readonly addresses?: readonly {
    readonly type?: string;
    readonly value: string;
  }[];
  readonly conditions?: readonly KubernetesCondition[];
  readonly listeners?: readonly {
    readonly name: string;
    readonly attachedRoutes?: number;
    readonly conditions?: readonly KubernetesCondition[];
  }[];
}

/**
 * Status of a Gateway API resource that reports per-parent conditions, i.e.
 * routes (`parents`) — one entry per `parentRef` that a controller claimed.
 */
export interface RouteObservedStatus {
  readonly parents?: readonly {
    readonly controllerName?: string;
    readonly parentRef?: ParentReference;
    readonly conditions?: readonly KubernetesCondition[];
  }[];
}

/**
 * Status of a Gateway API policy attachment (`BackendTLSPolicy`, and the
 * implementation-specific policies that follow the same convention), which
 * reports conditions per ancestor rather than per parent.
 */
export interface GatewayPolicyObservedStatus {
  readonly ancestors?: readonly {
    readonly controllerName?: string;
    readonly conditions?: readonly KubernetesCondition[];
  }[];
}

// ============================================================================
// Shared schema shapes
//
// Extracted as `as const` shapes wherever a CRD repeats the same object at
// several paths, so the definitions cannot drift apart.
// ============================================================================

/** An object reference restricted to Secrets (and, historically, ConfigMaps). */
export const SecretObjectReferenceSchema = type({
  'group?': 'string',
  'kind?': 'string',
  name: 'string',
  'namespace?': 'string',
});

/** A certificate or CA reference used by listener TLS configuration. */
export type SecretObjectReference = typeof SecretObjectReferenceSchema.infer;

/** `GatewayClass.spec.parametersRef` — an implementation-specific config object. */
const parametersRefShape = {
  group: 'string',
  kind: 'string',
  name: 'string',
  'namespace?': 'string',
} as const;

/** A `metav1.LabelSelector` as Gateway API embeds it under `allowedRoutes`. */
const labelSelectorShape = {
  'matchLabels?': 'Record<string, string>',
  'matchExpressions?': type({
    key: 'string',
    operator: 'string',
    'values?': 'string[]',
  }).array(),
} as const;

/** An `HTTPRoute`/`GRPCRoute` header (and query-param) match. */
const headerMatchShape = {
  'type?': '"Exact" | "RegularExpression"',
  name: 'string',
  value: 'string',
} as const;

/** One `name`/`value` pair of a header-modifier filter. */
const headerValueShape = { name: 'string', value: 'string' } as const;

/** `filters[].requestRedirect.path` / `filters[].urlRewrite.path`. */
const httpPathModifierShape = {
  type: '"ReplaceFullPath" | "ReplacePrefixMatch"',
  'replaceFullPath?': 'string',
  'replacePrefixMatch?': 'string',
} as const;

/** `sessionPersistence` — identical on `HTTPRoute` and `GRPCRoute` rules. */
const sessionPersistenceShape = {
  'sessionName?': 'string',
  'absoluteTimeout?': 'string',
  'idleTimeout?': 'string',
  'type?': '"Cookie" | "Header"',
  'cookieConfig?': {
    'lifetimeType?': '"Permanent" | "Session"',
  },
} as const;

/** A CA-certificate reference, which unlike a Secret ref requires group/kind. */
const caCertificateRefShape = {
  group: 'string',
  kind: 'string',
  name: 'string',
} as const;

// ============================================================================
// GatewayClass
// ============================================================================

/** `GatewayClass.spec`. */
export const GatewayClassSpecSchema = type({
  controllerName: 'string',
  'description?': 'string',
  'parametersRef?': parametersRefShape,
});

/**
 * `GatewayClass.spec`.
 *
 * `TController` lets an implementation pin its own controller name as a literal
 * type (e.g. `GatewayClassSpec<'traefik.io/gateway-controller'>`) while the
 * unparameterized form stays usable for generic tooling. The shape is inferred
 * from {@link GatewayClassSpecSchema}; only `controllerName` is re-typed,
 * because ArkType has no generic-literal equivalent.
 */
export type GatewayClassSpec<TController extends string = string> = Omit<
  typeof GatewayClassSpecSchema.infer,
  'controllerName'
> & { controllerName: TController };

// ============================================================================
// Gateway
// ============================================================================

/** Which namespaces a listener accepts routes from. */
export const AllowedRoutesSchema = type({
  'namespaces?': {
    'from?': '"All" | "Selector" | "Same"',
    'selector?': labelSelectorShape,
  },
  'kinds?': type({
    'group?': 'string',
    kind: 'string',
  }).array(),
});

/** Which namespaces a listener accepts routes from. */
export type AllowedRoutes = typeof AllowedRoutesSchema.infer;

/** `Gateway.spec.listeners[].tls`. */
export const GatewayTLSConfigSchema = type({
  'mode?': '"Terminate" | "Passthrough"',
  'certificateRefs?': SecretObjectReferenceSchema.array(),
  /** Client-certificate validation for a terminating listener. */
  'frontendValidation?': {
    'caCertificateRefs?': type({
      ...caCertificateRefShape,
      'namespace?': 'string',
    }).array(),
  },
  'options?': 'Record<string, string>',
});

/** `Gateway.spec.listeners[].tls`. */
export type GatewayTLSConfig = typeof GatewayTLSConfigSchema.infer;

/**
 * A single `Gateway.spec.listeners[]` entry.
 *
 * `protocol` is narrower than the CRD, which types it as a bare string: these
 * five are the protocols the API defines, and an unknown protocol is rejected
 * by every controller rather than doing something useful.
 */
export const GatewayListenerSchema = type({
  name: 'string',
  protocol: '"HTTP" | "HTTPS" | "TLS" | "TCP" | "UDP"',
  port: 'number.integer',
  'hostname?': 'string',
  'tls?': GatewayTLSConfigSchema,
  'allowedRoutes?': AllowedRoutesSchema,
});

/** A single `Gateway.spec.listeners[]` entry. */
export type GatewayListener = typeof GatewayListenerSchema.infer;

/** A `Gateway.spec.addresses[]` entry. */
const gatewayAddressShape = {
  'type?': 'string',
  value: 'string',
} as const;

/** `Gateway.spec`. */
export const GatewaySpecSchema = type({
  gatewayClassName: 'string',
  listeners: GatewayListenerSchema.array(),
  'addresses?': type(gatewayAddressShape).array(),
  'infrastructure?': {
    'labels?': 'Record<string, string>',
    'annotations?': 'Record<string, string>',
    'parametersRef?': {
      group: 'string',
      kind: 'string',
      name: 'string',
    },
  },
  /** Default client certificate the Gateway presents to backends. */
  'backendTLS?': {
    'clientCertificateRef?': SecretObjectReferenceSchema,
  },
});

/** `Gateway.spec`. */
export type GatewaySpec = typeof GatewaySpecSchema.infer;

// ============================================================================
// Routes
// ============================================================================

/**
 * A route's reference to the Gateway (or listener) it attaches to.
 *
 * `kind` stays a plain string, matching the CRD: the mesh profile allows a
 * `Service` parent, so pinning the literal `'Gateway'` would reject a valid
 * upstream shape.
 */
export const ParentReferenceSchema = type({
  'group?': 'string',
  'kind?': 'string',
  name: 'string',
  'namespace?': 'string',
  'sectionName?': 'string',
  'port?': 'number.integer',
});

/** A route's reference to the Gateway (or listener) it attaches to. */
export type ParentReference = typeof ParentReferenceSchema.infer;

/** A backend a route rule forwards to. */
export const BackendRefSchema = type({
  'group?': 'string',
  'kind?': 'string',
  name: 'string',
  'namespace?': 'string',
  'port?': 'number.integer',
  'weight?': 'number.integer',
});

/** A backend a route rule forwards to. */
export type BackendRef = typeof BackendRefSchema.infer;

/**
 * One `HTTPRoute.spec.rules[].matches[]` entry.
 *
 * `path.value` is optional exactly as the CRD has it — an omitted value means
 * the `/` prefix — and `method` uses the CRD's enum rather than a bare string.
 */
export const HTTPRouteMatchSchema = type({
  'path?': {
    'type?': '"Exact" | "PathPrefix" | "RegularExpression"',
    'value?': 'string',
  },
  'headers?': type(headerMatchShape).array(),
  'queryParams?': type(headerMatchShape).array(),
  'method?':
    '"GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH"',
});

/** One `HTTPRoute.spec.rules[].matches[]` entry. */
export type HTTPRouteMatch = typeof HTTPRouteMatchSchema.infer;

/** A header modification applied by an `HTTPRoute` filter. */
export const HTTPHeaderFilterSchema = type({
  'set?': type(headerValueShape).array(),
  'add?': type(headerValueShape).array(),
  'remove?': 'string[]',
});

/** A header modification applied by an `HTTPRoute` filter. */
export type HTTPHeaderFilter = typeof HTTPHeaderFilterSchema.infer;

/**
 * One `HTTPRoute.spec.rules[].filters[]` entry.
 *
 * `extensionRef` is how an implementation attaches its own middleware — Traefik
 * uses it to reference a `traefik.io/v1alpha1` `Middleware`.
 */
export const HTTPRouteFilterSchema = type({
  type: '"RequestHeaderModifier" | "ResponseHeaderModifier" | "RequestMirror" | "RequestRedirect" | "URLRewrite" | "ExtensionRef"',
  'requestHeaderModifier?': HTTPHeaderFilterSchema,
  'responseHeaderModifier?': HTTPHeaderFilterSchema,
  'requestRedirect?': {
    'scheme?': '"http" | "https"',
    'hostname?': 'string',
    'port?': 'number.integer',
    'statusCode?': '301 | 302',
    'path?': httpPathModifierShape,
  },
  'urlRewrite?': {
    'hostname?': 'string',
    'path?': httpPathModifierShape,
  },
  'requestMirror?': {
    backendRef: BackendRefSchema,
    /** Mirror only a share of the requests. `percent` and `fraction` are exclusive. */
    'percent?': 'number.integer',
    'fraction?': {
      numerator: 'number.integer',
      'denominator?': 'number.integer',
    },
  },
  'extensionRef?': {
    group: 'string',
    kind: 'string',
    name: 'string',
  },
});

/** One `HTTPRoute.spec.rules[].filters[]` entry. */
export type HTTPRouteFilter = typeof HTTPRouteFilterSchema.infer;

/** A `backendRefs[]` entry, which may carry its own per-backend filters. */
const routeBackendRefSchema = BackendRefSchema.and({
  'filters?': HTTPRouteFilterSchema.array(),
});

/** One `HTTPRoute.spec.rules[]` entry. */
export const HTTPRouteRuleSchema = type({
  'name?': 'string',
  'matches?': HTTPRouteMatchSchema.array(),
  'filters?': HTTPRouteFilterSchema.array(),
  'backendRefs?': routeBackendRefSchema.array(),
  'timeouts?': {
    'request?': 'string',
    'backendRequest?': 'string',
  },
  'retry?': {
    'codes?': 'number.integer[]',
    'attempts?': 'number.integer',
    'backoff?': 'string',
  },
  'sessionPersistence?': sessionPersistenceShape,
});

/** One `HTTPRoute.spec.rules[]` entry. */
export type HTTPRouteRule = typeof HTTPRouteRuleSchema.infer;

/**
 * `HTTPRoute.spec`.
 *
 * `parentRefs` is required here although the CRD allows it to be absent: a
 * route attached to nothing serves no traffic, and TypeKro would have no
 * resource to order it against.
 */
export const HTTPRouteSpecSchema = type({
  parentRefs: ParentReferenceSchema.array(),
  'hostnames?': 'string[]',
  'rules?': HTTPRouteRuleSchema.array(),
});

/** `HTTPRoute.spec`. */
export type HTTPRouteSpec = typeof HTTPRouteSpecSchema.infer;

/** One `GRPCRoute.spec.rules[].matches[]` entry. */
export const GRPCRouteMatchSchema = type({
  'method?': {
    'type?': '"Exact" | "RegularExpression"',
    'service?': 'string',
    'method?': 'string',
  },
  'headers?': type(headerMatchShape).array(),
});

/** One `GRPCRoute.spec.rules[].matches[]` entry. */
export type GRPCRouteMatch = typeof GRPCRouteMatchSchema.infer;

/**
 * One `GRPCRoute.spec.rules[]` entry.
 *
 * The CRD accepts only the four filter types that make sense for gRPC
 * (`RequestHeaderModifier`, `ResponseHeaderModifier`, `RequestMirror`,
 * `ExtensionRef`) but reuses the HTTP filter shape, which is what
 * {@link HTTPRouteFilterSchema} models.
 */
export const GRPCRouteRuleSchema = type({
  'name?': 'string',
  'matches?': GRPCRouteMatchSchema.array(),
  'filters?': HTTPRouteFilterSchema.array(),
  'backendRefs?': routeBackendRefSchema.array(),
  'sessionPersistence?': sessionPersistenceShape,
});

/** One `GRPCRoute.spec.rules[]` entry. */
export type GRPCRouteRule = typeof GRPCRouteRuleSchema.infer;

/** `GRPCRoute.spec`. */
export const GRPCRouteSpecSchema = type({
  parentRefs: ParentReferenceSchema.array(),
  'hostnames?': 'string[]',
  'rules?': GRPCRouteRuleSchema.array(),
});

/** `GRPCRoute.spec`. */
export type GRPCRouteSpec = typeof GRPCRouteSpecSchema.infer;

// ============================================================================
// ReferenceGrant / BackendTLSPolicy
// ============================================================================

/**
 * `ReferenceGrant.spec` — the opt-in a namespace publishes so resources in
 * `from` namespaces may reference the listed `to` resources in this namespace.
 */
export const ReferenceGrantSpecSchema = type({
  from: type({
    group: 'string',
    kind: 'string',
    namespace: 'string',
  }).array(),
  to: type({
    group: 'string',
    kind: 'string',
    'name?': 'string',
  }).array(),
});

/** `ReferenceGrant.spec`. */
export type ReferenceGrantSpec = typeof ReferenceGrantSpecSchema.infer;

/**
 * `BackendTLSPolicy.spec`.
 *
 * Kept general on purpose: Envoy Gateway targets its own `Backend` kind while
 * other controllers target `Service`, so `targetRefs[].group`/`kind` are plain
 * strings rather than one vendor's literals.
 */
export const BackendTLSPolicySpecSchema = type({
  targetRefs: type({
    group: 'string',
    kind: 'string',
    name: 'string',
    'sectionName?': 'string',
  }).array(),
  validation: {
    hostname: 'string',
    'wellKnownCACertificates?': '"System"',
    'caCertificateRefs?': type(caCertificateRefShape).array(),
    'subjectAltNames?': type({
      type: '"Hostname" | "URI"',
      'hostname?': 'string',
      'uri?': 'string',
    }).array(),
  },
  'options?': 'Record<string, string>',
});

/** `BackendTLSPolicy.spec`. */
export type BackendTLSPolicySpec = typeof BackendTLSPolicySpecSchema.infer;

// ============================================================================
// Resource configuration
//
// The identity half of every Gateway API factory's config. `spec` is the only
// part that varies by kind, so it stays a type parameter (see
// `resources/gateway.ts`) while everything a caller types by hand is declared
// once, here, and inferred from.
// ============================================================================

const kubernetesName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 253');
const kubernetesDnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');

/**
 * Identity fields every Gateway API resource factory accepts.
 *
 * These schemas are the source of truth for the TYPES and the target of the
 * schema tests; the factories do not run them over their input, because inside
 * a composition `name` may be a `KubernetesRef` proxy rather than a string and
 * every constraint here would reject it.
 */
export const gatewayApiClusterResourceMetadataShape = {
  name: kubernetesName,
  /** Extra labels merged onto `metadata.labels`. */
  'labels?': 'Record<string, string>',
  /** Extra annotations merged onto `metadata.annotations`. */
  'annotations?': 'Record<string, string>',
  /** Resource graph id. Required when `name` is a schema reference. */
  'id?': 'string > 0',
} as const;

/** Identity fields every namespaced Gateway API resource factory accepts. */
export const gatewayApiNamespacedResourceMetadataShape = {
  ...gatewayApiClusterResourceMetadataShape,
  namespace: kubernetesDnsLabel,
} as const;

/** Identity of a cluster-scoped Gateway API resource, without its spec. */
export const GatewayApiClusterResourceMetadataSchema = type(gatewayApiClusterResourceMetadataShape);

/** Identity of a cluster-scoped Gateway API resource, without its spec. */
export type GatewayApiClusterResourceMetadata =
  typeof GatewayApiClusterResourceMetadataSchema.infer;

/** Identity of a namespaced Gateway API resource, without its spec. */
export const GatewayApiNamespacedResourceMetadataSchema = type(
  gatewayApiNamespacedResourceMetadataShape
);

/** Identity of a namespaced Gateway API resource, without its spec. */
export type GatewayApiNamespacedResourceMetadata =
  typeof GatewayApiNamespacedResourceMetadataSchema.infer;

/**
 * Configuration for `backendTLSPolicy`.
 *
 * Fully inferred rather than generic: a `BackendTLSPolicy` has exactly one
 * spec shape, so there is nothing for a type parameter to vary.
 */
export const BackendTLSPolicyConfigSchema = type({
  ...gatewayApiNamespacedResourceMetadataShape,
  /**
   * The `GatewayClass.spec.controllerName` whose ancestor conditions decide
   * readiness. A cluster can run several Gateway API controllers, and each one
   * publishes its own ancestor entry.
   */
  controllerName: 'string > 0',
  spec: BackendTLSPolicySpecSchema,
});

/** Configuration for `backendTLSPolicy`. */
export type BackendTLSPolicyConfig = typeof BackendTLSPolicyConfigSchema.infer;
