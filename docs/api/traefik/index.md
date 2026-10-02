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
| `traefikTlsCertificate` | A cert-manager `Certificate` whose Secret Traefik serves |
| `awsNlbServiceAnnotations` | AWS Load Balancer Controller annotations for a TCP-passthrough NLB with PROXY protocol v2 |
| `traefikForwardAuthSecurePair` | `forwardAuth` behind a Middleware that strips client-supplied identity headers |
| `traefikPluginMiddleware` / `traefikSecretValue` | A plugin Middleware, and `urn:k8s:secret` values for its configuration |
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
    loadBalancerClass?: string; // LoadBalancer only, e.g. 'service.k8s.aws/nlb'
    externalTrafficPolicy?: 'Cluster' | 'Local'; // not valid on ClusterIP
    loadBalancerSourceRanges?: string[]; // LoadBalancer only
  };
  // Both entrypoints are always published by the Service the bootstrap owns:
  // whether a port EXISTS is structural, so it cannot come from a value that
  // may be a schema reference.
  entrypoints?: {
    web?: {
      exposedPort?: number;
      proxyProtocol?: { trustedIPs: string[] };
      forwardedHeaders?: { trustedIPs: string[] };
      requestAcceptGraceTimeout?: string; // default '10s'
      graceTimeOut?: string; // default '30s'
      aliasHeadersStrategy?: 'keep' | 'delete' | 'reject'; // default 'delete'
    };
    websecure?: {
      exposedPort?: number;
      proxyProtocol?: { trustedIPs: string[] };
      forwardedHeaders?: { trustedIPs: string[] };
      requestAcceptGraceTimeout?: string;
      graceTimeOut?: string;
      aliasHeadersStrategy?: 'keep' | 'delete' | 'reject';
      readTimeout?: string;
      writeTimeout?: string;
      idleTimeout?: string;
    };
  };
  providers?: {
    crd?: boolean;
    gatewayApi?: boolean;
    kubernetesIngress?: boolean;
    allowEmptyServices?: boolean; // default false
    namespaces?: string[]; // default: all namespaces
    allowCrossNamespace?: boolean; // default false
  };
  terminationGracePeriodSeconds?: number; // default 60
  podDisruptionBudget?: { enabled?: boolean; maxUnavailable?: number }; // default on, 1
  scheduling?: {
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    priorityClassName?: string;
    zoneSpread?: 'DoNotSchedule' | 'ScheduleAnyway'; // default 'ScheduleAnyway'
    nodeSpread?: 'DoNotSchedule' | 'ScheduleAnyway'; // default 'ScheduleAnyway'
  };
  accessLogs?: boolean;
  logLevel?: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'PANIC';
  otlp?: { endpoint: string; insecure?: boolean; serviceName?: string };
  dashboard?: false;
}
```

`dashboard` is typed as the literal `false`. There is no value of this contract
that turns the dashboard on.

`name` is capped at **53 characters**, and the cap is derived rather than
picked: it is the tightest of every object name the composition and the chart
build out of it. Helm's own `releaseNameMaxLen` of 53 is the binding one; the
chart's suffixed Services (`<name>-udp`, `<name>-metrics`) allow 59 and 55, and
the file-provider ConfigMap — a DNS *subdomain*, not a label — allows 239. The
validation message names whichever constraint bound the limit. Nothing is
reserved for Pod names: the API server generates those with
`metadata.generateName`, which truncates the base before appending its random
suffix, so a long `name` can never produce an invalid Pod name.

The 53 binds on `name` by itself. The `HelmRelease` pins `spec.releaseName` to
`name`, so the Helm release is installed under exactly that name. Left unset,
Flux composes the release name as `<targetNamespace>-<name>` whenever
`spec.targetNamespace` is set — which this composition always sets — and the
install namespace would quietly spend part of the same 53. Pinning it also
keeps the release name stable when `namespace` changes, which Helm would
otherwise see as a different release.

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
  // The chart disables the redirect by OMITTING the redirection block.
  // ACME HTTP-01 challenge paths are exempt (see "TLS via cert-manager").
  redirectWebToWebsecure: true,
  defaultTlsOption: { minVersion: 'VersionTLS13' },
  defaultTlsStore: { defaultCertificateSecretName: 'edge-wildcard-tls' },
  // Flux CRD policy, applied to install AND upgrade. 'Skip' only when the
  // traefik.io CRDs are managed by something else.
  crds: 'CreateReplace',
  // JSON access-log field policy; see "Access logs".
  accessLog: { preset: 'default' },
  // Chart surface this factory does not model. The security pins still win.
  // A raw podDisruptionBudget replaces the default one.
  values: { podDisruptionBudget: { enabled: true, minAvailable: 1 } },
});
```

