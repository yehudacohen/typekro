import {
  isValuesMergeExpression,
  mergeValuesExpression,
  type ValuesMergeExpression,
} from '../../../core/aspects/values-merge.js';
import { Cel } from '../../../core/references/cel.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type {
  HarborLocalInstallationConfig,
  HarborProductionInstallationConfig,
} from '../types.js';

export type HarborMappedHelmValues = Record<string, unknown> | ValuesMergeExpression;

/** Official Harbor chart values for the bounded development profile. */
export function mapHarborLocalInstallationToHelmValues(
  config: HarborLocalInstallationConfig
): HarborMappedHelmValues {
  return mergeValuesLast(mapCommonValues(config, 'local-development'), config.values);
}

/** Official Harbor chart values for the HA-oriented production profile. */
export function mapHarborProductionInstallationToHelmValues(
  config: HarborProductionInstallationConfig
): HarborMappedHelmValues {
  const values = mapCommonValues(config, 'production');
  values.database = mapExternalDatabase(config.database);
  values.redis = mapExternalCache(config.cache);

  const components = ['core', 'portal', 'registry', 'jobservice', 'exporter'] as const;
  for (const component of components) {
    values[component] = {
      ...asObject(values[component]),
      replicas: config.replicas[component],
      resources: config.resources[component],
      podDisruptionBudget: { enabled: true, minAvailable: 1 },
    };
  }

  return mergeProductionValues(values, config.values);
}

