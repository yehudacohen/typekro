/**
 * Public Dagster integration contracts.
 *
 * This module defines the TypeKro-facing configuration, status, error, chart value,
 * and factory signatures for deploying Dagster OSS through the official Dagster Helm
 * chart. Implementation files must conform to these contracts.
 *
 * Interface decision: expose typed convenience fields for common Dagster deployment
 * configuration and use `values` as the single raw official chart passthrough surface.
 * The rejected alternatives were a raw-values-only wrapper, which would not provide
 * enough validation for common unsafe configurations, and an exhaustive chart model,
 * which would be brittle as the upstream chart evolves.
 *
 * Scenario preserved from planning: a TypeKro user brings a Dagster project image,
 * configures user-code server args, PostgreSQL, run launcher, ingress, and raw chart
 * `values`, then deploys directly or generates KRO/YAML while status is derived from
 * the owned HelmRelease. All captured planning requirements REQ-001 through REQ-014
 * remain included in this contract; no interface requirement is intentionally deferred
 * or weakened.
 *
 * Lifecycle/CRUD decision: this package does not introduce a separate persisted data
 * entity or database table. Create/read/update/delete lifecycle is inherited from
 * TypeKro resource factories: create/update through deploy/apply, read through status
 * hydration, and delete through `deleteInstance` where supported by the selected mode.
 */

import { type } from 'arktype';
import type { ValuesMergeExpression } from '../../core/aspects/values-merge.js';
import type { TypeKroError } from '../../core/errors.js';
import type {
  Composable,
  DirectResourceFactory,
  Enhanced,
  KroResourceFactory,
  PublicFactoryOptions,
} from '../../core/types/index.js';
import type {
  TypeKroChartValue,
  TypeKroValueTree,
  TypeKroValueTreeObject,
} from '../../core/types/common.js';
import type { HelmRepositorySpec, HelmRepositoryStatus } from '../helm/helm-repository.js';
import type { HelmReleaseSpec, HelmReleaseStatus } from '../helm/types.js';

/** Default official Dagster Helm repository URL. */
export type DagsterDefaultHelmRepositoryUrl = 'https://dagster-io.github.io/helm';

/** Default official Dagster Helm chart name. */
export type DagsterDefaultChartName = 'dagster';

/** Default chart version selected by the approved plan. */
export type DagsterDefaultChartVersion = '1.13.8';

/** Supported Dagster bootstrap phases exposed through TypeKro status. */
export type DagsterBootstrapPhase = 'Ready' | 'Installing' | 'Failed';

/** Supported image pull policies used by Dagster chart image fields. */
export type DagsterImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

/** Supported run launcher names in the Dagster Helm chart. */
export type DagsterRunLauncherType =
  | 'K8sRunLauncher'
  | 'CeleryK8sRunLauncher'
  | 'CustomRunLauncher';

/** Supported scheduler names in the Dagster Helm chart. */
export type DagsterSchedulerType = 'DagsterDaemonScheduler' | 'CustomScheduler';

/** Supported compute log manager names documented by Dagster OSS. */
export type DagsterComputeLogManagerType =
  | 'NoOpComputeLogManager'
  | 'AzureBlobComputeLogManager'
  | 'GCSComputeLogManager'
  | 'S3ComputeLogManager'
  | 'LocalComputeLogManager'
  | 'CustomComputeLogManager';

/** Supported workload identity auth providers in the Dagster chart PostgreSQL config. */
export type DagsterPostgresqlAuthProviderType = 'azure_wif' | 'gcp_wif' | 'aws_wif';

/** Error codes thrown by Dagster validation and values mapping. */
export type DagsterConfigurationErrorCode =
  | 'DAGSTER_INVALID_CONFIG'
  | 'DAGSTER_REQUIRED_CONFIG_MISSING'
  | 'DAGSTER_UNSAFE_SECRET_CONFIG'
  | 'DAGSTER_UNSUPPORTED_KRO_CONFIG';

/** Error codes for Dagster resource factory and lifecycle operations. */
export type DagsterOperationErrorCode =
  | DagsterConfigurationErrorCode
  | 'DAGSTER_RESOURCE_APPLY_FAILED'
  | 'DAGSTER_RESOURCE_DELETE_FAILED'
  | 'DAGSTER_RESOURCE_READ_FAILED'
  | 'DAGSTER_RESOURCE_RECONCILE_FAILED';

/** Dagster components referenced by validation, lifecycle, and operational contracts. */
export type DagsterComponentName =
  | 'helmRepository'
  | 'helmRelease'
  | 'webserver'
  | 'daemon'
  | 'userDeployments'
  | 'postgresql'
  | 'runLauncher'
  | 'scheduler'
  | 'computeLogManager'
  | 'ingress'
  | 'flower'
  | 'rabbitmq'
  | 'redis';

/** Operational event categories emitted by Dagster diagnostics without secret values. */
export type DagsterOperationalEventType =
  | 'helmRepositoryNotReady'
  | 'helmReleaseNotReady'
  | 'configurationValidationFailed'
  | 'databaseConfigurationInvalid'
  | 'brokerConfigurationInvalid'
  | 'userCodeDeploymentInvalid'
  | 'ingressConfigurationInvalid';

/** Health check names exposed by Dagster status and tests. */
export type DagsterHealthCheckName =
  | 'helmRepositoryReady'
  | 'helmReleaseReady'
  | 'webserverReady'
  | 'daemonReady'
  | 'userDeploymentsReady';

/** Metrics signal names exposed by Dagster chart and convenience config. */
export type DagsterMetricSignalName =
  | 'dagsterHelmReleaseReady'
  | 'dagsterWebserverReplicasConfigured'
  | 'dagsterDaemonEnabled'
  | 'dagsterUserDeploymentsConfigured'
  | 'dagsterCeleryWorkersConfigured'
  | 'dagsterFlowerEnabled';

/** Shared ArkType schema shape for Kubernetes resource requirements. */
const resourceRequirementsSchemaShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

/** Shared ArkType schema shape for Kubernetes tolerations. */
const tolerationSchemaShape = {
  'key?': 'string',
  'operator?': '"Exists" | "Equal"',
  'value?': 'string',
  'effect?': '"NoSchedule" | "PreferNoSchedule" | "NoExecute"',
  'tolerationSeconds?': 'number',
} as const;

