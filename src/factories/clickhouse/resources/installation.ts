/**
 * ClickHouseInstallation (CHI) Factory
 *
 * Compiles a high-level typed config into a `clickhouse.altinity.com/v1`
 * ClickHouseInstallation managed by the Altinity clickhouse-operator.
 *
 * THE POINT of this typed factory is the zone-pinned layout: the operator's
 * `podDistribution` supports only the `kubernetes.io/hostname` topologyKey
 * (Altinity/clickhouse-operator#772), so per-zone spreading must be compiled
 * as a per-replica `layout.replicas:` list with zone-pinned pod templates.
 * On EKS, EBS volumes are zonal — a replica rescheduled into another AZ
 * strands its PVC (production incident) — so `zones` should be set for any
 * multi-replica production CHI.
 *
 * CHI shape follows the official examples
 * (docs/chi-examples/01-simple-layout-01-1shard-1repl.yaml and
 * 14-zones-distribution-01.yaml in the operator repo).
 */

import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type {
  ChiPodTemplate,
  ClickHouseInstallationConfig,
  ClickHouseInstallationSpec,
  ClickHouseInstallationStatus,
} from '../types.js';
import { compileZonePinnedLayout } from '../utils/zone-layout.js';

/**
 * Known CHI/CHK reconcile status strings.
 *
 * Source: clickhouse-operator `pkg/apis/clickhouse.altinity.com/v1/type_status.go`
 * (StatusInProgress/StatusCompleted/StatusAborted/StatusTerminating). The
 * operator writes them to `status.status`; `Completed` means the installation
 * is fully reconciled.
 */
export const CHI_STATUS = {
  IN_PROGRESS: 'InProgress',
  COMPLETED: 'Completed',
  ABORTED: 'Aborted',
  TERMINATING: 'Terminating',
} as const;

/**
 * CHI/CHK Readiness Evaluator
 *
 * Keys off the operator-reported `status.status` reconcile state (see
 * CHI_STATUS). Unlike condition-based CRDs, the clickhouse-operator reports a
 * single status string plus host progress counters.
 */
export function chiReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const resource = liveResource as
    | { status?: ClickHouseInstallationStatus }
    | null
    | undefined;
  const status = resource?.status;

  if (!status || status.status === undefined) {
    return {
      ready: false,
      message: 'Installation has no status yet',
      reason: 'StatusMissing',
    };
  }

  if (status.status === CHI_STATUS.COMPLETED) {
    return {
      ready: true,
      message: `Installation reconciled (${status.hostsCompletedCount ?? status.hostsCount ?? 0}/${status.hostsCount ?? 0} hosts)`,
      reason: 'Completed',
    };
  }

  if (status.status === CHI_STATUS.IN_PROGRESS) {
    return {
      ready: false,
      message: `Reconcile in progress (${status.hostsCompletedCount ?? 0}/${status.hostsCount ?? 0} hosts)`,
      reason: 'InProgress',
    };
  }

  if (status.status === CHI_STATUS.ABORTED) {
    return {
      ready: false,
      message: `Reconcile aborted${status.errors?.length ? `: ${status.errors[0]}` : ''}`,
      reason: 'Aborted',
    };
  }

  if (status.status === CHI_STATUS.TERMINATING) {
    return {
      ready: false,
      message: 'Installation is terminating',
      reason: 'Terminating',
    };
  }

  return {
    ready: false,
    message: `Unknown installation status: ${status.status}`,
    reason: 'UnknownStatus',
  };
}

/** Default ClickHouse server image repository. */
const DEFAULT_CLICKHOUSE_IMAGE_REPOSITORY = 'clickhouse/clickhouse-server';

/**
 * Default logical cluster name.
 *
 * SIGNOZ COMPATIBILITY: SigNoz's ClickHouse migrations hardcode the cluster
 * name `cluster`, so a CHI consumed by SigNoz MUST keep this default.
 */
export const DEFAULT_CHI_CLUSTER_NAME = 'cluster';

/** Name of the generated data volume claim template. */
const DATA_VOLUME_TEMPLATE = 'data-volume';

/** Base name for generated pod templates. */
const POD_TEMPLATE_BASE = 'clickhouse';

/** Flatten the typed users map to the operator's path-keyed format. */
function compileUsers(
  users: NonNullable<Composable<ClickHouseInstallationConfig>['users']>
): Record<string, unknown> {
  const compiled: Record<string, unknown> = {};
  for (const [userName, user] of Object.entries(users)) {
    if (user.passwordSha256Hex !== undefined) {
      compiled[`${userName}/password_sha256_hex`] = user.passwordSha256Hex;
    }
    if (user.networksIp !== undefined) {
      compiled[`${userName}/networks/ip`] = user.networksIp;
    }
  }
  return compiled;
}

