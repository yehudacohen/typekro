// Vertical Pod Autoscaler factory constants.
//
// Verified against the Fairwinds `vpa` chart 5.1.0 (appVersion `1.7.1`) from
// https://charts.fairwinds.com/stable. That chart is the long-standing
// community chart; the kubernetes/autoscaler `vertical-pod-autoscaler` chart
// (0.13.0) still describes itself as not ready for production use.
//
// Bumping the chart: re-check VPA_DEFAULT_RECOMMENDER_FLAGS and
// VPA_DEFAULT_UPDATER_FLAGS against the new VPA version's docs/flags.md and
// the chart's default `extraArgs`, since every flag is rendered explicitly.
//
// @see https://github.com/FairwindsOps/charts/tree/master/stable/vpa
// @see https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler

/** API group/version of `VerticalPodAutoscaler`. */
export const VPA_API_VERSION = 'autoscaling.k8s.io/v1';

/** Pinned Fairwinds `vpa` chart version (VPA 1.7.1). */
export const DEFAULT_VPA_CHART_VERSION = '5.1.0';
/** Chart name in the Fairwinds repository. */
export const VPA_CHART_NAME = 'vpa';
/** Fairwinds stable chart repository. */
export const DEFAULT_VPA_REPOSITORY_URL = 'https://charts.fairwinds.com/stable';
/** `HelmRepository` name owned by the shared singleton composition. */
export const DEFAULT_VPA_REPOSITORY_NAME = 'fairwinds-stable';
/** Install namespace, as in the chart's install instructions. */
export const DEFAULT_VPA_NAMESPACE = 'vpa';

/**
 * Default component resources: the chart's own requests, restated so the
 * rendered values show them. Helm merges a partial override with these.
 */
export const VPA_DEFAULT_RESOURCES = {
  recommender: { requests: { cpu: '50m', memory: '500Mi' } },
  updater: { requests: { cpu: '50m', memory: '500Mi' } },
  admissionController: { requests: { cpu: '50m', memory: '200Mi' } },
} as const;

/**
 * Recommender flag defaults: the chart's values for the minimum pod
 * recommendation, upstream's for the rest.
 *
 * @see https://github.com/kubernetes/autoscaler/blob/vertical-pod-autoscaler-1.7.1/vertical-pod-autoscaler/docs/flags.md
 */
export const VPA_DEFAULT_RECOMMENDER_FLAGS = {
  podRecommendationMinCpuMillicores: 15,
  podRecommendationMinMemoryMb: 100,
  targetCpuPercentile: 0.9,
  targetMemoryPercentile: 0.9,
  recommendationMarginFraction: 0.15,
  cpuHistogramDecayHalfLife: '24h',
  memoryHistogramDecayHalfLife: '24h',
  memoryAggregationInterval: '24h',
  memoryAggregationIntervalCount: 8,
  storage: 'checkpoint',
  historyLength: '8d',
  prometheusAddress: 'http://prometheus.monitoring.svc',
  recommenderName: 'default',
} as const;

/** Updater flag defaults (upstream). */
export const VPA_DEFAULT_UPDATER_FLAGS = { minReplicas: 2, evictionTolerance: 0.5 } as const;

/**
 * `tlsSecretKeys` for a cert-manager `Certificate` Secret: maps `ca.crt`,
 * `tls.crt` and `tls.key` onto the file names the admission controller reads.
 */
export const VPA_CERT_MANAGER_TLS_SECRET_KEYS = [
  { key: 'ca.crt', path: 'caCert.pem' },
  { key: 'tls.crt', path: 'serverCert.pem' },
  { key: 'tls.key', path: 'serverKey.pem' },
] as const;
