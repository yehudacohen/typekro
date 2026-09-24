/**
 * ClickStack (HyperDX) Bootstrap Composition — EXTERNAL ClickHouse only.
 *
 * Deploys the OFFICIAL `clickstack` chart (3.2.x, MIT) from
 * https://clickhouse.github.io/ClickStack-helm-charts via HelmRepository and
 * HelmRelease resources. Build-around: we wrap the official chart — never
 * hand-rolled manifests. NOT the archived hyperdxio/helm-charts repo, NOT the
 * deprecated `hdx-oss-v2` chart, and NOT the `clickstack-operators`
 * prerequisite chart (its ClickHouse operator CRDs would collide with the
 * Altinity clickhouse-operator that manages our ClickHouseInstallation, and
 * it drags in a MongoDB operator we don't want).
 *
 * BUILD-TIME vs RUNTIME: `makeClickstackBootstrap(options)` constructs a
 * composition VARIANT. Options that decide WHICH resources exist (the Mongo
 * mode + its storage shape) and the static raw chart values are build-time —
 * plain JS may branch on them because they are always concrete. The runtime
 * spec carries only proxy-safe values (names, namespaces, endpoints,
 * versions, credentials); a user composing with `schema.spec.*` refs never
 * hits a JS branch on a proxy.
 *
 * What gets deployed:
 * 1. The target Namespace.
 * 2. The shared ClickStack HelmRepository singleton.
 * 3. Internal-Mongo variant only: a minimal single-replica Mongo
 *    StatefulSet + Service (`mongo:7`, no operator/CRDs/auth — APP METADATA
 *    ONLY, dev-first; see resources/mongo.ts for the loud caveats).
 * 4. The clickstack HelmRelease: HyperDX (UI/API/OpAMP) + the OTel gateway
 *    collector subchart, wired to the EXTERNAL ClickHouse
 *    (`clickhouse.enabled: false` and `mongodb.enabled: false` are hard-pinned
 *    by the values mapper and beat the build-time values passthrough).
 *
 * STATUS CONTRACT: beyond ready/phase, the status exposes `ui.url`,
 * `gateway.otlpHttpEndpoint` / `gateway.otlpGrpcEndpoint`, and
 * `app.host/appPort/apiPort` so downstream compositions (e.g.
 * `clickstackK8sTelemetry`) consume connection details without reconstructing
 * chart naming rules. The mapper pins `fullnameOverride` to the release name
 * to make that naming deterministic; endpoints are derived from the owned
 * HelmRelease resource's metadata (never `schema.spec.*` — KRO status CEL
 * cannot reference the instance spec).
 *
 * SCHEMA / REPLICATION CAVEAT: on first start the gateway collector's goose
 * migrations create `otel_logs` / `otel_traces` / `otel_metrics_*` /
 * `hyperdx_sessions` in the external ClickHouse as plain single-node
 * MergeTree tables. That matches a 1-replica CHI (our dev-first sizing);
 * multi-replica / `ON CLUSTER` schemas are NOT supported by ClickStack's
 * tooling — revisit (and see `CLICKSTACK_CLICKHOUSE_GUIDANCE`) before scaling
 * the CHI. Version coupling is loose: chart vendors CH 25.7, seed schemas
 * carry a <26.2 compat variant, and the optional JSON-typed schema
 * (`HYPERDX_OTEL_EXPORTER_CLICKHOUSE_JSON_ENABLE`) wants CH 25.3+.
 *
 * @example Internal Mongo (default)
 * ```typescript
 * const factory = clickstackBootstrap.factory('kro', { namespace: 'typekro-system' });
 *
 * await factory.deploy({
 *   name: 'clickstack',
 *   clickhouse: {
 *     host: 'clickhouse-observability.clickhouse.svc.cluster.local',
 *     username: 'otelcollector',
 *     password: '…',
 *   },
 *   apiKey: '…',
 * });
 * ```
 *
 * @example External Mongo (build-time variant)
 * ```typescript
 * const bootstrap = makeClickstackBootstrap({ mongo: { mode: 'external' } });
 *
 * await bootstrap.factory('kro').deploy({
 *   name: 'clickstack',
 *   clickhouse: { host: '…' },
 *   apiKey: '…',
 *   mongoUri: 'mongodb://user:pass@mongo.example.com:27017/hyperdx',
 * });
 * ```
 */

