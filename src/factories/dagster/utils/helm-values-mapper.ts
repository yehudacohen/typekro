/**
 * Dagster Helm values mapper and validation.
 *
 * The mapper intentionally builds only Dagster chart values. Bootstrap-only
 * fields such as `name`, `namespace`, chart version, and Flux repository names
 * stay in TypeKro resource configuration and are never forwarded to Helm.
 */

import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { TypeKroError } from '../../../core/errors.js';
import { Cel } from '../../../core/references/cel.js';
import type { TypeKroValueTree, TypeKroValueTreeObject } from '../../../core/types/common.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type {
  DagsterBootstrapConfig,
  DagsterConfigValidationResult,
  DagsterConfigurationErrorCode,
  DagsterConfigurationIssue,
  DagsterHelmValues,
  DagsterImageConfig,
  DagsterMappedHelmValues,
  DagsterUserDeployment,
} from '../types.js';

type DagsterRuntimeValueTree = TypeKroValueTree | ValuesMergeExpression;
type DagsterRuntimeValueTreeObject = { [key: string]: DagsterRuntimeValueTree };

const DEFAULT_USER_DEPLOYMENT_PORT = 3030;
const DEFAULT_USER_DEPLOYMENT_PULL_POLICY = 'IfNotPresent';
const GRAPH_AWARE_DEEP_MERGE_SECTIONS = new Set([
  'global',
  'dagsterWebserver',
  'dagsterDaemon',
  'dagster-user-deployments',
  'postgresql',
  'runLauncher',
  'scheduler',
  'computeLogManager',
  'ingress',
  'flower',
  'rabbitmq',
  'redis',
]);

/** Error thrown when typed Dagster configuration violates safety invariants. */
export class DagsterConfigurationValidationError extends TypeKroError {
  constructor(
    code: DagsterConfigurationErrorCode,
    message: string,
    context: { name?: string; issues: DagsterConfigurationIssue[] }
  ) {
    super(message, code, context);
    this.name = 'DagsterConfigurationError';
  }
}

/** Validate cross-field Dagster config rules that ArkType cannot express alone. */
export function validateDagsterConfig(config: DagsterBootstrapConfig): DagsterConfigValidationResult {
  const issues: DagsterConfigurationIssue[] = [];

  validateUserDeployments(config, issues);
  validateRunLauncher(config, issues);
  validatePostgresql(config, issues);

  return { valid: issues.length === 0, issues };
}

/** Map typed Dagster bootstrap config into official Dagster Helm chart values. */
export function mapDagsterConfigToHelmValues(
  config: DagsterBootstrapConfig
): DagsterMappedHelmValues {
  const validation = validateDagsterConfig(config);
  if (!validation.valid) {
    const firstIssue = validation.issues[0];
    throw new DagsterConfigurationValidationError(
      firstIssue?.code ?? 'DAGSTER_INVALID_CONFIG',
      `DagsterConfigurationError ${firstIssue?.code ?? 'DAGSTER_INVALID_CONFIG'}: ${validation.issues
        .map((issue) => issue.path)
        .join(', ')}`,
      { name: config.name, issues: validation.issues }
    );
  }

  const values: DagsterHelmValues = {};

  setIfDefined(values, 'nameOverride', config.nameOverride);
  setIfDefined(values, 'fullnameOverride', config.fullnameOverride);
  setIfDefined(values, 'rbacEnabled', config.rbacEnabled);
  setIfDefined(values, 'imagePullSecrets', copyDefinedArray(config.imagePullSecrets));
  mergeGlobalValues(values, config);
  setIfDefined(values, 'dagsterWebserver', mapWebserverConfig(config.webserver));
  setIfDefined(values, 'dagsterDaemon', mapDaemonConfig(config.daemon));
  setIfDefined(values, 'dagster-user-deployments', mapUserDeployments(config));
  mapPostgresql(values, config);
  setIfDefined(values, 'runLauncher', mapRunLauncher(config));
  setIfDefined(values, 'scheduler', copyDefinedObject(config.scheduler));
  setIfDefined(values, 'computeLogManager', copyDefinedObject(config.computeLogManager));
  setIfDefined(values, 'ingress', copyDefinedObject(config.ingress));
  setIfDefined(values, 'flower', copyDefinedObject(config.flower));
  setIfDefined(values, 'rabbitmq', mapRabbitmq(config));
  setIfDefined(values, 'redis', mapRedis(config));

  const generateCeleryConfigSecret = falseWhenValuePresent(
    config.global?.celeryConfigSecretName,
    'schema.spec.global.celeryConfigSecretName'
  );
  setIfDefined(values, 'generateCeleryConfigSecret', generateCeleryConfigSecret);

  return mergeRawValuesLast(values, config.values);
}

