/**
 * Upstream Gateway API constants.
 *
 * These are vendor-neutral: every Gateway API implementation (Envoy Gateway,
 * Traefik v3, Istio, ...) reconciles the same group and kinds and differs only
 * in the `GatewayClass.spec.controllerName` it claims.
 */

/** Gateway API resource group. */
export const GATEWAY_API_GROUP = 'gateway.networking.k8s.io';

/** Standard-channel API version for `GatewayClass`, `Gateway`, `HTTPRoute`, `GRPCRoute`. */
export const GATEWAY_API_VERSION = 'gateway.networking.k8s.io/v1';

/** API version for `ReferenceGrant` (still v1beta1 in the standard channel). */
export const GATEWAY_API_REFERENCE_GRANT_VERSION = 'gateway.networking.k8s.io/v1beta1';

/** API version for `BackendTLSPolicy`. */
export const GATEWAY_API_TLS_POLICY_VERSION = 'gateway.networking.k8s.io/v1alpha3';

/**
 * Readiness-condition types published by Gateway API controllers.
 *
 * `Accepted` means the controller claimed the resource and its configuration is
 * valid; `Programmed` (Gateway only) means the data plane is serving it.
 */
export const GATEWAY_API_ACCEPTED_CONDITION = 'Accepted';
/** See {@link GATEWAY_API_ACCEPTED_CONDITION}. */
export const GATEWAY_API_PROGRAMMED_CONDITION = 'Programmed';
/** Route/policy condition reporting whether every `backendRef` resolved. */
export const GATEWAY_API_RESOLVED_REFS_CONDITION = 'ResolvedRefs';
