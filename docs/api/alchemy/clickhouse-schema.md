# ClickHouseSchema

`ClickHouseSchema` is an [Alchemy](/advanced/alchemy-integration) v2 resource that applies
ClickHouse DDL — databases, `S3Queue` tables, materialized views, application tables — to a
cluster the `clickhouse` / `clickstack` factories deployed, at converge time, with state.

It fills the gap between the two things TypeKro could already do: the factories create a
ClickHouse *server*, and `clickStackStorage`'s retention CronJob runs DDL *from inside the
cluster on a timer*. Neither one owns a deployment's own schema. `ClickHouseSchema` does:
it runs once per converge, it is diffable (an unchanged schema issues no statements at all),
a failure fails the deploy instead of appearing in a Job log, and — because it is an Alchemy
resource — it can be ordered after the instance's readiness like any other dependency.

```typescript
import { clickHouseSchema, clickHouseSchemaProvider } from 'typekro/alchemy';
```

## Quick start

```typescript
const schema = yield* clickHouseSchema('orders-schema', {
  target: {
    namespace: 'example-observability',
    podSelector: { 'clickhouse.altinity.com/chi': 'orders' },
  },
  statements: [
    'CREATE DATABASE IF NOT EXISTS orders',
    `CREATE TABLE IF NOT EXISTS orders.events (
       id UUID, at DateTime, payload String
     ) ENGINE = MergeTree ORDER BY at`,
  ],
});
```

Merge `clickHouseSchemaProvider` into your Alchemy runtime's providers, the same way you merge
`kroProvider`.

## The idempotence contract

**Every statement must be safe to execute against a database where it has already been
executed.** TypeKro does not parse SQL and cannot check this for you. Write:

| Instead of | Write |
| --- | --- |
| `CREATE DATABASE orders` | `CREATE DATABASE IF NOT EXISTS orders` |
| `CREATE TABLE orders.events (…)` | `CREATE TABLE IF NOT EXISTS orders.events (…)` |
| `CREATE MATERIALIZED VIEW orders.mv …` | `CREATE MATERIALIZED VIEW IF NOT EXISTS orders.mv …` (or `CREATE OR REPLACE VIEW`) |
| `ALTER TABLE orders.events ADD COLUMN c String` | `ALTER TABLE orders.events ADD COLUMN IF NOT EXISTS c String` |
| `DROP TABLE orders.events` | `DROP TABLE IF EXISTS orders.events` |

Why it matters: when the fingerprint changes, **the whole ordered list is re-run** — not just
the statements you added. A non-idempotent statement therefore works on the first converge and
fails on the second.

The same property is what makes a failed converge recoverable. The fingerprint is recorded only
after the last statement succeeds, so a run that dies at statement 7 re-runs statements 0–6 on
the next converge.

## Lifecycle