function validateUserDeployments(
  config: DagsterBootstrapConfig,
  issues: DagsterConfigurationIssue[]
): void {
  const deployments = config.userDeployments?.deployments;
  if (!Array.isArray(deployments)) return;

  deployments.forEach((deployment, index) => {
    const hasGrpcArgs = hasNonEmptyArray(deployment.dagsterApiGrpcArgs);
    const hasCodeServerArgs = hasNonEmptyArray(deployment.codeServerArgs);
    if (hasGrpcArgs === hasCodeServerArgs) {
      issues.push({
        code: 'DAGSTER_REQUIRED_CONFIG_MISSING',
        path: `userDeployments.deployments[${index}]`,
        component: 'userDeployments',
        message:
          'Each typed Dagster user deployment must set exactly one server argument field.',
      });
    }
  });
}

function validateRunLauncher(
  config: DagsterBootstrapConfig,
  issues: DagsterConfigurationIssue[]
): void {
  if (config.runLauncher?.type !== 'CeleryK8sRunLauncher') return;

  const hasRabbitmq = config.rabbitmq?.enabled === true;
  const hasRedis =
    config.redis?.enabled === true ||
    config.redis?.internal === true ||
    !!config.redis?.host ||
    !!config.redis?.brokerUrl ||
    !!config.redis?.backendUrl;
  const hasSecret = !!config.global?.celeryConfigSecretName;
  const hasRawCeleryConfig = hasRawPath(config.values, 'runLauncher') || hasRawPath(config.values, 'redis');

  if (!hasRabbitmq && !hasRedis && !hasSecret && !hasRawCeleryConfig) {
    issues.push({
      code: 'DAGSTER_REQUIRED_CONFIG_MISSING',
      path: 'runLauncher.celeryK8sRunLauncher',
      component: 'runLauncher',
      message: 'CeleryK8sRunLauncher requires RabbitMQ, Redis, or explicit raw Celery config.',
    });
  }
}

function validatePostgresql(
  config: DagsterBootstrapConfig,
  issues: DagsterConfigurationIssue[]
): void {
  if (config.postgresql?.enabled !== false) return;
  if (config.postgresql.host || hasRawPath(config.values, 'postgresql')) return;

  issues.push({
    code: 'DAGSTER_REQUIRED_CONFIG_MISSING',
    path: 'postgresql.host',
    component: 'postgresql',
    message: 'External PostgreSQL config requires a host or raw chart PostgreSQL values.',
  });
}

function mergeGlobalValues(values: DagsterHelmValues, config: DagsterBootstrapConfig): void {
  const globalValues = mapGlobalConfig(config.global) ?? {};

  overlayGlobalValue(
    globalValues,
    'serviceAccountName',
    config.serviceAccountName,
    'schema.spec.serviceAccountName',
    'schema.spec.global.serviceAccountName'
  );
  overlayGlobalValue(
    globalValues,
    'postgresqlSecretName',
    config.postgresql?.passwordSecretName,
    'schema.spec.postgresql.passwordSecretName',
    'schema.spec.global.postgresqlSecretName'
  );

  if (Object.keys(globalValues).length > 0) {
    values.global = globalValues;
  }
}

