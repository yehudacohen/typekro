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
import { assertClickHouseClusterName, assertPositiveIntegerCount } from '../utils/validation.js';
import { chiReadinessEvaluator } from './installation.js';

/** Name of the generated keeper data volume claim template. */
const KEEPER_DATA_VOLUME_TEMPLATE = 'data-volume';

/**
 * Default logical keeper cluster name.
 *
 * DELIBERATELY INDEPENDENT OF THE INSTALLATION NAME. The Altinity CRD caps
 * `spec.configuration.clusters[].name` at 15 bytes on the CHK exactly as it
 * does on the CHI (`maxLength: 15`, `pattern: ^[a-zA-Z0-9-]{0,15}$`, annotated
 * `See namePartClusterMaxLen const`), while `metadata.name` is uncapped — so
 * echoing the installation name into the cluster name made every keeper whose
 * release name was longer than 15 bytes fail admission on its FIRST apply with
 * `spec.configuration.clusters[0].name: Too long: may not be more than 15
 * bytes`.
 *
 * The internal cluster name is a NAME FRAGMENT, not an identity: the operator
 * builds `chk-<installation>-<cluster>-<shard>-<replica>` from it, so it is
 * already disambiguated by the installation name in front of it and only has
 * to be short and stable. A constant is therefore the right default, mirroring
 * `DEFAULT_CHI_CLUSTER_NAME` (`cluster`) on the CHI side. Pass `clusterName`
 * to override it.
 *
 * Anything that needs the value — a `keeper_path` prefix, an
 * operator-generated Service name — must read it from this constant or from
 * the rendered `spec.configuration.clusters[0].name`, never by assuming it
 * equals the installation name.
 */
export const DEFAULT_CHK_CLUSTER_NAME = 'keeper';

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

  // NOT `config.name`: the installation name is uncapped, the CLUSTER name is
  // capped at 15 bytes by the CRD (see DEFAULT_CHK_CLUSTER_NAME). Validated
  // with the SAME assertion the CHI uses, so CHI and CHK fail identically —
  // at build time, with the cap named — instead of at apply time.
  const clusterName = config.clusterName ?? DEFAULT_CHK_CLUSTER_NAME;
  assertClickHouseClusterName('clickHouseKeeperInstallation', 'clusterName', clusterName);

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
 * The internal cluster name defaults to {@link DEFAULT_CHK_CLUSTER_NAME} and
 * is independent of `name` — the CRD caps it at 15 bytes while `name` is
 * uncapped.
 *
 * @param config - High-level keeper configuration
 * @returns Enhanced ClickHouseKeeperInstallation resource with readiness
 *   evaluation
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
