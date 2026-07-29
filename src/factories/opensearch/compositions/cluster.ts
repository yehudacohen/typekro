import { type } from 'arktype';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { setIncludeWhen } from '../../../core/metadata/resource-metadata.js';
import { Cel } from '../../../core/references/cel.js';
import type { CallableComposition } from '../../../core/types/deployment.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { certificate } from '../../cert-manager/resources/certificates.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import { networkPolicy } from '../../kubernetes/networking/network-policy.js';
import { DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE } from '../constants.js';
import { OPENSEARCH_HTTP_PORT, openSearchClusterResource } from '../resources/cluster.js';
import type {
  OpenSearchClusterConfig,
  OpenSearchClusterStatus,
  OpenSearchClusterTopology,
} from '../types.js';
import { OpenSearchClusterStatusSchema } from '../types.js';

const DEFAULT_OPENSEARCH_VERSION = '3.2.0';

interface ResolvedTopology {
  readonly profile: 'development' | 'production';
  readonly nodes: number;
  readonly roles: readonly ('cluster_manager' | 'data' | 'ingest')[];
  readonly tls: 'generated' | 'secret' | 'cert-manager';
  readonly snapshots: boolean;
  readonly snapshotCredentialKeys: {
    readonly accessKey: string;
    readonly secretKey: string;
  };
  readonly podDisruptionBudget?: {
    readonly minAvailable?: number;
    readonly maxUnavailable?: number;
  };
  readonly networkPolicy?: {
    readonly operatorNamespace: string;
    readonly ingressNamespaceLabels: Readonly<Record<string, string>>;
    readonly egressNamespaceLabels: readonly Readonly<Record<string, string>>[];
    readonly egressCidrs: readonly string[];
  };
}

export interface OpenSearchClusterBuildOptions extends OpenSearchClusterTopology {
  readonly tls?: 'generated' | 'secret' | 'cert-manager';
  readonly snapshots?: boolean;
  /**
   * OpenSearch operator keystore mappings use Secret keys as YAML map keys,
   * so these are build-time path fragments rather than runtime values.
   */
  readonly snapshotCredentialKeys?: {
    readonly accessKey?: string;
    readonly secretKey?: string;
  };
}

type OpenSearchClusterTlsConfig = NonNullable<OpenSearchClusterConfig['tls']>;

export type OpenSearchClusterConfigFor<Options extends OpenSearchClusterBuildOptions> = Omit<
  OpenSearchClusterConfig,
  'tls' | 'snapshots'
> & {
  readonly tls: Extract<
    OpenSearchClusterTlsConfig,
    {
      readonly source: Options['tls'] extends undefined ? 'generated' : NonNullable<Options['tls']>;
    }
  >;
} & (Options['snapshots'] extends true
    ? {
        readonly snapshots: NonNullable<OpenSearchClusterConfig['snapshots']>;
      }
    : { readonly snapshots?: never });

type OpenSearchClusterRuntimeSpec = Omit<
  OpenSearchClusterConfig,
  'name' | 'namespace' | 'storage' | 'tls'
> & {
  readonly name: string;
  readonly namespace: string;
  readonly storage: {
    readonly size: string;
    readonly storageClassName?: string;
  };
  readonly tls: NonNullable<OpenSearchClusterConfig['tls']>;
};