function overlayGlobalValue(
  target: TypeKroValueTreeObject,
  key: string,
  overlayValue: unknown,
  overlayPath: string,
  fallbackPath: string
): void {
  const fallbackValue = target[key];
  if (overlayValue === undefined) return;

  if (isGraphAwareValue(overlayValue) || isValuesMergeExpression(overlayValue)) {
    target[key] = Cel.expr<string>(
      `${hasSchemaPath(overlayPath)} ? ${overlayPath} : ${hasSchemaPath(fallbackPath)} ? ${fallbackPath} : omit()`
    ) as TypeKroValueTree;
    return;
  }

  if (fallbackValue !== undefined || overlayValue !== undefined) {
    target[key] = overlayValue as TypeKroValueTree;
  }
}

function mapGlobalConfig(
  global: DagsterBootstrapConfig['global']
): TypeKroValueTreeObject | undefined {
  if (!global) return undefined;
  if (!isGraphAwareValue(global)) return copyDefinedObject(global);

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'dagsterHome', global.dagsterHome);
  setIfDefined(mapped, 'serviceAccountName', global.serviceAccountName);
  setIfDefined(mapped, 'postgresqlSecretName', global.postgresqlSecretName);
  setIfDefined(mapped, 'postgresqlAuthWifEnabled', global.postgresqlAuthWifEnabled);
  setIfDefined(mapped, 'celeryConfigSecretName', global.celeryConfigSecretName);
  setIfDefined(mapped, 'dagsterInstanceConfigMap', global.dagsterInstanceConfigMap);

  return mapped;
}

function mapWebserverConfig(
  webserver: DagsterBootstrapConfig['webserver']
): TypeKroValueTreeObject | undefined {
  if (!webserver) return undefined;
  if (!isGraphAwareValue(webserver)) return copyDefinedObject(webserver);

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'replicaCount', webserver.replicaCount);
  setIfDefined(mapped, 'image', copyDefinedObject(webserver.image));
  setIfDefined(mapped, 'service', copyDefinedObject(webserver.service));
  setIfDefined(mapped, 'pathPrefix', webserver.pathPrefix);
  setIfDefined(mapped, 'enableReadOnly', webserver.enableReadOnly);
  setIfDefined(mapped, 'logFormat', webserver.logFormat);
  setIfDefined(mapped, 'logLevel', webserver.logLevel);
  setIfDefined(mapped, 'workspace', copyDefinedObject(webserver.workspace));
  setIfDefined(mapped, 'readinessProbe', copyDefinedObject(webserver.readinessProbe));
  setIfDefined(mapped, 'livenessProbe', copyDefinedObject(webserver.livenessProbe));
  setIfDefined(mapped, 'startupProbe', copyDefinedObject(webserver.startupProbe));
  mapPodConfig(mapped, webserver);

  return mapped;
}

function mapDaemonConfig(
  daemon: DagsterBootstrapConfig['daemon']
): TypeKroValueTreeObject | undefined {
  if (!daemon) return undefined;
  if (!isGraphAwareValue(daemon)) return copyDefinedObject(daemon);

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'enabled', daemon.enabled);
  setIfDefined(mapped, 'image', copyDefinedObject(daemon.image));
  setIfDefined(mapped, 'heartbeatTolerance', daemon.heartbeatTolerance);
  setIfDefined(mapped, 'logFormat', daemon.logFormat);
  setIfDefined(mapped, 'runCoordinator', copyDefinedObject(daemon.runCoordinator));
  setIfDefined(mapped, 'runMonitoring', copyDefinedObject(daemon.runMonitoring));
  setIfDefined(mapped, 'runRetries', copyDefinedObject(daemon.runRetries));
  setIfDefined(mapped, 'sensors', copyDefinedObject(daemon.sensors));
  setIfDefined(mapped, 'schedules', copyDefinedObject(daemon.schedules));
  mapPodConfig(mapped, daemon);

  return mapped;
}