import type { V1CronJob, V1PersistentVolumeClaim } from '@kubernetes/client-node';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/portable-strategies.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import type { TypeKroValue } from '../../../core/types/common.js';
import { containsKubernetesRefs, isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import type { HelmReleasePostRenderer } from '../../helm/types.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { persistentVolumeClaim } from '../../kubernetes/storage/persistent-volume-claim.js';
import { cronJob } from '../../kubernetes/workloads/cron-job.js';
import {
  CLICKSTACK_API_PORT,
  CLICKSTACK_APP_PORT,
  CLICKSTACK_GATEWAY_NAME_SUFFIX,
  CLICKSTACK_OTLP_GRPC_PORT,
  CLICKSTACK_OTLP_HTTP_PORT,
  clickstackHelmRelease,
  DEFAULT_CLICKSTACK_REPO_NAME,
  DEFAULT_CLICKSTACK_REPO_URL,
  DEFAULT_CLICKSTACK_VERSION,
} from '../resources/helm.js';
import { clickstackMongoService, clickstackMongoStatefulSet } from '../resources/mongo.js';
import {
  type ClickStackBootstrapConfig,
  ClickStackBootstrapConfigSchema,
  type ClickStackBootstrapRuntimeConfig,
  ClickStackBootstrapStatusSchema,
  type ClickStackBuildOptions,
  type ClickStackExternalMongoBootstrapConfig,
  ClickStackExternalMongoBootstrapConfigSchema,
  type ClickStackExternalMongoBuildOptions,
  type ClickStackInlineExternalMongoBuildOptions,
  type ClickStackInlineInternalMongoBuildOptions,
  type ClickStackInternalMongoBuildOptions,
  type ClickStackMongoStorageOptions,
  type ClickStackSecretValuesBootstrapConfig,
  ClickStackSecretValuesBootstrapConfigSchema,
  type ClickStackSecretValuesExternalMongoBuildOptions,
  type ClickStackSecretValuesExternalMongoBootstrapConfig,
  ClickStackSecretValuesExternalMongoBootstrapConfigSchema,
  type ClickStackSecretValuesInternalMongoBuildOptions,
  type ResolvedClickStackInitialUser,
  assertClickStackReleaseName,
  CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION,
  CLICKSTACK_CONTRACT_CONFIGMAP_SUFFIX,
  CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV,
  CLICKSTACK_INITIAL_USER_MARKER_ID,
  CLICKSTACK_INITIAL_USER_VALIDATED_APP_VERSION,
  CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS,
  CLICKSTACK_RETENTION_NAME_SUFFIX,
  CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX,
  clickStackInitialUserVersionValidationRule,
  isClickStackInitialUserValidatedChartVersion,
  resolveClickStackInitialUser,
} from '../types.js';
import {
  DEFAULT_CLICKSTACK_NAMESPACE,
  mapClickStackConfigToHelmValues,
} from '../utils/helm-values-mapper.js';
import {
  CLICKSTACK_CONFIG_MAP_NAME,
  CLICKSTACK_SECRET_NAME,
  type ResolvedClickStackStorage,
  assertQueueReplicaCompatible,
  clickStackQueueClaimName,
  renderPersistentQueueClaimSpec,
  renderRetentionScript,
  resolveClickStackStorage,
} from '../utils/storage.js';
import {
  applyHyperdxOidcValues,
  CLICKSTACK_HYPERDX_OIDC_VALIDATED_APP_VERSION,
  CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS,
  hyperdxOidcPluginConfigMapData,
  hyperdxOidcPluginConfigMapName,
  isClickStackHyperdxOidcValidatedChartVersion,
  type ResolvedClickStackHyperdxOidc,
  resolveClickStackHyperdxOidc,
} from '../hyperdx-oidc/index.js';
import { clickstackHelmRepositoryBootstrap } from './clickstack-helm-repository.js';

/** Concrete, resolved build choices the composition body branches on. */
interface ResolvedBuildConfig {
  mongoMode: 'internal' | 'external';
  credentialSource: 'inline' | 'secretValues';
  /** Internal-Mongo PVC sizing (build-time; shapes the StatefulSet template). */
  storage?: ClickStackMongoStorageOptions;
  values?: Record<string, unknown>;
  /**
   * Caller-supplied Flux post-renderers, passed through to the HelmRelease
   * unchanged; the composition adds none of its own (the queue's `fsGroup`
   * rides on the `otel-collector.podSecurityContext` chart value).
   */
  postRenderers?: TypeKroValue<HelmReleasePostRenderer>[];
  /**
   * The EXTERNAL ClickHouse's storage story: retention DDL, the collector's
   * persistent queue, and the status contract. Distinct from `storage` above,
   * which is Mongo's PVC.
   */
  clickhouseStorage: ResolvedClickStackStorage;
  /** HyperDX OIDC sign-in wiring, when configured (see `hyperdx-oidc/`). */
  hyperdxOidc?: ResolvedClickStackHyperdxOidc;
  /**
   * The first HyperDX account the Team-bootstrap CronJob seeds, when one is
   * configured. Build-time: it is rendered into the CronJob's mongosh script.
   */
  initialUser?: ResolvedClickStackInitialUser;
}

const CLICKSTACK_CHART_PLACEHOLDER_API_KEY = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';

/**
 * Readiness for the collector queue's PersistentVolumeClaim.
 *
 * `Pending` counts as ready ON PURPOSE. The default binding mode of most
 * dynamic provisioners — and of kind's `local-path` StorageClass — is
 * `WaitForFirstConsumer`, which does not bind a claim until a Pod that mounts
 * it is scheduled. That Pod comes from the HelmRelease which DEPENDS on this
 * claim, so requiring `Bound` here would deadlock every such cluster. What
 * this evaluator does still catch is a claim the API server rejected the
 * provisioning of (`Lost`), and a claim whose status has not appeared at all.
 */
const clickstackQueueClaimReadiness = registerPortableReadinessEvaluator<V1PersistentVolumeClaim>(
  'typekro.readiness.clickstack.queue-claim',
  '1',
  (liveResource) => {
    const phase = liveResource.status?.phase;
    if (phase === 'Bound') {
      return { ready: true, reason: 'Bound', message: 'The queue claim is bound to a volume' };
    }
    if (phase === 'Pending') {
      return {
        ready: true,
        reason: 'WaitingForConsumer',
        message:
          'The queue claim is Pending — expected until the collector Pod is scheduled on a ' +
          'WaitForFirstConsumer StorageClass',
      };
    }
    return {
      ready: false,
      reason: phase === undefined ? 'NoStatus' : 'UnexpectedPhase',
      message: `The queue claim is in phase ${phase ?? '<none>'}, expected Bound or Pending`,
    };
  }
);
const clickstackTeamBootstrapReadiness = registerPortableReadinessEvaluator<V1CronJob>(
  'typekro.readiness.clickstack.team-bootstrap',
  '1',
  (liveResource) => {
    const status = liveResource.status;
    const scheduledAt = status?.lastScheduleTime
      ? new Date(status.lastScheduleTime).getTime()
      : Number.NaN;
    const succeededAt = status?.lastSuccessfulTime
      ? new Date(status.lastSuccessfulTime).getTime()
      : Number.NaN;
    if (
      Number.isFinite(scheduledAt) &&
      Number.isFinite(succeededAt) &&
      succeededAt >= scheduledAt
    ) {
      return {
        ready: true,
        reason: 'BootstrapCurrent',
        message: 'The latest ClickStack Team credential convergence succeeded',
      };
    }
    return {
      ready: false,
      reason: status?.active?.length ? 'BootstrapActive' : 'BootstrapPending',
      message: status?.lastScheduleTime
        ? 'The latest ClickStack Team credential convergence has not succeeded'
        : 'The ClickStack Team credential convergence has not run yet',
    };
  }
);
/**
 * Resource id of the owned ClickStack HelmRelease inside the graph.
 *
 * Extracted as a constant because the status now READS BACK from it
 * (`spec.chart.spec.version`), so the id appears in two places and must not
 * drift.
 */
const CLICKSTACK_HELM_RELEASE_RESOURCE_ID = 'clickstackHelmRelease';

/**
 * Resource id of the CONTRACT ConfigMap inside the composition graph.
 *
 * WHY THIS RESOURCE EXISTS. The HyperDX app/API ports and the whole `storage`
 * durability block come from the CONSTRUCTION-TIME build, not from the owned
 * HelmRelease. As bare constants they were dropped by KRO (status CEL cannot
 * express a literal-only leaf, nor reference `schema.spec.*`), so the declared
 * schema promised fields the live CR never carried — a GitOps consumer reading
 * `kubectl get clickstackbootstraps -o yaml` saw the ingest endpoints but not
 * what happens to the telemetry after it arrives. Writing them into a
 * ConfigMap this composition owns gives them a resource to be projected from,
 * and the ConfigMap is a readable artifact in its own right.
 *
 * @see https://github.com/yehudacohen/typekro/issues/188
 */
const CLICKSTACK_CONTRACT_RESOURCE_ID = 'clickstackContract';

const inlineSchemaFieldValidations = {
  apiKey: `self != "${CLICKSTACK_CHART_PLACEHOLDER_API_KEY}"`,
} as const;

/**
 * The DEGRADED script: reconcile the ingestion key by creating the Team
 * outright. Rendered only when `initialUser` is NOT configured.
 *
 * READ THIS BEFORE COPYING IT. Creating the Team here is what makes the stack
 * unreachable. HyperDX hands out exactly ONE registration per instance —
 * `POST /register/password` creates the first account AND its Team, then
 * answers 409 `teamAlreadyExists` forever after — so a Team that exists
 * without an account has SPENT that registration on nobody. The invite flow
 * needs an authenticated user to start from, so there is no way back in
 * (#227). This path exists because it is what shipped, and removing it would
 * break deployments whose ingestion key is already converged; it is not the
 * supported way to run the composition. Configure `initialUser`.
 */
const CLICKSTACK_TEAM_BOOTSTRAP_SCRIPT = [
  "const database = db.getSiblingDB('hyperdx');",
  'const apiKey = process.env.HYPERDX_API_KEY;',
  "if (typeof apiKey !== 'string' || apiKey.trim().length === 0) throw new Error('HYPERDX_API_KEY is required.');",
  `if (apiKey === '${CLICKSTACK_CHART_PLACEHOLDER_API_KEY}') throw new Error('HYPERDX_API_KEY must override the published ClickStack chart placeholder.');`,
  "const hookId = 'typekro-managed-ingestion';",
  'const teams = database.teams.find({ hookId }).toArray();',
  "if (teams.length > 1) throw new Error('Multiple TypeKro-managed ClickStack Teams exist.');",
  'if (teams.length === 0) {',
  '  const now = new Date();',
  '  database.teams.insertOne({',
  "    name: 'Applik8s Observability',",
  '    allowedAuthMethods: [],',
  '    hookId,',
  '    apiKey,',
  '    collectorAuthenticationEnforced: true,',
  '    isMetricsSeriesTableEnabled: false,',
  '    createdAt: now,',
  '    updatedAt: now,',
  '  });',
  '} else if (teams[0].apiKey !== apiKey || teams[0].collectorAuthenticationEnforced !== true) {',
  '  database.teams.updateOne({ _id: teams[0]._id }, {',
  '    $set: { apiKey, collectorAuthenticationEnforced: true, updatedAt: new Date() },',
  '  });',
  '}',
].join('\n');

/**
 * Render the mongosh script the bootstrap CronJob runs.
 *
 * THE UPSTREAM INVARIANT. HyperDX bootstraps on a first-run-claims-the-instance
 * pattern. The first visitor to `POST /register/password` creates the account,
 * creates the Team, and has `setupTeamDefaults` provision that Team's
 * ClickHouse connection and its log/trace/metric/session sources; registration
 * then closes behind them (409 `teamAlreadyExists`). Exactly one registration
 * exists, and whoever spends it becomes the administrator. A stack that reaches
 * a human with that registration unspent is a working stack — the chart alone
 * ships one.
 *
 * WHAT TYPEKRO USED TO DO TO IT. Creating the Team directly, to pre-seed the
 * ingestion key, spends the registration without producing the account: one
 * Team, zero users, a login page nobody can satisfy, and no connections or
 * sources either (#227). {@link CLICKSTACK_TEAM_BOOTSTRAP_SCRIPT} is that
 * behaviour, kept for compatibility and documented as degraded.
 *
 * WHAT IT DOES NOW, WITH `initialUser`. It spends the registration the way
 * upstream intends — through the app's own endpoint — and then patches only
 * what it actually needs:
 *
 *  1. BOOTSTRAP-ONCE, ON DURABLE STATE OF OUR OWN. The outer guard is a marker
 *     document in {@link CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION}, not the
 *     presence of a user or a Team. "Has TypeKro ever bootstrapped?" and "does
 *     an account exist right now?" are different questions, and answering the
 *     first with the second means an account an operator DELETED ON PURPOSE is
 *     recreated by the next minute's run. The marker is written on both exits —
 *     after registering, and on discovering the instance was already claimed —
 *     because from either point on the account lifecycle belongs to HyperDX and
 *     to humans. `$setOnInsert` means an existing marker is never restamped.
 *  2. REGISTER, DO NOT EMULATE. The POST carries `{email, password,
 *     confirmPassword}`. The app writes the user document, derives its own
 *     salt/hash with its own parameters, generates its own `accessKey`, creates
 *     the Team and runs `setupTeamDefaults`. TypeKro reproduces none of that, so
 *     none of it can drift. A 409 `teamAlreadyExists` means a human beat the
 *     CronJob to it, which is a SUCCESS: the instance is claimed, which is the
 *     whole objective. A 400 is relayed with the endpoint's own body, which
 *     names the offending field far better than a second copy of its rules
 *     could — and a rejected registration is not a consumed one, so a bad
 *     password costs a failed run and nothing else.
 *  3. PATCH ONLY `teams.apiKey`. The collector holds a pre-shared ingestion key
 *     from the chart's Secret, so the Team the app just created has to carry
 *     that key. One `updateOne`, and it runs on EVERY pass — not just the
 *     bootstrap one — so a rotated Secret still converges. This is the entire
 *     remaining coupling to HyperDX's private schema, and the reason
 *     {@link CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS} still exists.
 *  4. THE PASSWORD IS ONLY REQUIRED WHERE IT IS USED. The env var is wired
 *     `optional: true` at the Kubernetes level, so an absent Secret key cannot
 *     stop the container from starting and thereby break ingestion-key
 *     reconciliation too. Presence is asserted INSIDE the branch that
 *     registers, so rotating the bootstrap password away afterwards is a no-op
 *     rather than a permanent reconciliation failure.
 *  5. AN API THAT IS NOT UP YET IS NOT A FAULT. The CronJob runs every minute
 *     and the HyperDX API may still be starting, so a connection failure is
 *     reported as the transient it is, in those words, instead of as a stack
 *     trace that reads like a broken deployment.
 *
 * @param initialUser - The resolved build-time option, or `undefined`
 * @returns The complete `--eval` script
 */
export function renderClickStackTeamBootstrapScript(
  initialUser?: ResolvedClickStackInitialUser
): string {
  if (initialUser === undefined) return CLICKSTACK_TEAM_BOOTSTRAP_SCRIPT;

  const passwordVar = initialUser.passwordEnvVarName;

  // mongosh resolves a promise returned by the LAST expression of `--eval` and
  // exits non-zero when it rejects, but it does NOT accept top-level `await`.
  // So the whole script is one async function, invoked as that last expression.
  return [
    'const main = async () => {',
    "  const database = db.getSiblingDB('hyperdx');",
    '  const apiKey = process.env.HYPERDX_API_KEY;',
    "  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) throw new Error('HYPERDX_API_KEY is required.');",
    `  if (apiKey === '${CLICKSTACK_CHART_PLACEHOLDER_API_KEY}') throw new Error('HYPERDX_API_KEY must override the published ClickStack chart placeholder.');`,
    `  const apiBaseUrl = process.env.${CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV};`,
    `  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.length === 0) throw new Error('${CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV} is required to register the initial HyperDX user.');`,
    // JSON.stringify is the escaping here: the address is embedded as a JS
    // string literal and never concatenated into the script raw.
    `  const initialUserEmail = ${JSON.stringify(initialUser.email)};`,
    // TypeKro's OWN state, in TypeKro's OWN collection — not an extra field on
    // an upstream-owned team or user document.
    `  const bootstrapMarkers = database.${CLICKSTACK_BOOTSTRAP_MARKER_COLLECTION};`,
    `  const initialUserMarkerId = ${JSON.stringify(CLICKSTACK_INITIAL_USER_MARKER_ID)};`,
    // Marker present => the instance was claimed under TypeKro's watch. Short
    // -circuit BEFORE looking at teams, the password, or the network at all.
    '  if (bootstrapMarkers.findOne({ _id: initialUserMarkerId }) === null) {',
    // A Team is what `/register/password` refuses on, so its absence is the
    // same question as "is the instance still unclaimed?".
    '    if (database.teams.countDocuments({}) === 0) {',
    `      const initialUserPassword = process.env.${passwordVar};`,
    `      if (typeof initialUserPassword !== 'string' || initialUserPassword.length === 0) throw new Error('${passwordVar} is required to register the initial HyperDX user, but the Secret key is absent or empty. Add the key to the Secret the CronJob reads, or drop initialUser from the composition.');`,
    '      let response;',
    '      try {',
    "        response = await fetch(apiBaseUrl + '/register/password', {",
    "          method: 'POST',",
    "          headers: { 'content-type': 'application/json' },",
    '          body: JSON.stringify({ email: initialUserEmail, password: initialUserPassword, confirmPassword: initialUserPassword }),',
    '        });',
    '      } catch (error) {',
    // The CronJob's whole retry strategy is "run again in a minute", so say
    // that, rather than surfacing a bare `TypeError: fetch failed`.
    "        throw new Error('WAITING: the HyperDX API at ' + apiBaseUrl + ' is not reachable yet (' + error.message + '). This is expected while the release is still starting; the CronJob retries every minute.');",
    '      }',
    '      const responseBody = await response.text();',
    // 409 is SUCCESS: a human registered first, so the instance is claimed and
    // an administrator exists — which is the whole objective.
    "      if (response.status === 409 && responseBody.indexOf('teamAlreadyExists') !== -1) {",
    "        print('ClickStack initial user: the HyperDX instance was already claimed by an earlier registration; recording bootstrap as complete.');",
    '      } else if (response.status < 200 || response.status >= 300) {',
    // HyperDX validates the address and the password itself and answers with a
    // body naming the field. Relay it; a second copy of its rules here could
    // only diverge from them.
    "        throw new Error('HyperDX refused the initial-user registration at ' + apiBaseUrl + '/register/password with HTTP ' + response.status + '. The endpoint is the authority on the address and password it accepts, and its response was: ' + responseBody + ' (no registration was consumed; fix the value and the CronJob will retry).');",
    '      } else {',
    "        print('ClickStack initial user: registered ' + initialUserEmail + ' and claimed the HyperDX instance.');",
    '      }',
    '    } else {',
    "      print('ClickStack initial user: a HyperDX Team already exists, so registration is closed; recording bootstrap as complete.');",
    '    }',
    // Written on EVERY exit from the bootstrap branch. After this point the
    // account lifecycle belongs to HyperDX and to humans, and an account
    // somebody deleted on purpose stays deleted.
    '    bootstrapMarkers.updateOne({ _id: initialUserMarkerId }, { $setOnInsert: { completed: true, completedAt: new Date() } }, { upsert: true });',
    '  }',
    // ── The one surviving write into HyperDX's own schema ────────────────
    // The collector authenticates with a pre-shared key, so the Team has to
    // carry it. Reconciled on every pass so a rotated Secret converges.
    '  const teams = database.teams.find({}).toArray();',
    "  if (teams.length === 0) throw new Error('WAITING: no HyperDX Team exists yet, so the ingestion key has nothing to reconcile against. If the bootstrap marker is present the Team was deleted after bootstrap — TypeKro deliberately does not recreate it, because that would spend a registration nobody can use.');",
    "  if (teams.length > 1) throw new Error('Multiple HyperDX Teams exist. HyperDX assumes exactly one, so TypeKro will not guess which one owns the ingestion key.');",
    '  if (teams[0].apiKey !== apiKey || teams[0].collectorAuthenticationEnforced !== true) {',
    '    database.teams.updateOne({ _id: teams[0]._id }, {',
    '      $set: { apiKey, collectorAuthenticationEnforced: true, updatedAt: new Date() },',
    '    });',
    '  }',
    "  return 'clickstack-bootstrap-ok';",
    '};',
    'main();',
  ].join('\n');
}

/**
 * Refuse `initialUser` on a chart version nobody has audited — the BUILD-TIME
 * half of the allowlist.
 *
 * WHY A THROW AND NOT A WARNING. The residual coupling is a write to
 * `teams.apiKey` in an upstream-owned schema. If that field moves, the CronJob
 * still succeeds and the stack still reports Ready; the only symptom is
 * telemetry silently refused at the gateway. A warning is the wrong instrument
 * for a failure nobody will be looking for, and the cost is bounded because
 * `initialUser` is opt-in and
 * {@link ClickStackInitialUserOptions.allowUnvalidatedChartVersion} is an
 * explicit escape hatch.
 *
 * WHY IT IS NOT THE WHOLE GUARD. `version` is a RUNTIME spec field, so in KRO
 * mode it is a schema reference here and a value a consumer supplies to the CR
 * at apply time — there is no build to fail. That half is covered by narrowing
 * `spec.version` on the generated CRD; see
 * {@link clickStackInitialUserVersionValidationRule}. This function therefore
 * treats a non-string as "not mine to check", which is also what the analysis
 * pass hands it.
 *
 * @param version - Concrete chart version, or a schema ref in KRO mode
 * @param initialUser - The resolved option; `undefined` skips the guard
 * @throws Error when a concrete version is not on the allowlist
 */
function assertClickStackInitialUserChartVersion(
  version: unknown,
  initialUser?: ResolvedClickStackInitialUser
): void {
  if (initialUser === undefined || initialUser.allowUnvalidatedChartVersion) return;
  if (typeof version !== 'string') return;

  if (!isClickStackInitialUserValidatedChartVersion(version)) {
    throw new Error(
      'ClickStack initialUser is audited only against chart version(s) ' +
        `${CLICKSTACK_INITIAL_USER_VALIDATED_CHART_VERSIONS.join(', ')} (appVersion ` +
        `${CLICKSTACK_INITIAL_USER_VALIDATED_APP_VERSION}), but version ${JSON.stringify(version)} ` +
        'was requested. Registration goes through HyperDX\'s own endpoint, but TypeKro still ' +
        "patches the Team's apiKey directly in HyperDX's schema — if that field moves the Job " +
        'still succeeds and ingestion is silently unauthenticated. The list is exact on purpose: ' +
        'a range such as ">=3.2.0" resolves to a chart nobody audited. Verify the registration ' +
        'contract and the teams.apiKey field on that chart, then set ' +
        'initialUser.allowUnvalidatedChartVersion: true.'
    );
  }
}

/**
 * Refuse `hyperdxOidc` on a chart version the plugin was not audited against —
 * the build-time half; the KRO half is the shared `spec.version` narrowing in
 * {@link clickStackSchemaFieldValidations}.
 *
 * The plugin also checks its hook points at startup and turns itself off if
 * they are missing, so an unaudited chart fails CLOSED to password-only login
 * rather than breaking HyperDX. The throw is about not shipping a sign-in path
 * nobody has verified.
 */
function assertClickStackHyperdxOidcChartVersion(
  version: unknown,
  hyperdxOidc?: ResolvedClickStackHyperdxOidc
): void {
  if (hyperdxOidc === undefined || hyperdxOidc.allowUnvalidatedChartVersion) return;
  if (typeof version !== 'string') return;
  if (!isClickStackHyperdxOidcValidatedChartVersion(version)) {
    throw new Error(
      'ClickStack hyperdxOidc is audited only against chart version(s) ' +
        `${CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS.join(', ')} (appVersion ` +
        `${CLICKSTACK_HYPERDX_OIDC_VALIDATED_APP_VERSION}), but version ${JSON.stringify(version)} ` +
        "was requested. The plugin hooks HyperDX's Passport instance, root router and user/team " +
        'models. Verify them on that chart, then set hyperdxOidc.allowUnvalidatedChartVersion: true.'
    );
  }
}

/**
 * Schema field validations for a composition, with the chart-version narrowing
 * added when `initialUser` is configured.
 *
 * This is the KRO-mode half of the version allowlist. `schemaFieldValidations`
 * becomes `x-kubernetes-validations` on the generated CRD, so a consumer who
 * sets an unaudited `spec.version` on the custom resource is refused by
 * ADMISSION — the path a build-time throw structurally cannot reach. It is
 * applied to the `secretValues` variants too, which previously carried no
 * validations at all and so had no KRO-side guard of any kind.
 *
 * @param base - The mode's own validations (inline mode pins `apiKey`)
 * @param initialUser - The resolved option; `undefined` adds nothing
 * @returns Composition options carrying the merged map, or `{}` when empty
 */
function clickStackSchemaFieldValidations(
  base: Readonly<Record<string, string>>,
  initialUser?: ResolvedClickStackInitialUser,
  hyperdxOidc?: ResolvedClickStackHyperdxOidc
): { schemaFieldValidations?: Readonly<Record<string, string>> } {
  const merged: Record<string, string> = { ...base };
  // Both features are audited against the same chart series, so one rule
  // covers either (see CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS).
  if (
    (initialUser !== undefined && !initialUser.allowUnvalidatedChartVersion) ||
    (hyperdxOidc !== undefined && !hyperdxOidc.allowUnvalidatedChartVersion)
  ) {
    merged.version = clickStackInitialUserVersionValidationRule();
  }
  return Object.keys(merged).length > 0 ? { schemaFieldValidations: merged } : {};
}

/**
 * Shared composition body. `build` is CONCRETE (construction-time), so every
 * plain-JS branch below is on build config — never on the (possibly
 * schema-proxy) runtime spec.
 *
 * NOTE: the variant builders pass INLINE delegating arrows
 * (`(spec) => bootstrapBody(spec, build)`) to `kubernetesComposition` — a
 * composition function that is itself a returned closure defeats the
 * composition analyzer and mis-serializes mixed CEL templates (verified
 * empirically: `Cel.template` values came out double-wrapped as
 * `${tcp://${…}}`).
 */
function bootstrapBody(spec: ClickStackBootstrapRuntimeConfig, build: ResolvedBuildConfig) {
  {
    const credentialsSecret = (
      spec as
        | ClickStackSecretValuesBootstrapConfig
        | ClickStackSecretValuesExternalMongoBootstrapConfig
    ).credentialsSecret;
    const resolvedNamespace = isKubernetesRef(spec.namespace)
      ? Cel.default(spec.namespace, DEFAULT_CLICKSTACK_NAMESPACE)
      : (spec.namespace ?? DEFAULT_CLICKSTACK_NAMESPACE);
    const resolvedVersion = isKubernetesRef(spec.version)
      ? Cel.default(spec.version, DEFAULT_CLICKSTACK_VERSION)
      : (spec.version ?? DEFAULT_CLICKSTACK_VERSION);

    // The seed writes into HyperDX's OWN schema, so it is only valid on the
    // chart series TypeKro has read that schema from.
    assertClickStackInitialUserChartVersion(
      isKubernetesRef(spec.version) ? undefined : (spec.version ?? DEFAULT_CLICKSTACK_VERSION),
      build.initialUser
    );
    // The OIDC plugin hooks HyperDX internals, so the same audited-chart rule applies.
    assertClickStackHyperdxOidcChartVersion(
      isKubernetesRef(spec.version) ? undefined : (spec.version ?? DEFAULT_CLICKSTACK_VERSION),
      build.hyperdxOidc
    );

    // The schema constrains `name` — DNS-label syntax and the derived length
    // bound — for KRO admission and direct-mode `deploy`; direct-mode `toYaml`
    // does not run `validateSpec`, so a concrete malformed or over-long name
    // would otherwise sail through and render a CronJob the API server refuses
    // plus status endpoints naming a gateway Service the chart truncated away.
    // The guard runs the SAME schema, so the message cannot drift from it.
    if (!isKubernetesRef(spec.name)) assertClickStackReleaseName(spec.name);

    if (build.credentialSource === 'inline') {
      const inlineApiKey = (
        spec as ClickStackBootstrapConfig | ClickStackExternalMongoBootstrapConfig
      ).apiKey;
      if (
        !isKubernetesRef(inlineApiKey) &&
        (inlineApiKey.trim().length === 0 || inlineApiKey === CLICKSTACK_CHART_PLACEHOLDER_API_KEY)
      ) {
        throw new Error(
          'ClickStack inline credential mode requires a non-empty apiKey that is not the published chart placeholder.'
        );
      }
    }

    // HyperDX OIDC: fold the plugin's env, volumes and mounts into the static
    // values (appended to the caller's lists, which a deep merge would replace).
    const staticValues =
      build.hyperdxOidc === undefined
        ? build.values
        : applyHyperdxOidcValues(
            'makeClickstackBootstrap',
            build.values,
            build.hyperdxOidc,
            spec.name,
            // With initialUser, the bootstrap CronJob claims the instance: a
            // first OIDC login must not create the team in its place, and
            // only the initial user's own registration passes passwordLogin: false.
            build.initialUser
          );

    const helmValues = mapClickStackConfigToHelmValues(spec, {
      mongoMode: build.mongoMode,
      credentialSource: build.credentialSource,
      ...(staticValues !== undefined && { values: staticValues }),
      storage: build.clickhouseStorage,
    });

    if (
      build.credentialSource === 'secretValues' &&
      !isKubernetesRef(credentialsSecret) &&
      credentialsSecret === undefined
    ) {
      throw new Error('ClickStack secretValues credential mode requires credentialsSecret.');
    }
    if (
      build.credentialSource === 'secretValues' &&
      !isKubernetesRef(spec.clickhouse) &&
      ((spec.clickhouse as { password?: unknown }).password !== undefined ||
        (spec.clickhouse as { appPassword?: unknown }).appPassword !== undefined ||
        (spec as { apiKey?: unknown }).apiKey !== undefined ||
        spec.customValues !== undefined)
    ) {
      throw new Error(
        'ClickStack secretValues credential mode rejects inline clickhouse.password, clickhouse.appPassword, apiKey, and runtime customValues.'
      );
    }

    const _clickstackNamespace = namespace({
      metadata: {
        // This resource is active only when namespace is omitted, so its
        // identity is always TypeKro's documented standalone default.
        name: DEFAULT_CLICKSTACK_NAMESPACE,
        labels: {
          'app.kubernetes.io/name': 'clickstack',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'clickstackNamespace',
    }).withIncludeWhen(
      isKubernetesRef(spec.namespace) ? Cel.not(spec.namespace) : spec.namespace === undefined
    );

    // One cluster-level Flux source shared by every ClickStack instance —
    // singleton(...) keeps it out of any single instance's KRO ApplySet
    // (see clickstack-helm-repository.ts for the ownership rationale).
    const _clickstackHelmRepository = singleton(clickstackHelmRepositoryBootstrap, {
      id: 'clickstack-helm-repository',
      spec: {
        name: DEFAULT_CLICKSTACK_REPO_NAME,
        namespace: DEFAULT_FLUX_NAMESPACE,
        url: DEFAULT_CLICKSTACK_REPO_URL,
      },
    });

    // ── Internal Mongo (build-time variant) ─────────────────────────────
    if (build.mongoMode === 'internal') {
      const _mongoStatefulSet = clickstackMongoStatefulSet({
        name: spec.name,
        namespace: resolvedNamespace as string,
        ...(build.storage?.size !== undefined && { storageSize: build.storage.size }),
        ...(build.storage?.storageClassName !== undefined && {
          storageClassName: build.storage.storageClassName,
        }),
        statefulSetId: 'clickstackMongoStatefulSet',
      });
      const _mongoService = clickstackMongoService({
        name: spec.name,
        namespace: resolvedNamespace as string,
        serviceId: 'clickstackMongoService',
      });
    }

    // ── Collector persistent sending queue (PVC) ─────────────────────────
    //
    // A "persistent queue" has to outlive the collector Pod, and the two
    // volume kinds a chart can template for you do NOT: an `emptyDir` dies
    // with the Pod, and a *generic ephemeral volume*'s PVC is deleted along
    // with the Pod that owns it
    // (https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/). So the
    // claim is a STANDALONE PersistentVolumeClaim owned by this composition,
    // mounted by `claimName` through the chart's `extraVolumes` seam. It is
    // created before the HelmRelease so the collector's first Pod can bind it.
    //
    // READINESS: the claim is treated as ready while `Pending`, because a
    // `WaitForFirstConsumer` StorageClass (the common default, and kind's) does
    // not bind a claim until a Pod mounts it — and that Pod is created by the
    // HelmRelease that waits on this resource. Gating on `Bound` here would
    // deadlock the deployment on every such cluster.
    const queueClaim =
      build.clickhouseStorage.persistentQueue === undefined
        ? undefined
        : persistentVolumeClaim({
            id: 'clickstackQueueClaim',
            metadata: {
              name: clickStackQueueClaimName(spec.name),
              namespace: resolvedNamespace as string,
              labels: {
                'app.kubernetes.io/name': 'clickstack-otel-queue',
                'app.kubernetes.io/instance': spec.name,
                'app.kubernetes.io/managed-by': 'typekro',
              },
            },
            spec: renderPersistentQueueClaimSpec(build.clickhouseStorage.persistentQueue),
          }).withReadinessEvaluator(clickstackQueueClaimReadiness);

    // ── ClickStack HelmRelease ───────────────────────────────────────────
    //
    // The HelmRelease does not set `disableWait`, so helm-controller waits
    // for the chart's workloads (HyperDX app + gateway collector) before
    // reporting Ready — readiness is workload-aware, mirroring the
    // dagster/clickhouse bootstraps. The HyperDX pod's own waitForMongodb
    // init container gates on Mongo reachability, so no explicit dependency
    // on the internal Mongo is needed.
    //
    // POST-RENDERERS: the caller's static ones, passed through verbatim. The
    // composition adds none of its own — the queue's `fsGroup` used to ride
    // here as a Kustomize patch on `<release>-otel-collector` (#223), but the
    // subchart exposes `podSecurityContext` as a plain chart value, so the
    // mapper pins it in `values` instead (name-independent, no per-reconcile
    // Kustomize pass; see renderPersistentQueueValues). The seam stays open
    // for callers.
    const postRenderers = build.postRenderers ?? [];
    const _clickstackHelmRelease = clickstackHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
      ...(postRenderers.length > 0 && { postRenderers }),
      ...(build.credentialSource === 'secretValues'
        ? {
            valuesFrom: [
              {
                kind: 'Secret' as const,
                // biome-ignore lint/style/noNonNullAssertion: the secretValues schema requires credentialsSecret
                name: credentialsSecret!.name,
                valuesKey: isKubernetesRef(credentialsSecret?.valuesKey)
                  ? Cel.default(credentialsSecret.valuesKey, 'values.yaml')
                  : (credentialsSecret?.valuesKey ?? 'values.yaml'),
              },
            ],
          }
        : {}),
      id: CLICKSTACK_HELM_RELEASE_RESOURCE_ID,
    });
    // The collector Pod mounts the queue claim by name, so the claim has to
    // exist before helm-controller creates the Deployment.
    if (queueClaim !== undefined) {
      _clickstackHelmRelease.dependsOn(queueClaim);
    }

    // ── HyperDX OIDC plugin ──────────────────────────────────────────────
    // The HyperDX pod mounts the plugin from this ConfigMap, so it has to
    // exist before the Deployment. The caller's configuration Secret is theirs
    // to create; see hyperdx-oidc/index.ts.
    if (build.hyperdxOidc !== undefined) {
      const oidcPlugin = configMap({
        id: 'clickstackHyperdxOidcPlugin',
        metadata: {
          name: hyperdxOidcPluginConfigMapName(spec.name),
          namespace: resolvedNamespace as string,
          labels: {
            'app.kubernetes.io/name': 'hyperdx-oidc-plugin',
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
        ...hyperdxOidcPluginConfigMapData(),
      });
      _clickstackHelmRelease.dependsOn(oidcPlugin);
    }

    // HyperDX's production OpAMP controller activates OTLP only after its
    // authoritative Team collection contains an ingestion key. The chart's
    // HYPERDX_API_KEY environment value configures application telemetry but
    // does not create that Team. Bootstrap one framework-owned Team from the
    // chart-owned Secret, after the release (and therefore Mongo) is ready.
    // This keeps the credential out of the Job manifest, coexists with
    // application-created Teams, and converges the framework-owned key when a
    // referenced Secret or Mongo URI rotates. A one-shot Job cannot observe
    // either update after it completes, so this deliberately uses an
    // idempotent minute-level CronJob. Readiness requires a successful run;
    // the script rejects the chart's public placeholder key, making an absent
    // Secret values override fail closed.
    const mongoUri =
      build.mongoMode === 'external'
        ? (spec as ClickStackExternalMongoBootstrapConfig).mongoUri
        : Cel.template(
            'mongodb://%s-mongodb.%s.svc.cluster.local:27017/hyperdx',
            spec.name,
            resolvedNamespace
          );
    const _teamBootstrap = cronJob({
      id: 'clickstackTeamBootstrap',
      metadata: {
        name: `${spec.name}${CLICKSTACK_TEAM_BOOTSTRAP_NAME_SUFFIX}`,
        namespace: resolvedNamespace as string,
        labels: {
          'app.kubernetes.io/name': 'clickstack-team-bootstrap',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      spec: {
        schedule: '* * * * *',
        concurrencyPolicy: 'Forbid',
        startingDeadlineSeconds: 60,
        successfulJobsHistoryLimit: 1,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            backoffLimit: 6,
            template: {
              metadata: {
                labels: {
                  'app.kubernetes.io/name': 'clickstack-team-bootstrap',
                  'app.kubernetes.io/instance': spec.name,
                },
              },
              spec: {
                restartPolicy: 'Never',
                containers: [
                  {
                    name: 'team-bootstrap',
                    image: 'mongo:7',
                    command: [
                      'mongosh',
                      '--quiet',
                      mongoUri as string,
                      '--eval',
                      renderClickStackTeamBootstrapScript(build.initialUser),
                    ],
                    env: [
                      {
                        // `optional: false` is right HERE and only here: the
                        // ingestion key is CONTINUOUSLY required — every run
                        // reconciles the Team's apiKey against it — so its
                        // absence genuinely is a reason not to start.
                        name: 'HYPERDX_API_KEY',
                        valueFrom: {
                          secretKeyRef: {
                            name: CLICKSTACK_SECRET_NAME,
                            key: 'HYPERDX_API_KEY',
                            optional: false,
                          },
                        },
                      },
                      // The initial user's password has a DIFFERENT lifecycle:
                      // it is needed once, by one branch of the script, and is
                      // meaningless afterwards. `optional: true` is therefore
                      // deliberate. With `optional: false` a missing key stops
                      // kubelet from ever starting the container, so the
                      // ingestion key is never reconciled either. It would also
                      // mean that rotating the bootstrap password away after a
                      // successful registration breaks every future
                      // reconciliation. Presence is asserted inside the
                      // registering branch instead, where it matters.
                      ...(build.initialUser === undefined
                        ? []
                        : [
                            {
                              name: build.initialUser.passwordEnvVarName,
                              valueFrom: {
                                secretKeyRef: {
                                  name: build.initialUser.passwordSecretName,
                                  key: build.initialUser.passwordSecretKey,
                                  optional: true,
                                },
                              },
                            },
                            {
                              // Where the script POSTs `/register/password`.
                              // DERIVED, not hardcoded: the HyperDX Service
                              // takes the release name, and both it and the
                              // namespace are runtime values, so this is a CEL
                              // template for the same reason the Mongo URI is.
                              // The port is the composition's own
                              // CLICKSTACK_API_PORT, the one the status
                              // contract already publishes as `app.apiPort`.
                              name: CLICKSTACK_INITIAL_USER_API_BASE_URL_ENV,
                              value: Cel.template(
                                `http://%s.%s.svc.cluster.local:${CLICKSTACK_API_PORT}`,
                                spec.name,
                                resolvedNamespace
                              ) as unknown as string,
                            },
                          ]),
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    }).withReadinessEvaluator(clickstackTeamBootstrapReadiness);
    _teamBootstrap.dependsOn(_clickstackHelmRelease);

    // ── OTel table retention (TTL) ───────────────────────────────────────
    //
    // TypeKro does not own the OTel tables — the gateway collector's goose
    // migrations create them on first start, and only then can a TTL be
    // applied. So retention converges through an idempotent CronJob rather
    // than a one-shot Job: it skips tables that have not appeared yet and
    // re-checks later, and it only issues `MODIFY TTL` when the table's
    // current definition does not already carry the target expression.
    //
    // Connection details come from the chart-owned `clickstack-config`
    // ConfigMap and `clickstack-secret` Secret (the same envFrom pair the
    // gateway collector uses), so this works identically in inline and
    // Secret-backed credential modes and keeps no credential in the manifest.
    if (build.clickhouseStorage.retentionEntries.length > 0) {
      const _retention = cronJob({
        id: 'clickstackRetention',
        metadata: {
          name: `${spec.name}${CLICKSTACK_RETENTION_NAME_SUFFIX}`,
          namespace: resolvedNamespace as string,
          labels: {
            'app.kubernetes.io/name': 'clickstack-otel-retention',
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
        spec: {
          schedule: build.clickhouseStorage.retentionSchedule,
          concurrencyPolicy: 'Forbid',
          successfulJobsHistoryLimit: 1,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            spec: {
              backoffLimit: 3,
              template: {
                metadata: {
                  labels: {
                    'app.kubernetes.io/name': 'clickstack-otel-retention',
                    'app.kubernetes.io/instance': spec.name,
                  },
                },
                spec: {
                  restartPolicy: 'Never',
                  containers: [
                    {
                      name: 'retention',
                      image: build.clickhouseStorage.retentionImage,
                      command: ['sh', '-c', renderRetentionScript(build.clickhouseStorage)],
                      envFrom: [
                        { configMapRef: { name: CLICKSTACK_CONFIG_MAP_NAME, optional: false } },
                        { secretRef: { name: CLICKSTACK_SECRET_NAME, optional: false } },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      });
      _retention.dependsOn(_clickstackHelmRelease);
    }

    // The build-time half of the status contract, written to a resource this
    // composition OWNS so it can be projected into status rather than emitted
    // as a literal KRO drops. See CLICKSTACK_CONTRACT_RESOURCE_ID.
    const _clickstackContract = configMap({
      id: CLICKSTACK_CONTRACT_RESOURCE_ID,
      metadata: {
        name: `${spec.name}${CLICKSTACK_CONTRACT_CONFIGMAP_SUFFIX}`,
        namespace: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'clickstack',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/component': 'contract',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      // ConfigMap values are strings by definition, so the numeric ports come
      // back through `int(...)` and the boolean through an `== "true"`
      // comparison — both live-verified to resolve in kro mode (KRO status
      // CEL) and in direct mode (the cel-js reference resolver).
      // `version` is deliberately NOT here: the chart pin the status reports
      // is read straight off the owned HelmRelease
      // (`spec.chart.spec.version`), so echoing it through this ConfigMap
      // would be a second copy of the same fact.
      data: {
        appPort: String(CLICKSTACK_APP_PORT),
        apiPort: String(CLICKSTACK_API_PORT),
        storageMode: build.clickhouseStorage.mode,
        ...(build.clickhouseStorage.diskType !== undefined
          ? { storageDiskType: build.clickhouseStorage.diskType }
          : {}),
        ...(build.clickhouseStorage.policyName !== undefined
          ? { storagePolicyName: build.clickhouseStorage.policyName }
          : {}),
        ...(build.clickhouseStorage.retention?.logs !== undefined
          ? { storageRetentionLogs: build.clickhouseStorage.retention.logs }
          : {}),
        ...(build.clickhouseStorage.retention?.traces !== undefined
          ? { storageRetentionTraces: build.clickhouseStorage.retention.traces }
          : {}),
        ...(build.clickhouseStorage.retention?.metrics !== undefined
          ? { storageRetentionMetrics: build.clickhouseStorage.retention.metrics }
          : {}),
        storagePersistentQueue: String(build.clickhouseStorage.persistentQueue !== undefined),
      },
    });

    const helmReleaseStatus = helmReleaseConditionSummary(_clickstackHelmRelease);
    const teamBootstrapReady = Cel.expr<boolean>(
      'has(clickstackTeamBootstrap.status.lastScheduleTime) && ',
      'has(clickstackTeamBootstrap.status.lastSuccessfulTime) && ',
      'string(clickstackTeamBootstrap.status.lastSuccessfulTime) >= ',
      'string(clickstackTeamBootstrap.status.lastScheduleTime)'
    );

    // Status endpoints derive from the owned HelmRelease resource so they
    // serialize as KRO status CEL and land on the live KRO CR's status
    // (same reachability class as the PR #93 review finding). Naming is
    // deterministic because the mapper pins `fullnameOverride` to the release
    // name: HyperDX Service = `<name>`, gateway Service =
    // `<name>-otel-collector`. The subchart truncates the latter at 63
    // characters, so the literal is only right because the runtime schema
    // bounds `name` (CLICKSTACK_NAME_LIMIT). Ports are chart defaults (see
    // resources/helm.ts) and ride INSIDE the resource-derived URL strings.
    //
    // These use NATURAL proxy access inside JS template literals (typekro
    // >= 0.24.0, with the #97 resource-metadata-proxy fix). In KRO mode the
    // imperative analyzer converts them to status CEL and (#97)
    // `clickstackHelmRelease.metadata.*` resolves resource-anchored instead
    // of degrading to `schema.spec.name`; in direct mode they are plain JS,
    // so live-status re-execution evaluates them to concrete strings — the
    // bimodal win over the old raw `Cel.expr("...literal CEL...")` strings,
    // which stayed opaque markers in direct mode. `ready`/`phase` below stay
    // raw Cel.expr: they use the CEL `.exists()` macro over the HelmRelease
    // conditions, which has no analyzer-convertible JS equivalent — so they are
    // NOT natural template literals. They still resolve in BOTH modes, though:
    // KRO status CEL in kro mode, and the cel-js reference resolver evaluates
    // the `.exists()` macro against the live HelmRelease conditions in direct
    // mode (proven concrete — ready===true / phase==="Ready" — in the hermetic
    // final-pipeline test). Unchanged by this migration: raw Cel.expr before
    // and after; only the metadata endpoint fields switched to template literals.
    return {
      ready: Cel.expr<boolean>(helmReleaseStatus.ready, ' && ', teamBootstrapReady),
      phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
        helmReleaseStatus.failed,
        ' ? "Failed" : (',
        helmReleaseStatus.ready,
        ' && ',
        teamBootstrapReady,
        ' ? "Ready" : "Installing")'
      ),
      // The HelmRelease's own chart pin — the version Flux is reconciling,
      // read off the release rather than echoed from `resolvedVersion`. In kro
      // mode `resolvedVersion` is `Cel.default(schema.spec.version, …)`, a
      // schema-only expression KRO drops from the instance status, so the
      // declared `version` field never appeared on the live CR at all.
      version: _clickstackHelmRelease.spec.chart.spec.version,
      ui: {
        url: `http://${_clickstackHelmRelease.metadata.name}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local:${CLICKSTACK_APP_PORT}`,
      },
      gateway: {
        otlpHttpEndpoint: `http://${_clickstackHelmRelease.metadata.name}${CLICKSTACK_GATEWAY_NAME_SUFFIX}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local:${CLICKSTACK_OTLP_HTTP_PORT}`,
        otlpGrpcEndpoint: `http://${_clickstackHelmRelease.metadata.name}${CLICKSTACK_GATEWAY_NAME_SUFFIX}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local:${CLICKSTACK_OTLP_GRPC_PORT}`,
      },
      app: {
        host: `${_clickstackHelmRelease.metadata.name}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local`,
        // Projected from the owned contract ConfigMap through `int(...)`.
        // These were bare numeric constants, which KRO omits from the instance
        // status — so the declared `app` object arrived with only `host`.
        appPort: Cel.expr<number>(`int(${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.appPort)`),
        apiPort: Cel.expr<number>(`int(${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.apiPort)`),
      },
      // Storage sits next to `gateway.otlpHttpEndpoint` so one read answers
      // both "where do I send telemetry" and "what happens to it".
      //
      // PROJECTED FROM THE OWNED CONTRACT CONFIGMAP, not inlined: as bare
      // build-time constants KRO dropped the whole block, so the declared
      // schema promised a durability contract the live CR never carried.
      storage: {
        mode: Cel.expr<'pvc' | 's3'>(`${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storageMode`),
        ...(build.clickhouseStorage.diskType !== undefined && {
          diskType: Cel.expr<'s3' | 's3_plain_rewritable'>(
            `${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storageDiskType`
          ),
        }),
        ...(build.clickhouseStorage.policyName !== undefined && {
          policyName: Cel.expr<string>(
            `${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storagePolicyName`
          ),
        }),
        ...(build.clickhouseStorage.retention !== undefined && {
          retention: {
            ...(build.clickhouseStorage.retention.logs !== undefined && {
              logs: Cel.expr<string>(
                `${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storageRetentionLogs`
              ),
            }),
            ...(build.clickhouseStorage.retention.traces !== undefined && {
              traces: Cel.expr<string>(
                `${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storageRetentionTraces`
              ),
            }),
            ...(build.clickhouseStorage.retention.metrics !== undefined && {
              metrics: Cel.expr<string>(
                `${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storageRetentionMetrics`
              ),
            }),
          },
        }),
        persistentQueue: Cel.expr<boolean>(
          `${CLICKSTACK_CONTRACT_RESOURCE_ID}.data.storagePersistentQueue == "true"`
        ),
      },
    };
  }
}

/**
 * Resolve the ClickHouse-storage half of a build, with the queue's
 * replica constraint checked against the build-time chart values.
 *
 * The persistent queue is ONE bbolt database under an exclusive file lock, so
 * `persistentQueue` and `replicaCount > 1` cannot both be honoured — that
 * combination is rejected at construction rather than deploying a second
 * collector that blocks on the lock (or wedges on `Multi-Attach` first).
 */
function resolveClickHouseStorageForBuild(
  options: Pick<ClickStackInternalMongoBuildOptions, 'storage' | 'values'>
): ResolvedClickStackStorage {
  const resolved = resolveClickStackStorage('makeClickstackBootstrap', options.storage);
  const collectorValues = (options.values as Record<string, unknown> | undefined)?.[
    'otel-collector'
  ];
  const replicaCount =
    typeof collectorValues === 'object' && collectorValues !== null
      ? (collectorValues as { replicaCount?: unknown }).replicaCount
      : undefined;
  assertQueueReplicaCompatible('makeClickstackBootstrap', resolved, replicaCount);
  return resolved;
}

function resolveInternalBuild(options: ClickStackInternalMongoBuildOptions): ResolvedBuildConfig {
  const initialUser = resolveClickStackInitialUser(
    'makeClickstackBootstrap',
    CLICKSTACK_SECRET_NAME,
    options.initialUser
  );
  const hyperdxOidc = resolveClickStackHyperdxOidc('makeClickstackBootstrap', options.hyperdxOidc);
  return {
    mongoMode: 'internal',
    credentialSource: options.credentials?.source ?? 'inline',
    ...(options.mongo?.storage !== undefined && { storage: options.mongo.storage }),
    ...(options.values !== undefined && { values: options.values }),
    ...(options.postRenderers !== undefined && { postRenderers: options.postRenderers }),
    clickhouseStorage: resolveClickHouseStorageForBuild(options),
    ...(initialUser !== undefined && { initialUser }),
    ...(hyperdxOidc !== undefined && { hyperdxOidc }),
  };
}

function resolveExternalBuild(options: ClickStackExternalMongoBuildOptions): ResolvedBuildConfig {
  const initialUser = resolveClickStackInitialUser(
    'makeClickstackBootstrap',
    CLICKSTACK_SECRET_NAME,
    options.initialUser
  );
  const hyperdxOidc = resolveClickStackHyperdxOidc('makeClickstackBootstrap', options.hyperdxOidc);
  return {
    mongoMode: 'external',
    credentialSource: options.credentials?.source ?? 'inline',
    ...(options.values !== undefined && { values: options.values }),
    ...(options.postRenderers !== undefined && { postRenderers: options.postRenderers }),
    clickhouseStorage: resolveClickHouseStorageForBuild(options),
    ...(initialUser !== undefined && { initialUser }),
    ...(hyperdxOidc !== undefined && { hyperdxOidc }),
  };
}

function buildInternalInlineComposition(options: ClickStackInlineInternalMongoBuildOptions) {
  const build = resolveInternalBuild(options);
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap',
      kind: options.kind ?? 'ClickStackBootstrap',
      spec: ClickStackBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackBootstrapConfig) => bootstrapBody(spec, build),
    clickStackSchemaFieldValidations(inlineSchemaFieldValidations, build.initialUser, build.hyperdxOidc)
  );
}

function buildInternalSecretValuesComposition(
  options: ClickStackSecretValuesInternalMongoBuildOptions
) {
  const build: ResolvedBuildConfig = {
    ...resolveInternalBuild(options),
    credentialSource: 'secretValues',
  };
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap',
      kind: options.kind ?? 'ClickStackBootstrap',
      spec: ClickStackSecretValuesBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackSecretValuesBootstrapConfig) => bootstrapBody(spec, build),
    clickStackSchemaFieldValidations({}, build.initialUser, build.hyperdxOidc)
  );
}

function buildExternalInlineComposition(options: ClickStackInlineExternalMongoBuildOptions) {
  const build = resolveExternalBuild(options);
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap-external-mongo',
      kind: options.kind ?? 'ClickStackExternalMongoBootstrap',
      spec: ClickStackExternalMongoBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackExternalMongoBootstrapConfig) => bootstrapBody(spec, build),
    clickStackSchemaFieldValidations(inlineSchemaFieldValidations, build.initialUser, build.hyperdxOidc)
  );
}

function buildExternalSecretValuesComposition(
  options: ClickStackSecretValuesExternalMongoBuildOptions
) {
  const build: ResolvedBuildConfig = {
    ...resolveExternalBuild(options),
    credentialSource: 'secretValues',
  };
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap-external-mongo',
      kind: options.kind ?? 'ClickStackExternalMongoBootstrap',
      spec: ClickStackSecretValuesExternalMongoBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackSecretValuesExternalMongoBootstrapConfig) => bootstrapBody(spec, build),
    clickStackSchemaFieldValidations({}, build.initialUser, build.hyperdxOidc)
  );
}

/** Composition type for the internal-Mongo variant. */
export type ClickStackBootstrapComposition = ReturnType<typeof buildInternalInlineComposition>;

/** Composition type for the Secret-backed internal-Mongo variant. */
export type ClickStackSecretValuesBootstrapComposition = ReturnType<
  typeof buildInternalSecretValuesComposition
>;

/** Composition type for the external-Mongo variant. */
export type ClickStackExternalMongoBootstrapComposition = ReturnType<
  typeof buildExternalInlineComposition
>;

/** Composition type for the Secret-backed external-Mongo variant. */
export type ClickStackSecretValuesExternalMongoBootstrapComposition = ReturnType<
  typeof buildExternalSecretValuesComposition
>;

function isSecretValuesExternalBuild(
  options: ClickStackBuildOptions
): options is ClickStackSecretValuesExternalMongoBuildOptions {
  return options.mongo?.mode === 'external' && options.credentials?.source === 'secretValues';
}

function isInlineExternalBuild(
  options: ClickStackBuildOptions
): options is ClickStackInlineExternalMongoBuildOptions {
  return options.mongo?.mode === 'external' && options.credentials?.source !== 'secretValues';
}

function isSecretValuesInternalBuild(
  options: ClickStackBuildOptions
): options is ClickStackSecretValuesInternalMongoBuildOptions {
  return options.mongo?.mode !== 'external' && options.credentials?.source === 'secretValues';
}

/**
 * Construct a ClickStack bootstrap composition variant. Build-time options
 * select WHICH resources exist (Mongo mode/storage) and bake static raw chart
 * values; everything per-instance stays in the runtime spec.
 */
export function makeClickstackBootstrap(
  options?: ClickStackInlineInternalMongoBuildOptions
): ClickStackBootstrapComposition;
export function makeClickstackBootstrap(
  options: ClickStackSecretValuesInternalMongoBuildOptions
): ClickStackSecretValuesBootstrapComposition;
export function makeClickstackBootstrap(
  options: ClickStackInlineExternalMongoBuildOptions
): ClickStackExternalMongoBootstrapComposition;
export function makeClickstackBootstrap(
  options: ClickStackSecretValuesExternalMongoBuildOptions
): ClickStackSecretValuesExternalMongoBootstrapComposition;
export function makeClickstackBootstrap(
  options: ClickStackBuildOptions = {}
):
  | ClickStackBootstrapComposition
  | ClickStackSecretValuesBootstrapComposition
  | ClickStackExternalMongoBootstrapComposition
  | ClickStackSecretValuesExternalMongoBootstrapComposition {
  // Build-time options must be CONCRETE: they select which resources exist and bake static chart
  // values at construction — a schema ref here can never serialize (loud > silent mis-serialization).
  if (containsKubernetesRefs(options)) {
    throw new Error(
      'makeClickstackBootstrap: build-time options contain a schema/resource reference. ' +
        'Build-time options (mongo mode/storage, static chart values, name/kind) are fixed at ' +
        'construction — move per-instance values into the runtime spec instead.'
    );
  }
  if (options.credentials?.source === 'secretValues') {
    const hyperdx = options.values?.hyperdx;
    const deployment =
      hyperdx && typeof hyperdx === 'object' && !Array.isArray(hyperdx)
        ? hyperdx.deployment
        : undefined;
    if (
      hyperdx &&
      typeof hyperdx === 'object' &&
      !Array.isArray(hyperdx) &&
      (hyperdx.secrets !== undefined ||
        (deployment &&
          typeof deployment === 'object' &&
          !Array.isArray(deployment) &&
          deployment.defaultConnections !== undefined))
    ) {
      throw new Error(
        'makeClickstackBootstrap: secretValues credential mode rejects build-time hyperdx.secrets and hyperdx.deployment.defaultConnections. Put those values in the referenced Secret.'
      );
    }
  }
  if (isSecretValuesExternalBuild(options)) {
    return buildExternalSecretValuesComposition(options);
  }
  if (isInlineExternalBuild(options)) {
    return buildExternalInlineComposition(options);
  }
  if (isSecretValuesInternalBuild(options)) {
    return buildInternalSecretValuesComposition(options);
  }
  return buildInternalInlineComposition(options);
}

/**
 * The default ClickStack bootstrap: internal single-replica Mongo (dev-first),
 * default RGD name/kind. Use `makeClickstackBootstrap(...)` for the
 * external-Mongo variant, custom Mongo storage, or static raw chart values.
 */
export const clickstackBootstrap = makeClickstackBootstrap();
