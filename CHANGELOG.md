# Changelog

All notable changes to TypeKro will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`teamName` and `teamDefaults` build options on `makeClickstackBootstrap`.** `teamName` names the
  HyperDX Team (default `ClickStack`, at most 100 characters). With `initialUser` it renames HyperDX's
  registered Team only when set. `teamDefaults` controls the one-time seed of an empty Team's
  connection and sources. It is on by default with inline credentials and off by default with
  `secretValues`, where `true` (or an options object) opts in. `{ allowUnvalidatedChartVersion: true }`
  lifts its chart-version guard. See "Team name and default sources" in the ClickStack docs.

- **OpenID Connect sign-in for HyperDX:** the `hyperdxOidc` option on `makeClickstackBootstrap` (#241).
  HyperDX's open-source build has only email-and-password login. TypeKro now ships a small plugin
  (`plugins/hyperdx-oidc/`, bundled into the library) that joins HyperDX's own Passport and session path, so
  no image fork is needed. It is shipped as a ConfigMap, loaded with `NODE_OPTIONS=--require`, and active
  only in the API process. It registers one Passport strategy per provider and adds the
  `/api/login/oidc/...` routes. Every login ends in `req.logIn()`, which gives an ordinary HyperDX session.
  - Authorization-code flow with PKCE via a bundled `oauth4webapi`, with multiple providers and per-provider
    claim names.
  - Access rules on groups and email domains, and verified email required by default.
  - Accounts are linked by (provider, `sub`). An existing user is linked by email only if no provider has
    claimed it yet (e.g. the break-glass `initialUser`), and emails must be ASCII. Otherwise new users are
    created just-in-time. A linked user whom the provider stops admitting has their API access key rotated.
  - With `initialUser`, a first OIDC login never creates HyperDX's team. With `passwordLogin: false`, the
    only first-run registration let through is the `initialUser`'s own: the plugin gets its email, and the
    same password Secret key the bootstrap CronJob reads is projected into the HyperDX pod as a file. The
    plugin re-reads that file on every attempt and compares the password in constant time, and only while no
    team exists. Anything else is refused, and while the password key is missing every registration is
    refused. A key added or rotated before the bootstrap registers takes effect without restarting HyperDX.
    Once any team exists, every registration is refused identically without reading or comparing the
    password, so the endpoint can't be used to test guesses at it. The plugin refuses with a `303` to the
    login page, so the `initialUser` CronJob no longer follows redirects: following one would read the
    login page's `200` as a registration. A redirect fails the run without a marker, and it retries.
  - The link invariants (one link per subject, one per HyperDX user) are enforced by unique indexes, so
    concurrent sign-ins can't both claim an account. Sign-in fails closed until the indexes exist.
  - Configuration comes from a caller-owned Secret that is re-read at runtime, so providers can be added or
    removed without a restart. An invalid config keeps the last good one.
  - `passwordLogin: false` is enforced on HyperDX's password strategy itself, which covers every spelling of
    the route, and also refuses registration and team-invite acceptance. `maxSessionAge` expires OIDC
    sessions.
  - The plugin self-checks its hook points and turns itself off on a mismatched HyperDX. It is gated to
    audited chart versions like `initialUser`.
  - New CI steps: the committed bundle must match the plugin source, and a Docker-gated suite signs in
    against the real `hyperdx:2.35.0` image and a mock OIDC provider.

  New exports: `ClickStackHyperdxOidcOptions`, `resolveClickStackHyperdxOidc`, `applyHyperdxOidcValues`,
  `hyperdxOidcPluginConfigMapName`, `hyperdxOidcPluginConfigMapData`,
  `CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS`, `HYPERDX_OIDC_PLUGIN_SHA256` and related constants.

- `ClickHouseKeeperClusterNameSchema` and `assertClickHouseKeeperClusterName` — the CHK's
  own cluster-name contract: Altinity's CRD alphabet and cap, plus the one rule the
  operator's own naming requires (at least one alphanumeric) —
  `^[A-Za-z0-9-]*[A-Za-z0-9][A-Za-z0-9-]*$` bounded at 15 bytes. It is deliberately WIDER
  than the CHI's `ClickHouseClusterNameSchema`: the CHI adds a LEADING-letter requirement
  because its generator renders the cluster name as a raw XML element name, and the
  keeper's generator does not (see `### Changed`). `9keeper` is therefore accepted for a
  CHK and rejected for a CHI.

- `clusterName` on `clickHouseKeeperInstallation()`, with `DEFAULT_CHK_CLUSTER_NAME`
  (`keeper`) exported as the recommended explicit value. It is required whenever the
  installation name is longer than 15 bytes or otherwise illegal as a cluster name, which
  the CRD caps independently of `metadata.name` (see Fixed). It mirrors the CHI's existing
  `clusterName`, but is bound by the CHK's own `ClickHouseKeeperClusterNameSchema`
  (`^[A-Za-z0-9-]*[A-Za-z0-9][A-Za-z0-9-]*$`, capped at 15 bytes), not the CHI's
  `ClickHouseClusterNameSchema`: the CHK deliberately accepts a LEADING digit or dash,
  which the CHI does not, because the CHI's config generator renders the cluster name as an
  XML element name.

- `ClickHouseSchema`, an Alchemy v2 resource (`TypeKro.ClickHouseSchema`) that applies
  ClickHouse DDL to a cluster the `clickhouse`/`clickstack` factories deployed, at
  converge time, with state. Nothing in TypeKro previously ran a deployment's own
  schema: the factories create a server, and `clickStackStorage`'s retention CronJob
  runs DDL from inside the cluster on a timer over tables TypeKro does not own.
  `clickHouseSchema(id, props)` covers the other case — databases, `S3Queue` tables,
  materialized views and application tables that belong to the deployment — as a
  first-class Alchemy resource, so it is diffable, it fails the deploy rather than a
  Job log, and it can be ordered after the instance's readiness like any other
  dependency. Merge `clickHouseSchemaProvider` into the runtime's providers alongside
  `kroProvider`.

  Statements are the author's contract: each must be individually idempotent
  (`CREATE ... IF NOT EXISTS`, `CREATE OR REPLACE`, `ALTER ... IF EXISTS`), because a
  changed fingerprint re-runs the WHOLE ordered list. The fingerprint — sha256 over the
  statements, the settings, the resolved client configuration and the execution model —
  is what makes an unchanged schema a true no-op. It is recorded only after the last
  statement succeeds, so a converge that dies partway re-runs from the beginning. Three
  things are compared outside the fingerprint, because they describe WHERE the DDL landed
  rather than what it was: the `target`, the live pod set, and the cluster.

  DDL is made cluster-wide EXPLICITLY, through a validated `execution` model, because
  standard ClickHouse DDL is server-local: a converge that touched one pod of a
  multi-replica deployment would report success while the other servers had no schema,
  and then no-op forever on the fingerprint. `{ mode: 'fanout' }` (the default) runs the
  ordered list against every server pod matching the selector and records the pod set in
  state as `{ name, uid }` pairs, so a scale-out, a removed replica, or a pod REPLACED
  under the same name re-applies even though the statements did not change; a
  single-replica installation is a one-pod fanout, so the default is also correct there.
  The UID is the identity, not the name: a StatefulSet replica that is deleted and
  recreated (a drain, a template change) comes back under the same name with an empty
  disk, which a recorded set of names cannot tell apart from the pod that was there
  before. `metadata.uid` identifies the pod OBJECT and is never reused, so a new UID
  re-applies and an unchanged one does not — correctly, because a pod object that survived
  kept its PersistentVolume (and the schema with it) or its replicated metadata in Keeper.
  `podNames` is kept alongside `pods` for compatibility. `fanout` is ALL OR NOTHING: the whole matching set is enumerated first
  (pods carrying a `deletionTimestamp`, and pods in a terminal phase, are excluded — they
  can never become Ready again), every pod in it must become Ready within
  `waitForPod.timeoutMs` before a single statement is executed, and a matching pod without
  the requested container fails the converge immediately, naming it. A StatefulSet
  mid-rollout therefore makes the resource wait — and then fail — rather than fingerprint
  an apply that only reached one replica; on a large cluster where some replica is almost
  always rolling, `onCluster` is the mode to use. The recorded set is always the one the
  statements ACTUALLY reached rather than the set that was live when the run finished, so
  a replica that appears mid-apply is never claimed as covered — and never left behind
  either: a `fanout` apply RECONCILES UNTIL THE LIVE SET IS COVERED. It selects the
  complete Ready set, applies the ordered list to every pod not yet applied to in this run,
  re-lists, applies to whatever appeared (by name and UID), and repeats until ONE EXIT
  PREDICATE holds — the last re-list observed a NON-EMPTY set, every pod of it was applied
  to by this run (by name and UID), and it matched the observation before it. All three
  parts are load-bearing. Without the first, "no pod is uncovered" is vacuously true of the
  empty set, so a run whose only pod disappeared between the exec and the re-list recorded
  `pods: []` as a success — and during a single-replica StatefulSet replacement that empty
  window sits exactly between the old pod going away and its SAME-NAMED successor arriving,
  leaving the successor (a new pod object, with an empty disk) unapplied behind a
  fingerprint that said the work was done. Without the third, a single snapshot cannot tell
  a settled set from one still moving: a pod that vanished mid-pass leaves every remaining
  pod covered while the set itself is mid-change. An empty set is therefore never
  convergence; it is waited out on the SAME `waitForPod` budget as the readiness wait, and
  a failure names the race ("the matching set became empty after N pod(s) were applied; a
  same-named successor would be unapplied") rather than the "no pod matched the selector"
  of a selector that never matched anything. Pods that disappeared between passes are
  dropped from the recorded set. A settled cluster still costs exactly one pass — the
  selection's own list and the re-list are the two consecutive observations. Two bounds stop
  a churning cluster looping forever — `maxReconcilePasses` (default 3) and the overall
  `waitForPod.timeoutMs`, spent ACROSS the passes rather than renewed by each one — and
  hitting either before the predicate holds FAILS the converge, naming which part of it the
  observation failed, so alchemy commits nothing and the next converge starts over. It never
  returns success with an uncovered pod and never records an empty set; recording an
  uncovered pod and merely warning left it unapplied until some future deployment happened
  to change the fingerprint. `maxReconcilePasses` is not part of
  the fingerprint — it says how the apply is driven, not what is applied — and is ignored
  under `onCluster`, which has no coverage to reconcile. `{ mode: 'onCluster', cluster }` runs the statements once and requires EVERY
  statement to carry an explicit `ON CLUSTER <cluster>` clause naming that cluster —
  matched with a ClickHouse-aware lexer, so quoting, case and string literals are handled.
  Nothing is inferred from a statement's shape: cluster-wideness is a property of the DDL
  TARGET, and a check keyed on a statement's references instead would wave through
  `CREATE TABLE events AS analytics.source`, which creates `events` locally. A statement
  that carries no clause is rejected at declaration time, naming its index, and TypeKro
  never rewrites the author's SQL to make the promise true. Statements with no
  cluster-wide form (`SET`, `USE`, a single-node `SYSTEM …`, `INSERT`) belong under
  `fanout`, which reaches every server itself. See
  https://clickhouse.com/docs/sql-reference/distributed-ddl.

  State also records a credential-free identity of the CLUSTER the statements reached —
  sha256 over the current context's cluster name, server URL and CA material, reusing the
  same `clusterIdentity` derivation the per-cluster API-capability cache keys on — and
  surfaces it as the `clusterId` output. Namespace, selector and container are just
  strings that a second cluster answers to identically, so without it, re-pointing a
  resource at another cluster matched the recorded target, matched the fingerprint, and
  applied nothing there.

  `onDelete` defaults to `retain` and does not reach the cluster at all on delete — a
  schema resource must never drop data because a stack was torn down. `run` executes an
  explicit `deleteStatements` list and nothing else; `run` without it, and
  `deleteStatements` under `retain`, are both rejected at declaration time rather than
  silently doing nothing.

  A plaintext password is not representable: both the config object and its `client`
  object reject undeclared keys, so `password` fails validation instead of being
  persisted to Alchemy state, and a misunderstood option fails loudly instead of being
  silently dropped while the author believes they configured something. The
  password is read inside the pod from the container's own environment
  (`--password "${CLICKHOUSE_PASSWORD:-}"` under `sh -c`, the variable name
  configurable via `client.passwordEnv`), matching what the retention CronJob and
  `clickHouseS3BackupCronJob` already set. Statements travel over the Kubernetes API
  server's `pods/exec` subresource — no port-forward, no exposed native port, no network
  path from the runner to the pod — one statement per `clickhouse-client` invocation, fed
  on stdin so no SQL appears in the container's argv. One invocation per statement rather
  than a single `--multiquery` batch is what makes error attribution by statement INDEX
  possible. `ClickHouseSchemaError` carries that index, the resource's own alchemy id, the
  pod it failed on and ClickHouse's error code and exception class — and never the
  statement text.

  Redaction does not try to filter credentials out of server output by keyword, because
  the case that matters has no keyword to match: ClickHouse echoes a bad definition back
  verbatim, and a positional `S3('https://…', '<key id>', '<secret>', 'CSV')` names none
  of its arguments. Instead, the error code and exception class are parsed out of the raw
  output first, and the retained message is redacted against the SUBMITTED statement —
  the statement text itself, every single-quoted literal it contains, and every value
  following `PASSWORD`/`IDENTIFIED BY`/`access_key_id`/`secret_access_key`/
  `aws_access_key_id`/`aws_secret_access_key`/`token` are replaced with `<redacted>`
  wherever they appear. Each literal is redacted in EVERY spelling it could be echoed
  in, longest first — the decoded value, the raw source slice between the quotes, and the
  value re-escaped both ways ClickHouse accepts (`\'` and `''`) — because a credential
  containing a quote is one secret with several spellings and the server frequently quotes
  back the text it was given rather than the value it decoded. Decoding and re-escaping both
  run off ONE table, ClickHouse's own
  (https://clickhouse.com/docs/sql-reference/syntax#string): `\xHH`, `\N`, `\a`, `\b`, `\e`,
  `\f`, `\n`, `\r`, `\t`, `\v`, `\0`, `\\`, `\'`, `\"`, `` \` ``, `\/`, `\=`, and for
  anything else "the backslash loses its special meaning i.e. it is interpreted literally",
  so `\z` stays two characters. A decoder that dropped every backslash instead would decode
  `\n` to the letter `n`, extracting a credential containing a newline in a spelling the
  server never emits and leaving the real one in the message. The keyword line filter
  remains as a second layer, and what survives is capped at 2 KiB so a runaway echo cannot
  be carried into Alchemy state.

  Only transport failures (websocket errors, resets, timeouts) are retried; a SQL error
  never is. Pods must be Ready before the first exec, with a bounded
  `waitForPod.timeoutMs`; under `onCluster`, EVERY Ready pod is considered when choosing
  the initiator, so a Ready pod from an older template without the requested container no
  longer causes the converge to reject the candidates behind it. The exec transport is an injectable
  `ClickHouseExecutor` interface with a default `@kubernetes/client-node` implementation.
  The converging identity needs `list` on `pods` and `create` on `pods/exec` in the target
  namespace.

- ClickHouse clusters may now keep their data in S3-compatible object storage
  with only a bounded local read-through cache on the node. `makeClickHouseCluster`
  takes a build-time `storage` topology whose `mode: 's3'` branch compiles a
  `storage_configuration` document into the ClickHouseInstallation's
  `configuration.files` and makes the generated policy the MergeTree default, so
  tables created by tooling outside TypeKro land on object storage with no
  per-table DDL. `mode: 'pvc'` remains the default and existing PVC consumers are
  unchanged.

  The durability trade-off is a discriminated `diskType`, not a boolean. The
  classic `s3` disk keeps part metadata on the local disk, so the bucket alone
  cannot be reattached and durability depends on the new optional
  `storage.backup` — a CronJob issuing `BACKUP DATABASE … TO S3(…)` with an
  age-based prune step and a documented restore procedure. On a sharded or
  replicated topology that statement becomes
  `BACKUP … ON CLUSTER '<clusterName>' TO S3(…)`, so every shard contributes to
  one Keeper-coordinated backup rather than the connected host silently
  capturing only its own shard; because that fan-out is coordinated through
  [Zoo]Keeper, a topology with more than one shard or replica that declares
  `storage.backup` without a keeper is rejected at construction. Because
  `clusterName` is interpolated into that statement, it is constrained to
  `^[a-zA-Z][a-zA-Z0-9-]{0,14}$` — the Altinity CRD's own alphabet and
  15-character cap on `clusters[].name`, plus a leading-letter rule. A literal is rejected at
  construction, the pattern travels into the generated KRO schema so a bad
  instance is rejected by the operator, and the backup script re-checks and
  escapes the name it receives before building the statement.
  `s3_plain_rewritable`
  keeps metadata in the bucket, making node loss a restart and reattach; it
  requires ClickHouse 24.5 or newer and a single replica, and both limits are
  enforced at construction time. `status.storage` reports the resulting
  guarantee.

  S3 credentials are never accepted inline: `auth.irsa` creates a ServiceAccount
  annotated with `eks.amazonaws.com/role-arn` and pairs it with
  `use_environment_credentials`, while `auth.secretRef` wires the keys as pod
  environment variables that the rendered configuration reads through `from_env`,
  so no key material appears in the ClickHouseInstallation spec.

  Every component of the object-storage location is validated at construction —
  `bucket` and the `backup.bucket` override against AWS's bucket naming rules
  through one shared validator, `region` against an AWS region shape, `prefix`
  and `backup.prefix` against a safe path-segment allow-list — and the fully
  COMPOSED endpoint URL is then validated again as a whole against the RFC 3986
  character allow-list. The composed string is what the runtime sees, in the
  `<endpoint>` element of `config.d/storage.xml` and in the
  `BACKUP … TO S3('<url>')` literal the CronJob builds, so it is checked as a
  unit rather than only component by component; the script's own quote-doubling
  stays as defence in depth. Values that XML 1.0 cannot represent at all — NUL
  and the other C0 controls, lone surrogates, the `#xFFFE`/`#xFFFF`
  non-characters — are refused when the configuration is built, naming the
  offending index and code point, because escaping cannot encode them and a
  rendered document containing one is rejected by ClickHouse's own parser at
  startup.

- ClickStack bootstraps may now declare the external ClickHouse's storage story.
  Per-signal `retention` renders an idempotent CronJob applying `TTL … DELETE` to
  the OTel tables the gateway collector creates, skipping tables that have not
  been migrated yet and leaving a converged cluster untouched. Convergence
  compares the COMPLETE TTL clause read back from `system.tables.engine_full`
  against the intended one, so neither a partial interval match nor extra
  clauses can report a different retention policy as converged. Retention is
  rejected at construction together with `diskType: 's3_plain_rewritable'`:
  that metadata type is immutable and ClickHouse refuses every `ALTER TABLE` on
  it except settings and comments, so the CronJob could never apply a TTL
  there.

  An opt-in persistent sending queue backs the gateway collector with file
  storage so a ClickHouse restart during a node rebuild does not drop in-flight
  telemetry. That queue is backed by a standalone PersistentVolumeClaim owned by
  the composition and mounted by `claimName` — never an `emptyDir` or a generic
  ephemeral volume, both of which Kubernetes deletes together with the collector
  Pod. The queue means exactly ONE gateway collector replica and there is no
  volume option that changes it: `file_storage` keeps the queue in a bbolt
  database under an exclusive file lock, so a second collector opening the same
  directory blocks on that lock rather than sharing the queue. A build-time
  `values['otel-collector'].replicaCount` above 1 is rejected at construction,
  the rendered values pin `replicaCount: 1`, and the claim is always
  `ReadWriteOnce`. Per-replica queues would need the chart's `mode: statefulset`
  with `volumeClaimTemplates`, which this composition does not model today — the
  error names that path rather than offering a shared volume that cannot
  deliver it.

  Because one replica bounds only the STEADY state, the queue also forces
  `rollout.strategy: 'Recreate'` on the gateway Deployment. The collector chart
  leaves it on Kubernetes' default `RollingUpdate`, whose default `maxSurge`
  rounds up to one extra Pod, so any pod-template change creates the
  replacement collector while the old one still holds the `ReadWriteOnce` claim
  and the bbolt lock. On another node that replacement never leaves
  `ContainerCreating` (`Multi-Attach error for volume`), and `RollingUpdate`
  will not terminate the old Pod until the new one is Ready, so the rollout
  deadlocks until `progressDeadlineSeconds` expires; on the same node it starts
  anyway and reports Ready off the OpAMP supervisor's `health_check` while its
  `file_storage` extension cannot take the lock, so the rollout "succeeds" over
  a queue the new collector never opened. `Recreate` removes the overlap
  entirely by draining first. The cost is a
  brief gateway outage on every rollout, and the persistent queue is exactly
  what makes that cost acceptable: producers upstream retry, and telemetry the
  gateway already accepted is on the claim rather than in the departing Pod's
  memory, so the replacement resumes draining the same queue. The pin is scoped
  to the queue — with no `persistentQueue` the gateway keeps the chart's
  `RollingUpdate` default — and unlike `replicaCount` a build-time
  `rollout.strategy` is overridden rather than rejected.

  The queue's chart
  values re-emit the gateway subchart's own `custom-config` volume alongside
  the claim, because Helm replaces a list-valued override and that mount is how
  the collector receives `global.otelCollector.customConfig` — without it the
  OpAMP supervisor cannot read the overlay and the agent starts without the
  ingest pipelines or the queue wiring, while the Pod still reports Ready. The
  bootstrap status now carries `storage` next to the gateway endpoints.
- A Traefik v3 factory (`typekro/traefik`) that stands Traefik up as a cluster
  edge and exposes its CRDs as typed factories. `traefikBootstrap` /
  `makeTraefikBootstrap` own the install — a singleton `HelmRepository` for the
  official chart, the `HelmRelease` (chart 41.5.0, Traefik `v3.7.13`, which
  carries the `traefik.io/v1alpha1` CRDs in its own `crds/` directory so one
  release installs both), an optional owned Namespace, and optional
  cluster-default `TLSOption`/`TLSStore` resources. The composition also OWNS
  the entrypoint Service — the chart's own Service is disabled through values —
  so its address can be projected without reading an unmanaged resource before
  anything has been applied. The status contract reports `ready`/`failed`/`phase`
  from the release's Ready condition, `loadBalancer.hostname`/`ip` from that
  owned Service, and `version` from the chart version Flux actually installed
  (the release's `status.history[]`, so a pinned-but-unavailable version is
  never reported as live). Both `install.crds` and `upgrade.crds` default to
  `CreateReplace` so a chart bump moves the `traefik.io/v1alpha1` CRDs with the
  proxy. Routing, TLS and upstream behavior are typed: `IngressRoute`,
  `IngressRouteTCP`, `TraefikService`, `ServersTransport`, `TLSOption`,
  `TLSStore`, and `Middleware` as a discriminated union over the whole OSS
  middleware set — two middleware keys in one spec is a compile error and is
  rejected before serialization. Typed builders carry the secure defaults for
  the middlewares an edge always needs (`forwardAuth`, `rateLimit` with the
  Redis backend, `inFlightReq`, `headers`, `redirectScheme`, `buffering`,
  `chain`). Traefik CRDs publish no status subresource, so they register an
  explicit always-ready evaluator rather than polling for conditions that never
  arrive.
- A shared, vendor-neutral Gateway API factory (`typekro/gateway-api`) holding
  `GatewayClass`, `Gateway`, `HTTPRoute`, `GRPCRoute`, `ReferenceGrant` and
  `BackendTLSPolicy` plus the upstream condition readiness evaluators
  (`Accepted`, `Accepted`+`Programmed` for a Gateway, per-parent conditions for
  routes, per-ancestor conditions scoped to a controller name for policies).
  Traefik consumes it with `traefik.io/gateway-controller`, so a Traefik edge
  and an Envoy AI Gateway can claim their own `GatewayClass` in one cluster.
  Every spec type in both factories is inferred from an ArkType schema verified
  field-by-field against the CRDs as the API server stores them, and every
  factory function accepts `Composable<T>`.

- `systemLogs` and `probes` on `makeClickHouseCluster()` and `clickHouseInstallation()`, the
  seams the two ClickHouse fixes below are configured through. Both are BUILD-TIME topology
  for the same reason `storage` is — `systemLogs` compiles into ClickHouse server
  configuration TEXT and `probes` into the enumerated pod templates — so a schema reference in
  either is rejected at construction rather than serialized as a `__KUBERNETES_REF__` marker
  into server configuration. `systemLogs` takes
  `{ storagePolicy?: string | false, ttl?: string | false, retentionDays?: number }`; `probes`
  takes a partial override (merged over the default) or `false` per probe, where `false` emits
  no probe and so hands that decision back to the clickhouse-operator's own default. Exported
  alongside them: `CLICKHOUSE_SYSTEM_LOG_TABLES`, `CLICKHOUSE_ENGINE_BOUND_SYSTEM_LOGS`,
  `DEFAULT_SYSTEM_LOG_RETENTION_DAYS`, `DEFAULT_CLICKHOUSE_STARTUP_PROBE`,
  `DEFAULT_CLICKHOUSE_LIVENESS_PROBE` and `DEFAULT_CLICKHOUSE_READINESS_PROBE`.

  `probes` validation mirrors KUBERNETES' own per-field bounds rather than applying one rule
  to every field, so a value the composition accepts is a value the API server accepts:
  `initialDelaySeconds` may be `0`; `periodSeconds`, `timeoutSeconds`, `failureThreshold` and
  `successThreshold` must be `>= 1`; and `successThreshold` must be exactly `1` on the
  `startup` and `liveness` probes, which only `readiness` may raise. The build-time
  ref-rejection is checked RECURSIVELY at both public entry points, so a reference nested
  inside `systemLogs` or `probes` (`systemLogs: { ttl: schema.spec.ttl }`) is rejected by name
  instead of reaching generated configuration.

### Fixed

- **ClickStack: the HyperDX Team the bootstrap creates now has a ClickHouse connection and sources,
  so signed-in users no longer land on HyperDX's "set up your connection" onboarding modal.** Without
  `initialUser`, the team-bootstrap CronJob inserts the Team into MongoDB itself. HyperDX provisions a
  Team's connection and sources only in `setupTeamDefaults`, which runs when `POST /register/password`
  creates a Team (read from the HyperDX 2.35.0 image: `setupDefaults.js`, called from
  `routers/api/root.js`). The CronJob's Team never got them, and neither did any Team created before
  this fix. Found on a downstream deployment, it affected every deployment without `initialUser`, with
  or without OIDC.
  - **What is seeded.** The CronJob seeds the `External ClickHouse` connection and the `Logs`, `Traces`,
    `Metrics` and `Sessions` sources, from the same values TypeKro renders into the chart's
    `defaultConnections` / `defaultSources`.
  - **Exact HyperDX shape.** The documents are written exactly as `setupTeamDefaults` stores them in
    HyperDX 2.35.0, and a new real-image test compares them field by field. As in HyperDX, the
    connection password is stored in plain text in the `connections` collection.
  - **Which password.** In both credential modes, HyperDX's default connection and the seed take the
    password from the same chart value, `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD`. The seed reads it,
    by `secretKeyRef`, from `clickstack-secret`, which the chart renders from that value. While the key
    is missing, the CronJob seeds nothing and records nothing, and seeds once it appears. Any value is
    seeded as it is, including an empty one and `hyperdx` (TypeKro reserves no password values).
  - **Default by credential mode.** On with inline credentials, where TypeKro owns the connection. Off
    with `secretValues`, where the values fragment may replace `defaultConnections` and the CronJob
    can't see it: without `initialUser`, a default seed would replace the caller's connection with
    TypeKro's. `teamDefaults: true` opts in.
  - **Seeded once.** The seed runs once per Team, and only into a Team with no connection and no source.
    The seed's ids and its progress are recorded in a `typekro_bootstrap` marker, so an interrupted run
    is finished without duplicates and without re-creating a document deleted in between. Once per run,
    just before it writes, it checks that the Team holds only its planned documents, and stops if not.
  - **Never overwrites.** After that the Team is never seeded again, so connections and sources edited
    or deleted in the UI are never overwritten or recreated.
  - **With `initialUser`.** The CronJob records the defaults HyperDX's registration created, after a
    60-second grace period, and fills them in only if that registration left the Team empty.
  - **Chart-version guard.** The seed writes HyperDX 2.35.0's private schema, so it carries the same
    exact allowlist as `initialUser` (chart 3.2.0), including for the default
    `makeClickstackBootstrap()`. There are three checks. A concrete version is refused at render time.
    The KRO CRD narrows `spec.version`, on CRDs KRO creates fresh only. The CronJob seeds nothing on an
    unaudited `CLICKSTACK_CHART_VERSION` at runtime, and that is the check that holds on existing KRO
    CRDs. `teamDefaults: { allowUnvalidatedChartVersion: true }` lifts all three.
  - **Opting out.** `teamDefaults: false` turns the seed off, and its guard with it. The seed is also
    off when build-time `values` replace the chart's default connections or sources.
- **ClickStack `secretValues` mode: HyperDX's default connection is TypeKro's external ClickHouse.**
  TypeKro rendered no `defaultConnections` in this mode, so chart 3.2.0 fell back to its own "Local
  ClickHouse" at the bundled ClickHouse Service, which TypeKro disables. With `initialUser`, HyperDX's
  registration provisioned that broken connection.
  - A `<release>-default-connections` ConfigMap now sets `hyperdx.deployment.defaultConnections` to the
    spec's host, HTTP port and UI user.
  - Every field is a Helm template the chart's `tpl` serialises with `toJson`. The password comes from
    the fragment's `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD`, and the host, port and user from typed
    values TypeKro sets under `typekro.clickstack.defaultConnection`. The ConfigMap is a constant that
    carries no credential, and a quote or backslash in any field stays valid JSON (checked with
    `helm template` against chart 3.2.0).
  - **No user value is spliced into HyperDX's connection or sources JSON in either mode.** Inline mode
    now uses the same Helm templates as `secretValues`: `hyperdx.deployment.defaultConnections` and
    `defaultSources` are `toJson` templates over typed values under `typekro.clickstack` (host URL,
    port, user, database) and `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD`. Before, KRO mode spliced the
    host, user, password and database into the JSON by hand, so a quote or backslash produced
    malformed `DEFAULT_CONNECTIONS`. Checked with `helm template` against chart 3.2.0.
  - `clickhouse.host` is checked at render time for a concrete value, by a CRD rule in KRO mode, and
    by the seed at runtime. The runtime check is the one that holds on existing KRO CRDs; on an
    invalid host it seeds nothing, writes no marker, and logs the host but never the password.
    Accepted: short names and FQDNs (with or without a trailing dot) of ASCII letters, digits, `.`,
    `-` and `_`, in any case; dotted-quad IPv4; and bracketed IPv6, validated as IPv6 by `net.isIPv6`.
    Refused: an empty value; whitespace, `/`, `\`, `?`, `#` or `@`; a scheme; a `:` outside brackets
    (a port); a bracketed value that isn't IPv6 (`[abc]`, `[:::]`); unbracketed IPv6, with a hint to
    bracket it; any other character; and a host WHATWG URL parsing would rewrite (`127.1`). The render
    time and runtime checks are identical, and the CRD rule is a syntactic pre-check that lets
    `[:::]` and `127.1` through to them.
  - The ConfigMap is listed in `valuesFrom` before the caller's Secret, so a `defaultConnections` in the
    fragment still wins.
- **ClickStack: the Team the bootstrap creates is named `ClickStack` (or `teamName`), not a hard-coded
  product name.**
  - **Only names TypeKro owns are renamed.** TypeKro records that it owns the name of a Team it
    creates before inserting it. A Team with no record is TypeKro's only while it still carries the
    name earlier releases hard-coded (matched by SHA-256, so the old name doesn't reappear in the
    source) or, with `initialUser`, HyperDX's registration name, `<email>'s Team`. Any other name,
    including one equal to `teamName`, is a person's, and once recorded as theirs it stays theirs.
  - **Nothing else changes.** Only `name` is updated, so the Team keeps its `_id`, its `apiKey` and its
    users.
  - **Concurrent renames.** TypeKro records the name it applied, and the rename is conditional on the
    name it read, so a rename in HyperDX (`PATCH /api/team/name`) wins, even one made at the same moment.
- **ClickStack + HyperDX OIDC without `initialUser`: a first OIDC sign-in can no longer create a second
  Team.** The plugin was allowed to create the Team there, so a sign-in before the team-bootstrap
  CronJob's first run left two Teams, and the plugin then refused every new user. The CronJob owns the
  Team on both paths now: the plugin gets `TYPEKRO_HDX_OIDC_CREATE_TEAM=false`. Until the Team exists,
  sign-in answers "HyperDX is still being set up. Try again in a minute." The plugin's startup line
  for that setup, which read as a warning about missing initial-user credentials, is now an accurate
  informational message.

- **HyperDX OIDC: sign-ins started or completed at the same moment in one browser all complete, each
  exactly once.** The plugin kept the pending sign-in (state, nonce, PKCE verifier, `returnTo`) in the
  HyperDX session, one per session. Several sign-ins in one browser therefore collided: a second start
  overwrote the first, and the first callback consumed the entry the second needed, so both got the 403
  denial page. A downstream end-to-end test with a reverse proxy that starts sign-in automatically for every
  signed-out page load found this: a browser restoring several tabs, or several links opened from chat,
  starts several at once. No session-based fix holds under real concurrency, because express-session saves
  the whole session and the last write wins, a browser with no session yet gets one session per concurrent
  start, and Passport regenerates the session on login.
  - Pending sign-ins now live in a plugin-owned collection, `typekro_oidc_pending_logins`, keyed by
    `state`, with a TTL index. They're no longer in the session, and any left there by earlier builds is
    removed.
  - Each sign-in is bound to the browser by its own random HttpOnly, SameSite=Lax cookie (Secure on
    https, path limited to the login routes). Only a SHA-256 of the cookie is stored.
  - A callback takes its entry with one atomic `findOneAndDelete` on state, binding hash, provider and
    expiry, before any token exchange. A replayed callback URL is refused at that lookup.
  - The per-entry nonce, PKCE verifier and 10-minute limit are unchanged.
  - A browser keeps at most 10 sign-ins in flight; the oldest is evicted first.
  - A `returnTo` longer than 2,048 characters now becomes `/`.
  - The real-image suite fires sign-ins concurrently in one cookie jar, both with and without an existing
    HyperDX session. It also fires concurrent callbacks and checks that each replayed callback URL is
    refused before any token exchange, five times each.
- **HyperDX OIDC: the chooser's password link can be configured.** With several providers the chooser
  linked HyperDX's password form at `/login`, which a deployment's reverse proxy may send to SSO. The new
  `passwordLoginPath` setting in the configuration document, or the `hyperdxOidc.passwordLoginPath` build
  option, sets the link (e.g. `/login?password`). The document's setting wins, and the default is still
  `/login`. It must be a same-origin path.
- **HyperDX OIDC: the provider chooser works behind a reverse proxy.** `GET /api/login/oidc` redirected to
  the single provider with a relative `Location`. HyperDX's UI proxies `/api/*` to its API server on port
  8000, and when the request's `Host` header has no port (every request through a TLS proxy on 443) it
  rewrites a relative `Location` to `http://<host>:8000/...`, which the browser can't reach. A downstream
  end-to-end test behind a reverse proxy found this. Every redirect the plugin issues is now absolute, built
  from the configured public URL. The callback URL and the chooser share one base (`redirectBaseUrl`, else
  `FRONTEND_URL`), and redirects to the UI use HyperDX's own redirect base. The request's `Host` header is
  never used. If `FRONTEND_URL` is missing or malformed and there is no `redirectBaseUrl`, redirects stay
  relative and the plugin logs a warning that says which. It also warns when `redirectBaseUrl` and
  `FRONTEND_URL` have different origins. `redirectBaseUrl` with credentials, a query or a fragment (even an
  empty `?` or `#`) is now refused, and a `returnTo` containing whitespace or control characters falls back
  to `/`. The real-image suite now also runs a HyperDX behind Caddy and follows the sign-in from the
  chooser to the provider and back.
- A `clickHouseInstallation` change that alters the pod template (probes above all) together with
  restart-requiring configuration no longer restarts ClickHouse under the OLD pod template first
  (#238). clickhouse-operator 0.27.x restarts the server in place (`SYSTEM SHUTDOWN`) before
  rolling the StatefulSet, and skips that only when a container's `env` changed; probe, resource,
  volume and affinity changes don't count. The 0.36 → 0.37 upgrade hit exactly this: the
  system-log config changed, the startup probe was added, and a server that already needed more
  than ~90s to boot was killed by the old liveness probe on every attempt. ClickHouse stayed down
  until the operator's 5-minute host wait ran out. The `clickhouse` container now carries
  `TYPEKRO_POD_TEMPLATE_HASH`, a digest of each pod template as TypeKro renders it (a zone
  template includes its affinity, so adding a zone leaves the other zones' digests alone), so any
  template change changes the env and the operator restarts the pod once, through the rollout, with the
  new template and config together. A config-only change keeps the operator's in-place restart.
  Runtime-only template values such as composition `podResources` are represented by their schema
  reference, so changing only the instance value does not move the digest. Those changes still roll
  normally through the StatefulSet; combined with restart-requiring ClickHouse configuration, the
  operator may still perform its pre-rollout software restart first, under the old resource limits.
  New exports: `CLICKHOUSE_POD_TEMPLATE_HASH_ENV` and
  `clickHousePodTemplateHash`.

  NOTE FOR EXISTING INSTALLATIONS: the first reconcile after upgrading adds the env var, which is
  itself a template change, so ClickHouse restarts once through a StatefulSet rollout.

- 0.37.0's system-log configuration stopped ClickHouse from starting under the Altinity
  clickhouse-operator: the server exited 36 (`BAD_ARGUMENTS`) during config load (#235).
  The operator's own `01-clickhouse-0{3,4,5}-*.xml` files give `query_log`, `part_log` and
  `trace_log` a full `<engine>`, and ClickHouse rejects a log that has `<engine>` plus the
  `<storage_policy>`/`<ttl>` that 0.37.0 merged in through `configuration.settings`. Those
  three logs now get no `configuration.settings` keys. Instead, a `config.d/system-logs.xml`
  file replaces each section wholesale (`replace="1"`), with the TTL and
  `SETTINGS storage_policy` written inside the engine definition. `query_thread_log`, which
  the operator switches off, is no longer given settings that switched it back on. A new
  Docker-gated suite (`test/integration/clickhouse/system-logs-server-boot.test.ts`, run in
  CI) boots a real server with the operator's default files and reproduces the 0.37.0
  crash as its control.

  The retention of `query_log`, `part_log` and `trace_log` moves from the operator's 30 days
  to 14, and ClickHouse renames each old table to `<name>_0` at the first restart. The
  replacing file also overrides anything set for those three logs through a caller's own
  settings or the operator's `configs.configdFiles`. It is verified against the operator
  0.27.1 defaults.

- `systemLogs.ttl: false` now has one meaning: TypeKro does not manage retention, and every
  log keeps its upstream TTL (none for most, ClickHouse's own on the three it bounds, the
  operator's 30 days on `query_log`/`part_log`/`trace_log`) in every storage mode. With the
  per-log fix alone it would have made those three unbounded in S3 mode and left them at 30
  days in PVC mode. The real-server suite covers S3, PVC and `{ storagePolicy: false }`.

- `systemLogs.storagePolicy` must now be a plain policy name (`^[A-Za-z_][A-Za-z0-9_.-]*$`),
  since it is quoted into an engine definition. `systemLogs.ttl` rejects `<`, `>` and `&`: the
  operator writes setting values into the server's XML config unescaped, so 0.37.0 already
  failed to start with them, only later and with a parse error.

- `CLICKHOUSE_SYSTEM_LOG_TABLES` is unchanged from 0.37.0: it still lists all 17
  default-enabled system logs. How each is configured is now given by three disjoint
  subsets: `CLICKHOUSE_SETTINGS_SYSTEM_LOG_TABLES` (through `configuration.settings`),
  `CLICKHOUSE_OPERATOR_REPLACED_SYSTEM_LOGS` (through the replacing file) and
  `CLICKHOUSE_OPERATOR_REMOVED_SYSTEM_LOGS` (left alone). Other new exports:
  `CHI_SYSTEM_LOGS_CONFIG_FILE`, `OPERATOR_SYSTEM_LOG_TTL`, `operatorReplacedSystemLogEngine`
  and `clickHouseSystemLogConfigurationFiles`.

- `clickhouseCluster` put ClickHouse's OWN `system.*_log` tables on object storage, and the
  resulting startup cost grew with uptime until the server could no longer boot at all
  (#232). In S3 mode the composition sets the S3 policy as the SERVER-WIDE MergeTree default
  (`merge_tree/storage_policy`), deliberately, so that tables created by tooling outside
  TypeKro — the ClickStack/HyperDX gateway collector's goose migrations, SigNoz's migrator —
  land on object storage with no per-table DDL. A server-wide default is server-WIDE: it also
  caught `query_log`, `trace_log`, `metric_log`, `part_log`, `blob_storage_log` and the rest,
  which write continuously, are never read, and on `plain_rewritable` object storage
  accumulate parts, `tmp_merge_*` directories and `__meta` entries. Startup walks and tidies
  that metadata one S3 round trip at a time, so boot time becomes a function of UPTIME.
  Observed on a cluster that ran healthily for days and then stopped being able to start:
  startup 2m48s against an operator liveness probe that kills at ~90s, 108 consecutive
  SIGKILLs, no self-recovery. Active part counts were unremarkable throughout (max 57) — the
  cost is object-store METADATA, not part count, which is what made it hard to see.

  Fixed by the SURGICAL route: the server-wide default is unchanged, and every system log
  ClickHouse enables by default is pinned back to the local `default` disk through its own
  `<storage_policy>` element (`query_log/storage_policy: default`, and so on for the rest).
  Where USER data lands does not move. The table list is ClickHouse 25.7's own
  default-enabled set, read out of `programs/server/config.xml` rather than guessed, with two
  deliberate omissions: `session_log`, whose section ships COMMENTED OUT (a system log exists
  if and only if its config section exists, so emitting one would ENABLE a log the server
  does not run), and `opentelemetry_span_log`, which declares its own `<engine>` — ClickHouse
  throws at STARTUP when a log carries both `<engine>` and `<storage_policy>`/`<ttl>`.

  Paired with retention, because these tables carry no TTL and so grow without bound on any
  disk: every one of them now gets `event_date + INTERVAL 14 DAY DELETE`, in PVC mode as well
  as S3. Fourteen days covers a full on-call rotation, and sits inside the range ClickHouse's
  own configuration already uses for the three tables it bothers to bound (3, 30 and 30 days).
  `systemLogs: { retentionDays }` changes the window; `systemLogs: { ttl: false }` leaves
  retention to the upstream defaults.

  NOTE FOR EXISTING INSTALLATIONS: ClickHouse compares the CREATE query it would write against
  the live table and, on a difference, RENAMES the old one to `system.<table>_0` before
  creating the replacement. The new tables are correct from the next restart, but the renamed
  ones stay on object storage and are still loaded at every boot — drop them to recover the
  boot time. See `docs/api/clickhouse/index.md`.

- `clickhouseCluster` set no probes at all on the CHI pod template, so a ClickHouse whose
  startup time had grown past ~90 seconds crash-looped forever and could not recover (#230).
  With the template silent the container inherits the clickhouse-operator's defaults: a
  liveness probe with `initialDelaySeconds: 60`, `periodSeconds: 3`, `failureThreshold: 10`
  and Kubernetes' 1s timeout — SIGKILL at roughly 90 seconds — and NO startup probe, because
  the operator's own `reconcile.host.wait.probes.startup` ships as `no` (and its CHI "startup"
  probe is literally its liveness probe again). ClickHouse's boot time is a function of how
  much data it has, so this failure is triggered by TIME rather than by load, a release or a
  configuration change, and it is silent until it is total. The symptom is far from the cause:
  the server never opens 8123 or 9000, only the interserver port 9009, and everything
  downstream crash-loops with connection-refused.

  The pod template now carries all three probes against the same `/ping`: a `startupProbe`
  with `periodSeconds: 10` and `failureThreshold: 90` (a ~15-minute boot budget, against the
  2m48s that triggered the incident), a `livenessProbe` with `failureThreshold: 6` and NO
  `initialDelaySeconds` — Kubernetes suspends liveness until the startup probe first
  succeeds, so the server may take as long as it needs to load and is still restarted ~60s
  after wedging once started — and a `readinessProbe` at `failureThreshold: 3`. All three
  raise `timeoutSeconds` to 5, off Kubernetes' 1s default, which is optimistic against the
  HTTP handler of a mid-load server. The operator only fills in a probe the pod template left
  unset, so these survive reconcile, and `probes.<name>: false` hands any one of them back.

- `clickstackBootstrap` produced a stack whose UI nobody could ever log in to, by breaking an
  upstream invariant. HyperDX bootstraps on a first-run-claims-the-instance pattern: the first
  visitor to `POST /register/password` creates the account AND its Team AND (through
  `setupTeamDefaults`) that Team's ClickHouse connection and its log/trace/metric/session sources,
  after which registration closes forever with `409 teamAlreadyExists` and the invite flow needs an
  authenticated user to start from. Exactly one registration exists per instance, and whoever spends
  it becomes the administrator. The chart alone therefore ships a reachable UI — but TypeKro's
  Team-bootstrap CronJob created the Team directly, to pre-seed the ingestion API key, which SPENDS
  that single registration without producing an account. Every deployment converged to one Team, zero
  users, no connections, no sources, and a login page nobody could satisfy (#227). Fixed with an
  optional build-time `initialUser` on `makeClickstackBootstrap` —
  `{ email, passwordSecretKey? | passwordSecretRef?, allowUnvalidatedChartVersion? }` — that makes
  the same CronJob spend the registration the way upstream intends: it POSTs the configured address
  and the password from the Secret to `/register/password`, so the account, the Team, the connection
  and the sources all come out of HyperDX's own code, and then patches only `teams.apiKey` so the
  Team carries the pre-shared ingestion key the collector authenticates with. A `409
  teamAlreadyExists` is treated as success — a human claimed the instance first, which is the
  objective — and an unreachable API is reported as the transient it is, since the CronJob retries
  every minute. HyperDX's `registrationSchema` is the authority on the address and the password:
  TypeKro checks only that they are present and relays the endpoint's own 400 body, which names the
  offending field, and a refused registration is not a consumed one. The password is never a prop:
  only where to find it is. In the `secretValues` credential mode, put it under
  `hyperdx.secrets.HYPERDX_INITIAL_USER_PASSWORD` in the `values.yaml` fragment of the external
  credentials Secret Flux already consumes through `valuesFrom`, and the CHART renders it into
  `clickstack-secret` — the credential never enters the HelmRelease or the RGD, and nothing
  hand-maintains that Helm-owned Secret. In the inline mode, where the only route into it would put
  the password in `spec.values`, `passwordSecretRef: { name, key }` points the CronJob at a Secret
  the operator owns instead; the two routes are mutually exclusive with a build-time error. The
  reference is `optional: true` deliberately: with `optional: false` an absent key stops kubelet
  starting the container, so the ingestion key is never reconciled either, and rotating the bootstrap
  password away after a successful registration would break every future run — presence is asserted
  inside the branch that registers instead (`HYPERDX_API_KEY` stays `optional: false`; it is required
  on every run). Bootstrap-once is carried by a durable marker of TypeKro's own —
  `typekro_bootstrap` / `_id: 'initial-user'`, written on every exit from the bootstrap branch —
  rather than by a `countDocuments({}) === 0` check, which answers "does something exist right now?"
  and so recreated an account an operator had deliberately deleted; a TypeKro-owned collection keeps
  framework state out of HyperDX's upstream-owned schema. WITHOUT `initialUser` the previous
  behaviour is unchanged and remains the default so existing deployments do not break, but it is
  DEGRADED and now documented as such: it spends the instance's one registration on a Team with
  nobody in it, leaving the UI permanently unreachable. Finally, because the one surviving write into
  an upstream-owned schema (`teams.apiKey`) would fail silently if the field moved — a green CronJob
  and silently unauthenticated ingestion — `initialUser` is held to an EXACT chart-version allowlist
  (3.2.0, appVersion 2.35.0) rather than a series or a prefix, since `3.2.0 || 4.0.0` and `>=3.2.0`
  are legal Helm ranges a prefix check would admit. It is enforced in both modes: a concrete version
  outside the list is refused at render time, and the generated CRD narrows `spec.version` with a CEL
  validation so a KRO consumer setting an unaudited version on the custom resource at apply time is
  refused by admission. KRO 0.9.2 adds that rule only to CRDs it creates fresh, so an upgraded CRD
  keeps only the render-time half. `allowUnvalidatedChartVersion` is the opt-out.

- `createKubernetesClientProvider(config?)` initialized the provider only when a config
  object was passed, although its signature and documentation promised "create and
  initialize" for an omitted config too. Any caller that omitted it got back a fresh,
  uninitialized provider whose first `getKubeConfig()` threw `KubernetesClientProvider not
  initialized. Call initialize() first.` (#219). Two documented forms hit this:
  `clickHouseSchema(...)` without a `kubeConfig` (the "omit for the ambient kubeconfig"
  form, which failed on its first exec) and a manually constructed `KroResource` without
  `kubeConfigOptions`. Fixed centrally: the factory now always initializes, and with no
  config `initialize` reaches `loadFromDefault()` (`KUBECONFIG`, then `~/.kube/config`).
  `KubernetesClientProvider.createInstance()` remains the way to get a deliberately
  uninitialized provider. Covered by a provider-level test that points `KUBECONFIG` at a
  fixture file and asserts `createKubernetesClientProvider()` is initialized from it, and by
  a `clickHouseSchema` test asserting the resolved `clusterId` is that file's
  `clusterIdentity()`. An injected `executor` with no `kubeConfig` is unchanged: it is still
  used as-is and still records no `clusterId`.

- `clickHouseSchema` with `onDelete: 'run'` now refuses a destructive teardown when the
  transport does not reach the cluster the state records. With the ambient kubeconfig the
  delete transport is whatever `KUBECONFIG` names at destroy time, and `namespace` +
  `podSelector` match pods on any cluster, so the `deleteStatements` (DROP statements)
  could have run against a different cluster than the one the schema was created in. The
  provider's `delete` hook now compares the persisted `output.clusterId` against the
  current transport's identity BEFORE any pod is listed or statement sent, and throws a
  `ClickHouseSchemaError` (`Refusing destructive schema teardown ... recorded <id>, current
  <id-or-none>`) on a mismatch. A recorded identity against an unknown current one (an
  injected `executor` with no `kubeConfig`) is rejected too; state that recorded no
  identity has nothing to compare against and behaves as before. Teardown with NO
  persisted state at all — no successful apply ever completed, as after a create that
  failed part-way through its `statements` — is refused as well (`... no persisted
  successful apply state ...`), before any transport is built: nothing identifies the
  cluster the partial DDL landed on, so the DROP statements must not run against whatever
  `KUBECONFIG` names now. `onDelete: 'retain'` still never reaches the cluster.

- `clickstackBootstrap` with `storage.persistentQueue.enabled: true` was unusable on block PVCs:
  the freshly provisioned filesystem is `root:root` 0755, the gateway collector image
  (`clickstack-otel-collector` 2.35.0) runs as `otel` (uid/gid 10001), no `fsGroup` was set and
  nothing chowned the mount, so the collector crash-looped forever on
  `open /var/lib/otelcol/file_storage/exporter_clickhouse__logs: permission denied` — a line that
  only appears in the OpAMP supervisor's `agent.log`, while the Pod reported a generic
  `Agent crashed during config application`. Whenever the queue is enabled the composition now
  pins `otel-collector.podSecurityContext` to `{ fsGroup, fsGroupChangePolicy: OnRootMismatch }`
  in the HelmRelease values: ClickStack 3.2.0's gateway is the stock `opentelemetry-collector`
  0.146.1 subchart under the `otel-collector` alias, and it renders that value verbatim into the
  Deployment's Pod `securityContext`. The pin is one of the mapper's hard pins (merged last,
  recursively), so build-time `values` / direct-mode `customValues` can add other
  `podSecurityContext` fields but not change these two. `storage.persistentQueue.fsGroup`
  (default `10001`, the collector image's `otel` group) is validated as a non-negative SAFE
  integer — `Number.isInteger(1e20)` is true but `fsGroup` is an int64 — and `0`, the root group,
  is allowed because Kubernetes allows it. `makeClickstackBootstrap` also accepts build-time
  `postRenderers`, threaded through `clickstackHelmRelease` to the HelmRelease verbatim; the
  composition adds none of its own. Exported alongside: `DEFAULT_QUEUE_FS_GROUP` and
  `QUEUE_FS_GROUP_CHANGE_POLICY`.
  ([#222](https://github.com/yehudacohen/typekro/issues/222))

  The first cut of this fix (#223, unreleased) carried the `fsGroup` as a Flux `postRenderers`
  Kustomize patch on the rendered `<release>-otel-collector` Deployment, on the premise that no
  chart value could reach the collector's security context. The premise was wrong — only the
  parent chart's own templates lack a hook — and the patch had a silent failure mode: the subchart
  names the Deployment `printf "%s-%s" .Release.Name "otel-collector" | trunc 63 | trimSuffix "-"`,
  so for a release name past 48 characters the patch matched nothing and the collector hit the same
  `permission denied`. The value-based seam is name-independent and drops the per-reconcile
  Kustomize pass. `renderPersistentQueuePostRenderer` and `clickStackGatewayName`, exported only
  by that unreleased cut, are gone.

  The queue also pins `otel-collector.enabled: true`, alongside the `replicaCount: 1` and
  `rollout.strategy: Recreate` it already owned. A build-time
  `values: { 'otel-collector': { enabled: false } }` with `persistentQueue.enabled: true` used to
  render a HelmRelease with the collector disabled but the queue's claim, its `file_storage`
  extension and `persistentQueue: true` in the status contract still present. Without a queue a
  caller's `enabled: false` still passes through.

- `clickstackBootstrap`'s runtime `name` is now bounded, and the bound is derived rather than
  written down: `CLICKSTACK_GENERATED_NAMES` lists every object name the bootstrap, its chart or a
  downstream controller derives from `name` with the limit each must satisfy, and
  `CLICKSTACK_NAME_LIMIT` (`deriveNameLengthLimit`, the Traefik bootstrap's mechanism) is the
  minimum — **37 characters**. Two derived names failed late and quietly before: the
  `<name>-team-bootstrap` CronJob (and `<name>-otel-retention`) is refused by the API server past
  Kubernetes' 52-character CronJob limit (the binding constraint, new
  `CRONJOB_NAME_MAX_LENGTH`), so a longer name never ran the Team bootstrap and `ready` never
  became true; and the chart truncates the gateway Deployment/Service `<name>-otel-collector` at
  63 characters while the status contract's `gateway.*Endpoint` fields assume the literal, so past
  48 characters they named a Service that did not exist. `name` must also be a Kubernetes DNS
  label (`CLICKSTACK_NAME_PATTERN`, the Traefik bootstrap's pattern), since every derived object
  is one — `""`, `"Foo"`, `"foo_bar"` and `"foo/bar"` fit the length bound and were refused only
  by the API server. Both are plain constraints on the schema (`ClickStackReleaseNameSchema`), so
  the KRO RGD carries `name: string | maxLength=37 pattern="…"`, direct-mode `deploy` rejects
  through the schema, and direct-mode `toYaml` runs the same schema on a concrete name
  (`assertClickStackReleaseName`) and refuses it with the same message — for the length, one that
  names the constraint behind the number. `CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX`,
  `CLICKSTACK_RETENTION_NAME_SUFFIX` and `CLICKSTACK_CONTRACT_CONFIGMAP_SUFFIX` are exported from
  `types.ts`. ([#222](https://github.com/yehudacohen/typekro/issues/222))

- One stalled idempotent GET no longer fails a whole converge (#213). Since 0.36.0 a
  Kubernetes read that never returns is reported after the 30 s `read` budget instead of
  hanging, and in practice the FIRST request of a freshly constructed client intermittently
  never completes against a healthy API server — the same GET answers in under a second
  from another client — so a single 30 s stall of a ~2 KB drift-check read was killing
  20-minute deploys. The alchemy persisted-identity drift check, the singleton drift gate
  and the engine's single (non-polling) external-reference read now re-issue the read
  EXACTLY ONCE on a request timeout, via `retryOnceOnRequestTimeout`, and log a warn naming
  the resource. The worst case is bounded at two read budgets. Under Bun the re-issued read
  is always a new connection (the HTTP library sends every request with `agent: false` and
  `Connection: close`); with the stock Node client it is a plain re-issue that may reuse a
  pooled socket. Only a request timeout (the socket timer's, the deadline wrapper's, or a
  premature close) is retried; an HTTP error the server answered with, a TLS failure or an
  abort is thrown immediately, the deployment's abort signal is checked before the second
  attempt — for the engine's external-reference read that is the deployment-wide signal, so
  a cancelled deployment puts no second read on the wire — and creates, updates and deletes
  are never retried. When the retry times out as well, the error says the read was already
  re-issued once.

- The request-timeout hint no longer blames an exec credential a kubeconfig does not have.
  `PollTimeoutError` names "a wedged or expired kubeconfig exec credential" only when the
  current user actually carries an `exec` block (`usesExecCredential`, threaded through
  `withCallDeadline`); for a pre-minted token or client certificate it says a wedged exec
  credential cannot be the cause and the connection stalled before the API server answered,
  and where the credential shape is not known it hedges instead of asserting either way.

- A KRO instance that had ALREADY failed could be reported as a generic readiness
  timeout instead of the error it actually hit. The readiness poll checked the
  ResourceGraphDefinition status schema before it checked the instance's own terminal
  state, and under the strict schema-lookup policy a retryable lookup failure abandons
  the iteration and retries — so an instance sitting in `FAILED`/`ERROR` with a precise
  controller message stayed hidden behind lookup retries until the deadline. The
  terminal-state check now runs as soon as the state and conditions have been read from
  the instance, before any schema lookup is attempted, so the instance's own message is
  what the caller gets, immediately.

  **Behaviour clarification:** that terminal state is treated as authoritative only when
  it describes the CURRENT `metadata.generation`. Kubernetes keeps the status
  subresource across spec updates, so the first read after an update can return the new
  generation alongside the PREVIOUS deployment's verdict — a failed state, a `False`
  condition whose `observedGeneration` is one behind, and that deployment's message —
  while the new generation is about to reconcile perfectly well; KRO documents
  `observedGeneration < metadata.generation` as "not yet processed". A terminal state is
  therefore reported only when some `False` condition has observed the current
  generation. Stale failure evidence falls through to ordinary polling, still bounded by
  the caller's timeout. Instances that report no generation, and conditions from an
  older KRO that carry no `observedGeneration` at all, cannot be shown to be stale and
  keep the previous behaviour exactly.

- The readiness timeout message could blame a status-schema lookup failure that had
  since recovered. The remembered lookup error is now cleared as soon as a later lookup
  succeeds, so a timeout caused by an instance never projecting its declared status is
  no longer misattributed to a transport blip on an earlier poll. The wording is also
  corrected from "never returned" to "could not be read", since a persistent 404 or 5xx
  does return — with an error. The remembered failure is now the classifier's
  Kubernetes-aware description rather than a stringified exception, so a client that rejects
  with a bare `Status` object no longer prints as `[object Object]` in the one line an
  operator has to work from; the original rejection stays reachable as the timeout error's
  `cause`.

- KRO instance readiness could overshoot its own declared timeout by up to a full poll
  interval. Each sleep between polls ran to completion before the loop re-checked the
  deadline, so a short budget with a long interval returned late — most visibly on the
  path taken while an instance has no status at all, which sleeps the standard poll
  interval regardless of the caller's configured one. Every sleep in the wait is now
  capped to whatever is left of the budget, making the declared timeout the real upper
  bound.

- The Bun-compatible HTTP library ignored an `AbortSignal` that was ALREADY aborted when
  the request was built, and sent the request anyway. An aborted signal never fires
  `abort` again, so registering a listener silently missed it — and a converge-wide
  signal that trips while an earlier call is in flight leaves exactly that state for the
  next call in the queue. The signal is now checked before the listener is registered:
  an already-aborted request rejects with the signal's own reason and is torn down
  before any bytes reach the wire. The live-abort path was made consistent, rejecting
  with the signal's reason rather than a generic error.

- **Behaviour change.** The KRO instance readiness check no longer converts an
  UNCERTAIN ResourceGraphDefinition status-schema read into an EMPTY status schema. It
  reads that schema to learn which custom status fields an instance is expected to
  project; previously ANY failure of that read set "expects no custom status fields",
  so a request that never produced an answer let an ACTIVE, synced instance be declared
  ready without validating a single one of its status fields — and, for a request that
  burned its whole budget, after the deadline had already passed.

  The gate that was supposed to prevent this recognised only the readiness poll's own
  per-call timeout class, and a request can fail at several layers: the HTTP library
  arms its socket timer synchronously while the request is issued, so with comparable
  budgets it fires FIRST and raises the base request-timeout type; a connection dropped
  mid-response raises the premature-close type; a 5xx or an unrecognised transport error
  raises neither. Failures are now classified with the same shared classifier the rest
  of the engine uses, and the question it answers is the right one — did the server
  actually ANSWER? — rather than which error class this happens to be.

  Being uncertain is not, however, a reason to retry forever. Failures are split by the
  shared retry policy the engine already applies to the same question. A failure that
  could plausibly resolve on its own — the RGD object is absent (404), or the request hit
  a transient fault (5xx, rate limiting, a wedged request, a dropped socket, a DNS blip) —
  ABANDONS that poll iteration: neither ready nor permissive. The loop polls again, so
  the caller's overall `timeout` stays the single authority on how long to keep trying
  and one blip is ridden out instead of failing the deploy; the poll interval is honoured
  before the retry, so a fast-rejecting premature close cannot spin. A read that never
  succeeds simply never satisfies the status-field check, and the resulting overall
  timeout error now carries the last lookup failure so the diagnosis is not lost.

  A DETERMINISTIC failure instead fails fast with the original error. A refused request
  (401/403) is the canonical case, matching every other 401/403 in the codebase and the
  documented policy that waiting cannot fix RBAC — but a malformed or rejected request
  (400/405/422), a 404 meaning the ResourceGraphDefinition API resource is not served at
  all, a rejected TLS handshake, and an error with no Kubernetes shape whatsoever (a
  `TypeError` from a client signature mismatch or a plain programming bug) are just as
  fixed. Previously all of them were retried to the deadline and then reported as a
  readiness timeout, which hid the actual cause behind a message about the KRO
  controller. The shared classifier also learned the two "the request never got an
  answer" shapes it did not previously recognise — this project's own request-timeout
  types, and socket/DNS failures identified only by their system `code` — so they count
  as transient wherever that classifier is used, rather than reading as unrecognised
  programming errors.

  **An HTTP status outranks every transport heuristic.** If the error carries a status, the API
  server ANSWERED — the request reached it and it formed a verdict — so evidence that the
  transport failed cannot overturn it, because a transport that failed could not have carried a
  status back. The two do co-occur: a client can leave a system `code` on a status-bearing error,
  and Node's `fetch()` spells its failures as a `TypeError` whose message the shared retry
  predicate sniffs for the word `fetch` — which a status-bearing `TypeError` matches just as well.
  Consulting that evidence first turned a 422 the server had already REJECTED into a transient
  fault and polled it to the deadline, reporting a readiness timeout instead of the rejection.
  Both classifiers in this module now decide on the status alone while one exists, and only fall
  through to the TLS / request-timeout / socket-code / message ladder when the request produced no
  HTTP response at all. A retryable status stays retryable however the message reads, and a 4xx
  the classifier has no specific name for is still the server's verdict on the request.

  **TLS trust, identity and protocol failures are NOT retryable.** An expired, not-yet-valid,
  self-signed or wrongly-named server certificate, an unverifiable chain, or a protocol
  mismatch (`EPROTO`) is a configuration fact: the wrong CA bundle, a stale kubeconfig, a
  plain-HTTP endpoint addressed as HTTPS. Each is rejected identically on every attempt, so
  polling one for a multi-minute budget only buries what to fix under a timeout. They now
  classify as a TLS configuration error that fails fast, and the reported detail names the
  system code and points at the setting to look at — the cluster CA / server certificate for a
  certificate verdict, the server URL and TLS version window for a protocol mismatch, and the
  client/server TLS configuration for the rest of Node's `ERR_TLS_*` namespace
  (`ERR_TLS_DH_PARAM_SIZE`, `ERR_TLS_INVALID_CONTEXT`, …), which says nothing about a certificate
  and whose operator would otherwise be sent to the one thing that is not wrong.

  The recognised codes are the COMPLETE set, not a sample: every certificate-verification code
  Node documents under "OpenSSL error codes" (`nodejs.org/api/errors.html`) — including
  `CERT_REVOKED`, the CRL codes, `HOSTNAME_MISMATCH`, `INVALID_CA` and the signature/field
  formatting errors — plus Node's own `ERR_TLS_CERT_ALTNAME_INVALID`, the fatal certificate
  alerts a server sends when it rejects a client certificate (a stale kubeconfig arrives as
  `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`, not as any `CERT_*` code), and the protocol-mismatch codes
  `EPROTO`, `ERR_SSL_WRONG_VERSION_NUMBER` and the TLS-version family. Completeness matters
  because the failure mode is not graceful: an unrecognised code falls through to the generic
  "a `TypeError` mentioning fetch is retryable" rule, so a single omission means that code
  alone polls to the deadline. An unknown code beginning `CERT_` is treated the same way for
  the same reason — every `CERT_*` code OpenSSL defines is a verdict on the certificate.
  `OUT_OF_MEM`, which shares that doc section, is deliberately excluded: it reports a resource
  shortage rather than anything about the certificate. This is deliberately
  narrower than the "was the server reachable?" taxonomy used elsewhere in the same module,
  which counts a rejected handshake as "unreachable" because the server never answered —
  correct for that question, wrong for "is it worth asking again?". The codes are also read
  through one level of `cause`, because Node's `fetch()` reports every transport failure as
  the same opaque `TypeError: fetch failed`; without that, a rejected certificate matched the
  classifier's generic fetch-failure rule and was retried. Because this classifier is SHARED,
  the engine's required external-reference resolver — whose documented policy is that a
  permanent failure fails immediately — gets the same fail-fast behaviour, instead of spending
  its read budget on a certificate that will never be accepted.
  Node's own `ERR_TLS_*` family is treated the same way by prefix (`ERR_TLS_DH_PARAM_SIZE`,
  `ERR_TLS_INVALID_PROTOCOL_VERSION`, …), with `ERR_TLS_HANDSHAKE_TIMEOUT` carved out as the one
  transient member, and with its own diagnostic hint rather than the certificate one.

  A 404 for the RGD OBJECT stays strict rather than permissive for the same reason the
  whole policy is: the RGD name the poll looks up is the name the factory emitted — both
  read one stored field — so it means the RGD is missing, not that the instance has no
  status schema. A repo-wide test asserts that property against every shipped
  composition, so a future refactor that re-derived the lookup name from the instance's
  kind or apiVersion could not pass unnoticed.

- A cancelled deployment could still issue the write it was cancelled to prevent. The
  per-request deadline wrapper raced an already-aborted signal against the operation,
  but the race is set up AFTER the call has been made: the caller's promise rejected
  while the create or delete had already left for the API server. In a replacement
  sequence — delete, wait for the 404, create — an abort landing in that window
  cancelled the deployment and created the object anyway. The wrapper now checks the
  signal BEFORE invoking the client method, so an aborted converge cannot launch new
  cluster mutations.

- The Bun-compatible HTTP library leaked an abort listener per successful request. The
  listener was registered with `{ once: true }`, which removes it only when the event
  FIRES — and the overwhelmingly common case is that it never fires, because the request
  succeeded. A caller's `AbortSignal` typically spans a whole converge, so every
  completed request left its closure (and the request object it captured) attached, and
  the signal's listener list grew for the life of the operation. Detaching is now part
  of the same latch that every terminal path already goes through, alongside clearing
  the request timer.

- `callDeadlineBudget()` collapsed `create` and `update` into a single write budget, so
  a caller who configured both got the `create` value on every POST, PUT, PATCH and
  apply, and the configured `update` was honoured only when `create` was absent —
  contradicting the separate `create` and `update` knobs the HTTP timeout configuration
  exposes and the split the HTTP layer itself already makes by method. The per-verb
  budget is now `{ read, create, update, delete }`, method-name classification
  distinguishes a create (POST, `create*`) from an update (PUT/PATCH, `replace*`,
  `patch*`, server-side apply), and there is NO cross-fallback between the two: an
  unconfigured verb takes the shared write default, never its sibling's configured
  value. Deletes still win over both, and an unrecognised method still takes the short
  read budget so a misclassified call fails fast rather than hanging.

- `clickHouseKeeperInstallation()` now fails at BUILD time, instead of at the operator,
  when a LITERAL installation name cannot be the CHK's internal cluster name. The Altinity CRD
  constrains `spec.configuration.clusters[].name` to `minLength: 1` / `maxLength: 15` /
  `^[a-zA-Z0-9-]{0,15}$` (`See namePartClusterMaxLen const`) on the
  ClickHouseKeeperInstallation exactly as it does on the ClickHouseInstallation, while
  `metadata.name` is uncapped — so the FIRST apply of any keeper whose release name was
  longer than 15 bytes was rejected by the API server with
  `spec.configuration.clusters[0].name: Too long: may not be more than 15 bytes`, at a
  point where nothing in the graph could explain it.

  The default still DERIVES from the installation name, so every deployment that already
  worked keeps exactly the object names it had. That is deliberate: the cluster name is a
  fragment of every generated object name
  (`chk-<installation>-<cluster>-<shard>-<replica>`), so changing it replaces the
  StatefulSet with fresh volumes and loses the coordination state every `Replicated*`
  table depends on — a silent default swap would have done that to every keeper whose
  name already fitted the cap. Only names that could never have worked change behaviour,
  from an operator rejection into an error naming the field, the byte length, the cap and
  the remedy. No truncation, no silent rename.

  An explicit `clusterName` (see Added) runs `assertClickHouseKeeperClusterName`, the CHK's
  own check, bound by `ClickHouseKeeperClusterNameSchema`
  (`^[A-Za-z0-9-]*[A-Za-z0-9][A-Za-z0-9-]*$`, capped at 15 bytes) rather
  than the CHI's `ClickHouseClusterNameSchema`: the CHK deliberately accepts a LEADING digit
  or dash, which the CHI's `assertClickHouseClusterName` rejects, because the CHI's config
  generator renders the cluster name as an XML element name and the keeper's does not. Both
  resources reject an over-long value identically; unit tests pin the length boundary at 15
  accepted / 16 rejected on both, and pin the leading-character difference between the two
  schemas separately. The CHI is unchanged — its `cluster` default was already independent
  of the installation name, which is why only the keeper failed.

  KRO MODE: the check moves to the operator, and the factory says so. When `name` is a
  schema reference the value is unknown at build time — the RGD carries
  `clusters[0].name: ${schema.spec.name}` and the generated KRO schema types `spec.name`
  as a bare `string` with no length bound — so an over-long INSTANCE name still reaches
  Altinity's admission check. The factory emits a build-time WARNING saying
  that, recommending `clusterName: DEFAULT_CHK_CLUSTER_NAME` for a NEW deployment (with
  the state-loss caveat for an existing one) and pointing at the other option: bounding
  the enclosing composition's own spec field with `ClickHouseKeeperClusterNameSchema` — the
  CHK's own contract, not the CHI's `ClickHouseClusterNameSchema` — whose `maxLength` and
  `pattern` (`^[A-Za-z0-9-]*[A-Za-z0-9][A-Za-z0-9-]*$`, permitting a LEADING digit or dash) the schema
  generator carries into the RGD so KRO rejects a bad instance at admission. `clusterName`
  is deliberately NOT made mandatory for
  references — that would force it on existing KRO-mode deployments.

  The warning is emitted once per build with NO cross-build state. Serializing a
  composition re-executes its body several times, and every repeat is one of the
  framework's internal ANALYSIS passes, which it already marks with
  `suppressResourceDiagnostics` — the same gate `createResource` uses for its own
  resource-construction diagnostics. Nothing is remembered between builds, so an
  independent composition built later in the same process, even with the same namespace
  and resource id, still gets its own warning.

  The same change stops two framework placeholders from being validated as if they were a
  user's installation name: the defaults-extraction pass's `REQUIRED_FIELD_SENTINEL`, and
  the `__KUBERNETES_REF_…__` marker string that a template literal over a schema proxy
  produces (`` `${spec.name}-keeper` ``).

  Anything that needs the value — a `keeper_path` prefix, an operator-generated Service
  name, and on the CHI side the `ON CLUSTER '<name>'` target of a consumer's DDL — must
  read it from the exported constant or the `clusterName` it passed, or from the resource
  (`clickhouse.clusterName` on the cluster composition's status, projected from the CHI's
  own `spec.configuration.clusters[0].name`), never by assuming a particular derivation.
  The 15-byte cap with `minLength: 1` covers the cluster, shard and replica names and
  `spec.templates.hostTemplates[].spec.name`, on the CHI, the CHIT and the CHK alike;
  TypeKro emits none of the shard, replica or hostTemplate names today. Pod, volume-claim
  and service TEMPLATE names are uncapped.

- A Kubernetes request whose connection dropped part-way through the response hung
  forever instead of failing. The Bun-compatible HTTP library wrapped `https.request`
  in a promise that settled only on the response's `end` event or the request's
  `error` event, while the request's `close` event cleared the wall-clock timeout
  without settling anything. A truncated response therefore disarmed the only thing
  that could have rejected, and the caller's `await` never returned — a converge
  stalled at an arbitrary API call until some far outer deadline, with no error and
  no indication of which call was stuck.

  The event ordering made this reliable rather than rare. On Bun — and only on Bun —
  the request's `close` fires as soon as the response HEADERS arrive, before the body,
  so the timer was disarmed for the whole body phase of every request; Node emits that
  event after the exchange ends, which delays the same unguarded disarm rather than
  avoiding it. On both runtimes a mid-body drop is then reported only on the response
  (`aborted`, `error`, `close`) and never as an error on the request, and nothing
  listened to those. The promise now settles through a single latch that every terminal
  event goes
  through — the response's `end`, `aborted`, `error` and a `close` before `end`, the
  request's `error`, a request `close` with no response in flight, the timeout, and an
  abort signal — and the timer is cleared only by that latch, never on its own. A
  premature close rejects with a typed error carrying the method and path, a
  `socket hang up` message and an `ECONNRESET` code, so the existing transient- and
  retryable-error classifiers treat it as the transport blip it is; a timeout still
  reports the timeout rather than the reset its own teardown produces. The pre-connect
  phase gained a matching `setTimeout` on the request, so a stalled DNS or TCP/TLS
  connect is torn down rather than merely abandoned.

- Every Kubernetes request the Alchemy KRO provider issues is now bounded by a per-verb
  deadline — the drift and terminating-identity reads, the singleton and pre-hoist
  safety gates (including the owned-namespace pagination), the hoisted-namespace
  ownership probe, the two generated-CRD migrations, the client handed to the
  deployment engine, and the finalizer-safe teardown (instance and definition
  deletion, the empty-gated Namespace delete and its cluster inventory, whose
  discovery fans out across aggregated API groups that may be unreachable). None of
  them had a bound: a
  wedged call (a hung exec credential, a half-open socket, an API server that accepts
  the connection and never answers) left `reconcile` hanging with no log line and no
  error, and the converge only died on the caller's outer timeout — with no indication
  of which resource was stuck. Observed on an update of a `ResourceGraphDefinition`
  whose live object had been deleted out-of-band while its generated CRD was retained:
  the handler never reached the deployment engine, so not even `Starting deployment`
  was logged.

  Each call now rejects with a `PollTimeoutError` naming the resource and the method.
  The budget comes from `options.httpTimeouts` PER VERB — reads, writes and deletes get
  their own budgets, so a create behind an admission webhook or a delete waiting on a
  finalizer is no longer cut short by the read timeout — and every verb is capped by the
  deployment timeout. The cancellation signal reaches all of these calls rather than only
  the terminating-identity wait.

  A wedged singleton-owner spec-drift check now fails CLOSED instead of silently
  skipping its assertion. That gate treats a failed read as "nothing to clash with", so
  it has to be able to tell a timeout apart from an absent object — and under Bun the
  HTTP library's own socket timer is armed while the request is issued, i.e. BEFORE any
  deadline wrapper around the call, so with equal budgets the socket error is the one the
  gate actually sees. The HTTP library now raises a typed `RequestTimeoutError` (the
  message is unchanged) that `PollTimeoutError` extends, so either timing layer is
  recognised by `isRequestTimeoutError`.

  The bound applies to the caller's `await`, not to the socket: under Bun the client
  also sets an HTTP-level timeout that aborts the request, but on Node
  `@kubernetes/client-node` takes no timeout configuration, so an in-flight request (or
  a wedged exec-auth subprocess) can outlive the rejection. See
  `docs/advanced/alchemy-integration.md`.

- `Composable<T>` mangled `readonly` array fields. Its passthrough list tested
  the mutable `unknown[]`, which a `readonly T[]` does not satisfy, so those
  fields fell into the object branch and were rebuilt element-wise as
  `Composable<T>[]` — a shape no factory could assign back to the original
  field. It now tests `readonly unknown[]`, which covers both forms.
- KRO-mode serialization now reports status leaves KRO drops from the instance.
  KRO requires every status field to refer to a RESOURCE in the graph
  (`instance status field must refer to a resource`), and its status CEL
  environment has no `schema` identifier, so a leaf that references no resource
  is left unset and the declared status schema promises a field the custom
  resource never carries — invisible until now, because TypeKro hydrated those
  leaves client-side in `getStatus()`. Two shapes are reported: a bare
  **literal** (a reference-free CEL expression counts as one; KRO drops it the
  same way), and a bare **`schema.spec.*` reference**, which looks resolvable
  because the CR does hold the value in its own spec but has no resource to
  project from. A `schema.spec.*` INSIDE an expression that also references a
  resource stays valid — the resource supplies the dependency KRO requires. The
  diagnostic names every offending path, says which shape it is, and suggests
  projecting the value through an owned resource (echo it into a ConfigMap or an
  annotation and read it back) or dropping the field. `allowLiteralStatus`
  selects the severity, on the composition or on the factory (the factory wins,
  so CI can hold a graph it does not own to projection). It defaults to warn for
  this release and flips to error in the next major — set
  `allowLiteralStatus: false` now on compositions you want held to projection.
  Direct mode is unaffected: it assembles status locally, with no reconciler, so
  both shapes are legitimate there.
- KRO-mode serialization now fails when a runtime `schema.spec.*` value decided
  build-time structure — which resources exist, how long a list is, or what an
  object's keys are called. A ResourceGraphDefinition is fixed at build time, so
  compositions that branched on a spec value, enumerated a map-typed spec field,
  or read `.length` off a spec collection previously emitted a well-formed graph
  that silently encoded the build-time guess for every instance. The diagnostic
  names the resource, the `spec.<path>`, what the graph actually encodes, and the
  two legitimate shapes: make it a build-time factory option, or keep the
  structure fixed and pass the spec value as a plain field. Detection covers
  spec-derived object keys and resource ids, build-time enumeration of map-typed
  fields, collections collapsed to a single element outside a `forEach`,
  predicates that reach the spec only through a local binding, `switch` on a spec
  discriminant, and `.length` reads outside status expressions. Control flow
  TypeKro already compiles — `if (spec.x)`, `if (spec.x === 'y')` and
  `spec.items.map(...)` — is unaffected, as are all value positions.
  `allowStructuralSpecDependence: true` in the composition options downgrades the
  error to a warning naming every path, for migrating an existing composition;
  `TYPEKRO_STRUCTURAL_SPEC=strict` re-enables it everywhere to audit a repository.
- `Cel.firstWhereHas()`, `Cel.firstOf()` and `Cel.loadBalancerAddress()` project
  an optional nested list — a Service's `status.loadBalancer.ingress`, a
  HelmRelease's `status.history` — in the one guard form cel-js and cel-go both
  accept. They chain a `has()` guard for every hop of the path, select entries
  with `filter`, and keep the index inside a lazy ternary, so an absent
  intermediate object yields the fallback instead of an evaluation error. The
  list is a field selected off a resource or schema proxy, so `field` is checked
  against the element type and the projection is typed from the field it
  projects. `Cel.unsafeListPath()` names a list by its CEL path for the case
  where no proxy is in scope, such as a bootstrap composition naming a graph
  resource by id.
- Every emitted status CEL expression is now checked against both CEL dialects
  at serialization time: cel-js's own parser, plus a curated denylist of
  confirmed cel-go divergences. Each rule declares whether it is a proven
  `divergence` — `has()` on an index expression, and a `has()` guard written
  after the access it guards — or a `note`, which is reported but never fails.
  Notes cover a form neither engine accepts (JavaScript that leaked through the
  expression converter), a form whose divergence would depend on a CEL type the
  serializer cannot see (`in` on something that may be a message list entry),
  and an expression past the analysis budget. A finding names the status leaf,
  the expression and the dialect. Divergences warn by default and fail
  serialization under `strictCelDiagnostics` / `TYPEKRO_STRICT_CEL=1`; notes
  never fail, so strict mode cannot reject valid CEL.
- `getStatusLeafDiagnostics()` reads the per-field diagnostics recorded during
  direct-mode status resolution.

### Changed

- **⚠️ Upgrade notes for ClickStack (Team defaults and `secretValues` connections).** See "Upgrading"
  in the ClickStack docs.
  - **The default composition now carries a chart-version guard.** The Team-defaults seed is on by
    default with inline credentials and writes HyperDX 2.35.0's schema, so a chart version other than
    3.2.0 is refused at render time, and the KRO CRD narrows `spec.version`. Users pinned to another
    chart must set `teamDefaults: false` or `teamDefaults: { allowUnvalidatedChartVersion: true }`.
    On KRO, the CronJob also checks the chart version at runtime and seeds nothing on an unaudited one.
    KRO 0.9.2 doesn't add a validation-only change to a CRD it already created (verified in its source
    and on a real cluster), so the CRD rule reaches new CRDs only.
  - **`secretValues` deployments get a `<release>-default-connections` ConfigMap in `valuesFrom`**,
    before the caller's Secret. The seed is opt-in there.
  - **A Team HyperDX already gave the wrong connection is never repaired.** This includes the chart's
    "Local ClickHouse", which a `secretValues` + `initialUser` registration used to get. The Team isn't
    empty, so fix the connection in HyperDX's UI.
  - **The HelmRelease's `hyperdx.deployment.defaultConnections` / `defaultSources` are Helm templates
    now, in both modes**, which the chart's `tpl` renders into `DEFAULT_CONNECTIONS` /
    `DEFAULT_SOURCES`. Anything that read them from the HelmRelease as JSON must render them first.
  - **`clickhouse.host` values that break the connection URLs are now refused:** an empty value;
    whitespace, `/`, `\`, `?`, `#` or `@`; a scheme; a port; a bracketed value that isn't IPv6;
    unbracketed IPv6; non-ASCII or other characters outside letters, digits, `.`, `-` and `_`; and
    shorthand IPv4. Trailing-dot FQDNs and bracketed IPv6 still work.

- **Documentation and test examples use generic names.** The NATS JetStream examples use
  `ORDERS_EVENTS` / `orders.events.>`, the Envoy AI Gateway examples use the `x-acme-principal`
  header, and the semantic-planning RFP refers to downstream application platforms in general.

- **The CHI and the CHK no longer share one cluster-name rule.**
  `CLICKHOUSE_CLUSTER_NAME_PATTERN` (CHI) was
  `^[a-zA-Z]([a-zA-Z0-9-]{0,13}[a-zA-Z0-9])?$`; it is now `^[a-zA-Z][a-zA-Z0-9-]{0,14}$`.
  The CHK gets its own `CLICKHOUSE_KEEPER_CLUSTER_NAME_PATTERN` =
  `^[A-Za-z0-9-]*[A-Za-z0-9][A-Za-z0-9-]*$`, with the 15-byte cap carried by
  `ClickHouseKeeperClusterNameSchema` and by the concrete assertion: **Altinity's CRD
  alphabet and cap, plus the one rule the operator's own naming requires (at least one
  alphanumeric)** (see `### Added`). The leading-letter rule below is justified for the CHI
  only: the keeper's generator emits `<server><id>/<hostname>/<port>` from HOST names
  (`pkg/model/chk/config/generator.go`, `getRaftConfig`) and the cluster name reaches only
  the sanitized macro behind generated StatefulSet / Service / ConfigMap names, where a
  leading digit is a fine DNS-1123 label. `clickHouseKeeperInstallation({ name: '9keeper' })`
  was valid upstream and is valid again, and `-keeper`, `keeper-` and `2024` are accepted
  too.

  AT LEAST ONE ALPHANUMERIC IS REQUIRED, and it is the only thing added to the CRD's rule.
  An ALL-DASH name (`-`, `---`) satisfies Altinity's `^[a-zA-Z0-9-]{0,15}$`, so admission
  accepts it — and the object then cannot reconcile. The operator feeds the cluster name
  through its short-name sanitizer `strings.Trim(s, "-_.")`, which strips every leading and
  trailing `-`, `_` and `.`, so an all-dash name sanitizes to the EMPTY string; the CHK
  (whose `pdbManaged` defaults to true) names the PodDisruptionBudget it creates by the
  pattern `chk-{chk}-{cluster}`, which then yields e.g. `chk-keeper-` — a name ending in a
  dash, invalid as Kubernetes metadata. The CHI needs no equivalent rule: its
  leading-letter requirement already guarantees an alphanumeric, so a CHI cluster name can
  never be all dashes.

  A TRAILING DASH IS NOW ACCEPTED ON BOTH — `cluster-` is legal under the CRD's
  `^[a-zA-Z0-9-]{0,15}$`, `-` is a legal XML `NameChar` in every position but the first,
  and `chi-<chi>-cluster--0-0` is still a valid DNS-1123 label, so the old prohibition was
  cosmetic. This widens what is accepted, so nothing that used to build stops building. The
  backup CronJob's in-container guard drops the matching `*-` case arm.

  THE LEADING-LETTER RULE IS KEPT, deliberately, and it is stricter than the CRD. The
  operator writes the cluster name VERBATIM AS AN XML ELEMENT NAME when it renders
  `remote_servers.xml` — `util.Iline(b, indent, "<%s>", cluster.GetName())` in
  `pkg/model/chi/config/generator.go` (release-0.27.1), with no escaping — and an XML
  `NameStartChar` may be neither a digit nor a hyphen. A cluster named `9cluster` therefore
  produces `<9cluster>`, an unparseable `remote_servers.xml`, and a server that will not
  start, so such a name was never a working deployment. It stays on the CHI ONLY; the
  keeper takes no LEADING-character rule at all.

- **The ClickHouse cluster composition's status-contract ConfigMap is renamed** from
  `<installation>-contract` to `<installation>-clickhouse-contract`
  (`CLICKHOUSE_CONTRACT_CONFIGMAP_SUFFIX`); its keys are unchanged. Affected: anything
  OUTSIDE the resource graph that read the old object by name — a GitOps check, a
  dashboard, a script doing `kubectl get configmap <installation>-contract`. Readers
  inside the graph are unaffected, because the status projection reaches it through its
  graph resource id (`clickhouseContract.data.*`), not by object name.

  The old name collided with the ClickStack bootstrap composition's own
  `<release>-contract`, so a stack whose ClickHouse cluster and ClickStack release were
  both named after the stack — the normal way to name one — put two independently-owned
  ConfigMaps on one `(kind, namespace, name)`, and KRO refused the second instance on its
  first deploy: `resource belongs to a different ApplySet: <ns>/<release>-contract
  (ConfigMap) belongs to ApplySet "<A>", cannot reassign to "<B>"`. The two ConfigMaps are
  different contracts — the ClickHouse one carries the database/ports/user and the
  durability block, the ClickStack one the app ports and retention — so neither
  composition could consume the other's; they only ever collided on the NAME. The
  ClickStack bootstrap remains the sole declarer of `<release>-contract` and is untouched;
  component-scoping the ClickHouse one follows the convention the Envoy AI Gateway family
  already used (`<name>-platform-contract`, `<name>-gateway-contract`).

  UPGRADING AN EXISTING STACK HAS A TRANSIENT CONFLICT WINDOW. The end state is
  conflict-free, and a unit test pins it: after the rename the ClickHouse cluster declares
  only `<installation>-clickhouse-contract` and no longer mentions `<installation>-contract`
  anywhere, so once its instance reconciles the old ConfigMap falls outside its ApplySet and
  KRO prunes it, leaving the name free for the ClickStack bootstrap. The ORDER of those two
  reconciles is not guaranteed, though: the two instances are separate
  ResourceGraphDefinitions with no dependency between them, and ApplySet pruning is KRO's
  own server-side behaviour — there is no ordering to assert offline. If both are upgraded at once, the ClickStack
  instance may briefly still see the ClickHouse instance as the owner of
  `<release>-contract` and be rejected with the ApplySet error. It clears on the next
  converge, once the ClickHouse instance has reconciled; re-applying the ClickStack instance
  (or simply waiting for the next reconcile) is the whole remedy, and no data is involved —
  both objects are status-projection ConfigMaps. To avoid the window entirely, let the
  ClickHouse cluster reconcile first, then apply the ClickStack bootstrap.

  A reusable guard comes with it: `assertNoDuplicateDeclarations` renders any set of
  compositions against one name and namespace and fails on any
  `(group, kind, namespace, name)` declared by more than one of them — the API GROUP is part
  of the identity (two `Widget`s from different groups are different objects) while the
  VERSION is not (one group/kind/name at two versions is one stored object, so it is still
  reported). It is applied across the compositions that
  realistically co-exist in a namespace — ClickStack bootstrap, ClickStack k8s telemetry,
  the ClickHouse cluster and the keeper.

- `HelmReleaseSpec` gained `install.crds` and `upgrade.crds`
  (`HelmReleaseCrdsPolicy`). Flux defaults the upgrade action to `Skip`, so a
  chart that ships its CRDs in `crds/` otherwise keeps serving the schemas it
  was first installed with.
- `HelmReleaseSpec` gained `releaseName`. Flux composes the Helm release name as
  `<targetNamespace>-<name>` whenever `spec.targetNamespace` is set and
  `spec.releaseName` is not, so the install namespace spends part of Helm's
  53-character release-name budget. The Traefik factory pins it to the `name` it
  already pins as the chart's `fullnameOverride`, which makes that factory's
  derived 53-character `name` limit exact and keeps the release name stable
  across a change of install namespace.
- Alchemy is upgraded to `2.0.0-beta.74`, bringing the current native provider
  catalog and Distilled AWS `1.0.0-rc.6`; TypeKro's Effect runtime cohort moves
  with it to `4.0.0-rc.110`. CI now locks all three dependency boundaries so a
  partial upgrade cannot silently reintroduce incompatible runtime copies.
- ClickHouse users may now source plaintext passwords through the Altinity
  operator's native `secretKeyRef` support, and ClickStack bootstraps may load a
  complete credential values fragment from a Kubernetes Secret through Flux.
  The Secret-backed ClickStack variant omits credential values and default
  connection passwords from RGD instances and HelmRelease inline values while
  preserving direct/KRO parity.
- The upstream Gateway API types and readiness evaluators that
  `envoy-ai-gateway` owned now live in the shared `typekro/gateway-api` module
  and are re-exported from `typekro/envoy-ai-gateway` unchanged. Every
  previously exported symbol, its behavior, and its portable
  readiness-strategy identifier are preserved, so serialized plans stay
  resolvable. `GatewaySpec` and `BackendTLSPolicySpec` are correspondingly more
  general (listener TLS, hostnames, allowed routes, non-Envoy target refs);
  `envoy-ai-gateway`'s `GatewayClassSpec` keeps its controller name pinned as a
  literal.
- ClickStack composition variants now expose explicit `namespaceOwnership`,
  allowing parent deployment graphs to manage the workload Namespace without
  introducing a second owner for the same Kubernetes object.
- KRO artifact bindings now use a topology-independent nested string-map
  schema, so adding or removing generated artifact outputs no longer changes
  the application CRD. Imperative and Alchemy deployments automatically migrate
  the released v0.32 fixed-property schema and resume interrupted migrations.
  GitOps users with existing v0.32 artifact-backed instances must follow the
  one-time `allowBreakingChanges` procedure in the migration guide before
  applying normal generated YAML.

### Fixed

- `clickhouseOperatorBootstrap` now stops the Altinity operator from copying
  another controller's ownership labels onto the objects it generates. The
  operator propagates a ClickHouseInstallation's labels to every ConfigMap,
  Service, StatefulSet and PVC it creates for it; in KRO mode the CHI is a
  graph child carrying KRO's ApplySet membership labels, so those labels landed
  on the operator's own children and KRO's pruning deleted them as members it
  no longer declared. The Pod could then never mount `chi-<name>-common-configd`
  and the CHI sat `InProgress` indefinitely with no error reported anywhere.
  The bootstrap now defaults the operator's `label.exclude` to the ApplySet and
  KRO ownership labels, which `customValues` can still override.
- `makeClickHouseCluster` accepts `name`/`kind` overrides for the generated
  ResourceGraphDefinition. The runtime spec schema is a product of the topology
  — declared users, a required keeper, and the `s3_plain_rewritable` version
  floor all appear only where they apply — and KRO refuses to update a
  generated CRD with a breaking schema change, so two different topologies
  deployed to one cluster previously made whichever was applied second fail
  with "breaking changes detected".
- The shared Flux HelmRelease readiness evaluator no longer reports ready while
  Flux is still installing. It previously accepted readiness evidence that did
  not describe the current release, so `waitForReady: true` on a Helm-backed
  bootstrap could return before the chart's workloads — and, for an operator
  chart, its CRDs — existed, and a consumer proceeding on `ready` failed. Ready
  now additionally requires every generation-bearing observation Flux publishes
  (the top-level `observedGeneration` and the `Ready`/`Released` conditions'
  own) to be exactly `metadata.generation` rather than merely not behind,
  `Reconciling` not to be `True` (Flux holds it for the whole install/upgrade,
  so a `Ready=True` beside it belongs to the previous release), `Stalled` not to
  be `True`, the revision Flux last attempted to be the revision actually
  released (the failed-upgrade-then-rollback shape), and a present `Released`
  condition to be `True`. The portable strategy revision is bumped so a graph
  serialized by an older TypeKro cannot rehydrate the looser evaluator.
- ClickHouse and ClickStack status contracts are now fully observable through
  KRO. Fields that came from the construction-time topology — the ClickHouse
  cluster's `clickhouse.port`/`database`/`user` and its whole `storage`
  durability block, and ClickStack's `version`, `app.appPort`/`apiPort` and
  `storage` block — were emitted as literals, which KRO drops from the instance
  status, so the declared schema promised fields the live custom resource never
  carried. Each composition now writes those values into a ConfigMap it owns
  (`<name>-contract`) and projects the status back from that resource, so
  `kubectl get clickhouseclusters -o yaml` shows the whole contract, durability
  included, in both factory modes.
- `makeClickHouseCluster` now carries the `s3_plain_rewritable` ClickHouse
  version floor into the generated KRO schema as a `pattern=` marker on
  `spec.version`, so an instance selecting a server that cannot run that
  metadata type is rejected by the API server. The construction-time check
  could not see a per-instance version in KRO mode and previously skipped
  silently; a concrete version it cannot parse (a moving tag, a digest pin) is
  now refused rather than assumed.
- A custom ClickHouse `storage.endpoint` is now parsed and validated part by
  part — scheme, userinfo, host shape, port range, query, fragment and path —
  instead of only passing a character allow-list, which accepted
  `http://key:secret@minio:9000` and wrote those credentials into the server's
  `config.d/storage.xml`. S3 bucket names are checked against the complete
  published general-purpose-bucket rule set, including the reserved `xn--`,
  `sthree-` and `amzn-s3-demo-` prefixes and the `-s3alias`, `--ol-s3`,
  `.mrap` and `--x-s3` suffixes; a dotted bucket name is refused on the AWS
  virtual-hosted endpoint the factory composes, where the wildcard certificate
  cannot cover the extra label.
- `ClickHouseInstallationConfigSchema` now models the S3 storage branch field by
  field, with the credential-transport and region-or-endpoint invariants encoded
  in the schema, and `ClickHouseInstallationConfig` is inferred from it. The
  schema previously described only the two fields common to both storage modes
  while the exported type was widened with the whole S3 configuration, leaving
  every S3 field unvalidated.
- A composition can now observe a resource its own release creates. An
  `observedResource` that declares `dependsOn` on resources in the same graph is
  read after those resources have been applied and are ready, retrying until the
  observed resource appears or the bounded read budget runs out, instead of in a
  single pass before anything is applied. A reference that never appears fails the
  deployment with an error naming the reference, its `dependsOn` targets and the
  elapsed wait; it is never silently skipped. References with no in-graph
  dependencies keep the existing up-front read, and KRO mode is unchanged.
- Waiting for an observed resource now stops on a failure that waiting cannot
  fix. A read that returns 401/403, 400/405/422, a 404 for an apiVersion/kind the
  cluster does not serve, or that throws a non-Kubernetes error fails the
  deployment immediately, naming the reference, its `dependsOn` targets, the
  classification and the API server's own message. Only a 404 for the object
  itself, 429, 5xx and transport failures keep polling, so a misconfigured
  reference no longer spends the whole read budget before reporting a generic
  timeout.
- The CloudNativePG bootstrap no longer drops an instance's `customValues`. The
  Helm values mapper enumerated the map-typed spec field at build time, so the
  emitted RGD carried a single placeholder key instead of the instance's chart
  overrides; it now routes a reference through the graph-aware runtime values
  merge, as the ClickHouse operator bootstrap already did.
- Direct-mode status fields now resolve independently. A CEL leaf that reached
  into an optional nested field the controller had not populated yet — the
  canonical case being `service.status.loadBalancer.ingress` on a Service with
  no address — threw during resolution and took the *entire* status object to
  unresolved, blanking `ready`, `failed` and `phase` along with it. Each leaf
  now has its own error boundary: the failing field comes back `undefined` and
  is reported with its path and error, and its siblings keep their values.
- The Rook, Envoy AI Gateway and OpenSearch compositions guarded their optional
  nested lists with a single `has()` on the full path, which raises "Identifier
  not found" under cel-js when an intermediate object is absent — exactly the
  state those lists are in before their controller populates them. All three
  now use the guarded-list helpers.
- Nested-composition status inlining is now linear in the size of the
  nested-status mapping. The inliner previously made up to 16 whole-string
  substitution passes, each re-scanning text the previous pass had
  substituted; once a mapping referenced its own flattened child id — the
  normal shape when that id is also a concrete graph resource — the emitted
  expression doubled on every pass, so a two-level composition could emit a
  6 MB status expression that exceeds the Kubernetes object size limit. Each
  `<id>.status.<field>` mapping is now resolved recursively with an
  in-progress set, substituted output is never re-scanned, and a mapping
  already being expanded on the current path keeps its concrete resource
  reference. Emitted YAML is unchanged for compositions that were not hitting
  the runaway path. The 16-level depth guard remains a safety net for
  genuinely deep, acyclic nesting and is now an error under strict CEL
  diagnostics (`strictCelDiagnostics` / `TYPEKRO_STRICT_CEL=1`).
- The nested-composition status inliner now reads the CEL text it rewrites by
  the language's own lexis, so a reference is expanded only where it really is
  one. A status field path carrying an index (`items[0].name`,
  `ports["http"].port`) matches its mapping key again instead of leaving a
  virtual id in the emitted RGD; the whole `STRING_LIT`/`BYTES_LIT` family is
  recognised — raw and bytes prefixes, both triple-quoted forms — so a token
  inside quoted data is left alone; `//` line comments are masked alongside
  string literals, so commented-out expression text is no longer expanded; and
  a CEL macro's lambda variable shields only the references inside that macro's
  body, so `list.map(svc, svc.status.x) && svc.status.phase` expands its second
  `svc` rather than treating both as the iteration element.
- A list index in a nested-composition status path now emits as an index in
  either of the two spellings it arrives in. A status proxy renders a numeric
  key as `items[0]`, but a nested mapping key for an array element is built
  dotted (`items.0`) — and a reference marker's field path admits that form
  too. The dotted form was read as a plain field name, so the inliner emitted
  `(inner).0.name`, which is not valid CEL and is rejected by both evaluation
  engines; and a mapping key stored under one spelling could not be reached
  from the other, leaving a virtual id in the emitted RGD. A whole segment of
  digits is now read as an index on the segment before it, so both spellings
  resolve to the same mapping and emit `(inner)[0].name`. Identifiers that
  merely contain digits (`v2`, `ip4`, `_0`) are unaffected.
- Every dotted numeric segment in a serialized reference path now becomes an
  index, not just the first one. The late rewrite that turns `items.0` into
  `items[0]` took its decision from the character before the run in its INPUT,
  so in a path into a nested list — `matrix.0.1.value` — the second run saw the
  digit the first run had just consumed and stopped, emitting
  `matrix[0].1.value`: still not valid CEL, and still rejected by both
  evaluation engines. The decision now reads the text already emitted, so runs
  chain, and it requires a whole identifier rather than a single identifier
  character, so `v2.0` indexes the identifier `v2` while the fractions of `1.0`
  and `2.5e3` stay untouched. Serialized output is unchanged for every path
  that was already valid.
- Public Discord links now use the current community invitation.
- TypeKro's frozen and published dependency graphs now pin `js-yaml` 4.3.1
  and `angular-expressions` 1.5.2 so both runtime dependencies include their
  current security patches.
- Alchemy KRO teardown no longer mistakes the declaration set's own terminating
  instance for a foreign consumer of its ResourceGraphDefinition. The RGD now
  remains a hard, finalizer-aware deletion gate instead of reporting success,
  dropping retry state, and leaking the live definition.
- NATS bootstraps now consume one explicit cluster-wide NACK singleton in
  CRD-connect mode instead of installing a competing non-namespaced controller
  per NATS instance. The official NACK chart uses fixed ClusterRole and
  ClusterRoleBinding names; deleting one former installation could therefore
  remove RBAC from another live controller. Stream and Consumer resources keep
  per-resource NATS routing, shared controller configuration is concrete
  build-time input through `makeNatsBootstrap()`, protected values preserve the
  multi-system routing model, and consumer deletion no longer owns controller
  teardown. The singleton uses TypeKro-prefixed service-account/RBAC names so
  even a controller named `jetstream` can become ready alongside a v0.33.5
  controller; direct deploy then performs UID-leased retirement of the exact
  legacy HelmRelease while recognizing a current NATS server itself named
  `nack`, and KRO/Alchemy use normal graph pruning.
- Direct dependency planning now resolves composition callback and
  local-variable aliases to their canonical graph resources, fails closed when
  an alias is ambiguous, and reports repeated unknown references only once per
  source resource.
- Confirmed Harbor project teardown with `purgeRepositories: true` now removes
  project immutable-tag rules before deleting repositories. TypeKro-managed
  immutability no longer blocks its own exact-name-confirmed lifecycle with
  Harbor HTTP 412, and robot Secrets remain until project deletion completes.
- Rook managed platforms now pin one OBC provisioner prefix on both the
  operator and StorageClass instead of disabling namespace scoping on only the
  operator. External-operator platforms accept either the matching prefix or
  an exact provisioner identity, preventing permanently pending OBCs across
  namespace-scoped, custom-prefix, and global Rook configurations.
- The managed Ory identity stack's default Kratos schema now marks its email
  trait as a password-credential identifier. Identities created through the
  Admin API can therefore complete password login without requiring consumers
  to replace the otherwise usable default schema.
- Direct and Alchemy deployments now materialize TypeKro's internal Helm-values merge expressions
  before encoding the canonical artifact record. Concrete chart overrides therefore deep-merge with
  integration defaults instead of leaking `__typekroValuesMerge` as literal Helm values; KRO keeps
  its graph-aware CEL merge behavior.
- Restart-safe KRO artifact-binding migration now resolves an omitted schema group to KRO's
  documented `kro.run` default. Repeated deployments of otherwise valid default-group compositions
  no longer fail while inspecting the generated CRD.
- Direct Alchemy singleton owners now gate consumer scheduling through a dedicated barrier instead
  of being injected into each consumer's canonical live-resource dependencies. This preserves
  singleton readiness ordering without making direct artifact execution records fail dependency
  parity during materialization.
- Automatic KRO artifact-binding migration now replaces the complete generated CRD with
  resource-version concurrency rather than sending a partial merge patch through
  `KubernetesObjectApi`. This avoids the client serializer's `data is not iterable` failure while
  retaining restart-safe conflict retries. Version-only schemas correctly resolve to KRO's default
  `kro.run` API group during migration.
- Artifact-binding migration now also replaces the complete ResourceGraphDefinition with
  resource-version concurrency. This avoids the same client serializer failure when an RGD update
  contains array-valued resources, while preserving live metadata and omitting status.
- Semantic planning now represents ArkType's explicitly open `object` and
  `object[]` nodes—including root `type('object')` schemas and ordinary or
  `ignore` undeclared-key policies—without falsely opening `reject`/`delete`
  shapes. The Kubernetes Secret factory also records its exact
  lowercase factory provenance, so managed Ory platform compositions produce
  valid strict plans when both `Secret` registrations are loaded.
- Direct Alchemy declarations now recursively materialize singleton-owner
  compositions, preserve their spec fingerprints, order consumers after the
  complete owner graph, and retain shared owner resources. Compositions whose
  entire direct surface is a singleton reference, such as the shared
  OpenSearch operator bootstrap, no longer report a successful empty plan.
- Portable direct-plan materialization now evaluates KRO's `dyn()` type
  widening as runtime identity, matching the other direct CEL evaluators and
  preserving structured defaults inside recursively materialized owners.
- Envoy AI Gateway platform installations can declare their controller
  namespaces externally owned, allowing a parent Alchemy graph to establish a
  generated credential before the platform Helm releases without competing
  Namespace owners.
- Ory identity and platform stacks can declare their target namespace
  externally owned when a parent deployment graph is the lifecycle authority.
- **Arktype `object` now maps to KRO `object` instead of `string`.** A bare `type('object')` is represented by
  arktype as the string `"object"`, which the KRO type mapper had no case for, so it fell through to the
  `string` default. Every schemaless-object field was therefore declared `string` in the generated RGD and KRO
  admission dropped whatever object a caller sent. `object[]` is fixed by the same change (the array branch
  recurses). Affects any factory using `type('object')` for passthrough config — Dagster, APISIX, Ory,
  ClickHouse — not just Dagster.
- **Dagster's raw `values` escape hatch is genuinely opaque.** It had been assigned the fully typed
  `helmValuesSchemaShape`, making a CLOSED schema out of a field documented as *raw official chart values*; its
  `postgresql` sub-shape reused the convenience shape, so bundled-subchart settings (`primary.*`,
  `nodeSelector`, `persistence`) were unreachable through either documented route. Typed convenience remains on
  the high-level API (`postgresql`, `webserver`, `runLauncher`, …).

### Added

- **Always-on KRO label-propagation guard.** `typeKroRuntimeBootstrap()` now installs a cluster-scoped
  `MutatingAdmissionPolicy` enforcing that only KRO may introduce KRO's ownership labels on an object.
  Operators that copy the parent CR's whole label map onto their children previously handed KRO's ApplySet
  pruner objects it never applied, which it then deleted on every requeue (`kubernetes-sigs/kro#1153`).
  On CREATE the labels are removed if present; on UPDATE only if absent from the old object, so labels KRO
  already placed survive Flux patches, HPA scaling and human annotations. `spec.selector` on a Service and a
  workload's pod-template labels are covered too, so the guard cannot create a selector mismatch, and
  `failurePolicy: Ignore` means a guard that cannot evaluate never blocks a write. There is no config
  option; `TYPEKRO_DISABLE_LABEL_GUARD=1` is the documented break-glass. The bootstrap reports
  `status.labelPropagationGuard: 'active' | 'unavailable'`. Pre-existing operator children that already
  carry the labels self-heal through one prune-and-recreate cycle; expect a minute of churn the first time.

  The policy's group version is **discovered, never assumed**: `MutatingAdmissionPolicy` is beta at
  `admissionregistration.k8s.io/v1beta1` on Kubernetes 1.34/1.35, GA at `.../v1` from 1.36, and absent below
  1.34. Direct-mode deployment runs API discovery for the group against the cluster it is deploying to
  before it materializes the graph, so the applied policy always carries the version that cluster serves.
  Where nothing can be resolved — no pin and no cluster, as in an offline `toYaml()` render — the guard is
  skipped with a warning and the status projects `'unavailable'`, rather than emitting a GA policy that a
  1.34 cluster would reject and so fail the apply of the whole bootstrap.
  `TYPEKRO_LABEL_GUARD_API_VERSION` pins the version for exactly those offline renders.

  A build that targets a cluster says so **explicitly**. `probeLabelPropagationGuardSupport(kubeConfig)`
  returns the resolved capability and `withLabelPropagationGuardCapability(capability, () => build())`
  scopes it to one build; `factory('direct').deploy()` does the equivalent internally. There is no ambient
  "last cluster anyone probed" fallback, which previously let a probe of cluster A supply the group version
  for an untargeted build meant for cluster B.
- **Cluster API capability resolution.** `resolveClusterCapability()` and the deploy-time capability
  registry behind it discover which group version a cluster serves a kind at, caching per **cluster
  identity** (server URL, CA material, context cluster name) with a bounded lifetime and entry count, so a
  process talking to two clusters never reuses one cluster's answer for the other.
  `resetLabelGuardCapabilityCache()` clears it for tests.

  Discovery is **three-way**: `served`, `unserved`, `unknown`. `unserved` is reported only when the API
  server actually answered — a 404 for the group version, or a resource list without the kind — and is
  cached for the full lifetime. Every other outcome (unreachable server, RBAC, timeout, TLS) is `unknown`,
  carries the classified reason, and is never cached as an answer: the next call re-probes. Previously all
  of these collapsed into `unserved`, so a transient error made the guard report "the cluster does not serve
  MutatingAdmissionPolicy" — and cached that false claim for five minutes.
- **`KRO_OWNERSHIP_LABELS`.** The shared set of label keys only KRO may introduce, exported from the package
  root for operator-side propagation filters and for the new `assertNoForeignApplySetLabels()` e2e assertion.
  It adds `kro.run/kro-version` to the four keys factories were copying privately: a KRO upgrade rewrites
  that value, and an operator that re-derives a Service selector from the parent's labels moves the selector
  off its own running pods.
- **`mutatingAdmissionPolicy()` / `mutatingAdmissionPolicyBinding()`.** Typed factories for KEP-3962 mutating
  admission policies, at either the beta or GA group version.
- **`allowBreakingChanges` factory option.** Stamps `kro.run/allow-breaking-changes: "true"` on the generated
  RGD. The same option already existed at composition level, but a consumer of a SHIPPED composition
  (`dagsterBootstrap`, `apisixBootstrap`, …) cannot reach that, so there was no way to migrate an
  already-deployed RGD. Off by default.

### ⚠️ UPGRADE NOTE — existing deployments need one authorized converge

The `object` correction changes the DECLARED TYPE of existing RGD fields (52 of them in the Dagster RGD alone).
KRO refuses breaking CRD updates, **and the refusal is silent**: the apply succeeds, the RGD reports
`Ready=True`, and the registered CRD keeps its OLD schema. The only evidence is a controller log line:

```
cannot update CRD <plural>.kro.run: breaking changes detected: Type changed from string to object; ...
```

So an upgrade can appear to land while nothing changed and values continue to be pruned. To migrate, authorize
it for the one converge that performs the change:

```ts
myComposition.factory('kro', { allowBreakingChanges: true })
```

then drop the option again. Verify with:

```
kubectl get crd <plural>.kro.run \
  -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.values.type}'
```

It should print `object`. Deleting and recreating the RGD also works (KRO re-registers the CRD from scratch)
but destroys existing custom resources, so prefer the annotation. Do not enable it globally: it disables a real
safety check, and a genuinely lossy change (narrowing a type, dropping a field) can strand existing CRs.

## [0.21.0] - 2026-07-02

### Added

- Added computed status aliases so status builders can name and reuse JavaScript
  expressions while preserving KRO CEL generation.
- Added `computed`, `alias`, and `aliases` helpers for explicit status expression
  aliasing, plus lexical alias inlining for common local variable patterns.

## [0.20.3] - 2026-07-01

### Fixed

- Fixed Dagster KRO ResourceGraphDefinition admission for the default daemon liveness probe fallback.
  The generated CEL now `dyn(...)`-wraps both the user-provided probe branch and the default probe map
  branch, avoiding a `(bool, string, map)` ternary type mismatch while preserving per-instance
  override behavior.

## [0.20.2] - 2026-06-30

### Fixed

- Fixed KRO runtime values-merge CEL for optional scalar overlays when multiple chart values with
  different scalar types are merged together. Optional scalar branches are now `dyn(...)`-wrapped
  before falling back to `omit()`, keeping the enclosing merge operand typed as `map(string, dyn)`
  instead of producing incompatible per-field map value types.
- Applied the same `dyn(...)` wrapping to Dagster graph-mode global value fallbacks such as
  `serviceAccountName`, `postgresqlSecretName`, and generated celery config secret toggles.

## [0.20.1] - 2026-06-30

### Fixed

- Fixed KRO-invalid CEL emitted for **optional scalar** spec fields in the runtime values-merge.
  When a `values` block contained a CEL/ref (forcing the runtime map-merge), each optional overlay
  field was emitted as `.merge({ "X": has(spec.X) ? spec.X : omit() })`. KRO types `omit()` as
  `map(string, dyn)`, so for a scalar field the ternary `bool ? <scalar> : map(string, dyn)` failed
  to compile (`GraphAccepted=False` / `no matching overload for '_?_:_'`). Optional refs now emit a
  type-safe conditional single-key merge `.merge(has(spec.X) ? {"X": spec.X} : {})` (both branches
  maps), and the emitted value preserves the field's full expression (e.g. a `string(...)` conversion
  is not dropped to the bare path). Static maps and the field-level `has(x) ? x : omit()` form are
  unchanged.
- Fixed the alchemy KRO RGD deploy ignoring the factory's configured `timeout`: it hardcoded
  `DEFAULT_RGD_TIMEOUT` (60s) instead of honoring `factoryOptions.timeout` (the non-alchemy paths
  already did). A converge whose RGD legitimately takes >60s to reach ready (e.g. a Helm workload
  rollout) false-failed with `AbortError: Delay aborted`.

## [0.20.0] - 2026-06-30

### Changed

- **BREAKING (pre-1.0 minor):** Alchemy resource scope is now metadata-driven rather than inferred from a centralized Kubernetes kind list. Factory-created cluster-scoped resources serialize their `scope: 'cluster'` metadata into Alchemy state, and raw manifests must declare `scope: 'cluster'` explicitly when they are cluster-scoped. Legacy JSON-only Alchemy state without serialized scope is no longer reclassified by `apiVersion`/`kind`.
- KRO prerequisite resources now use the same per-resource scope metadata path across imperative deploys, GitOps YAML, and declarative Alchemy resources.

### Fixed

- ResourceGraphDefinition and other factory-created cluster-scoped resources no longer receive a deployment namespace when their scope metadata is present.
- Persisted Alchemy `scope` metadata is stripped before manifests are sent to Kubernetes.

## [0.19.0] - 2026-06-29

### Added

- Added Dagster daemon liveness probe support and related Alchemy/serializer hardening for external refs and conditional value rendering.

## [0.18.0] - 2026-06-26

### Added

- Added `kroPrerequisites` for KRO factories so prerequisite resources can be applied or emitted before
  the ResourceGraphDefinition. Resource prerequisites work across imperative deploys, GitOps YAML, and
  declarative Alchemy resources; live `beforeResourceGraphDefinition` hooks remain deploy-only.
- Added prerequisite handling for cluster-scoped resources, CRD readiness, and ordered Alchemy
  declarations so dependent prerequisites reconcile predictably before the RGD.

## [0.17.0] - 2026-06-15

### Added

- Caddy ingress: a build-time `makeCaddyIngress({ ephemeral?: boolean })` option. With `ephemeral: true`
  the `/data` volume is an `emptyDir` instead of the default PVC — Caddy's `tls internal` CA regenerates
  per pod, but the plane no longer depends on a single-AZ ReadWriteOnce volume that strands the pod
  (`Pending`, PV node-affinity mismatch) when a node/AZ changes under it. The choice is resolved when the
  composition is constructed (a real value, not a KRO spec field), so it selects the resource set
  statically and never needs an unsafe runtime conditional. The default `caddyIngress` is unchanged
  (PVC-backed). Ephemeral mode validates against a dedicated schema (`CaddyIngressEphemeralConfigSchema`)
  with no `persistence` field, so passing `persistence` config in ephemeral mode is rejected loudly
  rather than silently ignored.

## [0.16.0] - 2026-06-14

### Added

- Added a typed Caddy integration for config-driven reverse proxy deployments.

### Changed

- Caddy bootstrap is intentionally single-replica with `Recreate` rollout semantics because it owns a
  single ReadWriteOnce data volume.
- Direct-mode re-execution now hydrates `.spec` references from live Kubernetes resources, improving
  parity with KRO CEL status evaluation.

## [0.15.3] - 2026-06-12

### Fixed

- Fixed declarative Alchemy KRO custom-resource deploys so rehydrated CR instances regain the
  KRO readiness evaluator before waiting for readiness.

## [0.15.2] - 2026-06-12

### Fixed

- Fixed declarative Alchemy KRO resources so CR instance declarations honor the factory
  `waitForReady` option and default to end-to-end readiness, matching the imperative deploy path.

## [0.15.1] - 2026-06-12

### Fixed

- Fixed KRO status serialization so schema-only status fields are hydrated by TypeKro instead of
  being emitted into the ResourceGraphDefinition status schema.
- Fixed nested status expression handling so embedded template expressions remain valid CEL and
  resource-backed status fields continue to be emitted for KRO reconciliation.
- Fixed integration test typecheck regressions in the status hydration and Cilium test suites.

## [0.15.0]

### Changed

- **Alchemy integration migrated v1 → v2 (BREAKING).** TypeKro's alchemy integration now targets
  alchemy `2.0.0-beta` (Effect-based) instead of `0.62`. The dependency was bumped (`alchemy`
  `^0.62.3` → `2.0.0-beta.51`) and `effect` (`4.0.0-beta.75`) is now a direct dependency.

### Added

- **Declarative alchemy v2 resources.** `typekro/alchemy` now exports `KroResource` (an alchemy v2
  `Resource`), `kroProvider` (its provider `Layer`), `materializeAlchemyResources(KroResource, decls)`,
  and the `AlchemyResourceDeclaration` type.
- **`factory.toAlchemyResources(spec, opts?)`** on both direct and Kro factories — emits a typekro
  deployment as per-resource alchemy v2 declarations (KRO: any shared singleton owners + the RGD +
  one CR instance; direct: one per resolved resource, topologically ordered with `dependsOn`). Feed them to
  `materializeAlchemyResources` inside an alchemy Stack (with `kroProvider` merged into the runtime)
  to deploy them as unified-state, reverse-topo-torn-down resources. The v2 analog of the removed
  imperative path; see `docs/advanced/alchemy-integration.md`.

### Removed

- **The imperative alchemy v1 API.** Removed `ResourceGraph.deployWithAlchemy(scope)`, the
  `alchemyScope` factory option, `isAlchemyManaged` (on factories + `FactoryStatus`), the
  `AlchemyDeploymentStrategy`, dynamic per-kind provider registration, and the `Scope` re-export.
  Migration: replace `factory('…', { alchemyScope }).deploy(spec)` with
  `materializeAlchemyResources(KroResource, await factory.toAlchemyResources(spec))` inside your
  alchemy v2 Stack.

### Security

- `toAlchemyResources` persists the factory's `kubeConfigOptions` into alchemy state so a state-driven
  delete can reconnect. If the kubeconfig uses static credentials (`token`/`certData`/`keyData`) those
  are written to the state store. Prefer re-derived auth (`exec`, e.g. `aws eks get-token`, or
  `authProvider`) and a secured state backend.

## [0.12.0] - 2026-06-08

### Added

- **Dagster integration**: typed Helm values mapper, Flux HelmRepository/HelmRelease factories, and `dagsterBootstrap` composition for Dagster OSS deployments.
- **Dagster package export and documentation**: new `typekro/dagster` entry point with API docs and live direct/KRO validation coverage.

### Fixed

- Dagster graph-mode Helm values now preserve nested runtime references and CEL expressions, including global and subchart overrides.
- Dagster RabbitMQ credential conveniences now map to the official chart paths under `rabbitmq.rabbitmq.*`.
- KRO factory YAML generation now validates specs consistently with direct `deploy()` execution.

## [0.11.0] - 2026-06-07

### Added

- **Ory integration**: typed Ory Identity and Platform stack compositions with Hydra, Kratos, Keto, Oathkeeper, Maester resources, chart value contracts, upstream coverage, and API documentation.
- **Ory Helm utilities**: typed chart values mappers and resource factories for Ory Helm releases, OAuth2 clients, and Oathkeeper rules.
- **Helm runtime values coverage**: regression tests for graph-mode Helm values merging and runtime passthrough behavior.

### Changed

- SearXNG bootstrap configs now require an explicit secret source for enabled instances: either `server.secret_key` for an auto-created Secret or `secretKeyRef` for an external Secret.
- SearXNG KRO mode now rejects `enabled: false` instances; direct mode still supports disabled instances by creating no resources. KRO users should omit disabled instances instead.
- TypeKro runtime bootstrap now defaults to KRO `0.9.2` and Flux `v2.7.5` in examples and docs.

### Fixed

- Graph-mode Helm values now preserve runtime values during graph merges, including Ory chart values.
- Composed CEL operands are grouped correctly to preserve intended expression precedence.
- SearXNG KRO bootstrap status and resource guards no longer reference omitted resources for missing secret sources.
- Nested resource serialization and schema proxy handling were tightened for external refs, `omit()` conversion, and status field generation.

## [0.10.1] - 2026-05-04

### Fixed

- Nested direct-mode re-execution now binds non-intercepted live-status `Map` methods to the underlying map, fixing brand-check failures for three-level nested compositions.

## [0.10.0] - 2026-05-04

### Added

- **Typed resource aspects**: reusable, type-checked resource mutations that can target resources by kind/capability, selectors, slots, and IDs.
- **Aspect convenience helpers**: `withLabels()`, `withAnnotations()`, `withMetadata()`, `withEnvVars()`, `withEnvFrom()`, `withResourceDefaults()`, `withImagePullPolicy()`, `withReplicas()`, `withServiceAccount()`, `withLocalWorkspace()`, and `withHotReload()`.
- **Dedicated aspect exports**: new `typekro/aspects` package export path alongside top-level exports for aspect primitives and helpers.
- **Hot reload aspects**: `hotReload()` and `withHotReload()` support local-development container, volume, label, and replica overrides.
- **Aspect documentation**: guide and API reference for target semantics, selectors, slots, KRO safety constraints, and advanced `override({ spec: ... })` usage.

### Fixed

- KRO-mode aspect validation now rejects unsafe reference-backed composite mutations while preserving safe no-op mutations.
- Aspect selector and render-option validation now fails closed for malformed selector input and avoids mistaking arbitrary specs for render options.

## [0.9.0] - 2026-04-28

### Added

- **SearXNG integration**: `searxngBootstrap` composition and `searxng()` factory for deploying the SearXNG metasearch engine. Supports auto-created Secret (from `server.secret_key`) or external `secretKeyRef` for Vault / external-secrets-operator workflows.
- **Public singleton helper**: `singleton()` is exported from the root `typekro` entry point for shared-owner boundaries used by nested compositions such as `webAppWithProcessing`.
- **JS-to-CEL: native `if`/`else` control flow**: Composition bodies can now use plain JavaScript `if (!spec.optional) { createResource(...) }` patterns to generate KRO `includeWhen` directives. The framework's differential execution captures resources from untaken branches (using a hybrid schema proxy that overrides tested optional fields with `undefined`) and field-level differences between proxy and hybrid runs are auto-converted to CEL `has(...) ? ... : ...` conditionals on the emitted resource fields.
- **JS-to-CEL: truthiness-aware `has()` wrapping**: Bare `if (spec.optionalField)` now compiles to `has(schema.spec.optionalField)` in the emitted RGD. Required boolean fields still compile to their value read (`schema.spec.enabled`) because `has()` on a required field is trivially true.
- **Framework: `Cel.has(ref)` and `Cel.not(ref|expr)`**: Public CEL helpers for explicit escape hatches where the auto-conversion can't reach (rare; AST analyzer covers most cases).
- **Framework: nested-object ternary detection**: `analyzeFactoryArgTernaries` now recurses into nested object literals, so ternaries deep inside structured factory arguments produce template overrides at the correct dotted path.
- **KRO 0.9 `omit()` emission**: Optional spec fields without defaults now emit `${has(schema.spec.X) ? schema.spec.X : omit()}` CEL conditionals inline during ref-to-CEL conversion (no post-hoc YAML rewriting). Mixed-template fields and sub-path refs are intentionally left unwrapped.
- **`simple.Secret` proxy-value guard**: The `simple.Secret` factory now throws a descriptive error if any `stringData` value is a `KubernetesRef` proxy or a string containing a `__KUBERNETES_REF__` marker. Previously these would silently base64-encode the marker token, producing a valid-but-wrong Secret in KRO mode. The error message points at the low-level `secret()` factory which passes stringData through untouched.
- **Phase 1/2 default precedence**: `applyNullishDefaults` now supports an `overwrite` mode so Phase 2 (authoritative re-execution) can correct Phase 1 (regex fast-path) misfires on the same field. Phase 1 misfires on edge cases like multi-line `??` expressions; Phase 2 always runs and takes precedence.
- **Required-field sentinel hardening**: `extractDefaultsByComparison` now filters out NaN values (from numeric-coercion propagation of the required-field sentinel) in addition to the existing substring match, preventing silent type-confusion when a required numeric field is compared.
- **Integration-skill rules #30–#34**: Composition side-effect constraints; `simple.Secret` proxy-value trap (#31); native-TypeScript composition preference (#32); "fix the framework, don't work around it" (#33); differential-capture override scoping and compound-condition limitations (#34).

### Changed

- **BREAKING**: Default KRO version bumped from `0.8.5` to `0.9.2`. TypeKro's serialization pipeline now emits the KRO 0.9+ mixed-template CEL format (`literal${string(ref)}literal`) and uses the `CELOmitFunction` feature gate for `omit()` support. Existing clusters must upgrade KRO to 0.9.2+ with `--set config.featureGates.CELOmitFunction=true` (the `typeKroRuntimeBootstrap` bootstrap sets this automatically). Running TypeKro 0.8+ against KRO 0.8.x will cause RGD validation failures at reconcile time.
- **BREAKING**: Mixed-template CEL format — references embedded in template literals now emit as `${string(ref)}` wrapped rather than CEL string concatenation (`"literal" + ref + "literal"`). This requires KRO 0.9+.
- `webAppWithProcessing` now defaults `database.database` to `app` when omitted instead of deriving the database name from the app name.

### Fixed

- `applyTernaryConditionalsToResources` now properly escapes `"`, `\`, `\n`, `\r`, and `\t` in ternary truthy-branch literal text when embedding into CEL string literals. Previous versions only escaped `\n`, which was a latent bug for compositions with quoted YAML values in conditional sections.
- `resolveDefaultsByReExecution` now matches proxy-run and defaults-run resources by RESOURCE ID instead of by insertion order. Compositions with conditional `createResource` patterns (e.g., `if (!spec.x) { createResource(...) }`) produce different resource counts between runs, and positional matching silently paired unrelated resources and corrupted default detection. The SearXNG KRO integration test regressed on this until it was fixed.
- Differential field capture now narrows the override set to only optional fields that appear in AST-detected condition tests — previously, over-eager override of all optional fields made `spec.server?.secret_key` evaluate to `undefined` in hybrid runs and leaked empty values into captured resources.
- `pickConditionField` fallback now emits a `logger.debug` entry so multi-field-override cases where the heuristic guesses the controlling field can be diagnosed from the composition output.

### Deprecated

- The SearXNG factory's plaintext `server.secret_key` env-var delivery path is retained for direct-mode callers that manage their own secret injection, but using the `searxngBootstrap` composition (which auto-creates a K8s Secret) or providing an explicit `secretKeyRef` is strongly preferred. The plaintext path exposes the secret in `kubectl get deploy -o yaml` and should not be used in production.

## [0.8.0] - 2026-04-05

## [0.5.0] - 2026-03-16

### Added

- **Kro v0.8.x**: `forEach` directive for iterating over arrays in resource definitions
- **Kro v0.8.x**: `includeWhen` directive for conditional resource inclusion based on `schema.spec` fields
- **Kro v0.8.x**: `readyWhen` directive for custom readiness CEL expressions
- **Kro v0.8.x**: `externalRef` for referencing pre-existing cluster resources without managing their lifecycle
- **Security**: Replace `new Function()` calls with `angular-expressions` for safe expression evaluation
- **Tests**: 37 compile-time type tests covering 13 type system areas
- **Tests**: 29 unit tests for serialization pipeline (schema, validation, yaml)
- **Tests**: 26 unit tests for safe expression evaluation
- **Tests**: 30 unit tests for CRD schema fix logic
- **Tests**: E2E integration tests for Kro v0.8.x features (forEach, includeWhen, readyWhen, externalRef)
- Configurable HTTP request timeouts for Kubernetes API operations
- APISIX chart upgraded to 2.13.0 with orphan cleanup support
- `customResource()` factory now provides a default readiness evaluator (overridable via `.withReadinessEvaluator()`)
- APISIX admin credentials now configurable via `gateway.adminCredentials` in bootstrap config
- New subpath entry points: `typekro/advanced` for internal/advanced APIs and `typekro/alchemy` for Alchemy integration
- `arktypeToKroSchema` and `createWebService` added to main public API
- `RbacMode` and `TypeKroRuntimeConfig` types added for TypeKro runtime compositions
- Runtime typo detection for status field names (Levenshtein distance, debug mode only)
- WeakMap-based resource metadata store replacing non-enumerable object properties
- Factory registry with self-registration pattern replacing hardcoded allowlists
- Shared deployment infrastructure: `ResourceApplier`, `ReadinessWaiter`, `ResourceRollbackManager` extracted from engine
- `analyzeAndConvertStatusMappings` pipeline decomposed into named stages with `StageResult` pattern

### Changed

- **BREAKING**: Kro upgraded from v0.3.0 to v0.8.5 (OCI registry moved to `registry.k8s.io/kro/charts`)
- **BREAKING**: All factories now require explicit readiness evaluators (no default provided by `createResource`)
- **BREAKING**: `ResourceGraph` interface renamed to `DeploymentResourceGraph`
- **BREAKING**: `FactoryOptions` split into `PublicFactoryOptions` (user-facing) and `InternalFactoryOptions` (internal)
- **BREAKING**: `ResourceDeploymentError`, `ResourceReadinessTimeoutError`, `ResourceConflictError`, and `UnsupportedMediaTypeError` now extend `TypeKroError` instead of `Error`
- **BREAKING**: `KroResourceTemplate.template` field is now optional (to support the new `externalRef` alternative)
- Lower-level APIs moved to dedicated subpath exports: `typekro/advanced` (logging, K8s client, errors, CEL internals) and `typekro/alchemy` (Alchemy deployers and utilities)
- Ingress readiness evaluator rewritten to require actual controller signals instead of accepting empty status
- `autoFix.fluxCRDs` patching logs upgraded to warn level
- CRD schema fix logic consolidated from 3 files into `src/core/utils/crd-schema-fix.ts`
- Status builder context migrated from `globalThis` flag to `AsyncLocalStorage`
- 41 generic `throw new Error()` calls migrated to typed error classes
- 38 `as any` casts eliminated across 4 core files
- Cert-manager upgraded to 1.19.3
- `MutatingAdmissionWebhook` kind corrected to `MutatingWebhookConfiguration`
- `ValidatingAdmissionWebhook` kind corrected to `ValidatingWebhookConfiguration`

### Fixed

- `deploy()` hang caused by unbounded status hydration polling
- Deployment deadlocks in cert-manager helm mapping
- Hardcoded sleeps/timeouts replaced with polling and configurable values
- `getTimeoutForRequest()` now uses configured timeouts instead of hardcoded values
- Bun async abort errors in event monitor cleanup
- `Promise.allSettled` used in test cleanup to prevent cascading failures
- `CelEvaluationError` now extends `TypeKroError` instead of `Error`
- Missing exports for `ConversionError` and `StatusHydrationError` from barrel
- Race condition in `ensureFluxCRDsPatched` with concurrent deployments
- Timer leak in CRD JSON patch `Promise.race` (timeout never cleared)
- Async `setTimeout` unhandled rejection in deployment timeout handlers
- Incorrect `successCount` in partial deployment error (counted all resources, not just successful ones)
- Shared timeout budget across sequential namespace deletions (each namespace now gets its own timeout)
- Cert-manager Helm values spread overwriting carefully-built nested defaults
- Integration test `unhandledRejection` handlers now properly cleaned up in `afterAll`

### Removed

- ~70 lines of dead code in HelmRelease readiness evaluator
- Unused `WebhookConfig` interface from cert-manager types
- `CompositionFactory` type removed from main `'typekro'` barrel (still accessible via `typekro/advanced`)
- `UnsupportedPatternDetector` class removed entirely

## [0.4.0] - 2026-01-01

### Added

- Cilium ecosystem support: networking policies, L7 policies, gateway API integration
- Cert-manager ecosystem with CEL expressions and nested composition improvements
- Major deployment engine improvements
- APISIX bootstrap fixes
- Comprehensive unit tests for marker conversion

### Fixed

- Regex pattern for `__KUBERNETES_REF__` marker conversion
- Kro HelmRelease namespace to match ClusterRoleBinding (kro-system)
- CEL expression cloning and OCI HelmRepository readiness issues
- Cilium bootstrap composition export and test issues

## [0.3.1] - 2025-09-07

### Added

- JavaScript-to-CEL template literal conversion

### Fixed

- HTTP 415 error in Kubernetes API operations

## [0.3.0] - 2025-09-04

### Added

- JavaScript to CEL expression conversion system
- Standard npm publish workflow based on `package.json` version changes

### Fixed

- Preserve static values in status builder analyzer for performance
- Preserve undefined values in status builder analyzer
- Edge case bug fixes in expression handling

## [0.2.2] - 2025-08-27

### Fixed

- Grant `contents: write` permission for GitHub releases
- Documentation link standardization

## [0.2.0] - 2025-08-27

### Added

- Kubernetes events progress monitoring
- Imperative composition pattern with enhanced error handling
- Comprehensive Alchemy test coverage
- Production-ready repository infrastructure (CI, coverage, Dependabot)

### Fixed

- Circular reference hanging in deployment engine
- Comprehensive linting fixes

## [0.1.0] - 2025-08-08

### Added

- Initial release
- Type-safe Kubernetes resource composition with `toResourceGraph()`
- Magic proxy system for cross-resource references
- CEL expression support for status builders (`Cel.expr()`, `Cel.template()`)
- Factory functions: Deployment, Service, ConfigMap, Secret, Ingress, PVC, RBAC resources
- HelmRelease and HelmRepository factories for Flux CD
- YAML file resource factory
- Kustomize factory functions
- Direct deployment mode with readiness checking
- Kro deployment mode with ResourceGraphDefinition serialization
- Schema proxy with type-safe spec/status access

[Unreleased]: https://github.com/yehudacohen/typekro/compare/v0.21.0...HEAD
[0.21.0]: https://github.com/yehudacohen/typekro/compare/v0.20.3...v0.21.0
[0.20.3]: https://github.com/yehudacohen/typekro/compare/v0.20.2...v0.20.3
[0.20.2]: https://github.com/yehudacohen/typekro/compare/v0.20.1...v0.20.2
[0.20.1]: https://github.com/yehudacohen/typekro/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/yehudacohen/typekro/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/yehudacohen/typekro/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/yehudacohen/typekro/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/yehudacohen/typekro/compare/v0.16.1...v0.17.0
[0.16.0]: https://github.com/yehudacohen/typekro/compare/v0.15.4...v0.16.0
[0.15.3]: https://github.com/yehudacohen/typekro/compare/v0.15.2...v0.15.3
[0.15.2]: https://github.com/yehudacohen/typekro/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/yehudacohen/typekro/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/yehudacohen/typekro/compare/v0.14.0...v0.15.0
[0.12.0]: https://github.com/yehudacohen/typekro/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/yehudacohen/typekro/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/yehudacohen/typekro/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/yehudacohen/typekro/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/yehudacohen/typekro/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/yehudacohen/typekro/compare/v0.7.0...v0.8.0
[0.5.0]: https://github.com/yehudacohen/typekro/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yehudacohen/typekro/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/yehudacohen/typekro/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yehudacohen/typekro/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/yehudacohen/typekro/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/yehudacohen/typekro/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yehudacohen/typekro/releases/tag/v0.1.0