function resolveTopology(options: OpenSearchClusterBuildOptions): ResolvedTopology {
  const profile = options.profile ?? 'development';
  const nodes = options.nodes ?? 3;
  const roles = options.roles ?? ['cluster_manager', 'data', 'ingest'];
  if (!Number.isSafeInteger(nodes) || nodes < 3) {
    throw new Error(
      'makeOpenSearchCluster requires at least three nodes because the OpenSearch operator does not support single-node clusters.'
    );
  }
  if (!roles.includes('cluster_manager')) {
    throw new Error(
      'makeOpenSearchCluster roles must include cluster_manager because its single node pool must be able to elect a cluster manager.'
    );
  }
  const pdb =
    options.podDisruptionBudget ??
    (profile === 'production' ? { minAvailable: Math.max(1, nodes - 1) } : undefined);
  if (pdb?.minAvailable !== undefined && pdb.maxUnavailable !== undefined) {
    throw new Error(
      'makeOpenSearchCluster podDisruptionBudget accepts minAvailable or maxUnavailable, not both.'
    );
  }
  if (
    (pdb?.minAvailable !== undefined &&
      (!Number.isSafeInteger(pdb.minAvailable) ||
        pdb.minAvailable < 1 ||
        pdb.minAvailable >= nodes)) ||
    (pdb?.maxUnavailable !== undefined &&
      (!Number.isSafeInteger(pdb.maxUnavailable) ||
        pdb.maxUnavailable < 0 ||
        pdb.maxUnavailable >= nodes))
  ) {
    throw new Error(
      'makeOpenSearchCluster PodDisruptionBudget must preserve at least one available node.'
    );
  }
  const networkPolicy =
    options.networkPolicy?.enabled === true
      ? {
          operatorNamespace:
            options.networkPolicy.operatorNamespace ?? DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE,
          ingressNamespaceLabels: options.networkPolicy.ingressNamespaceLabels ?? {},
          egressNamespaceLabels: options.networkPolicy.egressNamespaceLabels ?? [],
          egressCidrs: options.networkPolicy.egressCidrs ?? [],
        }
      : profile === 'production'
        ? {
            operatorNamespace:
              options.networkPolicy?.operatorNamespace ?? DEFAULT_OPENSEARCH_OPERATOR_NAMESPACE,
            ingressNamespaceLabels: options.networkPolicy?.ingressNamespaceLabels ?? {},
            egressNamespaceLabels: options.networkPolicy?.egressNamespaceLabels ?? [],
            egressCidrs: options.networkPolicy?.egressCidrs ?? [],
          }
        : undefined;
  if (networkPolicy && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(networkPolicy.operatorNamespace)) {
    throw new Error(
      'makeOpenSearchCluster networkPolicy.operatorNamespace must be a non-empty Kubernetes Namespace name.'
    );
  }
  if (
    profile === 'production' &&
    networkPolicy &&
    Object.keys(networkPolicy.ingressNamespaceLabels).length === 0
  ) {
    throw new Error(
      'makeOpenSearchCluster production network policy requires ingressNamespaceLabels.'
    );
  }
  return {
    profile,
    nodes,
    roles,
    tls: options.tls ?? 'generated',
    snapshots: options.snapshots ?? false,
    snapshotCredentialKeys: {
      accessKey: options.snapshotCredentialKeys?.accessKey ?? 'accessKey',
      secretKey: options.snapshotCredentialKeys?.secretKey ?? 'secretKey',
    },
    ...(pdb ? { podDisruptionBudget: pdb } : {}),
    ...(networkPolicy ? { networkPolicy } : {}),
  };
}

function buildSpecSchema(topology: ResolvedTopology) {
  const shape: Record<string, unknown> = {
    name: 'string > 0',
    namespace: 'string > 0',
    'version?': 'string > 0',
    'serviceName?': 'string > 0',
    'lifecycle?': '"owned-delete" | "external-delete" | "external-retain"',
    storage: {
      size: 'string > 0',
      'storageClassName?': 'string > 0',
    },
    'resources?': {
      'requests?': { 'cpu?': 'string', 'memory?': 'string' },
      'limits?': { 'cpu?': 'string', 'memory?': 'string' },
    },
    'adminCredentialsSecret?': { name: 'string > 0' },
    'dashboardCredentialsSecret?': { name: 'string > 0' },
    'monitoring?': 'boolean',
  };
  if (topology.tls === 'generated') {
    shape.tls = { source: '"generated"' };
  } else if (topology.tls === 'secret') {
    shape.tls = {
      source: '"secret"',
      secretName: 'string > 0',
      adminSecretName: 'string > 0',
      adminDn: '(string > 0)[] > 0',
    };
  } else {
    shape.tls = {
      source: '"cert-manager"',
      secretName: 'string > 0',
      adminSecretName: 'string > 0',
      issuerName: 'string > 0',
      'issuerKind?': '"Issuer" | "ClusterIssuer"',
      dnsNames: 'string[] > 0',
      adminDn: '(string > 0)[] > 0',
    };
  }
  if (topology.snapshots) {
    shape.snapshots = {
      repository: 'string > 0',
      bucket: 'string > 0',
      credentialsSecret: {
        name: 'string > 0',
      },
      'endpoint?': 'string',
      'region?': 'string',
      'basePath?': 'string',
    };
  }
  return type(shape as never);
}

export function makeOpenSearchCluster<
  const Options extends OpenSearchClusterBuildOptions = Record<never, never>,
