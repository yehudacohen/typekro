/**
 * ClickStack Helm values mappers.
 *
 * Pure functions mapping typed factory config onto OFFICIAL chart values.
 * Bootstrap-only fields (name, namespace, chart version, Flux repository
 * names) stay in TypeKro resource configuration and are never forwarded.
 *
 * BUILD-TIME vs RUNTIME: the mappers take the runtime spec (proxy-safe VALUES
 * only — concrete in direct mode, schema refs in KRO mode) plus concrete
 * build-time options (`mongoMode`, static raw `values`). All plain-JS
 * branching happens on the build-time options; runtime fields are only ever
 * embedded as values or wrapped in explicit `has()`-guarded CEL.
 *
 * Values keys verified 2026-07-06 against
 * https://github.com/ClickHouse/ClickStack-helm-charts
 * charts/clickstack/values.yaml (chart 3.2.0, appVersion 2.35.0):
 * - `hyperdx.config.*` env map: `CLICKHOUSE_ENDPOINT` (native, tcp://…),
 *   `CLICKHOUSE_SERVER_ENDPOINT` (host:port), `CLICKHOUSE_USER`,
 *   `HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE`, `MONGO_URI`, `FRONTEND_URL`.
 * - `hyperdx.secrets.*`: `CLICKHOUSE_PASSWORD` (collector/ingest user),
 *   `CLICKHOUSE_APP_PASSWORD` (UI user), `HYPERDX_API_KEY`,
 *   `MONGODB_PASSWORD` (unused here — internal Mongo runs authless, external
 *   Mongo carries credentials in its URI).
 * - DOC-VS-TEMPLATE DISCREPANCY: several docs describe `defaultConnections` /
 *   `defaultSources` directly under `hyperdx.*`, but the chart templates read
 *   them from `hyperdx.deployment.defaultConnections` /
 *   `hyperdx.deployment.defaultSources` (values.yaml lines 100/110) — the
 *   deployment block is what we set. The same block offers
 *   `useExistingConfigSecret`/`existingConfigSecret` for external secret
 *   management (reachable via the build-time `values` passthrough).
 * - `clickhouse.enabled` / `mongodb.enabled`: both HARD-PINNED to false here.
 *   The bundled ClickHouse/Keeper are `ClickHouseCluster`/`KeeperCluster`
 *   CRDs and the bundled Mongo is a `MongoDBCommunity` CRD — all owned by the
 *   separate `clickstack-operators` prerequisite chart we refuse to install
 *   (ClickHouse Inc.'s operator CRDs would collide with our Altinity
 *   operator). These pins beat the raw `values` passthrough in BOTH modes
 *   because the merge happens at construction time on concrete objects.
 * - `fullnameOverride`: pinned to the release name — the status contract's
 *   naming anchor. With it set, the chart's `clickstack.hyperdx.fullname`
 *   helper names the HyperDX app resources exactly `<release>` (no `-app`
 *   suffix), and the gateway Service stays `<release>-otel-collector`
 *   (subchart naming from `.Release.Name`), so the bootstrap status can
 *   derive endpoints deterministically.
 * - `otel-collector.*`: the gateway subchart (alias) stays enabled with chart
 *   defaults; it reads the shared `clickstack-config` ConfigMap and
 *   `clickstack-secret` Secret via `extraEnvsFrom`, so the external-CH env
 *   above reconfigures it too (its goose migrations create the otel_* tables
 *   in the external ClickHouse at startup).
 */

import {
  isMergeableValuesObject,
  isValuesMergeExpression,
  mergeValuesExpression,
} from '../../../core/aspects/values-merge.js';
import { Cel } from '../../../core/references/cel.js';
import type { TypeKroChartValues } from '../../../core/types/common.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { CLICKSTACK_MONGO_NAME_SUFFIX, CLICKSTACK_MONGO_PORT } from '../resources/mongo.js';
import { type CollectorConfigFragment, renderCollectorConfig } from './collector-config.js';
import { CLICKSTACK_CONNECTION_NAME, CLICKSTACK_DEFAULT_SOURCES } from './team-defaults.js';
import {
  type ResolvedClickStackStorage,
  clickStackQueueClaimName,
  persistentQueueConfigFragment,
  renderPersistentQueueValues,
} from './storage.js';
import type {
  ClickStackBootstrapConfig,
  ClickStackBootstrapRuntimeConfig,
  ClickStackExternalMongoBootstrapConfig,
  ClickStackHelmValues,
  ClickStackK8sTelemetryConfig,
  ClickStackMappedHelmValues,
  OtelCollectorHelmValues,
  OtelCollectorMappedHelmValues,
} from '../types.js';

