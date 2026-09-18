/**
 * ClickHouseKeeperInstallation (CHK) Factory
 *
 * Minimal typed factory for the `clickhouse-keeper.altinity.com/v1`
 * ClickHouseKeeperInstallation CRD (coordination service for replicated
 * ClickHouse tables — the modern replacement for ZooKeeper), managed by the
 * same Altinity clickhouse-operator install as CHI resources.
 */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { createResource } from '../../shared.js';
import type {
  ClickHouseKeeperInstallationConfig,
  ClickHouseKeeperInstallationSpec,
  ClickHouseKeeperInstallationStatus,
} from '../types.js';
import {
  assertClickHouseClusterName,
  assertPositiveIntegerCount,
  CLICKHOUSE_CLUSTER_NAME_MAX_BYTES,
  CLICKHOUSE_CLUSTER_NAME_PATTERN,
} from '../utils/validation.js';
import { chiReadinessEvaluator } from './installation.js';

/** Name of the generated keeper data volume claim template. */
const KEEPER_DATA_VOLUME_TEMPLATE = 'data-volume';

/**
 * The RECOMMENDED explicit keeper cluster name — not an implicit default.
 *
 * WHAT THE CAP IS. The Altinity CRD constrains
 * `spec.configuration.clusters[].name` on the CHK exactly as on the CHI:
 * `minLength: 1`, `maxLength: 15`, `pattern: ^[a-zA-Z0-9-]{0,15}$`, annotated
 * `See namePartClusterMaxLen const`. `metadata.name` is uncapped, so a keeper
 * whose installation name was longer than 15 bytes used to fail admission on
 * its FIRST apply with `spec.configuration.clusters[0].name: Too long: may not
 * be more than 15 bytes`. The same 15-byte cap (with `minLength: 1`) applies to
 * the shard, replica and `templates.hostTemplates[].spec.name` host names;
 * TypeKro emits none of those today. Pod, volume-claim and service template
 * names are NOT capped.
 *
 * WHY IT IS NOT THE DEFAULT. The cluster name is a fragment of every object
 * name the operator generates (`chk-<installation>-<cluster>-<shard>-<replica>`),
 * so switching an existing deployment's cluster name REPLACES its StatefulSet
 * with fresh volumes — losing the coordination state every `Replicated*` table
 * in the ClickHouse cluster depends on. Silently swapping the default would do
 * that to every deployment whose installation name already fitted the cap, and
 * those deployments were never broken. So the default still DERIVES from the
 * installation name, and a name that cannot fit is a loud BUILD error pointing
 * at this constant rather than a silent rename or a silent truncation.
 *
 * Anything that needs the value — a `keeper_path` prefix, an
 * operator-generated Service name — must read it from the rendered
 * `spec.configuration.clusters[0].name` (or from the `clusterName` it passed
 * in), never by assuming a particular derivation.
 */
export const DEFAULT_CHK_CLUSTER_NAME = 'keeper';

/**
 * Resolve the CHK's logical cluster name.
 *
 * BACKWARD COMPATIBLE BY CONSTRUCTION. With no `clusterName`, the value is the
 * installation name — unchanged behaviour for every deployment that already
 * worked, because every deployment that already worked had a name within the
 * cap. When the installation name cannot be a legal cluster name, the factory
 * fails at BUILD time naming the field, the length, the cap and the remedy,
 * instead of letting the operator reject the object on apply.
 *
 * A non-string `name` is a schema reference: it is passed through exactly as
 * before and validated by the CRD (and by the generated KRO schema) instead.
 */
function resolveKeeperClusterName(config: Composable<ClickHouseKeeperInstallationConfig>): string {
  if (config.clusterName !== undefined) {
    // Explicit override: the same check the CHI applies to its own
    // `clusterName`, so both resources fail identically.
    assertClickHouseClusterName('clickHouseKeeperInstallation', 'clusterName', config.clusterName);
    return config.clusterName as string;
  }

  const derived = config.name;
  if (typeof derived !== 'string' || CLICKHOUSE_CLUSTER_NAME_PATTERN.test(derived)) {
    return derived as string;
  }

  const byteLength = Buffer.byteLength(derived, 'utf8');
  const reason =
    byteLength > CLICKHOUSE_CLUSTER_NAME_MAX_BYTES
      ? `it is ${byteLength} bytes and the cap is ${CLICKHOUSE_CLUSTER_NAME_MAX_BYTES}`
      : `it does not match ${CLICKHOUSE_CLUSTER_NAME_PATTERN.source}`;

  throw new Error(
    `clickHouseKeeperInstallation: 'clusterName' defaults to the installation name ` +
      `(${JSON.stringify(derived)}), which cannot be a cluster name — ${reason}. The Altinity ` +
      `CRD constrains \`spec.configuration.clusters[].name\` to minLength 1 / maxLength 15 / ` +
      `\`^[a-zA-Z0-9-]{0,15}\$\` (\`See namePartClusterMaxLen const\`) while \`metadata.name\` ` +
      `is uncapped, so the operator would reject this object on its first apply with ` +
      `"spec.configuration.clusters[0].name: Too long: may not be more than 15 bytes". ` +
      `Set an explicit clusterName — e.g. clusterName: '${DEFAULT_CHK_CLUSTER_NAME}'. It is a ` +
      `fragment of the generated object names ` +
      `(\`chk-<installation>-<cluster>-<shard>-<replica>\`), already disambiguated by the ` +
      `installation name, so any short stable value works — but CHANGING it on an existing ` +
      `deployment replaces the StatefulSet with fresh volumes and loses keeper coordination ` +
      `state, so pick it once.`
  );
}

