// AWS Load Balancer Controller types.
//
// Config contracts are interfaces and each ArkType schema is annotated with
// its interface, so the published declarations stay small; the schemas are
// what validates direct-mode input and generates the KRO SimpleSchema.

import type {
  V1LabelSelector,
  V1ResourceRequirements,
  V1Toleration,
  V1TopologySpreadConstraint,
} from '@kubernetes/client-node';
import { type Type, type } from 'arktype';
import type { HelmReleaseLifecycleOptions } from '../helm/types.js';

// =============================================================================
// Bootstrap composition
// =============================================================================

/** Runtime spec of the AWS Load Balancer Controller bootstrap. */
export interface AwsLoadBalancerControllerBootstrapConfig {
  /** Helm release name. The service account name does not follow it. */
  name: string;
  /** Install namespace. @default 'kube-system' */
  namespace?: string;
  /** Chart version. @default DEFAULT_AWS_LBC_CHART_VERSION */
  chartVersion?: string;
  /** EKS cluster name. Required by the chart. */
  clusterName: string;
  /** AWS region. Discovered from instance metadata when unset. */
  region?: string;
  /** VPC ID. Discovered from instance metadata when unset. */
  vpcId?: string;
  /** Controller replicas. @default 2 (chart default) */
  replicaCount?: number;
  /** Override the controller image, e.g. a regional or private ECR mirror. */
  image?: { repository?: string; tag?: string; pullPolicy?: 'Always' | 'IfNotPresent' | 'Never' };
  /**
   * The controller's service account, named `aws-load-balancer-controller`
   * unless `name` is set. TypeKro creates no IAM: put the IRSA role in
   * `annotations` (`eks.amazonaws.com/role-arn`), or associate an EKS Pod
   * Identity with that name in this namespace.
   */
  serviceAccount?: { create?: boolean; name?: string; annotations?: Record<string, string> };
  /** PodDisruptionBudget spec. Rendered only above 1 replica. @default { maxUnavailable: 1 } */
  podDisruptionBudget?: { minAvailable?: number; maxUnavailable?: number };
  topologySpreadConstraints?: V1TopologySpreadConstraint[];
  /**
   * Make the controller the default for every new `type: LoadBalancer`
   * Service. @default false, so Services owned by another controller are
   * never taken over.
   */
  enableServiceMutatorWebhook?: boolean;
  /** Create the `alb` IngressClass. @default true (chart default) */
  createIngressClassResource?: boolean;
  /** IngressClass name the controller serves. @default 'alb' (chart default) */
  ingressClass?: string;
  /**
   * Default target type for Ingresses and Services. `ip` needs pod IPs routable
   * from the VPC (Amazon VPC CNI, Cilium ENI mode); use `instance` with an
   * overlay CNI such as Cilium in VXLAN/Geneve mode. @default 'ip'
   */
  defaultTargetType?: 'ip' | 'instance';
  resources?: V1ResourceRequirements;
  nodeSelector?: Record<string, string>;
  tolerations?: V1Toleration[];
  logLevel?: 'info' | 'debug';
}

/** Status of the AWS Load Balancer Controller bootstrap. */
export interface AwsLoadBalancerControllerBootstrapStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  /** Chart version Flux installed, read from the release history. */
  version: string;
}

/** Build-time options of {@link makeAwsLoadBalancerControllerBootstrap}. Must be concrete. */
export interface AwsLoadBalancerControllerBootstrapOptions extends HelmReleaseLifecycleOptions {
  /** Composition name. @default 'aws-load-balancer-controller-bootstrap' */
  name?: string;
  /** Custom resource kind. @default 'AwsLoadBalancerControllerBootstrap' */
  kind?: string;
  /**
   * Raw chart values laid over the mapped values. A key set here replaces the
   * mapped value as a whole (so `podDisruptionBudget: { minAvailable: 1 }`
   * drops the default `maxUnavailable`); `serviceAccount` merges field by field.
   */
  values?: Record<string, unknown>;
}

const imageSchema = {
  'repository?': 'string > 0',
  'tag?': 'string > 0',
  'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
} as const;

const labelSelectorSchema = {
  'matchLabels?': 'Record<string, string>',
  'matchExpressions?': type({
    key: 'string',
    operator: 'string',
    'values?': 'string[]',
  }).array(),
} as const;

