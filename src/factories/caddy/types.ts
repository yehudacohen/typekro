/**
 * Caddy Ingress Types
 *
 * Caddy here is a CONFIG-DRIVEN reverse proxy (not the Caddy ingress-controller, and not a Helm
 * bootstrap): the composition runs the official `caddy` image with a Caddyfile we supply, and emits a
 * ConfigMap (Caddyfile) + Deployment + Service + PVC. Caddy's built-in `tls internal` issues certs from a
 * local CA (no cert-manager), so the PVC persists `/data` (the CA root) across restarts.
 *
 * KRO-safety note: the Caddyfile is supplied as a STRING (`caddyfile`), not derived from a structured
 * `routes` array inside the composition. A `routes` array would be a graph proxy in KRO mode and cannot be
 * `.map()`-ed into a string (see integration-skill rules 32/48). Use the exported `renderCaddyfile()`
 * helper to build the string from routes in concrete (consumer/direct) contexts, then pass it here.
 */

import { type } from 'arktype';

/** Container resource requests/limits — shared shape. */
const resourceRequirementsSchemaShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

/**
 * Sizing for the PVC backing Caddy's `/data` (the `tls internal` CA root + issued certs). The PVC is
 * always created — persisting the CA root is required so it's stable across restarts; an ephemeral/emptyDir
 * mode isn't offered because a conditional volume can't be expressed safely in KRO (compound includeWhen).
 */
const persistenceSchemaShape = {
  'size?': 'string',
  'storageClass?': 'string',
} as const;

/**
 * Caddy ingress config. `caddyfile` is the raw Caddyfile content (the routing + TLS config), supplied as
 * a string so it passes through unchanged in both direct and KRO modes.
 */
export const CaddyIngressConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  /** Full Caddyfile content. Build it from routes via `renderCaddyfile()` when you have concrete routes. */
  caddyfile: 'string',
  /** Full container image ref INCLUDING the tag (default `caddy:2.11.2`). */
  'image?': 'string',
  /**
   * Version label/status hint — surfaced as `app.kubernetes.io/version` + `status.version` (default
   * `2.11.2`). Cosmetic only; the running tag comes from `image`. Set it to match your `image` tag.
   */
  'version?': 'string',
  /**
   * Replica count (default 1). Stays 1 by default because `tls internal` keeps its CA in the PVC `/data`
   * (a RWO volume one pod owns); HA needs RWX storage or externalized certs.
   */
  'replicaCount?': 'number',
  /** HTTP listener port on the Service + container (default 80). */
  'httpPort?': 'number',
  /** HTTPS listener port on the Service + container (default 443). */
  'httpsPort?': 'number',
  /** Service type (default ClusterIP — reached via the access tunnel; no public LB). */
  'serviceType?': '"ClusterIP" | "NodePort" | "LoadBalancer"',
  /** Sizing for the always-created `/data` PVC that holds the `tls internal` CA root (default 1Gi). */
  'persistence?': persistenceSchemaShape,
  'resources?': resourceRequirementsSchemaShape,
});
export type CaddyIngressConfig = typeof CaddyIngressConfigSchema.infer;

/**
 * Caddy ingress status. `ready` is a direct Deployment-proxy comparison (multi-resource non-Helm
 * composition → no `Cel.expr`/conditions array): `status.readyReplicas >= spec.replicas` (the Deployment's
 * own desired count). It resolves in BOTH kro CEL and direct-mode hydration (spec refs hydrate via the
 * LIVE_SPEC_KEY core change) — unlike the JS `replicaCount ?? 1` const, which bakes the literal `1` into
 * kro and makes it ignore replicaCount. `version` is the deploy-time version label (static). No `phase`
 * field: a `ready ? 'Ready' : 'Installing'` ternary referencing a resource ref currently serializes to a
 * malformed CEL (`caddyDeployment.schema.spec.replicas`) — a typekro analyzer bug to fix separately;
 * `ready` carries the signal anyway.
 */
export const CaddyIngressStatusSchema = type({
  ready: 'boolean',
  'version?': 'string',
});
export type CaddyIngressStatus = typeof CaddyIngressStatusSchema.infer;

/** A single host→upstream route, for the `renderCaddyfile()` helper (NOT a composition spec field). */
export interface CaddyRoute {
  /** The hostname Caddy serves, e.g. `dagster-dev.acme.internal`. */
  host: string;
  /** The upstream `host:port` Caddy reverse-proxies to, e.g. `dagster.dagster-platform-dev.svc:80`. */
  upstream: string;
}

/** Options for `renderCaddyfile()`. */
export interface RenderCaddyfileOptions {
  /** TLS mode per site. `internal` (default) uses Caddy's local CA; `off` serves plain HTTP. */
  tls?: 'internal' | 'off';
}
