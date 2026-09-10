/**
 * S3-backed ClickHouse storage compilation.
 *
 * Compiles the typed `storage` discriminated union into the three things the
 * Altinity operator needs to make a ClickHouse cluster keep its data in object
 * storage with only a local cache on the node:
 *
 * 1. a `storage_configuration` XML document dropped into the CHI's
 *    `configuration.files` under `config.d/storage.xml` (disks + policies),
 * 2. the `merge_tree/storage_policy` default in `configuration.settings`, so
 *    tables created by OTHER tooling (HyperDX/OTel goose migrations, SigNoz)
 *    land on object storage with NO per-table DDL, and
 * 3. the pod-template patch that gives the server its credentials — an
 *    IRSA-annotated ServiceAccount plus `use_environment_credentials`, or
 *    Secret-backed env vars referenced from the XML with `from_env`.
 *
 * ## Two disk types, two DIFFERENT durability stories
 *
 * The distinction is the whole point of the discriminated `diskType` — a
 * boolean `s3: true` would hide it:
 *
 * - `s3` (classic): part METADATA lives on the local disk; only the part data
 *   goes to the bucket. The bucket is NOT self-describing — losing the node
 *   loses the map to the objects. Durability comes from backups, which is why
 *   `backup` exists.
 * - `s3_plain_rewritable`: metadata lives in the bucket, so the bucket IS
 *   self-describing and node loss is a restart + re-attach. The cost is hard
 *   engine restrictions (see below).
 *
 * ## `s3_plain_rewritable` restrictions (verified against the ClickHouse docs)
 *
 * `s3_plain_rewritable` arrived in 24.4, and from **24.5** any object-storage
 * disk can be configured with the `plain_rewritable` metadata type — the
 * explicit `type: object_storage` + `object_storage_type: s3` +
 * `metadata_type: plain_rewritable` form this module emits. It executes merges
 * and supports `INSERT`, but the ClickHouse documentation is explicit that
 * **mutations and table replication are NOT supported**. So:
 * - single replica only (the factory rejects `replicas > 1`),
 * - no `ALTER ... UPDATE/DELETE`, no lightweight deletes,
 * - `ALTER TABLE ... MODIFY TTL` must be issued with
 *   `materialize_ttl_after_modify = 0` (the materialization step is a
 *   mutation); TTL-driven part expiry itself runs in merges and works.
 *
 * @see https://clickhouse.com/docs/operations/storing-data
 */

import { containsKubernetesRefs } from '../../../utils/type-guards.js';
import type {
  ClickHouseInstallationStorage,
  ClickHouseS3BackupOptions,
  ClickHouseS3StorageOptions,
  ClickHouseStorageTopology,
} from '../types.js';
import { assertClickHouseIdentifier } from './validation.js';
import { xmlAttr, xmlText } from './xml.js';

/**
 * Deeply loosen optional properties so a `Composable<T>` value — where TypeKro's
 * proxy mapping turns `x?: T` into `x: T | undefined` — assigns under
 * `exactOptionalPropertyTypes`.
 */
type Loosen<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { readonly [K in keyof T]?: Loosen<T[K]> | undefined }
      : T;

/**
 * Storage input accepted by {@link resolveClickHouseStorage}: either the full
 * installation storage (local volume sizing + mode) or the build-time topology
 * alone (`makeClickHouseCluster` resolves it before the runtime `size` exists).
 *
 * Every field is loosened to optional because this function's whole job is to
 * validate the shape at runtime — the type is a convenience, not the contract.
 */
export type ClickHouseStorageInput =
  | Loosen<ClickHouseInstallationStorage>
  | Loosen<ClickHouseStorageTopology>;

// ============================================================================
// Defaults and well-known names
// ============================================================================

/** Default MergeTree storage policy name created for S3-backed clusters. */
export const DEFAULT_S3_POLICY_NAME = 's3_main';

/** Disk name of the raw object-storage disk inside `storage_configuration`. */
export const S3_DISK_NAME = 's3';

/** Disk name of the local read-through cache wrapping {@link S3_DISK_NAME}. */
export const S3_CACHE_DISK_NAME = 's3_cache';

/** Volume name inside the generated storage policy. */
export const S3_POLICY_VOLUME_NAME = 'main';

/**
 * Default filesystem path of the local cache. It sits UNDER the operator's
 * data volume mount (`/var/lib/clickhouse`), so the thin local PVC declared by
 * `storage.size` backs the cache without an extra volume.
 */
export const DEFAULT_S3_CACHE_PATH = '/var/lib/clickhouse/disks/s3_cache/';

