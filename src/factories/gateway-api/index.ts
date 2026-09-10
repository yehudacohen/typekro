/**
 * Shared upstream Gateway API factory.
 *
 * One implementation of `GatewayClass`, `Gateway`, `HTTPRoute`, `GRPCRoute`,
 * `ReferenceGrant` and `BackendTLSPolicy` plus their condition-based readiness
 * evaluators, consumed by every Gateway API implementation in TypeKro.
 *
 * Vendor-specific policy CRDs stay in their own factory packages.
 */
export * from './constants.js';
export * from './readiness.js';
export * from './resources/index.js';
export * from './types.js';
