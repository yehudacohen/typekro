/**
 * Shared Ory Helm chart value contracts for Ory k8s chart version 0.62.0.
 *
 * Subproduct source-of-truth chart contracts live in `hydra.ts`, `kratos.ts`,
 * `keto.ts`, `oathkeeper.ts`, `hydra-maester.ts`, and `oathkeeper-maester.ts`.
 * This module owns shared YAML/Kubernetes helper shapes and re-exports the
 * subproduct contracts as an umbrella compatibility surface.
 */

/** Primitive YAML scalar accepted by Helm values. */
export type OryYamlScalar = string | number | boolean | null;

/** Arbitrary YAML node for upstream app config and Kubernetes extension points. */
export type OryYamlValue = OryYamlScalar | OryYamlValue[] | { [key: string]: OryYamlValue };

/** Upstream Kubernetes object maps intentionally accept user-defined keys. */
export type OryObjectMap = Record<string, unknown>;

/** Kubernetes labels or annotations. */
export type OryStringMap = Record<string, string>;

/** Kubernetes container image pull policy. */
export type OryImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

/** Kubernetes service type values used by the Ory charts. */
export type OryServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';

/** Kubernetes path type values used by ingress rules. */
export type OryIngressPathType = 'Exact' | 'Prefix' | 'ImplementationSpecific';

/** Ory chart automigration execution modes. */
export type OryAutomigrationType = 'job' | 'initContainer';

/** Oathkeeper Maester integration modes used by Ory global values. */
export type OryOathkeeperMaesterMode = 'controller' | 'sidecar';

/** Ory subproduct schema modules re-exported by this umbrella chart-values contract. */
export type OryChartValuesSubproductModule =
  | 'hydra'
  | 'kratos'
  | 'keto'
  | 'oathkeeper'
  | 'hydra-maester'
  | 'oathkeeper-maester';

/** Shared pod metadata chart values. */
export interface OryPodMetadataValues {
  labels?: OryStringMap;
  annotations?: OryStringMap;
}

/** Shared image chart values. */
export interface OryImageValues {
  registry?: string;
  repository?: string;
  tag?: string;
  pullPolicy?: OryImagePullPolicy;
}

/** Busybox image values used by chart test hooks and init containers. */
export interface OryBusyboxImageValues {
  registry?: string;
  repository?: string;
  tag?: string;
}

/** Minimal Kubernetes resource requests/limits values. */
export interface OryResourceRequirementsValues {
  limits?: OryObjectMap;
  requests?: OryObjectMap;
}

/** Kubernetes service account chart values. */
export interface OryServiceAccountValues {
  create?: boolean;
  annotations?: OryStringMap;
  name?: string;
  automountServiceAccountToken?: boolean;
}

/** PodDisruptionBudget chart values. */
export interface OryPdbValues {
  enabled?: boolean;
  spec?: {
    minAvailable?: string | number;
    maxUnavailable?: string | number;
  };
}

/** Prometheus ServiceMonitor chart values shared by Ory charts. */
export interface OryServiceMonitorValues {
  enabled?: boolean;
  scheme?: string;
  scrapeInterval?: string;
  scrapeTimeout?: string;
  relabelings?: OryObjectMap[];
  metricRelabelings?: OryObjectMap[];
  labels?: OryStringMap;
  tlsConfig?: OryObjectMap;
  targetLabels?: string[];
}

/** ConfigMap behavior values shared by Ory charts. */
export interface OryConfigMapValues {
  hashSumEnabled?: boolean;
  annotations?: OryStringMap;
}

/** Helm test pod values shared by Ory charts. */
export interface OryTestValues {
  labels?: OryStringMap;
  busybox?: OryBusyboxImageValues;
}

/** Kubernetes Secret chart values shared by Ory charts. */
export interface OrySecretValues {
  enabled?: boolean;
  nameOverride?: string;
  enableDefaultAnnotations?: boolean;
  secretAnnotations?: OryStringMap;
  extraAnnotations?: OryStringMap;
  hashSumEnabled?: boolean;
  mountPath?: string;
  filename?: string;
}

/** Kubernetes service values shared by Ory service definitions. */
export interface OryServiceEndpointValues {
  enabled?: boolean;
  type?: OryServiceType;
  clusterIP?: string;
  loadBalancerIP?: string;
  nodePort?: string | number;
  port?: number;
  containerPort?: number;
  name?: string;
  annotations?: OryStringMap;
  labels?: OryStringMap;
  metricsPath?: string;
  appProtocol?: string;
  externalTrafficPolicy?: string;
  internalTrafficPolicy?: string;
  headless?: {
    enabled?: boolean;
  };
}

