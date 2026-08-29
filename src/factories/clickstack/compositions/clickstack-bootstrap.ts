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

import type { V1CronJob } from '@kubernetes/client-node';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/portable-strategies.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { containsKubernetesRefs, isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { namespace } from '../../kubernetes/core/namespace.js';
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
} from '../types.js';
import {
  DEFAULT_CLICKSTACK_NAMESPACE,
  mapClickStackConfigToHelmValues,
} from '../utils/helm-values-mapper.js';
import { clickstackHelmRepositoryBootstrap } from './clickstack-helm-repository.js';

/** Concrete, resolved build choices the composition body branches on. */
interface ResolvedBuildConfig {
  mongoMode: 'internal' | 'external';
  credentialSource: 'inline' | 'secretValues';
  storage?: ClickStackMongoStorageOptions;
  values?: Record<string, unknown>;
}

const CLICKSTACK_CHART_PLACEHOLDER_API_KEY = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
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
    if (Number.isFinite(scheduledAt) && Number.isFinite(succeededAt) && succeededAt >= scheduledAt) {
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
const inlineSchemaFieldValidations = {
  apiKey: `self != "${CLICKSTACK_CHART_PLACEHOLDER_API_KEY}"`,
} as const;

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

    const helmValues = mapClickStackConfigToHelmValues(spec, {
      mongoMode: build.mongoMode,
      credentialSource: build.credentialSource,
      ...(build.values !== undefined && { values: build.values }),
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

    // ── ClickStack HelmRelease ───────────────────────────────────────────
    //
    // The HelmRelease does not set `disableWait`, so helm-controller waits
    // for the chart's workloads (HyperDX app + gateway collector) before
    // reporting Ready — readiness is workload-aware, mirroring the
    // dagster/clickhouse bootstraps. The HyperDX pod's own waitForMongodb
    // init container gates on Mongo reachability, so no explicit dependency
    // on the internal Mongo is needed.
    const _clickstackHelmRelease = clickstackHelmRelease({
      name: spec.name,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      values: helmValues,
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
      id: 'clickstackHelmRelease',
    });

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
        name: `${spec.name}-team-bootstrap`,
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
                      CLICKSTACK_TEAM_BOOTSTRAP_SCRIPT,
                    ],
                    env: [
                      {
                        name: 'HYPERDX_API_KEY',
                        valueFrom: {
                          secretKeyRef: {
                            name: 'clickstack-secret',
                            key: 'HYPERDX_API_KEY',
                            optional: false,
                          },
                        },
                      },
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
    // `<name>-otel-collector`. Ports are chart defaults (see resources/helm.ts)
    // and ride INSIDE the resource-derived URL strings.
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
      version: resolvedVersion,
      ui: {
        url: `http://${_clickstackHelmRelease.metadata.name}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local:${CLICKSTACK_APP_PORT}`,
      },
      gateway: {
        otlpHttpEndpoint: `http://${_clickstackHelmRelease.metadata.name}${CLICKSTACK_GATEWAY_NAME_SUFFIX}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local:${CLICKSTACK_OTLP_HTTP_PORT}`,
        otlpGrpcEndpoint: `http://${_clickstackHelmRelease.metadata.name}${CLICKSTACK_GATEWAY_NAME_SUFFIX}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local:${CLICKSTACK_OTLP_GRPC_PORT}`,
      },
      app: {
        host: `${_clickstackHelmRelease.metadata.name}.${_clickstackHelmRelease.metadata.namespace}.svc.cluster.local`,
        // Bare numeric constants — no resource anchor, so client-hydrated
        // only; both ports are KRO-visible inside the URL fields above.
        appPort: CLICKSTACK_APP_PORT,
        apiPort: CLICKSTACK_API_PORT,
      },
    };
  }
}

function resolveInternalBuild(options: ClickStackInternalMongoBuildOptions): ResolvedBuildConfig {
  return {
    mongoMode: 'internal',
    credentialSource: options.credentials?.source ?? 'inline',
    ...(options.mongo?.storage !== undefined && { storage: options.mongo.storage }),
    ...(options.values !== undefined && { values: options.values }),
  };
}

function resolveExternalBuild(options: ClickStackExternalMongoBuildOptions): ResolvedBuildConfig {
  return {
    mongoMode: 'external',
    credentialSource: options.credentials?.source ?? 'inline',
    ...(options.values !== undefined && { values: options.values }),
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
    { schemaFieldValidations: inlineSchemaFieldValidations }
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
    (spec: ClickStackSecretValuesBootstrapConfig) => bootstrapBody(spec, build)
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
    { schemaFieldValidations: inlineSchemaFieldValidations }
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
    (spec: ClickStackSecretValuesExternalMongoBootstrapConfig) => bootstrapBody(spec, build)
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
