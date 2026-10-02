// Karpenter type definitions.
//
// Config and status shapes are interfaces, which keeps the published
// declarations small. Only the bootstrap composition's spec and status need
// runtime ArkType schemas (KRO builds its SimpleSchema from them), and those
// are annotated with the interfaces they validate.
//
// @see https://karpenter.sh/docs/concepts/nodepools/
// @see https://karpenter.sh/docs/concepts/nodeclasses/

import { type Type, type } from 'arktype';
import type { KARPENTER_LABELS } from './constants.js';

// ============================================================================
// Shared Kubernetes shapes
// ============================================================================

/** Status condition as Karpenter publishes it on `NodePool` and `EC2NodeClass`. */
export interface KarpenterCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

/** A node taint. */
export interface KarpenterTaint {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

/** Pod toleration for the controller Deployment. */
export interface KarpenterToleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** CPU/memory requests and limits. */
export interface KarpenterResourceRequirements {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

// ============================================================================
// NodePool (karpenter.sh/v1)
// ============================================================================

/** A well-known requirement key, or any other label key. */
export type KarpenterRequirementKey =
  | (typeof KARPENTER_LABELS)[keyof typeof KARPENTER_LABELS]
  // `string & {}` keeps literal autocompletion on an open string type.
  | (string & {});

/** One scheduling requirement. `Gt`/`Lt`/`Gte`/`Lte` take a single integer value. */
export interface NodePoolRequirement {
  key: KarpenterRequirementKey;
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt' | 'Gte' | 'Lte';
  values?: string[];
  /** Minimum number of distinct values the scheduler must keep available (1-50). */
  minValues?: number;
}

/** Reference to the node class a `NodePool` launches with. */
export interface NodeClassReference {
  name: string;
  /** @default 'karpenter.k8s.aws' */
  group?: string;
  /** @default 'EC2NodeClass' */
  kind?: string;
}

/** Disruption budget. `schedule` and `duration` must be set together. */
export interface NodePoolDisruptionBudget {
  /** Node count or percentage, e.g. `'10%'` or `'5'`. */
  nodes: string;
  /** Cron schedule (or `@daily` style macro) the budget is active on. */
  schedule?: string;
  /** How long the budget stays active after each `schedule` tick, e.g. `'8h'`. */
  duration?: string;
  /** Disruption methods this budget applies to. All of them when omitted. */
  reasons?: Array<'Underutilized' | 'Empty' | 'Drifted'>;
}

/** `spec.disruption` of a `NodePool`. */
export interface NodePoolDisruption {
  /** @default 'WhenEmptyOrUnderutilized' (CRD default) */
  consolidationPolicy?: 'WhenEmpty' | 'WhenEmptyOrUnderutilized' | 'Balanced';
  /**
   * Duration such as `'30s'`, or `'Never'`. Required by the CRD whenever
   * `disruption` is set; the `'0s'` default applies only when it is omitted.
   */
  consolidateAfter: string;
  budgets?: NodePoolDisruptionBudget[];
}

/** `spec` of a `karpenter.sh/v1` `NodePool`. */
export interface NodePoolSpec {
  template: {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
    spec: {
      nodeClassRef: NodeClassReference;
      requirements: NodePoolRequirement[];
      taints?: KarpenterTaint[];
      /** Taints the node starts with and that a daemon is expected to remove. */
      startupTaints?: KarpenterTaint[];
      /** Node lifetime, e.g. `'720h'`, or `'Never'`. @default '720h' (CRD default) */
      expireAfter?: string;
      /** Upper bound on draining a node before it is forcibly terminated. */
      terminationGracePeriod?: string;
    };
  };
  disruption?: NodePoolDisruption;
  /** Upper bound on the capacity this pool may provision, e.g. `{ cpu: '1000', memory: '4000Gi' }`. */
  limits?: Record<string, string | number>;
  /** Priority against other pools (1-100). Higher wins. */
  weight?: number;
}

/** Observed status of a `NodePool`. */
export interface NodePoolStatus {
  conditions?: KarpenterCondition[];
  /** Capacity currently provisioned by this pool, by resource name. */
  resources?: Record<string, string>;
  /** Number of nodes this pool currently owns. */
  nodes?: number;
  nodeClassObservedGeneration?: number;
}

/** Configuration for {@link nodePool}. `NodePool` is cluster-scoped. */
export interface NodePoolConfig {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec: NodePoolSpec;
  /** Resource id for composition references. */
  id?: string;
}

// ============================================================================
// EC2NodeClass (karpenter.k8s.aws/v1)
// ============================================================================

/**
 * AMI selector term. An `alias` (`al2023@latest`, `bottlerocket@v1.30.0`, ...)
 * must be the only term; `id` excludes the other fields.
 */
export interface EC2NodeClassAMISelectorTerm {
  alias?: string;
  id?: string;
  name?: string;
  owner?: string;
  ssmParameter?: string;
  tags?: Record<string, string>;
}

/** Subnet selector term: tags or an id. */
export interface EC2NodeClassSubnetSelectorTerm {
  tags?: Record<string, string>;
  id?: string;
}

/** Security group selector term: tags, an id or a name. */
export interface EC2NodeClassSecurityGroupSelectorTerm {
  tags?: Record<string, string>;
  id?: string;
  name?: string;
}

/** EBS settings of a block device mapping. */
export interface EC2NodeClassEbs {
  /** Size such as `'100Gi'`. */
  volumeSize?: string;
  volumeType?: 'standard' | 'io1' | 'io2' | 'gp2' | 'sc1' | 'st1' | 'gp3';
  iops?: number;
  throughput?: number;
  encrypted?: boolean;
  kmsKeyID?: string;
  deleteOnTermination?: boolean;
  snapshotID?: string;
  /** MiB/s to initialize a volume restored from `snapshotID` (100-300). */
  volumeInitializationRate?: number;
}

/** A block device mapping. At most one may set `rootVolume`. */
export interface EC2NodeClassBlockDeviceMapping {
  deviceName?: string;
  ebs?: EC2NodeClassEbs;
  rootVolume?: boolean;
}

/** Instance metadata service options. The CRD defaults to IMDSv2 with a hop limit of 1. */
export interface EC2NodeClassMetadataOptions {
  httpEndpoint?: 'enabled' | 'disabled';
  httpProtocolIPv6?: 'enabled' | 'disabled';
  /** 1-64. Use 2 only when pods without IRSA/Pod Identity must reach IMDS. */
  httpPutResponseHopLimit?: number;
  /** `'required'` is IMDSv2-only. `'optional'` also allows IMDSv1. */
  httpTokens?: 'required' | 'optional';
}

/** Kubelet settings Karpenter applies to the nodes it launches. */
export interface EC2NodeClassKubelet {
  maxPods?: number;
  podsPerCore?: number;
  /** Keys: `cpu`, `memory`, `ephemeral-storage`, `pid`. */
  systemReserved?: Record<string, string>;
  /** Keys: `cpu`, `memory`, `ephemeral-storage`, `pid`. */
  kubeReserved?: Record<string, string>;
  /** Signal to threshold, e.g. `{ 'memory.available': '5%' }`. */
  evictionHard?: Record<string, string>;
  evictionSoft?: Record<string, string>;
  evictionSoftGracePeriod?: Record<string, string>;
  evictionMaxPodGracePeriod?: number;
  imageGCHighThresholdPercent?: number;
  imageGCLowThresholdPercent?: number;
  cpuCFSQuota?: boolean;
  clusterDNS?: string[];
}

/** Fields of an `EC2NodeClass` spec other than the node identity. */
export interface EC2NodeClassSpecBase {
  /** Required unless `amiSelectorTerms` uses an `alias`. */
  amiFamily?:
    | 'AL2'
    | 'AL2023'
    | 'Bottlerocket'
    | 'Custom'
    | 'Windows2019'
    | 'Windows2022'
    | 'Windows2025';
  amiSelectorTerms: EC2NodeClassAMISelectorTerm[];
  subnetSelectorTerms: EC2NodeClassSubnetSelectorTerm[];
  securityGroupSelectorTerms: EC2NodeClassSecurityGroupSelectorTerm[];
  associatePublicIPAddress?: boolean;
  blockDeviceMappings?: EC2NodeClassBlockDeviceMapping[];
  metadataOptions?: EC2NodeClassMetadataOptions;
  /** Tags applied to instances, volumes and launch templates. */
  tags?: Record<string, string>;
  /** Merged with (or, for `Custom`, replaces) the user data Karpenter generates. */
  userData?: string;
  kubelet?: EC2NodeClassKubelet;
  detailedMonitoring?: boolean;
  instanceStorePolicy?: 'RAID0';
  /** On-demand capacity reservations to launch into (beta, enabled by default). */
  capacityReservationSelectorTerms?: Array<{
    id?: string;
    ownerID?: string;
    tags?: Record<string, string>;
    instanceMatchCriteria?: 'open' | 'targeted';
  }>;
  /** Placement group, by `name` or `id`. */
  placementGroupSelector?: { name?: string; id?: string };
  /** Network interfaces, e.g. EFA. Must include device 0 on card 0 of type `interface`. */
  networkInterfaces?: Array<{
    networkCardIndex: number;
    deviceIndex: number;
    interfaceType: 'interface' | 'efa-only';
  }>;
  /** IPv4 prefixes per primary ENI (prefix delegation). */
  ipPrefixCount?: number;
  cpuOptions?: { nestedVirtualization?: 'enabled' | 'disabled' };
  /** Connection tracking timeouts, in seconds. */
  connectionTracking?: {
    tcpEstablishedTimeout?: number;
    udpStreamTimeout?: number;
    udpTimeout?: number;
  };
  /** Launch template context (for AWS Outposts / reserved capacity). */
  context?: string;
}

/**
 * `spec` of a `karpenter.k8s.aws/v1` `EC2NodeClass`. Exactly one of `role`
 * (Karpenter manages the instance profile) or `instanceProfile` is set.
 */
export type EC2NodeClassSpec = EC2NodeClassSpecBase &
  (
    | { /** IAM role name for the nodes. */ role: string; instanceProfile?: never }
    | { /** Existing instance profile name. */ instanceProfile: string; role?: never }
  );

/** Observed status of an `EC2NodeClass`. */
export interface EC2NodeClassStatus {
  conditions?: KarpenterCondition[];
  amis?: Array<{ id: string; name?: string }>;
  subnets?: Array<{ id: string; zone: string; zoneID?: string }>;
  securityGroups?: Array<{ id: string; name?: string }>;
  instanceProfile?: string;
  capacityReservations?: Array<{
    id: string;
    availabilityZone: string;
    instanceType: string;
    instanceMatchCriteria: 'open' | 'targeted';
    ownerID: string;
    reservationType?: 'default' | 'capacity-block';
    state?: 'active' | 'expiring';
    endTime?: string;
  }>;
}

/** Configuration for {@link ec2NodeClass}. `EC2NodeClass` is cluster-scoped. */
export interface EC2NodeClassConfig {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec: EC2NodeClassSpec;
  /** Resource id for composition references. */
  id?: string;
}

// ============================================================================
// Bootstrap composition
// ============================================================================

/** Runtime spec of the `karpenterBootstrap` composition. */
export interface KarpenterBootstrapConfig {
  /** Helm release name. The controller's resources and ServiceAccount take this name. */
  name: string;
  /** Install namespace. @default 'kube-system' */
  namespace?: string;
  /** Chart version for both `karpenter-crd` and `karpenter`. @default '1.14.1' */
  version?: string;
  /** EKS cluster name (`settings.clusterName`). */
  clusterName: string;
  /** API server endpoint. Discovered from EKS when omitted. */
  clusterEndpoint?: string;
  /** SQS queue name for interruption handling. Disabled when omitted. */
  interruptionQueue?: string;
  /** @default 2 */
  replicas?: number;
  /** @default 'info' */
  logLevel?: 'debug' | 'info' | 'error';
  /**
   * `Default` resolves through the node instead of cluster DNS, for a controller
   * that has to start before CoreDNS has anywhere to run. @default 'ClusterFirst'
   */
  dnsPolicy?: 'ClusterFirst' | 'Default';
  serviceAccount?: {
    /** @default the release name */
    name?: string;
    /** IRSA: `{ 'eks.amazonaws.com/role-arn': '<role arn>' }`. Not needed for EKS Pod Identity. */
    annotations?: Record<string, string>;
  };
  podDisruptionBudget?: {
    /** @default 1 */
    maxUnavailable?: number;
  };
  /** Merged with the chart default `kubernetes.io/os: linux`. */
  nodeSelector?: Record<string, string>;
  /**
   * Merged into the chart default, which keeps the controller off nodes that
   * Karpenter itself launched. Lists replace the chart's lists.
   */
  affinity?: Record<string, unknown>;
  /** @default KARPENTER_DEFAULT_TOPOLOGY_SPREAD_CONSTRAINTS */
  topologySpreadConstraints?: Record<string, unknown>[];
  /** @default KARPENTER_DEFAULT_TOLERATIONS */
  tolerations?: KarpenterToleration[];
  /**
   * Controller container resources. Defaults to requests of 1 CPU / 1Gi and a
   * 1Gi memory limit; pass `{}` to set none.
   */
  resources?: KarpenterResourceRequirements;
}

/** Status of the `karpenterBootstrap` composition. */
export interface KarpenterBootstrapStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  /** Controller chart version Flux installed, read from the `HelmRelease` history. */
  version: string;
}

const kubernetesDnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');
const resourceList = { 'cpu?': 'string', 'memory?': 'string' } as const;

/**
 * Release name: a DNS label short enough for the `<name>-crd` release to fit
 * Helm's 53-character release-name limit.
 */
const releaseName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 49');

/** ArkType schema for {@link KarpenterBootstrapConfig}. */
export const KarpenterBootstrapConfigSchema: Type<KarpenterBootstrapConfig> = type({
  name: releaseName,
  'namespace?': kubernetesDnsLabel,
  'version?': 'string > 0',
  clusterName: 'string > 0',
  'clusterEndpoint?': 'string',
  'interruptionQueue?': 'string',
  'replicas?': 'number.integer >= 1',
  'logLevel?': '"debug" | "info" | "error"',
  'dnsPolicy?': '"ClusterFirst" | "Default"',
  'serviceAccount?': {
    'name?': kubernetesDnsLabel,
    'annotations?': 'Record<string, string>',
  },
  'podDisruptionBudget?': { 'maxUnavailable?': 'number.integer >= 0' },
  'nodeSelector?': 'Record<string, string>',
  'affinity?': 'Record<string, unknown>',
  'topologySpreadConstraints?': type('Record<string, unknown>').array(),
  'tolerations?': type({
    'key?': 'string',
    'operator?': '"Exists" | "Equal"',
    'value?': 'string',
    'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
    'tolerationSeconds?': 'number.integer',
  }).array(),
  'resources?': { 'requests?': resourceList, 'limits?': resourceList },
});

/** ArkType schema for {@link KarpenterBootstrapStatus}. */
export const KarpenterBootstrapStatusSchema: Type<KarpenterBootstrapStatus> = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  version: 'string',
});