/** Ingress host path values. */
export interface OryIngressPathValues {
  path?: string;
  pathType?: OryIngressPathType;
}

/** Ingress host values. */
export interface OryIngressHostValues {
  host?: string;
  paths?: OryIngressPathValues[];
}

/** Ingress TLS values. */
export interface OryIngressTlsValues {
  secretName?: string;
  hosts?: string[];
}

/** Kubernetes ingress values shared by Ory charts. */
export interface OryIngressEndpointValues {
  enabled?: boolean;
  className?: string;
  annotations?: OryStringMap;
  hosts?: OryIngressHostValues[];
  tls?: OryIngressTlsValues[];
  defaultBackend?: OryObjectMap;
}

/** Kubernetes rolling update strategy values. */
export interface OryRollingUpdateValues {
  maxSurge?: string | number;
  maxUnavailable?: string | number;
}

/** Kubernetes deployment strategy values. */
export interface OryDeploymentStrategyValues {
  type?: string;
  rollingUpdate?: OryRollingUpdateValues;
}

/** Kubernetes probe timing values used by Ory charts. */
export interface OryProbeTimingValues {
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
  timeoutSeconds?: number;
}

/** Kubernetes HPA values used by Ory charts. */
export interface OryAutoscalingValues {
  enabled?: boolean;
  minReplicas?: number;
  maxReplicas?: number;
  targetCPU?: OryObjectMap;
  targetMemory?: OryObjectMap;
  behavior?: OryObjectMap;
  extraMetrics?: OryObjectMap[];
}

/** Shared Kubernetes pod/container scheduling and security fields. */
export interface OryPodRuntimeValues {
  resources?: OryResourceRequirementsValues;
  podSecurityContext?: OryObjectMap;
  securityContext?: OryObjectMap;
  nodeSelector?: OryStringMap;
  tolerations?: OryObjectMap[];
  affinity?: OryObjectMap;
  topologySpreadConstraints?: OryObjectMap[];
  dnsConfig?: OryObjectMap;
  podMetadata?: OryPodMetadataValues;
  automountServiceAccountToken?: boolean;
  terminationGracePeriodSeconds?: number;
}

/** Shared custom migration job values used by Ory service charts. */
export interface OryCustomMigrationJobValues {
  enabled?: boolean;
  customArgs?: string[];
  nodeSelector?: OryStringMap;
  resources?: OryResourceRequirementsValues;
  extraEnv?: OryObjectMap[];
}

/** Shared custom migrations values. */
export interface OryCustomMigrationsValues {
  jobs?: Record<string, OryCustomMigrationJobValues>;
}

/** Shared automigration values used by Ory service charts. */
export interface OryAutomigrationValues {
  enabled?: boolean;
  type?: OryAutomigrationType;
  customCommand?: string[];
  customArgs?: string[];
  resources?: OryResourceRequirementsValues;
  extraEnv?: OryObjectMap[];
}

/** Shared migration/init Job values. */
export interface OryJobValues {
  annotations?: OryStringMap;
  labels?: OryStringMap;
  extraContainers?: string | OryObjectMap[];
  extraEnv?: OryObjectMap[];
  podMetadata?: OryPodMetadataValues;
  extraInitContainers?: string;
  nodeSelector?: OryStringMap;
  resources?: OryResourceRequirementsValues;
  tolerations?: OryObjectMap[];
  lifecycle?: string | OryObjectMap;
  automountServiceAccountToken?: boolean;
  shareProcessNamespace?: boolean;
  serviceAccount?: OryServiceAccountValues;
  spec?: {
    backoffLimit?: number;
  };
}

/** Shared watcher sidecar values. */
export interface OryWatcherValues {
  enabled?: boolean;
  image?: string;
  mountFile?: string;
  podMetadata?: OryPodMetadataValues;
  watchLabelKey?: string;
  revisionHistoryLimit?: number;
  podSecurityContext?: OryObjectMap;
  resources?: OryResourceRequirementsValues;
  automountServiceAccountToken?: boolean;
  securityContext?: OryObjectMap;
}

/** Global values shared by all Ory charts. */
export interface OryGlobalValues {
  imageRegistry?: string | null;
  podMetadata?: OryPodMetadataValues;
  ory?: {
    oathkeeper?: {
      maester?: {
        mode?: OryOathkeeperMaesterMode;
      };
    };
  };
}

export type * from './hydra.js';
export type * from './kratos.js';
export type * from './keto.js';
export type * from './oathkeeper.js';
export type * from './hydra-maester.js';
export type * from './oathkeeper-maester.js';