#### Why raw values are build-time

Most Helm integrations also accept `values` on the *runtime* spec, serialized
for KRO as `json.unmarshal(json.marshal(schema.spec.values))` and merged last so
a user can override a default. This factory deliberately does not, because
KRO's `map.merge()` is **shallow**:

- Merging raw values last would let any KRO instance set `api.dashboard: true`,
  `api.insecure: true`, or hand the entrypoint Service back to the chart —
  precisely the things this factory exists to make unreachable.
- Merging the pins last to prevent that would replace whole top-level sections,
  silently discarding a caller's sibling keys under `api`, `ingressRoute`,
  `securityContext`, `podSecurityContext`, `service` and `global`.

A values contract with non-negotiable pins has to resolve precedence where the
merge can be deep and auditable, which is construction time. `makeTraefikBootstrap({ values })`
merges *beneath* the mapped values and the pins, and keeps unpinned siblings:
`api: { dashboard: true, basePath: '/dashboard' }` yields `dashboard: false`
with `basePath` intact.

Chart values are typed in two layers. `TraefikManagedHelmValues` is a **closed**
description — no index signatures at any depth — of the paths this factory maps,
pins or reads back, so a pin that stopped matching the chart is a compile error.
`TraefikRawHelmValues` (`Record<string, unknown>`) is the one named raw
boundary, and it is what `values` accepts: an override often has to reach a
sibling of a mapped path, such as `metrics.prometheus` beside the mapped
`metrics.otlp`, which a closed type would reject.

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
  version: string;
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

`version` is the chart version **Flux installed**, read off the `HelmRelease`'s
`status.history[]` rather than echoed from `spec.chartVersion`. It is therefore
a runtime observation, not a deploy-time literal: a pinned-but-unavailable
version is never reported as though it were live. It stays `''` until Flux has
recorded its first release.

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
drift with whatever the chart would derive from the Helm release name. Two
consequences worth knowing:

- The Service type, its annotations and its published ports are properties of a
  resource TypeKro owns, not chart values. A `LoadBalancer` Service therefore
  participates in `waitForReady`.
- `providers.kubernetesIngress.publishedService.pathOverride` is set to the
  owned Service, because the chart only emits that flag for a Service it
  created itself. The chart's Gateway API `statusAddress.service` wiring has no
  such override and is skipped; set `providers.kubernetesGateway.statusAddress`
  through `values` if a Gateway needs a published address.

## Production defaults

| Default | Why |
|---------|-----|
| `requestAcceptGraceTimeout: 10s`, `graceTimeOut: 30s` on both entrypoints | On SIGTERM Traefik keeps accepting for 10s, while the load balancer deregisters the pod, then drains in-flight requests for up to 30s. |
| `terminationGracePeriodSeconds: 60` | Covers both. `validateTraefikHelmValues` warns when an entrypoint's accept + drain time reaches the grace period. |
| PodDisruptionBudget, `maxUnavailable: 1` | A node drain can't evict every replica at once, and the budget never blocks a drain, even at one replica. |
| Soft zone and node spread (`ScheduleAnyway`, `maxSkew: 1`) | Replicas land in different zones and on different nodes when the cluster allows it. The selector is the chart's exact pod selector, and `matchLabelKeys: [pod-template-hash]` counts skew per ReplicaSet so a rolling update spreads the new pods. Set `zoneSpread: 'DoNotSchedule'` to make the zone spread hard. |
| `allowEmptyServices: false`, `allowCrossNamespace: false` | Traefik's own defaults, stated explicitly. With `allowEmptyServices: true`, a route whose Service has no ready endpoints answers `503` instead of disappearing (`404`). |
| Prometheus on the internal `metrics` entrypoint (9100) | The owned Service never publishes it, and `ports.metrics.expose` stays `false` even if the raw values set it. |

**Behind an AWS NLB with IP targets**, size the shutdown to the NLB:

- Raise `requestAcceptGraceTimeout` to cover the time the NLB takes to stop
  sending new connections to a deregistered target. That is often more than
  10s, so 20s to 30s is a safer start.
- Set the target group's `deregistration_delay.timeout_seconds` (through
  `awsNlbServiceAnnotations({ targetGroupAttributes })`) at or above
  `graceTimeOut`, so the NLB keeps draining connections as long as Traefik
  does.
- Keep `terminationGracePeriodSeconds` above the sum of the two.
- Enable the AWS Load Balancer Controller's pod readiness gate by labelling the
  install namespace `elbv2.k8s.aws/pod-readiness-gate-inject: enabled`. A
  rolling update then waits for each new pod to be healthy in the target group
  before it removes an old one.

Raw `values` take precedence over these defaults in a few places:

- A raw `podDisruptionBudget` replaces the default PDB. Merging the two could
  set `minAvailable` and `maxUnavailable` together, which the API server
  rejects.
- Raw `topologySpreadConstraints` replace the default spread.
- A raw `nodeSelector`, `tolerations`, `priorityClassName` or
  `deployment.terminationGracePeriodSeconds` is used when the spec does not
  set it. The spec field wins when both are set, in both modes.
- Other `metrics.prometheus` keys (router labels, the chart's metrics Service,
  a ServiceMonitor) pass through. Only `entryPoint` is pinned.

### Access logs

Access logs are JSON. The build option `accessLog` controls which fields and
request headers they carry:

```typescript
const edge = traefik.makeTraefikBootstrap({
  name: 'public-edge',
  kind: 'PublicEdge',
  accessLog: {
    preset: 'crowdsec', // or 'default'
    headers: { Referer: 'keep', 'X-Request-Id': 'keep' },
    queryParameters: 'keep',
  },
});
```

Every field is kept and every request header is dropped unless listed.
`User-Agent` is kept. `Authorization`, `Proxy-Authorization`, `Cookie` and
`Set-Cookie` are always dropped. The policy covers request headers and the
response headers Traefik can log (`downstream_*`, `origin_*`) alike. Overriding any of them to `keep`, in any letter case, throws,
while `redact` is allowed. The `crowdsec` preset also pins every field that
CrowdSec's `crowdsecurity/traefik-logs` parser reads from a JSON line
(`ClientHost`, `RequestHost`, `RequestPath`, `DownstreamStatus`, `Duration`,
`RouterName` and the others in `TRAEFIK_CROWDSEC_ACCESS_LOG_FIELDS`), along
with `User-Agent`. Dropping one of them throws. `ClientHost` is the real client
only when the proxy trust described below is set, so configure that too
before CrowdSec acts on it.

The policy replaces any `accessLog.fields` in the raw values.

## A public edge behind an AWS NLB

For a public API the usual shape is an AWS Network Load Balancer passing TCP 80
and 443 straight to Traefik, with Traefik terminating TLS using certificates
from cert-manager. The NLB never sees plaintext and never holds a certificate,
so Traefik keeps SNI, ALPN and client certificates.

```typescript
import * as traefik from 'typekro/traefik';

const VPC_CIDR = '10.0.0.0/16';

const edge = traefik.makeTraefikBootstrap({
  name: 'public-edge',
  kind: 'PublicEdge',
  defaultTlsStore: {
    defaultCertificateSecretName: 'edge-default-tls',
    // The bootstrap also owns the cert-manager Certificate behind it.
    certificate: { hostnames: ['api.example.com'], issuerRef: { name: 'letsencrypt' } },
  },
});

await edge.factory('direct', { namespace: 'flux-system', waitForReady: true, kubeConfig }).deploy({
  name: 'traefik',
  namespace: 'traefik',
  replicas: 3,
  service: {
    type: 'LoadBalancer',
    loadBalancerClass: 'service.k8s.aws/nlb',
    annotations: traefik.awsNlbServiceAnnotations({
      scheme: 'internet-facing',
      targetType: 'ip', // the default
      proxyProtocol: true, // the default: PROXY protocol v2 to every target port
      crossZone: true,
      targetGroupAttributes: { 'deregistration_delay.timeout_seconds': '30' },
    }),
  },
  entrypoints: {
    // The NLB connects from its own private addresses, so trust the VPC.
    web: { proxyProtocol: { trustedIPs: [VPC_CIDR] } },
    websecure: { proxyProtocol: { trustedIPs: [VPC_CIDR] } },
  },
  providers: { crd: true, kubernetesIngress: true }, // Ingress: for the HTTP-01 solver
});
```

