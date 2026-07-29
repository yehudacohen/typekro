import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';
import type { Composable } from '../../core/types/index.js';

export const OpenSearchOperatorBootstrapConfigSchema = type({
  name: 'string > 0',
  'namespace?': 'string > 0',
  'version?': 'string > 0',
  'repositoryName?': 'string > 0',
  'repositoryNamespace?': 'string > 0',
  'customValues?': 'Record<string, unknown>',
});

export type OpenSearchOperatorBootstrapConfig =
  typeof OpenSearchOperatorBootstrapConfigSchema.infer;

export const OpenSearchOperatorReferenceConfigSchema = type({
  name: 'string > 0',
});

export type OpenSearchOperatorReferenceConfig =
  typeof OpenSearchOperatorReferenceConfigSchema.infer;

export interface OpenSearchOperatorBootstrapBuildOptions {
  readonly name?: string;
  readonly namespace?: string;
  readonly version?: string;
  readonly repositoryName?: string;
  readonly repositoryNamespace?: string;
  /**
   * Concrete build-time values for the singleton operator installation.
   * Runtime schema references cannot participate in singleton ownership.
   */
  readonly customValues?: Record<string, unknown>;
}

export const OpenSearchOperatorBootstrapStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  version: 'string',
});

export type OpenSearchOperatorBootstrapStatus =
  typeof OpenSearchOperatorBootstrapStatusSchema.infer;

export const OpenSearchHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

export const OpenSearchHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

export interface OpenSearchOperatorHelmReleaseConfig {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  readonly repositoryName: string;
  readonly repositoryNamespace: string;
  readonly values?: TypeKroChartValue<Record<string, unknown>>;
  readonly id?: string;
}

export const OpenSearchClusterConfigSchema = type({
  name: 'string > 0',
  namespace: 'string > 0',
  'version?': 'string',
  'serviceName?': 'string',
  /**
   * One atomic lifecycle choice avoids combinations that would claim retained
   * PVCs while deleting their containing Namespace.
   */
  'lifecycle?': '"owned-delete" | "external-delete" | "external-retain"',
  'adminCredentialsSecret?': {
    name: 'string > 0',
  },
  'dashboardCredentialsSecret?': {
    name: 'string > 0',
  },
  storage: {
    size: 'string > 0',
    'storageClassName?': 'string',
  },
  'resources?': {
    'requests?': { 'cpu?': 'string', 'memory?': 'string' },
    'limits?': { 'cpu?': 'string', 'memory?': 'string' },
  },
  tls: type({
    source: '"generated"',
  })
    .or({
      source: '"secret"',
      secretName: 'string > 0',
      adminSecretName: 'string > 0',
      adminDn: '(string > 0)[] > 0',
    })
    .or({
      source: '"cert-manager"',
      secretName: 'string > 0',
      adminSecretName: 'string > 0',
      issuerName: 'string > 0',
      'issuerKind?': '"Issuer" | "ClusterIssuer"',
      dnsNames: 'string[] > 0',
      adminDn: '(string > 0)[] > 0',
    }),
  'snapshots?': {
    repository: 'string > 0',
    bucket: 'string > 0',
    credentialsSecret: {
      name: 'string > 0',
      'accessKeyKey?': 'string > 0',
      'secretKeyKey?': 'string > 0',
    },
    'endpoint?': 'string',
    'region?': 'string',
    'basePath?': 'string',
  },
  'monitoring?': 'boolean',
});

export type OpenSearchClusterConfig = typeof OpenSearchClusterConfigSchema.infer;

export const OpenSearchClusterStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  endpoint: 'string',
  credentialsSecret: 'string',
  version: 'string',
  availableNodes: 'number',
  health: 'string',
  snapshotRepository: 'string',
});

export type OpenSearchClusterStatus = typeof OpenSearchClusterStatusSchema.infer;