/** Shared ArkType schema shape for Kubernetes-style environment entries. */
const envVarSchema = type({
  name: 'string',
  'value?': 'string',
  'valueFrom?': 'Record<string, unknown>',
});

/** Shared ArkType schema shape for ConfigMap/Secret env source refs. */
const namedRefSchema = type({ name: 'string' });

/** Shared ArkType schema shape for container image configuration. */
const imageSchemaShape = {
  repository: 'string',
  'tag?': 'string',
  'pullPolicy?': '"Always" | "IfNotPresent" | "Never"',
} as const;

/** Shared ArkType schema shape for values that intentionally pass chart-compatible objects. */
const objectMapSchema = type('object');

/** Shared ArkType schema shape for arrays of chart-compatible objects. */
const objectMapArraySchema = objectMapSchema.array();

const podConfigSchemaShape = {
  'labels?': 'Record<string, string>',
  'nodeSelector?': 'Record<string, string>',
  'affinity?': objectMapSchema,
  'tolerations?': type(tolerationSchemaShape).array(),
  'resources?': resourceRequirementsSchemaShape,
  'podSecurityContext?': objectMapSchema,
  'securityContext?': objectMapSchema,
  'volumes?': objectMapArraySchema,
  'volumeMounts?': objectMapArraySchema,
  'env?': envVarSchema.array(),
  'envConfigMaps?': namedRefSchema.array(),
  'envSecrets?': namedRefSchema.array(),
} as const;

const webserverSchemaShape = {
  ...podConfigSchemaShape,
  'replicaCount?': 'number',
  'image?': imageSchemaShape,
  'service?': {
    'type?': 'string',
    'port?': 'number',
    'annotations?': 'Record<string, string>',
  },
  'pathPrefix?': 'string',
  'enableReadOnly?': 'boolean',
  'logFormat?': '"colored" | "json" | "rich"',
  'logLevel?': 'string',
  'workspace?': {
    'enabled?': 'boolean',
    'servers?': type({ host: 'string', port: 'number', 'name?': 'string' }).array(),
    'externalConfigmap?': 'string',
  },
  'readinessProbe?': objectMapSchema,
  'livenessProbe?': objectMapSchema,
  'startupProbe?': objectMapSchema,
} as const;

const daemonSchemaShape = {
  ...podConfigSchemaShape,
  'enabled?': 'boolean',
  'image?': imageSchemaShape,
  'heartbeatTolerance?': 'number',
  'logFormat?': '"colored" | "json" | "rich"',
  'runCoordinator?': {
    'enabled?': 'boolean',
    'type?': '"QueuedRunCoordinator" | "CustomRunCoordinator"',
    'config?': objectMapSchema,
  },
  'runMonitoring?': objectMapSchema,
  'runRetries?': objectMapSchema,
  'sensors?': objectMapSchema,
  'schedules?': objectMapSchema,
} as const;

const userDeploymentSchema = type({
  name: 'string',
  image: imageSchemaShape,
  'dagsterApiGrpcArgs?': 'string[]',
  'codeServerArgs?': 'string[]',
  'port?': 'number',
  'replicaCount?': 'number',
  'includeConfigInLaunchedRuns?': { 'enabled?': 'boolean' },
  'env?': envVarSchema.array(),
  'envConfigMaps?': namedRefSchema.array(),
  'envSecrets?': namedRefSchema.array(),
  'labels?': 'Record<string, string>',
  'annotations?': 'Record<string, string>',
  'nodeSelector?': 'Record<string, string>',
  'affinity?': objectMapSchema,
  'tolerations?': type(tolerationSchemaShape).array(),
  'podSecurityContext?': objectMapSchema,
  'securityContext?': objectMapSchema,
  'resources?': resourceRequirementsSchemaShape,
  'volumes?': objectMapArraySchema,
  'volumeMounts?': objectMapArraySchema,
  'initContainers?': objectMapArraySchema,
  'sidecarContainers?': objectMapArraySchema,
  'readinessProbe?': objectMapSchema,
  'livenessProbe?': objectMapSchema,
  'startupProbe?': objectMapSchema,
  'deploymentStrategy?': objectMapSchema,
  'service?': { 'annotations?': 'Record<string, string>' },
}).narrow((deployment, ctx) => {
  const hasGrpcArgs = Array.isArray(deployment.dagsterApiGrpcArgs) && deployment.dagsterApiGrpcArgs.length > 0;
  const hasCodeServerArgs = Array.isArray(deployment.codeServerArgs) && deployment.codeServerArgs.length > 0;

  if (hasGrpcArgs !== hasCodeServerArgs) return true;

  return ctx.mustBe('a user deployment with exactly one of dagsterApiGrpcArgs or codeServerArgs');
});

const userDeploymentsSchemaShape = {
  'enabled?': 'boolean',
  'enableSubchart?': 'boolean',
  'imagePullSecrets?': namedRefSchema.array(),
  'deployments?': userDeploymentSchema.array(),
} as const;

const postgresqlSchemaShape = {
  'enabled?': 'boolean',
  'host?': 'string',
  'username?': 'string',
  'database?': 'string',
  'password?': 'string',
  'passwordSecretName?': 'string',
  'servicePort?': 'number',
  'params?': 'Record<string, string>',
  'scheme?': 'string',
  'authProvider?': objectMapSchema,
  'values?': objectMapSchema,
} as const;

const k8sRunLauncherSchemaShape = {
  'imagePullPolicy?': '"Always" | "IfNotPresent" | "Never"',
  'image?': imageSchemaShape,
  'jobNamespace?': 'string',
  'loadInclusterConfig?': 'boolean',
  'kubeconfigFile?': 'string',
  'envConfigMaps?': namedRefSchema.array(),
  'envSecrets?': namedRefSchema.array(),
  'envVars?': 'string[]',
  'volumes?': objectMapArraySchema,
  'volumeMounts?': objectMapArraySchema,
  'labels?': 'Record<string, string>',
  'resources?': resourceRequirementsSchemaShape,
  'runK8sConfig?': objectMapSchema,
  'failPodOnRunFailure?': 'boolean',
  'securityContext?': objectMapSchema,
} as const;

