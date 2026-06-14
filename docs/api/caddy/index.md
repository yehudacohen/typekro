# Caddy

A **config-driven Caddy reverse proxy** for TypeKro. Unlike the Caddy ingress-controller (which watches
`Ingress` resources) or a Helm bootstrap, this runs the official `caddy` image with a **Caddyfile you
supply** and emits a ConfigMap (the Caddyfile) + Deployment + Service + PVC.

Its headline feature is **`tls internal`**: Caddy's built-in local CA issues valid certificates for any
name — including private TLDs like `*.acme.internal` — with **no cert-manager, no ACME, and no etcd**. The
PVC persists `/data` so the CA root is stable across restarts; trust that root once and every site is
green-locked.

```ts
import { caddyIngress, renderCaddyfile } from 'typekro/caddy';
```

## What gets created

| Resource | Purpose |
| --- | --- |
| `ConfigMap` | holds the Caddyfile (`spec.caddyfile`) |
| `PersistentVolumeClaim` | persists `/data` — the `tls internal` CA root + issued certs |
| `Deployment` | runs `caddy:<version>` mounting the Caddyfile + the PVC |
| `Service` | exposes the proxy (ClusterIP by default) |
| `Namespace` | the Caddy workload namespace |

## Quick example

```ts
import { caddyIngress, renderCaddyfile } from 'typekro/caddy';

// Build the Caddyfile from concrete host -> upstream routes.
const caddyfile = renderCaddyfile([
  { host: 'dagster-dev.acme.internal', upstream: 'dagster.dagster-platform-dev.svc:80' },
  { host: 'signoz.acme.internal', upstream: 'signoz.observability.svc:3301' },
]);
// =>
//   dagster-dev.acme.internal {
//       tls internal
//       reverse_proxy dagster.dagster-platform-dev.svc:80
//   }
//   ...

const factory = caddyIngress.factory('direct', { namespace: 'caddy-system' });
await factory.deploy({ name: 'caddy', namespace: 'caddy-system', caddyfile });
```

## `renderCaddyfile(routes, options?)`

A pure helper that turns host→upstream routes into a Caddyfile string. Kept separate from the composition
so the composition stays a string passthrough (KRO-safe — see below).

- `tls: 'internal'` (default) — each site uses Caddy's local CA (`tls internal`).
- `tls: 'off'` — sites are addressed as `http://<host>` (plain HTTP, no auto-HTTPS).

## Configuration

| Field | Default | Notes |
| --- | --- | --- |
| `name` | — | required |
| `caddyfile` | — | **required**; the full Caddyfile content (a string) |
| `namespace` | `caddy-system` | Caddy workload namespace |
| `image` | `caddy:2.11.2` | full container image ref **including the tag** (one field — not `image:version` — so the KRO default applies cleanly) |
| `version` | `2.11.2` | version label/status hint (`app.kubernetes.io/version` + `status.version`); cosmetic — set it to match your `image` tag |
| `replicaCount` | `1` | stays 1 by default — `tls internal` keeps its CA in a RWO PVC one pod owns |
| `httpPort` / `httpsPort` | `80` / `443` | Service + container ports |
| `serviceType` | `ClusterIP` | reach it via a tunnel; no public LB by default |
| `persistence.size` | `1Gi` | size of the always-created `/data` PVC |
| `persistence.storageClass` | cluster default | storage class for the PVC |
| `resources` | — | container requests/limits |

## Why the Caddyfile is a string (KRO safety)

The composition takes the Caddyfile as a **string**, not a structured `routes` array. In KRO mode a
`routes` array would be a graph proxy that can't be `.map()`-ed into a string at graph-generation time.
Passing the rendered string keeps the composition identical in **direct** and **KRO** modes. Build the
string with `renderCaddyfile()` wherever you have concrete routes (e.g. a generator that knows its
services), then pass it as `caddyfile`.

## Readiness & status

| Field | Meaning |
| --- | --- |
| `ready` | the Deployment has `readyReplicas >=` its desired replicas (respects `replicaCount` in both modes) |
| `version` | the deploy-time version label (static, not runtime) |

## Factory modes

`caddyIngress.factory('kro', …)` generates a `ResourceGraphDefinition`; `caddyIngress.factory('direct', …)`
applies the resources directly. `toYaml()` renders the RGD for GitOps.

## Prerequisites

- A **default StorageClass** (or set `persistence.storageClass`) so the `/data` PVC binds.
- To get a green lock in a browser/client, **trust Caddy's internal CA root** once (Caddy serves it; it's
  also in the PVC under `/data/caddy/pki/authorities/local/root.crt`).

## Next steps

- [`tls internal` directive](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Caddy PKI app / local CA](https://caddyserver.com/docs/caddyfile/directives/tls#internal)