/** Default namespace for a ClickStack install. */
export const DEFAULT_CLICKSTACK_NAMESPACE = 'clickstack';

/** Default namespace for the k8s telemetry collectors. */
export const DEFAULT_CLICKSTACK_TELEMETRY_NAMESPACE = 'clickstack-telemetry';

/**
 * Default OTLP/HTTP endpoint of the ClickStack gateway collector, assuming
 * the canonical `clickstackBootstrap` install (release name 'clickstack' in
 * namespace 'clickstack'). The chart names the gateway Service
 * `<release>-otel-collector` (templates/_helpers.tpl `clickstack.otel.fullname`)
 * and exposes otlp-http on servicePort 4318 (values.yaml `otel-collector.ports`).
 * Prefer wiring `stack.status.gateway.otlpHttpEndpoint` instead of relying on
 * this default.
 */
export const DEFAULT_CLICKSTACK_GATEWAY_ENDPOINT =
  'http://clickstack-otel-collector.clickstack.svc.cluster.local:4318';

/**
 * Collector image for the k8s telemetry instances. The stock chart ships an
 * empty `image.repository` on purpose; the ClickStack k8s ingestion docs use
 * the contrib distribution (it carries the k8s receivers the presets enable).
 */
export const DEFAULT_K8S_TELEMETRY_COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib';

export { CLICKSTACK_CONNECTION_NAME } from './team-defaults.js';

/**
 * The ClickStack image runs under the OpAMP supervisor. Its built-in remote
 * configuration declares the OTLP receiver but, without an overlay, does not
 * attach it to any pipeline. The Service and health endpoint can therefore be
 * Ready while 4317/4318 refuse connections. Chart 3.1+ provides the supported
 * `global.otelCollector.customConfig` merge seam; keep every built-in receiver
 * while attaching OTLP to all three signal pipelines.
 *
 * ⚠️ A STRUCTURED FRAGMENT, not YAML text. It shares the overlay — ONE YAML
 * document — with the persistent queue's own wiring, and both contribute a
 * top-level `service` key. Concatenating the two texts declared `service`
 * twice and the supervisor rejected the whole file, so contributions are
 * deep-merged and serialised exactly once through
 * `renderCollectorConfig`. See `utils/collector-config.ts`.
 */
export const CLICKSTACK_INGEST_PIPELINES_FRAGMENT: CollectorConfigFragment = {
  service: {
    pipelines: {
      'logs/in': { receivers: ['fluentforward', 'otlp/hyperdx'] },
      metrics: { receivers: ['prometheus', 'otlp/hyperdx'] },
      traces: { receivers: ['nop', 'otlp/hyperdx'] },
    },
  },
};

/**
 * The ingest-pipelines overlay on its own — the rendering emitted when no
 * persistent queue is configured.
 *
 * BYTE-IDENTICAL to the hand-written string this constant replaced. That is
 * not a coincidence: `renderCollectorConfig`'s flow level is chosen so the
 * `receivers` lists stay inline, and a unit test pins the exact text. The
 * queue fix must not churn the ConfigMap of every install that does not use
 * the queue.
 */
export const CLICKSTACK_INGEST_PIPELINES_CONFIG = renderCollectorConfig([
  CLICKSTACK_INGEST_PIPELINES_FRAGMENT,
]);

/** Concrete build-time options consumed by the bootstrap values mapper. */
export interface ClickStackValuesMapperOptions {
  /** Which Mongo wiring to emit (build-time; default 'internal'). */
  mongoMode?: 'internal' | 'external';
  /** Static raw chart values merged after the typed mapping (pins re-applied after). */
  values?: TypeKroChartValues<ClickStackHelmValues>;
  /** Runtime credential transport selected by the composition constructor. */
  credentialSource?: 'inline' | 'secretValues';
  /**
   * Resolved storage consumption options. Only the persistent sending queue
   * reaches chart values — the storage POLICY needs none, because the
   * `clickhouse` factory makes it the server default.
   */
  storage?: ResolvedClickStackStorage;
}

/** Values pair for the two stock collector instances. */
export interface ClickStackK8sTelemetryValues {
  daemonset: OtelCollectorMappedHelmValues;
  deployment: OtelCollectorMappedHelmValues;
}

// ============================================================================
// Shared helpers
// ============================================================================