/** Compile the high-level config into a full CHI spec. */
function compileInstallationSpec(
  config: Composable<ClickHouseInstallationConfig>
): ClickHouseInstallationSpec {
  const shards = config.shards ?? 1;
  const replicas = config.replicas ?? 1;
  const clusterName = config.clusterName ?? DEFAULT_CHI_CLUSTER_NAME;
  const image =
    config.image ?? `${DEFAULT_CLICKHOUSE_IMAGE_REPOSITORY}:${config.version}`;
  const zones = config.zones ?? [];

  // Shared ClickHouse server pod spec (per-zone templates add affinity).
  const podSpec: Record<string, unknown> = {
    containers: [
      {
        name: 'clickhouse',
        image,
        ...(config.podResources && { resources: config.podResources }),
      },
    ],
  };

  // Storage claim: only storageClassName is set from input. On EKS the class
  // should be a WaitForFirstConsumer + allowVolumeExpansion gp3 StorageClass
  // so the PVC binds in the zone the scheduler picks (and can expand later);
  // WaitForFirstConsumer is a StorageClass property, not a PVC field.
  const volumeClaimTemplates = [
    {
      name: DATA_VOLUME_TEMPLATE,
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: config.storage.size } },
        ...(config.storage.storageClassName && {
          storageClassName: config.storage.storageClassName,
        }),
      },
    },
  ];

  let layout: ClickHouseInstallationSpec['configuration'];
  let podTemplates: ChiPodTemplate[];
  let defaultPodTemplate: string | undefined;

  if (zones.length > 0) {
    // Zone-pinned per-replica layout: NO replicasCount — the explicit
    // replicas list defines the replica count, and each replica references
    // its zone's nodeAffinity-pinned pod template (round-robin across zones
    // when replicas > zones.length). See utils/zone-layout.ts.
    const zonePinned = compileZonePinnedLayout({
      replicaCount: replicas,
      zones,
      podTemplateBaseName: POD_TEMPLATE_BASE,
      podSpec,
    });
    podTemplates = zonePinned.podTemplates;
    layout = {
      clusters: [
        {
          name: clusterName,
          layout: {
            shardsCount: shards,
            replicas: zonePinned.replicas,
          },
        },
      ],
    };
  } else {
    // Plain homogeneous layout: shardsCount x replicasCount with one shared
    // pod template applied via defaults.
    podTemplates = [{ name: POD_TEMPLATE_BASE, spec: podSpec }];
    defaultPodTemplate = POD_TEMPLATE_BASE;
    layout = {
      clusters: [
        {
          name: clusterName,
          layout: {
            shardsCount: shards,
            replicasCount: replicas,
          },
        },
      ],
    };
  }

  return {
    defaults: {
      templates: {
        ...(defaultPodTemplate && { podTemplate: defaultPodTemplate }),
        dataVolumeClaimTemplate: DATA_VOLUME_TEMPLATE,
      },
    },
    configuration: {
      ...layout,
      // The operator's `zookeeper` section serves clickhouse-keeper too.
      ...(config.keeper && {
        zookeeper: {
          nodes: [
            { host: config.keeper.host, port: config.keeper.port ?? 2181 },
          ],
        },
      }),
      ...(config.users && { users: compileUsers(config.users) }),
    },
    templates: {
      podTemplates,
      volumeClaimTemplates,
    },
  };
}

/**
 * ClickHouseInstallation Factory
 *
 * Creates a ClickHouse cluster managed by the Altinity clickhouse-operator.
 *
 * @param config - High-level installation configuration
 * @returns Enhanced ClickHouseInstallation resource with readiness evaluation
 *
 * @example
 * ```typescript
 * const chi = clickHouseInstallation({
 *   name: 'signoz-clickhouse',
 *   namespace: 'observability',
 *   version: '25.12.5',                     // SigNoz-coupled server version
 *   shards: 1,
 *   replicas: 2,
 *   zones: ['us-east-2a', 'us-east-2b'],    // zone-pinned replicas (EBS is zonal)
 *   storage: { size: '100Gi', storageClassName: 'gp3-expandable' },
 *   keeper: { host: 'keeper-signoz.observability.svc.cluster.local' },
 *   id: 'signozClickhouse',
 * });
 * ```
 */
function createClickHouseInstallationResource(
  config: Composable<ClickHouseInstallationConfig>
): Enhanced<ClickHouseInstallationSpec, ClickHouseInstallationStatus> {
  const spec = compileInstallationSpec(config);

  return createResource(
    {
      apiVersion: 'clickhouse.altinity.com/v1',
      kind: 'ClickHouseInstallation',
      metadata: {
        name: config.name,
        ...(config.namespace && { namespace: config.namespace }),
      },
      spec,
      ...(config.id && { id: config.id }),
    },
    { scope: 'namespaced', dnsAddressable: true }
  ).withReadinessEvaluator(chiReadinessEvaluator) as Enhanced<
    ClickHouseInstallationSpec,
    ClickHouseInstallationStatus
  >;
}

export const clickHouseInstallation = createClickHouseInstallationResource;
