/** Oathkeeper chart value contracts for Ory k8s chart version 0.62.0. */

import type {
  OryAutoscalingValues,
  OryConfigMapValues,
  OryDeploymentStrategyValues,
  OryGlobalValues,
  OryImageValues,
  OryIngressEndpointValues,
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
  OryYamlValue,
} from './chart-values.js';

/** Oathkeeper image values including chart init container image. */
export interface OryOathkeeperImageValues extends OryImageValues {
  initContainer?: {
    repository?: string;
    tag?: string;
  };
}

/** Oathkeeper chart sidecar values. */
export interface OryOathkeeperSidecarValues {
  image?: {
    repository?: string;
    tag?: string;
  };
  envs?: OryObjectMap;
}

/** Oathkeeper application values. */
export interface OryOathkeeperAppValues {
  helmTemplatedConfigEnabled?: boolean;
  configFileOverride?: {
    enabled?: boolean;
    nameOverride?: string;
  };
  config?: {
    access_rules?: { repositories?: string[] };
    serve?: {
      proxy?: { port?: number };
      api?: { port?: number };
      prometheus?: { port?: number };
    };
    [key: string]: OryYamlValue | undefined;
  };
  mutatorIdTokenJWKs?: string;
  accessRulesOverride?: { nameOverride?: string };
  accessRules?: string;
  managedAccessRules?: boolean;
}

/** Oathkeeper deployment values. */
export interface OryOathkeeperDeploymentValues extends OryPodRuntimeValues {
  strategy?: OryDeploymentStrategyValues;
  lifecycle?: OryObjectMap;
  readinessProbe?: OryProbeTimingValues;
  startupProbe?: OryProbeTimingValues;
  customLivenessProbe?: OryObjectMap;
  customReadinessProbe?: OryObjectMap;
  customStartupProbe?: OryObjectMap;
  serviceAccount?: OryServiceAccountValues;
  nodeSelector?: OryStringMap;
  extraEnv?: OryObjectMap[];
  extraArgs?: string[];
  extraVolumes?: OryObjectMap[];
  extraVolumeMounts?: OryObjectMap[];
  extraContainers?: string;
  extraInitContainers?: string;
  labels?: OryStringMap;
  annotations?: OryStringMap;
  autoscaling?: OryAutoscalingValues;
}

/** Values for the Ory Oathkeeper chart. */
export interface OryOathkeeperChartValues {
  global?: OryGlobalValues;
  replicaCount?: number;
  revisionHistoryLimit?: number;
  image?: OryOathkeeperImageValues;
  sidecar?: OryOathkeeperSidecarValues;
  priorityClassName?: string;
  imagePullSecrets?: OryObjectMap[];
  nameOverride?: string;
  fullnameOverride?: string;
  securityContext?: OryObjectMap;
  podSecurityContext?: OryObjectMap;
  demo?: boolean;
  service?: {
    proxy?: OryServiceEndpointValues;
    api?: OryServiceEndpointValues;
    metrics?: OryServiceEndpointValues;
  };
  ingress?: {
    proxy?: OryIngressEndpointValues;
    api?: OryIngressEndpointValues;
  };
  oathkeeper?: OryOathkeeperAppValues;
  secret?: OrySecretValues;
  deployment?: OryOathkeeperDeploymentValues;
  affinity?: OryObjectMap;
  maester?: { enabled?: boolean };
  pdb?: OryPdbValues;
  serviceMonitor?: OryServiceMonitorValues;
  configmap?: OryConfigMapValues;
  test?: OryTestValues;
}
