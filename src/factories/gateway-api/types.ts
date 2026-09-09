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
 */

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

/**
 * `GatewayClass.spec`.
 *
 * `TController` lets an implementation pin its own controller name as a literal
 * type (e.g. `GatewayClassSpec<'traefik.io/gateway-controller'>`) while the
 * unparameterized form stays usable for generic tooling.
 */
export interface GatewayClassSpec<TController extends string = string> {
  readonly controllerName: TController;
  readonly description?: string;
  readonly parametersRef?: {
    readonly group: string;
    readonly kind: string;
    readonly name: string;
    readonly namespace?: string;
  };
}

/** Which namespaces a listener accepts routes from. */
export interface AllowedRoutes {
  readonly namespaces?: {
    readonly from?: 'All' | 'Selector' | 'Same';
    readonly selector?: {
      readonly matchLabels?: Readonly<Record<string, string>>;
    };
  };
  readonly kinds?: readonly {
    readonly group?: string;
    readonly kind: string;
  }[];
}

/** A certificate or CA reference used by listener TLS configuration. */
export interface SecretObjectReference {
  readonly group?: string;
  readonly kind?: string;
  readonly name: string;
  readonly namespace?: string;
}

/** `Gateway.spec.listeners[].tls`. */
export interface GatewayTLSConfig {
  readonly mode?: 'Terminate' | 'Passthrough';
  readonly certificateRefs?: readonly SecretObjectReference[];
  readonly options?: Readonly<Record<string, string>>;
}

/** A single `Gateway.spec.listeners[]` entry. */
export interface GatewayListener {
  readonly name: string;
  readonly protocol: 'HTTP' | 'HTTPS' | 'TLS' | 'TCP' | 'UDP';
  readonly port: number;
  readonly hostname?: string;
  readonly tls?: GatewayTLSConfig;
  readonly allowedRoutes?: AllowedRoutes;
}

/** `Gateway.spec`. */
export interface GatewaySpec {
  readonly gatewayClassName: string;
  readonly listeners: readonly GatewayListener[];
  readonly addresses?: readonly {
    readonly type?: string;
    readonly value: string;
  }[];
  readonly infrastructure?: {
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
  };
}

/** A route's reference to the Gateway (or listener) it attaches to. */
export interface ParentReference {
  readonly group?: string;
  readonly kind?: 'Gateway';
  readonly name: string;
  readonly namespace?: string;
  readonly sectionName?: string;
  readonly port?: number;
}

/** A backend a route rule forwards to. */
export interface BackendRef {
  readonly group?: string;
  readonly kind?: string;
  readonly name: string;
  readonly namespace?: string;
  readonly port?: number;
  readonly weight?: number;
}

/** One `HTTPRoute.spec.rules[].matches[]` entry. */
export interface HTTPRouteMatch {
  readonly path?: {
    readonly type?: 'Exact' | 'PathPrefix' | 'RegularExpression';
    readonly value: string;
  };
  readonly headers?: readonly {
    readonly type?: 'Exact' | 'RegularExpression';
    readonly name: string;
    readonly value: string;
  }[];
  readonly queryParams?: readonly {
    readonly type?: 'Exact' | 'RegularExpression';
    readonly name: string;
    readonly value: string;
  }[];
  readonly method?: string;
}

/** A header modification applied by an `HTTPRoute` filter. */
export interface HTTPHeaderFilter {
  readonly set?: readonly { readonly name: string; readonly value: string }[];
  readonly add?: readonly { readonly name: string; readonly value: string }[];
  readonly remove?: readonly string[];
}

/**
 * One `HTTPRoute.spec.rules[].filters[]` entry.
 *
 * `extensionRef` is how an implementation attaches its own middleware — Traefik
 * uses it to reference a `traefik.io/v1alpha1` `Middleware`.
 */