const celeryWorkerQueueSchema = type({
  name: 'string',
  'replicaCount?': 'number',
  'labels?': 'Record<string, string>',
  'nodeSelector?': 'Record<string, string>',
  'configSource?': objectMapSchema,
  'additionalCeleryArgs?': 'string[]',
});

const celeryK8sRunLauncherSchemaShape = {
  ...podConfigSchemaShape,
  'imagePullPolicy?': '"Always" | "IfNotPresent" | "Never"',
  'image?': imageSchemaShape,
  'jobNamespace?': 'string',
  'workerQueues?': celeryWorkerQueueSchema.array(),
  'configSource?': objectMapSchema,
  'env?': 'Record<string, string>',
  'failPodOnRunFailure?': 'boolean',
} as const;

const runLauncherSchemaShape = {
  'type?': '"K8sRunLauncher" | "CeleryK8sRunLauncher" | "CustomRunLauncher"',
  'k8sRunLauncher?': k8sRunLauncherSchemaShape,
  'celeryK8sRunLauncher?': celeryK8sRunLauncherSchemaShape,
  'customRunLauncher?': objectMapSchema,
} as const;

const schedulerSchemaShape = {
  'type?': '"DagsterDaemonScheduler" | "CustomScheduler"',
  'config?': objectMapSchema,
} as const;

const computeLogManagerSchemaShape = {
  'type?':
    '"NoOpComputeLogManager" | "AzureBlobComputeLogManager" | "GCSComputeLogManager" | "S3ComputeLogManager" | "LocalComputeLogManager" | "CustomComputeLogManager"',
  'config?': objectMapSchema,
} as const;

const flowerSchemaShape = {
  ...podConfigSchemaShape,
  'enabled?': 'boolean',
  'image?': imageSchemaShape,
  'service?': {
    'type?': 'string',
    'annotations?': 'Record<string, string>',
    'port?': 'number',
  },
  'livenessProbe?': objectMapSchema,
  'startupProbe?': objectMapSchema,
} as const;

const ingressEndpointSchemaShape = {
  'host?': 'string',
  'path?': 'string',
  'pathType?': 'string',
  'tls?': { 'enabled?': 'boolean', 'secretName?': 'string' },
  'precedingPaths?': objectMapArraySchema,
  'succeedingPaths?': objectMapArraySchema,
} as const;

const ingressSchemaShape = {
  'enabled?': 'boolean',
  'annotations?': 'Record<string, string>',
  'labels?': 'Record<string, string>',
  'ingressClassName?': 'string',
  'dagsterWebserver?': ingressEndpointSchemaShape,
  'readOnlyDagsterWebserver?': ingressEndpointSchemaShape,
  'flower?': ingressEndpointSchemaShape,
} as const;

const rabbitmqSchemaShape = {
  'enabled?': 'boolean',
  'image?': imageSchemaShape,
  'username?': 'string',
  'password?': 'string',
  'servicePort?': 'number',
  'values?': objectMapSchema,
} as const;

const redisSchemaShape = {
  'enabled?': 'boolean',
  'internal?': 'boolean',
  'image?': imageSchemaShape,
  'usePassword?': 'boolean',
  'password?': 'string',
  'host?': 'string',
  'port?': 'number',
  'brokerDbNumber?': 'number',
  'backendDbNumber?': 'number',
  'brokerUrl?': 'string',
  'backendUrl?': 'string',
  'values?': objectMapSchema,
} as const;

const globalSchemaShape = {
  'dagsterHome?': 'string',
  'serviceAccountName?': 'string',
  'postgresqlSecretName?': 'string',
  'postgresqlAuthWifEnabled?': 'boolean',
  'celeryConfigSecretName?': 'string',
  'dagsterInstanceConfigMap?': 'string',
} as const;

/** Official chart `serviceAccount` block — notably `annotations` (e.g. IRSA `eks.amazonaws.com/role-arn`). */
const serviceAccountSchemaShape = {
  'create?': 'boolean',
  'name?': 'string',
  // Record<string,string> (not objectMapSchema/`object`) so the generated CRD field is an object map with
  // string values — `object` serializes to `type: string`, which k8s rejects for an annotations map (422).
  'annotations?': 'Record<string, string>',
} as const;

const helmValuesSchemaShape = {
  ...globalSchemaShape,
  'global?': globalSchemaShape,
  'serviceAccount?': serviceAccountSchemaShape,
  'nameOverride?': 'string',
  'fullnameOverride?': 'string',
  'rbacEnabled?': 'boolean',
  'imagePullSecrets?': namedRefSchema.array(),
  'dagsterWebserver?': webserverSchemaShape,
  'dagsterDaemon?': daemonSchemaShape,
  'dagster-user-deployments?': userDeploymentsSchemaShape,
  'postgresql?': postgresqlSchemaShape,
  'generatePostgresqlPasswordSecret?': 'boolean',
  'generateCeleryConfigSecret?': 'boolean',
  'rabbitmq?': rabbitmqSchemaShape,
  'redis?': redisSchemaShape,
  'runLauncher?': runLauncherSchemaShape,
  'scheduler?': schedulerSchemaShape,
  'computeLogManager?': computeLogManagerSchemaShape,
  'flower?': flowerSchemaShape,
  'ingress?': ingressSchemaShape,
  'pythonLogs?': objectMapSchema,
  'busybox?': objectMapSchema,
  'extraManifests?': 'unknown[]',
} as const;

/** Kubernetes Secret key reference used for Dagster sensitive chart values. */
export interface DagsterSecretKeyRef {
  /** Name of an existing Kubernetes Secret in the Dagster deployment namespace. */
  name: string;
  /** Key inside the Kubernetes Secret. */
  key: string;
}

/** Existing Secret reference source for sensitive values. */
export interface DagsterSecretKeyRefSource {
  /** Existing Kubernetes Secret key reference. */
  secretRef: DagsterSecretKeyRef;
}

/** Explicit literal source intentionally supplied by the caller. */
export interface DagsterLiteralValueSource {
  /** Literal value. Treat as sensitive when used for credentials or tokens. */
  value: string;
}

/** Explicit source for Dagster sensitive or configurable scalar values. */
export type DagsterValueSource = DagsterSecretKeyRefSource | DagsterLiteralValueSource;