/** ArkType schema for {@link AwsLoadBalancerControllerBootstrapConfig}. */
export const AwsLoadBalancerControllerBootstrapConfigSchema: Type<AwsLoadBalancerControllerBootstrapConfig> =
  type({
    name: 'string > 0',
    'namespace?': 'string > 0',
    'chartVersion?': 'string > 0',
    clusterName: 'string > 0',
    'region?': 'string > 0',
    'vpcId?': 'string > 0',
    'replicaCount?': 'number.integer >= 1',
    'image?': imageSchema,
    'serviceAccount?': {
      'create?': 'boolean',
      'name?': 'string > 0',
      'annotations?': 'Record<string, string>',
    },
    // Integers only: a `number | string` union collapses to a schemaless
    // `object` in KRO's SimpleSchema, which rejects a plain integer, and the
    // chart passes these straight into the PDB, where a string must be a
    // percentage. Use build-time `values` for a percentage.
    'podDisruptionBudget?': {
      'minAvailable?': 'number.integer >= 0',
      'maxUnavailable?': 'number.integer >= 0',
    },
    'topologySpreadConstraints?': type({
      maxSkew: 'number.integer > 0',
      topologyKey: 'string',
      whenUnsatisfiable: '"DoNotSchedule" | "ScheduleAnyway"',
      'labelSelector?': labelSelectorSchema,
      'minDomains?': 'number.integer > 0',
      'matchLabelKeys?': 'string[]',
      'nodeAffinityPolicy?': '"Honor" | "Ignore"',
      'nodeTaintsPolicy?': '"Honor" | "Ignore"',
    }).array(),
    'enableServiceMutatorWebhook?': 'boolean',
    'createIngressClassResource?': 'boolean',
    'ingressClass?': 'string > 0',
    'defaultTargetType?': '"ip" | "instance"',
    'resources?': {
      'limits?': 'Record<string, string>',
      'requests?': 'Record<string, string>',
    },
    'nodeSelector?': 'Record<string, string>',
    'tolerations?': type({
      'key?': 'string',
      'operator?': '"Exists" | "Equal"',
      'value?': 'string',
      'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
      'tolerationSeconds?': 'number.integer',
    }).array(),
    'logLevel?': '"info" | "debug"',
  });

/** ArkType schema for {@link AwsLoadBalancerControllerBootstrapStatus}. */
export const AwsLoadBalancerControllerBootstrapStatusSchema: Type<AwsLoadBalancerControllerBootstrapStatus> =
  type({
    ready: 'boolean',
    failed: 'boolean',
    phase: '"Ready" | "Installing" | "Failed"',
    version: 'string',
  });

// =============================================================================
// Helm resources
// =============================================================================

/** Config of the eks-charts `HelmRepository`. */
export interface AwsLoadBalancerControllerHelmRepositoryConfig {
  /** @default DEFAULT_AWS_LBC_REPOSITORY_NAME */
  name?: string;
  /** @default 'flux-system' */
  namespace?: string;
  /** @default DEFAULT_AWS_LBC_REPOSITORY_URL */
  url?: string;
  /** @default '1h' */
  interval?: string;
  id?: string;
}

/** Config of the controller `HelmRelease`. */
export interface AwsLoadBalancerControllerHelmReleaseConfig extends HelmReleaseLifecycleOptions {
  /** Release name. */
  name: string;
  /** Namespace of the HelmRelease object. @default 'flux-system' */
  namespace?: string;
  /** Namespace the controller is installed into. @default 'kube-system' */
  targetNamespace?: string;
  /** @default DEFAULT_AWS_LBC_CHART_VERSION */
  version?: string;
  /** @default DEFAULT_AWS_LBC_REPOSITORY_NAME */
  repositoryName?: string;
  /** @default the HelmRelease namespace */
  repositoryNamespace?: string;
  /** @default '10m' */
  interval?: string;
  /** Chart values. Build them with `mapAwsLoadBalancerControllerConfigToHelmValues`. */
  values?: Record<string, unknown>;
  id?: string;
}

/** Spec of the shared eks-charts `HelmRepository` singleton. */
export interface AwsLoadBalancerControllerHelmRepositorySingletonSpec {
  name: string;
  namespace: string;
  url: string;
}

export const AwsLoadBalancerControllerHelmRepositorySingletonSpecSchema: Type<AwsLoadBalancerControllerHelmRepositorySingletonSpec> =
  type({ name: 'string > 0', namespace: 'string > 0', url: 'string > 0' });

export const AwsLoadBalancerControllerHelmRepositorySingletonStatusSchema: Type<{
  ready: boolean;
}> = type({ ready: 'boolean' });

// =============================================================================
// elbv2.k8s.aws/v1beta1 resources
// =============================================================================

/** A port on a Service or pod: a number or a port name. */
export type AwsLbcPort = number | string;