/** CHI `configuration.files` key for the rendered storage configuration. */
export const CHI_STORAGE_CONFIG_FILE = 'config.d/storage.xml';

/** CHI `configuration.settings` key that makes the S3 policy the default. */
export const MERGE_TREE_STORAGE_POLICY_SETTING = 'merge_tree/storage_policy';

/** Env var name the rendered XML reads the access key id from. */
export const S3_ACCESS_KEY_ID_ENV = 'CLICKHOUSE_S3_ACCESS_KEY_ID';

/** Env var name the rendered XML reads the secret access key from. */
export const S3_SECRET_ACCESS_KEY_ENV = 'CLICKHOUSE_S3_SECRET_ACCESS_KEY';

/** Default Secret key holding the access key id. */
export const DEFAULT_ACCESS_KEY_ID_SECRET_KEY = 'AWS_ACCESS_KEY_ID';

/** Default Secret key holding the secret access key. */
export const DEFAULT_SECRET_ACCESS_KEY_SECRET_KEY = 'AWS_SECRET_ACCESS_KEY';

/** IRSA annotation the EKS pod identity webhook keys off. */
export const IRSA_ROLE_ARN_ANNOTATION = 'eks.amazonaws.com/role-arn';

/** Default object-key prefix for scheduled backups. */
export const DEFAULT_BACKUP_PREFIX = 'backups';

/** Default database backed up by the generated backup CronJob. */
export const DEFAULT_BACKUP_DATABASE = 'default';

/** `<s3>` credential section name used by `BACKUP ... TO S3(...)`. */
export const S3_BACKUP_CONFIG_SECTION = 'backup';

/**
 * Characters a custom `storage.endpoint` may use.
 *
 * The unreserved + reserved sets of RFC 3986 MINUS the characters that are an
 * injection somewhere downstream rather than a malformed URL — `&`, `'`, `"`,
 * `<`, `>` and a backslash. Whitespace and control characters are excluded by
 * construction, since the pattern is an allow-list; so is non-ASCII, which
 * means an internationalized host must be passed in its punycode form.
 */