function mapCommonValues(
  config: HarborLocalInstallationConfig | HarborProductionInstallationConfig,
  profile: 'local-development' | 'production'
): Record<string, unknown> {
  const graphMode = isKubernetesRef(config.name);
  const exposureType = config.exposure.type;
  const tlsSource = graphMode
    ? Cel.expr<'auto' | 'secret' | 'none'>(
        'schema.spec.exposure.tls.source == "cert-manager" ? "secret" : schema.spec.exposure.tls.source'
      )
    : config.exposure.tls.source === 'cert-manager'
      ? 'secret'
      : config.exposure.tls.source;
  const tlsSecretName = graphMode
    ? Cel.expr<string>(
        'schema.spec.exposure.tls.source == "cert-manager" ? schema.spec.certificate.secretName : (has(schema.spec.exposure.tls.secretName) ? schema.spec.exposure.tls.secretName : "")'
      )
    : config.exposure.tls.source === 'cert-manager'
      ? config.certificate?.secretName
      : config.exposure.tls.secretName;
  const storage = config.storage;
  const storageSecure = graphMode
    ? Cel.expr<boolean>('has(schema.spec.storage.secure) ? schema.spec.storage.secure : true')
    : (storage.secure ?? true);
  const storageSkipVerify = graphMode
    ? Cel.expr<boolean>(
        'has(schema.spec.storage.skipVerify) ? schema.spec.storage.skipVerify : false'
      )
    : (storage.skipVerify ?? false);
  const disableRedirect = graphMode
    ? Cel.expr<boolean>(
        'has(schema.spec.storage.disableRedirect) ? schema.spec.storage.disableRedirect : true'
      )
    : (storage.disableRedirect ?? true);
  const trivyEnabled = graphMode
    ? Cel.expr<boolean>('has(schema.spec.trivyEnabled) ? schema.spec.trivyEnabled : true')
    : (config.trivyEnabled ?? true);
  const metricsEnabled = graphMode
    ? Cel.expr<boolean>('has(schema.spec.metricsEnabled) ? schema.spec.metricsEnabled : false')
    : (config.metricsEnabled ?? false);
  const pvcStorageClass = graphMode
    ? Cel.expr<string>(
        'has(schema.spec.pvcStorageClassName) ? schema.spec.pvcStorageClassName : ""'
      )
    : (config.pvcStorageClassName ?? '');

  validateHarborConfig(config, graphMode);

  const values: Record<string, unknown> = {
    expose: {
      type: exposureType,
      tls: {
        enabled: config.exposure.tls.enabled,
        certSource: tlsSource,
        secret: { secretName: tlsSecretName ?? '' },
      },
      ingress: {
        hosts: {
          core: graphMode
            ? Cel.expr<string>(
                'has(schema.spec.exposure.ingress) ? schema.spec.exposure.ingress.host : ""'
              )
            : (config.exposure.ingress?.host ?? ''),
        },
        className: graphMode
          ? Cel.expr<string>(
              'has(schema.spec.exposure.ingress) && has(schema.spec.exposure.ingress.className) ? schema.spec.exposure.ingress.className : ""'
            )
          : (config.exposure.ingress?.className ?? ''),
        annotations: graphMode
          ? Cel.expr<Record<string, string>>(
              'has(schema.spec.exposure.ingress) && has(schema.spec.exposure.ingress.annotations) ? schema.spec.exposure.ingress.annotations : {}'
            )
          : (config.exposure.ingress?.annotations ?? {}),
      },
      nodePort: {
        ports: {
          http: {
            port: 80,
            nodePort: graphMode
              ? Cel.expr<number>(
                  'has(schema.spec.exposure.nodePort) && has(schema.spec.exposure.nodePort.http) ? schema.spec.exposure.nodePort.http : 30002'
                )
              : (config.exposure.nodePort?.http ?? 30002),
          },
          https: {
            port: 443,
            nodePort: graphMode
              ? Cel.expr<number>(
                  'has(schema.spec.exposure.nodePort) && has(schema.spec.exposure.nodePort.https) ? schema.spec.exposure.nodePort.https : 30003'
                )
              : (config.exposure.nodePort?.https ?? 30003),
          },
        },
      },
    },
    externalURL: config.exposure.externalUrl,
    persistence: {
      enabled: true,
      resourcePolicy: 'keep',
      persistentVolumeClaim: {
        database: { storageClass: pvcStorageClass },
        redis: { storageClass: pvcStorageClass },
        trivy: { storageClass: pvcStorageClass },
      },
      imageChartStorage: {
        type: 's3',
        disableredirect: disableRedirect,
        ...(storage.caBundleSecretName ? { caBundleSecretName: storage.caBundleSecretName } : {}),
        s3: {
          existingSecret: storage.existingSecret,
          region: storage.region,
          regionendpoint: storage.regionEndpoint,
          bucket: storage.bucket,
          secure: storageSecure,
          skipverify: storageSkipVerify,
          v4auth: true,
          ...(storage.rootDirectory ? { rootdirectory: storage.rootDirectory } : {}),
        },
      },
    },
    existingSecretAdminPassword: config.adminPasswordSecret.name,
    existingSecretAdminPasswordKey: graphMode
      ? Cel.expr<string>(
          'has(schema.spec.adminPasswordSecret.key) ? schema.spec.adminPasswordSecret.key : "HARBOR_ADMIN_PASSWORD"'
        )
      : (config.adminPasswordSecret.key ?? 'HARBOR_ADMIN_PASSWORD'),
    existingSecretSecretKey: config.componentSecrets.encryptionKey,
    core: {
      existingSecret: config.componentSecrets.core,
      ...(config.componentSecrets.xsrf ? { existingXsrfSecret: config.componentSecrets.xsrf } : {}),
    },
    jobservice: {
      existingSecret: config.componentSecrets.jobservice,
      jobLoggers: ['database'],
    },
    registry: {
      existingSecret: config.componentSecrets.registry,
      credentials: { existingSecret: config.componentSecrets.registryCredentials },
    },
    trivy: { enabled: trivyEnabled },
    metrics: { enabled: metricsEnabled },
    ...(config.caBundleSecretName ? { caBundleSecretName: config.caBundleSecretName } : {}),
    internalTLS: mapInternalTls(config, graphMode),
  };

  if (profile === 'local-development') {
    values.database = graphMode
      ? {
          type: Cel.expr<string>('has(schema.spec.database) ? "external" : "internal"'),
          external: mapExternalDatabase(config.database, graphMode).external,
        }
      : config.database
        ? mapExternalDatabase(config.database)
        : { type: 'internal' };
    values.redis = graphMode
      ? {
          type: Cel.expr<string>('has(schema.spec.cache) ? "external" : "internal"'),
          external: mapExternalCache(config.cache, graphMode).external,
        }
      : config.cache
        ? mapExternalCache(config.cache)
        : { type: 'internal' };
  }

  return values;
}

function mapExternalDatabase(
  database:
    | HarborLocalInstallationConfig['database']
    | HarborProductionInstallationConfig['database'],
  graphMode = false
): Record<string, unknown> {
  if (!database && !graphMode) return { type: 'internal' };
  return {
    type: 'external',
    external: {
      host: database?.host,
      port: graphMode
        ? Cel.expr<string>(
            'string(has(schema.spec.database) && has(schema.spec.database.port) ? schema.spec.database.port : 5432)'
          )
        : String(database?.port ?? 5432),
      username: database?.username,
      coreDatabase: database?.database,
      existingSecret: database?.existingSecret,
      sslmode: graphMode
        ? Cel.expr<string>(
            'has(schema.spec.database) && has(schema.spec.database.sslMode) ? schema.spec.database.sslMode : "require"'
          )
        : (database?.sslMode ?? 'require'),
    },
  };
}

