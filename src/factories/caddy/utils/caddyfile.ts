/**
 * Caddyfile rendering helper.
 *
 * Pure function: given concrete routes, produce a Caddyfile string. Kept OUT of the composition so the
 * composition stays a string passthrough (KRO-safe). Consumers with a concrete route list (e.g. a
 * generator that knows its services) call this, then pass the result as `caddyfile`.
 */

import type { CaddyRoute, RenderCaddyfileOptions } from '../types.js';

/**
 * Render a Caddyfile from host→upstream routes.
 *
 * - `tls: 'internal'` (default): each site uses Caddy's built-in local CA (`tls internal`) — valid certs
 *   for any name (incl. private TLDs like `.internal`), no ACME/cert-manager. Trust the root once.
 * - `tls: 'off'`: sites are addressed as `http://<host>` so Caddy serves plain HTTP (no auto-HTTPS).
 *
 * @example
 * renderCaddyfile([{ host: 'dagster-dev.acme.internal', upstream: 'dagster.dagster-platform-dev.svc:80' }])
 */
export function renderCaddyfile(
  routes: readonly CaddyRoute[],
  options: RenderCaddyfileOptions = {}
): string {
  const tls = options.tls ?? 'internal';
  const blocks = routes.map((route) => {
    const address = tls === 'off' ? `http://${route.host}` : route.host;
    const lines = [`${address} {`];
    if (tls === 'internal') lines.push('\ttls internal');
    lines.push(`\treverse_proxy ${route.upstream}`, '}');
    return lines.join('\n');
  });
  // Trailing newline keeps the file POSIX-clean and diff-friendly.
  return `${blocks.join('\n\n')}\n`;
}