/** Kubernetes resource requests and limits used by chart pod settings. */
export interface DagsterResourceRequirements {
  /** Requested resources. */
  requests?: {
    /** CPU request such as `500m`. */
    cpu?: string;
    /** Memory request such as `1Gi`. */
    memory?: string;
  };
  /** Resource limits. */
  limits?: {
    /** CPU limit such as `2`. */
    cpu?: string;
    /** Memory limit such as `4Gi`. */
    memory?: string;
  };
}

/** Kubernetes toleration shape accepted by Dagster chart pod settings. */
export interface DagsterToleration {
  key?: string;
  operator?: 'Exists' | 'Equal';
  value?: string;
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
  tolerationSeconds?: number;
}

/** Kubernetes-style environment variable entry used by Dagster chart settings. */
export interface DagsterEnvVar {
  /** Environment variable name. */
  name: string;
  /** Literal value. */
  value?: string;
  /** Kubernetes valueFrom source. This remains free-form to match Kubernetes API shape. */
  valueFrom?: TypeKroValueTreeObject;
}

/** Reference to an existing ConfigMap or Secret by name. */
export interface DagsterNamedRef extends TypeKroValueTreeObject {
  name: string;
}

/** Container image settings used by Dagster system and user-code containers. */
export interface DagsterImageConfig {
  /** Image repository, for example `docker.io/acme/my-dagster-project`. */
  repository: string;
  /** Image tag. If omitted in chart-managed images, the chart may default to chart version. */
  tag?: string;
  /** Kubernetes image pull policy. */
  pullPolicy?: DagsterImagePullPolicy;
}

/** Shared pod customization subset used across Dagster chart components. */
export interface DagsterPodConfig {
  /** Additional pod labels. */
  labels?: Record<string, string>;
  /** Node selector for pod scheduling. */
  nodeSelector?: Record<string, string>;
  /** Kubernetes affinity. Free-form because Kubernetes affinity is deeply structured. */
  affinity?: TypeKroValueTreeObject;
  /** Kubernetes tolerations. */
  tolerations?: DagsterToleration[];
  /** Pod resource requests and limits. */
  resources?: DagsterResourceRequirements;
  /** Kubernetes pod security context. */
  podSecurityContext?: TypeKroValueTreeObject;
  /** Kubernetes container security context. */
  securityContext?: TypeKroValueTreeObject;
  /** Additional volumes. Free-form to preserve upstream chart compatibility. */
  volumes?: TypeKroValueTreeObject[];
  /** Additional volume mounts. Free-form to preserve upstream chart compatibility. */
  volumeMounts?: TypeKroValueTreeObject[];
  /** Additional environment variables. */
  env?: DagsterEnvVar[];
  /** Existing ConfigMaps to expose as environment variables. */
  envConfigMaps?: DagsterNamedRef[];
  /** Existing Secrets to expose as environment variables. */
  envSecrets?: DagsterNamedRef[];
}

/** Global chart convenience config mapped to `.Values.global` and related top-level fields. */
export interface DagsterGlobalConfig {
  /** DAGSTER_HOME path used by chart-managed containers. */
  dagsterHome?: string;
  /** Shared service account for this chart and subcharts. */
  serviceAccountName?: string;
  /** Existing PostgreSQL password Secret name. */
  postgresqlSecretName?: string;
  /** Enables PostgreSQL workload identity federation instead of password Secret auth. */
  postgresqlAuthWifEnabled?: boolean;
  /** Existing Celery config Secret name for broker/backend URLs. */
  celeryConfigSecretName?: string;
  /** Existing ConfigMap containing Dagster instance configuration. */
  dagsterInstanceConfigMap?: string;
}

/** Dagster webserver convenience config. */
export interface DagsterWebserverConfig extends DagsterPodConfig {
  /** Number of webserver replicas. */
  replicaCount?: number;
  /** Webserver image override. */
  image?: DagsterImageConfig;
  /** Service settings for the webserver. */
  service?: {
    type?: string;
    port?: number;
    annotations?: Record<string, string>;
  };
  /** Optional URL path prefix, such as `/dagster`. */
  pathPrefix?: string;
  /** Deploy an additional read-only webserver. */
  enableReadOnly?: boolean;
  /** Webserver log format. */
  logFormat?: 'colored' | 'json' | 'rich';
  /** Uvicorn log level. */
  logLevel?: string;
  /** Workspace config for separately managed user-code deployments. */
  workspace?: {
    enabled?: boolean;
    servers?: Array<{ host: string; port: number; name?: string }>;
    externalConfigmap?: string;
  };
  /** Startup/readiness/liveness probe overrides. */
  readinessProbe?: TypeKroValueTreeObject;
  livenessProbe?: TypeKroValueTreeObject;
  startupProbe?: TypeKroValueTreeObject;
}

/** Dagster daemon convenience config. */
export interface DagsterDaemonConfig extends DagsterPodConfig {
  /** Whether the daemon should be included. */
  enabled?: boolean;
  /** Daemon image override. */
  image?: DagsterImageConfig;
  /** Maximum heartbeat tolerance in seconds. */
  heartbeatTolerance?: number;
  /** Daemon log format. */
  logFormat?: 'colored' | 'json' | 'rich';
  /** Run coordinator convenience config. */
  runCoordinator?: {
    enabled?: boolean;
    type?: 'QueuedRunCoordinator' | 'CustomRunCoordinator';
    config?: TypeKroValueTreeObject;
  };
  /** Run monitoring convenience config. */
  runMonitoring?: TypeKroValueTreeObject;
  /** Run retries convenience config. */
  runRetries?: TypeKroValueTreeObject;
  /** Sensor evaluation convenience config. */
  sensors?: TypeKroValueTreeObject;
  /** Schedule evaluation convenience config. */
  schedules?: TypeKroValueTreeObject;
}