function mapExternalCache(
  cache: HarborLocalInstallationConfig['cache'] | HarborProductionInstallationConfig['cache'],
  graphMode = false
): Record<string, unknown> {
  if (!cache && !graphMode) return { type: 'internal' };
  return {
    type: 'external',
    external: {
      addr: cache?.address,
      username: graphMode
        ? Cel.expr<string>(
            'has(schema.spec.cache) && has(schema.spec.cache.username) ? schema.spec.cache.username : ""'
          )
        : (cache?.username ?? ''),
      existingSecret: cache?.existingSecret,
      coreDatabaseIndex: '0',
      jobserviceDatabaseIndex: '1',
      registryDatabaseIndex: '2',
      trivyAdapterIndex: '5',
      tlsOptions: {
        enable: graphMode
          ? Cel.expr<boolean>(
              'has(schema.spec.cache) && has(schema.spec.cache.tls) ? schema.spec.cache.tls.enabled : false'
            )
          : (cache?.tls?.enabled ?? false),
        ...(cache?.tls?.caBundleSecretName
          ? { caBundleSecretName: cache.tls.caBundleSecretName }
          : {}),
      },
    },
  };
}

function mapInternalTls(
  config: HarborLocalInstallationConfig | HarborProductionInstallationConfig,
  graphMode: boolean
): Record<string, unknown> {
  const internal = config.internalTls;
  return {
    enabled: graphMode
      ? Cel.expr<boolean>('has(schema.spec.internalTls) ? schema.spec.internalTls.enabled : false')
      : (internal?.enabled ?? false),
    certSource: graphMode
      ? Cel.expr<string>(
          'has(schema.spec.internalTls) && has(schema.spec.internalTls.certSource) ? schema.spec.internalTls.certSource : "auto"'
        )
      : (internal?.certSource ?? 'auto'),
    ...(internal?.coreSecretName ? { core: { secretName: internal.coreSecretName } } : {}),
    ...(internal?.jobserviceSecretName
      ? { jobservice: { secretName: internal.jobserviceSecretName } }
      : {}),
    ...(internal?.registrySecretName
      ? { registry: { secretName: internal.registrySecretName } }
      : {}),
    ...(internal?.portalSecretName ? { portal: { secretName: internal.portalSecretName } } : {}),
    ...(internal?.trivySecretName ? { trivy: { secretName: internal.trivySecretName } } : {}),
  };
}

function validateHarborConfig(
  config: HarborLocalInstallationConfig | HarborProductionInstallationConfig,
  graphMode: boolean
): void {
  if (graphMode) return;
  if (config.exposure.type === 'ingress' && !config.exposure.ingress?.host) {
    throw new Error('Harbor ingress exposure requires exposure.ingress.host.');
  }
  if (
    (config.exposure.tls.source === 'secret' && !config.exposure.tls.secretName) ||
    (config.exposure.tls.source === 'cert-manager' && !config.certificate?.secretName)
  ) {
    throw new Error(
      'Harbor TLS source secret/cert-manager requires the corresponding Secret name.'
    );
  }
  if (config.exposure.tls.enabled && config.exposure.tls.source === 'none') {
    throw new Error('Harbor TLS cannot be enabled while its certificate source is none.');
  }
  if (config.profile === 'production') {
    if (!config.exposure.tls.enabled) {
      throw new Error('Production Harbor requires TLS exposure.');
    }
    if (config.storage.skipVerify) {
      throw new Error('Production Harbor cannot skip S3 certificate verification.');
    }
    if (!config.networkPolicy.enabled) {
      throw new Error('Production Harbor requires an enabled NetworkPolicy contract.');
    }
    if (Object.keys(config.networkPolicy.ingressNamespaceLabels).length === 0) {
      throw new Error(
        'Production Harbor NetworkPolicy requires ingress controller namespace labels.'
      );
    }
    if (
      config.networkPolicy.egressNamespaceLabels.length === 0 &&
      !config.networkPolicy.egressCidrs?.length
    ) {
      throw new Error(
        'Production Harbor NetworkPolicy must declare provider namespaces or explicit egress CIDRs.'
      );
    }
  }
}

function mergeValuesLast(
  base: Record<string, unknown>,
  overrides: unknown
): HarborMappedHelmValues {
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

/**
 * Preserve production escape-hatch additions without allowing them to weaken
 * the typed availability, credential, TLS, storage, or network contract.
 * Local development intentionally retains chart-values-last behavior.
 */
function mergeProductionValues(
  protectedValues: Record<string, unknown>,
  overrides: unknown
): HarborMappedHelmValues {
  if (overrides === undefined) return protectedValues;
  if (
    isKubernetesRef(overrides) ||
    isCelExpression(overrides) ||
    isValuesMergeExpression(overrides)
  ) {
    return mergeValuesExpression(overrides, protectedValues);
  }
  if (!isPlainObject(overrides)) return protectedValues;
  const merged = cloneValue(overrides) as Record<string, unknown>;
  deepMerge(merged, protectedValues);
  return merged;
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
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

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)])
    );
  }
  return value;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = cloneValue(sourceValue);
    }
  }
}
