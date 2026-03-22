/**
 * Helm Values Mapper for Inngest
 *
 * Maps InngestBootstrapConfig to Helm chart values for the inngest chart.
 *
 * @see https://github.com/inngest/inngest-helm
 */

import type { InngestBootstrapConfig } from '../types.js';

/** Helm values structure for the inngest chart. */
export interface InngestHelmValues {
  replicaCount?: number;
  inngest?: {
    eventKey?: string;
    signingKey?: string;
    postgres?: { uri?: string };
    redis?: { uri?: string };
    host?: string;
    sdkUrl?: string[];
    noUI?: boolean;
    pollInterval?: number;
    queueWorkers?: number;
    logLevel?: string;
    json?: boolean;
    extraEnv?: Array<{ name: string; value: string }>;
  };
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  postgresql?: {
    enabled?: boolean;
    auth?: { database?: string; username?: string; password?: string };
    persistence?: { enabled?: boolean; size?: string; storageClass?: string };
    resources?: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
    };
  };
  redis?: {
    enabled?: boolean;
    persistence?: { enabled?: boolean; size?: string; storageClass?: string };
    resources?: {
      requests?: { cpu?: string; memory?: string };
      limits?: { cpu?: string; memory?: string };
    };
  };
  ingress?: {
    enabled?: boolean;
    className?: string;
    annotations?: Record<string, string>;
    hosts?: Array<{
      host: string;
      paths?: Array<{ path?: string; pathType?: string }>;
    }>;
    tls?: Array<{ secretName?: string; hosts?: string[] }>;
  };
  keda?: {
    enabled?: boolean;
    minReplicas?: number;
    maxReplicas?: number;
    pollingInterval?: number;
    cooldownPeriod?: number;
  };
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{
    key?: string;
    operator?: string;
    value?: string;
    effect?: string;
  }>;
  [key: string]: unknown;
}

/**
 * Map InngestBootstrapConfig to Helm chart values.
 *
 * Explicitly picks fields from the config — bootstrap-only fields like
 * `name`, `namespace`, `version` are NOT passed to Helm values.
 *
 * @param config - Resolved Inngest bootstrap configuration
 * @returns Helm values object compatible with the inngest chart
 */
export function mapInngestConfigToHelmValues(
  config: InngestBootstrapConfig
): InngestHelmValues {
  const values: InngestHelmValues = {};

  if (config.replicaCount !== undefined) {
    values.replicaCount = config.replicaCount;
  }

  // Core Inngest application config
  values.inngest = {
    eventKey: config.inngest.eventKey,
    signingKey: config.inngest.signingKey,
  };
  if (config.inngest.postgres) values.inngest.postgres = config.inngest.postgres;
  if (config.inngest.redis) values.inngest.redis = config.inngest.redis;
  if (config.inngest.host) values.inngest.host = config.inngest.host;
  if (config.inngest.sdkUrl) values.inngest.sdkUrl = config.inngest.sdkUrl;
  if (config.inngest.noUI !== undefined) values.inngest.noUI = config.inngest.noUI;
  if (config.inngest.pollInterval !== undefined) {
    values.inngest.pollInterval = config.inngest.pollInterval;
  }
  if (config.inngest.queueWorkers !== undefined) {
    values.inngest.queueWorkers = config.inngest.queueWorkers;
  }
  if (config.inngest.logLevel) values.inngest.logLevel = config.inngest.logLevel;
  if (config.inngest.json !== undefined) values.inngest.json = config.inngest.json;
  if (config.inngest.extraEnv) values.inngest.extraEnv = config.inngest.extraEnv;

  if (config.resources) values.resources = config.resources;
  if (config.postgresql) values.postgresql = config.postgresql;
  if (config.redis) values.redis = config.redis;
  if (config.ingress) values.ingress = config.ingress;
  if (config.keda) values.keda = config.keda;
  if (config.nodeSelector) values.nodeSelector = config.nodeSelector;
  if (config.tolerations) {
    values.tolerations = config.tolerations;
  }

  // Custom values last for user overrides
  if (config.customValues) {
    Object.assign(values, config.customValues);
  }

  return removeUndefinedValues(values);
}

/**
 * Recursively remove undefined values from an object.
 */
function removeUndefinedValues<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const cleaned = removeUndefinedValues(value as Record<string, unknown>);
      if (Object.keys(cleaned).length > 0) {
        result[key] = cleaned;
      }
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