/** `has()`-guard chain for a `schema.spec.…` path (dagster mapper pattern). */
function hasSchemaPath(path: string): string {
  const parts = path.split('.');
  const guards: string[] = [];
  for (let index = 2; index < parts.length; index++) {
    guards.push(`has(${parts.slice(0, index + 1).join('.')})`);
  }
  return guards.join(' && ');
}

/** Resolve a possibly-ref runtime value with a fallback, in either mode. */
function resolve<T>(value: T | undefined, fallback: NonNullable<T>): NonNullable<T> {
  if (isKubernetesRef(value)) {
    return Cel.default(
      value as Parameters<typeof Cel.default>[0],
      fallback as Parameters<typeof Cel.default>[1]
    ) as unknown as NonNullable<T>;
  }
  return (value ?? fallback) as NonNullable<T>;
}

/**
 * Graph-mode optional passthrough: emit the schema value when the instance
 * sets it, `omit()` the key otherwise. `dyn()` wraps the present branch so the
 * ternary type-checks against map-typed `omit()` (KRO has no mixed `_?_:_`
 * overload — same trick as the dagster mapper).
 */
function graphOptional(path: string): unknown {
  return Cel.expr(`${hasSchemaPath(path)} ? dyn(${path}) : omit()`);
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function isMergeObject(value: unknown): value is Record<string, unknown> {
  return isMergeableValuesObject(value);
}

/**
 * Deep merge (objects merge recursively, arrays/primitives replace, source wins),
 * copy-on-write.
 *
 * Only `target` itself is written. A nested object already in `target` is copied
 * before anything is merged into it, and a subtree taken from `source` is cloned,
 * so the result never shares a mutable object with either side. Both sides can
 * belong to the caller: the build-time `values` passthrough and typed spec fields
 * reach this merge by reference, and the hard pins are merged over them
 * afterwards. Merging in place wrote the pins into the caller's own `values`, and
 * the next build then read them back as if the caller had set them.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (isMergeObject(targetValue) && isMergeObject(sourceValue)) {
      const next = { ...targetValue };
      deepMerge(next, sourceValue);
      target[key] = next;
    } else {
      target[key] = cloneMergeValue(sourceValue);
    }
  }
}

/**
 * Copy a values subtree: plain objects and arrays are rebuilt at every depth.
 * Opaque leaves (references, CEL expressions, templates, merge nodes, and
 * anything carrying a symbol brand, such as the planning markers) stay as they
 * are, as does any frozen or non-plain object. A frozen object cannot be
 * mutated through the result, and the recursion above copies before writing.
 */
function cloneMergeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMergeValue);
  if (!isMergeObject(value) || Object.isFrozen(value)) return value;
  const copy: Record<string, unknown> = {};
  deepMerge(copy, value);
  return copy;
}

/**
 * Merge overrides then re-apply the hard pins so the pins ALWAYS win.
 *
 * - Concrete override objects (build-time `values`, direct-mode
 *   `customValues`) deep-merge into the base; the pins deep-merge after them.
 * - A graph-aware override (`customValues` arriving as a schema ref / CEL
 *   expression from an outer composition) routes through TypeKro's runtime
 *   values merge (`mergeValuesExpression`, the machinery the serializer
 *   compiles to a KRO runtime map-merge — same path as the dagster/ory
 *   families), with the pins overlay merged LAST so the hard pins beat the
 *   per-instance override in the KRO-serialized HelmRelease values too.
 */
function mergeOverridesWithPinsLast(
  base: Record<string, unknown>,
  overrides: readonly unknown[],
  pins: Record<string, unknown>
): ClickStackMappedHelmValues {
  let merged: ClickStackMappedHelmValues = base;

  for (const override of overrides) {
    if (override === undefined) continue;
    if (
      isKubernetesRef(override) ||
      isCelExpression(override) ||
      isValuesMergeExpression(override)
    ) {
      merged = mergeValuesExpression(merged, override) as ClickStackMappedHelmValues;
    } else if (isMergeObject(override)) {
      if (isValuesMergeExpression(merged)) {
        merged = mergeValuesExpression(merged, override) as ClickStackMappedHelmValues;
      } else {
        deepMerge(merged as Record<string, unknown>, override);
      }
    }
  }

  // Hard pins LAST — they beat every passthrough in both modes.
  if (isValuesMergeExpression(merged)) {
    return mergeValuesExpression(merged, pins) as ClickStackMappedHelmValues;
  }
  deepMerge(merged as Record<string, unknown>, pins);
  return merged;
}

// ============================================================================
// HyperDX default connections / sources (external ClickHouse)
// ============================================================================