const ENDPOINT_URL_CHARACTERS = /^[A-Za-z0-9._~:/?#@!$()*+,;=%[\]-]+$/;

/**
 * Minimum ClickHouse version this factory accepts for
 * `diskType: 's3_plain_rewritable'`.
 *
 * 24.4 introduced the `s3_plain_rewritable` disk; 24.5 generalized it to the
 * `metadata_type: plain_rewritable` form emitted here, so 24.5 is the floor.
 */
export const MIN_S3_PLAIN_REWRITABLE_VERSION = '24.5';

/** Keys that only ever make sense on the `s3` storage mode. */
const S3_ONLY_STORAGE_KEYS = [
  'bucket',
  'prefix',
  'region',
  'endpoint',
  'diskType',
  'cache',
  'policyName',
  'auth',
  'backup',
] as const;

// ============================================================================
// Resolved shapes
// ============================================================================

/** Credentials as resolved for rendering (never carries key material). */
export type ResolvedClickHouseS3Auth =
  | { readonly kind: 'irsa'; readonly roleArn: string; readonly serviceAccountName?: string }
  | {
      readonly kind: 'secretRef';
      readonly secretName: string;
      readonly accessKeyIdKey: string;
      readonly secretAccessKeyKey: string;
    };

/** Backup schedule with every default applied. */
export interface ResolvedClickHouseS3Backup {
  readonly schedule: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly database: string;
  /** Backup object-key base URL (`.../<prefix>/`), used by `BACKUP TO S3`. */
  readonly endpointUrl: string;
  /** Days of backups to keep; `undefined` means keep everything. */
  readonly retentionDays?: number;
  readonly auth?: {
    readonly secretName: string;
    readonly usernameKey: string;
    readonly passwordKey: string;
  };
}

/** Fully defaulted, validated S3 storage configuration. */
export interface ResolvedClickHouseS3Storage {
  readonly mode: 's3';
  readonly bucket: string;
  /** Normalized key prefix without leading/trailing slashes ('' when absent). */
  readonly prefix: string;
  readonly region?: string;
  /** Custom S3-compatible base endpoint (MinIO); undefined for real AWS. */
  readonly endpoint?: string;
  readonly diskType: 's3' | 's3_plain_rewritable';
  readonly policyName: string;
  readonly cacheMaxSizeBytes: number;
  readonly cachePath: string;
  readonly auth: ResolvedClickHouseS3Auth;
  /** Disk endpoint URL, always with a trailing slash. */
  readonly endpointUrl: string;
  readonly backup?: ResolvedClickHouseS3Backup;
}

/** Fully defaulted, validated PVC storage configuration (today's behaviour). */
export interface ResolvedClickHousePvcStorage {
  readonly mode: 'pvc';
}

/** Discriminated resolution of the `storage` input. */
export type ResolvedClickHouseStorage = ResolvedClickHousePvcStorage | ResolvedClickHouseS3Storage;

// ============================================================================
// Small validated parsers
// ============================================================================

/**
 * Byte multiplier per Kubernetes quantity suffix.
 *
 * A `Map` rather than an object literal: the suffix is taken from CALLER input,
 * and an object lookup keyed on caller input reads `Object.prototype` on a miss
 * (`'constructor'`, `'__proto__'`), returning something that is not a number
 * and is not `undefined` either. The regex in {@link parseByteQuantity} already
 * bounds the suffix to this exact set, so the two guards are independent — the
 * lookup does not depend on the pattern staying that tight.
 */
const BYTE_SUFFIXES = new Map<string, number>([
  ['', 1],
  ['k', 1000],
  ['K', 1000],
  ['M', 1000 ** 2],
  ['G', 1000 ** 3],
  ['T', 1000 ** 4],
  ['Ki', 1024],
  ['Mi', 1024 ** 2],
  ['Gi', 1024 ** 3],
  ['Ti', 1024 ** 4],
]);

/**
 * Parse a Kubernetes-style quantity into bytes.
 *
 * ClickHouse's cache `max_size` wants a byte count, while every other size in
 * this factory family is a Kubernetes quantity — so the input stays a quantity
 * and the conversion happens here (loudly) instead of the caller guessing.
 *
 * @param context - Entry point name for the error message
 * @param field - Offending field path (e.g. `storage.cache.size`)
 * @param value - Quantity string such as `'100Gi'`, `'50G'`, or `'1048576'`
 * @returns The value in bytes
 * @throws Error when the quantity cannot be parsed or is not positive
 */
export function parseByteQuantity(context: string, field: string, value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(|k|K|M|G|T|Ki|Mi|Gi|Ti)$/.exec(value.trim());
  const suffix = match?.[2];
  const digits = match?.[1];
  if (digits === undefined || suffix === undefined) {
    throw new Error(
      `${context}: '${field}' must be a Kubernetes-style byte quantity ` +
        `(e.g. '100Gi', '50G', '1048576') — got ${JSON.stringify(value)}.`
    );
  }
  const bytes = Math.floor(Number(digits) * (BYTE_SUFFIXES.get(suffix) ?? 1));
  if (!Number.isFinite(bytes) || bytes < 1) {
    throw new Error(
      `${context}: '${field}' must resolve to at least one byte — got ${JSON.stringify(value)}.`
    );
  }
  return bytes;
}

/**
 * Extract `{ major, minor }` from a ClickHouse version tag.
 *
 * Returns `undefined` for tags this function cannot read (`'latest'`, a digest
 * pin, a schema reference) so callers can skip version gating rather than
 * reject a legitimate but unparseable pin.
 */
export function parseClickHouseVersion(
  version: unknown
): { major: number; minor: number } | undefined {
  if (typeof version !== 'string') return undefined;
  const match = /^v?([0-9]{1,4})\.([0-9]{1,4})(?:[._-].*)?$/.exec(version.trim());
  const major = match?.[1];
  const minor = match?.[2];
  if (major === undefined || minor === undefined) return undefined;
  return { major: Number(major), minor: Number(minor) };
}

/**
 * Assert the server version can run `s3_plain_rewritable` MergeTree writes.
 *
 * @param context - Entry point name for the error message
 * @param version - The configured ClickHouse server version tag
 * @throws Error when the parsed version is below
 *   {@link MIN_S3_PLAIN_REWRITABLE_VERSION}
 */
export function assertS3PlainRewritableVersion(context: string, version: unknown): void {
  const parsed = parseClickHouseVersion(version);
  if (parsed === undefined) return;
  const floor = parseClickHouseVersion(MIN_S3_PLAIN_REWRITABLE_VERSION);
  if (floor === undefined) return;
  const below =
    parsed.major < floor.major || (parsed.major === floor.major && parsed.minor < floor.minor);
  if (below) {
    throw new Error(
      `${context}: storage.diskType 's3_plain_rewritable' requires ClickHouse ` +
        `>= ${MIN_S3_PLAIN_REWRITABLE_VERSION} (got '${String(version)}'). The ` +
        `metadata_type: plain_rewritable form this factory emits was generalized in ` +
        `24.5; earlier servers cannot run MergeTree writes/merges on it. Use ` +
        `diskType: 's3' with a backup schedule on older servers.`
    );
  }
}

// ============================================================================
// Storage resolution
// ============================================================================

/** True when the storage input selects the object-storage mode. */
export function isS3Storage(
  storage: ClickHouseStorageInput
): storage is ClickHouseStorageInput & ClickHouseS3StorageOptions {
  return (storage as { mode?: string }).mode === 's3';
}

function normalizePrefix(context: string, prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.includes('//')) {
    throw new Error(
      `${context}: 'storage.prefix' must not contain empty path segments — got ` +
        `${JSON.stringify(prefix)}.`
    );
  }
  return trimmed;
}