export interface HTTPRouteFilter {
  readonly type:
    | 'RequestHeaderModifier'
    | 'ResponseHeaderModifier'
    | 'RequestMirror'
    | 'RequestRedirect'
    | 'URLRewrite'
    | 'ExtensionRef';
  readonly requestHeaderModifier?: HTTPHeaderFilter;
  readonly responseHeaderModifier?: HTTPHeaderFilter;
  readonly requestRedirect?: {
    readonly scheme?: 'http' | 'https';
    readonly hostname?: string;
    readonly port?: number;
    readonly statusCode?: 301 | 302;
    readonly path?: {
      readonly type: 'ReplaceFullPath' | 'ReplacePrefixMatch';
      readonly replaceFullPath?: string;
      readonly replacePrefixMatch?: string;
    };
  };
  readonly urlRewrite?: {
    readonly hostname?: string;
    readonly path?: {
      readonly type: 'ReplaceFullPath' | 'ReplacePrefixMatch';
      readonly replaceFullPath?: string;
      readonly replacePrefixMatch?: string;
    };
  };
  readonly requestMirror?: {
    readonly backendRef: BackendRef;
  };
  readonly extensionRef?: {
    readonly group: string;
    readonly kind: string;
    readonly name: string;
  };
}

/** One `HTTPRoute.spec.rules[]` entry. */
export interface HTTPRouteRule {
  readonly name?: string;
  readonly matches?: readonly HTTPRouteMatch[];
  readonly filters?: readonly HTTPRouteFilter[];
  readonly backendRefs?: readonly (BackendRef & {
    readonly filters?: readonly HTTPRouteFilter[];
  })[];
  readonly timeouts?: {
    readonly request?: string;
    readonly backendRequest?: string;
  };
  readonly retry?: {
    readonly codes?: readonly number[];
    readonly attempts?: number;
    readonly backoff?: string;
  };
  readonly sessionPersistence?: {
    readonly sessionName?: string;
    readonly absoluteTimeout?: string;
    readonly idleTimeout?: string;
    readonly type?: 'Cookie' | 'Header';
  };
}

/** `HTTPRoute.spec`. */
export interface HTTPRouteSpec {
  readonly parentRefs: readonly ParentReference[];
  readonly hostnames?: readonly string[];
  readonly rules?: readonly HTTPRouteRule[];
}

/** One `GRPCRoute.spec.rules[].matches[]` entry. */
export interface GRPCRouteMatch {
  readonly method?: {
    readonly type?: 'Exact' | 'RegularExpression';
    readonly service?: string;
    readonly method?: string;
  };
  readonly headers?: readonly {
    readonly type?: 'Exact' | 'RegularExpression';
    readonly name: string;
    readonly value: string;
  }[];
}

/** One `GRPCRoute.spec.rules[]` entry. */
export interface GRPCRouteRule {
  readonly name?: string;
  readonly matches?: readonly GRPCRouteMatch[];
  readonly filters?: readonly HTTPRouteFilter[];
  readonly backendRefs?: readonly BackendRef[];
  readonly sessionPersistence?: {
    readonly sessionName?: string;
    readonly type?: 'Cookie' | 'Header';
  };
}

/** `GRPCRoute.spec`. */
export interface GRPCRouteSpec {
  readonly parentRefs: readonly ParentReference[];
  readonly hostnames?: readonly string[];
  readonly rules?: readonly GRPCRouteRule[];
}

/**
 * `ReferenceGrant.spec` — the opt-in a namespace publishes so resources in
 * `from` namespaces may reference the listed `to` resources in this namespace.
 */
export interface ReferenceGrantSpec {
  readonly from: readonly {
    readonly group: string;
    readonly kind: string;
    readonly namespace: string;
  }[];
  readonly to: readonly {
    readonly group: string;
    readonly kind: string;
    readonly name?: string;
  }[];
}

/**
 * `BackendTLSPolicy.spec`.
 *
 * Kept general on purpose: Envoy Gateway targets its own `Backend` kind while
 * other controllers target `Service`, so `targetRefs[].group`/`kind` are plain
 * strings rather than one vendor's literals.
 */
export interface BackendTLSPolicySpec {
  readonly targetRefs: readonly {
    readonly group: string;
    readonly kind: string;
    readonly name: string;
    readonly sectionName?: string;
  }[];
  readonly validation: {
    readonly hostname: string;
    readonly wellKnownCACertificates?: 'System';
    readonly caCertificateRefs?: readonly {
      readonly group: string;
      readonly kind: string;
      readonly name: string;
    }[];
    readonly subjectAltNames?: readonly {
      readonly type: 'Hostname' | 'URI';
      readonly hostname?: string;
      readonly uri?: string;
    }[];
  };
  readonly options?: Readonly<Record<string, string>>;
}