/**
 * With `clickhouse.enabled: false` the chart still renders its default
 * `defaultConnections`/`defaultSources` pointing at the (nonexistent) bundled
 * ClickHouse Service, so both must be overridden for external mode. The
 * sources below mirror the chart defaults (values.yaml `defaultSources`,
 * chart 3.2.0) with the connection renamed and the database a Helm template.
 */
// The JSON itself is a Helm template, built below (CLICKSTACK_DEFAULT_SOURCES_TEMPLATE).

/**
 * The connection and database the Team bootstrap seeds, derived exactly as
 * `defaultConnections` / `defaultSources` derive them: `http://<host>:<httpPort>`,
 * the UI user (`appUsername`, else `username`, else `default`) and the OTel
 * database. Concrete values in direct mode, CEL in KRO mode. The password is
 * not here: the CronJob reads it from the chart-owned Secret.
 */
export function clickStackDefaultConnectionTarget(config: ClickStackBootstrapRuntimeConfig): {
  host: string;
  username: string;
  database: string;
} {
  const ch = config.clickhouse;
  if (isKubernetesRef(config.name) || isKubernetesRef(ch)) {
    const httpPortStr = Cel.expr<string>(
      `string(${hasSchemaPath('schema.spec.clickhouse.httpPort')} ? schema.spec.clickhouse.httpPort : 8123)`
    );
    return {
      host: Cel.template('http://%s:%s', ch.host, httpPortStr) as unknown as string,
      username: Cel.expr<string>(
        `${hasSchemaPath('schema.spec.clickhouse.appUsername')} ? schema.spec.clickhouse.appUsername : ` +
          `(${hasSchemaPath('schema.spec.clickhouse.username')} ? schema.spec.clickhouse.username : "default")`
      ) as unknown as string,
      database: resolve(ch.database, 'default'),
    };
  }
  return {
    host: `http://${ch.host}:${ch.httpPort ?? 8123}`,
    username: ch.appUsername ?? ch.username ?? 'default',
    database: ch.database ?? 'default',
  };
}

/**
 * The chart value HyperDX's `DEFAULT_CONNECTIONS` password is read from in
 * `secretValues` mode, as a Helm template. The chart runs `tpl` over
 * `hyperdx.deployment.defaultConnections` with the release's merged values
 * (its own default uses `{{ .Values.hyperdx.secrets.CLICKHOUSE_APP_PASSWORD }}`),
 * so the caller's `valuesFrom` fragment supplies the password while TypeKro
 * supplies the topology. `toJson` quotes and escapes it as a JSON string.
 */
export const CLICKSTACK_APP_PASSWORD_VALUE_TEMPLATE =
  '{{ .Values.hyperdx.secrets.CLICKHOUSE_APP_PASSWORD | toJson }}';

/** Key of the values document in the `secretValues` default-connections ConfigMap. */
export const CLICKSTACK_DEFAULT_CONNECTIONS_VALUES_KEY = 'values.yaml';

/**
 * Where, in the HelmRelease's own `spec.values`, TypeKro puts the non-secret
 * values HyperDX's default connection and sources are built from: host URL,
 * port and user under `.defaultConnection`, the OTel database under
 * `.defaultSources`. The chart ignores the key; the templates below read it.
 */
export const CLICKSTACK_DEFAULTS_VALUES_PATH = 'typekro.clickstack';
/** @deprecated Use {@link CLICKSTACK_DEFAULTS_VALUES_PATH}; kept for the `.defaultConnection` path. */
export const CLICKSTACK_DEFAULT_CONNECTION_VALUES_PATH = `${CLICKSTACK_DEFAULTS_VALUES_PATH}.defaultConnection`;

/** A Helm template that serialises one chart value as JSON. */
const toJsonTemplate = (path: string) => `{{ .Values.${path} | toJson }}`;

/**
 * HyperDX's `defaultConnections`, in BOTH credential modes: a Helm template
 * the chart runs `tpl` over (with the release's merged values) when it sets
 * `DEFAULT_CONNECTIONS`. Every field is serialised by `toJson`: the host,
 * port and user from {@link CLICKSTACK_DEFAULTS_VALUES_PATH}, the password
 * from `hyperdx.secrets.CLICKHOUSE_APP_PASSWORD` (rendered by TypeKro inline,
 * supplied by the values fragment with `secretValues`). Nothing user-supplied
 * is ever interpolated into JSON by hand, so a quote, backslash or space in
 * any field stays valid JSON, in direct and KRO mode alike.
 */