function mapPodConfig(target: TypeKroValueTreeObject, podConfig: NonNullable<DagsterBootstrapConfig['webserver']>): void {
  setIfDefined(target, 'labels', podConfig.labels);
  setIfDefined(target, 'nodeSelector', podConfig.nodeSelector);
  setIfDefined(target, 'affinity', copyDefinedObject(podConfig.affinity));
  setIfDefined(target, 'tolerations', copyDefinedArray(podConfig.tolerations));
  setIfDefined(target, 'resources', copyDefinedObject(podConfig.resources));
  setIfDefined(target, 'podSecurityContext', copyDefinedObject(podConfig.podSecurityContext));
  setIfDefined(target, 'securityContext', copyDefinedObject(podConfig.securityContext));
  setIfDefined(target, 'volumes', copyDefinedArray(podConfig.volumes));
  setIfDefined(target, 'volumeMounts', copyDefinedArray(podConfig.volumeMounts));
  setIfDefined(target, 'env', copyDefinedArray(podConfig.env));
  setIfDefined(target, 'envConfigMaps', copyDefinedArray(podConfig.envConfigMaps));
  setIfDefined(target, 'envSecrets', copyDefinedArray(podConfig.envSecrets));
}

function mapUserDeployments(config: DagsterBootstrapConfig): TypeKroValueTreeObject | undefined {
  const userDeployments = config.userDeployments;
  if (!userDeployments) return undefined;

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'enabled', userDeployments.enabled);
  setIfDefined(mapped, 'enableSubchart', userDeployments.enableSubchart ?? userDeployments.enabled ?? false);
  setIfDefined(mapped, 'imagePullSecrets', copyDefinedArray(userDeployments.imagePullSecrets));

  const deployments = userDeployments.deployments;
  if (Array.isArray(deployments)) {
    mapped.deployments = deployments.map(mapUserDeployment);
  } else {
    setIfDefined(mapped, 'deployments', copyDefinedArray(deployments));
  }

  return mapped;
}

function mapUserDeployment(deployment: DagsterUserDeployment): TypeKroValueTreeObject {
  const mapped = copyDefinedObject(deployment) ?? {};
  setIfDefined(mapped, 'port', deployment.port ?? DEFAULT_USER_DEPLOYMENT_PORT);
  mapped.image = mapUserDeploymentImage(deployment.image);
  return mapped;
}

function mapUserDeploymentImage(image: DagsterImageConfig): TypeKroValueTreeObject {
  return {
    ...copyDefinedObject(image),
    pullPolicy: image.pullPolicy ?? DEFAULT_USER_DEPLOYMENT_PULL_POLICY,
  };
}

function mapPostgresql(values: DagsterHelmValues, config: DagsterBootstrapConfig): void {
  const postgresql = config.postgresql;
  if (!postgresql) return;

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'enabled', postgresql.enabled);
  setIfDefined(mapped, 'postgresqlHost', postgresql.host);
  setIfDefined(mapped, 'postgresqlUsername', postgresql.username);
  setIfDefined(mapped, 'postgresqlDatabase', postgresql.database);
  setIfDefined(mapped, 'postgresqlPassword', postgresql.password);
  setIfDefined(mapped, 'postgresqlParams', postgresql.params);
  setIfDefined(mapped, 'postgresqlScheme', postgresql.scheme);
  setIfDefined(mapped, 'authProvider', copyDefinedObject(postgresql.authProvider));

  if (postgresql.servicePort !== undefined) {
    mapped.service = { port: postgresql.servicePort };
  }

  const mappedWithSubValues = mergeSubValues(mapped, postgresql.values);
  if (isEmittableValue(mappedWithSubValues)) {
    setIfDefined(values, 'postgresql', mappedWithSubValues);
  }

  const generatePostgresqlPasswordSecret = falseWhenValuePresent(
    postgresql.passwordSecretName,
    'schema.spec.postgresql.passwordSecretName'
  );
  setIfDefined(values, 'generatePostgresqlPasswordSecret', generatePostgresqlPasswordSecret);
}