function buildEndpointUrl(
  context: string,
  bucket: string,
  prefix: string,
  region: string | undefined,
  endpoint: string | undefined
): string {
  const suffix = prefix === '' ? '' : `${prefix}/`;
  if (endpoint !== undefined) {
    if (!/^https?:\/\//.test(endpoint)) {
      throw new Error(
        `${context}: 'storage.endpoint' must be an absolute http(s) URL of the ` +
          `S3-compatible service (e.g. 'http://minio.minio.svc.cluster.local:9000') — got ` +
          `${JSON.stringify(endpoint)}. The bucket and prefix are appended by the factory, ` +
          `so do not include them here.`
      );
    }
    // Beyond "is a URL": an ALLOW-LIST of the characters RFC 3986 actually
    // permits, because this value lands in two places with two different
    // injection stories — `<endpoint>` text in `config.d/storage.xml` (escaped
    // on the way out, but a raw newline there is still a silent value change),
    // and the `BACKUP … TO S3('<url>')` string literal the backup CronJob
    // builds, where a quote is extra SQL rather than a bad URL. Constraining
    // the input is cheaper to reason about than escaping correctly for both.
    if (!ENDPOINT_URL_CHARACTERS.test(endpoint)) {
      throw new Error(
        `${context}: 'storage.endpoint' must use only URL characters matching ` +
          `${ENDPOINT_URL_CHARACTERS.source} — no whitespace, quotes, angle brackets, '&', ` +
          `backslash or control characters (got ${JSON.stringify(endpoint)}). The value is ` +
          `rendered into the server's storage XML and into the ` +
          `\`BACKUP … TO S3('<url>')\` string literal of the generated CronJob, and none of ` +
          `those characters belong in a URL.`
      );
    }
    // Path-style addressing: MinIO and most S3-compatible services serve
    // virtual-hosted-style only behind extra DNS configuration.
    return `${endpoint.replace(/\/+$/, '')}/${bucket}/${suffix}`;
  }
  if (region === undefined || region.trim() === '') {
    throw new Error(
      `${context}: 'storage.region' is required for AWS S3 (it forms the disk endpoint ` +
        `https://<bucket>.s3.<region>.amazonaws.com/<prefix>/). Set 'storage.endpoint' ` +
        `instead when targeting a custom S3-compatible service such as MinIO.`
    );
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${suffix}`;
}

function resolveAuth(context: string, auth: unknown): ResolvedClickHouseS3Auth {
  if (auth === null || typeof auth !== 'object') {
    throw new Error(
      `${context}: 'storage.auth' is required in S3 mode — use ` +
        `{ irsa: { roleArn } } on EKS or { secretRef: { name } } elsewhere. Access keys are ` +
        `never accepted inline.`
    );
  }
  const irsa = (auth as { irsa?: { roleArn?: string; serviceAccountName?: string } }).irsa;
  const secretRef = (
    auth as {
      secretRef?: { name?: string; accessKeyIdKey?: string; secretAccessKeyKey?: string };
    }
  ).secretRef;

  if (irsa !== undefined && secretRef !== undefined) {
    throw new Error(
      `${context}: 'storage.auth' accepts exactly one credential transport — got both ` +
        `'irsa' and 'secretRef'.`
    );
  }
  if (irsa !== undefined) {
    if (typeof irsa.roleArn !== 'string' || irsa.roleArn.trim() === '') {
      throw new Error(`${context}: 'storage.auth.irsa.roleArn' is required and must be a string.`);
    }
    return {
      kind: 'irsa',
      roleArn: irsa.roleArn,
      ...(irsa.serviceAccountName !== undefined && {
        serviceAccountName: irsa.serviceAccountName,
      }),
    };
  }
  if (secretRef !== undefined) {
    if (typeof secretRef.name !== 'string' || secretRef.name.trim() === '') {
      throw new Error(`${context}: 'storage.auth.secretRef.name' is required.`);
    }
    return {
      kind: 'secretRef',
      secretName: secretRef.name,
      accessKeyIdKey: secretRef.accessKeyIdKey ?? DEFAULT_ACCESS_KEY_ID_SECRET_KEY,
      secretAccessKeyKey: secretRef.secretAccessKeyKey ?? DEFAULT_SECRET_ACCESS_KEY_SECRET_KEY,
    };
  }
  throw new Error(
    `${context}: 'storage.auth' is required in S3 mode — use ` +
      `{ irsa: { roleArn } } on EKS or { secretRef: { name } } elsewhere. Access keys are ` +
      `never accepted inline.`
  );
}

function resolveBackup(
  context: string,
  backup: Loosen<ClickHouseS3BackupOptions>,
  diskBucket: string,
  region: string | undefined,
  endpoint: string | undefined
): ResolvedClickHouseS3Backup {
  if (typeof backup.schedule !== 'string' || backup.schedule.trim() === '') {
    throw new Error(
      `${context}: 'storage.backup.schedule' is required and must be a cron expression ` +
        `(e.g. '0 2 * * *').`
    );
  }
  let retentionDays: number | undefined;
  if (backup.retention !== undefined) {
    const days = backup.retention.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1) {
      throw new Error(
        `${context}: 'storage.backup.retention.days' must be a positive integer (got ` +
          `${JSON.stringify(days)}).`
      );
    }
    retentionDays = days;
  }
  const database = backup.database ?? DEFAULT_BACKUP_DATABASE;
  // The generated CronJob interpolates this into a `BACKUP DATABASE <db>`
  // statement, so it must be a bare SQL identifier — validated here so the
  // script never needs quoting and cannot be turned into extra SQL.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error(
      `${context}: 'storage.backup.database' must be a bare SQL identifier ` +
        `(letters, digits and underscores, not starting with a digit) — got ` +
        `${JSON.stringify(database)}.`
    );
  }
  const bucket = backup.bucket ?? diskBucket;
  const prefix = normalizePrefix(context, backup.prefix ?? DEFAULT_BACKUP_PREFIX);
  if (prefix === '') {
    throw new Error(
      `${context}: 'storage.backup.prefix' must be a non-empty key prefix — backups must not ` +
        `share the bucket root with the data disk.`
    );
  }
  const secretRef = backup.auth?.secretRef;
  if (
    backup.auth !== undefined &&
    (secretRef === undefined || typeof secretRef.name !== 'string')
  ) {
    throw new Error(
      `${context}: 'storage.backup.auth' requires 'secretRef.name' — the CronJob reads the ` +
        `ClickHouse user and password from that Secret.`
    );
  }

  return {
    schedule: backup.schedule,
    bucket,
    prefix,
    database,
    endpointUrl: buildEndpointUrl(context, bucket, prefix, region, endpoint),
    ...(retentionDays !== undefined && { retentionDays }),
    ...(secretRef !== undefined &&
      typeof secretRef.name === 'string' && {
        auth: {
          secretName: secretRef.name,
          usernameKey: secretRef.usernameKey ?? 'username',
          passwordKey: secretRef.passwordKey ?? 'password',
        },
      }),
  };
}

/**
 * Resolve and validate the `storage` input into a discriminated result.
 *
 * The S3 branch is BUILD-TIME data: it compiles into an XML document and
 * selects which resources exist (ServiceAccount, backup CronJob), so a schema
 * reference anywhere inside it can never serialize — this function rejects one
 * loudly rather than emitting `__KUBERNETES_REF__` markers into server config.
 *
 * @param context - Entry point name used in every error message
 * @param storage - The `storage` field as supplied by the caller
 * @param version - The configured ClickHouse version (gates
 *   `s3_plain_rewritable`); pass `undefined` to skip the gate
 * @returns The resolved storage configuration
 * @throws Error when PVC and S3 options are mixed, when a required S3 field is
 *   missing, or when a value is not build-time concrete
 */
export function resolveClickHouseStorage(
  context: string,
  storage: ClickHouseStorageInput,
  version?: unknown
): ResolvedClickHouseStorage {
  const asRecord = storage as unknown as Record<string, unknown>;

  if (!isS3Storage(storage)) {
    const stray = S3_ONLY_STORAGE_KEYS.filter((key) => asRecord[key] !== undefined);
    if (stray.length > 0) {
      throw new Error(
        `${context}: storage mode 'pvc' (the default) rejects the S3-only option(s) ` +
          `${stray.map((key) => `'storage.${key}'`).join(', ')}. PVC and S3 storage cannot be ` +
          `mixed — set storage.mode: 's3' to use them, or remove them to keep PVC-backed ` +
          `MergeTree storage.`
      );
    }
    return { mode: 'pvc' };
  }

  // Every S3 field is build-time (XML text + resource selection). A ref here
  // would serialize into server configuration as a marker string.
  const s3Only: Record<string, unknown> = {};
  for (const key of S3_ONLY_STORAGE_KEYS) {
    if (asRecord[key] !== undefined) s3Only[key] = asRecord[key];
  }
  if (containsKubernetesRefs(s3Only)) {
    throw new Error(
      `${context}: 'storage' in S3 mode contains a schema/resource reference. The S3 disk ` +
        `configuration compiles to a storage_configuration XML document and selects which ` +
        `resources exist (ServiceAccount, backup CronJob), so it is fixed at CONSTRUCTION ` +
        `time — pass it to makeClickHouseCluster({ storage: { mode: 's3', ... } }) as concrete ` +
        `values. Only the thin local volume sizing (storage.size / storage.storageClassName) ` +
        `is runtime spec.`
    );
  }

  if (typeof storage.bucket !== 'string' || storage.bucket.trim() === '') {
    throw new Error(`${context}: 'storage.bucket' is required in S3 mode.`);
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(storage.bucket)) {
    throw new Error(
      `${context}: 'storage.bucket' must be a valid S3 bucket name (lowercase letters, ` +
        `digits, '.' and '-', 3-63 characters) — got ${JSON.stringify(storage.bucket)}.`
    );
  }
  if (storage.cache === undefined || typeof storage.cache.size !== 'string') {
    throw new Error(
      `${context}: 'storage.cache.size' is required in S3 mode — it caps the local ` +
        `read-through cache that keeps queries off the network. It must fit inside ` +
        `'storage.size' (the thin local volume that hosts it).`
    );
  }

  const diskType = storage.diskType ?? 's3';
  if (diskType !== 's3' && diskType !== 's3_plain_rewritable') {
    throw new Error(
      `${context}: 'storage.diskType' must be 's3' or 's3_plain_rewritable' — got ` +
        `${JSON.stringify(diskType)}.`
    );
  }
  if (diskType === 's3_plain_rewritable') {
    assertS3PlainRewritableVersion(context, version);
  }

  const prefix = normalizePrefix(context, storage.prefix);
  const cacheMaxSizeBytes = parseByteQuantity(context, 'storage.cache.size', storage.cache.size);
  const localBytes =
    typeof (storage as { size?: unknown }).size === 'string'
      ? parseByteQuantity(context, 'storage.size', (storage as { size: string }).size)
      : undefined;
  if (localBytes !== undefined && cacheMaxSizeBytes > localBytes) {
    throw new Error(
      `${context}: 'storage.cache.size' (${storage.cache.size}) exceeds 'storage.size' ` +
        `(${(storage as { size: string }).size}). The cache lives on the local volume, so a ` +
        `cache larger than the volume fills the disk instead of evicting.`
    );
  }

  // The policy name is rendered as an XML ELEMENT NAME (`<s3_main>`) inside
  // `config.d/storage.xml` and is also the value of the
  // `merge_tree/storage_policy` setting that every table then references, so
  // it has to be a bare identifier — a `<`, a quote or a space there produces
  // a different element or a malformed document, and escaping is not available
  // in element-name position.
  const policyName = storage.policyName ?? DEFAULT_S3_POLICY_NAME;
  assertClickHouseIdentifier(context, 'storage.policyName', policyName);

  return {
    mode: 's3',
    bucket: storage.bucket,
    prefix,
    ...(storage.region !== undefined && { region: storage.region }),
    ...(storage.endpoint !== undefined && { endpoint: storage.endpoint }),
    diskType,
    policyName,
    cacheMaxSizeBytes,
    cachePath: storage.cache.path ?? DEFAULT_S3_CACHE_PATH,
    auth: resolveAuth(context, storage.auth),
    endpointUrl: buildEndpointUrl(
      context,
      storage.bucket,
      prefix,
      storage.region,
      storage.endpoint
    ),
    ...(storage.backup !== undefined && {
      backup: resolveBackup(
        context,
        storage.backup,
        storage.bucket,
        storage.region,
        storage.endpoint
      ),
    }),
  };
}

// ============================================================================
// XML rendering
// ============================================================================

function indent(depth: number): string {
  return '    '.repeat(depth);
}

/** Render the credential elements shared by the disk and backup sections. */
function renderCredentialElements(auth: ResolvedClickHouseS3Auth, depth: number): string[] {
  if (auth.kind === 'irsa') {
    // The AWS SDK inside ClickHouse picks up the projected web-identity token
    // that the EKS pod identity webhook mounts for the annotated
    // ServiceAccount. No key material anywhere in the manifests.
    return [`${indent(depth)}<use_environment_credentials>true</use_environment_credentials>`];
  }
  // `from_env` substitution: the XML names the env var, the pod template
  // supplies it from the Secret. The key material never enters the CHI spec.
  return [
    `${indent(depth)}<access_key_id from_env="${xmlAttr(S3_ACCESS_KEY_ID_ENV)}"></access_key_id>`,
    `${indent(depth)}<secret_access_key from_env="${xmlAttr(
      S3_SECRET_ACCESS_KEY_ENV
    )}"></secret_access_key>`,
  ];
}