/**
 * The target group a `TargetGroupBinding` binds to: its ARN, its name, or both.
 * The CRD makes neither field required, but the controller's webhook rejects a
 * binding with neither, so the type requires at least one. With both set, the
 * controller uses the ARN and does not look the name up.
 */
export type TargetGroupBindingTargetGroup =
  | {
      /** ARN of an existing target group. Takes precedence over `targetGroupName`. */
      targetGroupARN: string;
      /** Name of an existing target group. Ignored while `targetGroupARN` is set. */
      targetGroupName?: string;
    }
  | {
      /** ARN of an existing target group. Takes precedence over `targetGroupName`. */
      targetGroupARN?: string;
      /** Name of an existing target group, which the controller resolves to its ARN. */
      targetGroupName: string;
    };

/** Spec of an `elbv2.k8s.aws/v1beta1` `TargetGroupBinding`. */
export type TargetGroupBindingSpec = TargetGroupBindingSpecFields & TargetGroupBindingTargetGroup;

/** The `TargetGroupBinding` spec fields other than the target group itself. */
export interface TargetGroupBindingSpecFields {
  /** The Service (and its port) whose endpoints become targets. */
  serviceRef: { name: string; port: AwsLbcPort };
  targetType?: 'instance' | 'ip';
  /** Protocol of a target group the controller looks up by name. */
  targetGroupProtocol?: 'HTTP' | 'HTTPS' | 'TCP' | 'TLS' | 'UDP' | 'TCP_UDP' | 'QUIC' | 'TCP_QUIC';
  ipAddressType?: 'ipv4' | 'ipv6';
  /** Security group rules the controller manages so the load balancer reaches the targets. */
  networking?: {
    ingress?: {
      from: ({ ipBlock: { cidr: string } } | { securityGroup: { groupID: string } })[];
      /** Required by the CRD. An empty port entry opens every TCP port. */
      ports: { port?: AwsLbcPort; protocol?: 'TCP' | 'UDP' }[];
    }[];
  };
  /** Restrict `instance` targets to matching nodes. */
  nodeSelector?: V1LabelSelector;
  vpcID?: string;
  multiClusterTargetGroup?: boolean;
  /** Assume this role to reach a target group in another account. */
  iamRoleArnToAssume?: string;
  assumeRoleExternalId?: string;
}

/** Status of a `TargetGroupBinding`. */
export interface TargetGroupBindingStatus {
  observedGeneration?: number;
  conditions?: { type: string; status: string; reason?: string; message?: string }[];
}

/** Config of {@link targetGroupBinding}. */
export interface TargetGroupBindingConfig {
  name: string;
  namespace?: string;
  spec: TargetGroupBindingSpec;
  id?: string;
}

/** Spec of a cluster-scoped `elbv2.k8s.aws/v1beta1` `IngressClassParams`. */
export interface IngressClassParamsSpec {
  /** Ingresses from these namespaces only may use the class. */
  namespaceSelector?: V1LabelSelector;
  /** Merge every Ingress of the class into one ALB. */
  group?: { name: string };
  scheme?: 'internal' | 'internet-facing';
  ipAddressType?: 'ipv4' | 'dualstack' | 'dualstack-without-public-ipv4';
  targetType?: 'instance' | 'ip';
  /** Subnets by ID or by tag. Otherwise the controller discovers them by tag. */
  subnets?: { ids?: string[]; tags?: Record<string, string[]> };
  tags?: { key: string; value: string }[];
  loadBalancerAttributes?: { key: string; value: string }[];
  loadBalancerName?: string;
  sslPolicy?: string;
  certificateArn?: string[];
  inboundCIDRs?: string[];
  /** Managed prefix lists allowed to reach the load balancer. */
  prefixListsIDs?: string[];
  /** Redirect HTTP to this HTTPS port on every Ingress of the class. */
  sslRedirectPort?: string;
  wafv2AclArn?: string;
  wafv2AclName?: string;
  /** Per-listener attributes, keyed by port and protocol. */
  listeners?: {
    port?: number;
    protocol?: string;
    listenerAttributes?: { key: string; value: string }[];
  }[];
  /** Pre-provisioned ALB capacity. */
  minimumLoadBalancerCapacity?: { capacityUnits: number };
  /** Take the load balancer's IPv4 addresses from an IPAM pool. */
  ipamConfiguration?: { ipv4IPAMPoolId?: string };
}

/** Config of {@link ingressClassParams}. */
export interface IngressClassParamsConfig {
  name: string;
  spec?: IngressClassParamsSpec;
  id?: string;
}