function mapRunLauncher(config: DagsterBootstrapConfig): TypeKroValueTreeObject | undefined {
  const runLauncher = config.runLauncher;
  if (!runLauncher) return undefined;

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'type', runLauncher.type);

  const launcherConfig: TypeKroValueTreeObject = {};
  setIfDefined(launcherConfig, 'k8sRunLauncher', copyDefinedObject(runLauncher.k8sRunLauncher));
  setIfDefined(
    launcherConfig,
    'celeryK8sRunLauncher',
    copyDefinedObject(runLauncher.celeryK8sRunLauncher)
  );
  setIfDefined(launcherConfig, 'customRunLauncher', copyDefinedObject(runLauncher.customRunLauncher));

  if (Object.keys(launcherConfig).length > 0) {
    mapped.config = launcherConfig;
  }

  return mapped;
}

function mapRabbitmq(config: DagsterBootstrapConfig): DagsterRuntimeValueTree | undefined {
  const rabbitmq = config.rabbitmq;
  if (!rabbitmq) return undefined;

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'enabled', rabbitmq.enabled);
  setIfDefined(mapped, 'image', copyDefinedObject(rabbitmq.image));

  const rabbitmqCredentials: TypeKroValueTreeObject = {};
  setIfDefined(rabbitmqCredentials, 'username', rabbitmq.username);
  setIfDefined(rabbitmqCredentials, 'password', rabbitmq.password);
  if (Object.keys(rabbitmqCredentials).length > 0) {
    mapped.rabbitmq = rabbitmqCredentials;
  }

  if (rabbitmq.servicePort !== undefined) {
    mapped.service = { port: rabbitmq.servicePort };
  }

  return mergeSubValues(mapped, rabbitmq.values);
}

function mapRedis(config: DagsterBootstrapConfig): DagsterRuntimeValueTree | undefined {
  const redis = config.redis;
  if (!redis) return undefined;

  const mapped: TypeKroValueTreeObject = {};
  setIfDefined(mapped, 'enabled', redis.enabled);
  setIfDefined(mapped, 'internal', redis.internal);
  setIfDefined(mapped, 'image', copyDefinedObject(redis.image));
  setIfDefined(mapped, 'usePassword', redis.usePassword);
  setIfDefined(mapped, 'password', redis.password);
  setIfDefined(mapped, 'host', redis.host);
  setIfDefined(mapped, 'port', redis.port);
  setIfDefined(mapped, 'brokerDbNumber', redis.brokerDbNumber);
  setIfDefined(mapped, 'backendDbNumber', redis.backendDbNumber);
  setIfDefined(mapped, 'brokerUrl', redis.brokerUrl);
  setIfDefined(mapped, 'backendUrl', redis.backendUrl);

  return mergeSubValues(mapped, redis.values);
}

function mergeSubValues(
  mapped: TypeKroValueTreeObject,
  values: unknown
): DagsterRuntimeValueTree {
  if (values === undefined) return mapped;
  if (isKubernetesRef(values) || isCelExpression(values) || isValuesMergeExpression(values)) {
    return mergeValuesExpression(mapped, values);
  }

  const subValues = asValueObject(values);
  if (subValues) {
    deepMerge(mapped, subValues);
  }

  return mapped;
}

function isEmittableValue(value: DagsterRuntimeValueTree): boolean {
  if (isValuesMergeExpression(value) || isKubernetesRef(value) || isCelExpression(value)) return true;
  return !isMergeObject(value) || Object.keys(value).length > 0;
}

function hasRawPath(values: unknown, key: string): boolean {
  const rawValues = asValueObject(values);
  return rawValues ? rawValues[key] !== undefined : false;
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function setIfDefined(target: TypeKroValueTreeObject, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value as TypeKroValueTree;
  }
}

function copyDefinedObject(source: object | undefined): TypeKroValueTreeObject | undefined {
  if (!source) return undefined;
  if (!isMergeObject(source)) return source as TypeKroValueTreeObject;

  const result: TypeKroValueTreeObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      result[key] = copyDefinedArray(value);
    } else if (isMergeObject(value)) {
      const nested = copyDefinedObject(value);
      if (nested && Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      result[key] = value as TypeKroValueTree;
    }
  }

  return result;
}