export const CLICKSTACK_DEFAULT_CONNECTIONS_TEMPLATE = (() => {
  const connection = `${CLICKSTACK_DEFAULTS_VALUES_PATH}.defaultConnection`;
  return `[{"name":${JSON.stringify(CLICKSTACK_CONNECTION_NAME)},"host":${toJsonTemplate(`${connection}.host`)},"port":${toJsonTemplate(`${connection}.port`)},"username":${toJsonTemplate(`${connection}.username`)},"password":${CLICKSTACK_APP_PASSWORD_VALUE_TEMPLATE}}]`;
})();

/**
 * HyperDX's `defaultSources`: {@link CLICKSTACK_DEFAULT_SOURCES} with every
 * `databaseName` a `toJson` template of the OTel database, for the same
 * reason as {@link CLICKSTACK_DEFAULT_CONNECTIONS_TEMPLATE}.
 */
export const CLICKSTACK_DEFAULT_SOURCES_TEMPLATE = JSON.stringify(
  CLICKSTACK_DEFAULT_SOURCES
).replaceAll('"%s"', toJsonTemplate(`${CLICKSTACK_DEFAULTS_VALUES_PATH}.defaultSources.database`));

/**
 * The `secretValues`-mode values document that sets
 * `hyperdx.deployment.defaultConnections` to
 * {@link CLICKSTACK_DEFAULT_CONNECTIONS_TEMPLATE}.
 *
 * WHY A SEPARATE DOCUMENT. TypeKro renders no `defaultConnections` in
 * `spec.values` in this mode, because Flux applies `spec.values` last and it
 * would override a `defaultConnections` in the caller's fragment. Without one
 * the chart falls back to its own "Local ClickHouse" at the bundled ClickHouse
 * Service TypeKro disables, which HyperDX's registration (`initialUser`) would
 * provision. The composition hands this document to Flux as a ConfigMap
 * `valuesFrom` entry BEFORE the caller's Secret, so the fragment still wins.
 */
export const CLICKSTACK_SECRET_VALUES_DEFAULT_CONNECTIONS_DOCUMENT = [
  'hyperdx:',
  '  deployment:',
  '    defaultConnections: |',
  `      ${CLICKSTACK_DEFAULT_CONNECTIONS_TEMPLATE}`,
  '',
].join('\n');

/**
 * The typed values the templates read (see {@link CLICKSTACK_DEFAULTS_VALUES_PATH}):
 * the same host, port, user and database the seed uses.
 */
function clickStackDefaultsValues(config: ClickStackBootstrapRuntimeConfig): {
  defaultConnection: { host: string; port: number; username: string };
  defaultSources: { database: string };
} {
  const target = clickStackDefaultConnectionTarget(config);
  const ch = config.clickhouse;
  const port =
    isKubernetesRef(config.name) || isKubernetesRef(ch)
      ? (Cel.expr<number>(
          `${hasSchemaPath('schema.spec.clickhouse.httpPort')} ? schema.spec.clickhouse.httpPort : 8123`
        ) as unknown as number)
      : (ch.httpPort ?? 8123);
  return {
    defaultConnection: { host: target.host, port, username: target.username },
    defaultSources: { database: target.database },
  };
}

// ============================================================================
// clickstackBootstrap values
// ============================================================================

/**
 * Map typed ClickStack runtime config + build options into official
 * clickstack chart values.
 *
 * Handles both composition modes: concrete config (direct mode) emits plain
 * values; schema-proxy config (KRO mode) emits `has()`-guarded CEL so chart
 * defaults resolve per instance.
 */
