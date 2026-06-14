/**
 * Caddy Integration for TypeKro.
 *
 * A CONFIG-DRIVEN Caddy reverse proxy (official `caddy` image + a supplied Caddyfile) — not the Caddy
 * ingress-controller and not a Helm bootstrap. Emits ConfigMap (Caddyfile) + Deployment + Service + PVC.
 * Caddy's `tls internal` issues certs from a built-in local CA (no cert-manager); the PVC persists `/data`
 * so the CA root is stable.
 *
 * ## Compositions
 * - `caddyIngress` — runs Caddy with a supplied Caddyfile (kro + direct modes).
 *
 * ## Helpers
 * - `renderCaddyfile(routes, opts)` — build the Caddyfile string from concrete host→upstream routes.
 *
 * @example
 * ```typescript
 * import { caddyIngress, renderCaddyfile } from 'typekro/caddy';
 *
 * const caddyfile = renderCaddyfile([
 *   { host: 'dagster-dev.acme.internal', upstream: 'dagster.dagster-platform-dev.svc:80' },
 * ]);
 * const factory = caddyIngress.factory('direct', { namespace: 'caddy-system' });
 * await factory.deploy({ name: 'caddy', caddyfile });
 * ```
 *
 * @see https://caddyserver.com/docs/caddyfile/directives/tls
 * @module
 */
export * from './compositions/index.js';
export * from './types.js';
export * from './utils/index.js';
