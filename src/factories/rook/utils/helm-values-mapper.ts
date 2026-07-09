/** Map typed bootstrap options into official `rook-ceph` chart values. */

import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { RookCephOperatorBootstrapConfig } from '../types.js';

export interface RookCephOperatorHelmValues {
  logLevel?: 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';
  enableOBCWatchOperatorNamespace?: boolean;
  obcProvisionerNamePrefix?: string;
  obcAllowAdditionalConfigFields?: string;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  [key: string]: unknown;
}

export type RookCephOperatorMappedHelmValues = RookCephOperatorHelmValues | ValuesMergeExpression;

type RookCephOperatorHelmValuesInput = {
  [K in keyof Pick<
    RookCephOperatorBootstrapConfig,
    | 'logLevel'
    | 'enableOBCWatchOperatorNamespace'
    | 'obcProvisionerNamePrefix'
    | 'obcAllowAdditionalConfigFields'
    | 'resources'
    | 'values'
  >]: RookCephOperatorBootstrapConfig[K] | undefined;
};

/**
 * Map typed fields and merge raw chart `values` last.
 *
 * Whole-map schema refs use TypeKro's runtime values merge so KRO mode does
 * not lose user overrides or stringify graph markers.
 */
export function mapRookCephOperatorConfigToHelmValues(
  config: RookCephOperatorHelmValuesInput
): RookCephOperatorMappedHelmValues {
  const values: RookCephOperatorHelmValues = {};

  if (config.logLevel !== undefined) values.logLevel = config.logLevel;
  if (config.enableOBCWatchOperatorNamespace !== undefined) {
    values.enableOBCWatchOperatorNamespace = config.enableOBCWatchOperatorNamespace;
  }
  if (config.obcProvisionerNamePrefix !== undefined) {
    values.obcProvisionerNamePrefix = config.obcProvisionerNamePrefix;
  }
  if (config.obcAllowAdditionalConfigFields !== undefined) {
    values.obcAllowAdditionalConfigFields = config.obcAllowAdditionalConfigFields;
  }
  if (config.resources !== undefined) values.resources = config.resources;

  return mergeValuesLast(values, config.values);
}

function mergeValuesLast(
  base: RookCephOperatorHelmValues,
  overrides: unknown
): RookCephOperatorMappedHelmValues {
  if (overrides === undefined) return base;

  if (
    isKubernetesRef(overrides) ||
    isCelExpression(overrides) ||
    isValuesMergeExpression(overrides)
  ) {
    return mergeValuesExpression(base, overrides);
  }

  if (isPlainObject(overrides)) deepMerge(base, overrides);
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value) &&
    !isValuesMergeExpression(value)
  );
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}
