---
title: CrowdSec Factories
description: CrowdSec for a Traefik-fronted API — Flux bootstrap for LAPI, log agents and AppSec, plus the Traefik bouncer plugin and Middleware
---

# CrowdSec Factories

::: warning Experimental
CrowdSec factories are experimental. The API may change in future releases.
:::

[CrowdSec](https://www.crowdsec.net/) reads your edge's access logs, detects
abusive clients (scanners, brute force, known CVE exploits), and hands out
decisions that a bouncer enforces. This module installs CrowdSec next to a
Traefik edge and gives you the Traefik-side pieces as plain objects.

Verified against:

| Component | Version | License |
|---|---|---|
| `crowdsec` chart, `https://crowdsecurity.github.io/helm-charts` | **0.24.2** (CrowdSec **v1.8.1**) | MIT (chart and CrowdSec) |
| Traefik bouncer plugin `github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin` | **v1.7.1** | Apache-2.0 |

The chart ships no CRDs, so there is one `HelmRelease` and no CRD policy.

## Installation

```typescript
import * as crowdsec from 'typekro/crowdsec';
```

`typekro/crowdsec` is a subpath export only; it is not in the root `typekro`
barrel. It does not import `typekro/traefik`: the Traefik helpers return plain
objects you pass to the Traefik factories.

## What runs

```
client ─▶ Traefik ─▶ [crowdsec bouncer Middleware] ─▶ your API
             │               │  ▲ decisions (stream, every 15s)
   access log│               │  │ AppSec check (per request, optional)
             ▼               ▼  │
   agent DaemonSet ──alerts──▶ LAPI ◀── AppSec Deployment
```

- **LAPI** (Local API) stores alerts and decisions and serves them to bouncers.
  ClusterIP only; the chart's LAPI Ingress is pinned off. SQLite on a PVC
  (one replica) or an existing Postgres (any number of replicas). Chart 0.24
  no longer ships the Metabase dashboard, so there is nothing to switch off.
- **Agents** run as a DaemonSet and read the Traefik pods' container log files
  on each node.
- **AppSec** (optional) is CrowdSec's WAF: in-band virtual patching, which
  blocks the request, and out-of-band OWASP CRS, which feeds a ban scenario.
- **The bouncer** is a Traefik plugin running as a Middleware. It pulls
  decisions from LAPI in stream mode and, with AppSec, asks AppSec about each
  request.

## Quick example

```typescript
import * as crowdsec from 'typekro/crowdsec';

const security = crowdsec.makeCrowdsecBootstrap({
  bouncers: [{ name: 'traefik', keySecretRef: { name: 'crowdsec-bouncer', key: 'api-key' } }],
  acquisitions: [{ namespace: 'traefik', podName: 'traefik-*' }],
  simulation: { global: true },
  appsec: {},
});

const instance = await security
  .factory('direct', { namespace: 'flux-system', waitForReady: true, timeout: 900_000, kubeConfig })
  .deploy({ name: 'crowdsec', namespace: 'crowdsec' });

// instance.status.lapiHost   → 'crowdsec-service.crowdsec.svc.cluster.local:8080'
// instance.status.appsecHost → 'crowdsec-appsec-service.crowdsec.svc.cluster.local:7422'
```

## Available factories

| Export | What it is |
|---|---|
| `crowdsecBootstrap` | The default composition: SQLite LAPI, agents on `traefik/traefik-*`, CAPI off, AppSec off. |
| `makeCrowdsecBootstrap(options)` | Build a composition from build-time options (below). |
| `crowdsecHelmRepositoryBootstrap` | The shared `HelmRepository`, owned by a singleton. |
| `crowdsecHelmRepository`, `crowdsecHelmRelease` | The Flux resources, if you assemble your own graph. |
| `mapCrowdsecConfigToHelmValues` | The values mapper the bootstrap uses. |
| `crowdsecTraefikPlugin({ version?, hash? })` | One `experimental.plugins` entry for Traefik. |
| `crowdsecBouncerMiddleware(options)` | A Traefik `Middleware.spec` that runs the bouncer. |
| `crowdsecSecretUrn(secret)` | `urn:k8s:secret:<name>:<key>`, which Traefik resolves in plugin config. |

## Runtime spec and status

The runtime spec only carries values that may be schema references in KRO
mode: `name` (at most 39 characters, so the chart's Job names fit),
`namespace`, `chartVersion`, and per component `resources` (requests are
required, so no pod is BestEffort) plus `appsec.replicas`.

Everything that decides what CrowdSec runs is a build-time option, because it
is rendered into CrowdSec's own config files.

Status fields are all read from the owned `HelmRelease`, so they hydrate the
same way in direct and KRO mode: `ready`, `failed`, `phase`, `lapiHost`,
`appsecHost` (`''` when AppSec is off) and `version` (the chart version Flux
installed).

## Build-time options

| Option | Default | Notes |
|---|---|---|
| `storage` | `{ type: 'sqlite', size: '1Gi' }` | Or `{ type: 'postgres', host, database, user, passwordSecretRef, port?, sslMode? }`. The password must not contain `"` or `\`: CrowdSec substitutes it into YAML before parsing. |
| `lapi.replicas` | `1` | More than one needs Postgres. |
| `lapi.env`, `agent.env` | none | Extra env, appended after the env this factory sets. Raw `values.lapi.env` / `values.agent.env` would be replaced, so use these. |
| `lapi.pdb`, `appsec.pdb` | `true` | `maxUnavailable: 1`, which never blocks a drain. The chart has no PDB. |
| `lapi.placement`, `agent.placement`, `appsec.placement` | soft spread across nodes | `nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints`, `priorityClassName`. Give the agents the same tolerations as Traefik so they run wherever Traefik does. |
| `acquisitions` | `[{ namespace: 'traefik', podName: 'traefik-*' }]` | Namespace plus pod-name glob; `program` defaults to `traefik`. |
| `collections` | none | Added to `crowdsecurity/traefik`, `crowdsecurity/base-http-scenarios`, `crowdsecurity/http-cve`. |
| `centralApi` | absent: offline | `{ communityBlocklist, enrollment? }`. See [Enrollment](#enrollment). |
| `bouncers` | none | `[{ name, keySecretRef }]`, registered as `BOUNCER_KEY_<name>`. |
| `allowlist` | none | `{ ips?, cidrs?, reason? }`. See [Allowlists](#allowlists). |
| `simulation` | off | `{ global: true, enforce? }` or `{ global: false, simulate? }`. See [Rollout](#simulation-first-rollout). |
| `networkPolicy` | absent: none | `{ traefikNamespace, metricsNamespace? }`. See [Network policy](#network-policy). |
| `appsec` | absent: off | See [AppSec](#appsec). |
| `metrics` | metrics on, no monitors | Every pod serves Prometheus on `:6060`. `serviceMonitor` / `podMonitor` need the Prometheus Operator CRDs. |
| `agent.containerRuntime` | `'containerd'` | The container log format on the nodes. |
| `values` | none | Raw chart values, merged first. Everything this factory sets wins. |

Default requests: LAPI 100m CPU / 256Mi, agent 100m / 192Mi, AppSec 200m /
384Mi. Memory is limited (512Mi, 384Mi, 768Mi); CPU is not, because AppSec
answers on the request path and a throttled LAPI delays every decision pull.
Override per component with the runtime spec's `resources`.

### Why there is no label-selector acquisition

The DaemonSet agents read node-local files named
`/var/log/containers/<pod>_<namespace>_<container>-<id>.log`, which carry the
pod name but no labels. CrowdSec 1.8 does have a `kubernetes` datasource that
selects pods by label, but it streams logs through the API: every agent in a
DaemonSet would read every matching pod, counting each line once per node. It
would need a single-replica agent Deployment with RBAC for `pods/log`, and the
0.24.2 chart's `values.schema.json` rejects the datasource anyway. Name the
Traefik pods with a glob instead; `traefikBootstrap` names them
`<release>-<hash>`. For any other source the chart accepts (syslog, Loki,
CloudWatch, ...), pass it through raw `values.agent.additionalAcquisition`.

## Wiring Traefik

Three things on the Traefik side:

1. **Declare the plugin** in `experimental.plugins`. `crowdsecTraefikPlugin()`
   returns `{ moduleName, version: 'v1.7.1', hash }`, where `hash` is the
   SHA-256 of the archive Traefik downloads. Traefik refuses an archive whose
   hash differs. Any other version needs its own `hash`.
2. **Keep the User-Agent** in Traefik's JSON access log. The CrowdSec Traefik
   parser reads it, and the chart drops headers by default.
3. **Create the Middleware** with `crowdsecBouncerMiddleware(...)` and put it
   first in each route's middleware list.

On the current `typekro/traefik`, use the raw `values` passthrough:

```typescript
import { crowdsecTraefikPlugin } from 'typekro/crowdsec';
import { makeTraefikBootstrap } from 'typekro/traefik';

export const edge = makeTraefikBootstrap({
  values: {
    experimental: { plugins: { crowdsec: crowdsecTraefikPlugin() } },
    accessLog: { fields: { headers: { names: { 'User-Agent': 'keep' } } } },
  },
});
```

The Traefik plugin work in #281 adds typed equivalents. Once it lands,
pass the same declaration as `plugins: { crowdsec: crowdsecTraefikPlugin() }`
(its `abortOnPluginFailure` default then stops Traefik from starting without
the bouncer), use its CrowdSec access-log preset, and prefer `localPlugins` to
vendor the plugin so a plugin-registry outage cannot block a Traefik start.
`crowdsecBouncerMiddleware` keeps working unchanged: it is a plain Middleware
spec that names the plugin.

### The route: bouncer first

```typescript
import { crowdsecBouncerMiddleware } from 'typekro/crowdsec';
import { traefikIngressRoute, traefikMiddleware } from 'typekro/traefik';

const bouncer = traefikMiddleware({
  name: 'crowdsec',
  namespace: 'traefik',
  spec: crowdsecBouncerMiddleware({
    // From the bootstrap's status; inside a parent composition, use the
    // nested composition's status instead.
    lapiHost: instance.status.lapiHost,
    appsecHost: instance.status.appsecHost,
    apiKeySecret: { name: 'crowdsec-bouncer', key: 'api-key' },
  }),
  id: 'crowdsecBouncer',
});

const route = traefikIngressRoute({
  name: 'api',
  namespace: 'traefik',
  spec: {
    entryPoints: ['websecure'],
    ingressClassName: 'traefik',
    tls: { secretName: 'api-tls' },
    routes: [
      {
        match: 'Host(`api.example.com`)',
        kind: 'Rule',
        // The bouncer runs before authentication, rate limits and the backend.
        middlewares: [{ name: 'crowdsec' }, { name: 'api-authz' }, { name: 'api-rate-limit' }],
        services: [{ name: 'api', namespace: 'api', port: 8080 }],
      },
    ],
  },
  id: 'apiRoute',
});
route.dependsOn(bouncer);
```

### The bouncer key

The key is one Secret value used twice: LAPI registers it from
`bouncers[].keySecretRef` in the CrowdSec namespace, and the Middleware reads
it as `urn:k8s:secret:<name>:<key>` from **its own** namespace. Create the
same Secret in both namespaces, for example with External Secrets. Generate a
long random value (`openssl rand -hex 32`).

The resolved key is part of Traefik's dynamic configuration, and Traefik's API
(`/api/http/middlewares`) returns plugin configuration unredacted. The
`traefikBootstrap` keeps the API and dashboard off, so nothing serves it. If
your Traefik exposes the API, mount the Secret into the Traefik pods
(`deployment.additionalVolumes` / `additionalVolumeMounts`) and pass
`apiKeyFile: '/path/to/key'` instead of `apiKeySecret`; the plugin then reads
the key from the file (`crowdsecLapiKeyFile`) and the API shows only the path.

LAPI only adds a bouncer whose name is not registered yet. To rotate a key,
delete the bouncer (`cscli bouncers delete traefik` in the LAPI pod), update
both Secrets, and restart LAPI and Traefik.

### Client IPs

CrowdSec bans the client address Traefik logs. Behind a load balancer that
address must be the real client: use PROXY protocol on the entrypoint, or list
the load balancer's ranges in Traefik's `forwardedHeaders.trustedIPs` and in
the bouncer's `forwardedHeadersTrustedIps`. Otherwise every request appears to
come from the load balancer, and the base install's `crowdsecurity/whitelists`
parser ignores private addresses, so nothing is ever banned.

## Fail-open semantics

`failOpen: true` (the default) keeps the API up when CrowdSec is not:

| Situation | `failOpen: true` | `failOpen: false` |
|---|---|---|
| LAPI unreachable during a decision pull | Keep the last decisions; let new clients through (`updateMaxFailure: -1`). | Keep serving through `failClosedAfter` failed pulls in a row (default 4, about a minute at the 15 s interval), then block every request until a pull succeeds (`updateMaxFailure: failClosedAfter`). |
| AppSec unreachable | Let the request through (`crowdsecAppsecUnreachableBlock: false`). | Block it. |
| AppSec returns 500 | Let the request through (`crowdsecAppsecFailureBlock: false`). | Block it. |
| Body cannot be buffered for AppSec (HTTP/2 stream without length) | Forward headers only (`crowdsecAppsecUnreadableBodyBlock: false`). | Block it. |
| Traefik starts while LAPI is down | The first pull waits up to 10 s, then serves. | The first pull fails; traffic flows until `failClosedAfter` pulls have failed, then everything is blocked. |

Known bans keep working while LAPI is down either way: they are cached in
Traefik. The bouncer only bans. It configures no captcha provider, so a
captcha decision is enforced as a ban.

**Fail-closed needs a highly available LAPI.** Run Postgres with two or more
LAPI replicas. With single-replica SQLite the Deployment uses `Recreate`, so
every LAPI restart, upgrade or node drain is a gap with no LAPI at all, and a
gap longer than the tolerance blocks all traffic.

**The plugin's state is per Traefik process, not per Middleware.** The plugin
runs one decision stream and one health flag for the whole Traefik instance,
started by the first CrowdSec Middleware Traefik loads. Several CrowdSec
Middlewares with different `failOpen`, `failClosedAfter` or
`updateIntervalSeconds` do not behave independently: the first one's settings
win. Use one bouncer Middleware per Traefik installation and reference it from
every route.

**The plugin download is a startup dependency.** Traefik downloads the plugin
from plugins.traefik.io when a pod starts. With the chart's default
`experimental.abortOnPluginFailure: false` (the case on the current
`typekro/traefik`), a pod that cannot reach the registry starts without the
plugin, and every route that references the CrowdSec Middleware fails,
whatever `failOpen` says. Once #281 lands, vendor the plugin with
`localPlugins` so a pod start no longer depends on the registry.

## Simulation-first rollout

1. **Simulate.** Deploy with `simulation: { global: true }`. Scenarios raise
   alerts and simulated decisions, which bouncers ignore. With AppSec, in-band
   matches answer `allow` (the generated AppSec policy sets
   `default_remediation: allow` under global simulation) and out-of-band CRS
   bans are simulated too, because the bootstrap mounts `simulation.yaml` on
   the AppSec pods as well as the agents.
2. **Review.** Watch `cscli alerts list` and the CrowdSec metrics for a week of
   normal traffic. Allowlist your own egress, monitors and partners, and add
   AppSec exclusions for false positives.
3. **Enforce the obvious.** List the high-confidence scenarios in
   `simulation: { global: true, enforce: [...] }`, for example
   `crowdsecurity/http-cve-probing`. Everything else stays simulated.
4. **Enforce everything.** Set `simulation: { global: false }`. To keep a few
   noisy scenarios observing, list them:
   `simulation: { global: false, simulate: ['crowdsecurity/http-crawl-non_statics'] }`.
   AppSec in-band bans once global simulation is off;
   `appsec.inBandRemediation: 'allow'` keeps it in observe mode longer.

Both shapes render CrowdSec's `simulation.yaml`, whose `exclusions` list
inverts with the global flag: with `simulation: true` it names the scenarios
that enforce, with `simulation: false` the ones that are simulated. The
`enforce` and `simulate` names make that explicit.

## Enrollment

Offline is the default: LAPI runs with `DISABLE_ONLINE_API=true`, shares
nothing and pulls no community blocklist.

**For production, turn on the Central API** with
`centralApi: { communityBlocklist: true }`. LAPI then registers with CAPI on
its own, pulls the community blocklist of IPs that other CrowdSec users are
seeing attack, and shares signals about the attacks it sees. This needs **no
console account**: the registration is anonymous and automatic.

Enrolling in the CrowdSec console is a separate, optional step that adds a web
UI, alert history and the ability to subscribe to extra blocklists:

1. Create an account on the CrowdSec console and copy the enrollment key.
2. Store it in a Secret in the CrowdSec namespace (`crowdsec-enroll`, key `key`).
3. Deploy with:
   ```typescript
   centralApi: {
     communityBlocklist: true,
     enrollment: { keySecretRef: { name: 'crowdsec-enroll', key: 'key' }, tags: ['edge'] },
   }
   ```
4. Accept the instance in the console.

With `centralApi` set, LAPI registers with the Central API (CAPI), shares
signals about the attacks it sees, and pulls the community blocklist. Set
`communityBlocklist: false` to register and enroll without pulling it. CAPI
credentials are kept in a Secret so several LAPI replicas share one identity.

## Allowlists

`allowlist.ips` and `allowlist.cidrs` are rendered as a **parser whitelist**
in stage `s02-enrich` on the agents, next to the hub's own
`crowdsecurity/whitelists`. CrowdSec recommends parser whitelists for plain IP
and range lists: the event is dropped before any scenario sees it, which is
the cheapest place. The chart mounts parsers only on agents, so for AppSec the
same list is also rendered as a postoverflow whitelist (`s01-whitelist`).

Two limits:

- A whitelist stops new decisions. It does not lift decisions that already
  exist, and it does not stop AppSec in-band blocking. Use the bouncer's
  `clientTrustedIps` for clients that must never be checked at all.
- CrowdSec's newer centralized allowlists (`cscli allowlists`) live in LAPI
  and also filter blocklists, but they are managed imperatively, so this
  factory does not use them.

## AppSec

```typescript
appsec: {
  virtualPatching: true,          // in-band: crowdsecurity/appsec-default
  crs: true,                      // out-of-band: crowdsecurity/crs
  maxBodySize: 1_048_576,         // bytes inspected
  bodySizeExceededAction: 'partial',
  exclusions: [
    { ruleId: 942100, pathPrefix: '/v1/uploads', phase: 'outofband' },
    { ruleName: 'crowdsecurity/vpatch-env-access', pathPrefix: '/health' },
  ],
}
```

The AppSec pods load `crowdsecurity/appsec-default`, `crowdsecurity/crs` and a
generated `typekro/appsec-policy` config, in that order. The policy config
carries the body limit (`SetMaxBodySize`, `SetBodySizeExceededAction`) and the
exclusions: an exclusion without `pathPrefix` removes the rule at load time,
one with a prefix removes it per request. Set the bouncer's `appsecBodyLimit`
to the same size, so the plugin does not send more than AppSec reads.

## Network policy

`networkPolicy: { traefikNamespace: 'traefik' }` adds two NetworkPolicies:

- **LAPI** accepts `:8080` only from the release's agent and AppSec pods and
  from pods in `traefikNamespace` (the bouncer).
- **AppSec** accepts `:7422` only from pods in `traefikNamespace`.

Both accept `:6060` (Prometheus) from `metricsNamespace`, or from any
namespace when it is unset. The agents need no ingress besides metrics and get
no policy. Any other bouncer outside `traefikNamespace`, and a Traefik running
with `hostNetwork` (its traffic comes from the node, not a pod), is blocked
unless you extend the policies. It needs a CNI that enforces NetworkPolicy; most such CNIs let
kubelet probes through, which come from the node.

In direct mode, the policies need the NetworkPolicy fix in #285: before it,
direct-mode deploys dropped every `ingress[].from` peer, so the rules admitted
any source on their ports. KRO mode is not affected.

## Limits

- The bouncer plugin (v1.7.1) in stream mode matches decisions by exact IP: its
  cache is keyed by the decision's value. A **range** decision
  (`cscli decisions add --range ...`) is pulled but never matches a client.
  Ban addresses, or run the plugin in `live` mode (not modelled here), where
  LAPI does the matching. The same applies to range entries in blocklists.
- One CrowdSec release per namespace: the chart uses fixed ConfigMap names.
- Traffic between the bouncer and LAPI is plain HTTP inside the cluster. The
  chart's TLS mode needs cert-manager and is not modelled yet; restrict it with
  `networkPolicy`.
- Collections are installed from the CrowdSec hub when pods start, so the pods
  need outbound access to the hub.