/** Render the disk `<type>` family for the resolved disk type. */
function renderDiskTypeElements(
  diskType: ResolvedClickHouseS3Storage['diskType'],
  depth: number
): string[] {
  if (diskType === 's3_plain_rewritable') {
    // Explicit modern form (24.5+): object_storage + s3 + plain_rewritable
    // metadata. Metadata lives IN the bucket, which is what makes the bucket
    // self-describing after node loss.
    return [
      `${indent(depth)}<type>object_storage</type>`,
      `${indent(depth)}<object_storage_type>s3</object_storage_type>`,
      `${indent(depth)}<metadata_type>plain_rewritable</metadata_type>`,
    ];
  }
  return [`${indent(depth)}<type>s3</type>`];
}

/**
 * Every value the storage document interpolates as an XML ELEMENT NAME, paired
 * with the option (or constant) it came from so the error can name it.
 *
 * Kept as one list rather than checked inline at each `lines.push` so that the
 * set of element-name sites is auditable in a single place — the point of the
 * check is that this list and the `<${...}>` interpolations below stay the same
 * set.
 */
function elementNameSites(
  resolved: ResolvedClickHouseS3Storage
): readonly (readonly [string, string])[] {
  return [
    ['storage.policyName', resolved.policyName],
    ['S3_DISK_NAME', S3_DISK_NAME],
    ['S3_CACHE_DISK_NAME', S3_CACHE_DISK_NAME],
    ['S3_POLICY_VOLUME_NAME', S3_POLICY_VOLUME_NAME],
    ['S3_BACKUP_CONFIG_SECTION', S3_BACKUP_CONFIG_SECTION],
  ];
}