| Phase | Behaviour |
| --- | --- |
| **create** | Wait for the server pods matching `target.podSelector` to be Ready — *all* of them under `fanout`, *one* under `onCluster` — then run every statement in array order against each pod the execution model selects, re-listing and reconciling under `fanout` until the [exit predicate](#the-exit-predicate) holds — a non-empty, fully applied, stable set. Record `fingerprint`, `appliedAt`, `statementCount`, `database`, `target`, `pods`, `podNames`, `clusterId`. |
| **update** | If the fingerprint, the target, the cluster identity *and* (under `fanout`) the live pod set are unchanged, do nothing. Otherwise re-run every statement and record the new state. |
| **delete** | Per `onDelete` (see below). |

The fingerprint is a sha256 over the ordered `statements`, the `settings`, the resolved `client`
configuration and the `execution` model. Three things are compared *outside* the fingerprint,
because they describe *where* the DDL landed rather than *what* it was:

- **the target** — re-pointing the resource at another namespace, selector or container
  re-applies the DDL there even though the statements are byte-identical;
- **the cluster identity** — see [Cluster identity](#cluster-identity);
- **the pod set**, under `fanout` — see [Execution model](#execution-model).

## Execution model

**ClickHouse DDL is server-local by default.** `CREATE TABLE …` executed on one pod creates that
table on that pod and nowhere else. On a multi-replica or multi-shard deployment, a converge
that touches a single pod would report success while the rest of the cluster has no schema — and
would then never try again, because the fingerprint says the work is done.

Two mechanisms make DDL cluster-wide, and `execution` requires you to pick one. See ClickHouse's
[Distributed DDL](https://clickhouse.com/docs/sql-reference/distributed-ddl) reference.

### `{ mode: 'fanout' }` — the default

```typescript
execution: { mode: 'fanout' }   // default; may be omitted
```

TypeKro runs the ordered statement list against **every server pod** matching the selector, one
pod after another, each pod receiving the list in statement order. It needs nothing from the
cluster — no Keeper, no `Replicated` database engine — and leans on exactly the idempotence the
statements already promise.

#### It is all or nothing

`fanout` **never applies to a strict subset.** The whole matching set is enumerated first, and
every pod in it must become Ready before a single statement is executed:

- **matching** means the selector matched it and it is not on its way out: pods with a
  `metadata.deletionTimestamp`, and pods in a terminal phase (`Succeeded`/`Failed`), are excluded
  — they can never be Ready again, so waiting for them would only burn the budget;
- every other matching pod — Ready, `Pending`, running-but-not-Ready — must reach Ready within
  `waitForPod.timeoutMs`, or the converge **fails**, naming the pods and their phases;
- a matching pod without `target.container` fails the converge **immediately**, naming it: no
  amount of waiting adds a container to a running pod.

This is what a **StatefulSet mid-rollout** hits: one Ready replica and two `Pending` ones make
the resource *wait*, and then *fail* if the rollout does not finish in time — rather than record
a fingerprinted, apparently cluster-wide apply that only ever reached one server and is never
retried. Failing is the recoverable outcome: the fingerprint is written only on success, so the
next converge applies the full list to the full set.

On a large cluster where some replica is almost always rolling, **`onCluster` is the right
mode** — it hands the DDL to Keeper and needs exactly one Ready server.

A selector that also matches non-server pods therefore *fails* a `fanout` converge instead of
quietly skipping them. Narrow the selector.

#### The recorded pod set

The pod set is recorded in `pods` as `{ name, uid }` pairs, and an otherwise-unchanged converge
compares the live set against it. That check costs one `list pods` call and no exec, so an
unchanged schema on an unchanged topology is still free.

**The UID is the identity, not the name.** A StatefulSet replica that is deleted and recreated —
a node drain, a CHI template change, a `kubectl delete pod` — comes back as `chi-orders-0-0-0`
again, with a fresh empty disk and no schema. A recorded set of *names* cannot tell that apart
from the pod that was there before, so the advertised replacement detection could not see it.
`metadata.uid` can: it identifies the pod **object**, and is never reused. Precisely:

| What changed | Re-applies? | Why |
| --- | --- | --- |
| A pod was added (scale-out) | yes | the new replica has no schema |
| A pod was removed | yes | the recorded set no longer matches what is live |
| Same name, **new UID** | yes | a different pod object — a replacement, with a new disk |
| Same name, **same UID** | no | the pod object survived, so its PersistentVolume did (and the schema with it), or the `Replicated`/`ON CLUSTER` metadata in Keeper did. A container restart is not a reason to re-run the whole ordered list. |

`podNames` is kept alongside, carrying the same pods in the same order, for compatibility and for
reading state at a glance. State written before UIDs were recorded has no `pods` field at all;
the comparison falls back to names for it, and the first converge that applies rewrites state in
the new shape.

#### Reconciling until the set is covered

A replica can be added, replaced or removed **while the statements are running**, so the set that
is live when the run finishes is not necessarily the set that was applied to.

Recording the live set would be wrong — it claims coverage of a pod nothing ran on, and the claim
is never revisited because it makes the two sets agree. Recording only what was reached and
*warning* about the difference is not enough either: Alchemy commits that state without another
reconcile, so the newly observed pod stays unapplied until some future deployment happens to
change the fingerprint. So the apply **keeps reconciling**:

1. select the complete Ready set (the all-or-nothing rules above);
2. apply the whole ordered list to every pod not yet applied to **in this run** — a pod an
   earlier pass already covered is not re-run;
3. re-list. Pods that appeared are uncovered and get another pass; pods that **disappeared** are
   dropped from the recorded set, since state describes coverage of pods that exist;
4. repeat until the exit predicate below holds.

##### The exit predicate

A `fanout` apply may record a pod set **only** when the last re-list observed all three of:

1. a **non-empty** set;
2. every pod in it **applied to by this run**, compared by name **and** UID;
3. the **same set as the observation before it** — the selection's own list and the re-list are
   those two observations.

Each part rules out a specific way of committing a lie. Without (1), "no pod is uncovered" is
vacuously true of the empty set, so a run whose only pod disappeared between the exec and the
re-list would record `pods: []` as a success — and during a **single-replica StatefulSet
replacement** that empty window sits exactly between the old pod going away and its *same-named*
successor arriving, leaving the successor (a new pod object, with an empty disk) unapplied behind
a fingerprint that says the work is done. Without (2), coverage would be claimed for a pod nothing
ran on. Without (3), a single snapshot cannot tell a settled set from one still moving: a pod that
vanished mid-pass leaves every *remaining* pod covered while the set itself is mid-change.

An empty set is therefore never convergence. It is waited out on the **same** `waitForPod` budget
as the readiness wait — re-listing until a non-terminating matching pod is present and Ready, then
applying to it and re-verifying.

A settled cluster still costs exactly **one pass**: one `list pods`, the statements, one re-list —
those two lists are the two consecutive observations part (3) asks for.

Two bounds stop a genuinely churning cluster from looping forever — `maxReconcilePasses`
(default **3**) and the overall `waitForPod.timeoutMs`, which is spent **across** the passes
rather than renewed by each one. Hitting either before the predicate holds **fails** the converge,
naming which part of it the observation failed:

```
ClickHouseSchema 'orders-schema': execution.mode 'fanout' applies the statements to EVERY pod
matching clickhouse.altinity.com/chi=orders in namespace 'example-observability', but the pod
set kept changing: after 3 reconcile pass(es), 1 pod(s) had still not been applied to
(chi-orders-0-3-0). Nothing is recorded, so the next converge re-applies the whole list. Let
the rollout settle, raise maxReconcilePasses, or switch to execution.mode 'onCluster'.
```

The empty case names the race it is, rather than the "no pod matched the selector" of a selector
that never matched anything:

```
... but after 120000ms the matching set became empty after 1 pod(s) were applied; a same-named
successor would be unapplied. Let the rollout finish, raise waitForPod.timeoutMs, or switch to
execution.mode 'onCluster'.
```

**It never returns success with an uncovered pod, and never records an empty set.** Failing is the
recoverable outcome: no state is committed, so the next converge starts over and applies the whole
list to the whole set. A recorded partial apply would never be retried at all.

`maxReconcilePasses` is deliberately **not** part of the fingerprint — like `waitForPod`, `retry`
and `statementTimeoutMs`, it says how the apply is driven, not what is applied, so changing it
does not re-run DDL. It is ignored under `onCluster`, which has no coverage to reconcile: one
execution hands the DDL to Keeper's queue, which reaches pods this converge never looked at,
including ones that appear later.

**A single-replica installation is a one-pod fanout**, which is why the default is also the
correct setting there — you do not need to configure anything for the common case.

### `{ mode: 'onCluster', cluster: '<clusterName>' }`

```typescript
execution: { mode: 'onCluster', cluster: 'cluster' },
statements: [
  "CREATE DATABASE IF NOT EXISTS orders ON CLUSTER 'cluster'",
  `CREATE TABLE IF NOT EXISTS orders.events ON CLUSTER 'cluster' (id UUID, at DateTime)
   ENGINE = ReplicatedMergeTree ORDER BY at`,
],
settings: { distributed_ddl_task_timeout: 300 },
```

The statements distribute themselves through Keeper's DDL queue, so TypeKro runs them **once**,
on the first Ready pod.

That is only true if each statement actually says so, so **every statement is validated at
declaration time** and a statement that cannot keep the promise is rejected, naming its index:

```
Invalid ClickHouseSchema configuration for 'orders-schema': … must be cluster-wide under
execution.mode 'onCluster' (statements 1 carries no 'ON CLUSTER cluster' clause, which is
the only thing that makes a single execution reach every server; add the clause, or use
execution.mode 'fanout')
```

**Every statement must carry `ON CLUSTER <cluster>`, naming exactly the configured cluster.**
That is the only accepted proof. Keyword matching is case-insensitive and the name may be bare,
backtick-, double- or single-quoted; a clause that only appears inside a string literal does not
count, because the check runs on a ClickHouse-aware lexer rather than a regex.

Nothing is **inferred** from a statement's shape. The alternative — accepting a clause-free
statement whose references all live in databases you declare `Replicated` — keys on the
*references* rather than on the *DDL target*, and so waves through

```sql
CREATE TABLE events AS analytics.source   -- `events` is created LOCALLY
```

Getting that right means parsing the target of every DDL form ClickHouse accepts, and a parser
that is subtly wrong here half-applies a schema in silence. So the rule is the explicit one.

### Statements that cannot take `ON CLUSTER`

`SET`, `USE`, a single-node `SYSTEM …`, `INSERT` — these have no cluster-wide form, so they do
not belong under `onCluster` and are rejected there (`USE` and `SET` by name, the rest for
carrying no clause). **`fanout` is where they go**: it runs the ordered list on every server
itself, so reaching every server is a property of the mode rather than a promise the statement
has to make. Whether running them on every server is what you meant is then yours to decide.

**TypeKro never rewrites your SQL.** Adding `ON CLUSTER` on your behalf would change the
semantics of DDL TypeKro did not write, and getting that wrong on a production cluster is not
recoverable. Validation refuses; it does not repair.

## Cluster identity

`namespace`, `podSelector` and `container` are just strings — `telemetry` + `chi=orders` names a
pod in staging exactly as well as it names one in production. Without more, pointing the same
resource at a second cluster would match the recorded target, match the fingerprint, and silently
apply nothing there.

So the state also records a **credential-free identity of the cluster the statements reached**:

```
sha256(current-context cluster name | server URL | caData | caFile | skipTLSVerify)
```

— the same derivation the per-cluster API-capability probe cache keys on (`clusterIdentity`,
reused rather than re-derived, so the two cannot disagree about what "the same cluster" means).
No token, certificate or key material contributes to it. It is surfaced as the `clusterId`
output, and a change to it re-applies the DDL on the new cluster.

`clusterId` is `undefined` when the kubeconfig names no current cluster, or when you injected an
`executor` and supplied no `kubeConfig` to identify.

### `onDelete`

```typescript
onDelete: 'retain'   // default
```

`retain` is the default because **a schema resource must never drop data because a stack was
torn down**. It does not reach the cluster at all on delete; Alchemy simply drops the state
entry, and every database, table and row stays exactly as it was.

```typescript
yield* clickHouseSchema('orders-schema', {
  target: { namespace: 'example-observability', podSelector: { 'clickhouse.altinity.com/chi': 'orders' } },
  statements: ['CREATE DATABASE IF NOT EXISTS orders', /* … */],
  onDelete: 'run',
  deleteStatements: [
    'DROP TABLE IF EXISTS orders.events',
    'DROP DATABASE IF EXISTS orders',
  ],
});
```

`run` executes `deleteStatements`, in order, and nothing else — the destructive teardown has to
be spelled out. `onDelete: 'run'` without a non-empty `deleteStatements` is rejected at
declaration time, and so is `deleteStatements` under the `retain` default: statements that could
never run are a silent footgun.

`run` is also **bound to the recorded cluster**. Before a single pod is listed or statement sent,
the delete compares the state's `clusterId` against the identity of the cluster the current
transport reaches, and refuses with a `ClickHouseSchemaError` (`Refusing destructive schema
teardown …`) if they differ — including when the current identity is unknown because an
`executor` was injected without a `kubeConfig`. With the ambient kubeconfig the transport is
whatever `KUBECONFIG` names *at destroy time*, and `namespace` + `podSelector` match pods on any
cluster, so without this check a stale context could drop tables on the wrong cluster. State that
recorded no `clusterId` has nothing to compare against and is torn down as before.

`run` also refuses when there is **no persisted state at all** — no successful apply ever
completed for the resource, as after a create that failed part-way through its `statements`.
Nothing then identifies the cluster the partial DDL landed on, so the delete throws the same
`ClickHouseSchemaError` (`… no persisted successful apply state …`) before any transport is built.
Drop the state entry, or run the `deleteStatements` by hand against the cluster you intend.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `target.namespace` | `string` | Namespace holding the server pods. |
| `target.podSelector` | `Record<string, string>` | Label selector. Which matching pods are used is the [execution model](#execution-model)'s business — under `fanout`, *all* of them. Validated as real label keys/values. |
| `target.container` | `string?` | Defaults to `clickhouse`, the Altinity CHI server container. |
| `client.user` | `string?` | Defaults to `default`. |
| `client.passwordEnv` | `string?` | Name of the env var **inside the container** holding the password. Defaults to `CLICKHOUSE_PASSWORD`. |
| `client.database` | `string?` | Defaults to `default`. |
| `client.port` | `number?` | Native protocol port. Defaults to `9000`. |
| `statements` | `string[]` | Ordered, non-empty. Each must be idempotent. |
| `execution` | `{ mode: 'fanout' } \| { mode: 'onCluster', cluster: string }?` | How the DDL reaches every server. Defaults to `{ mode: 'fanout' }`. See [Execution model](#execution-model). |
| `settings` | `Record<string, string \| number>?` | Rendered as `--<setting>=<value>`. Names and values are validated as identifiers/scalars. |
| `onDelete` | `'retain' \| 'run'` | Defaults to `retain`. |
| `deleteStatements` | `string[]?` | Required — and only allowed — when `onDelete` is `'run'`. |
| `waitForPod.timeoutMs` | `number?` | Budget for the pods the execution model needs to become Ready — every matching pod under `fanout`, one under `onCluster`. Under `fanout` it also bounds the whole reconcile loop, spent across its passes. Defaults to 120000. |
| `maxReconcilePasses` | `number?` | `fanout` only: how many times an apply re-lists and applies to pods that appeared while it ran, before failing rather than recording a partial apply. Defaults to 3. See [Reconciling until the set is covered](#reconciling-until-the-set-is-covered). |
| `statementTimeoutMs` | `number?` | Per-statement exec timeout. Defaults to 300000. |
| `retry.maxAttempts` / `retry.backoffMs` | `number?` | Transport retries only. Defaults 3 / 1000ms. |
| `kubeConfig` | `SerializableKubeConfigOptions?` | Same shape `KroResource` accepts. Omit for the ambient kubeconfig. |
| `executor` | `ClickHouseExecutor?` | Runtime-only injection point (testing, embedding). Not serialized. |
| `readyBarrier` | `boolean?` | Alchemy ordering-only input. Pass an `Output` derived from the instance's handle to create the dependency edge; only the resolved scalar is persisted. |

Props are validated by an ArkType schema (`ClickHouseSchemaConfigSchema`) before they reach
Alchemy state, and the config types are inferred from it.

### There is no password prop

A plaintext credential is not representable: `client` **rejects undeclared keys**, so
`password: '…'` fails validation rather than being silently dropped. The password is read
inside the pod, from the container's own environment, as
`--password "${CLICKHOUSE_PASSWORD:-}"` under `sh -c` — so it never enters props, never reaches
Alchemy's state store, is never held by the process running the converge, and is never echoed.
(The value is a POSIX default expansion, so an unset variable means the empty password the stock
Altinity `default` user has.)

`clickhouse-client` also honours `CLICKHOUSE_PASSWORD` natively, but this resource does not
depend on that: passing `--password` explicitly behaves identically for a custom `passwordEnv`
and on images whose client build predates the native support. The default name matches what
every ClickHouse workload in TypeKro already sets — the ClickStack retention CronJob reads it,
and `clickHouseS3BackupCronJob` populates it from the credentials Secret.

## How statements reach the server

Statements are executed **one per `clickhouse-client` invocation**, each fed on **stdin**, over
the Kubernetes API server's `pods/exec` subresource.

- **Per statement, not one `--multiquery` batch.** A batch reports the first failure without
  saying which statement produced it, and error attribution by INDEX is the whole point of the
  `ClickHouseSchemaError` contract. The cost is one exec round trip per statement, which is
  negligible next to the DDL itself for the tens of statements a schema contains.
- **On stdin, not in `--query`.** SQL in argv is visible to anything reading `/proc` inside the
  pod and is echoed by exec audit logging.
- **Over `pods/exec`, not a connection.** A converge runs wherever your Alchemy runtime runs — a
  laptop, a CI runner — which generally has no network path to a ClickHouse pod. The
  alternatives are a port-forward (a tunnel that has to outlive every statement) or exposing the
  native port (a durable hole for a one-off migration). Exec needs neither: the statement travels
  over the same authenticated API-server connection everything else uses, and the client runs
  next to the server.

### RBAC

The identity running the converge needs, in the target namespace:

```yaml
rules:
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['list']
  - apiGroups: ['']
    resources: ['pods/exec']
    verbs: ['create']
```

## Errors

A failure raises `ClickHouseSchemaError` carrying the **resource's own id** (`resourceId` — the
name you gave *this* schema, so `orders-schema` and `billing-schema` are told apart), the
`statementIndex`, the pod it failed on and, when the server produced them, ClickHouse's
`clickHouseCode` and `clickHouseException`:

```
ClickHouseSchema 'orders-schema': statement 3 failed on pod chi-orders-0-1-0
with ClickHouse code 62 (DB::Exception) (exit 62).
```

### The redaction contract

**The failing statement's text is never on the error** — only its index. Statements should not
contain credentials (bind them through the server's own configuration, the way the S3 storage
compiler does), but a `CREATE TABLE … S3('https://…', 'AKIA…', 'wJalr…', 'CSV')` would, and
ClickHouse echoes the offending fragment back in its message — with nothing in the text saying
which positional argument is the secret.

So the contract is not "server output with credentials filtered out". It is: **keep what
identifies the failure, and treat every value the submitted statement contained as a secret.**

1. ClickHouse's error **code** and **exception class** are parsed out of the raw output first and
   carried separately. Neither can contain a credential, so redaction never costs you the part of
   the message that says what went wrong.
2. The **statement text** is replaced wherever the server echoed it back.
3. **Every literal the statement contains** — every single-quoted value, plus whatever follows
   `PASSWORD` / `IDENTIFIED BY` / `access_key_id` / `secret_access_key` / `aws_access_key_id` /
   `aws_secret_access_key` / `token` — is replaced with `<redacted>` wherever it appears. This is
   positional, so it catches the arguments keyword matching cannot name. Redacting a harmless
   literal costs a word of an error message; leaking the other kind costs the key.

   Each literal is redacted in **every spelling it could be echoed in**, longest first: the
   decoded value, the raw source slice between the quotes, and the value re-escaped both ways
   ClickHouse accepts. A credential containing a quote is one secret with three spellings —

   | | |
   | --- | --- |
   | decoded | `pa'ss` |
   | source, C-style | `pa\'ss` |
   | source, doubled | `pa''ss` |

   — and the server frequently quotes back the text it was *given* rather than the value it
   decoded, so redacting only the decoded form leaves the credential in the message. For a
   literal containing no quote, backslash or control character, which is nearly all of them, the
   three spellings are the same string and nothing changes.

   Decoded and re-escaped forms both come from **one escape table**, so the two are guaranteed to
   be views of the same string rather than independent guesses. It is ClickHouse's own, per
   [the string-literal syntax][ch-string]:

   | Escape | Decodes to | | Escape | Decodes to |
   | --- | --- | --- | --- | --- |
   | `\a` | alert (`0x07`) | | `\0` | null (`0x00`) |
   | `\b` | backspace (`0x08`) | | `\\` | `\` |
   | `\e` | escape (`0x1b`) | | `\'` (or `''`) | `'` |
   | `\f` | form feed (`0x0c`) | | `\"` | `"` |
   | `\n` | line feed (`0x0a`) | | `` \` `` | `` ` `` |
   | `\r` | carriage return (`0x0d`) | | `\/` | `/` |
   | `\t` | horizontal tab (`0x09`) | | `\=` | `=` |
   | `\v` | vertical tab (`0x0b`) | | `\xHH` | the byte `HH` (two hex digits) |
   | `\N` | nothing — reserved (`'a\Nb'` is `ab`) | | any other `\c` | `\c`, both characters |

   That last row is the rule that is easy to get wrong, and the documentation is explicit:
   *"The backslash loses its special meaning i.e. it is interpreted literally should it precede
   characters other than the ones listed below."* So `\z` is a backslash followed by a `z` —
   which is what lets `'Hello 100\%'` reach a `LIKE` pattern intact — while `\n` is a **newline**
   and not the letter `n`. A decoder that dropped every backslash would extract a credential
   containing a newline in a spelling the server never emits, leaving the real one in the message.

[ch-string]: https://clickhouse.com/docs/sql-reference/syntax#string
4. The **keyword line filter** (`password` / `secret` / `aws_secret` / `access_key` /
   `credential` / `token` → `[redacted]`) runs as a second layer, for text the statement did not
   account for.
5. The result is **capped at 2 KiB**, so a `DESCRIBE`-sized dump or a multi-megabyte parser trace
   cannot be carried into Alchemy state and every log line.

### Retries

Only **transport** failures are retried — a websocket error, a connection reset, an exec timeout.
A SQL error is never retried: re-issuing a statement the server actively rejected cannot help,
and for a statement that is not perfectly idempotent it can compound the damage.

## Full example: cluster → instance → schema

A `ClickHouseSchema` depends on the ClickHouse instance the same way any Alchemy resource
depends on another: through an `Output` derived from the instance's handle. That is what
`readyBarrier` is for — it is an ordering-only input, so Alchemy deploys the instance (and waits
for TypeKro's readiness evaluation on the `ClickHouseInstallation`) before the schema resource's
first exec, without copying the instance's outputs into the schema's state.

Statement order inside a `Stack` body is *not* a dependency edge on its own: Alchemy builds the
graph from Output references, not from the order in which you wrote the `yield*`s.

```typescript
import * as Alchemy from 'alchemy';
import * as Output from 'alchemy/Output';
import { Effect } from 'effect';
import { makeClickHouseCluster } from 'typekro/clickhouse';
import {
  clickHouseSchema,
  clickHouseSchemaProvider,
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from 'typekro/alchemy';

const NAMESPACE = 'example-observability';

const clickhouse = makeClickHouseCluster({ users: [{ name: 'writer' }] });
const factory = clickhouse.factory('kro', { namespace: NAMESPACE, waitForReady: true });

const declarations = await factory.toAlchemyResources({
  name: 'orders',
  namespace: NAMESPACE,
  version: '25.7',
  storage: { size: '100Gi' },
});

const stack = Alchemy.Stack(
  'orders-telemetry',
  { providers: [kroProvider, clickHouseSchemaProvider], state },
  Effect.gen(function* () {
    // 1. The ClickHouse instance (RGD + CR instance), deployed and Ready.
    const handles = yield* materializeAlchemyResources(KroResource, declarations);

    // 2. The schema, ordered after it. `readyBarrier` is the dependency edge: deriving it
    //    from the instance handles' Outputs is what makes Alchemy deploy them — and wait
    //    for TypeKro's readiness evaluation on the ClickHouseInstallation — first. Only
    //    the resolved `true` is persisted, so no unrelated output leaks into this state.
    return yield* clickHouseSchema('orders-schema', {
      readyBarrier: Output.map(
        Output.all(...Object.values(handles).map((handle) => Output.of(handle))),
        () => true
      ),
      target: {
        namespace: NAMESPACE,
        podSelector: { 'clickhouse.altinity.com/chi': 'orders' },
      },
      client: { user: 'writer', database: 'orders' },
      statements: [
        'CREATE DATABASE IF NOT EXISTS orders',

        // Application table.
        `CREATE TABLE IF NOT EXISTS orders.events (
           id UUID, at DateTime, customer String, amount Decimal(18, 2)
         ) ENGINE = MergeTree
         PARTITION BY toYYYYMM(at)
         ORDER BY (customer, at)
         TTL at + INTERVAL 90 DAY DELETE`,

        // Continuous ingest from an external bucket. The credentials come from the server's
        // own `<s3>` configuration section (matched by endpoint prefix), so the statement
        // itself carries none — which is exactly how it should be written.
        `CREATE TABLE IF NOT EXISTS orders.events_queue (
           id UUID, at DateTime, customer String, amount Decimal(18, 2)
         ) ENGINE = S3Queue('https://storage.example.com/telemetry/orders/*.json.gz', 'JSONEachRow', 'gzip')
         SETTINGS mode = 'ordered', keeper_path = '/clickhouse/s3queue/orders-events'`,

        // Materialized view moving rows from the queue into the table.
        `CREATE MATERIALIZED VIEW IF NOT EXISTS orders.events_mv
         TO orders.events
         AS SELECT id, at, customer, amount FROM orders.events_queue`,
      ],
      settings: { distributed_ddl_task_timeout: 300 },
      // Default. Destroying this stack leaves the data alone.
      onDelete: 'retain',
    });
  })
);
```

::: warning S3Queue and `ON CLUSTER`
`S3Queue` coordinates its ordered mode through Keeper, and a multi-replica topology needs the
table created on every replica. Under the `fanout` default TypeKro creates it on each server for
you. If you prefer Keeper to distribute the DDL instead, set
`execution: { mode: 'onCluster', cluster: '<clusterName>' }`, write every statement with
`ON CLUSTER '<clusterName>'` — the resource validates this and refuses rather than adding the
clause for you — and raise `settings.distributed_ddl_task_timeout` accordingly.
:::

## Outputs

```typescript
{
  fingerprint: string;    // sha256 over statements + settings + client + execution
  appliedAt: string;      // ISO-8601
  statementCount: number;
  database: string;
  target: { namespace: string; podSelector: Record<string, string>; container?: string };
  podNames: string[];     // sorted names, kept for compatibility; same pods as `pods`
  pods?: { name: string; uid?: string }[];  // sorted; the identity the pod-set check compares
  clusterId?: string;     // credential-free identity of the cluster it reached
}
```

## See also

- [Alchemy Integration](/advanced/alchemy-integration) — the `KroResource` / `kroProvider` model
- [ClickHouse](/api/clickhouse/) — `makeClickHouseCluster` and the storage topologies
- [ClickStack](/api/clickstack/) — the in-cluster retention CronJob, for DDL over tables TypeKro
  does not own
