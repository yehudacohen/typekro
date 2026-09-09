---
title: Traefik Factories
description: Factory functions for a Traefik v3 cluster edge — Helm bootstrap, typed CRDs, middleware and Gateway API
---

# Traefik Factories

::: warning Experimental
Traefik factories are experimental. The API may change in future releases.
:::

Stand Traefik v3 up as a cluster edge with a typed status contract, then express
routing, middleware and TLS with typed factories instead of hand-written CRD
YAML.

Verified against the official `traefik` chart **41.5.0** (Traefik Proxy
`v3.7.13`) from `https://traefik.github.io/charts`. That chart carries the
`traefik.io/v1alpha1` CRDs in its own `crds/` directory, so one `HelmRelease`
installs the CRDs and the proxy together — there is no separate `traefik-crds`
release to keep in version lockstep.

## Installation

```typescript
import * as traefik from 'typekro/traefik';
```

## Quick example

```typescript
import * as traefik from 'typekro/traefik';

const factory = traefik.traefikBootstrap.factory('direct', {
  namespace: 'flux-system',
  waitForReady: true,
  timeout: 600_000,
  kubeConfig,
});

const edge = await factory.deploy({
  name: 'traefik',
  namespace: 'traefik',
  replicas: 2,
  service: {
    type: 'LoadBalancer',
    annotations: {
      'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
      'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
      'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
    },
  },
  providers: { crd: true },
  accessLogs: true,
});

// edge.status.loadBalancer.hostname → the NLB hostname to point DNS at
```

## Available factories

| Factory | Description |
|---------|-------------|
| `traefikBootstrap` | Deploy Traefik via Helm with secure defaults and a status contract |
| `makeTraefikBootstrap` | Build a bootstrap variant (namespace lifecycle, default TLS resources, redirect, raw chart values) |
| `traefikHelmRepositoryBootstrap` | Singleton owner of the shared official chart `HelmRepository` |
| `traefikHelmRepository` / `traefikHelmRelease` | The two Flux resources, for graphs that compose them directly |
| `traefikIngressRoute` / `traefikIngressRouteTCP` | Typed HTTP and TCP routers |
| `traefikService` | Typed `TraefikService` — weighted, mirroring, failover, highest-random-weight |
| `traefikServersTransport` | Upstream TLS trust, connection pooling and forwarding timeouts |
| `traefikMiddleware` | The whole OSS middleware set as a discriminated union |
| `traefikForwardAuthMiddleware` … `traefikChainMiddleware` | Typed builders carrying the secure defaults |
| `traefikTLSOption` / `traefikTLSStore` | TLS policy and the default certificate |
| `traefikGatewayClass` / `traefikGateway` / `traefikHTTPRoute` / `traefikGRPCRoute` | Gateway API, via the shared `gateway-api` module |
| `mapTraefikConfigToHelmValues` / `validateTraefikHelmValues` | Values mapping and edge-configuration warnings |
| `validateTraefikMiddlewareSpec` | The exactly-one-middleware rule, callable directly |

## Bootstrap composition

### Runtime spec

Only proxy-safe values live in the runtime spec, so every field serializes as a
CEL reference in KRO mode:

```typescript
interface TraefikBootstrapConfig {
  name: string;
  namespace?: string;
  chartVersion?: string;
  replicas?: number;
  ingressClass?: string;
  service?: {
    type?: 'LoadBalancer' | 'NodePort' | 'ClusterIP';
    annotations?: Record<string, string>;
  };
  // Both entrypoints are always published by the Service the bootstrap owns:
  // whether a port EXISTS is structural, so it cannot come from a value that
  // may be a schema reference.
  entrypoints?: {
    web?: { exposedPort?: number };
    websecure?: {
      exposedPort?: number;
      readTimeout?: string;
      writeTimeout?: string;
      idleTimeout?: string;
    };
  };
  providers?: { crd?: boolean; gatewayApi?: boolean; kubernetesIngress?: boolean };
  accessLogs?: boolean;
  logLevel?: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'PANIC';
  otlp?: { endpoint: string; insecure?: boolean; serviceName?: string };
  dashboard?: false;
}
```