/**
 * Render the `storage_configuration` (and, with a backup schedule, the `<s3>`
 * credential section) XML for the CHI's `configuration.files`.
 *
 * The document is fully STATIC: credentials arrive through
 * `use_environment_credentials` or `from_env`, so no secret material is ever
 * rendered here.
 *
 * @param resolved - Resolved S3 storage configuration
 * @returns The XML document text, newline-terminated
 */
export function renderStorageConfigurationXml(resolved: ResolvedClickHouseS3Storage): string {
  // Every value below is checked at the XML BOUNDARY, not only at resolve
  // time. This function is exported and takes a `ResolvedClickHouseS3Storage`,
  // so a caller can hand it a hand-built object that never went through
  // `resolveClickHouseStorage`; and re-checking the four module constants
  // means a later change that makes any of them configurable inherits the rule
  // instead of quietly bypassing it.
  for (const [field, name] of elementNameSites(resolved)) {
    assertClickHouseIdentifier('renderStorageConfigurationXml', field, name);
  }

  const lines: string[] = ['<clickhouse>', `${indent(1)}<storage_configuration>`];

  lines.push(`${indent(2)}<disks>`);
  lines.push(`${indent(3)}<${S3_DISK_NAME}>`);
  lines.push(...renderDiskTypeElements(resolved.diskType, 4));
  lines.push(`${indent(4)}<endpoint>${xmlText(resolved.endpointUrl)}</endpoint>`);
  lines.push(...renderCredentialElements(resolved.auth, 4));
  lines.push(`${indent(3)}</${S3_DISK_NAME}>`);
  lines.push(`${indent(3)}<${S3_CACHE_DISK_NAME}>`);
  lines.push(`${indent(4)}<type>cache</type>`);
  lines.push(`${indent(4)}<disk>${S3_DISK_NAME}</disk>`);
  lines.push(`${indent(4)}<path>${xmlText(resolved.cachePath)}</path>`);
  lines.push(`${indent(4)}<max_size>${xmlText(String(resolved.cacheMaxSizeBytes))}</max_size>`);
  // Write-through caching: freshly inserted parts stay locally readable, which
  // is what makes an object-store-backed cluster usable for recent-data
  // queries (the dominant observability access pattern).
  lines.push(`${indent(4)}<cache_on_write_operations>true</cache_on_write_operations>`);
  lines.push(`${indent(3)}</${S3_CACHE_DISK_NAME}>`);
  lines.push(`${indent(2)}</disks>`);

  lines.push(`${indent(2)}<policies>`);
  lines.push(`${indent(3)}<${resolved.policyName}>`);
  lines.push(`${indent(4)}<volumes>`);
  lines.push(`${indent(5)}<${S3_POLICY_VOLUME_NAME}>`);
  lines.push(`${indent(6)}<disk>${S3_CACHE_DISK_NAME}</disk>`);
  lines.push(`${indent(5)}</${S3_POLICY_VOLUME_NAME}>`);
  lines.push(`${indent(4)}</volumes>`);
  lines.push(`${indent(3)}</${resolved.policyName}>`);
  lines.push(`${indent(2)}</policies>`);
  lines.push(`${indent(1)}</storage_configuration>`);

  if (resolved.backup !== undefined) {
    // `BACKUP ... TO S3(url)` runs SERVER-side, so the destination credentials
    // must come from the server's `<s3>` config (matched by endpoint prefix) —
    // that keeps keys out of the query text and therefore out of query_log.
    lines.push(`${indent(1)}<s3>`);
    lines.push(`${indent(2)}<${S3_BACKUP_CONFIG_SECTION}>`);
    lines.push(`${indent(3)}<endpoint>${xmlText(resolved.backup.endpointUrl)}</endpoint>`);
    lines.push(...renderCredentialElements(resolved.auth, 3));
    lines.push(`${indent(2)}</${S3_BACKUP_CONFIG_SECTION}>`);
    lines.push(`${indent(1)}</s3>`);
  }

  lines.push('</clickhouse>', '');
  return lines.join('\n');
}

