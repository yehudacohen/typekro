// Vertical Pod Autoscaler type definitions.
//
// Config and status shapes are interfaces, which keeps the published
// declarations small. Only the bootstrap composition's spec and status need
// runtime ArkType schemas (KRO builds its SimpleSchema from them), and those
// are annotated with the interfaces they validate.
//
// @see https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/api.md

import { type Type, type } from 'arktype';

// ============================================================================
// Shared Kubernetes shapes
// ============================================================================

/** Status condition as the recommender publishes it on a `VerticalPodAutoscaler`. */
export interface VpaCondition {
  /** `RecommendationProvided`, `LowConfidence`, `NoPodsMatched`, `FetchingHistory`, `ConfigDeprecated` or `ConfigUnsupported`. */
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** Quantities by resource name, e.g. `{ cpu: '100m', memory: '128Mi' }`. */
export type VpaResourceList = Record<string, string | number>;

/** Pod toleration for a VPA component. */
export interface VpaToleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** CPU/memory requests and limits. */
export interface VpaResourceRequirements {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

// ============================================================================
// VerticalPodAutoscaler (autoscaling.k8s.io/v1)
// ============================================================================

/**
 * When the VPA applies its recommendation. `Off` only records it; `Initial`
 * sets requests at pod creation; `Recreate` also evicts running pods;
 * `InPlaceOrRecreate` resizes in place and falls back to eviction; `InPlace`
 * never evicts. `Auto` is a deprecated alias of `Recreate`.
 */
export type VpaUpdateMode =
  | 'Off'
  | 'Initial'
  | 'Recreate'
  | 'InPlaceOrRecreate'
  | 'InPlace'
  | 'Auto';

/** The workload a VPA controls: anything with a `scale` subresource or a pod template. */
export interface VpaTargetRef {
  /** @default inferred by the VPA from `kind` */
  apiVersion?: string;
  kind: string;
  name: string;
}

/** Per-container bounds and scope. `containerName: '*'` applies to every container. */
export interface VpaContainerPolicy {
  containerName?: string;
  /** `Off` turns the VPA off for this container. @default 'Auto' */
  mode?: 'Auto' | 'Off';
  minAllowed?: VpaResourceList;
  maxAllowed?: VpaResourceList;
  /** @default ['cpu', 'memory'] */
  controlledResources?: Array<'cpu' | 'memory'>;
  /** `RequestsOnly` leaves limits alone. @default 'RequestsAndLimits' */
  controlledValues?: 'RequestsAndLimits' | 'RequestsOnly';
}

/** An eviction rule: only evict when the target moved in the given direction. */
export interface VpaEvictionRequirement {
  resources: Array<'cpu' | 'memory'>;
  changeRequirement: 'TargetHigherThanRequests' | 'TargetLowerThanRequests';
}

/** `spec` of a `VerticalPodAutoscaler`. */
export interface VerticalPodAutoscalerSpec {
  targetRef: VpaTargetRef;
  updatePolicy?: {
    /** The CRD sets no default; the VPA treats an unset mode as `'Recreate'`. */
    updateMode?: VpaUpdateMode;
    /** Minimum live replicas before the updater evicts; overrides `--min-replicas`. */
    minReplicas?: number;
    evictionRequirements?: VpaEvictionRequirement[];
  };
  resourcePolicy?: { containerPolicies?: VpaContainerPolicy[] };
  /** At most one recommender. The default recommender is used when empty. */
  recommenders?: Array<{ name: string }>;
}

/** The recommendation for one container. */
export interface VpaContainerRecommendation {
  containerName?: string;
  target: Record<string, string>;
  lowerBound?: Record<string, string>;
  upperBound?: Record<string, string>;
  /** The target before `minAllowed`/`maxAllowed` were applied. */
  uncappedTarget?: Record<string, string>;
}

/** Observed status of a `VerticalPodAutoscaler`. */
export interface VerticalPodAutoscalerStatus {
  recommendation?: { containerRecommendations?: VpaContainerRecommendation[] };
  conditions?: VpaCondition[];
}

/** Configuration for {@link verticalPodAutoscaler}. */
export interface VerticalPodAutoscalerConfig {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec: VerticalPodAutoscalerSpec;
  /**
   * `'recommendation'` waits for `RecommendationProvided=True`, which needs
   * running pods and metrics. `'accepted'` is ready once the API server has
   * stored the object. @default 'recommendation'
   */
  readiness?: 'recommendation' | 'accepted';
  /** Resource id for composition references. */
  id?: string;
}

/** A workload resource, used as a `targetRef` through its `apiVersion`, `kind` and name. */
export interface VpaTargetResource {
  apiVersion: string;
  kind: string;
  metadata: { name?: string | undefined };
}

/** Options for {@link vpaRecommendOnly}. */
export interface VpaRecommendOnlyOptions {
  /** @default the target's name */
  name?: string;
  namespace?: string;
  containerPolicies?: VpaContainerPolicy[];
  readiness?: 'recommendation' | 'accepted';
  id?: string;
}

// ============================================================================
// Bootstrap composition
// ============================================================================

/** Settings shared by the three VPA components. */
export interface VpaComponentConfig {
  /** @default true */
  enabled?: boolean;
  /** @default 1 */
  replicas?: number;
  /** Merged by Helm over the chart's requests (see `VPA_DEFAULT_RESOURCES`). */
  resources?: VpaResourceRequirements;
  /**
   * Rendered by the chart only when `replicas` is above 1. Percentages go
   * through the build-time `values`. @default { maxUnavailable: 1 }
   */
  podDisruptionBudget?: { minAvailable?: number; maxUnavailable?: number };
  nodeSelector?: Record<string, string>;
  tolerations?: VpaToleration[];
  affinity?: Record<string, unknown>;
}

/** Recommender settings and flags. Every flag is rendered with its default. */
export interface VpaRecommenderConfig extends VpaComponentConfig {
  /** klog verbosity (`--v`). @default 4 */
  logLevel?: number;
  /** `--pod-recommendation-min-cpu-millicores`. @default 15 */
  podRecommendationMinCpuMillicores?: number;
  /** `--pod-recommendation-min-memory-mb`. @default 100 */
  podRecommendationMinMemoryMb?: number;
  /** `--target-cpu-percentile`. @default 0.9 */
  targetCpuPercentile?: number;
  /** `--target-memory-percentile`. @default 0.9 */
  targetMemoryPercentile?: number;
  /** `--recommendation-margin-fraction`. @default 0.15 */
  recommendationMarginFraction?: number;
  /** `--cpu-histogram-decay-half-life`. @default '24h' */
  cpuHistogramDecayHalfLife?: string;
  /** `--memory-histogram-decay-half-life`. @default '24h' */
  memoryHistogramDecayHalfLife?: string;
  /** `--memory-aggregation-interval`: one memory peak sample per interval. @default '24h' */
  memoryAggregationInterval?: string;
  /** `--memory-aggregation-interval-count`: intervals in the memory window. @default 8 */
  memoryAggregationIntervalCount?: number;
  /** `--storage`: where usage history comes from. @default 'checkpoint' */
  storage?: 'checkpoint' | 'prometheus';
  /** `--history-length`: how far back to query Prometheus. @default '8d' */
  historyLength?: string;
  /** `--prometheus-address`. @default 'http://prometheus.monitoring.svc' */
  prometheusAddress?: string;
  /** `--recommender-name`, matched against a VPA's `recommenders`. @default 'default' */
  recommenderName?: string;
}

/** Updater settings and flags. */
export interface VpaUpdaterConfig extends VpaComponentConfig {
  /** `--min-replicas`: live replicas needed before the updater evicts. @default 2 */
  minReplicas?: number;
  /** `--eviction-tolerance`: fraction of replicas evictable at once. @default 0.5 */
  evictionTolerance?: number;
}

/** Admission controller settings: the webhook that writes recommended requests into new pods. */
export interface VpaAdmissionControllerConfig extends VpaComponentConfig {
  certificate?: {
    /**
     * Let the chart's `kube-webhook-certgen` hook Jobs create the serving
     * Secret and patch the webhook CA bundle. @default true
     */
    generate?: boolean;
    /** Serving Secret. @default '<name>-tls-secret' */
    secretName?: string;
    /** Secret key to file name mapping; `VPA_CERT_MANAGER_TLS_SECRET_KEYS` for cert-manager. */
    secretKeys?: Array<{ key: string; path: string }>;
  };
  webhook?: {
    /** @default 'Ignore' */
    failurePolicy?: 'Ignore' | 'Fail';
    /** @default 5 */
    timeoutSeconds?: number;
    namespaceSelector?: Record<string, unknown>;
    objectSelector?: Record<string, unknown>;
    /** E.g. `{ 'cert-manager.io/inject-ca-from': '<namespace>/<certificate>' }`. */
    annotations?: Record<string, string>;
  };
}

/** Runtime spec of the `vpaBootstrap` composition. */
export interface VpaBootstrapConfig {
  /** Helm release name, also the chart `fullnameOverride`. */
  name: string;
  /** Install namespace. @default 'vpa' */
  namespace?: string;
  /** Fairwinds `vpa` chart version. @default '5.1.0' */
  version?: string;
  recommender?: VpaRecommenderConfig;
  updater?: VpaUpdaterConfig;
  admissionController?: VpaAdmissionControllerConfig;
  /** Install the bundled metrics-server subchart. VPA needs `metrics.k8s.io`. @default false */
  metricsServer?: { enabled?: boolean };
  /** Priority class for every component. */
  priorityClassName?: string;
  /** Annotations on every component's service account. */
  serviceAccountAnnotations?: Record<string, string>;
}

/** Status of the `vpaBootstrap` composition. */
export interface VpaBootstrapStatus {
  ready: boolean;
  failed: boolean;
  phase: 'Ready' | 'Installing' | 'Failed';
  /** Chart version Flux installed, read from the `HelmRelease` history. */
  version: string;
}

const kubernetesDnsLabel = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 63');
// Helm release names are limited to 53 characters.
const releaseName = type(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/).and('string <= 53');
const resourceList = { 'cpu?': 'string', 'memory?': 'string' } as const;
const toleration = type({
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number.integer',
});
const componentShape = {
  'enabled?': 'boolean',
  'replicas?': 'number.integer >= 0',
  'resources?': { 'requests?': resourceList, 'limits?': resourceList },
  'podDisruptionBudget?': {
    'minAvailable?': 'number.integer >= 0',
    'maxUnavailable?': 'number.integer >= 0',
  },
  'nodeSelector?': 'Record<string, string>',
  'tolerations?': toleration.array(),
  'affinity?': 'Record<string, unknown>',
} as const;

/** ArkType schema for {@link VpaBootstrapConfig}. */
export const VpaBootstrapConfigSchema: Type<VpaBootstrapConfig> = type({
  name: releaseName,
  'namespace?': kubernetesDnsLabel,
  'version?': 'string > 0',
  'recommender?': {
    ...componentShape,
    'logLevel?': 'number.integer >= 0',
    'podRecommendationMinCpuMillicores?': 'number.integer >= 0',
    'podRecommendationMinMemoryMb?': 'number.integer >= 0',
    'targetCpuPercentile?': '0 < number <= 1',
    'targetMemoryPercentile?': '0 < number <= 1',
    'recommendationMarginFraction?': 'number >= 0',
    'cpuHistogramDecayHalfLife?': 'string > 0',
    'memoryHistogramDecayHalfLife?': 'string > 0',
    'memoryAggregationInterval?': 'string > 0',
    'memoryAggregationIntervalCount?': 'number.integer >= 1',
    'storage?': '"checkpoint" | "prometheus"',
    'historyLength?': 'string > 0',
    'prometheusAddress?': 'string > 0',
    'recommenderName?': 'string > 0',
  },
  'updater?': {
    ...componentShape,
    'minReplicas?': 'number.integer >= 1',
    'evictionTolerance?': '0 <= number <= 1',
  },
  'admissionController?': {
    ...componentShape,
    'certificate?': {
      'generate?': 'boolean',
      'secretName?': kubernetesDnsLabel,
      'secretKeys?': type({ key: 'string > 0', path: 'string > 0' }).array(),
    },
    'webhook?': {
      'failurePolicy?': '"Ignore" | "Fail"',
      'timeoutSeconds?': '1 <= number.integer <= 30',
      'namespaceSelector?': 'Record<string, unknown>',
      'objectSelector?': 'Record<string, unknown>',
      'annotations?': 'Record<string, string>',
    },
  },
  'metricsServer?': { 'enabled?': 'boolean' },
  'priorityClassName?': 'string',
  'serviceAccountAnnotations?': 'Record<string, string>',
});

/** ArkType schema for {@link VpaBootstrapStatus}. */
export const VpaBootstrapStatusSchema: Type<VpaBootstrapStatus> = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  version: 'string',
});

