/**
 * Traefik v3 factory.
 *
 * Stands Traefik up as a cluster edge — the Helm repository, the Helm release
 * and a status contract — and exposes its `traefik.io/v1alpha1` CRDs as typed
 * factories: `IngressRoute`, `IngressRouteTCP`, `Middleware` (the OSS
 * middleware set as a discriminated union), `TLSOption`, `TLSStore`,
 * `ServersTransport` and `TraefikService`.
 *
 * Traefik's Gateway API support comes from the shared
 * `src/factories/gateway-api` module rather than a Traefik-specific copy of the
 * upstream kinds.
 *
 * @security Secure by construction: the dashboard and the insecure API cannot
 * be enabled through this factory, `forwardAuth` defaults to
 * `trustForwardHeader: false` with an explicit `authResponseHeaders`
 * allowlist, `TLSOption` defaults to TLS 1.2 with `sniStrict`, and the proxy
 * runs non-root with a read-only root filesystem.
 */
export * from './compositions/index.js';
export * from './constants.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