// ============================================================================
// CHI fragments
// ============================================================================

/** CHI `configuration.files` entry for the resolved S3 storage. */
export function clickHouseS3ConfigurationFiles(
  resolved: ResolvedClickHouseS3Storage
): Record<string, string> {
  return { [CHI_STORAGE_CONFIG_FILE]: renderStorageConfigurationXml(resolved) };
}

/**
 * CHI `configuration.settings` entry that makes the S3 policy the DEFAULT.
 *
 * This is what lets tooling outside TypeKro — the ClickStack/HyperDX gateway
 * collector's goose migrations, SigNoz's migrator — create its tables with no
 * `SETTINGS storage_policy` clause and still land on object storage.
 */
export function clickHouseS3ConfigurationSettings(
  resolved: ResolvedClickHouseS3Storage
): Record<string, string> {
  return { [MERGE_TREE_STORAGE_POLICY_SETTING]: resolved.policyName };
}

/** A pod-template env var entry (the CRD's pod spec is an open structure). */
interface PodEnvVar {
  name: string;
  valueFrom: { secretKeyRef: { name: string; key: string; optional: false } };
}

/**
 * Env vars the ClickHouse container needs for Secret-backed credentials.
 *
 * Empty for IRSA. `optional: false` so a missing Secret fails the pod loudly
 * instead of starting a server whose S3 disk silently 403s.
 */
export function clickHouseS3ContainerEnv(resolved: ResolvedClickHouseS3Storage): PodEnvVar[] {
  if (resolved.auth.kind !== 'secretRef') return [];
  return [
    {
      name: S3_ACCESS_KEY_ID_ENV,
      valueFrom: {
        secretKeyRef: {
          name: resolved.auth.secretName,
          key: resolved.auth.accessKeyIdKey,
          optional: false,
        },
      },
    },
    {
      name: S3_SECRET_ACCESS_KEY_ENV,
      valueFrom: {
        secretKeyRef: {
          name: resolved.auth.secretName,
          key: resolved.auth.secretAccessKeyKey,
          optional: false,
        },
      },
    },
  ];
}

/**
 * ServiceAccount name the CHI pod template must run as, when IRSA is used.
 *
 * @param resolved - Resolved S3 storage configuration
 * @param installationName - CHI name, used for the derived default
 * @returns The ServiceAccount name, or `undefined` for non-IRSA credentials
 */
export function clickHouseS3ServiceAccountName(
  resolved: ResolvedClickHouseS3Storage,
  installationName: string
): string | undefined {
  if (resolved.auth.kind !== 'irsa') return undefined;
  return resolved.auth.serviceAccountName ?? `${installationName}-s3`;
}
