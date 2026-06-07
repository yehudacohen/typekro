/** Kratos chart value contracts for Ory k8s chart version 0.62.0. */

import type {
  OryAutoscalingValues,
  OryAutomigrationValues,
  OryConfigMapValues,
  OryCustomMigrationsValues,
  OryDeploymentStrategyValues,
  OryGlobalValues,
  OryImageValues,
  OryIngressEndpointValues,
  OryJobValues,
  OryObjectMap,
  OryPdbValues,
  OryPodRuntimeValues,
  OryProbeTimingValues,
  OryResourceRequirementsValues,
  OrySecretValues,
  OryServiceAccountValues,
  OryServiceEndpointValues,
  OryServiceMonitorValues,
  OryStringMap,
  OryTestValues,
  OryWatcherValues,
  OryYamlValue,
} from './chart-values.js';

/** Kratos application config values. */
export interface OryKratosAppValues {
  development?: boolean;
  automigration?: OryAutomigrationValues;
  identitySchemas?: Record<string, string>;
  emailTemplates?: Record<string, OryYamlValue>;
  config?: {
    courier?: { smtp?: Record<string, OryYamlValue>; template_override_path?: string };
    serve?: { public?: { port?: number }; admin?: { port?: number } };
    secrets?: Record<string, OryYamlValue>;
    [key: string]: OryYamlValue | undefined;
  };
  customMigrations?: OryCustomMigrationsValues;
}

/** Kratos deployment values. */
export interface OryKratosDeploymentValues extends OryPodRuntimeValues {
  lifecycle?: OryObjectMap;
  readinessProbe?: OryProbeTimingValues;
  startupProbe?: OryProbeTimingValues;
  customLivenessProbe?: OryObjectMap;
  customReadinessProbe?: OryObjectMap;
  customStartupProbe?: OryObjectMap;
  extraArgs?: string[];
  extraEnv?: OryObjectMap[];
  extraVolumes?: OryObjectMap[];
  extraVolumeMounts?: OryObjectMap[];
  extraInitContainers?: string;
  extraContainers?: string;
  priorityClassName?: string;
  labels?: OryStringMap;
  annotations?: OryStringMap;
  environmentSecretsName?: string;
  serviceAccount?: OryServiceAccountValues;
  automigration?: { extraEnv?: OryObjectMap[] };
  revisionHistoryLimit?: number;
}

/** Kratos StatefulSet values. */
export interface OryKratosStatefulSetValues extends OryPodRuntimeValues {
  resources?: OryResourceRequirementsValues;
  extraArgs?: string[];
  extraEnv?: OryObjectMap[];
  extraVolumes?: OryObjectMap[];
  extraVolumeMounts?: OryObjectMap[];
  extraInitContainers?: string;
  extraContainers?: string;
  annotations?: OryStringMap;
  environmentSecretsName?: string;
  labels?: OryStringMap;
  priorityClassName?: string;
  log?: { format?: string; level?: string };
  revisionHistoryLimit?: number;
}

/** Kratos cleanup values. */
export interface OryKratosCleanupValues {
  enabled?: boolean;
  batchSize?: number;
  sleepTables?: string;
  keepLast?: string;
}

/** Kratos cronjob values. */
export interface OryKratosCronjobValues {
  cleanup?: OryJobValues & {
    schedule?: string;
    customArgs?: string[];
    annotations?: OryStringMap;
    extraContainers?: OryObjectMap[];
    affinity?: OryObjectMap;
    resources?: OryResourceRequirementsValues;
  };
}

/** Values for the Ory Kratos chart. */
export interface OryKratosChartValues {
  global?: OryGlobalValues;
  replicaCount?: number;
  strategy?: OryDeploymentStrategyValues;
  image?: OryImageValues;
  imagePullSecrets?: OryObjectMap[];
  nameOverride?: string;
  fullnameOverride?: string;
  service?: {
    admin?: OryServiceEndpointValues;
    public?: OryServiceEndpointValues;
    courier?: OryServiceEndpointValues;
  };
  secret?: OrySecretValues;
  ingress?: {
    admin?: OryIngressEndpointValues;
    public?: OryIngressEndpointValues;
  };
  kratos?: OryKratosAppValues;
  deployment?: OryKratosDeploymentValues;
  statefulSet?: OryKratosStatefulSetValues;
  securityContext?: OryObjectMap;
  autoscaling?: OryAutoscalingValues;
  job?: OryJobValues;
  courier?: { enabled?: boolean };
  watcher?: OryWatcherValues;
  cleanup?: OryKratosCleanupValues;
  cronjob?: OryKratosCronjobValues;
  pdb?: OryPdbValues;
  serviceMonitor?: OryServiceMonitorValues;
  configmap?: OryConfigMapValues;
  test?: OryTestValues;
}