/** One Dagster user-code deployment served through gRPC or code-server. */
export interface DagsterUserDeployment {
  /** Unique deployment name in the chart. */
  name: string;
  /** User-code image containing the Dagster project. */
  image: DagsterImageConfig;
  /** Arguments to `dagster api grpc`. Mutually exclusive with `codeServerArgs`. */
  dagsterApiGrpcArgs?: string[];
  /** Arguments to `dagster code-server start`. Mutually exclusive with `dagsterApiGrpcArgs`. */
  codeServerArgs?: string[];
  /** gRPC/code-server port. */
  port?: number;
  /** Number of user-code deployment replicas. */
  replicaCount?: number;
  /** Whether to include this deployment config in launched runs. */
  includeConfigInLaunchedRuns?: { enabled?: boolean };
  /** Additional env vars, env source refs, pod settings, and resources. */
  env?: DagsterEnvVar[];
  envConfigMaps?: DagsterNamedRef[];
  envSecrets?: DagsterNamedRef[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  nodeSelector?: Record<string, string>;
  affinity?: TypeKroValueTreeObject;
  tolerations?: DagsterToleration[];
  podSecurityContext?: TypeKroValueTreeObject;
  securityContext?: TypeKroValueTreeObject;
  resources?: DagsterResourceRequirements;
  volumes?: TypeKroValueTreeObject[];
  volumeMounts?: TypeKroValueTreeObject[];
  initContainers?: TypeKroValueTreeObject[];
  sidecarContainers?: TypeKroValueTreeObject[];
  readinessProbe?: TypeKroValueTreeObject;
  livenessProbe?: TypeKroValueTreeObject;
  startupProbe?: TypeKroValueTreeObject;
  deploymentStrategy?: TypeKroValueTreeObject;
  service?: { annotations?: Record<string, string> };
}

/** Dagster user-code deployment chart section. */
export interface DagsterUserDeploymentsConfig {
  /** Creates workspace entries for user-code gRPC/code-server deployments. */
  enabled?: boolean;
  /** Controls whether the official subchart creates user-code resources. */
  enableSubchart?: boolean;
  /** Image pull Secrets for user-code containers. */
  imagePullSecrets?: DagsterNamedRef[];
  /** User-code deployments managed by the Dagster chart. */
  deployments?: DagsterUserDeployment[];
}

/** PostgreSQL auth provider settings for workload identity federation. */
export interface DagsterPostgresqlAuthProviderConfig {
  /** Provider type. */
  type?: DagsterPostgresqlAuthProviderType;
  /** Azure token scope override. */
  azureScope?: string;
  /** AWS RDS region. */
  awsRegion?: string;
}

/** Bundled or external PostgreSQL chart config. */
export interface DagsterPostgresqlConfig {
  /** Deploy bundled PostgreSQL or configure the chart for an external DB. */
  enabled?: boolean;
  /** External PostgreSQL host when bundled PostgreSQL is disabled. */
  host?: string;
  /** PostgreSQL username. */
  username?: string;
  /** PostgreSQL database name. */
  database?: string;
  /** Explicit local/dev password. Prefer `passwordSecretName` for production. */
  password?: string;
  /** Existing Secret name for the PostgreSQL password. */
  passwordSecretName?: string;
  /** PostgreSQL service port. */
  servicePort?: number;
  /** Additional PostgreSQL connection parameters. */
  params?: Record<string, string>;
  /** PostgreSQL URI scheme override. */
  scheme?: string;
  /** Workload identity auth provider settings. */
  authProvider?: DagsterPostgresqlAuthProviderConfig;
  /** Raw official postgresql subchart values merged before top-level `values`. */
  values?: TypeKroChartValue<TypeKroValueTreeObject>;
}

/** K8sRunLauncher convenience config. */
export interface DagsterK8sRunLauncherConfig {
  imagePullPolicy?: DagsterImagePullPolicy;
  image?: DagsterImageConfig;
  jobNamespace?: string;
  loadInclusterConfig?: boolean;
  kubeconfigFile?: string;
  envConfigMaps?: DagsterNamedRef[];
  envSecrets?: DagsterNamedRef[];
  envVars?: string[];
  volumes?: TypeKroValueTreeObject[];
  volumeMounts?: TypeKroValueTreeObject[];
  labels?: Record<string, string>;
  resources?: DagsterResourceRequirements;
  runK8sConfig?: TypeKroValueTreeObject;
  failPodOnRunFailure?: boolean;
  securityContext?: TypeKroValueTreeObject;
}

/** Celery worker queue config for CeleryK8sRunLauncher. */
export interface DagsterCeleryWorkerQueueConfig {
  name: string;
  replicaCount?: number;
  labels?: Record<string, string>;
  nodeSelector?: Record<string, string>;
  configSource?: TypeKroValueTreeObject;
  additionalCeleryArgs?: string[];
}

/** CeleryK8sRunLauncher convenience config. */
export interface DagsterCeleryK8sRunLauncherConfig extends Omit<DagsterPodConfig, 'env'> {
  imagePullPolicy?: DagsterImagePullPolicy;
  image?: DagsterImageConfig;
  jobNamespace?: string;
  workerQueues?: DagsterCeleryWorkerQueueConfig[];
  configSource?: TypeKroValueTreeObject;
  env?: Record<string, string>;
  failPodOnRunFailure?: boolean;
}

/** Dagster run launcher chart config. */
export interface DagsterRunLauncherConfig {
  type?: DagsterRunLauncherType;
  k8sRunLauncher?: DagsterK8sRunLauncherConfig;
  celeryK8sRunLauncher?: DagsterCeleryK8sRunLauncherConfig;
  customRunLauncher?: TypeKroValueTreeObject;
}

/** Dagster scheduler chart config. */
export interface DagsterSchedulerConfig {
  type?: DagsterSchedulerType;
  config?: TypeKroValueTreeObject;
}

/** Dagster compute log manager chart config. */
export interface DagsterComputeLogManagerConfig {
  type?: DagsterComputeLogManagerType;
  config?: TypeKroValueTreeObject;
}

/** RabbitMQ chart config for Celery mode. */
export interface DagsterRabbitmqConfig {
  enabled?: boolean;
  image?: DagsterImageConfig;
  username?: string;
  password?: string;
  servicePort?: number;
  values?: TypeKroChartValue<TypeKroValueTreeObject>;
}

/** Redis chart or external Redis config for Celery mode. */
export interface DagsterRedisConfig {
  enabled?: boolean;
  internal?: boolean;
  image?: DagsterImageConfig;
  usePassword?: boolean;
  password?: string;
  host?: string;
  port?: number;
  brokerDbNumber?: number;
  backendDbNumber?: number;
  brokerUrl?: string;
  backendUrl?: string;
  values?: TypeKroChartValue<TypeKroValueTreeObject>;
}

/** Flower diagnostics UI config. */
export interface DagsterFlowerConfig extends DagsterPodConfig {
  enabled?: boolean;
  image?: DagsterImageConfig;
  service?: {
    type?: string;
    annotations?: Record<string, string>;
    port?: number;
  };
  livenessProbe?: TypeKroValueTreeObject;
  startupProbe?: TypeKroValueTreeObject;
}

/** Ingress route config for a Dagster chart endpoint. */
export interface DagsterIngressEndpointConfig {
  host?: string;
  path?: string;
  pathType?: string;
  tls?: {
    enabled?: boolean;
    secretName?: string;
  };
  precedingPaths?: TypeKroValueTreeObject[];
  succeedingPaths?: TypeKroValueTreeObject[];
}

/** Dagster chart ingress config. */
export interface DagsterIngressConfig {
  enabled?: boolean;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  ingressClassName?: string;
  dagsterWebserver?: DagsterIngressEndpointConfig;
  readOnlyDagsterWebserver?: DagsterIngressEndpointConfig;
  flower?: DagsterIngressEndpointConfig;
}

/** Official Dagster chart values modeled as typed common fields plus free-form compatibility. */
export interface DagsterHelmValues extends TypeKroValueTreeObject {
  global?: TypeKroValueTreeObject;
  nameOverride?: string;
  fullnameOverride?: string;
  rbacEnabled?: boolean;
  imagePullSecrets?: DagsterNamedRef[];
  dagsterWebserver?: TypeKroValueTreeObject;
  dagsterDaemon?: TypeKroValueTreeObject;
  'dagster-user-deployments'?: TypeKroValueTreeObject;
  postgresql?: TypeKroValueTreeObject;
  generatePostgresqlPasswordSecret?: boolean;
  generateCeleryConfigSecret?: boolean;
  rabbitmq?: TypeKroValueTreeObject;
  redis?: TypeKroValueTreeObject;
  runLauncher?: TypeKroValueTreeObject;
  scheduler?: TypeKroValueTreeObject;
  computeLogManager?: TypeKroValueTreeObject;
  pythonLogs?: TypeKroValueTreeObject;
  flower?: TypeKroValueTreeObject;
  ingress?: TypeKroValueTreeObject;
  busybox?: TypeKroValueTreeObject;
  extraManifests?: TypeKroValueTree[];
}

/** Mapper output: concrete chart values or a graph-aware runtime values merge expression. */
export type DagsterMappedHelmValues = DagsterHelmValues | ValuesMergeExpression;

/** ArkType schema for Dagster bootstrap configuration. */
export const DagsterBootstrapConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'serviceAccountName?': 'string',
  'nameOverride?': 'string',
  'fullnameOverride?': 'string',
  'rbacEnabled?': 'boolean',
  'imagePullSecrets?': namedRefSchema.array(),
  'webserver?': webserverSchemaShape,
  'daemon?': daemonSchemaShape,
  'userDeployments?': userDeploymentsSchemaShape,
  'postgresql?': postgresqlSchemaShape,
  'runLauncher?': runLauncherSchemaShape,
  'scheduler?': schedulerSchemaShape,
  'computeLogManager?': computeLogManagerSchemaShape,
  'ingress?': ingressSchemaShape,
  'flower?': flowerSchemaShape,
  'rabbitmq?': rabbitmqSchemaShape,
  'redis?': redisSchemaShape,
  'global?': globalSchemaShape,
  'values?': helmValuesSchemaShape,
});

