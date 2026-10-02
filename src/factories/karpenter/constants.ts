// Karpenter factory constants.
//
// Verified against the official charts `karpenter` and `karpenter-crd` 1.14.1
// (appVersion `1.14.1`) published at `oci://public.ecr.aws/karpenter`.
//
// @see https://karpenter.sh/docs/upgrading/upgrade-guide/#crd-upgrades

/** API group/version of `NodePool` (and `NodeClaim`). */
export const KARPENTER_API_VERSION = 'karpenter.sh/v1';
/** API group/version of the AWS provider's `EC2NodeClass`. */
export const KARPENTER_AWS_API_VERSION = 'karpenter.k8s.aws/v1';
/** API group of `EC2NodeClass`, as a `nodeClassRef.group`. */
export const KARPENTER_AWS_GROUP = 'karpenter.k8s.aws';

/** Pinned chart version, used for both `karpenter-crd` and `karpenter`. */
export const DEFAULT_KARPENTER_CHART_VERSION = '1.14.1';
/** Controller chart name inside the OCI registry. */
export const KARPENTER_CHART_NAME = 'karpenter';
/** CRD chart name inside the OCI registry. */
export const KARPENTER_CRD_CHART_NAME = 'karpenter-crd';
/** Official OCI registry holding both charts. */
export const DEFAULT_KARPENTER_REPOSITORY_URL = 'oci://public.ecr.aws/karpenter';
/** `HelmRepository` name owned by the shared singleton composition. */
export const DEFAULT_KARPENTER_REPOSITORY_NAME = 'karpenter-repo';
/** Install namespace, as in the upstream getting-started guide. */
export const DEFAULT_KARPENTER_NAMESPACE = 'kube-system';

/**
 * Well-known label keys usable in `NodePool` requirements.
 *
 * @see https://karpenter.sh/docs/concepts/scheduling/#well-known-labels
 */
export const KARPENTER_LABELS = {
  capacityType: 'karpenter.sh/capacity-type',
  nodePool: 'karpenter.sh/nodepool',
  instanceType: 'node.kubernetes.io/instance-type',
  instanceCategory: 'karpenter.k8s.aws/instance-category',
  instanceFamily: 'karpenter.k8s.aws/instance-family',
  instanceGeneration: 'karpenter.k8s.aws/instance-generation',
  instanceSize: 'karpenter.k8s.aws/instance-size',
  instanceCpu: 'karpenter.k8s.aws/instance-cpu',
  instanceMemory: 'karpenter.k8s.aws/instance-memory',
  zone: 'topology.kubernetes.io/zone',
  arch: 'kubernetes.io/arch',
  os: 'kubernetes.io/os',
} as const;

/** Subnet and security-group tag Karpenter's getting-started guide discovers by. */
export const KARPENTER_DISCOVERY_TAG = 'karpenter.sh/discovery';

/**
 * Chart default tolerations, restated because a Helm list value replaces the
 * chart's list rather than merging with it.
 */
export const KARPENTER_DEFAULT_TOLERATIONS = [
  { key: 'CriticalAddonsOnly', operator: 'Exists' },
] as const;

/** Chart default topology spread: one controller replica per zone. */
export const KARPENTER_DEFAULT_TOPOLOGY_SPREAD_CONSTRAINTS = [
  { maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'DoNotSchedule' },
] as const;