`dashboard` is typed as the literal `false`. There is no value of this contract
that turns the dashboard on.

### Build-time options

Choices that decide **which** resources the graph contains cannot come from the
runtime spec — a schema reference is always present, so a JavaScript branch on
one is always taken. They are arguments to `makeTraefikBootstrap` instead:

```typescript
const edge = traefik.makeTraefikBootstrap({
  name: 'traefik-edge',
  kind: 'TraefikEdge',
  // 'external' when a parent graph already establishes the namespace
  namespaceOwnership: 'owned',
  // The chart disables the redirect by OMITTING the redirection block
  redirectWebToWebsecure: true,
  defaultTlsOption: { minVersion: 'VersionTLS13' },
  defaultTlsStore: { defaultCertificateSecretName: 'edge-wildcard-tls' },
  // Flux CRD policy, applied to install AND upgrade. 'Skip' only when the
  // traefik.io CRDs are managed by something else.
  crds: 'CreateReplace',
  // Chart surface this factory does not model. The security pins still win.
  values: { podDisruptionBudget: { enabled: true, minAvailable: 1 } },
});
```

### CRD lifecycle

Chart 41.5.0 ships the `traefik.io/v1alpha1` CRDs in its own `crds/` directory,
so one `HelmRelease` installs the CRDs and the proxy together. Flux, however,
defaults `spec.upgrade.crds` to `Skip` — a chart bump would install a newer
proxy against the CRD schemas the release was *first* created with. Both
`install.crds` and `upgrade.crds` are therefore set from one option, defaulting
to `CreateReplace`.

### Status contract

```typescript
interface TraefikBootstrapStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  loadBalancer: { hostname: string; ip: string };
  serviceName: string;
}
```

`ready` / `failed` / `phase` come from the `HelmRelease`'s Ready condition,
ignoring conditions stale for the current generation. `loadBalancer` reports the
first `status.loadBalancer.ingress` entry of the entrypoint Service that carries
the field — an entry carries `ip` or `hostname`, rarely both, and a load
balancer may report several. Both fields stay `''` for a `ClusterIP` or
`NodePort` Service and while a cloud controller is still provisioning.
`serviceName` is read back from the same Service — the values mapper pins
`fullnameOverride` to `spec.name`, so the name is deterministic.

Every field is a projection of a resource the composition **owns**. That rules
out literals: KRO leaves literal status fields unset, so declaring one would
put a field in the status schema that the instance never carries. The
entrypoint *names* are consequently not part of this contract — they are fixed
by the composition and exported as `TRAEFIK_WEB_ENTRYPOINT` and
`TRAEFIK_WEBSECURE_ENTRYPOINT`.

### The entrypoint Service is owned, not observed

The chart would normally create the entrypoint Service, and an earlier revision
of this factory read it back with `observedResource`. That cannot work for a
fresh deployment: `DirectDeploymentEngine` resolves every external reference
*before* it applies anything, and a failed read is fatal — so the first deploy
died on a `404` for a Service the release had not created yet, and `dependsOn`
could not reorder it because the read happens before the dependency graph is
walked.

The factory therefore disables the chart's Service (`service.enabled: false`)
and creates a typed one instead, selecting the chart's pods through
`app.kubernetes.io/name` and `app.kubernetes.io/instance`. Both label sources
are pinned (`nameOverride`, `instanceLabelOverride`) so the selector cannot
drift with the Helm release name Flux composes. Two consequences worth knowing:

- The Service type, its annotations and its published ports are properties of a
  resource TypeKro owns, not chart values. A `LoadBalancer` Service therefore
  participates in `waitForReady`.
- `providers.kubernetesIngress.publishedService.pathOverride` is set to the
  owned Service, because the chart only emits that flag for a Service it
  created itself. The chart's Gateway API `statusAddress.service` wiring has no
  such override and is skipped; set `providers.kubernetesGateway.statusAddress`
  through `values` if a Gateway needs a published address.

## Routing with typed CRDs

