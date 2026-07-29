import { registerPortableReadinessEvaluator } from '../../../core/readiness/index.js';
import type { Composable, Enhanced, ResourceStatus } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import type {
  OpenSearchClusterObservedStatus,
  OpenSearchClusterResourceConfig,
  OpenSearchClusterResourceSpec,
} from '../types.js';

export const OPENSEARCH_HTTP_PORT = 9200;

export function openSearchClusterReadinessEvaluator(liveResource: unknown): ResourceStatus {
  const observed = liveResource as
    | {
        readonly spec?: OpenSearchClusterResourceSpec;
        readonly status?: OpenSearchClusterObservedStatus;
      }
    | undefined;
  const status = observed?.status;
  if (!status) {
    return {
      ready: false,
      reason: 'StatusMissing',
      message: 'OpenSearchCluster has no observed status yet',
    };
  }
  const failedComponent = status.componentsStatus?.find(({ status: componentStatus }) =>
    ['failed', 'error'].includes(componentStatus?.toLowerCase() ?? '')
  );
  if (failedComponent) {
    return {
      ready: false,
      reason: 'ComponentFailed',
      message:
        failedComponent.description ??
        `OpenSearch component ${failedComponent.component ?? '<unknown>'} failed`,
    };
  }
  const expectedNodes =
    observed?.spec?.nodePools.reduce((total, pool) => total + pool.replicas, 0) ?? 1;
  const expectedVersion = observed?.spec?.general.version;
  const observedVersion = status.version;
  const ready =
    status.initialized === true &&
    (status.availableNodes ?? 0) >= expectedNodes &&
    ['green', 'yellow'].includes(status.health?.toLowerCase() ?? '') &&
    typeof expectedVersion === 'string' &&
    observedVersion === expectedVersion;
  return ready
    ? {
        ready: true,
        reason: 'ClusterReady',
        message: `${status.availableNodes ?? 0} nodes available; health=${status.health}; version=${observedVersion}`,
      }
    : {
        ready: false,
        reason:
          expectedVersion && observedVersion && observedVersion !== expectedVersion
            ? 'VersionProgressing'
            : status.phase || 'ClusterProgressing',
        message: `${status.availableNodes ?? 0} nodes available; health=${status.health ?? 'unknown'}; version=${observedVersion ?? 'unknown'}; desiredVersion=${expectedVersion ?? 'unknown'}`,
      };
}

registerPortableReadinessEvaluator(
  'typekro.readiness.opensearch.cluster',
  '1',
  openSearchClusterReadinessEvaluator
);

function compileOpenSearchClusterSpec(
  config: Composable<OpenSearchClusterResourceConfig>
): OpenSearchClusterResourceSpec {
  const snapshot = config.snapshots;
  const tls =
    config.tls.source === 'generated'
      ? {
          http: { generate: true as const },
          transport: { generate: true as const, perNode: true as const },
        }
      : {
          http: {
            generate: false as const,
            secret: { name: config.tls.secretName },
            adminDn: config.tls.adminDn,
          },
          transport: { generate: true as const, perNode: true as const },
        };
  return {
    general: {
      serviceName: config.serviceName,
      version: config.version,
      httpPort: OPENSEARCH_HTTP_PORT,
      vendor: 'opensearch',
      ...(snapshot ? { pluginsList: ['repository-s3'] } : {}),
      drainDataNodes: true,
      monitoring: { enable: config.monitoring },
      ...(snapshot
        ? {
            keystore: [
              {
                secret: {
                  name: snapshot.credentialsSecret.name,
                  keyMappings: {
                    [snapshot.credentialsSecret.accessKeyKey]: 's3.client.default.access_key',
                    [snapshot.credentialsSecret.secretKeyKey]: 's3.client.default.secret_key',
                  },
                },
              },
            ],
            snapshotRepositories: [
              {
                name: snapshot.repository,
                type: 's3' as const,
                settings: {
                  bucket: snapshot.bucket,
                  ...(snapshot.endpoint ? { endpoint: snapshot.endpoint } : {}),
                  ...(snapshot.region ? { region: snapshot.region } : {}),
                  ...(snapshot.basePath ? { base_path: snapshot.basePath } : {}),
                },
              },
            ],
          }
        : {}),
    },
    security: {
      config: {
        ...(config.adminCredentialsSecret
          ? { adminCredentialsSecret: config.adminCredentialsSecret }
          : {}),
        ...(config.tls.source === 'generated'
          ? {}
          : { adminSecret: { name: config.tls.adminSecretName } }),
      },
      tls,
    },
    dashboards: {
      enable: false,
      ...(config.dashboardCredentialsSecret
        ? {
            opensearchCredentialsSecret: config.dashboardCredentialsSecret,
          }
        : {}),
    },
    nodePools: [
      {
        component: 'nodes',
        replicas: config.nodes,
        roles: config.roles,
        diskSize: config.storage.size,
        ...(config.storage.storageClassName
          ? {
              persistence: {
                pvc: {
                  storageClass: config.storage.storageClassName,
                  accessModes: ['ReadWriteOnce'] as const,
                },
              },
            }
          : {}),
        ...(config.resources ? { resources: config.resources } : {}),
        ...(config.podDisruptionBudget
          ? {
              pdb: {
                enable: true as const,
                ...(config.podDisruptionBudget.minAvailable !== undefined
                  ? { minAvailable: config.podDisruptionBudget.minAvailable }
                  : {}),
                ...(config.podDisruptionBudget.maxUnavailable !== undefined
                  ? { maxUnavailable: config.podDisruptionBudget.maxUnavailable }
                  : {}),
              },
            }
          : {}),
      },
    ],
  };
}

export function openSearchClusterResource(
  config: Composable<OpenSearchClusterResourceConfig>
): Enhanced<OpenSearchClusterResourceSpec, OpenSearchClusterObservedStatus> {
  return createResource(
    {
      apiVersion: 'opensearch.org/v1',
      kind: 'OpenSearchCluster',
      metadata: {
        name: config.name,
        namespace: config.namespace,
        labels: {
          'app.kubernetes.io/name': 'opensearch',
          'app.kubernetes.io/instance': config.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
        ...(config.storage.deletionPolicy === 'retain'
          ? {
              annotations: {
                'typekro.dev/storage-retention':
                  'PVC retention applies only while the externally owned namespace survives',
              },
            }
          : {}),
      },
      spec: compileOpenSearchClusterSpec(config),
      ...(config.id ? { id: config.id } : {}),
    },
    { scope: 'namespaced' }
  ).withReadinessEvaluator(openSearchClusterReadinessEvaluator) as Enhanced<
    OpenSearchClusterResourceSpec,
    OpenSearchClusterObservedStatus
  >;
}
