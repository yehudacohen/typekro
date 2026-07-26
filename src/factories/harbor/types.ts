import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';

const secretRefShape = {
  name: 'string',
  'key?': 'string',
} as const;

const resourceRequirementsShape = {
  'requests?': { 'cpu?': 'string', 'memory?': 'string' },
  'limits?': { 'cpu?': 'string', 'memory?': 'string' },
} as const;

const exposureShape = {
  type: '"ingress" | "clusterIP" | "nodePort" | "loadBalancer"',
  externalUrl: 'string',
  tls: {
    enabled: 'boolean',
    source: '"auto" | "secret" | "cert-manager" | "none"',
    'secretName?': 'string',
  },
  'ingress?': {
    host: 'string',
    'className?': 'string',
    'annotations?': 'Record<string, string>',
  },
  'nodePort?': {
    'http?': '30000 <= number.integer <= 32767',
    'https?': '30000 <= number.integer <= 32767',
  },
} as const;

const certificateShape = {
  secretName: 'string',
  issuerRef: {
    name: 'string',
    'kind?': '"Issuer" | "ClusterIssuer"',
    'group?': 'string',
  },
  'duration?': 'string',
  'renewBefore?': 'string',
} as const;

const s3StorageShape = {
  bucket: 'string',
  region: 'string',
  regionEndpoint: 'string',
  existingSecret: 'string',
  'rootDirectory?': 'string',
  'secure?': 'boolean',
  'skipVerify?': 'boolean',
  'disableRedirect?': 'boolean',
  'caBundleSecretName?': 'string',
} as const;

const externalDatabaseShape = {
  host: 'string',
  'port?': '1 <= number.integer <= 65535',
  username: 'string',
  database: 'string',
  existingSecret: 'string',
  'sslMode?': '"disable" | "require" | "verify-ca" | "verify-full"',
} as const;

const externalCacheShape = {
  address: 'string',
  existingSecret: 'string',
  'username?': 'string',
  'tls?': {
    enabled: 'boolean',
    'caBundleSecretName?': 'string',
  },
} as const;

const componentSecretsShape = {
  encryptionKey: 'string',
  core: 'string',
  jobservice: 'string',
  registry: 'string',
  registryCredentials: 'string',
  'xsrf?': 'string',
} as const;

const internalTlsShape = {
  enabled: 'boolean',
  'certSource?': '"auto" | "secret"',
  'caBundleSecretName?': 'string',
  'coreSecretName?': 'string',
  'jobserviceSecretName?': 'string',
  'registrySecretName?': 'string',
  'portalSecretName?': 'string',
  'trivySecretName?': 'string',
} as const;

const networkPolicyShape = {
  enabled: 'boolean',
  'ingressNamespaceLabels?': 'Record<string, string>',
  'egressNamespaceLabels?': 'Record<string, string>[]',
  'egressCidrs?': 'string[]',
} as const;

const productionNetworkPolicyShape = {
  enabled: 'true',
  ingressNamespaceLabels: 'Record<string, string>',
  egressNamespaceLabels: 'Record<string, string>[]',
  'egressCidrs?': 'string[]',
} as const;

const productionExposureShape = {
  ...exposureShape,
  tls: {
    enabled: 'true',
    source: '"auto" | "secret" | "cert-manager"',
    'secretName?': 'string',
  },
} as const;

const {
  'secure?': _optionalSecure,
  'skipVerify?': _optionalSkipVerify,
  ...productionS3StorageBaseShape
} = s3StorageShape;

const productionS3StorageShape = {
  ...productionS3StorageBaseShape,
  secure: 'true',
  skipVerify: 'false',
} as const;

const harborCommonShape = {
  name: 'string',
  'namespace?': 'string',
  'chartVersion?': 'string',
  'harborVersion?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryNamespaceOwnership?': '"owned" | "external"',
  'repositoryUrl?': 'string',
  'namespaceOwnership?': '"owned" | "external"',
  exposure: exposureShape,
  'certificate?': certificateShape,
  storage: s3StorageShape,
  adminPasswordSecret: secretRefShape,
  componentSecrets: componentSecretsShape,
  'internalTls?': internalTlsShape,
  'caBundleSecretName?': 'string',
  'pvcStorageClassName?': 'string',
  'trivyEnabled?': 'boolean',
  'metricsEnabled?': 'boolean',
  'values?': 'Record<string, unknown>',
} as const;

/** Local Harbor profile. Internal DB/cache are explicit development conveniences. */
export const HarborLocalInstallationConfigSchema = type({
  ...harborCommonShape,
  profile: '"local-development"',
  'database?': externalDatabaseShape,
  'cache?': externalCacheShape,
  'networkPolicy?': networkPolicyShape,
}).narrow((config, ctx) => {
  const collision = findChartOwnedSecretCollision(config);
  return collision === undefined
    ? true
    : ctx.mustBe(`external Secret names distinct from chart-owned Secret ${collision}`);
});
export type HarborLocalInstallationConfig = typeof HarborLocalInstallationConfigSchema.infer;