```typescript
const route = traefik.traefikIngressRoute({
  name: 'orders-api',
  namespace: 'edge',
  spec: {
    entryPoints: ['websecure'],
    ingressClassName: 'traefik',
    routes: [
      {
        match: 'Host(`api.example.com`) && PathPrefix(`/v1`)',
        kind: 'Rule',
        priority: 100,
        middlewares: [{ name: 'orders-api-edge' }],
        services: [{ name: 'orders-api', port: 8080, serversTransport: 'orders-api-slow' }],
      },
    ],
    tls: {
      secretName: 'orders-api-tls',
      options: { name: 'default', namespace: 'traefik' },
    },
  },
  id: 'ordersApiRoute',
});
```

`ingressClassName` is **required**, not decoration. The bootstrap sets
`providers.kubernetesCRD.ingressClass` (from `spec.ingressClass`, default
`traefik`), and Traefik then processes only the CRDs whose class matches — that
is what lets two Traefik installations share a cluster without stealing each
other's routes. An `IngressRoute` without it is silently ignored and the edge
answers `404`.

Traefik's `providers.kubernetesCRD.allowCrossNamespace` is `false` by default,
so an `IngressRoute` and the `Middleware` resources it names must share a
namespace unless you enable cross-namespace references through `values`.

### Timeouts above 60 seconds

An edge fronting long requests needs both halves raised — the entrypoint's
responding timeouts and the upstream transport's:

```typescript
// Entrypoint side, on the bootstrap spec
entrypoints: { websecure: { readTimeout: '120s', writeTimeout: '120s', idleTimeout: '180s' } }

// Upstream side
const transport = traefik.traefikServersTransport({
  name: 'orders-api-slow',
  namespace: 'edge',
  spec: {
    forwardingTimeouts: { responseHeaderTimeout: '120s', idleConnTimeout: '150s' },
  },
  id: 'ordersApiTransport',
});
```

## Middleware

`traefikMiddleware` takes a discriminated union over the OSS middleware set:
exactly one key. Two keys is a compile error, and is re-checked before
serialization because Traefik resolves such an object by applying one
middleware and silently dropping the other.

```typescript
// Rejected at compile time AND at build time
traefik.traefikMiddleware({
  name: 'both',
  namespace: 'edge',
  spec: { forwardAuth: { address: 'http://authz' }, rateLimit: { average: 10, burst: 20 } },
  id: 'both',
});
```

### forwardAuth to an in-cluster authorizer

```typescript
const authz = traefik.traefikForwardAuthMiddleware({
  name: 'orders-api-authz',
  namespace: 'edge',
  address: 'http://orders-authorizer.edge.svc.cluster.local:8080/authorize',
  // Explicit allowlist: only these headers are copied onto the upstream request
  authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
  authRequestHeaders: ['Authorization', 'X-Edge-Api-Key'],
  id: 'ordersApiAuthz',
});
```

`trustForwardHeader` defaults to `false`. Enable it only when every client
reaching the entrypoint is already behind a trusted proxy that rewrites
`X-Forwarded-*`; otherwise a caller can assert its own source address.

### Header-keyed rate limit with the Redis backend

```typescript
const rateLimit = traefik.traefikRateLimitMiddleware({
  name: 'orders-api-rate-limit',
  namespace: 'edge',
  average: 50,
  burst: 100,
  period: '1s',
  // The principal a preceding forwardAuth injected
  requestHeaderName: 'X-Edge-Principal',
  redis: {
    endpoints: ['valkey-primary.edge.svc.cluster.local:6379'],
    secret: 'valkey-auth',
    db: 3,
    dialTimeout: '500ms',
  },
  id: 'ordersApiRateLimit',
});
```

Without `redis` each Traefik replica keeps its own counters, so the effective
budget is `average × replicas`. Supply the backend whenever the budget must
hold for the whole edge. The `secret` names a Secret with `username` /
`password` keys.

### Concurrency cap, CORS, body limits and a chain

