// Barman Cloud plugin helpers: the workload-identity check on an `ObjectStore`, and the
// fragments that wire a `Cluster`, a `Backup` or `ScheduledBackup`, and a recovery to the plugin.

import { TypeKroError } from '../../../core/errors.js';
import {
  containsCelExpressions,
  containsKubernetesRefs,
  isCelExpression,
  isKubernetesRef,
  isMixedTemplate,
  isResourceReference,
} from '../../../utils/type-guards.js';
import { BARMAN_CLOUD_PLUGIN_NAME } from '../constants.js';
import type { ClusterExternalCluster, ClusterPlugin, PluginConfiguration } from '../types.js';
import { isS3DestinationPath } from './barman-cloud-constraints.js';

// =============================================================================
// WORKLOAD IDENTITY
// =============================================================================

// The guard fails closed. The spec, `configuration`, `s3Credentials` and, when given, `wal`,
// `data`, `instanceSidecarConfiguration` and its `env` entries must be objects written in the
// composition: a schema reference in their place would let an instance add static keys. Only the
// leaves below may come from the composition spec, and `inheritFromIAMRole` must be the literal
// `true`. Static key fields are refused whether concrete or symbolic.

/** `s3Credentials` fields that hold static keys. */
const STATIC_S3_CREDENTIAL_FIELDS = ['accessKeyId', 'secretAccessKey', 'sessionToken'] as const;

/** `s3Credentials` fields besides `inheritFromIAMRole` that may be set: secret references. */
const S3_CREDENTIAL_SECRET_REFERENCES: ReadonlySet<string> = new Set(['region', 'sseCustomerKey']);

/** Environment variables that would hand the sidecar static AWS keys. */
const STATIC_AWS_KEY_ENV = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

/** Fields of each object that may come from the composition spec. */
const SPEC_LEAVES = {
  spec: new Set(['retentionPolicy']),
  configuration: new Set([
    'destinationPath',
    'endpointURL',
    'endpointCA',
    's3AddressingStyle',
    'tags',
    'historyTags',
  ]),
  wal: new Set(['compression', 'encryption', 'maxParallel']),
  data: new Set(['compression', 'encryption', 'jobs', 'immediateCheckpoint']),
  instanceSidecarConfiguration: new Set([
    'logLevel',
    'resources',
    'retentionPolicyIntervalSeconds',
  ]),
  env: new Set(['value', 'valueFrom']),
} satisfies Record<string, ReadonlySet<string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a value is, or contains, something only known per instance. */
function isSymbolic(value: unknown): boolean {
  return (
    isResourceReference(value) ||
    isMixedTemplate(value) ||
    containsKubernetesRefs(value) ||
    containsCelExpressions(value)
  );
}

/**
 * A plain object written in the composition. A schema reference is a function-backed proxy, so
 * it is not one, and neither is a CEL expression.
 */
function isConcreteObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isKubernetesRef(value) &&
    !isResourceReference(value) &&
    !isCelExpression(value)
  );
}

function refuseNotConcrete(where: string): never {
  throw new TypeKroError(
    `${where} of an ObjectStore must be written out in the composition, not taken from the ` +
      'spec: an instance could set static S3 keys through it. Only leaf values such as ' +
      'destinationPath, endpointURL, retentionPolicy or compression may come from the spec.',
    'CNPG_BARMAN_CLOUD_NOT_CONCRETE',
    { where }
  );
}

/** Requires `value` to be a concrete object, refusing it as `where` otherwise. */
function concreteObject(value: unknown, where: string): Record<string, unknown> {
  if (!isConcreteObject(value)) refuseNotConcrete(where);
  return value;
}

/** Fields of each object the guard checks on their own, as concrete objects. */
const NESTED = {
  spec: new Set(['configuration', 'instanceSidecarConfiguration']),
  configuration: new Set(['s3Credentials', 'wal', 'data']),
  instanceSidecarConfiguration: new Set(['env']),
} satisfies Partial<Record<keyof typeof SPEC_LEAVES, ReadonlySet<string>>>;

const NONE: ReadonlySet<string> = new Set();

/**
 * Refuses a field of `object` that is, or contains, a value only known per instance, unless it
 * is one of the allowed spec `leaves` or a `nested` object the guard checks on its own.
 */
function refuseSymbolicFields(
  object: Record<string, unknown>,
  leaves: ReadonlySet<string>,
  where: string,
  nested: ReadonlySet<string> = NONE
): void {
  for (const [key, value] of Object.entries(object)) {
    if (!leaves.has(key) && !nested.has(key) && isSymbolic(value)) {
      refuseNotConcrete(`${where}.${key}`);
    }
  }
}

function refuseStaticCredentials(fields: string[]): never {
  throw new TypeKroError(
    `ObjectStore authenticates to S3 through the pod's workload identity (IRSA or EKS Pod ` +
      `Identity); remove ${fields.join(', ')} and set s3Credentials.inheritFromIAMRole: true.`,
    'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
    { fields }
  );
}

