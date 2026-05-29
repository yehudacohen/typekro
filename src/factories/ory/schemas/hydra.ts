/** Hydra chart value contracts for Ory k8s chart version 0.62.0. */

import type {
  OryAutoscalingValues,
  OryAutomigrationValues,
  OryConfigMapValues,
  OryCustomMigrationsValues,
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
  OryDeploymentStrategyValues,
} from './chart-values.js';

/** Hydra service chart application config values. */
export interface OryHydraAppValues {
  command?: string[];
  customArgs?: string[];
  config?: {
    serve?: {
      public?: { port?: number };
      admin?: { port?: number };
      tls?: { allow_termination_from?: string[] };
    };
    secrets?: Record<string, OryYamlValue>;
    urls?: { self?: Record<string, OryYamlValue> };
    [key: string]: OryYamlValue | undefined;
  };
  automigration?: OryAutomigrationValues;
  customMigrations?: OryCustomMigrationsValues;
  dev?: boolean;
}

/** Hydra deployment values. */
export interface OryHydraDeploymentValues extends OryPodRuntimeValues {
  strategy?: OryDeploymentStrategyValues;
  initContainerSecurityContext?: OryObjectMap;
  lifecycle?: OryObjectMap;
  labels?: OryStringMap;
  annotations?: OryStringMap;
  extraEnv?: OryObjectMap[];
  automigration?: { extraEnv?: OryObjectMap[] };
  serviceAccount?: OryServiceAccountValues;
  extraVolumes?: OryObjectMap[];
  extraVolumeMounts?: OryObjectMap[];
  autoscaling?: OryAutoscalingValues;
  readinessProbe?: OryProbeTimingValues;
  startupProbe?: OryProbeTimingValues;
  extraInitContainers?: string;
  extraContainers?: string;
  customLivenessProbe?: OryObjectMap;
  customReadinessProbe?: OryObjectMap;
  customStartupProbe?: OryObjectMap;
  revisionHistoryLimit?: number;
}

/** Hydra janitor configuration. */
export interface OryHydraJanitorValues {
  enabled?: boolean;
  cleanupGrants?: boolean;
  cleanupRequests?: boolean;
  cleanupTokens?: boolean;
  batchSize?: number;
  limit?: number;
}

/** Hydra cronjob values. */
export interface OryHydraCronjobValues {
  janitor?: OryJobValues & {
    schedule?: string;
    customCommand?: string[];
    customArgs?: string[];
    extraVolumes?: OryObjectMap[];
    extraVolumeMounts?: OryObjectMap[];
    affinity?: OryObjectMap;
    podSecurityContext?: OryObjectMap;
    securityContext?: OryObjectMap;
    resources?: OryResourceRequirementsValues;
  };
}

/** Values for the Ory Hydra chart. */
export interface OryHydraChartValues {
  global?: OryGlobalValues;
  replicaCount?: number;
  image?: OryImageValues;
  imagePullSecrets?: OryObjectMap[];
  nameOverride?: string;
  fullnameOverride?: string;
  priorityClassName?: string;
  service?: {
    public?: OryServiceEndpointValues;
    admin?: OryServiceEndpointValues;
  };
  secret?: OrySecretValues;
  ingress?: {
    public?: OryIngressEndpointValues;
    admin?: OryIngressEndpointValues;
  };
  hydra?: OryHydraAppValues;
  deployment?: OryHydraDeploymentValues;
  job?: OryJobValues;
  affinity?: OryObjectMap;
  maester?: { enabled?: boolean };
  'hydra-maester'?: {
    adminService?: { name?: string; port?: number };
  };
  watcher?: OryWatcherValues;
  janitor?: OryHydraJanitorValues;
  cronjob?: OryHydraCronjobValues;
  pdb?: OryPdbValues;
  serviceMonitor?: OryServiceMonitorValues;
  configmap?: OryConfigMapValues;
  test?: OryTestValues;
}