```typescript
const concurrency = traefik.traefikInFlightReqMiddleware({
  name: 'orders-api-concurrency',
  namespace: 'edge',
  amount: 20,
  requestHeaderName: 'X-Edge-Customer',
  id: 'ordersApiConcurrency',
});

const headers = traefik.traefikHeadersMiddleware({
  name: 'orders-api-headers',
  namespace: 'edge',
  headers: {
    accessControlAllowOriginList: ['https://console.example.com'],
    accessControlAllowMethods: ['GET', 'POST', 'OPTIONS'],
    accessControlAllowHeaders: ['authorization', 'content-type'],
    accessControlAllowCredentials: true,
    accessControlMaxAge: 600,
    addVaryHeader: true,
    frameDeny: true,
    contentTypeNosniff: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
    stsSeconds: 31_536_000,
    stsIncludeSubdomains: true,
  },
  id: 'ordersApiHeaders',
});

const bodyLimit = traefik.traefikBufferingMiddleware({
  name: 'orders-api-body-limit',
  namespace: 'edge',
  buffering: { maxRequestBodyBytes: 1_048_576, memRequestBodyBytes: 262_144 },
  id: 'ordersApiBodyLimit',
});

// One reference several routes can share
const chain = traefik.traefikChainMiddleware({
  name: 'orders-api-edge',
  namespace: 'edge',
  middlewares: [
    { name: 'orders-api-headers' },
    { name: 'orders-api-authz' },
    { name: 'orders-api-rate-limit' },
    { name: 'orders-api-concurrency' },
    { name: 'orders-api-body-limit' },
  ],
  id: 'ordersApiEdgeChain',
});
```

Middleware order matters: it is the order requests traverse. Put CORS first so
a preflight is answered before authorization, and authorization before the
rate limit so the budget is keyed on an authenticated principal.

## TLS via cert-manager

```typescript
import * as certManager from 'typekro/cert-manager';

const cert = certManager.certificate({
  name: 'edge-wildcard',
  namespace: 'traefik',
  spec: {
    secretName: 'edge-wildcard-tls',
    dnsNames: ['*.example.com'],
    issuerRef: { name: 'letsencrypt', kind: 'ClusterIssuer' },
  },
  id: 'edgeCertificate',
});

const option = traefik.traefikTLSOption({
  name: 'default',
  namespace: 'traefik',
  spec: { minVersion: 'VersionTLS13' },
  id: 'defaultTlsOption',
});

const store = traefik.traefikTLSStore({
  name: 'default',
  namespace: 'traefik',
  spec: { defaultCertificate: { secretName: 'edge-wildcard-tls' } },
  id: 'defaultTlsStore',
});
store.dependsOn(cert);
```

An omitted `minVersion` becomes `VersionTLS12` and an omitted `sniStrict`
becomes `true`. `sniStrict` rejects handshakes that would otherwise fall back
to Traefik's self-signed default certificate — a fallback that turns a
certificate misconfiguration into a silently insecure connection.

`TLSStore` and `TLSOption` named `default` are cluster-wide singletons in
Traefik, so only one namespace should own them. Chart 41.5.0 can restrict which
namespace that is through
`providers.kubernetesCRD.defaultTLSResourcesNamespace`.

## Gateway API

Traefik v3 implements upstream Gateway API, so these are thin wrappers over the
shared `src/factories/gateway-api` module — the same module
`envoy-ai-gateway` uses — with Traefik's controller name pinned.

```typescript
// Enable the provider on the bootstrap spec
providers: { crd: true, gatewayApi: true }

const route = traefik.traefikHTTPRoute({
  name: 'orders-api',
  namespace: 'edge',
  spec: {
    parentRefs: [{ name: 'traefik-gateway', namespace: 'traefik' }],
    hostnames: ['api.example.com'],
    rules: [
      {
        matches: [{ path: { type: 'PathPrefix', value: '/v1' } }],
        // Gateway API has no vendor-neutral forwardAuth/rateLimit filter, so a
        // Traefik Middleware attaches through an ExtensionRef
        filters: [traefik.traefikMiddlewareFilter('orders-api-authz')],
        backendRefs: [{ name: 'orders-api', port: 8080 }],
        timeouts: { request: '120s' },
      },
    ],
  },
  id: 'ordersApiHttpRoute',
});
```

`TRAEFIK_GATEWAY_CONTROLLER_NAME` is `traefik.io/gateway-controller`, so a
Traefik edge and an Envoy AI Gateway can coexist in one cluster, each claiming
its own `GatewayClass`.