/** Configuration for deploying Dagster through the bootstrap composition. */
export type DagsterBootstrapConfig = Omit<
  typeof DagsterBootstrapConfigSchema.infer,
  | 'webserver'
  | 'daemon'
  | 'userDeployments'
  | 'postgresql'
  | 'runLauncher'
  | 'scheduler'
  | 'computeLogManager'
  | 'ingress'
  | 'flower'
  | 'rabbitmq'
  | 'redis'
  | 'global'
  | 'values'
> & {
  nameOverride?: string;
  fullnameOverride?: string;
  rbacEnabled?: boolean;
  imagePullSecrets?: DagsterNamedRef[];
  webserver?: DagsterWebserverConfig;
  daemon?: DagsterDaemonConfig;
  userDeployments?: DagsterUserDeploymentsConfig;
  postgresql?: DagsterPostgresqlConfig;
  runLauncher?: DagsterRunLauncherConfig;
  scheduler?: DagsterSchedulerConfig;
  computeLogManager?: DagsterComputeLogManagerConfig;
  ingress?: DagsterIngressConfig;
  flower?: DagsterFlowerConfig;
  rabbitmq?: DagsterRabbitmqConfig;
  redis?: DagsterRedisConfig;
  global?: DagsterGlobalConfig;
  values?: TypeKroChartValue<DagsterHelmValues>;
};

/** Component readiness exposed by `DagsterBootstrapStatus`. */
export interface DagsterBootstrapComponentStatus {
  /** Whether the Flux HelmRepository is ready. */
  helmRepository: boolean;
  /** Whether the Flux HelmRelease is ready. */
  helmRelease: boolean;
  /** Whether the HelmRelease that owns webserver resources is ready. */
  webserver: boolean;
  /** Whether the HelmRelease that owns daemon resources is ready. */
  daemon: boolean;
  /** Whether the HelmRelease that owns user-code resources is ready. */
  userDeployments: boolean;
}

/** Observed Dagster bootstrap status derived from owned Helm resources. */
export interface DagsterBootstrapStatus {
  /** Overall readiness from the owned HelmRelease Ready condition. */
  ready: boolean;
  /** Coarse deployment phase from the owned HelmRelease Ready condition. */
  phase: DagsterBootstrapPhase;
  /** Whether the owned HelmRelease Ready condition is explicitly False. */
  failed: boolean;
  /** Configured chart version. */
  version?: string;
  /** Component booleans derived from HelmRepository/HelmRelease readiness and config inclusion. */
  components: DagsterBootstrapComponentStatus;
}

