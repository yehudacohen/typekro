/**
 * ClickStack (HyperDX) Bootstrap Composition — EXTERNAL ClickHouse only.
 *
 * Deploys the OFFICIAL `clickstack` chart (3.0.x, MIT) from
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
 * const factory = clickstackBootstrap.factory('kro', { namespace: 'clickstack' });
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
} from '../types.js';
import {
  DEFAULT_CLICKSTACK_NAMESPACE,
  mapClickStackConfigToHelmValues,
} from '../utils/helm-values-mapper.js';
import { clickstackHelmRepositoryBootstrap } from './clickstack-helm-repository.js';

/** Concrete, resolved build choices the composition body branches on. */
interface ResolvedBuildConfig {
  mongoMode: 'internal' | 'external';
  storage?: ClickStackMongoStorageOptions;
  values?: Record<string, unknown>;
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
    const resolvedNamespace = isKubernetesRef(spec.namespace)
      ? Cel.default(spec.namespace, DEFAULT_CLICKSTACK_NAMESPACE)
      : (spec.namespace ?? DEFAULT_CLICKSTACK_NAMESPACE);
    const resolvedVersion = isKubernetesRef(spec.version)
      ? Cel.default(spec.version, DEFAULT_CLICKSTACK_VERSION)
      : (spec.version ?? DEFAULT_CLICKSTACK_VERSION);

    const helmValues = mapClickStackConfigToHelmValues(spec, {
      mongoMode: build.mongoMode,
      ...(build.values !== undefined && { values: build.values }),
    });

    const _clickstackNamespace = namespace({
      metadata: {
        name: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'clickstack',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      id: 'clickstackNamespace',
    });

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
      id: 'clickstackHelmRelease',
    });

    const helmReleaseReady = Cel.expr<boolean>(
      _clickstackHelmRelease.status.conditions,
      '.exists(c, c.type == "Ready" && c.status == "True")'
    );

    // Status endpoints derive from the owned HelmRelease's metadata (resource
    // refs — valid in KRO status CEL, unlike schema.spec refs). Naming is
    // deterministic because the mapper pins `fullnameOverride` to the release
    // name: HyperDX Service = `<name>`, gateway Service =
    // `<name>-otel-collector`. Ports are chart defaults (see resources/helm.ts).
    const releaseName = _clickstackHelmRelease.metadata.name;
    const releaseNamespace = _clickstackHelmRelease.metadata.namespace;

    return {
      ready: helmReleaseReady,
      phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
        'clickstackHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "False") ' +
          '? "Failed" : clickstackHelmRelease.status.conditions.exists(c, c.type == "Ready" && ' +
          'c.status == "True") ? "Ready" : "Installing"'
      ),
      version: resolvedVersion,
      ui: {
        url: Cel.template(
          `http://%s.%s.svc.cluster.local:${CLICKSTACK_APP_PORT}`,
          releaseName,
          releaseNamespace
        ),
      },
      gateway: {
        otlpHttpEndpoint: Cel.template(
          `http://%s${CLICKSTACK_GATEWAY_NAME_SUFFIX}.%s.svc.cluster.local:${CLICKSTACK_OTLP_HTTP_PORT}`,
          releaseName,
          releaseNamespace
        ),
        otlpGrpcEndpoint: Cel.template(
          `http://%s${CLICKSTACK_GATEWAY_NAME_SUFFIX}.%s.svc.cluster.local:${CLICKSTACK_OTLP_GRPC_PORT}`,
          releaseName,
          releaseNamespace
        ),
      },
      app: {
        host: Cel.template('%s.%s.svc.cluster.local', releaseName, releaseNamespace),
        appPort: CLICKSTACK_APP_PORT,
        apiPort: CLICKSTACK_API_PORT,
      },
    };
  }
}

function buildInternalComposition(options: ClickStackInternalMongoBuildOptions) {
  const build: ResolvedBuildConfig = {
    mongoMode: 'internal',
    ...(options.mongo?.storage !== undefined && { storage: options.mongo.storage }),
    ...(options.values !== undefined && { values: options.values }),
  };
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap',
      kind: options.kind ?? 'ClickStackBootstrap',
      spec: ClickStackBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackBootstrapConfig) => bootstrapBody(spec, build)
  );
}

function buildExternalComposition(options: ClickStackExternalMongoBuildOptions) {
  const build: ResolvedBuildConfig = {
    mongoMode: 'external',
    ...(options.values !== undefined && { values: options.values }),
  };
  return kubernetesComposition(
    {
      name: options.name ?? 'clickstack-bootstrap-external-mongo',
      kind: options.kind ?? 'ClickStackExternalMongoBootstrap',
      spec: ClickStackExternalMongoBootstrapConfigSchema,
      status: ClickStackBootstrapStatusSchema,
    },
    (spec: ClickStackExternalMongoBootstrapConfig) => bootstrapBody(spec, build)
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
