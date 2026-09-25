# ClickStack (HyperDX) Factories

Deploy [ClickStack](https://clickhouse.com/docs/use-cases/observability/clickstack) — ClickHouse Inc.'s
observability stack (the HyperDX UI/API, an OTel gateway collector, and schema migrations) — via the
OFFICIAL `clickstack` Helm chart (3.2.x, MIT) from
[`ClickHouse/ClickStack-helm-charts`](https://github.com/ClickHouse/ClickStack-helm-charts), wired to an
**external ClickHouse** you already run (e.g. an Altinity-operator-managed
[`ClickHouseInstallation`](../clickhouse/)).

## Credential modes

The default accepts `clickhouse.password`, `clickhouse.appPassword`, and a required, non-empty
`apiKey` inline. The published chart placeholder is rejected. Those values enter the HelmRelease
and RGD instance, so use that mode only when etcd/RBAC protection is sufficient.

For production, construct the Secret-backed variant:

```typescript
const clickstack = makeClickstackBootstrap({
  credentials: { source: 'secretValues' },
});

await clickstack.factory('kro', { namespace: 'typekro-system' }).deploy({
  name: 'clickstack',
  namespace: 'observability',
  clickhouse: {
    host: 'clickhouse-observability.observability.svc.cluster.local',
    username: 'otelcollector',
  },
  credentialsSecret: {
    name: 'clickstack-credentials',
    valuesKey: 'values.yaml',
  },
});
```

The Secret key is a Helm values fragment containing `hyperdx.secrets`. Flux merges it before TypeKro's
non-sensitive inline values. TypeKro deliberately omits that credential-bearing path from the
HelmRelease and rejects inline password/API-key fields in this variant.

HyperDX's default ClickHouse connection comes from TypeKro: a `<release>-default-connections`
ConfigMap, listed in `valuesFrom` before your Secret, sets `hyperdx.deployment.defaultConnections` to
the external ClickHouse in the spec. The password is left as a Helm template that reads
`.Values.hyperdx.secrets.CLICKHOUSE_APP_PASSWORD` (piped through `toJson`), and the chart's `tpl`
fills it in from your fragment. Without the ConfigMap, the chart would fall back to its own "Local
ClickHouse" at the bundled ClickHouse, which isn't deployed here. A
`hyperdx.deployment.defaultConnections` in your fragment still overrides it, since your Secret comes
later.

The Secret must be in the ClickStack workload namespace because Flux values references are
namespace-local. The fragment must override `hyperdx.secrets.HYPERDX_API_KEY`: an idempotent reconciliation CronJob refuses the chart's
published placeholder and keeps the installation non-ready until an authoritative Team is updated.
It reruns every minute so API-key and external-Mongo URI rotations converge without replacing an
immutable completed Job.

Omit `namespace` to let TypeKro create and own the documented `clickstack` default Namespace. Pass
`namespace` when a parent platform owns the workload Namespace; ClickStack targets that Namespace
without creating or deleting it. The same rule is preserved when the factory is nested in another
composition, so one Kubernetes Namespace never gains competing lifecycle owners.

## Import

```typescript
import {
  clickstackBootstrap,
  makeClickstackBootstrap,
  clickstackK8sTelemetry,
  makeClickstackK8sTelemetry,
} from 'typekro/clickstack';
```

## Quick Example

```typescript
// 1. The stack (internal dev-first Mongo, external ClickHouse). Omitting the
// runtime namespace asks TypeKro to hoist and own its `clickstack` default.
const bootstrap = makeClickstackBootstrap({ credentials: { source: 'secretValues' } });
const factory = bootstrap.factory('kro', { namespace: 'typekro-system' });
const stack = await factory.deploy({
  name: 'clickstack',
  clickhouse: {
    host: 'clickhouse-observability.clickhouse.svc.cluster.local',
    username: 'otelcollector',
  },
  credentialsSecret: { name: 'clickstack-credentials', valuesKey: 'values.yaml' },
});

// 2. Cluster telemetry into it (wired from the status contract):
const telemetry = clickstackK8sTelemetry.factory('kro', { namespace: 'clickstack-telemetry' });
await telemetry.deploy({
  name: 'telemetry',
  endpoint: stack.status.gateway.otlpHttpEndpoint,
  apiKeySecret: { name: 'clickstack-api-key' },
});
```

## External ClickHouse ONLY (and never `clickstack-operators`)

The chart's bundled ClickHouse and MongoDB are **hard-pinned off** (`clickhouse.enabled: false`,
`mongodb.enabled: false`) and those pins beat any build-time `values` passthrough — in both direct and
KRO mode. Their CRDs belong to the `clickstack-operators` prerequisite chart, whose ClickHouse operator
(ClickHouse Inc.'s own) **collides with the Altinity clickhouse-operator** managing your
ClickHouseInstallations, and which drags in a MongoDB operator besides. This integration never installs
it.

Point `spec.clickhouse` at your CHI — the [`clickhouse` factories'](../clickhouse/) status contract
gives you the coordinates (`chi.status.clickhouse.host`, ports, cluster name) without hand-building
service names.

### ClickHouse host

`clickhouse.host` goes into `http://<host>:<httpPort>` and `tcp://<host>:<nativePort>` as it is, so it
must be a host that every URL parser reads as that same host, and nothing more.

- **Accepted:**
  - a short name, or an FQDN with or without a trailing dot, made of ASCII letters, digits, `.`, `-` and
    `_`, in any case;
  - an IPv4 address in dotted-quad form;
  - a bracketed IPv6 address, validated as IPv6 (`[fd00::1]`, `[::ffff:10.0.0.7]`).
- **Refused:**
  - an empty value;
  - whitespace, `/`, `\`, `?`, `#` or `@` (a path, query, fragment or userinfo). URL parsers read `\` as
    a path separator;
  - a scheme (`http://…`) or a `:` outside brackets (a port; use `httpPort` / `nativePort`);
  - a bracketed value that isn't a valid IPv6 address (`[abc]`, `[:::]`, `[fd00::1]:8123`);
  - an unbracketed IPv6 address. The error says to bracket it;
  - any other character, including percent-encoding and non-ASCII;
  - a host URL parsing would rewrite, such as shorthand IPv4 `127.1`.

**Where it is checked.**

- **Render time, for a concrete host:** the full check, with Node's `net.isIPv6` and WHATWG URL parsing.
- **Runtime, in the Team-defaults seed:** the same full check, in mongosh. It holds on every CRD.
- **At admission:** the generated CRD carries a **syntactic** pre-check. A bracketed value may hold only
  hex digits, `.` and at least one `:`, and anything else only ASCII letters, digits, `.`, `-` and `_`.
  It doesn't parse IPv6 or normalise IPv4, because Kubernetes' CEL IP library needs a newer API server,
  so `[:::]` and `127.1` pass admission and are refused by the other two checks. It also reaches new
  CRDs only (see the [KRO caveat](#chart-versions-it-is-valid-for)).

## MongoDB Modes (build-time)

HyperDX requires MongoDB for app state (dashboards, alerts, users — metadata only):

- **`makeClickstackBootstrap()`** (default): an **internal single-replica** `mongo:7`
  StatefulSet + Service — no operator, no CRDs, no auth. Dev-first; NOT an HA datastore.
- **`makeClickstackBootstrap({ mongo: { mode: 'external' } })`**: the variant's runtime spec REQUIRES
  `mongoUri` (topology shapes the schema); nothing Mongo-shaped is deployed.

## Initial user (and the one registration HyperDX hands out)

HyperDX bootstraps on a **first-run-claims-the-instance** pattern. The first visitor to
`POST /register/password` creates the account, creates the Team, and — through `setupTeamDefaults` —
gets that Team's ClickHouse connection and its log/trace/metric/session sources. Registration then
closes behind them: every later attempt answers `409 teamAlreadyExists`, and the invite flow needs an
authenticated user to start from. **Exactly one registration exists per instance, and whoever spends
it becomes the administrator.**

The chart on its own ships a perfectly reachable UI. The bootstrap CronJob is what broke it: it
created the Team directly, to pre-seed the ingestion API key, which **spends that single registration
without producing an account**. Every deployment converged to one Team, zero users, no connections, no
sources, and a login page nobody could satisfy — verified on ClickStack 3.2.0 / app 2.35.0
([#227](https://github.com/yehudacohen/typekro/issues/227)).

`initialUser` makes the CronJob spend the registration **the way upstream intends** — through the
app's own endpoint — so the account, the Team, the connection and the sources all come out of
HyperDX's own code:

```typescript
const bootstrap = makeClickstackBootstrap({
  initialUser: { email: 'ops@example.com' },
});
```

Configuring it is the supported way to run this composition. See
[without `initialUser`](#without-initialuser-the-degraded-mode) for what you get if you do not.

**The password is never a prop.** Only where to find it is. The value reaches the container through a
`secretKeyRef`, and there are two ways to point at it — pick by credential mode.

### `secretValues` mode: let the chart create the Secret

This is the supported path for the Secret-backed credential mode, and it is the default shape of
`initialUser`. Your external credentials Secret already carries a `values.yaml` fragment that Flux
merges through `valuesFrom`; add the password to the `hyperdx.secrets` map in that fragment and the
**chart** renders it into `clickstack-secret` alongside `HYPERDX_API_KEY`. The credential never enters
the HelmRelease, the RGD, or any TypeKro build option.

```yaml
# The externally-managed Secret, in the ClickStack workload namespace.
apiVersion: v1
kind: Secret
metadata:
  name: clickstack-credentials
stringData:
  values.yaml: |
    hyperdx:
      secrets:
        HYPERDX_API_KEY: "…"
        CLICKHOUSE_PASSWORD: "…"
        CLICKHOUSE_APP_PASSWORD: "…"
        HYPERDX_INITIAL_USER_PASSWORD: "…"
```

```typescript
const bootstrap = makeClickstackBootstrap({
  credentials: { source: 'secretValues' },
  initialUser: {
    email: 'ops@example.com',
    // Key inside the CHART-rendered `clickstack-secret`, which is to say: the
    // key you wrote under `hyperdx.secrets` above.
    // Default: 'HYPERDX_INITIAL_USER_PASSWORD'.
    passwordSecretKey: 'HYPERDX_INITIAL_USER_PASSWORD',
  },
});
```

Do **not** precreate or hand-maintain `clickstack-secret` itself. It is Helm-owned — ClickStack 3.2.0
renders it from `.Values.hyperdx.secrets` — so a hand-written copy may be adopted, rejected or
overwritten by the next reconciliation. Supply the values, let the chart own the object.

### Inline mode: reference a Secret you own

In the inline credential mode there is no clean route into `clickstack-secret`: the only way to add a
key is build-time `values.hyperdx.secrets`, which lands the password in the HelmRelease `spec.values`
tree in etcd — undoing the point of keeping it out of a prop. Use `passwordSecretRef` to point the
CronJob at a Secret you create and rotate yourself, and skip the chart's Secret entirely:

```typescript
const bootstrap = makeClickstackBootstrap({
  initialUser: {
    email: 'ops@example.com',
    passwordSecretRef: { name: 'hyperdx-bootstrap', key: 'initial-user.password' },
  },
});
```

The Secret must live in the ClickStack workload Namespace, because a `secretKeyRef` is
namespace-local. `passwordSecretKey` and `passwordSecretRef` are **mutually exclusive** — they name
Secrets with different owners, so supplying both is a build-time error rather than a silent
precedence rule. Because a Secret key may contain `-` and `.` (which a POSIX environment variable name
may not), the container variable is always `HYPERDX_INITIAL_USER_PASSWORD` in this mode.

### What the CronJob actually does

1. **Checks its own marker.** A document in `typekro_bootstrap` / `_id: 'initial-user'`. Present means
   the instance was claimed under TypeKro's watch, and the run short-circuits before touching the
   network, the password, or anything else.
2. **Registers, if no Team exists yet.** `POST /register/password` with the configured address and the
   password from the Secret. The app writes the account, derives its own hashes, generates its own
   keys, creates the Team and provisions its connection and sources. TypeKro reproduces none of it, so
   none of it can drift.
3. **Records the marker** — on every exit from the bootstrap branch, including a `409
   teamAlreadyExists` (a human beat the CronJob to it, which is a success: the instance is claimed).
   A redirect is a refusal, not a registration: the POST never follows one, so the run fails without a
   marker and retries.
4. **Patches `teams.apiKey`.** One `updateOne`, on every run, so the Team carries the pre-shared
   ingestion key the collector authenticates with and a rotated Secret still converges.
5. **Checks the Team's defaults.** Registration already ran `setupTeamDefaults`, so this normally
   finds the connection and sources in place and records that. See
   [Team name and default sources](#team-name-and-default-sources).

### What it guarantees

- **HyperDX validates the address and the password, not TypeKro.** `registrationSchema` is the
  authority on both, and it answers a bad one with a 400 whose body names the offending field — which
  the CronJob relays verbatim. A second, divergent copy of those rules here could only reject values
  the app would have taken. **A refused registration is not a consumed registration**, so a typo or a
  weak password costs one failed run and nothing else.
- **Bootstrap-once, on durable state.** The outer guard is the marker, not the presence of an account.
  "Has TypeKro ever bootstrapped?" is a different question from "does an account exist right now?",
  and answering the first with the second resurrects an account an operator deleted on purpose. It is
  a TypeKro-owned collection rather than an extra field on HyperDX's own documents, so framework
  bookkeeping stays out of an upstream-owned schema.
- **Never a reason ingestion fails to converge.** The password reference is `optional: true`. With
  `optional: false` a missing key stops kubelet starting the container at all, so the ingestion key is
  never reconciled either. Presence is asserted inside the branch that registers, so rotating the
  bootstrap password away afterwards is a no-op rather than a permanent failure.
  (`HYPERDX_API_KEY` stays `optional: false`: it is needed on every run.)
- **An API that has not started yet is reported as transient.** The CronJob runs every minute and
  depends on the HelmRelease, so the first runs can legitimately find nothing listening. That log line
  says so, in those words, instead of reading like a broken deployment.
- **A Team deleted after bootstrap is not recreated.** Recreating it would spend a registration nobody
  can use — the exact bug this feature exists to fix — so the run fails loudly and leaves the decision
  to you.

### Without `initialUser`: the DEGRADED mode

Omitting `initialUser` keeps exactly the behaviour that shipped before: the CronJob creates the Team
itself so the ingestion API key exists. **This spends the instance's one registration on a Team with
nobody in it.** Telemetry flows, and the UI is unreachable — permanently, with no supported way back
in short of deleting the Team so registration reopens. It remains the default only so that existing
deployments whose ingestion key is already converged do not break. It is not a configuration to
choose.

A Team the CronJob inserts never passes through HyperDX's `setupTeamDefaults`, so on its own it has no
ClickHouse connection and no sources. The CronJob seeds them itself, and names the Team — see
[Team name and default sources](#team-name-and-default-sources).

### Team name and default sources

HyperDX's UI opens its "set up your connection to ClickHouse" onboarding modal for a Team with no
connection (`GET /api/connections` is empty) or no source (`GET /api/sources` is empty). HyperDX only
provisions them in `setupTeamDefaults`, which it calls when `POST /register/password` creates a
Team. A Team created any other way, like the one the degraded path inserts, stays empty. On every
run the CronJob therefore also reconciles the Team's name and, once, its defaults.

**When it seeds.**

| Credentials | `teamDefaults` default | Why |
| --- | --- | --- |
| inline | on | TypeKro owns the whole connection: it renders `defaultConnections` from the spec. |
| `secretValues` | **off** | Your values fragment may replace `defaultConnections`, and the CronJob can't see that. Without `initialUser` nothing runs `setupTeamDefaults`, so a default seed would put TypeKro's connection in place of yours, once and for good. Set `teamDefaults: true` (or an options object) to seed TypeKro's typed ClickHouse topology. |

With `initialUser` the default barely matters: HyperDX's own registration seeds the Team from the fully
merged values, and the CronJob then finds it configured and adds nothing.

**What is seeded.** One connection named `External ClickHouse`, with host
`http://<clickhouse.host>:<clickhouse.httpPort>`, the UI user `clickhouse.appUsername` (else
`username`, else `default`), and that user's password. The password is read by `secretKeyRef`, so it
never appears in the manifest or the log (see [the password](#the-seeded-password) for which key). Like
HyperDX's own connections, it is stored in plain text in HyperDX's `connections` collection. Then the
`Logs`, `Traces`, `Metrics` and `Sessions` sources on `otel_logs`, `otel_traces`,
`otel_metrics_{gauge,histogram,sum}` and `hyperdx_sessions` in `clickhouse.database`, with the column
mappings and cross-references TypeKro renders into the chart's `defaultSources`. The documents are
exactly what `setupTeamDefaults` stores for the same `DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` in
HyperDX 2.35.0. The real-image test compares the two field by field.

**Only into an empty Team, and only once.** The first time the CronJob sees a Team, it seeds only if
the Team has no connection and no source. Anything already there is someone else's configuration, and
the Team is left alone for good. Seeding reserves its document ids in a marker in `typekro_bootstrap`
first, and records each document once it is written. A run interrupted halfway is finished by the next
without duplicating anything, and without re-creating a document someone deleted in between. Each run
checks once, just before it writes, that the Team holds nothing but TypeKro's planned documents (so a
run resuming an interrupted seed checks too). If it finds a connection or source that isn't one of
TypeKro's, it stops and keeps what exists. After that, the Team is never seeded again. **Edits
made in the UI afterwards are never overwritten**, and connections or sources deleted on purpose stay
deleted. A Team TypeKro did not create itself gets a 60-second grace period first, so the CronJob never
writes while HyperDX's own registration is still setting the Team up. (One narrow window remains: if the
CronJob dies between writing a document and recording it, and someone deletes that document before the
next run, the next run writes it again.)

#### The seeded password

The seed has to create the same connection HyperDX's own registration would, with the same password.
Otherwise the Team looks configured, the connection can't log in, and nothing seeds again. In both
credential modes that password is the chart value `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD`:

- **Inline credentials:** TypeKro renders it from `clickhouse.appPassword` (else `password`), and writes
  it into `defaultConnections`.
- **`secretValues` credentials:** your fragment sets it, and TypeKro's
  [default-connections ConfigMap](#credential-modes) templates it into `defaultConnections`.

The chart renders the same value into `clickstack-secret`'s `CLICKHOUSE_APP_PASSWORD`, and the seed
reads it from there by `secretKeyRef`. There is one connection definition, and HyperDX's registration
and the seed both use it. If your fragment replaces `defaultConnections` itself, the seed can't follow
that, so leave `teamDefaults` off.

The seed holds off, and records nothing, only while the key is missing. It seeds on the first run after
the key appears. The reference is `optional: true`, so a missing Secret or key can't stop the CronJob
from reconciling the ingestion key.

Any value the key holds is seeded as it is, including an empty one (a ClickHouse user without a
password, as HyperDX itself does) and including `hyperdx`. That also happens to be the chart's
published default, but it is an ordinary password, and TypeKro reserves no values. If your
`secretValues` fragment omits `CLICKHOUSE_APP_PASSWORD` and you opt in, the chart's default is what gets
seeded. HyperDX's own registration would use it too.

**The name.** `teamName` (default `ClickStack`, at most 100 characters) names the Team the degraded
path creates. With `initialUser`, HyperDX names the Team at registration, and TypeKro renames it only
if you set `teamName`. A rename touches only `name`, so the Team keeps its `_id`, its `apiKey` and its
users. TypeKro renames a Team only while it owns the name, and records in `typekro_bootstrap` who does:

- **A Team the CronJob creates:** TypeKro records the name as its own before inserting the Team.
- **A Team with no record** (from before this release, or created by HyperDX): the name is TypeKro's
  only while it is still the default the Team was created with. That is the one name earlier releases
  hard-coded, matched by SHA-256, or, with `initialUser`, HyperDX's registration name
  `<initialUser.email>'s Team`. **Any other name is a person's choice and is kept**, even one that
  happens to equal `teamName`.
- **Once a person owns the name, they own it for good.** When TypeKro finds the Team renamed away from
  the name it recorded, or finds a name it doesn't own, it records the name as the person's. Later
  `teamName` changes, and later renames back to `teamName`, leave that Team alone.
- **Concurrent renames:** the rename is conditional on the name TypeKro read, so a rename in the UI at
  the same moment wins.

**Existing deployments** converge on the first run after upgrading. A Team still carrying the old
default name is renamed to `teamName`, and a Team someone renamed keeps its name. This includes a
deployment that has since switched to `initialUser`. The Team is seeded if it is still empty.

**Turning it on or off.** `teamDefaults: false` skips the seed, and `teamDefaults: true` asks for it
where it is off by default. It is always skipped when build-time `values` replace
`hyperdx.deployment.defaultConnections` or `defaultSources`, or set `useExistingConfigSecret`, because
what HyperDX would seed is then yours, and so is its password.

```typescript
const bootstrap = makeClickstackBootstrap({
  credentials: { source: 'secretValues' },
  teamName: 'Observability',
  teamDefaults: true, // `{ allowUnvalidatedChartVersion: true }` past chart 3.2.0
});
```

### Upgrading

Check these when upgrading from a release without the Team-defaults seed:

- **Pinned to a chart other than 3.2.0?** The seed is on by default with inline credentials, and it
  carries the [chart-version guard](#chart-versions-it-is-valid-for), so the default composition now
  refuses that version. Set `teamDefaults: false`, or
  `teamDefaults: { allowUnvalidatedChartVersion: true }` once you have checked HyperDX's
  `connections` / `sources` schema on that chart.
- **`secretValues` credentials:**
  - The HelmRelease gains a `<release>-default-connections` ConfigMap in `valuesFrom`, before your
    Secret, so HyperDX's default connection is the external ClickHouse from the spec. A
    `hyperdx.deployment.defaultConnections` in your fragment still wins.
  - The seed is opt-in there (`teamDefaults: true`).
- **A Team HyperDX already gave the wrong connection** is never repaired. That includes the chart's own
  "Local ClickHouse", which a `secretValues` + `initialUser` registration used to get. The Team isn't
  empty, so the seed leaves it alone. Fix or delete the connection in HyperDX's UI.
- **Team names:** a Team still carrying the old hard-coded default is renamed to `teamName` on the
  first run. Any other name is kept.
- **`clickhouse.host`:** a value with a scheme, port, path, backslash, userinfo, whitespace or
  non-ASCII characters is now refused, as are an unbracketed IPv6 address and a bracketed value that
  isn't IPv6. [The rules](#clickhouse-host) list exactly what's accepted.
- **KRO CRDs you already have** don't get the new admission rules, because KRO 0.9.2 doesn't apply a
  validation-only change to an existing CRD (see the [KRO caveat](#chart-versions-it-is-valid-for)).
  The render-time checks and the seed's runtime version check still apply.

### Chart versions it is valid for

Three features write into HyperDX's own, upstream-owned schema, and each is guarded by the same
version allowlist:

- **`initialUser`** patches `teams.apiKey`, and relies on the registration HTTP contract. Registration
  goes through HyperDX's own endpoint, so the account document, its hashing and `setupTeamDefaults`
  aren't TypeKro's business. The HTTP half fails loudly if it moves (a 404 turns the CronJob red). The
  `teams.apiKey` half doesn't: a renamed field would leave the Job green and ingestion silently
  unauthenticated.
- **The [Team-defaults seed](#team-name-and-default-sources)** writes `connections` and `sources`
  documents in HyperDX 2.35.0's shape. It is on by default with inline credentials, so **the default
  composition is guarded too**.
- **[`hyperdxOidc`](#sign-in-with-openid-connect-hyperdxoidc)** hooks HyperDX's Passport instance, root
  router and user/team models.

The allowlist is **exact**: chart **3.2.0** (appVersion 2.35.0). Not a series and not a prefix —
`3.2.0 || 4.0.0` and `>=3.2.0` are legal Helm version *ranges* that a prefix check would wave through,
and a patch bump promises nothing about the app's data contract. Whenever any of the three is on, it is
enforced in **both** modes. A concrete version outside the list is refused at render time. The
generated CRD narrows `spec.version` with a CEL validation, so a KRO consumer who sets an unaudited
version on the custom resource at apply time is refused by admission.

**KRO caveat: the CRD rules only reach new CRDs.** The version rule and the
[host rule](#clickhouse-host) are `x-kubernetes-validations` entries.
KRO 0.9.2's CRD compatibility check doesn't compare those, so it treats a change that only adds or
edits one as "no changes" and doesn't touch a CRD it already created. This was checked against its
source (`Ensure` in `pkg/client/crd.go`, `pkg/graph/crd/compat/schema.go`) and on a real cluster.
The rules land on CRDs KRO creates from this release on, or on an existing one the next time a compared
schema change, such as a new field, makes KRO patch it. For that reason, the Team-defaults seed checks
both again at runtime, whatever the CRD says, which also holds on an upgraded KRO deployment:

- **The chart version.** The CronJob gets the release's chart version and seeds nothing on an
  unaudited one.
- **The host.** The seed runs the full [host check](#clickhouse-host) (IPv6 and URL parsing, not just
  the CRD's syntactic rule) on the connection host it would write, and seeds nothing on an invalid one. It logs the host, never the password, and writes no marker, so it seeds
  once the host is fixed.

HyperDX's own default connection needs no such check: the host, user, password and database reach
`DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` through Helm's `toJson` in both credential modes, so any value
yields valid JSON.

The `initialUser` and `hyperdxOidc` version rules have the same limitation, and it predates this
release: on an upgraded CRD, only their build-time halves apply.

Each feature has its own escape hatch, for once you have checked its contract on a newer chart yourself:
`initialUser.allowUnvalidatedChartVersion`, `teamDefaults: { allowUnvalidatedChartVersion: true }` and
`hyperdxOidc.allowUnvalidatedChartVersion`. `teamDefaults: false` removes the seed, and with it the
seed's guard. With none of the three on, any chart version is accepted.

## Sign-in with OpenID Connect (`hyperdxOidc`)

HyperDX's open-source build signs users in only with an email and password; its SSO is a commercial
feature. `hyperdxOidc` adds OpenID Connect sign-in, without forking or rebuilding the HyperDX image (#241).

```typescript
const stack = makeClickstackBootstrap({
  initialUser: { email: 'ops@example.com' },          // keep a break-glass password account
  hyperdxOidc: { configSecretRef: { name: 'hyperdx-oidc' } },
});
```

`configSecretRef` names a Secret **you** create in the release's namespace, with the configuration under
the key `oidc.json` (override with `configSecretRef.key`):

```json
{
  "providers": [
    {
      "id": "cognito",
      "displayName": "Company SSO",
      "issuer": "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_EXAMPLE",
      "clientId": "…",
      "clientSecret": "…",
      "claims": { "groups": "cognito:groups" },
      "allow": { "groups": ["hyperdx-users"] }
    }
  ],
  "passwordLogin": true,
  "maxSessionAge": "12h"
}
```

Register `https://<hyperdx host>/api/login/oidc/<provider id>/callback` as the redirect URI with each
provider. Users sign in at `/api/login/oidc`, which goes straight to the provider when there is only one and
shows a chooser otherwise.

### Public URL

Set `hyperdx.frontendUrl` (HyperDX's `FRONTEND_URL`) to the URL users type, e.g.
`https://hyperdx.example.com`. The plugin builds every redirect it issues as an absolute URL:

- the callback URL and the chooser's redirect to the one provider use `redirectBaseUrl` if set, else
  `FRONTEND_URL`. They share one base, so the sign-in starts and ends on the same origin;
- the redirect back to HyperDX after sign-in and the `?err=` redirects to `/login` use HyperDX's own
  redirect base (`FRONTEND_URL`), as HyperDX's routes do.

If you set `redirectBaseUrl`, give it the same origin as `FRONTEND_URL`. Sign-in sets its session cookie on
the callback's origin and then sends the browser to `FRONTEND_URL`. On another origin that cookie isn't
sent, so the plugin logs a warning when the two origins differ.

Absolute redirects matter behind a reverse proxy. HyperDX's UI proxies `/api/*` to its API server on port
8000, and it rewrites a relative `Location` from the API by swapping in only the request's host. When the
`Host` header carries no port, as with every request through a TLS proxy on 443, the API server's port and
scheme stay, and the browser is sent to an unreachable `http://<host>:8000/...`.

The plugin never builds a redirect from the request's `Host` header, because that would be an open
redirect. HyperDX's image always sets `FRONTEND_URL`, defaulting to `http://localhost:<app port>`, so leaving
`hyperdx.frontendUrl` unset sends users to `localhost` after sign-in. `redirectBaseUrl` is refused unless it's
a plain `http(s)` base URL (no credentials, query or fragment). A `FRONTEND_URL` that isn't one is ignored,
and with no `redirectBaseUrl` the plugin falls back to relative redirects and logs a warning that says
which. Those work only when the browser reaches HyperDX on an explicit port, and no provider accepts a
relative callback. The chooser page's own links are relative, which is fine: the browser resolves them
against the page's public URL.

### How it works

HyperDX authenticates with Passport and keeps sessions in MongoDB. TypeKro ships a small plugin
(`plugins/hyperdx-oidc/`) that joins that same path. It is shipped as a ConfigMap
(`<release>-hyperdx-oidc-plugin`) and loaded into the HyperDX container with `NODE_OPTIONS=--require`, and it
activates only in the API process. There it:

- registers one Passport strategy per provider on HyperDX's own `passport`;
- adds the `/api/login/oidc/...` routes to HyperDX's root router;
- ends every sign-in in `req.logIn()`, so a signed-in user holds an ordinary HyperDX session. Logout and every
  API route work unchanged.

The flow is the authorization-code flow with PKCE, `state` and `nonce`. Issuer metadata is discovered and
refreshed.

Each sign-in in flight is a document in the `typekro_oidc_pending_logins` collection, keyed by `state`,
not an entry in the HyperDX session. That's why several sign-ins can start and complete at once in one
browser, for example when a reverse proxy starts sign-in for every signed-out tab a browser restores.
Each sign-in:

- **Is bound to the browser.** It sets its own random cookie (`typekro_oidc_…`: HttpOnly, SameSite=Lax,
  Secure on https, path limited to the login routes). The document stores only a SHA-256 of that cookie, and
  a callback must present the cookie for its own `state`. One cookie per sign-in, rather than one shared
  cookie, lets two sign-ins started at the same moment by a browser that has no cookie yet both succeed.
- **Is used exactly once.** The callback takes its document in one atomic `findOneAndDelete` before any
  token exchange, so a replayed callback URL is refused even when callbacks run concurrently.
- **Expires after 10 minutes.** A TTL index removes the document, and the cookie expires with it.
- **Counts towards a cap.** A browser keeps at most 10 sign-ins in flight; starting more evicts the oldest.

Sign-in is refused until the collection's indexes exist. A `returnTo` longer than 2,048 characters, or
not a same-origin path, becomes `/`.

The Secret is mounted as a directory (never `subPath`). The plugin re-reads it every `reloadSeconds`
(default 15), so **providers can be added, changed or removed without a restart**. An invalid document is
rejected, and the last good configuration keeps serving. A new plugin build changes the pod annotation
`typekro.io/hyperdx-oidc-plugin-sha256`, which rolls the pod.

### Who gets in

| Setting | Default | Meaning |
| --- | --- | --- |
| `allow.groups` / `allow.emailDomains` | — (one is required) | Every rule that is set must pass. An empty rule is refused, because it would admit every account the provider can authenticate. |
| `claims.email` / `claims.groups` / `claims.name` | `email` / `groups` / `name` | Claim names per provider, e.g. `cognito:groups` for Cognito, `roles` for Entra ID app roles. |
| `requireVerifiedEmail` | `true` | Refuse an ID token whose `email_verified` is not true. Turn off only for a provider that never sends it but owns the email (Entra ID), together with `allow.emailDomains`. |
| `linkExistingUsersByEmail` | follows `requireVerifiedEmail` | On a subject's first sign-in, link an existing HyperDX user with the same email, but only one no provider has linked yet (e.g. the password-only `initialUser`). Setting it to `true` with `requireVerifiedEmail: false` is refused: an unverified email is only a claim. |
| `createUsers` | `true` | Create a HyperDX user on first sign-in, in HyperDX's team (the open-source build has one). |
| `tokenEndpointAuthMethod` | `client_secret_basic` | Or `client_secret_post`. |
| `scopes` | `openid email profile` | Must include `openid`. |
| `passwordLogin` | `true` | `false` refuses HyperDX's own password login and first-run registration. With `initialUser`, the one exception is that account's own registration while no team exists (see below). |
| `passwordLoginPath` | `hyperdxOidc.passwordLoginPath`, else `/login` | Where the multi-provider chooser links HyperDX's password form. Set it, e.g. to `/login?password`, when your reverse proxy sends a bare `/login` to SSO. It must be a path on HyperDX's own origin. The build option `hyperdxOidc.passwordLoginPath` sets the default for every configuration; this key wins when set. With `passwordLogin: false` there's no link. |
| `maxSessionAge` | `12h` | OIDC sessions older than this, or from a provider that was removed, are logged out. `0` never expires them. |
| `redirectBaseUrl` | HyperDX's `FRONTEND_URL` | External URL used to build callback URLs and the chooser's redirect. Must share `FRONTEND_URL`'s origin (see [Public URL](#public-url)). |

Accounts are linked by the provider's stable subject (`sub`), recorded in the `typekro_oidc_identities`
collection in HyperDX's MongoDB, not by email. Two unique indexes enforce the invariants below: one link per
(provider, subject), and one link per HyperDX user. They hold even when sign-ins race, and sign-in is refused
until the indexes exist.
- An account that is already linked to one subject is never handed to another subject through its email.
  That covers a recycled email and the same email asserted by a second provider; the sign-in is refused.
- Emails must be ASCII. Unicode look-alikes (such as the Kelvin sign case-folding to `k`) are refused before
  any comparison.

**Revoking access.** A sign-in that the provider no longer admits (group or domain removed, email no longer
verified) is refused. For a linked user it also rotates their HyperDX access key, which ends their external
API and MCP access. Sessions end through `maxSessionAge`. To remove someone outright, delete their HyperDX
user. Note that a typo in `allow` rules that is live while linked users sign in rotates their keys too, so
check rule changes before applying them.

**Removing a provider** leaves its links in `typekro_oidc_identities`, so its users' emails stay attached to
their accounts, and a sign-in from another provider with the same email is refused. To move a user to a new
provider, delete their link document (`db.typekro_oidc_identities.deleteOne({ provider, subject })`).

**Without `initialUser`.** The team-bootstrap CronJob creates HyperDX's team, so the plugin never does.
If a first OIDC sign-in created the team before the CronJob's first run, there would be two teams, and the
plugin refuses new users once more than one exists. Until the CronJob has run (about a minute after the
release is ready), OIDC sign-in answers "HyperDX is still being set up. Try again in a minute." Afterwards,
every OIDC user joins that one team, which has its [connection and sources](#team-name-and-default-sources).
(The plugin can still create the team on its own, with `TYPEKRO_HDX_OIDC_CREATE_TEAM=true`, where
simultaneous first sign-ins race for a claim document in `typekro_oidc_state` so that exactly one creates
it. The composition never sets that.)

**With `initialUser`.** The first OIDC sign-in does not create HyperDX's team when `initialUser` is set.
Until a team exists, OIDC sign-in answers "still being set up". What else can claim the instance depends on
`passwordLogin`:

- With `passwordLogin: false`, only the `initialUser` credentials can use first-run registration, and only
  while no team exists. The wiring
  gives the plugin the `initialUser` email (`TYPEKRO_HDX_OIDC_BOOTSTRAP_EMAIL`) and projects the same
  password Secret key the bootstrap CronJob reads into the HyperDX pod as a file: an optional Secret volume
  mounted as a whole directory at `/etc/typekro/hyperdx-bootstrap` (the file is `password`, named by
  `TYPEKRO_HDX_OIDC_BOOTSTRAP_PASSWORD_FILE`). The plugin reads the file on every registration attempt and
  lets a registration through only when no team exists yet, its email matches (case-insensitively) and its
  password matches the file's exact bytes, as the CronJob sends them (compared in constant time; nothing is
  trimmed). The team check comes first. Any other registration is refused before HyperDX sees it. While the key is missing, every registration is refused,
  the bootstrap's included. Adding the key to the Secret, or rotating it before the bootstrap has
  registered, takes effect without restarting HyperDX once the kubelet syncs the Secret volume (typically
  within a minute or two), and the CronJob's next run then succeeds.
- With `passwordLogin: true`, registration is HyperDX's own and open to anyone until a team exists, exactly
  as without the plugin. Whoever registers first owns the instance, and the CronJob treats the resulting
  `teamAlreadyExists` as done. Keep the API unreachable until the bootstrap has run if that matters.

Once a team exists, registration is closed. With `passwordLogin: true`, HyperDX answers every registration
with `teamAlreadyExists`. With `passwordLogin: false`, the plugin refuses every registration identically,
the `initialUser` credentials included (the same `303` to `/login?err=passwordAuthNotAllowed`), without
reading the password file or comparing anything, so the endpoint can't be used to test guesses at the
initial password. The bootstrap CronJob doesn't need the `409`: it checks for a team before registering and
records the bootstrap as complete when one exists. The first OIDC sign-in with that account's email links
to it.

What that account is depends on `passwordLogin`. With `true` it's a **break-glass** login for when OIDC is
broken. With `false` it's only the **initial account**: it exists and owns the team, but can't sign in with
its password. Keep it as a break-glass login by leaving `passwordLogin: true`, or plan to flip the Secret back
if OIDC ever breaks, since the change applies without a restart.

### Guard rails

- The plugin checks every HyperDX hook point at startup. If one is missing, as on a HyperDX version it wasn't
  built for, it logs why and disables itself, and password login keeps working.
- It is enabled only on audited chart versions (`3.2.0`, HyperDX `2.35.0`), like `initialUser`: at build time
  in direct mode, and by narrowing `spec.version` on the CRD in KRO mode, on CRDs KRO creates fresh (see
  the [KRO caveat](#chart-versions-it-is-valid-for)). After verifying a newer chart, set
  `hyperdxOidc.allowUnvalidatedChartVersion: true`.
- Turning `passwordLogin` off doesn't end password sessions that already exist; they expire on HyperDX's own
  30-day rolling cookie. To end them now, rotate the session secret or delete the sessions in MongoDB.
- The team's default connection and sources come from HyperDX's registration (with `initialUser`) or from
  the team-bootstrap CronJob (without it), never from an OIDC sign-in.
- `passwordLogin: false` is enforced on HyperDX's password strategy itself, so it holds for every route
  that uses it, however the path is spelled (Express matches routes case-insensitively). First-run
  registration and team-invite acceptance, which create password accounts without the strategy, are refused
  too.
- If no valid configuration has loaded since the process started (e.g. a broken Secret at startup), no
  provider is active and password login stays **allowed**. That's the break-glass path for a broken OIDC
  configuration, and it is logged as an error. A configuration that later becomes invalid keeps the last good
  one.
- Per-instance runtime `values` that replace `hyperdx.deployment.env` would drop `NODE_OPTIONS` and switch
  the plugin off. Pass extra env through the build-time `values` instead, which the wiring appends to.
- With `initialUser` and `hyperdxOidc`, the HyperDX pod mounts the initial password's Secret key as a file,
  the key the bootstrap CronJob reads. The plugin never logs it. Rotating the key away after the bootstrap
  has registered is safe; the volume is optional, and HyperDX starts without it.
- Known cleanup debt: if one subject's first two sign-ins run at once and present two different verified
  emails, one of the two HyperDX users they create can be left with no link. Delete it by hand if it turns
  up.
- `team.allowedAuthMethods` is left untouched. HyperDX's own response schemas type it as `'password'` only,
  so the plugin enforces `passwordLogin` itself.
- If the caller's static `values` already set `NODE_OPTIONS` or the plugin's volume names, the build fails
  instead of silently overriding them. The plugin's env, volumes and mounts are appended to the caller's own
  lists.

## Build-Time Options vs Runtime Spec

Build-time (constructor — must be concrete; schema refs are rejected loudly): the Mongo mode + storage,
credential source, the [`initialUser`](#initial-user-and-the-one-registration-hyperdx-hands-out) account,
the Team's [`teamName` and `teamDefaults`](#team-name-and-default-sources),
the external ClickHouse's [`storage`](#s3-backed-clickhouse) story,
static raw chart `values`, static Flux `postRenderers` on the ClickStack HelmRelease (passed through
verbatim — the composition adds none of its own), RGD `name`/`kind`. Runtime spec (proxy-safe):
release name (at most **37 characters** — see [release-name length](#release-name-length)),
namespace, chart version, the ClickHouse connection, credential Secret coordinates or inline API key,
and HyperDX conveniences.

Note `customValues` is **not part of the runtime schema** — it's absent from `bootstrapBaseShape`, so
KRO-mode callers (whose spec is validated against that schema, and whose values come out as CEL) cannot
use it at all: the mapped values tree carries CEL template leaves, which cannot live inside a KRO
runtime map-merge (the serialized CEL is invalid). It IS accepted as an internal, **direct-mode-only**
escape hatch by the wider runtime-config type the values mapper consumes — only a CONCRETE object
merges, and there's no test coverage backing it as a supported feature. For anything beyond ad hoc
direct-mode tweaks, go through the build-time `values` instead.

## Schema / Replication Caveat

On first start the gateway collector's goose migrations create `otel_logs` / `otel_traces` /
`otel_metrics_*` / `hyperdx_sessions` in the external ClickHouse as **plain single-node MergeTree**
tables — matching a 1-shard×1-replica CHI. Multi-replica (`ON CLUSTER` / `Replicated*`) schemas are NOT
supported by ClickStack's tooling; see `CLICKSTACK_CLICKHOUSE_GUIDANCE` before scaling the CHI. Version
coupling is loose (chart vendors CH 25.7; a `<26.2` compat schema variant exists; the optional
JSON-typed schema via `HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE` wants CH 25.3+).

## S3-backed ClickHouse

When the external ClickHouse keeps its data in object storage
([`makeClickHouseCluster({ storage: { mode: 's3' } })`](/api/clickhouse/#storage)), the storage
**policy** needs nothing here: the `clickhouse` factory sets `merge_tree/storage_policy` as the
server default, so the gateway collector's goose migrations create `otel_logs` / `otel_traces` /
`otel_metrics_*` / `hyperdx_sessions` on the S3 policy with no `SETTINGS storage_policy` clause and
no per-table DDL from TypeKro. The kind integration suite asserts exactly that
(`test/integration/clickstack/s3-backed.test.ts`).

`storage` here covers the three things a server default cannot express — TTL retention, the
collector's persistent sending queue, and the status contract:

```typescript
const bootstrap = makeClickstackBootstrap({
  mongo: { mode: 'internal', storage: { storageClassName: 'gp3-expandable' } },
  storage: {
    mode: 's3',
    diskType: 's3',
    // Per-signal TTL, applied by an idempotent DDL CronJob.
    // NOT available with `diskType: 's3_plain_rewritable'` — see below.
    retention: { logs: '30d', traces: '7d', metrics: '90d' },
    // Survive a collector or ClickHouse restart during a node rebuild.
    persistentQueue: { enabled: true, size: '10Gi' },
  },
});
```

### Retention (TTL)

Durations are `'<n>d'`, `'<n>h'` or `'<n>m'`, compiled into
`ALTER TABLE … MODIFY TTL toDateTime(<column>) + INTERVAL n UNIT DELETE`. `logs` covers `otel_logs` and
`hyperdx_sessions` (a log-kind table in HyperDX's own source definitions), `traces` covers
`otel_traces`, and `metrics` covers `otel_metrics_gauge` / `_sum` / `_histogram`. Each table's TTL
keys off the timestamp column HyperDX itself queries — `Timestamp`, `TimeUnix`, `TimestampTime`.

The collector's own migration **already sets a 30-day TTL**
(`toDateTime(Timestamp) + toIntervalDay(30)`, with `ttl_only_drop_parts = 1` — verified live against
chart 3.2.0), so `retention` *overrides* that default rather than establishing the first one. The
`toDateTime(…)` wrapper matches the form the collector stores, which keeps the stored expression and
the idempotence probe directly comparable.

It runs as a **CronJob**, not a one-shot Job, for two honest reasons: the tables do not exist until
the collector has migrated, and TypeKro does not own their DDL. The script therefore skips a missing
table and re-checks on a later run, and only issues `MODIFY TTL` when the table's current TTL is not
already the intended one — so a converged cluster does no metadata churn. `retentionSchedule`
defaults to `'17 * * * *'`.

The idempotence probe compares the **complete** TTL clause, not a substring of it: it extracts
everything between `TTL ` and the trailing ` SETTINGS …` out of `system.tables.engine_full`,
collapses whitespace, and tests that for equality against the intended clause. A substring probe was
wrong in both directions — `toIntervalDay(3)` occurs inside `toIntervalDay(30)`, so a needed change
would be skipped, and a table carrying the intended interval *plus* extra clauses (a `WHERE`, a
second `TO VOLUME` entry) would also be reported as converged. On a mismatch the job logs the clause
it actually found, so a change in ClickHouse's rendering shows up in the Job log rather than as
silent per-run churn.

Every statement carries `SETTINGS materialize_ttl_after_modify = 0`, because the materialization
pass is a **mutation** and the `plain_rewritable` metadata type does not support mutations. Expiry
still happens during merges.

::: danger `retention` is incompatible with `diskType: 's3_plain_rewritable'`
The combination is **rejected at construction**. `materialize_ttl_after_modify = 0` skips the
materialization mutation, but that is not enough: the immutable metadata type refuses the metadata
`ALTER` itself. Verified live against ClickHouse 25.7 —

```text
Code: 344. DB::Exception: ALTER TABLE commands are not supported on immutable disk 's3',
except for setting and comment alteration. (SUPPORT_IS_DISABLED)
```

— while the identical statement against a table on the server's local policy succeeds, so this is a
property of the disk type, not of the statement. Rendering the CronJob anyway would ship a job that
CrashLoops on every run while reporting a retention policy that never takes effect.

**The two durability stories therefore trade off against TTL:**

| ClickHouse `diskType` | Node loss | TypeKro-managed `retention` |
| --- | --- | --- |
| `s3_plain_rewritable` | restart and reattach, no restore step | ✗ — keep the 30-day TTL the collector's migrations create |
| `s3` + `storage.backup` | restore from the scheduled backup | ✓ |
:::

The job reads its connection from the chart-owned `clickstack-config` ConfigMap and
`clickstack-secret` Secret via `envFrom` — the same pair the gateway collector uses — so it works
identically in inline and Secret-backed credential modes and keeps no credential in the manifest.

### Persistent collector queue

::: warning THE OVERLAY IS ONE YAML DOCUMENT
This is emitted through the chart's supported `global.otelCollector.customConfig` merge seam — the
same overlay that carries the ingest pipelines — and a YAML **list** in it *replaces* the
supervisor's own list rather than appending to it. So `persistentQueue.extensions` must enumerate
every extension the collector needs (default: `['health_check', 'file_storage/hyperdx']`) and
`persistentQueue.exporterNames` must name exporters the OpAMP supervisor actually defines (default:
`['clickhouse']`). Both are options precisely because the correct values depend on the ClickStack
version you deploy — inspect the rendered collector config before relying on this in production.

An exporter name the agent does not define **cannot be rejected at build time**: the exporter set
lives in the remote configuration the supervisor hands the agent, not in anything TypeKro renders.
It fails silently at runtime — the `exporters` map grows an exporter no pipeline references while
the real one keeps its in-memory queue. Check the rendered config, or check the queue directory on
the claim: the `file_storage` extension names its bbolt database `exporter_<name>_<signal>` after
the component that opened it.
:::

::: tip LIVE-VERIFIED, AND IT USED TO BE BROKEN
The overlay's contributors are composed structurally and serialised once
(`utils/collector-config.ts`). They used to be YAML **strings** that were concatenated, and both
open a top-level `service:` key, so the rendered document declared `service` twice and the
supervisor rejected the whole file on every poll:

```
Could not merge local config file: /etc/otelcol-contrib/custom/custom.config.yaml
yaml: unmarshal errors: line 18: mapping key "service" already defined at line 1
```

The agent then ran with **neither** the ingest pipelines **nor** the queue, while the Pod reported
Ready — readiness comes from the supervisor's own `health_check`, not from the agent. Enabling the
queue was a silent no-op that also took OTLP ingestion down. The integration suite now asserts that
the rendered ConfigMap declares `service` exactly once, that the supervisor's log carries no merge
rejection, and that a bbolt database for each queued exporter exists on the claim.
:::

The gateway buffers in memory by default, so a ClickHouse restart — exactly what an S3-backed node
rebuild causes — drops in-flight telemetry. `persistentQueue: { enabled: true }` adds a
`file_storage` extension, points the exporter's `sending_queue` at it, and pins the volume backing
its directory.

That volume is a **standalone `PersistentVolumeClaim` owned by the composition**, mounted by
`claimName`. It is deliberately neither of the two shapes a chart can template for you: an
`emptyDir` is deleted with the Pod, and a *generic ephemeral volume*'s PVC is
[deleted along with the Pod that owns it](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/) —
so either would be destroyed by exactly the collector restart the queue exists to survive. There is
no ephemeral fallback and no "omit `size`" path: `size` defaults to `'10Gi'`.

#### The queue means exactly one gateway collector replica

There is no access-mode knob and no shared-volume escape hatch, because the volume was never the
binding constraint. The `file_storage` extension keeps the queue in a
[bbolt](https://github.com/etcd-io/bbolt) database, and bbolt takes an **exclusive file lock** for
the lifetime of the handle — the extension's own README states one collector instance per
directory, and
[collector-contrib#5894](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/5894)
is the report of the second instance hanging on that lock. A `ReadWriteMany` volume does not fix
that: it hands both replicas the *same* locked database, so it would only trade a `Multi-Attach`
failure for a blocked collector or a corrupt queue.

So a build-time `values['otel-collector'].replicaCount` above 1 is **rejected at construction**,
and the rendered chart values pin `replicaCount: 1`. The claim is always `ReadWriteOnce`, which
stops a second Pod on another node from even attaching.

```typescript
// throws: the queue is a bbolt database under an exclusive lock — one replica
makeClickstackBootstrap({
  storage: { mode: 's3', persistentQueue: { enabled: true } },
  values: { 'otel-collector': { replicaCount: 3 } },
});

// correct
makeClickstackBootstrap({
  storage: { mode: 's3', persistentQueue: { enabled: true } },
  values: { 'otel-collector': { replicaCount: 1 } },
});
```

#### …and a `Recreate` rollout, because one replica does not bound an upgrade

`replicaCount: 1` bounds the **steady state**. It says nothing about what happens *during* a
rollout, and a rollout is where the queue's single-writer rule actually bites.

The collector chart leaves the Deployment on Kubernetes' default `RollingUpdate`
(`rollout.strategy` in its `values.yaml`), whose default `maxSurge: 25%` rounds **up** to one extra
Pod. So changing anything in the pod template — a new chart version, an image tag, an annotation —
creates the replacement collector while the old one is still running and still holds both the claim
and the queue. That overlap fails in one of two ways, depending on where the replacement lands:

- **On another node — a stuck rollout.** The `ReadWriteOnce` claim is still attached to the old
  Pod's node, so the replacement never leaves `ContainerCreating`
  (`Multi-Attach error for volume`). `RollingUpdate` will not terminate the old Pod until the new
  one is Ready, and `maxUnavailable: 25%` of one replica rounds **down** to zero, so nothing gives:
  the rollout deadlocks until `progressDeadlineSeconds` expires.
- **On the same node — a silent two-writer window.** The replacement starts, and its `file_storage`
  extension cannot take bbolt's exclusive lock while the old collector holds it. Readiness does not
  notice, because it comes from the OpAMP supervisor's own `health_check` rather than from the
  agent's extensions — the same blind spot as the `custom-config` mount below — so the Pod reports
  Ready and the rollout "succeeds" over a queue the new collector could not open. Observed live on
  a single-node cluster: under `RollingUpdate` the replacement went Ready in under 10 seconds.

The single-replica pin does not prevent either; it is what makes the overlap harmful.

Whenever `persistentQueue` is enabled, TypeKro therefore also pins:

```yaml
otel-collector:
  enabled: true
  replicaCount: 1
  rollout:
    strategy: Recreate
```

`Recreate` removes the overlap entirely: the old collector is deleted, its claim detaches and its
lock is released, and only then is the replacement created. Nothing carries a `rollingUpdate` block
alongside it — the chart's Deployment template emits that only on the `RollingUpdate` branch, and
the API server rejects a `Recreate` strategy that has one.

`enabled: true` is pinned for the same reason the queue owns the other two keys: the queue *is* the
gateway collector's sending queue. A build-time `values: { 'otel-collector': { enabled: false } }`
alongside `persistentQueue.enabled: true` would otherwise render a HelmRelease with no collector
but with the queue's claim, its `file_storage` extension and `persistentQueue: true` in the status
contract — a queue nothing writes to. With no `persistentQueue`, a caller's `enabled: false` passes
through untouched.

**The cost is a brief gateway outage on every rollout**, and the persistent queue is precisely what
makes that cost acceptable: producers upstream of the gateway retry, and telemetry the gateway has
already accepted sits on the claim rather than in the departing Pod's memory, so the replacement
resumes draining the same queue instead of starting empty. Without a queue there would be nothing
to make the gap safe — which is why the pin is scoped to the queue. **With no `persistentQueue` the
gateway keeps the chart's `RollingUpdate` default** and stays available across a rollout.

Unlike `replicaCount`, a build-time `values['otel-collector'].rollout.strategy` is not rejected at
construction — it is simply **overridden**. The deadlock is a property of the queue, not a
trade-off the caller gets to take.

#### …and an `fsGroup`, because a block PVC mounts root-owned

A freshly provisioned **block** volume — the AWS EBS CSI default StorageClass, and most other block
provisioners — comes formatted with a `root:root` 0755 filesystem, and nothing in the chart chowns
the mount. The gateway collector image (`clickstack-otel-collector`, verified on 2.35.0) runs as its
`otel` user, uid/gid **10001**, so it cannot create its bbolt databases in the mounted directory and
the exporter refuses to start:

```
Error: cannot start pipelines: failed to start "clickhouse" exporter:
open /var/lib/otelcol/file_storage/exporter_clickhouse__logs: permission denied
```

That line is in the OpAMP supervisor's `agent.log` (`/etc/otel/supervisor-data/agent.log`), not in
the Pod log, which only says `Agent crashed during config application, reporting FAILED status` — so
the gateway `CrashLoopBackOff`, the HelmRelease install timing out and the k8s-telemetry collectors
with nowhere to ship all read like a config-merge problem when the merged config is perfectly valid.
(A hostPath-style class such as kind's `local-path` happens to mount world-writable, which is why
the symptom only appears once the queue meets a real block PVC.)

Kubernetes fixes exactly this with a Pod `securityContext.fsGroup`: the kubelet applies the group to
the volume on mount. And the chart exposes it: ClickStack 3.2.0's gateway is the stock
`opentelemetry-collector` 0.146.1 subchart under the alias `otel-collector`, whose `values.yaml`
declares `podSecurityContext: {}` and whose Deployment template renders it verbatim:

```yaml
# opentelemetry-collector 0.146.1, templates/deployment.yaml
securityContext: {{- toYaml .Values.podSecurityContext | nindent 2 }}
```

So whenever `persistentQueue` is enabled, TypeKro pins two keys on that value as part of the
mapper's [hard pins](#build-time-options-vs-runtime-spec):

```yaml
otel-collector:
  podSecurityContext:
    fsGroup: 10001
    fsGroupChangePolicy: OnRootMismatch
```

`fsGroupChangePolicy: OnRootMismatch` skips the recursive chown once the volume root already carries
the group, so restarts after the first do not walk a queue directory that can hold gigabytes of bbolt
pages. The group is `persistentQueue.fsGroup` (default `10001`; any non-negative integer — `0` is the
root group, which Kubernetes allows) — override it when running a collector image whose user has a
different primary group:

```typescript
makeClickstackBootstrap({
  storage: { mode: 's3', persistentQueue: { enabled: true, fsGroup: 2000 } },
});
```

The pins are merged **last** and **recursively**, so a build-time `values['otel-collector'].podSecurityContext`
(or a direct-mode `customValues` one) can still add unrelated fields — `runAsNonRoot`,
`seccompProfile` — while `fsGroup` and `fsGroupChangePolicy` stay TypeKro's. With no
`persistentQueue` the block is not rendered and the collector Pod keeps whatever `podSecurityContext`
you pass through, or the chart's empty default.

::: details Why a value and not a post-renderer
An earlier release carried this as a Flux `postRenderers` Kustomize patch on the rendered
`<release>-otel-collector` Deployment, on the premise that the collector template had no
security-context hook. That premise was wrong — only the *parent* chart's own templates lack one —
and the patch had a failure mode of its own: the subchart names the Deployment
`printf "%s-%s" .Release.Name "otel-collector" | trunc 63 | trimSuffix "-"`, so for a release name
past 48 characters the chart truncated the name, the patch matched nothing, and the collector hit the
same `permission denied`. A value under the subchart alias never names the Deployment, so it cannot
miss. Build-time `postRenderers` you pass to `makeClickstackBootstrap` are still threaded through to
the HelmRelease unchanged — the composition just no longer appends any of its own.
:::

#### Batching inside the queue

The ClickStack collector batches in its `batch` processor, which runs **ahead of** the exporter's
queue. The image's default timeout is 5s (`HYPERDX_OTEL_BATCH_TIMEOUT`). Data waiting in the
processor has already been acknowledged to the sender, but it is not on disk yet, so a collector
crash loses up to one timeout of it. On an S3-backed ClickHouse you want long batches, because each
insert costs object-store PUTs. With the processor doing the batching, a 60s batch means a 60s loss
window.

`persistentQueue.batch` moves the long wait into the persistent queue:

```typescript
makeClickstackBootstrap({
  storage: {
    mode: 's3',
    persistentQueue: {
      enabled: true,
      batch: { flushTimeout: '30s', minSize: 50_000 },
    },
  },
});
```

TypeKro renders the batch into every queued exporter's `sending_queue` and lowers the processor's
timeout to `processorTimeout`:

```yaml
processors:
  batch:
    timeout: 200ms
exporters:
  clickhouse:
    sending_queue:
      enabled: true
      storage: file_storage/hyperdx
      batch: {flush_timeout: 30s, min_size: 50000, sizer: items}
```

| Option | Default | Range |
| --- | --- | --- |
| `flushTimeout` | required | `1s`–`10m` (`ms`, `s` or `m`) |
| `minSize` | `8192` | positive integer, in units of `sizer` |
| `maxSize` | unset (no split) | positive integer, at least `minSize` |
| `sizer` | `'items'` | `'items'` or `'bytes'` |
| `processorTimeout` | `'200ms'` | `10ms`–`5s`, shorter than `flushTimeout` |

**Crash safety.** This was checked against the exporter helper in collector v0.155.0, the version
`clickstack-otel-collector` 2.35.0 is built from. The queue writes each request to the
`file_storage` database before accepting it. The batcher reads requests from there, and the queue
deletes a request only after the batch holding it has been exported. On restart, requests that
were read but not exported go back on the queue. Delivery is at-least-once: a crash after ClickHouse
accepted a batch, but before the queue deleted it, sends that batch again. The `file_storage`
extension does not fsync by default. That is safe against a collector or Pod crash, but not against
losing the node.

**The trade-offs:**

- **The processor timeout is collector-wide.** Pipelines whose exporter is not in `exporterNames`,
  such as session replay's `clickhouse/rrweb`, now get 200ms batches instead of 5s. Add them to
  `exporterNames` to batch them in the queue too.
- **The queue holds the batch.** A request keeps its queue slot until its batch is exported. While
  data flows, the processor sends a request every `processorTimeout`, so one batch holds about
  `flushTimeout / processorTimeout` requests. TypeKro refuses a batch that could take more than half
  of the queue, so the other half stays free for a backlog while ClickHouse is down. A full queue
  refuses new data. With the default `queueSize` (1000, the collector's default) and the default
  `processorTimeout`, `flushTimeout` can be up to 100s. For longer batches, raise
  `persistentQueue.queueSize` (rendered as `sending_queue.queue_size`) or `processorTimeout`.
- **The batch is also held in memory** while it fills. Set `maxSize` to cap it under heavy load.

#### Release-name length

The runtime `name` is a Kubernetes DNS label — lowercase alphanumerics and `-`, starting and ending
with an alphanumeric (`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`, the same pattern the Traefik bootstrap
uses) — because every object derived from it is one. It is bounded at **37 characters**, and the
bound is *derived*, not written down:
`CLICKSTACK_GENERATED_NAMES` lists every object name the bootstrap (or its chart, or a controller
downstream) derives from `name` together with the limit each has to satisfy, and
`CLICKSTACK_NAME_LIMIT` is the minimum — the same `deriveNameLengthLimit` the Traefik bootstrap uses.
Two of those names would otherwise fail late and quietly:

- `<name>-team-bootstrap` (and `<name>-otel-retention`) are CronJobs, and Kubernetes refuses a
  CronJob name longer than **52** characters at create time so the `-<scheduled-time>` Jobs it spawns
  fit a 63-character label. This is the binding constraint: 52 − 15 = 37.
- `<name>-otel-collector` is the gateway Deployment and Service, which the chart **truncates** at 63
  characters. The status contract's `gateway.otlpHttpEndpoint`/`otlpGrpcEndpoint` assume the literal
  name, so past 48 characters they would point at a Service that does not exist. Every name the
  schema accepts renders the literal untruncated.

The pattern and the bound are a plain `pattern` and `maxLength` on the ArkType schema, so the KRO
RGD carries `name: string | maxLength=37 pattern="…"` and the API server refuses a malformed or
over-long instance; direct-mode `deploy` rejects it through the same schema, and direct-mode
`toYaml` runs the same schema on a concrete `name` and refuses it with the same message — for the
length, the message names the constraint that produced the number:

```
at most 37 characters, because the Team-bootstrap CronJob `<name>-team-bootstrap` (…) is limited to
52 characters and reserves 15 of them
```

::: info Future path: per-replica queues
Running several collectors each with their **own** queue is a real design, and a different one: it
needs the upstream chart's `mode: statefulset` with `volumeClaimTemplates`, so every replica gets a
private directory. This composition renders the gateway as the chart's default Deployment mounting
one standalone claim, so that shape is not modelled today — the construction error names it rather
than leaving a shared-volume option that cannot deliver it.
:::

The HelmRelease depends on the claim, so it exists before the collector's first Pod. The claim is
treated as ready while `Pending`, because a `WaitForFirstConsumer` StorageClass (the common default)
does not bind a claim until a Pod mounts it — and that Pod comes from the HelmRelease waiting on it.

::: warning The queue values re-emit the chart's own `custom-config` volume
Helm **replaces** a list-valued override rather than appending to it, and the chart mounts the
ConfigMap it renders from `global.otelCollector.customConfig` through the same
`extraVolumes` / `extraVolumeMounts` the queue needs — its `values.yaml` carries the warning itself:

> if you override extraVolumes/extraVolumeMounts yourself, Helm replaces these lists entirely

Verified live what happens otherwise: the queue volume evicts the custom-config mount, the OpAMP
supervisor logs `Could not read local config file: open
/etc/otelcol-contrib/custom/custom.config.yaml: no such file or directory` on every poll, and the
agent starts **without** the overlay — losing both the ingest pipelines and the queue's own
`file_storage` wiring, while the Pod still reports Ready (readiness comes from the *supervisor's*
health_check, not the agent's). TypeKro therefore re-emits the chart's entry alongside the queue's,
and both a unit test and the integration suite assert the two mounts coexist.
:::

## Status Contract

Beyond `ready`/`phase` (KRO CEL from the owned HelmRelease and Team-bootstrap CronJob), the status
exposes typed connection details so downstream compositions never reconstruct chart naming rules:

```typescript
status: {
  ready: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  ui: { url: string };
  gateway: { otlpHttpEndpoint: string; otlpGrpcEndpoint: string };
  app: { host: string; appPort: number; apiPort: number };
}
```

**Where each field lives on the KRO CR.** The connection contract is anchored on the **owned
HelmRelease resource**, so it serializes as KRO status CEL and is visible on the live KRO CR's
status (GitOps/KRO consumers can read it):

- `ready`, `phase` — generation-aware CEL over `clickstackHelmRelease.status.conditions`, combined
  with the authoritative Team-bootstrap CronJob's current schedule and last successful execution.
  `ready` becomes true only after Flux has observed the current HelmRelease generation **and** the
  current credential bootstrap has completed successfully; `phase` remains `Installing` until both
  gates pass and becomes `Failed` on a current-generation Helm failure.
- `ui.url`, `gateway.otlpHttpEndpoint`, `gateway.otlpGrpcEndpoint`, `app.host` — CEL string concat
  over `clickstackHelmRelease.metadata.name` / `.namespace` (the mapper pins `fullnameOverride` to
  the release name, so the HyperDX Service is `<name>` and the gateway Service is
  `<name>-otel-collector` — a literal that holds because the schema
  [bounds `name`](#release-name-length) below the chart's 63-character truncation), with the
  chart-default ports embedded in the URL strings.

The remaining fields — `app.appPort` (3000), `app.apiPort` (8000), the spec-derived `version`, and
the whole `storage` block (`mode`, `diskType`, `policyName`, `retention`, `persistentQueue` —
sitting next to `gateway.otlpHttpEndpoint` so one read answers both "where do I send telemetry" and
"what happens to it") — are **construction-time values**. KRO status CEL cannot express a
literal-only leaf (nor reference `schema.spec.*`), so emitting them as literals meant the declared
schema promised fields the live CR never carried. They are instead written into a ConfigMap the
composition **owns** (`<release>-contract`, resource id `clickstackContract`) and projected back
from it:

- `version` — `clickstackContract.data.version`, the resolved chart version. A resource field *may*
  reference `schema.spec.*`, so KRO substitutes `spec.version` when it creates the ConfigMap and the
  status reads the concrete value back off a resource.
- `app.appPort` / `app.apiPort` — `int(clickstackContract.data.appPort)` / `.apiPort`; ConfigMap
  values are strings, so the CEL `int(...)` conversion restores the declared numbers.
- `storage.mode` / `diskType` / `policyName` / `retention.*` — `clickstackContract.data.storage*`.
- `storage.persistentQueue` — `clickstackContract.data.storagePersistentQueue == "true"`.

Every declared status leaf is therefore a resource projection, and
`kubectl get clickstackbootstraps -o yaml` shows the whole contract in both factory modes. See
[typekro#188](https://github.com/yehudacohen/typekro/issues/188) for the underlying framework gap (a
literal status leaf is accepted at build time and then silently dropped by KRO).

## Kubernetes Telemetry

`clickstackK8sTelemetry` implements the
[documented ingestion pattern](https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/kubernetes):
TWO instances of the **stock** `opentelemetry-collector` chart — a daemonset (presets:
`logsCollection`, `hostMetrics`, `kubeletMetrics`, `kubernetesAttributes`) and a deployment (presets:
`kubernetesEvents`, `clusterMetrics`) — both exporting `otlphttp` to the ClickStack gateway. The
HyperDX API key is wired via `secretKeyRef` + OTel `${env:…}` expansion, so the key value never lands
in Helm values.

Its aggregate status waits for both collector releases and distinguishes a definite Flux failure
from an in-progress install:

```typescript
status: {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
}
```

`ready` is true only when both releases report `Ready=True`; `failed` is true when either reports
`Ready=False`.