/** ArkType schema for Dagster bootstrap status. */
export const DagsterBootstrapStatusSchema = type({
  ready: 'boolean',
  phase: '"Ready" | "Installing" | "Failed"',
  failed: 'boolean',
  'version?': 'string',
  components: {
    helmRepository: 'boolean',
    helmRelease: 'boolean',
    webserver: 'boolean',
    daemon: 'boolean',
    userDeployments: 'boolean',
  },
});

/** ArkType schema for the Dagster Helm chart repository wrapper. */
export const DagsterHelmRepositoryConfigSchema = type({
  'name?': 'string',
  'namespace?': 'string',
  'url?': 'string',
  'interval?': 'string',
  'id?': 'string',
});

/** Configuration for the Dagster HelmRepository wrapper. */
export type DagsterHelmRepositoryConfig = typeof DagsterHelmRepositoryConfigSchema.infer;

/**
 * Spec for the shared Dagster HelmRepository singleton composition. The official
 * Dagster chart repository is one cluster-level Flux source shared by every
 * Dagster instance, so it is deployed once via `singleton(...)`. These three
 * fields form the singleton's identity — all consumers must agree on them.
 */
export const DagsterHelmRepositorySingletonSpecSchema = type({
  name: 'string',
  namespace: 'string',
  url: 'string',
});

/** Status surfaced by the shared Dagster HelmRepository singleton. */
export const DagsterHelmRepositorySingletonStatusSchema = type({
  ready: 'boolean',
});

/** ArkType schema for the Dagster Helm chart release wrapper. */
export const DagsterHelmReleaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'values?': helmValuesSchemaShape,
  'id?': 'string',
});

/** Configuration for the Dagster HelmRelease wrapper. */
export type DagsterHelmReleaseConfig = Omit<
  typeof DagsterHelmReleaseConfigSchema.infer,
  'values'
> & {
  /** Graph-aware official Dagster chart values serialized recursively by TypeKro. */
  values?: TypeKroChartValue<DagsterHelmValues>;
};

/** One structured configuration issue produced by Dagster validation. */
export interface DagsterConfigurationIssue {
  /** Stable machine-readable error code. */
  code: DagsterConfigurationErrorCode;
  /** Dot path to the invalid config field. */
  path: string;
  /** Human-readable message that does not include secret values. */
  message: string;
  /** Optional high-level component associated with the issue. */
  component?: DagsterComponentName;
}

/** Validation result for Dagster typed config. */
export interface DagsterConfigValidationResult {
  /** True when no blocking validation issues were found. */
  valid: boolean;
  /** Structured issues; messages must not include secret values. */
  issues: DagsterConfigurationIssue[];
}

/** Structured context carried by Dagster TypeKro configuration errors. */
export interface DagsterConfigurationErrorContext extends Record<string, unknown> {
  /** Optional instance/config name associated with validation. */
  name?: string;
  /** All validation issues that caused the failure. */
  issues: DagsterConfigurationIssue[];
}

/** Structured configuration error thrown by Dagster mapper/factory validation. */
export interface DagsterConfigurationError extends TypeKroError {
  readonly name: 'DagsterConfigurationError';
  readonly code: DagsterConfigurationErrorCode;
  readonly context: DagsterConfigurationErrorContext;
}

/** Structured safe error returned by explicit Dagster lifecycle operation contracts. */
export interface DagsterOperationError {
  /** Stable machine-readable operation error code. */
  code: DagsterOperationErrorCode;
  /** Safe diagnostic message that excludes passwords, tokens, URLs with credentials, and DSNs. */
  message: string;
  /** Affected Dagster component, when applicable. */
  component?: DagsterComponentName;
  /** Kubernetes resource name, when applicable. */
  resourceName?: string;
  /** Kubernetes namespace, when applicable. */
  namespace?: string;
  /** Config or status path that produced the error, when known. */
  path?: string;
}

/** Successful explicit Dagster operation result. */
export interface DagsterOperationSuccess<T> {
  ok: true;
  value: T;
}

/** Failed explicit Dagster operation result with structured safe error details. */
export interface DagsterOperationFailure {
  ok: false;
  error: DagsterOperationError;
}

/** Result type used by explicit Dagster lifecycle operation contracts. */
export type DagsterOperationResult<T> = DagsterOperationSuccess<T> | DagsterOperationFailure;

/** Public resource factory signature with an explicit typed error boundary. */
export type DagsterResourceFactorySignature<TConfig, TSpec, TStatus> = {
  (config: Composable<TConfig>): Enhanced<TSpec, TStatus>;
  /** Structured errors thrown or surfaced by this factory use this shape. */
  readonly errorType?: DagsterOperationError;
};

/** Public utility signature with an explicit typed error boundary. */
export type DagsterUtilitySignature<
  TInput,
  TOutput,
  TError extends TypeKroError | DagsterOperationError,
> = {
  (input: TInput): TOutput;
  /** Structured errors thrown or surfaced by this utility use this shape. */
  readonly errorType?: TError;
};

/** Direct resource factory with explicit Dagster operation error shape. */
export type DagsterDirectFactoryWithErrors<TSpec extends object, TStatus extends object> =
  DirectResourceFactory<TSpec, TStatus> & {
    readonly errorType?: DagsterOperationError;
  };

/** KRO resource factory with explicit Dagster operation error shape. */
export type DagsterKroFactoryWithErrors<TSpec extends object, TStatus extends object> =
  KroResourceFactory<TSpec, TStatus> & {
    readonly errorType?: DagsterOperationError;
  };

/** Public Dagster factory and composition error boundary map. */
export interface DagsterFactoryErrorBoundary {
  dagsterHelmRepository: DagsterOperationError;
  dagsterHelmRelease: DagsterOperationError;
  dagsterBootstrap: DagsterOperationError;
  helmValuesMapper: DagsterOperationError;
  configValidator: DagsterOperationError;
}

/** Public values mapper contract. */
export type DagsterHelmValuesMapper = DagsterUtilitySignature<
  DagsterBootstrapConfig,
  DagsterMappedHelmValues,
  DagsterConfigurationError
>;

/** Public validation contract for typed Dagster config. */
export type DagsterConfigValidator = DagsterUtilitySignature<
  DagsterBootstrapConfig,
  DagsterConfigValidationResult,
  DagsterConfigurationError