/**
 * CHK Readiness Evaluator
 *
 * CHK reports the same `status.status` reconcile state machine as CHI
 * ('InProgress' | 'Completed' | 'Aborted' | 'Terminating' — shared operator
 * status code), so the CHI evaluator applies verbatim.
 */
export function chkReadinessEvaluator(liveResource: unknown): ResourceStatus {
  return chiReadinessEvaluator(liveResource);
}

registerPortableReadinessEvaluator(
  'typekro.readiness.clickhouse.keeper-installation',
  '1',
  chkReadinessEvaluator
);

/** Compile the high-level config into a CHK spec. */
function compileKeeperSpec(
  config: Composable<ClickHouseKeeperInstallationConfig>
): ClickHouseKeeperInstallationSpec {
  // LOUD build-time validation: the compiler BRANCHES on these (storage
  // presence selects the volume-claim template block; replicas defaults via
  // `?? 1`), so schema refs here would silently mis-compile. Storage SIZE and
  // class are plain values and may be refs.
  for (const field of ['storage', 'replicas'] as const) {
    if (isKubernetesRef(config[field]) || isCelExpression(config[field])) {
      throw new Error(
        `clickHouseKeeperInstallation: '${field}' is a BUILD-TIME field and received a ` +
          `schema reference or CEL expression — pass a concrete value (the compiler ` +
          `branches on it at graph-construction time).`
      );
    }
  }

  const replicas = config.replicas ?? 1;
  // A CHK layout with `replicasCount: 0` (or a fractional/negative count) is
  // invalid operator input — same shared validation as the CHI paths.
  assertPositiveIntegerCount('clickHouseKeeperInstallation', 'replicas', replicas);

  // Derived from the installation name (unchanged behaviour) unless that name
  // cannot be a legal cluster name, in which case this throws at BUILD time
  // rather than letting the operator reject the object. See
  // `resolveKeeperClusterName`.
  const clusterName = resolveKeeperClusterName(config);

  return {
    configuration: {
      clusters: [
        {
          name: clusterName,
          layout: { replicasCount: replicas },
        },
      ],
    },
    ...(config.storage && {
      defaults: {
        templates: {
          dataVolumeClaimTemplate: KEEPER_DATA_VOLUME_TEMPLATE,
        },
      },
      templates: {
        volumeClaimTemplates: [
          {
            name: KEEPER_DATA_VOLUME_TEMPLATE,
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: { requests: { storage: config.storage.size } },
              // On EKS: use a WaitForFirstConsumer + expandable gp3 class.
              ...(config.storage.storageClassName && {
                storageClassName: config.storage.storageClassName,
              }),
            },
          },
        ],
      },
    }),
  };
}

/**
 * ClickHouseKeeperInstallation Factory
 *
 * The internal cluster name defaults to the installation name and is capped at
 * 15 bytes by the CRD while `name` is not, so an installation name that cannot
 * be a cluster name is a BUILD error asking for an explicit `clusterName` (see
 * {@link DEFAULT_CHK_CLUSTER_NAME}) rather than a silent rename.
 *
 * @param config - High-level keeper configuration
 * @returns Enhanced ClickHouseKeeperInstallation resource with readiness
 *   evaluation
 * @throws Error when no `clusterName` is given and the installation name is
 *   longer than 15 bytes or otherwise illegal as a cluster name
 *
 * @example
 * ```typescript
 * const keeper = clickHouseKeeperInstallation({
 *   name: 'keeper',
 *   namespace: 'observability',
 *   replicas: 3, // odd count for quorum
 *   storage: { size: '10Gi', storageClassName: 'gp3-expandable' },
 *   id: 'clickhouseKeeper',
 * });
 * ```
 *
 * @example An installation name past the 15-byte cluster-name cap
 * ```typescript
 * const keeper = clickHouseKeeperInstallation({
 *   name: 'observability-keeper',     // 20 bytes — fine as an object name
 *   clusterName: DEFAULT_CHK_CLUSTER_NAME, // required: 'keeper'
 *   replicas: 3,
 * });
 * ```
 */
function createClickHouseKeeperInstallationResource(
  config: Composable<ClickHouseKeeperInstallationConfig>
): Enhanced<ClickHouseKeeperInstallationSpec, ClickHouseKeeperInstallationStatus> {
  const spec = compileKeeperSpec(config);

  return createResource(
    {
      apiVersion: 'clickhouse-keeper.altinity.com/v1',
      kind: 'ClickHouseKeeperInstallation',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced', dnsAddressable: true }
  ).withReadinessEvaluator(chkReadinessEvaluator) as Enhanced<
    ClickHouseKeeperInstallationSpec,
    ClickHouseKeeperInstallationStatus
  >;
}

export const clickHouseKeeperInstallation = createClickHouseKeeperInstallationResource;
