// Barman Cloud plugin helpers: the workload-identity check on an `ObjectStore`, and the
// fragments that wire a `Cluster`, a `Backup` or `ScheduledBackup`, and a recovery to the plugin.

import { TypeKroError } from '../../../core/errors.js';
import { isCelExpression, isKubernetesRef, isMixedTemplate } from '../../../utils/type-guards.js';
import { BARMAN_CLOUD_PLUGIN_NAME } from '../constants.js';
import type { ClusterExternalCluster, ClusterPlugin, PluginConfiguration } from '../types.js';
import { S3_DESTINATION_PATH } from './barman-cloud-constraints.js';

// =============================================================================
// WORKLOAD IDENTITY
// =============================================================================

/** `s3Credentials` fields that hold static keys. */
const STATIC_S3_CREDENTIAL_FIELDS = ['accessKeyId', 'secretAccessKey', 'sessionToken'] as const;

/** Environment variables that would hand the sidecar static AWS keys. */
const STATIC_AWS_KEY_ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a value only known per instance, which admission checks instead. */
function isSymbolic(value: unknown): boolean {
  return isKubernetesRef(value) || isCelExpression(value) || isMixedTemplate(value);
}

// Refuses access keys and session tokens in `s3Credentials`, static AWS keys in the sidecar's
// `env`, Azure and Google credentials, and a destination that isn't `s3://<bucket>/<prefix>`.
// Values only known per instance pass; the composition's instance schema checks those.

/**
 * Throws unless an `ObjectStore` spec reaches S3 only through the pod's workload identity
 * (`s3Credentials.inheritFromIAMRole: true`, with IRSA or EKS Pod Identity).
 */
export function assertWorkloadIdentityObjectStore(spec: unknown): void {
  const configuration = isRecord(spec) ? spec.configuration : undefined;
  if (!isRecord(configuration)) return;

  for (const provider of ['azureCredentials', 'googleCredentials'] as const) {
    if (configuration[provider] !== undefined) {
      throw new TypeKroError(
        `ObjectStore supports S3 through workload identity only; remove configuration.${provider}.`,
        'CNPG_BARMAN_CLOUD_NOT_S3',
        { field: `configuration.${provider}` }
      );
    }
  }

  const credentials = configuration.s3Credentials;
  if (!isSymbolic(credentials)) {
    const staticFields = isRecord(credentials)
      ? STATIC_S3_CREDENTIAL_FIELDS.filter((field) => credentials[field] !== undefined)
      : [];
    if (staticFields.length > 0) {
      throw new TypeKroError(
        `ObjectStore authenticates to S3 through the pod's workload identity (IRSA or EKS Pod ` +
          `Identity); remove s3Credentials.${staticFields.join(', s3Credentials.')} and set ` +
          's3Credentials.inheritFromIAMRole: true.',
        'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
        { fields: staticFields }
      );
    }
    const inherit = isRecord(credentials) ? credentials.inheritFromIAMRole : undefined;
    if (inherit !== true && !isSymbolic(inherit)) {
      throw new TypeKroError(
        'ObjectStore must set s3Credentials.inheritFromIAMRole: true, so barman-cloud uses the ' +
          "pod's workload identity (IRSA or EKS Pod Identity).",
        'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
        { fields: ['s3Credentials.inheritFromIAMRole'] }
      );
    }
  }

  const env =
    isRecord(spec) && isRecord(spec.instanceSidecarConfiguration)
      ? spec.instanceSidecarConfiguration.env
      : undefined;
  if (Array.isArray(env)) {
    const keys = env
      .map((entry) => (isRecord(entry) ? entry.name : undefined))
      .filter(
        (name): name is string => typeof name === 'string' && STATIC_AWS_KEY_ENV.includes(name)
      );
    if (keys.length > 0) {
      throw new TypeKroError(
        `ObjectStore sidecar env must not carry static AWS keys; remove ${keys.join(', ')}.`,
        'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
        { fields: keys.map((name) => `instanceSidecarConfiguration.env.${name}`) }
      );
    }
  }

  const destination = configuration.destinationPath;
  if (
    typeof destination === 'string' &&
    !isSymbolic(destination) &&
    !S3_DESTINATION_PATH.test(destination)
  ) {
    throw new TypeKroError(
      `ObjectStore destinationPath must be s3://<bucket>/<prefix> with a non-empty bucket and ` +
        `prefix; got ${JSON.stringify(destination)}.`,
      'CNPG_BARMAN_CLOUD_DESTINATION_INVALID',
      { destinationPath: destination }
    );
  }
}