>;

/** Dagster HelmRepository factory signature. */
export type DagsterHelmRepositoryFactory = DagsterResourceFactorySignature<
  DagsterHelmRepositoryConfig,
  HelmRepositorySpec,
  HelmRepositoryStatus
>;

/** Dagster HelmRelease factory signature. */
export type DagsterHelmReleaseFactory = DagsterResourceFactorySignature<
  DagsterHelmReleaseConfig,
  HelmReleaseSpec<DagsterHelmValues>,
  HelmReleaseStatus
>;

/** Direct-mode Dagster bootstrap factory inherited from TypeKro compositions. */
export type DagsterBootstrapDirectFactory = DagsterDirectFactoryWithErrors<
  DagsterBootstrapConfig,
  DagsterBootstrapStatus
>;

/** KRO-mode Dagster bootstrap factory inherited from TypeKro compositions. */
export type DagsterBootstrapKroFactory = DagsterKroFactoryWithErrors<
  DagsterBootstrapConfig,
  DagsterBootstrapStatus
>;

/** Public selector for creating Dagster direct or KRO factories. */
export type DagsterBootstrapFactorySelector = {
  /** Create a direct-mode factory for deploy/apply/read/delete lifecycle operations. */
  (mode: 'direct', options?: PublicFactoryOptions): DagsterBootstrapDirectFactory;
  /** Create a KRO-mode factory for ResourceGraphDefinition-backed lifecycle operations. */
  (mode: 'kro', options?: PublicFactoryOptions): DagsterBootstrapKroFactory;
  /** Structured errors thrown or surfaced by factory creation use this shape. */
  readonly errorType?: DagsterOperationError;
};

/** Public YAML generation operation for the Dagster bootstrap composition. */
export type DagsterBootstrapYamlOperation = {
  /** Generate ResourceGraphDefinition YAML or direct manifest YAML for the supplied spec. */
  (spec?: DagsterBootstrapConfig): string;
  /** Structured errors thrown or surfaced by YAML generation use this shape. */
  readonly errorType?: DagsterOperationError;
};

/** Public `dagsterBootstrap` composition contract. */
export interface DagsterBootstrapComposition {
  /** Create a direct-mode or KRO-mode factory. */
  factory: DagsterBootstrapFactorySelector;
  /** Generate ResourceGraphDefinition YAML or direct manifest YAML for the supplied spec. */
  toYaml: DagsterBootstrapYamlOperation;
  /** Structured errors thrown or surfaced by the composition use this shape. */
  readonly errorType?: DagsterOperationError;
}

/** Create/update operation for Dagster bootstrap instances, inherited from TypeKro. */
export type DagsterBootstrapCreateOrUpdateOperation = DagsterBootstrapDirectFactory['deploy'];

/** Read/list operation for Dagster bootstrap instances, inherited from TypeKro. */
export type DagsterBootstrapReadOperation = DagsterBootstrapDirectFactory['getInstances'];

/** Delete operation for Dagster bootstrap instances, inherited from TypeKro. */
export type DagsterBootstrapDeleteOperation = DagsterBootstrapDirectFactory['deleteInstance'];

/** Declarative create/update operation for the Dagster HelmRepository wrapper. */
export type DagsterHelmRepositoryCreateOrUpdateOperation = DagsterHelmRepositoryFactory;

/** Declarative create/update operation for the Dagster HelmRelease wrapper. */
export type DagsterHelmReleaseCreateOrUpdateOperation = DagsterHelmReleaseFactory;

/** Read operation contract for the Dagster HelmRelease status shape. */
export type DagsterHelmReleaseReadOperation = (
  name: string,
  namespace?: string
) => DagsterOperationResult<HelmReleaseStatus>;

/** Delete operation contract for the Dagster HelmRelease resource. */
export type DagsterHelmReleaseDeleteOperation = (
  name: string,
  namespace?: string
) => DagsterOperationResult<void>;

/** Health check contract used by tests and operational diagnostics. */
export interface DagsterHealthCheckStatus {
  /** Machine-readable health check name. */
  name: DagsterHealthCheckName;
  /** Affected Dagster component. */
  component: DagsterComponentName;
  /** Whether this check is healthy. */
  healthy: boolean;
  /** Safe diagnostic message that excludes secret values. */
  message?: string;
  /** Kubernetes resource name, when applicable. */
  resourceName?: string;
  /** Kubernetes namespace, when applicable. */
  namespace?: string;
}

/** Metrics configuration signal emitted by values mapping and operational diagnostics. */
export interface DagsterMetricSignal {
  /** Machine-readable metric/configuration signal name. */
  name: DagsterMetricSignalName;
  /** Affected Dagster component. */
  component: DagsterComponentName;
  /** Whether the metric-producing feature is enabled or configured. */
  enabled: boolean;
  /** Optional safe metric endpoint or signal target. */
  endpoint?: string;
  /** Optional non-sensitive labels associated with this signal. */
  labels?: Record<string, string>;
}

/** Safe structured log event contract; secrets, DSNs, and credential URLs are excluded. */
export interface DagsterOperationalLogEvent {
  /** Machine-readable operational event type. */
  type: DagsterOperationalEventType;
  /** Affected Dagster component. */
  component: DagsterComponentName;
  /** Kubernetes resource name, when applicable. */
  resourceName?: string;
  /** Kubernetes namespace, when applicable. */
  namespace?: string;
  /** Safe diagnostic message that excludes passwords, tokens, URLs with credentials, and DSNs. */
  message: string;
}

/** Contract for graph-aware values merge behavior used by `mapDagsterConfigToHelmValues`. */
export interface DagsterValuesMergeContract {
  /** Typed convenience values are generated first. */
  typedValuesFirst: true;
  /** User-supplied raw official chart values merge last and win conflicts. */
  rawValuesMergeLast: true;
  /** Plain objects merge recursively. */
  deepMergeObjects: true;
  /** Arrays replace earlier arrays rather than concatenate. */
  arraysReplace: true;
  /** Primitive raw values override typed values. */
  primitivesOverride: true;
  /** Kubernetes refs, CEL expressions, and values-merge expressions are preserved. */
  graphAwareValuesPreserved: true;
}
