// KEDA type definitions.
//
// Config and status shapes are interfaces, which keeps the published
// declarations small. Only the bootstrap composition's spec and status need
// runtime ArkType schemas (KRO builds its SimpleSchema from them), and those
// are annotated with the interfaces they validate.
//
// Trigger metadata is `map[string]string` in the CRD, so every typed metadata
// field is a string, numbers included (`threshold: '20'`).
//
// @see https://keda.sh/docs/2.21/reference/scaledobject-spec/

import type { V1JobSpec } from '@kubernetes/client-node';
import { type Type, type } from 'arktype';

// ============================================================================
// Shared shapes
// ============================================================================

/** Status condition on a `ScaledObject` or `ScaledJob`. */
export interface KedaCondition {
  /** `Ready`, `Active`, `Fallback` or `Paused`. */
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
}

/** Pod toleration for a KEDA component. */
export interface KedaToleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** CPU/memory requests and limits. */
export interface KedaResourceRequirements {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

// ============================================================================
// Triggers
// ============================================================================

/** Reference to a `TriggerAuthentication` (default) or `ClusterTriggerAuthentication`. */
export interface KedaAuthenticationRef {
  name: string;
  /** @default 'TriggerAuthentication' */
  kind?: 'TriggerAuthentication' | 'ClusterTriggerAuthentication';
}

/**
 * Fields every trigger takes. `metricType` decides how the HPA reads the
 * value: `AverageValue` (default) divides it by the replica count, `Value`
 * does not.
 */
export interface KedaTriggerCommon {
  /** Required to reference the trigger from `scalingModifiers.formula`. */
  name?: string;
  authenticationRef?: KedaAuthenticationRef;
  /** @default 'AverageValue' */
  metricType?: 'AverageValue' | 'Value';
  /** Serve the HPA the value from the last poll instead of querying again. */
  useCachedMetrics?: boolean;
}

/** `prometheus` trigger metadata. */
export interface KedaPrometheusMetadata {
  serverAddress: string;
  query: string;
  threshold: string;
  activationThreshold?: string;
  namespace?: string;
  customHeaders?: string;
  ignoreNullValues?: 'true' | 'false';
  queryParameters?: string;
  unsafeSsl?: 'true' | 'false';
  /** `basic`, `bearer`, `tls`, `custom`, `oauth`, comma-separated. Credentials come from `authenticationRef`. */
  authModes?: string;
  timeout?: string;
}

/** `aws-sqs-queue` trigger metadata. */
export interface KedaAwsSqsQueueMetadata {
  queueURL?: string;
  queueURLFromEnv?: string;
  /** Messages one replica handles. @default '5' */
  queueLength?: string;
  activationQueueLength?: string;
  awsRegion: string;
  awsEndpoint?: string;
  scaleOnInFlight?: 'true' | 'false';
  scaleOnDelayed?: 'true' | 'false';
}

/** `aws-cloudwatch` trigger metadata: `namespace`/`metricName`/dimensions, or an `expression`. */
export interface KedaAwsCloudWatchMetadata {
  awsRegion: string;
  awsAccountId?: string;
  awsEndpoint?: string;
  namespace?: string;
  metricName?: string;
  dimensionName?: string;
  dimensionValue?: string;
  expression?: string;
  targetMetricValue: string;
  activationTargetMetricValue?: string;
  minMetricValue?: string;
  ignoreNullValues?: 'true' | 'false';
  metricCollectionTime?: string;
  metricStat?: string;
  metricStatPeriod?: string;
  metricUnit?: string;
  metricEndTimeOffset?: string;
}

/** `cron` trigger metadata. */
export interface KedaCronMetadata {
  /** IANA time zone, e.g. `'Europe/London'`. */
  timezone: string;
  start: string;
  end: string;
  desiredReplicas: string;
}

/** `metrics-api` trigger metadata. */
export interface KedaMetricsApiMetadata {
  url: string;
  valueLocation: string;
  targetValue: string;
  activationTargetValue?: string;
  format?: 'json' | 'xml' | 'yaml' | 'prometheus';
  unsafeSsl?: 'true' | 'false';
  authMode?: string;
  method?: string;
  timeout?: string;
  aggregateFromKubeServiceEndpoints?: 'true' | 'false';
  aggregationType?: 'average' | 'sum' | 'max' | 'min';
}

/** `postgresql` trigger metadata: `connectionFromEnv`, or host fields with a password from auth or env. */
export interface KedaPostgresqlMetadata {
  query: string;
  targetQueryValue: string;
  activationTargetQueryValue?: string;
  connectionFromEnv?: string;
  host?: string;
  port?: string;
  userName?: string;
  dbName?: string;
  sslmode?: string;
  passwordFromEnv?: string;
}

/** `redis` (list length) trigger metadata: `address`, or `host` and `port`. */
export interface KedaRedisMetadata {
  listName: string;
  /** Average list length per replica. @default '5' */
  listLength?: string;
  activationListLength?: string;
  address?: string;
  host?: string;
  port?: string;
  addressFromEnv?: string;
  hostFromEnv?: string;
  portFromEnv?: string;
  databaseIndex?: string;
  enableTLS?: 'true' | 'false';
  unsafeSsl?: 'true' | 'false';
  usernameFromEnv?: string;
  passwordFromEnv?: string;
}

/** Resource triggers (`cpu`, `memory`): the HPA's own resource metrics, which need requests on the pods. */
export interface KedaResourceTrigger
  extends Omit<KedaTriggerCommon, 'metricType' | 'authenticationRef'> {
  type: 'cpu' | 'memory';
  /** `Utilization` is a percentage of the request; `Value` is not allowed. */
  metricType: 'Utilization' | 'AverageValue';
  metadata: { value: string; containerName?: string };
}

/** A typed trigger for one of the common scalers. */
export type KedaTypedTrigger =
  | KedaResourceTrigger
  | (KedaTriggerCommon & { type: 'prometheus'; metadata: KedaPrometheusMetadata })
  | (KedaTriggerCommon & { type: 'aws-sqs-queue'; metadata: KedaAwsSqsQueueMetadata })
  | (KedaTriggerCommon & { type: 'aws-cloudwatch'; metadata: KedaAwsCloudWatchMetadata })
  | (KedaTriggerCommon & { type: 'cron'; metadata: KedaCronMetadata })
  | (KedaTriggerCommon & { type: 'metrics-api'; metadata: KedaMetricsApiMetadata })
  | (KedaTriggerCommon & { type: 'postgresql'; metadata: KedaPostgresqlMetadata })
  | (KedaTriggerCommon & { type: 'redis'; metadata: KedaRedisMetadata });

/** Scaler types with a typed trigger. */
export type KedaTypedTriggerType = KedaTypedTrigger['type'];

declare const kedaCustomTrigger: unique symbol;

/**
 * The scaler name of an untyped trigger. Branded, so a typed scaler's name
 * (`'prometheus'`, ...) never matches the untyped member of `KedaTrigger`.
 */
export type KedaCustomTriggerType = string & { readonly [kedaCustomTrigger]: true };

/** An untyped trigger for any other scaler, built with {@link kedaTrigger}. */
export interface KedaCustomTrigger extends KedaTriggerCommon {
  type: KedaCustomTriggerType;
  metadata: Record<string, string>;
}

/** A ScaledObject or ScaledJob trigger. */
export type KedaTrigger = KedaTypedTrigger | KedaCustomTrigger;

// ============================================================================
// ScaledObject (keda.sh/v1alpha1)
// ============================================================================

/** One HPA scaling rule set (`scaleUp` or `scaleDown`). */
export interface KedaHpaScalingRules {
  stabilizationWindowSeconds?: number;
  selectPolicy?: 'Max' | 'Min' | 'Disabled';
  policies?: Array<{ type: 'Pods' | 'Percent'; value: number; periodSeconds: number }>;
  /** Fractional deviation the HPA ignores. */
  tolerance?: string | number;
}

/** `spec` of a `ScaledObject`. */
export interface ScaledObjectSpec {
  /** The workload to scale. `kind` defaults to Deployment. */
  scaleTargetRef: {
    apiVersion?: string;
    kind?: string;
    name: string;
    envSourceContainerName?: string;
  };
  /** Seconds between trigger polls. @default 30 */
  pollingInterval?: number;
  /** Seconds after the last active trigger before scaling to zero. @default 300 */
  cooldownPeriod?: number;
  /** Seconds after creation before the cooldown can apply. @default 0 */
  initialCooldownPeriod?: number;
  /** Replicas while no trigger is active; must be below `minReplicaCount` (in practice 0). */
  idleReplicaCount?: number;
  /** @default 0 */
  minReplicaCount?: number;
  /** @default 100 */
  maxReplicaCount?: number;
  /** Replicas to hold when a scaler fails `failureThreshold` times in a row. */
  fallback?: {
    failureThreshold: number;
    replicas: number;
    behavior?:
      | 'static'
      | 'currentReplicas'
      | 'currentReplicasIfHigher'
      | 'currentReplicasIfLower'
      | 'scalingModifiers';
  };
  advanced?: {
    /** Return the target to its original replica count when the ScaledObject is deleted. */
    restoreToOriginalReplicaCount?: boolean;
    horizontalPodAutoscalerConfig?: {
      name?: string;
      behavior?: { scaleUp?: KedaHpaScalingRules; scaleDown?: KedaHpaScalingRules };
    };
    /**
     * Combine the triggers into one metric with a `formula` over trigger
     * names, e.g. `'max(inflight, latency * 100)'`.
     */
    scalingModifiers?: {
      formula: string;
      target: string;
      activationTarget?: string;
      /** @default 'AverageValue' */
      metricType?: 'AverageValue' | 'Value';
    };
  };
  triggers: KedaTrigger[];
}

/** Observed status of a `ScaledObject`. */
export interface ScaledObjectStatus {
  conditions?: KedaCondition[];
  /** Name of the HPA KEDA created. */
  hpaName?: string;
  scaleTargetKind?: string;
  originalReplicaCount?: number;
  pausedReplicaCount?: number;
  lastActiveTime?: string;
  externalMetricNames?: string[];
  resourceMetricNames?: string[];
  health?: Record<string, { numberOfFailures?: number; status?: string }>;
  triggersActivity?: Record<string, { isActive?: boolean }>;
}

/** Configuration for {@link scaledObject}. */
export interface ScaledObjectConfig {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec: ScaledObjectSpec;
  /** Resource id for composition references. */
  id?: string;
}

// ============================================================================
// ScaledJob (keda.sh/v1alpha1)
// ============================================================================

/** `spec` of a `ScaledJob`: KEDA creates Jobs from `jobTargetRef` as triggers demand. */
export interface ScaledJobSpec {
  jobTargetRef: V1JobSpec;
  /** @default 30 */
  pollingInterval?: number;
  /** @default 100 */
  successfulJobsHistoryLimit?: number;
  /** @default 100 */
  failedJobsHistoryLimit?: number;
  envSourceContainerName?: string;
  /** @default 0 */
  minReplicaCount?: number;
  /** @default 100 */
  maxReplicaCount?: number;
  rollout?: { strategy?: 'gradual' | 'immediate'; propagationPolicy?: 'foreground' | 'background' };
  scalingStrategy?: {
    strategy?: 'default' | 'custom' | 'accurate' | 'eager';
    customScalingQueueLengthDeduction?: number;
    customScalingRunningJobPercentage?: string;
    pendingPodConditions?: string[];
    multipleScalersCalculation?: 'max' | 'min' | 'avg' | 'sum';
  };
  triggers: KedaTrigger[];
}

/** Observed status of a `ScaledJob`. */
export interface ScaledJobStatus {
  conditions?: KedaCondition[];
  lastActiveTime?: string;
  triggersActivity?: Record<string, { isActive?: boolean }>;
}

/** Configuration for {@link scaledJob}. */
export interface ScaledJobConfig {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec: ScaledJobSpec;
  id?: string;
}

// ============================================================================
// TriggerAuthentication / ClusterTriggerAuthentication (keda.sh/v1alpha1)
// ============================================================================

/**
 * Pod identity for scalers that talk to a cloud API. `aws` uses the KEDA
 * operator's own identity (IRSA or EKS Pod Identity), or assumes `roleArn`;
 * `identityOwner: 'workload'` uses the scaled workload's service account role.
 */
export interface KedaPodIdentity {
  provider: 'aws' | 'azure-workload' | 'gcp' | 'none';
  roleArn?: string;
  /** `aws` only. @default 'keda' */
  identityOwner?: 'keda' | 'workload';
  /** `azure-workload`: client id to use instead of the operator's. */
  identityId?: string;
  identityTenantId?: string;
  identityAuthorityHost?: string;
}

/** `spec` of a `TriggerAuthentication` or `ClusterTriggerAuthentication`. */
export interface TriggerAuthenticationSpec {
  /** Trigger parameters read from Secret keys. A cluster-scoped one reads from the KEDA namespace. */
  secretTargetRef?: Array<{ parameter: string; name: string; key: string }>;
  configMapTargetRef?: Array<{ parameter: string; name: string; key: string }>;
  /** Trigger parameters read from the scale target's container environment. */
  env?: Array<{ parameter: string; name: string; containerName?: string }>;
  podIdentity?: KedaPodIdentity;
  /** Trigger parameters filled with a token for the named ServiceAccount. */
  boundServiceAccountToken?: Array<{ parameter: string; serviceAccountName: string }>;
}

/** Observed status of a trigger authentication: the objects that use it. */
export interface TriggerAuthenticationStatus {
  scaledobjects?: string;
  scaledjobs?: string;
}

/** Configuration for {@link triggerAuthentication} and {@link clusterTriggerAuthentication}. */
export interface TriggerAuthenticationConfig {
  name: string;
  /** Ignored for the cluster-scoped kind. */
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec: TriggerAuthenticationSpec;
  id?: string;
}

// ============================================================================
// Bootstrap composition
// ============================================================================

/** Settings shared by the operator, metrics server and webhooks. */
export interface KedaComponentConfig {
  /** @default 1 */
  replicas?: number;
  /** Merged by Helm over the chart's (see `KEDA_DEFAULT_RESOURCES`). */
  resources?: KedaResourceRequirements;
  /** No PDB is created when unset. */
  podDisruptionBudget?: { minAvailable?: number; maxUnavailable?: number };
  nodeSelector?: Record<string, string>;
  tolerations?: KedaToleration[];
  affinity?: Record<string, unknown>;
  topologySpreadConstraints?: Record<string, unknown>[];
  /** `debug`, `info`, `error`, or a number as a string. @default 'info' */
  logLevel?: string;
}

/** Runtime spec of the `kedaBootstrap` composition. */
export interface KedaBootstrapConfig {
  /** Helm release name. */
  name: string;
  /** Install namespace. @default 'keda' */
  namespace?: string;
  /** kedacore `keda` chart version. @default '2.21.0' */
  version?: string;
  /** Namespaces to watch, comma-separated. All when empty. @default '' */
  watchNamespace?: string;
  /** Log format of all components. @default 'console' */
  logFormat?: 'console' | 'json';
  operator?: KedaComponentConfig & {
    /** Annotations on the operator ServiceAccount, e.g. `eks.amazonaws.com/role-arn` for IRSA. */
    serviceAccountAnnotations?: Record<string, string>;
  };
  metricsServer?: KedaComponentConfig;
  webhooks?: KedaComponentConfig & {
    /** Install the validating admission webhooks. @default true */
    enabled?: boolean;
    /** @default 'Ignore' */
    failurePolicy?: 'Ignore' | 'Fail';
  };
  /** Workload identity of the operator, for scalers using `podIdentity` with `identityOwner: 'keda'`. */
  podIdentity?: {
    /** IRSA: annotates the operator ServiceAccount. Not needed for EKS Pod Identity. */
    awsIrsa?: { enabled?: boolean; roleArn?: string };
    azureWorkload?: { enabled?: boolean; clientId?: string; tenantId?: string };
    /** GKE Workload Identity: the GCP service account email. */
    gcp?: { enabled?: boolean; serviceAccount?: string };
  };
  /** Let cert-manager issue the internal TLS certificates instead of the operator. @default false */
  certManager?: boolean;
  priorityClassName?: string;
}

/** Status of the `kedaBootstrap` composition. */
export interface KedaBootstrapStatus {
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
const componentShape = {
  'replicas?': 'number.integer >= 0',
  'resources?': { 'requests?': resourceList, 'limits?': resourceList },
  'podDisruptionBudget?': {
    'minAvailable?': 'number.integer >= 0',
    'maxUnavailable?': 'number.integer >= 0',
  },
  'nodeSelector?': 'Record<string, string>',
  'tolerations?': type({
    'key?': 'string',
    'operator?': '"Exists" | "Equal"',
    'value?': 'string',
    'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
    'tolerationSeconds?': 'number.integer',
  }).array(),
  'affinity?': 'Record<string, unknown>',
  'topologySpreadConstraints?': type('Record<string, unknown>').array(),
  'logLevel?': 'string > 0',
} as const;

/** ArkType schema for {@link KedaBootstrapConfig}. */
export const KedaBootstrapConfigSchema: Type<KedaBootstrapConfig> = type({
  name: releaseName,
  'namespace?': kubernetesDnsLabel,
  'version?': 'string > 0',
  'watchNamespace?': 'string',
  'logFormat?': '"console" | "json"',
  'operator?': { ...componentShape, 'serviceAccountAnnotations?': 'Record<string, string>' },
  'metricsServer?': componentShape,
  'webhooks?': {
    ...componentShape,
    'enabled?': 'boolean',
    'failurePolicy?': '"Ignore" | "Fail"',
  },
  'podIdentity?': {
    'awsIrsa?': { 'enabled?': 'boolean', 'roleArn?': 'string' },
    'azureWorkload?': { 'enabled?': 'boolean', 'clientId?': 'string', 'tenantId?': 'string' },
    'gcp?': { 'enabled?': 'boolean', 'serviceAccount?': 'string' },
  },
  'certManager?': 'boolean',
  'priorityClassName?': 'string',
});

/** ArkType schema for {@link KedaBootstrapStatus}. */
export const KedaBootstrapStatusSchema: Type<KedaBootstrapStatus> = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  version: 'string',
});

