import { type } from 'arktype';
import type { TypeKroChartValue } from '../../core/types/common.js';

const externalSecretShape = {
  name: 'string',
} as const;

/**
 * The value is used as both the KRO instance name and as the prefix of
 * `<name>-typekro-metadata`. Reserving the suffix keeps every generated
 * Kubernetes name within the DNS-1123 label limit.
 */
const HatchetInstanceNameSchema = type(
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/,
).and('string <= 46');

/**
 * External PostgreSQL authority consumed by Hatchet.
 *
 * The referenced Secret must live in the Hatchet namespace and contain a
 * `DATABASE_URL` key. It remains outside the ResourceGraphDefinition.
 */
const externalDatabaseShape = {
  connectionSecret: externalSecretShape,
} as const;

export const HatchetInstallationConfigSchema = type({
  /**
   * TypeKro instance identity. The upstream Helm release remains the fixed
   * internal name `hatchet` because its recovery Secret names are
   * namespace-global.
   */
  name: HatchetInstanceNameSchema,
  'namespace?': 'string',
  'namespaceOwnership?': '"owned" | "external"',
  'chartVersion?': 'string',
  'serverVersion?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryNamespaceOwnership?': '"owned" | "external"',
  'repositoryUrl?': 'string',
  database: externalDatabaseShape,
  adminCredentialsSecret: externalSecretShape,
  'replicas?': {
    'api?': 'number.integer >= 1',
    'engine?': 'number.integer >= 1',
    'frontend?': 'number.integer >= 1',
  },
  'dashboard?': 'boolean',
  'serverUrl?': 'string',
  'cookieDomain?': 'string',
  'cookieInsecure?': 'boolean',
  'grpcBroadcastAddress?': 'string',
  'grpcInsecure?': 'boolean',
  'workerTokenJob?': 'boolean',
  'values?': 'Record<string, unknown>',
});

export type HatchetInstallationConfig = Omit<
  typeof HatchetInstallationConfigSchema.infer,
  'values'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
};

export const HatchetInstallationStatusSchema = type({
  ready: 'boolean',
  failed: 'boolean',
  phase: '"Installing" | "Ready" | "Failed"',
  chartVersion: 'string',
  serverVersion: 'string',
  endpoint: 'string',
  grpcEndpoint: 'string',
  configurationSecret: 'string',
  workerTokenSecret: 'string',
  dashboardEnabled: 'boolean',
});

export type HatchetInstallationStatus = typeof HatchetInstallationStatusSchema.infer;

export const HatchetHelmRepositoryConfigSchema = type({
  'name?': 'string',
  'namespace?': 'string',
  'url?': 'string',
  'interval?': 'string',
  'id?': 'string',
});

export type HatchetHelmRepositoryConfig = typeof HatchetHelmRepositoryConfigSchema.infer;

export interface HatchetValuesFromSource {
  kind: 'Secret' | 'ConfigMap';
  name: string;
  valuesKey?: string;
  targetPath?: string;
  optional?: boolean;
}

export const HatchetHelmReleaseConfigSchema = type({
  name: 'string',
  'namespace?': 'string',
  'version?': 'string',
  'repositoryName?': 'string',
  'repositoryNamespace?': 'string',
  'repositoryUrl?': 'string',
  'values?': 'Record<string, unknown>',
  'valuesFrom?': type({
    kind: '"Secret" | "ConfigMap"',
    name: 'string',
    'valuesKey?': 'string',
    'targetPath?': 'string',
    'optional?': 'boolean',
  }).array(),
  'id?': 'string',
});

export type HatchetHelmReleaseConfig = Omit<
  typeof HatchetHelmReleaseConfigSchema.infer,
  'values'
> & {
  values?: TypeKroChartValue<Record<string, unknown>>;
};
