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
 *   mongoUri: 'mongodb://user:pass@mongo.example.com:27017/hyperdx',
 * });
 * ```
 */

import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../core/config/defaults.js';
import { Cel } from '../../../core/references/cel.js';
import { singleton } from '../../../core/singleton/singleton.js';
import { containsKubernetesRefs, isKubernetesRef } from '../../../utils/type-guards.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { job } from '../../kubernetes/workloads/job.js';
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
  type ClickStackInternalMongoBuildOptions,
  type ClickStackMongoStorageOptions,
  type ClickStackSecretValuesBootstrapConfig,
  ClickStackSecretValuesBootstrapConfigSchema,
  type ClickStackSecretValuesExternalMongoBootstrapConfig,
  ClickStackSecretValuesExternalMongoBootstrapConfigSchema,
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

const secretValuesSchemaFieldValidations = {
  'clickhouse.password': 'self == null',
  'clickhouse.appPassword': 'self == null',
  apiKey: 'self == null',
} as const;

const CLICKSTACK_TEAM_BOOTSTRAP_SCRIPT = [
  "const database = db.getSiblingDB('hyperdx');",
  'const apiKey = process.env.HYPERDX_API_KEY;',
  "if (!apiKey) throw new Error('HYPERDX_API_KEY is required.');",
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
      throw new Error(
        'ClickStack secretValues credential mode requires credentialsSecret.'
      );
    }
    if (
      build.credentialSource === 'secretValues' &&
      !isKubernetesRef(spec.clickhouse) &&
      (spec.clickhouse.password !== undefined ||
        spec.clickhouse.appPassword !== undefined ||
        spec.apiKey !== undefined ||
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
      isKubernetesRef(spec.namespace)
        ? Cel.not(spec.namespace)
        : spec.namespace === undefined
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
    // replacement credentials Secret is selected.
    const mongoUri =
      build.mongoMode === 'external'
        ? (spec as ClickStackExternalMongoBootstrapConfig).mongoUri
        : Cel.template(
            'mongodb://%s-mongodb.%s.svc.cluster.local:27017/hyperdx',
            spec.name,
            resolvedNamespace
          );
    const _teamBootstrap = job({
      id: 'clickstackTeamBootstrap',
      metadata: {
        name: spec.name,
        namespace: resolvedNamespace as string,
        labels: {
          'app.kubernetes.io/name': 'clickstack-team-bootstrap',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
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
            containers: [{
              name: 'team-bootstrap',
              image: 'mongo:7',
              command: ['mongosh', '--quiet', mongoUri as string, '--eval', CLICKSTACK_TEAM_BOOTSTRAP_SCRIPT],
              env: [{
                name: 'HYPERDX_API_KEY',
                valueFrom: {
                  secretKeyRef: {
                    name: 'clickstack-secret',
                    key: 'HYPERDX_API_KEY',
                    optional: false,
                  },
                },
              }],
            }],
          },
        },
      },
    });
    _teamBootstrap.dependsOn(_clickstackHelmRelease);

    const helmReleaseReady = Cel.expr<boolean>(
      _clickstackHelmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
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
      ready: Cel.expr<boolean>(
        `${helmReleaseReady.expression} && has(clickstackTeamBootstrap.status.succeeded) && clickstackTeamBootstrap.status.succeeded > 0`
      ),
      phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
        'clickstackHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") || ' +
          '(has(clickstackTeamBootstrap.status.failed) && clickstackTeamBootstrap.status.failed > 0) ? "Failed" : ' +
          '(clickstackHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && ' +
          'has(clickstackTeamBootstrap.status.succeeded) && clickstackTeamBootstrap.status.succeeded > 0) ' +
          '? "Ready" : "Installing"'
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

function buildInternalComposition(options: ClickStackInternalMongoBuildOptions) {
  const build: ResolvedBuildConfig = {
    mongoMode: 'internal',
    credentialSource: options.credentials?.source ?? 'inline',
    ...(options.mongo?.storage !== undefined && { storage: options.mongo.storage }),
    ...(options.values !== undefined && { values: options.values }),
  };
  const secretValues = build.credentialSource === 'secretValues';
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap',
      kind: options.kind ?? 'ClickStackBootstrap',
      spec: secretValues
        ? ClickStackSecretValuesBootstrapConfigSchema
        : ClickStackBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackBootstrapConfig | ClickStackSecretValuesBootstrapConfig) =>
      bootstrapBody(spec, build),
    secretValues
      ? { schemaFieldValidations: secretValuesSchemaFieldValidations }
      : undefined
  );
}

function buildExternalComposition(options: ClickStackExternalMongoBuildOptions) {
  const build: ResolvedBuildConfig = {
    mongoMode: 'external',
    credentialSource: options.credentials?.source ?? 'inline',
    ...(options.values !== undefined && { values: options.values }),
  };
  const secretValues = build.credentialSource === 'secretValues';
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap-external-mongo',
      kind: options.kind ?? 'ClickStackExternalMongoBootstrap',
      spec: secretValues
        ? ClickStackSecretValuesExternalMongoBootstrapConfigSchema
        : ClickStackExternalMongoBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (
      spec:
        | ClickStackExternalMongoBootstrapConfig
        | ClickStackSecretValuesExternalMongoBootstrapConfig
    ) => bootstrapBody(spec, build),
    secretValues
      ? { schemaFieldValidations: secretValuesSchemaFieldValidations }
      : undefined
  );
}

/** Composition type for the internal-Mongo variant. */
export type ClickStackBootstrapComposition = ReturnType<typeof buildInternalComposition>;

/** Composition type for the external-Mongo variant. */
export type ClickStackExternalMongoBootstrapComposition = ReturnType<
  typeof buildExternalComposition
>;

/**
 * Construct a ClickStack bootstrap composition variant. Build-time options
 * select WHICH resources exist (Mongo mode/storage) and bake static raw chart
 * values; everything per-instance stays in the runtime spec.
 */
export function makeClickstackBootstrap(
  options?: ClickStackInternalMongoBuildOptions
): ClickStackBootstrapComposition;
export function makeClickstackBootstrap(
  options: ClickStackExternalMongoBuildOptions
): ClickStackExternalMongoBootstrapComposition;
export function makeClickstackBootstrap(
  options: ClickStackBuildOptions = {}
): ClickStackBootstrapComposition | ClickStackExternalMongoBootstrapComposition {
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
  if (options.mongo?.mode === 'external') {
    return buildExternalComposition(options as ClickStackExternalMongoBuildOptions);
  }
  return buildInternalComposition(options as ClickStackInternalMongoBuildOptions);
}

/**
 * The default ClickStack bootstrap: internal single-replica Mongo (dev-first),
 * default RGD name/kind. Use `makeClickstackBootstrap(...)` for the
 * external-Mongo variant, custom Mongo storage, or static raw chart values.
 */
export const clickstackBootstrap = makeClickstackBootstrap();