## Readiness

Flux resources use the shared Helm readiness evaluators.

None of the `traefik.io/v1alpha1` kinds declares a `status` subresource — the
proxy consumes them as dynamic configuration and reports problems in its own
logs and metrics, never on the object. They are therefore registered as
always-ready, the same treatment `envoy-ai-gateway` gives Envoy Gateway's
status-less `Backend` kind. A condition-based evaluator would poll to its
deadline and then fail a deployment whose routing is in fact live.

Gateway API resources use the shared condition evaluators: `Accepted` for a
`GatewayClass`, `Accepted` plus `Programmed` for a `Gateway`, per-parent
`Accepted` / `ResolvedRefs` for routes, and per-ancestor conditions scoped to
Traefik's controller name for `BackendTLSPolicy`.

## Security defaults

| Default | Why |
|---------|-----|
| `api.dashboard: false`, `api.insecure: false`, `api.debug: false` | The chart ships the dashboard **on**. An exposed dashboard exposes the full routing table; `api.insecure` serves the API unauthenticated over plain HTTP. |
| Dashboard and healthcheck `IngressRoute` disabled | Nothing publishes those internal routers. |
| Internal `traefik` entrypoint never published by the Service | It serves `/ping`, metrics and the dashboard. |
| `forwardAuth.trustForwardHeader: false` with an explicit `authResponseHeaders` | A trusted `X-Forwarded-*` lets a caller assert its own identity; an implicit "copy everything" lets an authorizer bug leak headers upstream. |
| `TLSOption` `minVersion: VersionTLS12`, `sniStrict: true` | TLS 1.0/1.1 are deprecated by RFC 8996; `sniStrict` prevents a silent fallback to a self-signed certificate. |
| `runAsNonRoot`, `runAsUser: 65532`, `RuntimeDefault` seccomp | Traefik binds unprivileged container ports and needs no root. |
| `readOnlyRootFilesystem`, no privilege escalation, all capabilities dropped | Traefik needs no writable root; ACME storage gets an explicit volume. |
| `ingressClass.isDefaultClass: false` | Claiming the cluster-default class would silently capture every class-less `Ingress`. |
| `global.checkNewVersion: false`, `global.sendAnonymousUsage: false` | No phone-home from an edge. |

The `api.*` and security-context pins are applied **after** every other values
source, including `makeTraefikBootstrap({ values })`. Re-enabling them means not
using this factory.

`validateTraefikHelmValues(values)` returns warnings for legal-but-questionable
edge configuration: a bypassed pin, a disabled CRD provider, a single replica
behind a LoadBalancer, missing resource requests.

## Deliberately not exposed

- **Traefik Hub.** The chart's `hub.*` surface is a commercial product with its
  own CRDs and licensing. Reach it through `makeTraefikBootstrap({ values })`.
- **ACME certificate resolvers.** cert-manager is the supported certificate
  path; `certificatesResolvers` needs persistent storage and a resolver-specific
  lifecycle this factory does not model. `TLSStore.defaultGeneratedCert` accepts
  a resolver name for graphs that configure one through `values`.
- **The dashboard.** See above.
- **`api.insecure` and `api.debug`.** See above.
- **The `kubernetesIngressNGINX` and `knative` providers.** Experimental
  upstream; reachable through `values`.
- **Deprecated middleware aliases** (`ipWhiteList`, `middlewareTCP`). Use
  `ipAllowList`; the CRD still accepts the old name but the factory does not
  offer it.
- **OTLP access logs.** They require the chart's `experimental.otlpLogs` flag.
  Access logs are written to stdout as JSON, which a collector scrapes anyway.
  OTLP **metrics and traces** are wired by the `otlp` spec field.

## See also

- [`examples/traefik-edge.ts`](https://github.com/yehudacohen/typekro/blob/master/examples/traefik-edge.ts) — the full orders API edge scenario
- [Envoy AI Gateway](/api/envoy-ai-gateway/) — the other Gateway API implementation, sharing the same `gateway-api` module
- [cert-manager](/api/cert-manager/) — certificate issuance for the TLS store
