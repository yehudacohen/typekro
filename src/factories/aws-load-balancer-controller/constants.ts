// AWS Load Balancer Controller factory constants.
//
// Verified against the `aws-load-balancer-controller` chart 3.5.0 (appVersion
// `v3.5.0`) published on https://aws.github.io/eks-charts.

// The chart ships its CRDs (TargetGroupBinding, IngressClassParams, the
// gateway.k8s.aws configuration kinds, ...) in its `crds/` directory. Flux
// SKIPS `crds/` on upgrade by default, so without `CreateReplace` a chart bump
// would run a newer controller against the CRD schemas of the first install.

/** Pinned chart version. */
export const DEFAULT_AWS_LBC_CHART_VERSION = '3.5.0';
/** Controller version bundled with {@link DEFAULT_AWS_LBC_CHART_VERSION}. */
export const DEFAULT_AWS_LBC_APP_VERSION = 'v3.5.0';
/** Chart name inside the eks-charts repository. */
export const AWS_LBC_CHART_NAME = 'aws-load-balancer-controller';
/** The eks-charts Helm repository. */
export const DEFAULT_AWS_LBC_REPOSITORY_URL = 'https://aws.github.io/eks-charts';
/** `HelmRepository` name the bootstrap composition owns as a singleton. */
export const DEFAULT_AWS_LBC_REPOSITORY_NAME = 'eks-charts';
/** Conventional release name, and the service account name the bootstrap pins. */
export const DEFAULT_AWS_LBC_NAME = 'aws-load-balancer-controller';
/** Namespace the controller is installed into by default, as in the upstream docs. */
export const DEFAULT_AWS_LBC_NAMESPACE = 'kube-system';
/** Flux CRD policy applied to install and upgrade. */
export const DEFAULT_AWS_LBC_CRDS_POLICY = 'CreateReplace';
/** API group/version of `TargetGroupBinding` and `IngressClassParams`. */
export const AWS_LBC_ELBV2_API_VERSION = 'elbv2.k8s.aws/v1beta1';
/** IAM policy the controller's role needs, for {@link DEFAULT_AWS_LBC_APP_VERSION}. */
export const AWS_LBC_IAM_POLICY_URL =
  'https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v3.5.0/docs/install/iam_policy.json';
