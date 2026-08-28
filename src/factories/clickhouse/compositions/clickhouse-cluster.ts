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
  users: readonly {
    name: string;
    networksIp: readonly string[];
    credentialSource: 'sha256Hex' | 'secret';
  }[];
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
      credentialSource: user.credentialSource ?? 'sha256Hex',
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
    definition.keeper = { host: 'string', 'port?': 'number.integer' };
  }

  if (topology.users.length > 0) {
    definition.users = Object.fromEntries(
      topology.users.map((user) => [
        user.name,
        user.credentialSource === 'secret'
          ? {
              passwordSecretRef: {
                name: 'string > 0',
                key: 'string > 0',
              },
            }
          : { passwordSha256Hex: 'string' },
      ])
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
      const users: ClickHouseUser[] = resolved.users.map((user) => {
        // biome-ignore lint/style/noNonNullAssertion: the generated schema requires one users.<name> entry per declared user
        const credential = spec.users![user.name]!;
        return {
          name: user.name,
          ...(user.credentialSource === 'secret'
            ? {
                passwordSecretRef: (
                  credential as { passwordSecretRef: { name: string; key: string } }
                ).passwordSecretRef,
              }
            : {
                passwordSha256Hex: (
                  credential as { passwordSha256Hex: string }
                ).passwordSha256Hex,
              }),
          networksIp: [...user.networksIp],
        };
      });

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
      // DERIVED FROM THE OWNED CHI RESOURCE (`clickhouse.metadata.*` /
      // `clickhouse.spec.*`) via NATURAL proxy access inside JS template
      // literals — NOT schema.spec.*. Two things make this the right form
      // in BOTH factory modes (typekro >= 0.24.0, which ships the #97
      // resource-metadata-proxy fix):
      //   - KRO mode: the imperative analyzer converts these template
      //     literals to KRO status CEL, and (post-#97) `clickhouse.metadata.*`
      //     resolves resource-anchored (`clickhouse.metadata.name`) instead
      //     of degrading to `schema.spec.name`, so they land on the live CR
      //     status for GitOps/KRO consumers.
      //   - direct mode: a template literal is plain JS, so direct mode's
      //     live-status re-execution evaluates it against the real resource
      //     values and hydrates a concrete string — where the old raw
      //     `Cel.expr("...literal CEL...")` strings stayed opaque markers.
      // The port constants inline as literals; the BARE constant fields
      // (port/database/user) have no resource anchor — see
      // ClickHouseClusterStatus for the split.
      return {
        ready: clickhouse.status.status === 'Completed',
        phase:
          clickhouse.status.status === 'Completed'
            ? 'Ready'
            : clickhouse.status.status === 'Aborted'
              ? 'Failed'
              : 'Installing',
        clickhouse: {
          host: `clickhouse-${clickhouse.metadata.name}.${clickhouse.metadata.namespace}.svc.cluster.local`,
          // Bare numeric constant — client-hydrated only (no resource
          // anchor); the port also appears in the KRO-visible URLs below.
          port: CLICKHOUSE_NATIVE_PORT,
          nativeUrl: `clickhouse://clickhouse-${clickhouse.metadata.name}.${clickhouse.metadata.namespace}.svc.cluster.local:${CLICKHOUSE_NATIVE_PORT}`,
          httpUrl: `http://clickhouse-${clickhouse.metadata.name}.${clickhouse.metadata.namespace}.svc.cluster.local:${CLICKHOUSE_HTTP_PORT}`,
          // The resolved logical cluster name is IN the owned CHI
          // (configuration.clusters[0].name), so read it from there — the
          // `spec.clusterName ?? default` expression itself is schema-only
          // and would be dropped. Kept as a raw Cel.expr (not a natural
          // template literal) because this is a deep read through an optional
          // nested array (`configuration.clusters[0]`), where natural proxy
          // access needs non-null assertions that add noise without changing
          // the output. That is an ERGONOMIC choice, NOT a hydration limit:
          // being a resource-path CEL it resolves in BOTH modes on typekro
          // >= 0.24.0 — status CEL in `factory('kro')`, and the cel-js
          // reference resolver evaluates it against the live CHI in
          // `factory('direct')` (proven concrete — `'cluster'` — in the
          // integration suite). Same for keeper.* below.
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
                // than from schema.spec.keeper (static → dropped). Kept as raw
                // Cel.expr for the same reasons as clusterName (deep optional
                // array read) — plus `port` must stay a number, which a
                // template literal would coerce to a string. Like clusterName,
                // these are resource-path CELs that resolve in BOTH modes
                // (cel-js evaluates them in direct mode) — not KRO-only.
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
          name: `${clickhouse.metadata.name}`,
          namespace: `${clickhouse.metadata.namespace}`,
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