/** Spec of the shared `HelmRepository` singleton. */
export interface KarpenterHelmRepositorySingletonSpec {
  name: string;
  namespace: string;
  url: string;
}

/** ArkType schema for {@link KarpenterHelmRepositorySingletonSpec}. */
export const KarpenterHelmRepositorySingletonSpecSchema: Type<KarpenterHelmRepositorySingletonSpec> =
  type({ name: kubernetesDnsLabel, namespace: kubernetesDnsLabel, url: 'string > 0' });

/** ArkType schema for the singleton's status. */
export const KarpenterHelmRepositorySingletonStatusSchema: Type<{ ready: boolean }> = type({
  ready: 'boolean',
});

/**
 * Build-time options for {@link makeKarpenterBootstrap}. These decide which
 * resources exist, so they must be concrete.
 */
export interface KarpenterBootstrapBuildOptions {
  /** Composition name. @default 'karpenter-bootstrap' */
  readonly name?: string;
  /** KRO kind. @default 'KarpenterBootstrap' */
  readonly kind?: string;
  /**
   * Who manages the CRDs. `'karpenter-crd'` (upstream's GitOps recommendation)
   * installs them from the `karpenter-crd` chart before the controller, whose
   * own `crds/` are skipped. `'external'` installs only the controller.
   * @default 'karpenter-crd'
   */
  readonly crds?: 'karpenter-crd' | 'external';
  /**
   * Keep the CRDs, and with them every NodePool and NodeClaim, when the
   * `karpenter-crd` release is uninstalled. @default true
   */
  readonly keepCrdsOnUninstall?: boolean;
  /**
   * `'owned'` makes the namespace part of the graph. `'external'` leaves it to
   * Flux (`install.createNamespace`), which is right for `kube-system`.
   * @default 'external'
   */
  readonly namespaceOwnership?: 'owned' | 'external';
  /** Raw chart values, deep-merged over the mapped values. Plain objects merge; lists replace. */
  readonly values?: Record<string, unknown>;
}