function refuseWithoutWorkloadIdentity(got: string): never {
  throw new TypeKroError(
    'ObjectStore must set s3Credentials.inheritFromIAMRole: true, written in the composition, ' +
      `so barman-cloud uses the pod's workload identity (IRSA or EKS Pod Identity); got ${got}.`,
    'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
    { fields: ['s3Credentials.inheritFromIAMRole'] }
  );
}

/**
 * Throws unless an `ObjectStore` spec reaches S3 only through the pod's workload identity
 * (`s3Credentials.inheritFromIAMRole: true`, with IRSA or EKS Pod Identity).
 *
 * It fails closed: the spec, `configuration` and `s3Credentials` must be objects written in the
 * composition, and so must `wal`, `data`, `instanceSidecarConfiguration` and each of its `env`
 * entries when given (`CNPG_BARMAN_CLOUD_NOT_CONCRETE`). Only leaf values such as
 * `destinationPath`, `endpointURL`, `retentionPolicy`, compression and an env entry's `value`
 * may come from the composition spec. `inheritFromIAMRole` must be the literal `true`, and
 * access keys, session tokens and static AWS key env variables are refused whether concrete or
 * symbolic (`CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS`), as are Azure and Google credentials
 * (`CNPG_BARMAN_CLOUD_NOT_S3`). A concrete `destinationPath` must be `s3://<bucket>/<prefix>`
 * with a valid bucket name (`CNPG_BARMAN_CLOUD_DESTINATION_INVALID`).
 */
export function assertWorkloadIdentityObjectStore(spec: unknown): void {
  const root = concreteObject(spec, 'The spec');
  refuseSymbolicFields(root, SPEC_LEAVES.spec, 'spec', NESTED.spec);
  const configuration = concreteObject(root.configuration, 'spec.configuration');

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
  if (credentials === undefined) refuseWithoutWorkloadIdentity('no s3Credentials');
  const s3Credentials = concreteObject(credentials, 'spec.configuration.s3Credentials');
  const staticFields = STATIC_S3_CREDENTIAL_FIELDS.filter(
    (field) => s3Credentials[field] !== undefined
  ).map((field) => `s3Credentials.${field}`);
  if (staticFields.length > 0) refuseStaticCredentials(staticFields);
  const unknownFields = Object.keys(s3Credentials).filter(
    (key) => key !== 'inheritFromIAMRole' && !S3_CREDENTIAL_SECRET_REFERENCES.has(key)
  );
  if (unknownFields.length > 0) {
    refuseStaticCredentials(unknownFields.map((field) => `s3Credentials.${field}`));
  }
  const inherit = s3Credentials.inheritFromIAMRole;
  if (inherit !== true) {
    refuseWithoutWorkloadIdentity(
      isSymbolic(inherit) ? 'a value only known per instance' : String(JSON.stringify(inherit))
    );
  }

  refuseSymbolicFields(
    configuration,
    SPEC_LEAVES.configuration,
    'spec.configuration',
    NESTED.configuration
  );
  for (const section of ['wal', 'data'] as const) {
    if (configuration[section] === undefined) continue;
    const where = `spec.configuration.${section}`;
    refuseSymbolicFields(
      concreteObject(configuration[section], where),
      SPEC_LEAVES[section],
      where
    );
  }

  if (root.instanceSidecarConfiguration !== undefined) {
    const sidecar = concreteObject(
      root.instanceSidecarConfiguration,
      'spec.instanceSidecarConfiguration'
    );
    refuseSymbolicFields(
      sidecar,
      SPEC_LEAVES.instanceSidecarConfiguration,
      'spec.instanceSidecarConfiguration',
      NESTED.instanceSidecarConfiguration
    );
    if (sidecar.env !== undefined) {
      if (!Array.isArray(sidecar.env)) refuseNotConcrete('spec.instanceSidecarConfiguration.env');
      const keys: string[] = [];
      sidecar.env.forEach((entry: unknown, index: number) => {
        const where = `spec.instanceSidecarConfiguration.env[${index}]`;
        const variable = concreteObject(entry, where);
        refuseSymbolicFields(variable, SPEC_LEAVES.env, where);
        if (typeof variable.name === 'string' && STATIC_AWS_KEY_ENV.includes(variable.name)) {
          keys.push(variable.name);
        }
      });
      if (keys.length > 0) {
        throw new TypeKroError(
          `ObjectStore sidecar env must not carry static AWS keys; remove ${keys.join(', ')}.`,
          'CNPG_BARMAN_CLOUD_STATIC_CREDENTIALS',
          { fields: keys.map((name) => `instanceSidecarConfiguration.env.${name}`) }
        );
      }
    }
  }

  const destination = configuration.destinationPath;
  if (
    !isSymbolic(destination) &&
    !(typeof destination === 'string' && isS3DestinationPath(destination))
  ) {
    throw new TypeKroError(
      `ObjectStore destinationPath must be s3://<bucket>/<prefix> with a valid S3 bucket name ` +
        `and a non-empty prefix; got ${JSON.stringify(destination)}.`,
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
