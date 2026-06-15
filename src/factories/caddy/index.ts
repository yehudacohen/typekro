/**
 * Caddy Integration for TypeKro.
 *
 * A CONFIG-DRIVEN Caddy reverse proxy (official `caddy` image + a supplied Caddyfile) — not the Caddy
 * ingress-controller and not a Helm bootstrap. Emits ConfigMap (Caddyfile) + Deployment + Service + a
 * `/data` volume. Caddy's `tls internal` issues certs from a built-in local CA (no cert-manager). By
 * default `/data` is a PVC so the CA root is stable across restarts; `makeCaddyIngress({ ephemeral: true })`
 * uses an `emptyDir` instead (CA regenerates per pod) so the plane tolerates node/AZ changes.
 *
 * ## Compositions
 * - `caddyIngress` — runs Caddy with a supplied Caddyfile (kro + direct modes); PVC-backed `/data`.
 * - `makeCaddyIngress(options)` — the constructor behind `caddyIngress`; pass `{ ephemeral: true }` for an
 *   `emptyDir`-backed `/data` (no PVC; takes no `persistence` config).
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
