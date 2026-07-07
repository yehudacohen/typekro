/**
 * ClickHouse Cluster Composition (build-time topology constructor)
 *
 * `makeClickHouseCluster(topology)` separates the two halves of a CHI
 * honestly:
 *
 * - BUILD-TIME topology (`zones`, `replicas`, `shards`, `keeper` presence,
 *   user names/networks) is fixed when the composition is CONSTRUCTED. The
 *   zone-pinned layout enumerates pod templates and per-replica entries, so
 *   it can never be instance-dynamic (the operator's own `podDistribution`
 *   supports only the hostname topologyKey — Altinity/clickhouse-operator
 *   issue #772 — and EBS volumes are zonal, so replicas must be pinned).
 *
 * - RUNTIME spec (`name`, `namespace`, `version`, `storage`, `clusterName`,
 *   keeper host, per-user password hashes) flows through as schema proxies
 *   and serializes to clean CEL in kro mode.
 *
 * Same construction pattern as `makeCaddyIngress`: build-time options select
 * the resource/schema shape statically — no runtime `includeWhen`
 * conditionals, no accepted-but-ignored spec fields.
 */

import { type } from 'arktype';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import {
  type ClickHouseClusterSpec,
  ClickHouseClusterStatusSchema,
  type ClickHouseClusterStatus,
  type ClickHouseClusterTopology,
  type ClickHouseUser,
} from '../types.js';
import {
  clickHouseInstallation,
  DEFAULT_CHI_CLUSTER_NAME,
} from '../resources/installation.js';
import { assertPositiveIntegerCount } from '../utils/validation.js';

/** Native (TCP) ClickHouse port — operator default ChDefaultTCPPortNumber. */
export const CLICKHOUSE_NATIVE_PORT = 9000;
/** HTTP interface port — operator default ChDefaultHTTPPortNumber. */
export const CLICKHOUSE_HTTP_PORT = 8123;
/** Default Keeper/ZooKeeper client port — operator default KpDefaultZKPortNumber. */
export const CLICKHOUSE_KEEPER_PORT = 2181;
/** Default database exposed on the status contract. */
export const CLICKHOUSE_DEFAULT_DATABASE = 'default';
/** Default allowed source networks for declared users. */
export const DEFAULT_USER_NETWORKS_IP = ['::/0'] as const;

/** Resource id of the CHI inside the composition graph. */
const CHI_RESOURCE_ID = 'clickhouse';

/**
 * Normalized build-time topology (defaults applied once, at construction).
 */
interface ResolvedTopology {
  zones: readonly string[];
  replicas: number;
  shards: number;
  keeper: boolean;
  users: readonly { name: string; networksIp: readonly string[] }[];
}

function resolveTopology(topology: ClickHouseClusterTopology): ResolvedTopology {
  const replicas = topology.replicas ?? 1;
  const shards = topology.shards ?? 1;
  // Fail at CONSTRUCTION time (not first serialization): counts are
  // build-time topology, and zero/fractional/negative counts compile to
  // invalid operator input (`replicasCount: 0` / `shardsCount: 0`).
  assertPositiveIntegerCount('makeClickHouseCluster', 'replicas', replicas);
  assertPositiveIntegerCount('makeClickHouseCluster', 'shards', shards);
  return {
    zones: topology.zones ?? [],
    replicas,
    shards,
    // Replicated tables need coordination — default keeper on for
    // multi-replica clusters unless the caller opts out explicitly.
    keeper: topology.keeper ?? replicas > 1,
    users: (topology.users ?? []).map((user) => ({
      name: user.name,
      networksIp: user.networksIp ?? DEFAULT_USER_NETWORKS_IP,
    })),
  };
}

/**
 * Build the runtime spec ArkType schema for a resolved topology. The SHAPE of
 * the schema is a build-time product: `keeper` is required iff the topology
 * enables it, and one `users.<name>` entry (with a required password hash) is
 * required per declared user — user names are literal schema keys, never
 * dynamic path fragments.
 */
function buildSpecSchema(topology: ResolvedTopology) {
  const definition: Record<string, unknown> = {
    name: 'string',
    namespace: 'string',
    version: 'string',
    'clusterName?': 'string',
    storage: {
      size: 'string',
      'storageClassName?': 'string',
    },
    'podResources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
  };

  if (topology.keeper) {
    definition.keeper = { host: 'string', 'port?': 'number' };
  }

  if (topology.users.length > 0) {
    definition.users = Object.fromEntries(
      topology.users.map((user) => [user.name, { passwordSha256Hex: 'string' }])
    );
  }

  return type(definition as never);
}