/** Spec of the shared `HelmRepository` singleton. */
export interface KedaHelmRepositorySingletonSpec {
  name: string;
  namespace: string;
  url: string;
}

/** ArkType schema for {@link KedaHelmRepositorySingletonSpec}. */
export const KedaHelmRepositorySingletonSpecSchema: Type<KedaHelmRepositorySingletonSpec> = type({
  name: kubernetesDnsLabel,
  namespace: kubernetesDnsLabel,
  url: 'string > 0',
});

/** ArkType schema for the singleton's status. */
export const KedaHelmRepositorySingletonStatusSchema: Type<{ ready: boolean }> = type({
  ready: 'boolean',
});

/**
 * Build-time options for {@link makeKedaBootstrap}. These decide which
 * resources exist, so they must be concrete.
 */
export interface KedaBootstrapBuildOptions {
  /** Composition name. @default 'keda-bootstrap' */
  readonly name?: string;
  /** KRO kind. @default 'KedaBootstrap' */
  readonly kind?: string;
  /**
   * `'owned'` makes the namespace part of the graph. `'external'` leaves it to
   * Flux (`install.createNamespace`). @default 'external'
   */
  readonly namespaceOwnership?: 'owned' | 'external';
  /**
   * Keep the CRDs, and with them every ScaledObject and ScaledJob, when the
   * release is uninstalled. @default true
   */
  readonly keepCrdsOnUninstall?: boolean;
  /** Raw chart values, deep-merged over the mapped values. Plain objects merge; lists replace. */
  readonly values?: Record<string, unknown>;
}

/** Configuration for the KEDA `HelmRepository`. */
export interface KedaHelmRepositoryConfig {
  /** @default DEFAULT_KEDA_REPOSITORY_NAME */
  name?: string;
  /** @default 'flux-system' */
  namespace?: string;
  /** @default DEFAULT_KEDA_REPOSITORY_URL */
  url?: string;
  /** @default '1h' */
  interval?: string;
  id?: string;
}

/** Configuration for {@link kedaHelmRelease}. */
export interface KedaHelmReleaseConfig {
  /** `HelmRelease` name, also pinned as the Helm release name. */
  name: string;
  /** Namespace of the `HelmRelease` object. @default 'flux-system' */
  namespace?: string;
  /** Install namespace. @default 'keda' */
  targetNamespace?: string;
  /** @default DEFAULT_KEDA_CHART_VERSION */
  version?: string;
  /** @default DEFAULT_KEDA_REPOSITORY_NAME */
  repositoryName?: string;
  /** @default the `HelmRelease` namespace */
  repositoryNamespace?: string;
  /** Let Flux create the install namespace. @default false */
  createNamespace?: boolean;
  values?: Record<string, unknown>;
  id?: string;
}