/** Spec of the shared `HelmRepository` singleton. */
export interface VpaHelmRepositorySingletonSpec {
  name: string;
  namespace: string;
  url: string;
}

/** ArkType schema for {@link VpaHelmRepositorySingletonSpec}. */
export const VpaHelmRepositorySingletonSpecSchema: Type<VpaHelmRepositorySingletonSpec> = type({
  name: kubernetesDnsLabel,
  namespace: kubernetesDnsLabel,
  url: 'string > 0',
});

/** ArkType schema for the singleton's status. */
export const VpaHelmRepositorySingletonStatusSchema: Type<{ ready: boolean }> = type({
  ready: 'boolean',
});

/**
 * Build-time options for {@link makeVpaBootstrap}. These decide which
 * resources exist, so they must be concrete.
 */
export interface VpaBootstrapBuildOptions {
  /** Composition name. @default 'vpa-bootstrap' */
  readonly name?: string;
  /** KRO kind. @default 'VpaBootstrap' */
  readonly kind?: string;
  /**
   * `'owned'` makes the namespace part of the graph. `'external'` leaves it to
   * Flux (`install.createNamespace`). @default 'external'
   */
  readonly namespaceOwnership?: 'owned' | 'external';
  /** Raw chart values, deep-merged over the mapped values. Plain objects merge; lists replace. */
  readonly values?: Record<string, unknown>;
}

/** Configuration for the VPA `HelmRepository`. */
export interface VpaHelmRepositoryConfig {
  /** @default DEFAULT_VPA_REPOSITORY_NAME */
  name?: string;
  /** @default 'flux-system' */
  namespace?: string;
  /** @default DEFAULT_VPA_REPOSITORY_URL */
  url?: string;
  /** @default '1h' */
  interval?: string;
  id?: string;
}

/** Configuration for {@link vpaHelmRelease}. */
export interface VpaHelmReleaseConfig {
  /** `HelmRelease` name, also pinned as the Helm release name. */
  name: string;
  /** Namespace of the `HelmRelease` object. @default 'flux-system' */
  namespace?: string;
  /** Install namespace. @default 'vpa' */
  targetNamespace?: string;
  /** @default DEFAULT_VPA_CHART_VERSION */
  version?: string;
  /** @default DEFAULT_VPA_REPOSITORY_NAME */
  repositoryName?: string;
  /** @default the `HelmRelease` namespace */
  repositoryNamespace?: string;
  /** Let Flux create the install namespace. @default false */
  createNamespace?: boolean;
  values?: Record<string, unknown>;
  id?: string;
}