export interface OpenSearchClusterTopology {
  readonly profile?: 'development' | 'production';
  readonly nodes?: number;
  readonly roles?: readonly ('cluster_manager' | 'data' | 'ingest')[];
  readonly podDisruptionBudget?: {
    readonly minAvailable?: number;
    readonly maxUnavailable?: number;
  };
  readonly networkPolicy?: {
    readonly enabled: boolean;
    /**
     * Namespace containing the OpenSearch operator. Its health probes are
     * always admitted independently of caller traffic.
     *
     * @default 'opensearch-operator-system'
     */
    readonly operatorNamespace?: string;
    readonly ingressNamespaceLabels?: Readonly<Record<string, string>>;
    readonly egressNamespaceLabels?: readonly Readonly<Record<string, string>>[];
    readonly egressCidrs?: readonly string[];
  };
}

export interface OpenSearchClusterResourceConfig {
  readonly name: string;
  readonly namespace: string;
  readonly version: string;
  readonly serviceName: string;
  readonly nodes: number;
  readonly roles: readonly ('cluster_manager' | 'data' | 'ingest')[];
  readonly storage: {
    readonly size: string;
    readonly storageClassName?: string;
    readonly deletionPolicy: 'retain' | 'delete';
  };
  readonly resources?: {
    readonly requests?: { readonly cpu?: string; readonly memory?: string };
    readonly limits?: { readonly cpu?: string; readonly memory?: string };
  };
  readonly adminCredentialsSecret?: { readonly name: string };
  readonly dashboardCredentialsSecret?: { readonly name: string };
  readonly tls:
    | { readonly source: 'generated' }
    | {
        readonly source: 'secret' | 'cert-manager';
        readonly secretName: string;
        readonly adminSecretName: string;
        readonly adminDn: readonly string[];
      };
  readonly snapshots?: {
    readonly repository: string;
    readonly bucket: string;
    readonly credentialsSecret: {
      readonly name: string;
      readonly accessKeyKey: string;
      readonly secretKeyKey: string;
    };
    readonly endpoint?: string;
    readonly region?: string;
    readonly basePath?: string;
  };
  readonly monitoring: boolean;
  readonly podDisruptionBudget?: OpenSearchClusterTopology['podDisruptionBudget'];
  readonly id?: string;
}

export interface OpenSearchClusterResourceSpec {
  readonly general: {
    readonly serviceName: string;
    readonly version: string;
    readonly httpPort: number;
    readonly vendor: 'opensearch';
    readonly pluginsList?: readonly string[];
    readonly drainDataNodes: boolean;
    readonly monitoring: { readonly enable: boolean };
    readonly keystore?: readonly {
      readonly secret: {
        readonly name: string;
        readonly keyMappings: Readonly<Record<string, string>>;
      };
    }[];
    readonly snapshotRepositories?: readonly {
      readonly name: string;
      readonly type: 's3';
      readonly settings: Readonly<Record<string, string>>;
    }[];
  };
  readonly security: {
    readonly config: {
      readonly adminCredentialsSecret?: { readonly name: string };
      readonly adminSecret?: { readonly name: string };
    };
    readonly tls: {
      readonly http:
        | { readonly generate: true }
        | {
            readonly generate: false;
            readonly secret: { readonly name: string };
            readonly adminDn: readonly string[];
          };
      readonly transport: {
        readonly generate: true;
        readonly perNode: true;
      };
    };
  };
  readonly dashboards?: {
    readonly enable: boolean;
    readonly opensearchCredentialsSecret?: { readonly name: string };
  };
  readonly nodePools: readonly {
    readonly component: string;
    readonly replicas: number;
    readonly roles: readonly ('cluster_manager' | 'data' | 'ingest')[];
    readonly diskSize: string;
    readonly persistence?: {
      readonly pvc: {
        readonly storageClass?: string;
        readonly accessModes: readonly ['ReadWriteOnce'];
      };
    };
    readonly resources?: Composable<NonNullable<OpenSearchClusterResourceConfig['resources']>>;
    readonly pdb?: {
      readonly enable: true;
      readonly minAvailable?: number;
      readonly maxUnavailable?: number;
    };
  }[];
}

export interface OpenSearchClusterObservedStatus {
  readonly phase?: string;
  readonly health?: string;
  readonly version?: string;
  readonly initialized?: boolean;
  readonly availableNodes?: number;
  readonly componentsStatus?: readonly {
    readonly component?: string;
    readonly status?: string;
    readonly description?: string;
    readonly conditions?: readonly string[];
  }[];
}
