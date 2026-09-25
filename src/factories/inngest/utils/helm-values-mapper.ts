/**
 * Helm Values Mapper for Inngest
 *
 * Maps InngestBootstrapConfig to Helm chart values for the inngest chart.
 *
 * @see https://github.com/inngest/inngest-helm
 */

import { isMergeableValuesObject } from '../../../core/aspects/values-merge.js';
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
    tolerationSeconds?: number;
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

  // Recursively deep merge custom values into the generated Helm values.
  // Plain objects are merged key-by-key at arbitrary depth. Arrays and
  // primitives are replaced (not concatenated or coerced).
  if (config.customValues) {
    deepMerge(values, config.customValues);
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
    if (isMergeableValuesObject(value)) {
      // Opaque leaves (references, CEL expressions, symbol-branded markers)
      // are kept whole: rebuilding one from its string keys drops its brand.
      const cleaned = removeUndefinedValues(value);
      if (Object.keys(cleaned).length > 0) {
        result[key] = cleaned;
      }
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Recursively deep merge `source` into `target`. Only `target` itself is
 * written: nested objects are copied before they are merged into.
 * - Plain objects are merged key-by-key at arbitrary depth.
 * - Arrays, primitives and opaque leaves (references, CEL expressions,
 *   symbol-branded markers) in source replace the target value.
 * - null and undefined in source replace the target value.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (isMergeableValuesObject(sourceValue) && isMergeableValuesObject(targetValue)) {
      // Copy before merging: the nested object can be the caller's own (a typed
      // field such as `nodeSelector` is mapped by reference), and merging into
      // it in place mutated it. References, CEL expressions and other branded
      // leaves are never merged into, so the spread never flattens one.
      const next = { ...targetValue };
      deepMerge(next, sourceValue);
      target[key] = next;
    } else {
      target[key] = sourceValue;
    }
  }
}