const {
  exposure: _commonExposure,
  storage: _commonStorage,
  'certificate?': _optionalCertificate,
  ...harborProductionCommonShape
} = harborCommonShape;

/** Production Harbor profile requiring external durable database and cache providers. */
export const HarborProductionInstallationConfigSchema = type({
  ...harborProductionCommonShape,
  profile: '"production"',
  exposure: productionExposureShape,
  certificate: certificateShape,
  storage: productionS3StorageShape,
  database: externalDatabaseShape,
  cache: externalCacheShape,
  networkPolicy: productionNetworkPolicyShape,
  replicas: {
    core: 'number.integer >= 2',
    portal: 'number.integer >= 2',
    registry: 'number.integer >= 2',
    jobservice: 'number.integer >= 2',
    exporter: 'number.integer >= 2',
  },
  resources: {
    core: resourceRequirementsShape,
    portal: resourceRequirementsShape,
    registry: resourceRequirementsShape,
    jobservice: resourceRequirementsShape,
    exporter: resourceRequirementsShape,
  },
}).narrow((config, ctx) => {
  const collision = findChartOwnedSecretCollision(config);
  return collision === undefined
    ? true
    : ctx.mustBe(`external Secret names distinct from chart-owned Secret ${collision}`);
});
export type HarborProductionInstallationConfig =
  typeof HarborProductionInstallationConfigSchema.infer;

export const HarborInstallationStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Installing" | "Ready" | "Failed"',
  endpoint: 'string',
  chartVersion: 'string',
  harborVersion: 'string',
  profile: '"local-development" | "production"',
  tlsEnabled: 'boolean',
  storageReady: 'boolean',
  databaseReady: 'boolean',
  cacheReady: 'boolean',
  networkPolicyReady: 'boolean',
  /** Flux-owned status is nested because KRO owns the root status envelope. */
  release: {
    observedGeneration: 'number.integer >= 0',
    conditions: type({
      type: 'string',
      status: 'string',
      'reason?': 'string',
      'message?': 'string',
      'observedGeneration?': 'number.integer >= 0',
    }).array(),
  },
});
export type HarborInstallationStatus = typeof HarborInstallationStatusSchema.infer;

export const HarborHelmRepositoryConfigSchema = type({
  'name?': 'string',
  'namespace?': 'string',
  'url?': 'string',
  'interval?': 'string',
  'id?': 'string',
});
export type HarborHelmRepositoryConfig = typeof HarborHelmRepositoryConfigSchema.infer;

export const HarborHelmReleaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryUrl?': 'string',
  'values?': 'Record<string, unknown>',
  'id?': 'string',
});
export type HarborHelmReleaseConfig = Omit<typeof HarborHelmReleaseConfigSchema.infer, 'values'> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
};

export interface HarborS3StorageBinding {
  bucket: string;
  region: string;
  regionEndpoint: string;
  existingSecret: string;
  secure: boolean;
  skipVerify: boolean;
}

interface HarborSecretNameConfig {
  name: string;
  storage: { existingSecret: string; caBundleSecretName?: string };
  adminPasswordSecret: { name: string };
  componentSecrets: {
    encryptionKey: string;
    core: string;
    jobservice: string;
    registry: string;
    registryCredentials: string;
    xsrf?: string;
  };
  database?: { existingSecret: string };
  cache?: { existingSecret: string; tls?: { caBundleSecretName?: string } };
  certificate?: { secretName: string };
  caBundleSecretName?: string;
  internalTls?: {
    caBundleSecretName?: string;
    coreSecretName?: string;
    jobserviceSecretName?: string;
    registrySecretName?: string;
    portalSecretName?: string;
    trivySecretName?: string;
  };
}

function findChartOwnedSecretCollision(config: HarborSecretNameConfig): string | undefined {
  const chartOwned = new Set(
    [
      'core',
      'database',
      'exporter',
      'ingress',
      'jobservice',
      'nginx',
      'registry',
      'registryctl',
      'trivy',
    ].map((suffix) => `${config.name}-${suffix}`)
  );
  const externalNames = [
    config.storage.existingSecret,
    config.storage.caBundleSecretName,
    config.adminPasswordSecret.name,
    config.componentSecrets.encryptionKey,
    config.componentSecrets.core,
    config.componentSecrets.jobservice,
    config.componentSecrets.registry,
    config.componentSecrets.registryCredentials,
    config.componentSecrets.xsrf,
    config.database?.existingSecret,
    config.cache?.existingSecret,
    config.cache?.tls?.caBundleSecretName,
    config.certificate?.secretName,
    config.caBundleSecretName,
    config.internalTls?.caBundleSecretName,
    config.internalTls?.coreSecretName,
    config.internalTls?.jobserviceSecretName,
    config.internalTls?.registrySecretName,
    config.internalTls?.portalSecretName,
    config.internalTls?.trivySecretName,
  ];
  return externalNames.find((name): name is string => name !== undefined && chartOwned.has(name));
}