// =============================================================================
// CLUSTER WIRING
// =============================================================================

export interface BarmanCloudPluginOptions {
  /** Name of the `ObjectStore` the cluster archives WAL and base backups to. */
  objectStoreName: string;
  /** Server name in the object store. @default the cluster's name */
  serverName?: string;
  /** Whether this plugin archives the cluster's WAL. @default true */
  isWALArchiver?: boolean;
}

/**
 * The `spec.plugins` entry that archives a cluster's WAL and base backups to an `ObjectStore`.
 */
export function barmanCloudPlugin(options: BarmanCloudPluginOptions): ClusterPlugin {
  return {
    name: BARMAN_CLOUD_PLUGIN_NAME,
    isWALArchiver: options.isWALArchiver ?? true,
    parameters: {
      barmanObjectName: options.objectStoreName,
      ...(options.serverName !== undefined && { serverName: options.serverName }),
    },
  };
}

/**
 * `method` and `pluginConfiguration` for a `Backup` or `ScheduledBackup` taken by the plugin.
 */
export function barmanCloudBackupMethod(): {
  method: 'plugin';
  pluginConfiguration: PluginConfiguration;
} {
  return { method: 'plugin', pluginConfiguration: { name: BARMAN_CLOUD_PLUGIN_NAME } };
}

export interface BarmanCloudRecoveryOptions {
  /** Name of the `externalClusters` entry. @default 'origin' */
  sourceName?: string;
  /** Name of the `ObjectStore` that holds the source's backups. */
  objectStoreName: string;
  /** Server name of the source cluster in that store, usually the source cluster's name. */
  serverName: string;
  /** Point-in-time target. Omit to replay all archived WAL. */
  recoveryTarget?: {
    targetTime?: string;
    targetLSN?: string;
    targetName?: string;
    exclusive?: boolean;
  };
}

/**
 * `bootstrap` and `externalClusters` for a `Cluster` recovered from the plugin's backups.
 *
 * The recovered cluster does not archive WAL unless it also has a {@link barmanCloudPlugin}
 * entry. Give it a different server name (or object store) than the source, so its archive
 * does not overwrite the source's.
 */
export function barmanCloudRecovery(options: BarmanCloudRecoveryOptions): {
  bootstrap: {
    recovery: { source: string; recoveryTarget?: BarmanCloudRecoveryOptions['recoveryTarget'] };
  };
  externalClusters: ClusterExternalCluster[];
} {
  const source = options.sourceName ?? 'origin';
  return {
    bootstrap: {
      recovery: {
        source,
        ...(options.recoveryTarget !== undefined && { recoveryTarget: options.recoveryTarget }),
      },
    },
    externalClusters: [
      {
        name: source,
        plugin: {
          name: BARMAN_CLOUD_PLUGIN_NAME,
          parameters: {
            barmanObjectName: options.objectStoreName,
            serverName: options.serverName,
          },
        },
      },
    ],
  };
}

/**
 * Throws when a `Backup` or `ScheduledBackup` uses `method: 'plugin'` without naming the plugin
 * in `pluginConfiguration`.
 */
export function assertPluginBackupConfigured(spec: unknown, kind: string): void {
  if (!isRecord(spec) || spec.method !== 'plugin') return;
  const configuration = spec.pluginConfiguration;
  if (!isRecord(configuration) || configuration.name === undefined) {
    throw new TypeKroError(
      `${kind} with method "plugin" must name the plugin in pluginConfiguration, for example ` +
        `{ name: '${BARMAN_CLOUD_PLUGIN_NAME}' }.`,
      'CNPG_PLUGIN_BACKUP_UNCONFIGURED',
      { kind }
    );
  }
}
