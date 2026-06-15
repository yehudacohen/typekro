# Caddy

A **config-driven Caddy reverse proxy** for TypeKro. Unlike the Caddy ingress-controller (which watches
`Ingress` resources) or a Helm bootstrap, this runs the official `caddy` image with a **Caddyfile you
supply** and emits a ConfigMap (the Caddyfile) + Deployment + Service + a `/data` volume — a PVC by
default, or an `emptyDir` in [ephemeral mode](#storage-persistent-vs-ephemeral).

Its headline feature is **`tls internal`**: Caddy's built-in local CA issues valid certificates for any
name — including private TLDs like `*.acme.internal` — with **no cert-manager, no ACME, and no etcd**. By
default a PVC persists `/data` so the CA root is stable across restarts (trust that root once and every
site is green-locked); in **ephemeral** mode `/data` is an `emptyDir` and the CA regenerates per pod.

```ts
import { caddyIngress, makeCaddyIngress, renderCaddyfile } from 'typekro/caddy';
```

## What gets created

| Resource | Purpose |
| --- | --- |
| `ConfigMap` | holds the Caddyfile (`spec.caddyfile`) |
| `PersistentVolumeClaim` | persists `/data` — the `tls internal` CA root + issued certs. **Default mode only** (omitted when ephemeral) |
| `Deployment` | runs `caddy:<version>` mounting the Caddyfile + the `/data` volume — **single replica**, `Recreate` strategy |
| `Service` | exposes the proxy (ClusterIP by default) |
| `Namespace` | the Caddy workload namespace |

> **Single replica by design.** Caddy keeps its `tls internal` CA in `/data`, and exactly one pod should
> own it — in the default mode that is a `ReadWriteOnce` PVC (multiple pods would need `ReadWriteMany` or
> an externalized CA); in ephemeral mode each pod would otherwise mint a *different* CA. So there is **no
> `replicaCount` knob** (the schema rejects it), the Deployment is pinned to one replica, and it uses the
> `Recreate` update strategy (a `RollingUpdate` would surge a second pod that can't co-mount the RWO PVC
> and wedge the rollout). HA is deliberately out of scope.

## Storage: persistent vs ephemeral

`caddyIngress` is the default, PVC-backed composition. For a plane that tolerates node/AZ changes, build an
**ephemeral** variant with `makeCaddyIngress({ ephemeral: true })`:

```ts
import { makeCaddyIngress } from 'typekro/caddy';

// emptyDir-backed /data — no PVC; the tls-internal CA regenerates per pod.
const factory = makeCaddyIngress({ ephemeral: true }).factory('kro', { namespace: 'caddy-system' });
```

| | Default (`caddyIngress`) | Ephemeral (`makeCaddyIngress({ ephemeral: true })`) |
| --- | --- | --- |
| `/data` volume | `PersistentVolumeClaim` (RWO) | `emptyDir` |
| CA root | persists across restarts | **regenerates per pod** (clients re-trust) |
| `persistence` config | `size` / `storageClass` honored | **rejected** (no PVC to size) |
| Survives a node/AZ change | ❌ pod can strand on the AZ-locked volume | ✅ reschedules anywhere |

Choose **ephemeral** when the CA's stability matters less than resilience — e.g. an internal access plane
where a stranded `Pending` pod (PV node-affinity mismatch after a node recycle) would take the ingress
down. The storage choice is **build-time** (a constructor option, not a spec field), so it selects the
resource set statically and never needs a runtime conditional. `makeCaddyIngress()` with no options is
identical to `caddyIngress`.

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
| `httpPort` / `httpsPort` | `80` / `443` | Service + container ports |
| `serviceType` | `ClusterIP` | reach it via a tunnel; no public LB by default |
| `persistence.size` | `1Gi` | size of the `/data` PVC. **Default mode only** — rejected in ephemeral mode |
| `persistence.storageClass` | cluster default | storage class for the PVC. **Default mode only** — rejected in ephemeral mode |
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
| `ready` | the Deployment's one pod is ready (`readyReplicas >= spec.replicas`); cannot report ready before that pod exists |
| `version` | the deploy-time version label (static, not runtime) |

## Factory modes

`caddyIngress.factory('kro', …)` generates a `ResourceGraphDefinition`; `caddyIngress.factory('direct', …)`
applies the resources directly. `toYaml()` renders the RGD for GitOps.

## Prerequisites

- In the default (PVC) mode, a **default StorageClass** (or set `persistence.storageClass`) so the `/data`
  PVC binds. Ephemeral mode needs no StorageClass.
- To get a green lock in a browser/client, **trust Caddy's internal CA root** once (Caddy serves it; it's
  also under `/data/caddy/pki/authorities/local/root.crt`). In ephemeral mode the CA changes whenever the
  pod restarts, so expect to re-trust then.

## Next steps

- [`tls internal` directive](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Caddy PKI app / local CA](https://caddyserver.com/docs/caddyfile/directives/tls#internal)