/** Configuration for the Karpenter `HelmRepository`. */
export interface KarpenterHelmRepositoryConfig {
  /** @default DEFAULT_KARPENTER_REPOSITORY_NAME */
  name?: string;
  /** @default 'flux-system' */
  namespace?: string;
  /** @default DEFAULT_KARPENTER_REPOSITORY_URL */
  url?: string;
  /** @default '1h' */
  interval?: string;
  id?: string;
}

/** Configuration for the Karpenter `HelmRelease` factories. */
export interface KarpenterHelmReleaseConfig {
  /** `HelmRelease` name, also pinned as the Helm release name. */
  name: string;
  /** Namespace of the `HelmRelease` object. @default 'flux-system' */
  namespace?: string;
  /** Install namespace. @default 'kube-system' */
  targetNamespace?: string;
  /** @default DEFAULT_KARPENTER_CHART_VERSION */
  version?: string;
  /** @default DEFAULT_KARPENTER_REPOSITORY_NAME */
  repositoryName?: string;
  /** @default the `HelmRelease` namespace */
  repositoryNamespace?: string;
  /** Let Flux create the install namespace. @default false */
  createNamespace?: boolean;
  /** Flux `spec.dependsOn`: releases that must be Ready before this one installs or upgrades. */
  dependsOn?: { name: string; namespace?: string }[];
  values?: Record<string, unknown>;
  id?: string;
}
