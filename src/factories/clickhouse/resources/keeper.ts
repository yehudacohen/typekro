/**
 * ClickHouseKeeperInstallation (CHK) Factory
 *
 * Minimal typed factory for the `clickhouse-keeper.altinity.com/v1`
 * ClickHouseKeeperInstallation CRD (coordination service for replicated
 * ClickHouse tables — the modern replacement for ZooKeeper), managed by the
 * same Altinity clickhouse-operator install as CHI resources.
 */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { createResource } from '../../shared.js';
import type {
  ClickHouseKeeperInstallationConfig,
  ClickHouseKeeperInstallationSpec,
  ClickHouseKeeperInstallationStatus,
} from '../types.js';
import { chiReadinessEvaluator } from './installation.js';

/** Name of the generated keeper data volume claim template. */
const KEEPER_DATA_VOLUME_TEMPLATE = 'data-volume';

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

  return {
    configuration: {
      clusters: [
        {
          name: config.name,
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