`awsNlbServiceAnnotations` emits AWS Load Balancer Controller v2 annotations:
`aws-load-balancer-type: external`, the scheme, the target type,
`aws-load-balancer-proxy-protocol: "*"`, and, when given, load-balancer and
target-group attributes, subnets, the name, tags and health-check settings. It
has no certificate or SSL-port inputs, because TLS is not terminated on the
NLB. It throws on ambiguous or malformed input: `proxy_protocol_v2.enabled` in
`targetGroupAttributes` (use `proxyProtocol`) or `crossZone` together with the
cross-zone attribute, where the controller would silently let one source win;
and a `,` in a value, a name over 32 characters, or a health-check `path` on a
TCP check.

**PROXY protocol has to be on at both ends.** With it on, the NLB prepends a
PROXY v2 header to every connection, health checks included. An entrypoint
without `proxyProtocol.trustedIPs` reads that header as the start of a TLS
handshake and drops the connection. `validateTraefikHelmValues(values,
{ serviceAnnotations })` warns about this mismatch. Keep the NLB health check
on TCP (the controller's default). An HTTP check sends the header too, so it
needs an entrypoint that accepts it.

**Trusted ranges.** `proxyProtocol.trustedIPs` lists the sources allowed to
send a PROXY header, and `forwardedHeaders.trustedIPs` lists the sources whose
`X-Forwarded-*` headers Traefik keeps. Behind an NLB with PROXY protocol, the
client address comes from the PROXY header. Leave `forwardedHeaders` unset
unless another proxy, such as a CDN, sits in front and sets `X-Forwarded-For`.
A range with a `/0` prefix (`0.0.0.0/0`, `::/0`) would let any client set its
own source address, so it is refused. Direct mode refuses it when the
composition runs, and KRO mode refuses it at admission through
`x-kubernetes-validations` on the generated CRD. An `insecure` flag that
reaches the final values throws as well, whether it comes through `values`
(`ports.*.proxyProtocol.insecure`), `additionalArguments` (`=true`, `=1` or
bare) or a `TRAEFIK_ENTRYPOINTS_*_INSECURE` entry in `env`. A range that is
legal but very broad, with an IPv4 prefix shorter than `/8` or an IPv6 prefix
shorter than `/16`, gets a `validateTraefikHelmValues` warning instead. The
escape hatch is
`makeTraefikBootstrap({ dangerouslyTrustAnySource: true })`, for a Traefik that
no client can reach directly.

With `targetType: 'ip'` the NLB sends traffic straight to pod IPs, so
`externalTrafficPolicy` has no effect. It matters for `instance` targets and
`NodePort` Services. `loadBalancerSourceRanges` limits which client CIDRs the
NLB admits.

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

### The forwardAuth secure pair

`traefikForwardAuthSecurePair` creates three Middlewares from one
`forwardAuth` configuration:

- `<name>-strip-identity`, a `headers` Middleware that removes every
  `authResponseHeaders` entry from the client's request;
- `<name>-forward-auth`, the `forwardAuth` itself, with the same secure
  defaults as `traefikForwardAuthMiddleware`;
- `<name>`, a `chain` of the two in that order. Routes reference this one.

```typescript
const authz = traefik.traefikForwardAuthSecurePair({
  name: 'orders-api-authz',
  namespace: 'edge',
  address: 'http://orders-authorizer.edge.svc.cluster.local:8080/authorize',
  authResponseHeaders: ['X-Edge-Principal', 'X-Edge-Tier', 'X-Edge-Customer'],
  id: 'ordersApiAuthz',
});
// route middlewares: [{ name: 'orders-api-authz' }]
```

When the authorizer approves a request, Traefik 3.7 replaces each
`authResponseHeaders` entry with the authorizer's value, or removes it if the
authorizer sent none, so the upstream never sees the client's copy. What it
does not do is keep the client's copy away from the authorizer. Without an
`authRequestHeaders` allowlist every client header is forwarded, and an
authorizer that reads, logs or echoes `X-Edge-Principal` can be fooled. The
strip step closes that gap and still protects against anything later in the
chain that reads those headers. Listing a returned identity header in
`authRequestHeaders` throws. Header names must be concrete values, because
they become keys of the strip Middleware.

The strip step removes only the canonical spelling. `X_Edge_Principal` or
`X.Edge.Principal` would get past it, and backends that turn header names into
variable names (CGI, WSGI, PHP, NGINX) read those as `X-Edge-Principal`. So
both entrypoints default to `aliasHeadersStrategy: 'delete'`, which removes any
request header whose name contains a character other than a letter, digit or
dash before routing. Set `entrypoints.<name>.aliasHeadersStrategy` to
`'reject'` to answer `400` instead, or to `'keep'` to forward such headers as
before. `delete` and `reject` also affect legitimate headers with `_` or `.`
in their names, so check your clients before you deploy.

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

**The Redis limiter fails closed.** When Traefik can't reach Redis it answers
`500 Could not insert/update bucket` for every request through the middleware,
and recovers on its own once Redis is back. The integration suite pins this
behavior. A Valkey outage is therefore an outage of every route behind the
limit. Traefik has no setting that makes it fail open. To reduce the risk:

- Run Valkey highly available and list every node in `redis.endpoints`, so the
  client can reach another node while one is down.
- Keep `dialTimeout` and `readTimeout` short, around a second, so requests fail
  fast instead of hanging.
- Alert on the `Could not insert/update bucket` error in Traefik's logs, and
  on a rise in 500 responses from routes behind the limiter.
- Where availability matters more than an exact shared budget, leave out
  `redis` and use the in-memory limiter. Each replica then counts on its own,
  so the effective limit is `average × replicas`.

## Plugins

Plugins are build-time options, because declaring one adds a volume to the
Traefik pod. A registry plugin needs an exact `version` and the SHA-256 `hash`
of its archive. Traefik refuses to load an archive whose hash does not match.
Without a hash, Traefik only asks the registry whether the archive is intact,
so whoever controls the registry or the network path decides what code runs
in the edge.

```typescript
const edge = traefik.makeTraefikBootstrap({
  name: 'public-edge',
  kind: 'PublicEdge',
  plugins: {
    bouncer: {
      moduleName: 'github.com/example/bouncer-plugin',
      version: 'v1.4.2',
      // curl -sL https://plugins.traefik.io/public/download/<moduleName>/<version> | sha256sum
      hash: '0f3c…64 hex digits…',
    },
  },
  // abortOnPluginFailure defaults to true once any plugin is declared
});

const bouncer = traefik.traefikPluginMiddleware({
  name: 'bouncer',
  namespace: 'edge',
  plugin: 'bouncer',
  config: {
    enabled: true,
    // Resolved by Traefik from the Secret in the Middleware's namespace.
    apiKey: traefik.traefikSecretValue('bouncer-credentials', 'api-key'),
  },
  id: 'bouncer',
});
```

- `localPlugins` loads a plugin from the pod's filesystem instead. An
  `inlinePlugin` ships its `source` files in a ConfigMap the chart creates. A
  `localPath` plugin mounts a volume you declare in raw
  `values.deployment.additionalVolumes`. The mount path is always
  `/plugins-local/src/<moduleName>`, which is where Traefik looks.
- `abortOnPluginFailure` defaults to `true` when any plugin is declared. If a
  security plugin fails to load, Traefik refuses to start, so the previous
  replicas keep serving. Otherwise Traefik would start without the plugin.
  With it on, the plugin registry becomes a startup dependency: while
  plugins.traefik.io is unreachable, new Traefik pods can't start, which
  blocks rollouts and scale-ups. Vendor critical plugins, such as a security
  bouncer, through `localPlugins` so they load from the pod itself.
- `traefikSecretValue(secret, key)` returns
  `urn:k8s:secret:<secret>:<key>`. Traefik resolves these strings at any depth
  of a **plugin** middleware's configuration, and nowhere else.
- Plugins already set in raw `values.experimental.plugins` are kept.
  `validateTraefikHelmValues` warns about any that carry no hash.

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

`traefikTlsCertificate` creates a cert-manager `Certificate` for a set of
hostnames, with an ECDSA P-256 key that rotates on every renewal. Its Secret
(`<name>-tls` by default) is what an `IngressRoute` serves through
`tls.secretName`. The Secret must be in the route's namespace.

```typescript
const cert = traefik.traefikTlsCertificate({
  name: 'orders-api',
  namespace: 'orders',
  hostnames: ['api.example.com'],
  issuerRef: { name: 'letsencrypt' }, // kind defaults to ClusterIssuer
  id: 'ordersCertificate',
});

traefik.traefikIngressRoute({
  name: 'orders-api',
  namespace: 'orders',
  spec: {
    entryPoints: ['websecure'],
    ingressClassName: 'traefik',
    tls: { secretName: 'orders-api-tls' },
    routes: [{ match: 'Host(`api.example.com`)', services: [{ name: 'orders', port: 8080 }] }],
  },
  id: 'ordersRoute',
});
```

For the certificate served when SNI matches no route, give the bootstrap a
`defaultTlsStore` and, optionally, `defaultTlsStore.certificate`. The bootstrap
then owns the `Certificate` too, in the install namespace. The `TLSStore` does
not wait for it: Traefik serves its self-signed default until cert-manager
writes the Secret. A `waitForReady` deploy does wait for the `Certificate`, so
with HTTP-01 the hostname's DNS must reach the NLB before the deploy times out.
External-DNS, driven by an annotation on the Service, can arrange that.

The same pieces can be composed by hand with the cert-manager factories:

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

### HTTP-01 with Let's Encrypt

An HTTP-01 `ClusterIssuer` needs a solver that Traefik routes on `web`. Either:

- **Ingress solver.** Enable Traefik's Ingress provider
  (`providers: { kubernetesIngress: true }`) and point the solver at Traefik's
  class. cert-manager creates an `Ingress` for
  `/.well-known/acme-challenge/<token>`. It names no entrypoint, so Traefik
  attaches it to `web` as well.

  ```typescript
  import * as certManager from 'typekro/cert-manager';

  certManager.clusterIssuer({
    name: 'letsencrypt',
    spec: {
      acme: {
        server: 'https://acme-v02.api.letsencrypt.org/directory',
        email: 'ops@example.com',
        privateKeySecretRef: { name: 'letsencrypt-account' },
        // Sets the Ingress class cert-manager stamps on its solver Ingress.
        solvers: [{ http01: { ingress: { class: 'traefik' } } }],
      },
    },
    id: 'letsencrypt',
  });
  ```

- **Gateway solver.** Enable `providers: { gatewayApi: true }`, run cert-manager
  with Gateway API support, and use `http01.gatewayHTTPRoute` with a
  `parentRefs` entry naming the Traefik `Gateway`'s HTTP listener.

DNS for each hostname must already point at the NLB, because Let's Encrypt
connects to it on port 80.

### HTTP-01 and the `web` redirect

The default `web` → `websecure` redirect does **not** apply to
`/.well-known/acme-challenge/`. The bootstrap sets Traefik's
`allowACMEByPass` on `web`, which narrows the generated redirect rule to
``HostRegexp(`^.+$`) && !PathPrefix(`/.well-known/acme-challenge/`)``. A
cert-manager HTTP-01 solver route on `web` therefore answers the challenge,
and every other path on `web` is still redirected.

Without the bypass the redirect wins every time: Traefik gives the router it
generates for an entrypoint redirection priority `MaxInt - 1`, above any rule
length. The redirect's priority is deliberately left alone. A route that names
no entrypoint attaches to all of them, so a low-priority redirect would serve
those routes over plain HTTP instead of redirecting them.

A challenge path with no solver route answers `404`, not `301`. Let's Encrypt
only fetches `/.well-known/acme-challenge/<token>` while an order is pending,
so this changes nothing for normal traffic.

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
| Access logs drop `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` | A bearer token in a log line is a live credential for as long as the log is kept. |
| `/0` trusted ranges and `insecure` proxy trust refused | Either lets any client set its own source address. |
| `aliasHeadersStrategy: delete` on both entrypoints | `X_Auth_User` would reach a CGI/WSGI/PHP/NGINX backend as `X-Auth-User`, past the forwardAuth strip step. |
| Registry plugins need an archive `hash`; `abortOnPluginFailure` on | Traefik runs only the plugin code that was reviewed, and never starts without a declared plugin. |

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