>(
  options: Options = {} as Options
): CallableComposition<OpenSearchClusterConfigFor<Options>, OpenSearchClusterStatus> {
  const topology = resolveTopology(options);
  const specSchema = buildSpecSchema(topology);
  return kubernetesComposition(
    {
      name: 'opensearch-cluster',
      kind: 'OpenSearchClusterInstallation',
      spec: specSchema as never,
      status: OpenSearchClusterStatusSchema,
    },
    (spec: OpenSearchClusterRuntimeSpec) => {
      const lifecycle = spec.lifecycle ?? 'owned-delete';
      const clusterNamespace = namespace({
        metadata: {
          name: spec.namespace,
          labels: {
            'app.kubernetes.io/name': 'opensearch',
            'app.kubernetes.io/instance': spec.name,
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
        id: 'clusterNamespace',
      });
      if (isKubernetesRef(spec.name)) {
        setIncludeWhen(clusterNamespace, [
          Cel.expr<boolean>(
            '!has(schema.spec.lifecycle) || schema.spec.lifecycle == "owned-delete"'
          ),
        ]);
      } else if (lifecycle !== 'owned-delete') {
        setIncludeWhen(clusterNamespace, [false]);
      }
      let serverCertificate: ReturnType<typeof certificate> | undefined;
      if (topology.tls === 'cert-manager') {
        const tls = spec.tls as Extract<
          NonNullable<OpenSearchClusterConfig['tls']>,
          { source: 'cert-manager' }
        >;
        serverCertificate = certificate({
          name: `${spec.name}-http`,
          namespace: spec.namespace,
          spec: {
            secretName: tls.secretName,
            issuerRef: {
              name: tls.issuerName,
              kind: tls.issuerKind ?? 'ClusterIssuer',
            },
            dnsNames: tls.dnsNames,
            usages: ['server auth'],
          },
          id: 'httpCertificate',
        });
      }
      const cluster = openSearchClusterResource({
        name: spec.name,
        namespace: spec.namespace,
        version: spec.version ?? DEFAULT_OPENSEARCH_VERSION,
        serviceName: spec.serviceName ?? spec.name,
        nodes: topology.nodes,
        roles: topology.roles,
        storage: {
          size: spec.storage.size,
          ...(spec.storage.storageClassName
            ? { storageClassName: spec.storage.storageClassName }
            : {}),
          deletionPolicy: lifecycle === 'external-retain' ? 'retain' : 'delete',
        },
        ...(spec.resources ? { resources: spec.resources } : {}),
        ...(spec.adminCredentialsSecret
          ? { adminCredentialsSecret: spec.adminCredentialsSecret }
          : {}),
        ...(spec.dashboardCredentialsSecret
          ? {
              dashboardCredentialsSecret: spec.dashboardCredentialsSecret,
            }
          : {}),
        tls:
          topology.tls === 'generated'
            ? { source: 'generated' }
            : externalTls(spec.tls, topology.tls),
        ...(topology.snapshots && spec.snapshots
          ? {
              snapshots: {
                repository: spec.snapshots.repository,
                bucket: spec.snapshots.bucket,
                credentialsSecret: {
                  name: spec.snapshots.credentialsSecret.name,
                  accessKeyKey: topology.snapshotCredentialKeys.accessKey,
                  secretKeyKey: topology.snapshotCredentialKeys.secretKey,
                },
                ...(spec.snapshots.endpoint ? { endpoint: spec.snapshots.endpoint } : {}),
                ...(spec.snapshots.region ? { region: spec.snapshots.region } : {}),
                ...(spec.snapshots.basePath ? { basePath: spec.snapshots.basePath } : {}),
              },
            }
          : {}),
        monitoring: spec.monitoring ?? false,
        ...(topology.podDisruptionBudget
          ? { podDisruptionBudget: topology.podDisruptionBudget }
          : {}),
        id: 'cluster',
      });
      if (serverCertificate) cluster.dependsOn(serverCertificate);

      if (topology.networkPolicy) {
        const podSelector = {
          matchLabels: {
            'opensearch.org/opensearch-cluster': spec.name,
          },
        };
        networkPolicy({
          metadata: {
            name: `${spec.name}-default`,
            namespace: spec.namespace,
          },
          spec: {
            podSelector,
            policyTypes: ['Ingress', 'Egress'],
            ingress: [
              {
                _from: [{ podSelector: {} }],
              },
              {
                _from: [
                  {
                    namespaceSelector: {
                      matchLabels: {
                        'kubernetes.io/metadata.name': topology.networkPolicy.operatorNamespace,
                      },
                    },
                  },
                ],
                ports: [{ protocol: 'TCP', port: OPENSEARCH_HTTP_PORT }],
              },
              ...(Object.keys(topology.networkPolicy.ingressNamespaceLabels).length > 0
                ? [
                    {
                      _from: [
                        {
                          namespaceSelector: {
                            matchLabels: topology.networkPolicy.ingressNamespaceLabels,
                          },
                        },
                      ],
                      ports: [
                        {
                          protocol: 'TCP' as const,
                          port: OPENSEARCH_HTTP_PORT,
                        },
                      ],
                    },
                  ]
                : []),
            ],
            egress: [
              { to: [{ podSelector: {} }] },
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: {
                        'kubernetes.io/metadata.name': 'kube-system',
                      },
                    },
                  },
                ],
                ports: [
                  { protocol: 'UDP', port: 53 },
                  { protocol: 'TCP', port: 53 },
                ],
              },
              ...topology.networkPolicy.egressNamespaceLabels.map((matchLabels) => ({
                to: [{ namespaceSelector: { matchLabels } }],
              })),
              ...topology.networkPolicy.egressCidrs.map((cidr) => ({
                to: [{ ipBlock: { cidr } }],
              })),
            ],
          },
          id: 'networkPolicy',
        });
      }

      const failed = Cel.expr<boolean>(
        'cluster.status.componentsStatus.exists(c, c.status == "Failed" || c.status == "Error")'
      );
      const ready = Cel.expr<boolean>(
        `cluster.status.initialized == true && cluster.status.availableNodes >= ${topology.nodes} && (cluster.status.health == "green" || cluster.status.health == "yellow") && cluster.status.version == cluster.spec.general.version`
      );
      return {
        ready,
        failed,
        phase: Cel.expr<'Ready' | 'Installing' | 'Failed'>(
          `cluster.status.componentsStatus.exists(c, c.status == "Failed" || c.status == "Error") ? "Failed" : (cluster.status.initialized == true && cluster.status.availableNodes >= ${topology.nodes} && (cluster.status.health == "green" || cluster.status.health == "yellow") && cluster.status.version == cluster.spec.general.version ? "Ready" : "Installing")`
        ),
        endpoint: `https://${cluster.spec.general.serviceName}.${cluster.metadata.namespace}.svc.cluster.local:${OPENSEARCH_HTTP_PORT}`,
        credentialsSecret: Cel.expr<string>(
          `has(cluster.spec.security.config.adminCredentialsSecret) && cluster.spec.security.config.adminCredentialsSecret.name != "" ? cluster.spec.security.config.adminCredentialsSecret.name : string(cluster.metadata.name) + "-admin-password"`
        ),
        version: cluster.status.version,
        availableNodes: cluster.status.availableNodes,
        health: cluster.status.health,
        snapshotRepository: Cel.expr<string>(
          'has(cluster.spec.general.snapshotRepositories) && cluster.spec.general.snapshotRepositories.size() > 0 ? cluster.spec.general.snapshotRepositories[0].name : ""'
        ),
      };
    },
    topology.tls === 'generated'
      ? undefined
      : {
          schemaFieldValidations: {
            'tls.adminDn': 'size(self) > 0 && self.all(dn, size(dn) > 0)',
          },
        }
  ) as unknown as CallableComposition<OpenSearchClusterConfigFor<Options>, OpenSearchClusterStatus>;
}

export const openSearchCluster = makeOpenSearchCluster();

function externalTls(
  tls: NonNullable<OpenSearchClusterConfig['tls']>,
  source: 'secret' | 'cert-manager'
): {
  readonly source: 'secret' | 'cert-manager';
  readonly secretName: string;
  readonly adminSecretName: string;
  readonly adminDn: readonly string[];
} {
  if (tls.source === 'generated') {
    throw new Error(
      `makeOpenSearchCluster configured TLS source ${source}, but the instance supplied generated TLS.`
    );
  }
  return {
    source,
    secretName: tls.secretName,
    adminSecretName: tls.adminSecretName,
    adminDn: tls.adminDn,
  };
}