export function mapClickStackConfigToHelmValues(
  config: ClickStackBootstrapRuntimeConfig,
  options: ClickStackValuesMapperOptions = {}
): ClickStackMappedHelmValues {
  const isGraph = isKubernetesRef(config.name) || isKubernetesRef(config.clickhouse);
  const mongoMode = options.mongoMode ?? 'internal';
  const credentialSource = options.credentialSource ?? 'inline';

  const ch = config.clickhouse;
  const hyperdxConfig: Record<string, unknown> = {};
  const hyperdxSecrets: Record<string, unknown> = {};
  const hyperdxDeployment: Record<string, unknown> = {};

  if (isGraph) {
    // Ports as string()-wrapped CEL so they compose into mixed string
    // templates (KRO mixed templates want string-typed segments).
    const nativePortStr = Cel.expr<string>(
      `string(${hasSchemaPath('schema.spec.clickhouse.nativePort')} ? schema.spec.clickhouse.nativePort : 9000)`
    );
    hyperdxConfig.CLICKHOUSE_ENDPOINT = Cel.template(
      'tcp://%s:%s?dial_timeout=10s',
      ch.host,
      nativePortStr
    );
    hyperdxConfig.CLICKHOUSE_SERVER_ENDPOINT = Cel.template('%s:%s', ch.host, nativePortStr);
    hyperdxConfig.CLICKHOUSE_USER = resolve(ch.username, 'default');
    hyperdxConfig.HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE = resolve(ch.database, 'default');
    hyperdxConfig.MONGO_URI =
      mongoMode === 'external'
        ? config.mongoUri
        : Cel.template(
            `mongodb://%s${CLICKSTACK_MONGO_NAME_SUFFIX}.%s.svc.cluster.local:${CLICKSTACK_MONGO_PORT}/hyperdx`,
            config.name,
            resolve(config.namespace, DEFAULT_CLICKSTACK_NAMESPACE)
          );
    hyperdxConfig.FRONTEND_URL = graphOptional('schema.spec.hyperdx.frontendUrl');

    if (credentialSource === 'inline') {
      const inlineConfig = config as
        | ClickStackBootstrapConfig
        | ClickStackExternalMongoBootstrapConfig;
      const inlineClickhouse = inlineConfig.clickhouse;
      const appPassword = Cel.expr<string>(
        `${hasSchemaPath('schema.spec.clickhouse.appPassword')} ? schema.spec.clickhouse.appPassword : ` +
          `(${hasSchemaPath('schema.spec.clickhouse.password')} ? schema.spec.clickhouse.password : "")`
      );
      hyperdxSecrets.CLICKHOUSE_PASSWORD = resolve(inlineClickhouse.password, '');
      hyperdxSecrets.CLICKHOUSE_APP_PASSWORD = appPassword;
      hyperdxSecrets.HYPERDX_API_KEY = inlineConfig.apiKey;
      hyperdxDeployment.defaultConnections = CLICKSTACK_DEFAULT_CONNECTIONS_TEMPLATE;
    }

    hyperdxDeployment.replicas = graphOptional('schema.spec.hyperdx.replicas');
    hyperdxDeployment.resources = graphOptional('schema.spec.hyperdx.resources');
    hyperdxDeployment.image = graphOptional('schema.spec.hyperdx.image');
    hyperdxDeployment.defaultSources = CLICKSTACK_DEFAULT_SOURCES_TEMPLATE;
  } else {
    const nativePort = ch.nativePort ?? 9000;
    const database = ch.database ?? 'default';
    const username = ch.username ?? 'default';
    hyperdxConfig.CLICKHOUSE_ENDPOINT = `tcp://${ch.host}:${nativePort}?dial_timeout=10s`;
    hyperdxConfig.CLICKHOUSE_SERVER_ENDPOINT = `${ch.host}:${nativePort}`;
    hyperdxConfig.CLICKHOUSE_USER = username;
    hyperdxConfig.HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE = database;
    hyperdxConfig.MONGO_URI =
      mongoMode === 'external'
        ? (config.mongoUri as string)
        : `mongodb://${config.name}${CLICKSTACK_MONGO_NAME_SUFFIX}.${config.namespace ?? DEFAULT_CLICKSTACK_NAMESPACE}.svc.cluster.local:${CLICKSTACK_MONGO_PORT}/hyperdx`;
    setIfDefined(hyperdxConfig, 'FRONTEND_URL', config.hyperdx?.frontendUrl);

    if (credentialSource === 'inline') {
      const inlineConfig = config as
        | ClickStackBootstrapConfig
        | ClickStackExternalMongoBootstrapConfig;
      const inlineClickhouse = inlineConfig.clickhouse;
      const password = inlineClickhouse.password ?? '';
      const appPassword = inlineClickhouse.appPassword ?? password;
      hyperdxSecrets.CLICKHOUSE_PASSWORD = password;
      hyperdxSecrets.CLICKHOUSE_APP_PASSWORD = appPassword;
      hyperdxSecrets.HYPERDX_API_KEY = inlineConfig.apiKey;
      hyperdxDeployment.defaultConnections = CLICKSTACK_DEFAULT_CONNECTIONS_TEMPLATE;
    }

    setIfDefined(hyperdxDeployment, 'replicas', config.hyperdx?.replicas);
    setIfDefined(hyperdxDeployment, 'resources', config.hyperdx?.resources);
    setIfDefined(hyperdxDeployment, 'image', config.hyperdx?.image);
    hyperdxDeployment.defaultSources = CLICKSTACK_DEFAULT_SOURCES_TEMPLATE;
  }

  const values: ClickStackHelmValues = {
    hyperdx: {
      config: hyperdxConfig,
      ...(credentialSource === 'inline' ? { secrets: hyperdxSecrets } : {}),
      deployment: hyperdxDeployment,
    },
    // The non-secret values the defaultConnections / defaultSources templates
    // read (both credential modes).
    typekro: { clickstack: clickStackDefaultsValues(config) },
  } as ClickStackHelmValues;

  // Hard pins (see module doc): external-only build-around + the status
  // contract's naming anchor. Merged AFTER every passthrough so they always
  // win — including over a graph-aware per-instance `customValues` override.
  // The persistent sending queue extends the SAME `customConfig` overlay the
  // ingest pipelines use, and pins the volume that backs its directory — a
  // queue whose directory is not writable degrades silently, and one backed by
  // a Pod-scoped volume degrades just as silently on the next restart, so both
  // halves travel together and beat the values passthrough. The mounted claim
  // is the standalone PVC the composition creates; the name comes from the
  // shared helper so the mount and the claim cannot drift.
  //
  // ⚠️ The overlay is COMPOSED, never concatenated. Both contributors carry a
  // top-level `service` key, and appending one YAML text to the other declared
  // it twice — which the OpAMP supervisor rejects for the WHOLE file
  // (`mapping key "service" already defined`), leaving the agent with neither
  // the ingest pipelines nor the queue while the Pod still reported Ready.
  // `renderCollectorConfig` deep-merges the fragments and serialises once.
  const queue = options.storage?.persistentQueue;
  const collectorFragments: CollectorConfigFragment[] = [CLICKSTACK_INGEST_PIPELINES_FRAGMENT];
  if (queue !== undefined) collectorFragments.push(persistentQueueConfigFragment(queue));
  const pins: Record<string, unknown> = {
    global: {
      otelCollector: {
        customConfig: renderCollectorConfig(collectorFragments),
      },
    },
    clickhouse: { enabled: false },
    mongodb: { enabled: false },
    fullnameOverride: config.name,
    ...(queue !== undefined
      ? renderPersistentQueueValues(queue, clickStackQueueClaimName(config.name))
      : {}),
  };

  // Per-instance `customValues` is a DIRECT-mode-only convenience: only a CONCRETE object merges.
  // In graph mode the schema proxy would fabricate a ref for the (deliberately undeclared — see
  // types.ts) field, and the runtime map-merge cannot host this mapper's template leaves — the
  // serialized CEL comes out syntactically invalid (verified empirically). So refs are EXCLUDED
  // here by design; graph-mode chart tweaks go through the build-time `values` instead.
  const concreteCustomValues = isMergeObject(config.customValues) ? config.customValues : undefined;

  // Precedence (low → high): typed mapping < build-time `values`
  // < concrete per-instance `customValues` (direct mode) < hard pins.
  return mergeOverridesWithPinsLast(values, [options.values, concreteCustomValues], pins);
}