function copyDefinedArray(values: readonly unknown[] | undefined): TypeKroValueTree | undefined {
  if (!values) return undefined;
  if (isKubernetesRef(values)) {
    return values;
  }
  if (isCelExpression(values)) {
    return values;
  }

  return values.map((value) => {
    if (Array.isArray(value)) return copyDefinedArray(value) ?? [];
    if (isMergeObject(value)) return copyDefinedObject(value) ?? {};
    return value as TypeKroValueTree;
  });
}

function deepMerge(target: TypeKroValueTreeObject, source: TypeKroValueTreeObject): void {
  const runtimeTarget = target as DagsterRuntimeValueTreeObject;
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = runtimeTarget[key];
    if (isMergeObject(targetValue) && isMergeObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      runtimeTarget[key] = mergeValue(key, targetValue, sourceValue);
    }
  }
}

function mergeValue(key: string, baseValue: unknown, overlayValue: unknown): DagsterRuntimeValueTree {
  if (baseValue === undefined) return overlayValue as DagsterRuntimeValueTree;
  if (overlayValue === undefined) return baseValue as DagsterRuntimeValueTree;

  if (
    (isGraphAwareValue(baseValue) &&
      isGraphAwareValue(overlayValue) &&
      shouldDeepMergeGraphAwareSection(key)) ||
    (isGraphAwareValue(baseValue) && isMergeObject(overlayValue)) ||
    (isMergeObject(baseValue) && isGraphAwareValue(overlayValue)) ||
    isValuesMergeExpression(baseValue) ||
    isValuesMergeExpression(overlayValue)
  ) {
    return mergeValuesExpression(baseValue, overlayValue);
  }

  return overlayValue as DagsterRuntimeValueTree;
}

function shouldDeepMergeGraphAwareSection(key: string): boolean {
  return GRAPH_AWARE_DEEP_MERGE_SECTIONS.has(key);
}

function asValueObject(value: unknown): TypeKroValueTreeObject | undefined {
  return isMergeObject(value) ? (value as TypeKroValueTreeObject) : undefined;
}

function mergeRawValuesLast(
  baseValues: DagsterHelmValues,
  rawValues: unknown
): DagsterMappedHelmValues {
  if (rawValues === undefined) return baseValues;
  if (isKubernetesRef(rawValues) || isCelExpression(rawValues) || isValuesMergeExpression(rawValues)) {
    return createDagsterValuesMerge(baseValues, rawValues);
  }

  const rawValueObject = asValueObject(rawValues);
  if (rawValueObject) {
    deepMerge(baseValues, rawValueObject);
  }

  return baseValues;
}

function createDagsterValuesMerge(
  baseValues: DagsterHelmValues,
  rawValues: unknown
): ValuesMergeExpression {
  if (!isKubernetesRef(rawValues) && !isCelExpression(rawValues) && !isValuesMergeExpression(rawValues)) {
    throw new DagsterConfigurationValidationError(
      'DAGSTER_INVALID_CONFIG',
      'DagsterConfigurationError DAGSTER_INVALID_CONFIG: values',
      {
        issues: [
          {
            code: 'DAGSTER_INVALID_CONFIG',
            path: 'values',
            message: 'Graph-aware raw values merge requires a KubernetesRef, CEL expression, or values merge expression.',
          },
        ],
      }
    );
  }

  return mergeValuesExpression(baseValues, rawValues);
}

function falseWhenValuePresent(value: unknown, schemaPath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (isGraphAwareValue(value) || isValuesMergeExpression(value)) {
    return Cel.expr<boolean>(`${hasSchemaPath(schemaPath)} ? false : omit()`) as boolean;
  }

  return false;
}

function hasSchemaPath(path: string): string {
  const parts = path.split('.');
  const guards: string[] = [];
  for (let index = 2; index < parts.length; index++) {
    guards.push(`has(${parts.slice(0, index + 1).join('.')})`);
  }
  return guards.join(' && ');
}

function isGraphAwareValue(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value);
}

function isMergeObject(value: unknown): value is TypeKroValueTreeObject {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isCelExpression(value) &&
    !isValuesMergeExpression(value)
  );
}