/**
 * Construct a ClickHouse cluster composition with a FIXED topology.
 *
 * The result is a normal TypeKro composition: use it directly
 * (`factory('kro').deploy({...})`) or nest it in other compositions with
 * schema references for every runtime field.
 *
 * @example
 * ```typescript
 * const clickhouse = makeClickHouseCluster({
 *   zones: ['us-east-2a', 'us-east-2b'],  // zone-pinned replicas (EBS is zonal)
 *   replicas: 2,
 *   shards: 1,
 *   users: [{ name: 'signoz' }],          // names are build-time path fragments
 * });
 *
 * await clickhouse.factory('kro').deploy({
 *   name: 'signoz-clickhouse',
 *   namespace: 'observability',
 *   version: '25.12.5',
 *   storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
 *   keeper: { host: 'keeper-signoz.observability.svc.cluster.local' },
 *   users: { signoz: { passwordSha256Hex: '...' } },
 * });
 * ```
 *
 * Downstream compositions consume the typed service contract:
 * ```typescript
 * signoz({
 *   clickhouse: {
 *     host: ch.status.clickhouse.host,
 *     port: ch.status.clickhouse.port,
 *     cluster: ch.status.clickhouse.clusterName,
 *   },
 * });
 * ```
 */
export function makeClickHouseCluster(
  topology: ClickHouseClusterTopology = {}
): CallableComposition<ClickHouseClusterSpec, ClickHouseClusterStatus> {
  const resolved = resolveTopology(topology);
  const specSchema = buildSpecSchema(resolved);
  const firstUserName = resolved.users[0]?.name;

  return kubernetesComposition(
    {
      name: 'clickhouse-cluster',
      kind: 'ClickHouseCluster',
      spec: specSchema as never,
      status: ClickHouseClusterStatusSchema as never,
    },
    (spec: ClickHouseClusterSpec) => {
      const clusterName = spec.clusterName ?? DEFAULT_CHI_CLUSTER_NAME;

      // Runtime credentials pair with build-time user names by LITERAL key:
      // `spec.users.<name>.passwordSha256Hex` is a plain schema path, so it
      // serializes to clean CEL. Names/networks come from the topology.
      const users: ClickHouseUser[] = resolved.users.map((user) => ({
        name: user.name,
        // biome-ignore lint/style/noNonNullAssertion: the generated schema requires one users.<name> entry per declared user
        passwordSha256Hex: spec.users![user.name]!.passwordSha256Hex,
        networksIp: [...user.networksIp],
      }));

      const clickhouse = clickHouseInstallation({
        name: spec.name,
        namespace: spec.namespace,
        version: spec.version,
        clusterName,
        // BUILD-TIME topology — concrete values from the constructor.
        shards: resolved.shards,
        replicas: resolved.replicas,
        ...(resolved.zones.length > 0 ? { zones: [...resolved.zones] } : {}),
        storage: {
          size: spec.storage.size,
          storageClassName: spec.storage.storageClassName,
        },
        ...(users.length > 0 ? { users } : {}),
        ...(resolved.keeper
          ? {
              keeper: {
                // biome-ignore lint/style/noNonNullAssertion: the generated schema requires keeper when the topology enables it
                host: spec.keeper!.host,
                port: spec.keeper?.port ?? CLICKHOUSE_KEEPER_PORT,
              },
            }
          : {}),
        podResources: spec.podResources,
        id: CHI_RESOURCE_ID,
      });

      // Connection contract derived from the operator's ACTUAL naming
      // (release-0.27.1): the CR-level Service is `clickhouse-{chi-name}`
      // (type ClusterIP; pkg/model/chi/namer/patterns.go +
      // pkg/model/chi/creator/service.go), listening on native 9000 /
      // HTTP 8123 (type_host.go defaults). Per-host services
      // (`chi-{chi}-{cluster}-{shard}-{replica}`) exist too but the CR
      // service is the stable entrypoint.
      //
      // DERIVED FROM THE OWNED CHI RESOURCE (not schema.spec): KRO status
      // CEL cannot reference schema.spec.*, so a spec-derived field is
      // classified static (client-hydrated) and DROPPED from the KRO CR's
      // status. Anchoring the derivation on the CHI resource
      // (`clickhouse.metadata.*` / `clickhouse.spec.*`) makes these
      // serialize as KRO status CEL, so GitOps/KRO consumers see the
      // connection contract on the live CR.
      //
      // The string concats are RAW Cel.expr over the resource id: the
      // status-builder proxy passes `metadata` values through verbatim
      // (which would resolve back to schema.spec.name → static), and the
      // serializer inlines CelExpression-valued template fields (like the
      // defaulted clusterName / keeper port) back to their schema
      // expressions — a raw resource-path expression survives both. Port
      // constants ride INSIDE the resource-derived URL strings; the BARE
      // constant fields (port/database/user) have no resource anchor and
      // stay client-hydrated — see ClickHouseClusterStatus for the split.
      const chiMeta = `${CHI_RESOURCE_ID}.metadata`;
      const chiHostCel = `"clickhouse-" + ${chiMeta}.name + "." + ${chiMeta}.namespace + ".svc.cluster.local"`;

      return {
        ready: clickhouse.status.status === 'Completed',
        phase:
          clickhouse.status.status === 'Completed'
            ? 'Ready'
            : clickhouse.status.status === 'Aborted'
              ? 'Failed'
              : 'Installing',
        clickhouse: {
          host: Cel.expr<string>(chiHostCel),
          // Bare numeric constant — client-hydrated only (no resource
          // anchor); the port also appears in the KRO-visible URLs below.
          port: CLICKHOUSE_NATIVE_PORT,
          nativeUrl: Cel.expr<string>(
            `"clickhouse://" + ${chiHostCel} + ":${CLICKHOUSE_NATIVE_PORT}"`
          ),
          httpUrl: Cel.expr<string>(
            `"http://" + ${chiHostCel} + ":${CLICKHOUSE_HTTP_PORT}"`
          ),
          // The resolved logical cluster name is IN the owned CHI
          // (configuration.clusters[0].name), so read it from there — the
          // `spec.clusterName ?? default` expression itself is schema-only
          // and would be dropped.
          clusterName: Cel.expr<string>(
            `${CHI_RESOURCE_ID}.spec.configuration.clusters[0].name`
          ),
          database: CLICKHOUSE_DEFAULT_DATABASE,
          ...(firstUserName ? { user: firstUserName } : {}),
        },
        ...(resolved.keeper
          ? {
              keeper: {
                // Echo the keeper endpoint from the CHI's own zookeeper
                // section (resource-derived → lands in KRO status) rather
                // than from schema.spec.keeper (static → dropped).
                host: Cel.expr<string>(
                  `${CHI_RESOURCE_ID}.spec.configuration.zookeeper.nodes[0].host`
                ),
                port: Cel.expr<number>(
                  `${CHI_RESOURCE_ID}.spec.configuration.zookeeper.nodes[0].port`
                ),
              },
            }
          : {}),
        installation: {
          // CHI identity from the owned resource (same reachability rule).
          name: Cel.expr<string>(`${chiMeta}.name`),
          namespace: Cel.expr<string>(`${chiMeta}.namespace`),
          endpoint: clickhouse.status.endpoint,
          // The operator's REAL CHI status fields are `hosts`/`hostsCompleted` — verified against
          // the installed CRD's OpenAPI schema on a live cluster. `hostsCount`/`hostsCompletedCount`
          // do not exist on the resource and made KRO reject the RGD outright ("undefined field
          // 'hostsCompletedCount'", GraphAccepted=False, state Inactive) — caught only by a LIVE
          // admission run; the CEL type-checker has no notion of the operator's real CRD schema.
          // The PUBLIC contract keeps the more explicit field names the review asked for; only the
          // CEL source reference changes.
          hostsCount: clickhouse.status.hosts,
          hostsCompletedCount: clickhouse.status.hostsCompleted,
        },
      };
    }
  ) as unknown as CallableComposition<ClickHouseClusterSpec, ClickHouseClusterStatus>;
}

/**
 * The default single-node cluster composition (1 shard, 1 replica, no zones,
 * no keeper, no declared users). See {@link makeClickHouseCluster} for
 * topology options.
 */
export const clickHouseCluster = makeClickHouseCluster();
