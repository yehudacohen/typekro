/** Keto chart value contracts for Ory k8s chart version 0.62.0. */

import type {
  OryAutoscalingValues,
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
  OrySecretValues,
  OryServiceAccountValues,
  OryServiceEndpointValues,
  OryServiceMonitorValues,
  OryStringMap,
  OryTestValues,
  OryWatcherValues,
  OryYamlValue,
  OryAutomigrationValues,
} from './chart-values.js';

/** Keto application values. */
export interface OryKetoAppValues {
  command?: string[];
  customArgs?: string[];
  automigration?: OryAutomigrationValues;
  config?: {
    serve?: {
      read?: { port?: number };
      write?: { port?: number };
      metrics?: { port?: number };
    };
    namespaces?: Array<{ id?: number; name?: string }>;
    dsn?: string;
    [key: string]: OryYamlValue | undefined;
  };
  customMigrations?: OryCustomMigrationsValues;
}

/** Keto deployment values. */
export interface OryKetoDeploymentValues extends OryPodRuntimeValues {
  strategy?: OryDeploymentStrategyValues;
  minReadySeconds?: number;
  podAnnotations?: OryStringMap;
  lifecycle?: OryObjectMap;
  readinessProbe?: OryProbeTimingValues;
  startupProbe?: OryProbeTimingValues;
  customLivenessProbe?: OryObjectMap;
  customReadinessProbe?: OryObjectMap;
  customStartupProbe?: OryObjectMap;
  annotations?: OryStringMap;
  autoscaling?: OryAutoscalingValues;
  extraContainers?: string;
  extraEnv?: OryObjectMap[];
  extraVolumes?: OryObjectMap[];
  extraVolumeMounts?: OryObjectMap[];
  extraInitContainers?: OryObjectMap | string;
  extraLabels?: OryStringMap;
  extraPorts?: OryObjectMap[];
  automigration?: { extraEnv?: OryObjectMap[] };
  revisionHistoryLimit?: number;
}

/** Values for the Ory Keto chart. */
export interface OryKetoChartValues {
  global?: OryGlobalValues;
  replicaCount?: number;
  image?: OryImageValues;
  imagePullSecrets?: OryObjectMap[];
  nameOverride?: string;
  fullnameOverride?: string;
  priorityClassName?: string;
  serviceAccount?: OryServiceAccountValues;
  podSecurityContext?: OryObjectMap;
  securityContext?: OryObjectMap;
  job?: OryJobValues;
  ingress?: {
    read?: OryIngressEndpointValues;
    write?: OryIngressEndpointValues;
  };
  service?: {
    read?: OryServiceEndpointValues;
    write?: OryServiceEndpointValues;
    metrics?: OryServiceEndpointValues;
  };
  extraServices?: Record<string, OryServiceEndpointValues>;
  secret?: OrySecretValues;
  keto?: OryKetoAppValues;
  deployment?: OryKetoDeploymentValues;
  watcher?: OryWatcherValues;
  pdb?: OryPdbValues;
  serviceMonitor?: OryServiceMonitorValues;
  configmap?: OryConfigMapValues;
  test?: OryTestValues;
}