// ============================================================================
// clickstackK8sTelemetry values
// ============================================================================

/** Concrete build-time options consumed by the telemetry values mapper. */
export interface ClickStackK8sTelemetryMapperOptions {
  daemonset?: { values?: TypeKroChartValues<OtelCollectorHelmValues> };
  deployment?: { values?: TypeKroChartValues<OtelCollectorHelmValues> };
}

/**
 * Map k8s telemetry runtime config + build options onto values for TWO stock
 * `opentelemetry-collector` chart instances — the documented ClickStack
 * Kubernetes ingestion pattern (verified 2026-07-06 against
 * https://clickhouse.com/docs/use-cases/observability/clickstack/ingesting-data/kubernetes
 * and the stock chart's values.yaml preset names).
 *
 * The API key reaches the exporter via OTel config `${env:HYPERDX_API_KEY}`
 * expansion backed by a `secretKeyRef` env var — the key value itself never
 * enters Helm values. In KRO mode the literal `${env:…}` would be parsed as a
 * KRO CEL template, so it is emitted as the CEL concat `"$" + "{env:…}"`,
 * which KRO evaluates back to the literal at instance materialization.
 */
export function mapK8sTelemetryConfigToHelmValues(
  config: ClickStackK8sTelemetryConfig,
  options: ClickStackK8sTelemetryMapperOptions = {}
): ClickStackK8sTelemetryValues {
  const isGraph = isKubernetesRef(config.name);

  const endpoint = resolve(config.endpoint, DEFAULT_CLICKSTACK_GATEWAY_ENDPOINT);
  const authHeader = otelEnvExpansion(isGraph, 'HYPERDX_API_KEY');
  const kubeletEndpoint = otelEnvExpansion(isGraph, 'K8S_NODE_NAME', ':10250');
  const secretKey = resolve(config.apiKeySecret?.key, 'HYPERDX_API_KEY');

  const extraEnvs = [
    {
      name: 'HYPERDX_API_KEY',
      valueFrom: {
        secretKeyRef: {
          name: config.apiKeySecret?.name,
          key: secretKey,
          // REQUIRED (matches the schema): a missing Secret/key must fail the pod loudly at start,
          // not launch a collector whose exporter silently ships unauthenticated requests.
          optional: false,
        },
      },
    },
  ];

  const exporters = {
    otlphttp: {
      endpoint,
      headers: { authorization: authHeader },
      compression: 'gzip',
    },
  };

  const pipelines = {
    logs: { exporters: ['otlphttp'] },
    metrics: { exporters: ['otlphttp'] },
  };

  const daemonset: Record<string, unknown> = {
    mode: 'daemonset',
    image: { repository: DEFAULT_K8S_TELEMETRY_COLLECTOR_IMAGE },
    // nodes/proxy access for the kubeletstats receiver (docs-faithful).
    clusterRole: {
      create: true,
      rules: [{ apiGroups: [''], resources: ['nodes/proxy'], verbs: ['get'] }],
    },
    presets: {
      logsCollection: { enabled: true },
      hostMetrics: { enabled: true },
      kubernetesAttributes: {
        enabled: true,
        extractAllPodLabels: true,
        extractAllPodAnnotations: true,
      },
      kubeletMetrics: { enabled: true },
    },
    extraEnvs,
    config: {
      receivers: {
        // Docs-recommended kubeletstats tuning: 20s interval + utilization metrics.
        kubeletstats: {
          collection_interval: '20s',
          auth_type: 'serviceAccount',
          endpoint: kubeletEndpoint,
          insecure_skip_verify: true,
          metrics: {
            'k8s.pod.cpu_limit_utilization': { enabled: true },
            'k8s.pod.cpu_request_utilization': { enabled: true },
            'k8s.pod.memory_limit_utilization': { enabled: true },
            'k8s.pod.memory_request_utilization': { enabled: true },
            'k8s.pod.uptime': { enabled: true },
            'k8s.node.uptime': { enabled: true },
            'k8s.container.cpu_limit_utilization': { enabled: true },
            'k8s.container.cpu_request_utilization': { enabled: true },
            'k8s.container.memory_limit_utilization': { enabled: true },
            'k8s.container.memory_request_utilization': { enabled: true },
            'container.uptime': { enabled: true },
          },
        },
      },
      exporters,
      service: { pipelines },
    },
  };

  const deployment: Record<string, unknown> = {
    mode: 'deployment',
    image: { repository: DEFAULT_K8S_TELEMETRY_COLLECTOR_IMAGE },
    replicaCount: 1,
    presets: {
      kubernetesAttributes: {
        enabled: true,
        extractAllPodLabels: true,
        extractAllPodAnnotations: true,
      },
      kubernetesEvents: { enabled: true },
      clusterMetrics: { enabled: true },
    },
    extraEnvs,
    config: {
      exporters,
      service: { pipelines },
    },
  };

  return {
    // `mode` is the identity of each instance — re-pinned after passthrough.
    daemonset: mergeOverridesWithPinsLast(daemonset, [options.daemonset?.values], {
      mode: 'daemonset',
    }) as OtelCollectorMappedHelmValues,
    deployment: mergeOverridesWithPinsLast(deployment, [options.deployment?.values], {
      mode: 'deployment',
    }) as OtelCollectorMappedHelmValues,
  };
}

/**
 * Emit an OTel-config env expansion (`${env:NAME}<suffix>`) safely per mode.
 * Direct mode emits the literal; KRO mode emits `"$" + "{env:NAME}<suffix>"`
 * because a literal `${…}` in an RGD template is parsed (and rejected) as a
 * KRO CEL expression.
 */
function otelEnvExpansion(isGraph: boolean, envVar: string, suffix = ''): unknown {
  if (isGraph) {
    return Cel.expr<string>(`"$" + "{env:${envVar}}${suffix}"`);
  }
  return `\${env:${envVar}}${suffix}`;
}
