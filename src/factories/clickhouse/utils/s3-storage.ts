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

import { type } from 'arktype';
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
 * Characters a `storage.endpoint` — and the fully COMPOSED disk/backup URL —
 * may use.
 *
 * The unreserved + reserved sets of RFC 3986 MINUS the characters that are an
 * injection somewhere downstream rather than a malformed URL — `&`, `'`, `"`,
 * `<`, `>` and a backslash. Whitespace and control characters are excluded by
 * construction, since the pattern is an allow-list; so is non-ASCII, which
 * means an internationalized host must be passed in its punycode form.
 *
 * Applied to the COMPOSED string, not only to the caller's `endpoint`: the
 * bucket, region and prefix are appended AFTER the endpoint is checked, so an
 * allow-list that only saw the endpoint would leave three other doors into the
 * same `S3('<url>')` string literal. See {@link composeS3EndpointUrl}.
 */
const ENDPOINT_URL_CHARACTERS = /^[A-Za-z0-9._~:/?#@!$()*+,;=%[\]-]+$/;

/**
 * Shape of an S3 bucket name, per AWS's general-purpose bucket naming rules.
 *
 * 3-63 characters of lowercase letters, digits, dots and hyphens, starting and
 * ending alphanumeric. Two further AWS rules are not expressible in one
 * readable pattern and are checked separately in {@link assertS3BucketName}:
 * no `..`, and not IP-address-shaped.
 *
 * The length bound lives in the pattern (`{1,61}` between the two anchored
 * alphanumerics) so the pattern alone is the whole character rule.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */
export const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Bucket names AWS rejects as ambiguous with an IP address. */
const IP_SHAPED_BUCKET_NAME = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;

/**
 * Bucket-name PREFIXES AWS reserves, with the reason each is reserved.
 *
 * These are the published general-purpose-bucket rules, not TypeKro policy —
 * a name carrying one of these is rejected by S3's own CreateBucket, so
 * accepting it here would only move the failure to the first write. `sthree-`
 * subsumes the separately documented `sthree-configurator`.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */
const RESERVED_BUCKET_NAME_PREFIXES: readonly { readonly prefix: string; readonly why: string }[] =
  [
    { prefix: 'xn--', why: 'AWS reserves it for punycode-encoded names' },
    { prefix: 'sthree-', why: 'AWS reserves it (including sthree-configurator)' },
    { prefix: 'amzn-s3-demo-', why: 'AWS reserves it for documentation examples' },
  ];

/** Bucket-name SUFFIXES AWS reserves, with the reason each is reserved. */
const RESERVED_BUCKET_NAME_SUFFIXES: readonly { readonly suffix: string; readonly why: string }[] =
  [
    { suffix: '-s3alias', why: 'AWS reserves it for S3 access-point aliases' },
    { suffix: '--ol-s3', why: 'AWS reserves it for Object Lambda access points' },
    { suffix: '.mrap', why: 'AWS reserves it for multi-region access points' },
    { suffix: '--x-s3', why: 'AWS reserves it for S3 Express directory buckets' },
  ];

/**
 * Region shape accepted for `storage.region`.
 *
 * Two lowercase letters (the geography — `us`, `eu`, `ap`, `cn`), one or more
 * lowercase words, then a single digit: `us-east-2`, `eu-central-1`,
 * `ap-southeast-3`, and the three-part partitions `us-gov-west-1` /
 * `cn-north-1`. Deliberately a SHAPE rather than an enumeration of today's
 * regions — a new region must not need a TypeKro release — but tight enough
 * that the value cannot carry a quote, a dot or a slash into the composed URL,
 * where it sits inside the host name.
 */
export const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * Characters one segment of an object-key prefix may use.
 *
 * The RFC 3986 `pchar` set minus `&`, the quotes, the percent (a prefix is
 * written into the URL verbatim, so a `%` there would be a half-finished
 * escape) and the slash, which is the segment SEPARATOR and is handled by
 * splitting rather than by the character class.
 */
const KEY_PREFIX_SEGMENT_CHARACTERS = /^[A-Za-z0-9._~!$()*+,;=:@-]+$/;

/**
 * Minimum ClickHouse version this factory accepts for
 * `diskType: 's3_plain_rewritable'`.
 *
 * 24.4 introduced the `s3_plain_rewritable` disk; 24.5 generalized it to the
 * `metadata_type: plain_rewritable` form emitted here, so 24.5 is the floor.
 */
export const MIN_S3_PLAIN_REWRITABLE_VERSION = '24.5';

/**
 * The {@link MIN_S3_PLAIN_REWRITABLE_VERSION} floor, expressed as a PATTERN so
 * it can travel into a generated KRO schema.
 *
 * WHY A PATTERN AND NOT ONLY A BUILD-TIME COMPARISON. `storage.diskType` is a
 * build-time choice, but `version` is per-INSTANCE runtime spec: in kro mode it
 * arrives at construction as a schema reference, so no build-time comparison
 * can see the value an instance will actually carry. Encoding the floor as a
 * pattern lets `makeClickHouseCluster` put it on `spec.version` in the
 * generated RGD (`string | pattern="…"`), so the API server / KRO REJECT an
 * instance that selects an unsupported server — the case the build-time check
 * structurally cannot reach.
 *
 * Reads as "major.minor >= 24.5": `24.5`-`24.9` and `24.10`+, any `25`-`99`
 * major, and any three-or-more-digit major. A trailing `.patch.build`, or a
 * `-`/`_` suffix, is accepted after the minor because ClickHouse tags look
 * like `25.7`, `25.12.5`, and `24.8.14.39`.
 *
 * RE2-compatible on purpose (no lookaround, no backreferences): the same
 * source becomes the `pattern=` marker of the generated KRO schema, and
 * Kubernetes validates OpenAPI patterns with RE2.
 */
export const S3_PLAIN_REWRITABLE_VERSION_PATTERN =
  /^v?(?:24\.(?:[5-9]|[1-9][0-9]+)|2[5-9]\.[0-9]+|[3-9][0-9]\.[0-9]+|[1-9][0-9]{2,}\.[0-9]+)(?:[._-][0-9A-Za-z._-]*)?$/;

/**
 * ArkType schema for a `version` that may back
 * `diskType: 's3_plain_rewritable'`.
 *
 * `makeClickHouseCluster` uses this as the spec-schema type of `version`
 * whenever the build-time topology selects `s3_plain_rewritable`, so the floor
 * travels into the generated RGD and KRO rejects a bad INSTANCE. Compositions
 * that wire `clickHouseInstallation()` by hand should do the same — see
 * {@link assertS3PlainRewritableVersion} for why a build-time check alone is
 * not enough there.
 */
export const ClickHouseS3PlainRewritableVersionSchema = type(
  S3_PLAIN_REWRITABLE_VERSION_PATTERN
);

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
//
// SCHEMA-FIRST, exactly like the user-facing shapes in `../types.ts`: the
// RESULT of the resolution is an ArkType schema and its TypeScript type is
// INFERRED from it (`typeof X.infer`), so there is one description of a
// resolved storage and it is one a runtime check can actually enforce.
//
// WHY THE RESULT SHAPE NEEDS A SCHEMA AT ALL. `resolveClickHouseStorage()` is
// not the only way a resolved value reaches the renderers: the module exports
// `renderStorageConfigurationXml()`, `clickHouseS3ContainerEnv()` and
// `clickHouseS3BackupCronJob()`, each of which takes a resolved storage as a
// plain argument. A hand-written interface describes that argument to the
// COMPILER only; downstream code that field-selects `bucket`, `diskType`,
// `auth.kind` or `backup.endpointUrl` out of it needs a description that
// exists at RUN time too — otherwise the structure is claimed (by a cast or a
// type predicate) rather than established.
// ============================================================================

/**
 * What `storage` has to be, quoted into the ArkType error on a bad value.
 *
 * It is attached to the `mode` DISCRIMINANT of
 * {@link ResolvedClickHouseS3StorageSchema} (via ArkType's `.describe()`), so a
 * value that never came out of the S3 branch of the resolver — a PVC
 * resolution, an unrelated object — is reported against `storage.mode` with
 * this sentence, while every other field keeps its own precise, path-named
 * error.
 */
export const RESOLVED_S3_STORAGE_REQUIREMENT =
  "a resolved S3 storage (mode: 's3'), as returned by resolveClickHouseStorage()";

/**
 * Credentials as resolved for rendering (never carries key material).
 *
 * A real ArkType union rather than a `kind` field plus optional siblings: the
 * two transports have DISJOINT payloads, and the union is what makes
 * `{ kind: 'irsa', secretName: … }` a validation error instead of a value the
 * renderer silently reads the wrong half of.
 */
export const ResolvedClickHouseS3AuthSchema = type({
  /** Transport discriminant; selects `use_environment_credentials`. */
  kind: '"irsa"',
  /** IAM role ARN annotated onto the ServiceAccount. */
  roleArn: 'string > 0',
  /** ServiceAccount name; defaulted by the composition when absent. */
  'serviceAccountName?': 'string > 0',
}).or({
  /** Transport discriminant; selects `from_env` credential elements. */
  kind: '"secretRef"',
  /** Secret holding the access keys, in the CHI namespace. */
  secretName: 'string > 0',
  /** Secret key holding the access key id (defaulted by the resolver). */
  accessKeyIdKey: 'string > 0',
  /** Secret key holding the secret access key (defaulted by the resolver). */
  secretAccessKeyKey: 'string > 0',
});

/** Credentials as resolved for rendering (see {@link ResolvedClickHouseS3AuthSchema}). */
export type ResolvedClickHouseS3Auth = typeof ResolvedClickHouseS3AuthSchema.infer;

/** Backup schedule with every default applied. */
export const ResolvedClickHouseS3BackupSchema = type({
  /** Cron schedule of the generated CronJob. */
  schedule: 'string > 0',
  /** Backup bucket (the disk's bucket unless overridden). */
  bucket: 'string > 0',
  /** Normalized, non-empty backup key prefix. */
  prefix: 'string > 0',
  /** Database to back up — a bare SQL identifier, checked by the resolver. */
  database: 'string > 0',
  /** Backup object-key base URL (`.../<prefix>/`), used by `BACKUP TO S3`. */
  endpointUrl: 'string > 0',
  /** Days of backups to keep; absent means keep everything. */
  'retentionDays?': 'number.integer > 0',
  /** ClickHouse credentials the CronJob connects with. */
  'auth?': {
    /** Secret holding the ClickHouse user and password. */
    secretName: 'string > 0',
    /** Secret key holding the user name. */
    usernameKey: 'string > 0',
    /** Secret key holding the password. */
    passwordKey: 'string > 0',
  },
});

/** Backup schedule with every default applied (see {@link ResolvedClickHouseS3BackupSchema}). */
export type ResolvedClickHouseS3Backup = typeof ResolvedClickHouseS3BackupSchema.infer;

/** Fully defaulted, validated S3 storage configuration. */
export const ResolvedClickHouseS3StorageSchema = type({
  /** Mode discriminant — see {@link RESOLVED_S3_STORAGE_REQUIREMENT}. */
  mode: type('"s3"').describe(RESOLVED_S3_STORAGE_REQUIREMENT),
  /** Bucket backing the MergeTree disk. */
  bucket: 'string > 0',
  /** Normalized key prefix without leading/trailing slashes ('' when absent). */
  prefix: 'string',
  /** AWS region; absent when a custom `endpoint` supplies the target. */
  'region?': 'string > 0',
  /** Custom S3-compatible base endpoint (MinIO); absent for real AWS. */
  'endpoint?': 'string > 0',
  /** Disk type — the durability choice (see the module docs). */
  diskType: '"s3" | "s3_plain_rewritable"',
  /** MergeTree storage policy name; rendered in XML ELEMENT-NAME position. */
  policyName: 'string > 0',
  /** Local read-through cache cap, already converted to bytes. */
  cacheMaxSizeBytes: 'number.integer > 0',
  /** Local cache directory, under the operator's data volume mount. */
  cachePath: 'string > 0',
  /** Credential transport for the disk. */
  auth: ResolvedClickHouseS3AuthSchema,
  /** Disk endpoint URL, always with a trailing slash. */
  endpointUrl: 'string > 0',
  /** Scheduled backups, when the caller asked for them. */
  'backup?': ResolvedClickHouseS3BackupSchema,
});

/** Fully defaulted, validated S3 storage (see {@link ResolvedClickHouseS3StorageSchema}). */
export type ResolvedClickHouseS3Storage = typeof ResolvedClickHouseS3StorageSchema.infer;

/** Fully defaulted, validated PVC storage configuration (today's behaviour). */
export const ResolvedClickHousePvcStorageSchema = type({
  /** Mode discriminant. */
  mode: '"pvc"',
});

/** Fully defaulted PVC storage (see {@link ResolvedClickHousePvcStorageSchema}). */
export type ResolvedClickHousePvcStorage = typeof ResolvedClickHousePvcStorageSchema.infer;

/** Discriminated resolution of the `storage` input. */
export const ResolvedClickHouseStorageSchema = ResolvedClickHousePvcStorageSchema.or(
  ResolvedClickHouseS3StorageSchema
);

/** Discriminated resolution of the `storage` input. */
export type ResolvedClickHouseStorage = typeof ResolvedClickHouseStorageSchema.infer;

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
 * TWO ENFORCEMENT SITES, ONE FLOOR. A CONCRETE version is checked here and
 * rejected loudly — including a version this function cannot READ (`'latest'`,
 * a digest pin), because "unreadable" is not evidence that the server supports
 * the `plain_rewritable` metadata type, and silently accepting it was the gap
 * this replaces. A version that is NOT a concrete string is a per-instance
 * schema reference: its value does not exist at construction, so no check here
 * can see it, and the floor must instead travel into the generated schema as
 * {@link ClickHouseS3PlainRewritableVersionSchema} — which
 * `makeClickHouseCluster` does automatically, so KRO rejects an instance that
 * selects an older server. A composition that wires `clickHouseInstallation()`
 * by hand with a schema-reference `version` MUST use that schema for its own
 * `version` field; nothing else can enforce the floor for it.
 *
 * @param context - Entry point name for the error message
 * @param version - The configured ClickHouse server version tag, or a schema
 *   reference (skipped — see above)
 * @throws Error when a concrete version is below
 *   {@link MIN_S3_PLAIN_REWRITABLE_VERSION} or cannot be parsed as
 *   `major.minor`
 */
export function assertS3PlainRewritableVersion(context: string, version: unknown): void {
  // Not a concrete string: a schema/resource reference whose value only exists
  // per instance. Enforced by the generated schema's pattern instead.
  if (typeof version !== 'string') return;

  const parsed = parseClickHouseVersion(version);
  if (parsed === undefined) {
    throw new Error(
      `${context}: storage.diskType 's3_plain_rewritable' requires a CONCRETE ClickHouse ` +
        `version of at least ${MIN_S3_PLAIN_REWRITABLE_VERSION}, and ` +
        `${JSON.stringify(version)} cannot be read as 'major.minor'. A moving tag or a ` +
        `digest pin is not evidence that the server supports the metadata_type: ` +
        `plain_rewritable form this factory emits, so it is refused rather than assumed — ` +
        `pin an explicit version (e.g. '25.7'), or use diskType: 's3' with a backup schedule.`
    );
  }
  const floor = parseClickHouseVersion(MIN_S3_PLAIN_REWRITABLE_VERSION);
  // Unreachable: the constant is a literal this function can parse. Kept as a
  // total branch rather than a non-null assertion.
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

/**
 * Assert a value is a legal S3 bucket name.
 *
 * ONE validator for both bucket-shaped options — `storage.bucket` and the
 * `storage.backup.bucket` override — because both are appended into the same
 * composed URL and therefore into the same `BACKUP … TO S3('<url>')` string
 * literal. A second, hand-inlined copy for the override is exactly how the
 * override came to be unchecked in the first place.
 *
 * @param context - Entry point name for the error message
 * @param field - Offending option path (e.g. `storage.backup.bucket`)
 * @param value - The bucket name received
 * @throws Error naming the option and the value when the name breaks AWS's
 *   naming rules
 */
export function assertS3BucketName(context: string, field: string, value: unknown): void {
  const invalid = (why: string): never => {
    throw new Error(
      `${context}: '${field}' must be a valid S3 bucket name — ${why} (got ` +
        `${JSON.stringify(value)}). AWS requires 3-63 characters of lowercase letters, ` +
        `digits, '.' and '-', starting and ending alphanumeric, with no '..', no ` +
        `IP-address shape, and none of the reserved prefixes ` +
        `(${RESERVED_BUCKET_NAME_PREFIXES.map((entry) => entry.prefix).join(', ')}) or ` +
        `suffixes (${RESERVED_BUCKET_NAME_SUFFIXES.map((entry) => entry.suffix).join(', ')}). ` +
        `The name is appended into the disk endpoint URL that the server's ` +
        `\`config.d/storage.xml\` and the \`BACKUP … TO S3('<url>')\` statement both read, so ` +
        `it is constrained rather than escaped.`
    );
  };
  if (typeof value !== 'string') invalid('it is not a string');
  const name = value as string;
  if (!S3_BUCKET_NAME_PATTERN.test(name)) {
    invalid(`it does not match ${S3_BUCKET_NAME_PATTERN.source}`);
  }
  // The rules below are the rest of AWS's published general-purpose-bucket
  // naming rules — every one a real CreateBucket rejection rather than TypeKro
  // policy. They are separate checks because folding them into one pattern
  // makes it unreadable, and because each one gets to name itself in the error.
  if (name.includes('..')) invalid("it contains '..'");
  if (IP_SHAPED_BUCKET_NAME.test(name)) invalid('it is formatted as an IP address');
  for (const { prefix, why } of RESERVED_BUCKET_NAME_PREFIXES) {
    if (name.startsWith(prefix)) invalid(`it starts with the reserved '${prefix}' — ${why}`);
  }
  for (const { suffix, why } of RESERVED_BUCKET_NAME_SUFFIXES) {
    if (name.endsWith(suffix)) invalid(`it ends with the reserved '${suffix}' — ${why}`);
  }
}

/**
 * Assert a value is an AWS region identifier.
 *
 * The region is interpolated into the HOST of the composed endpoint
 * (`<bucket>.s3.<region>.amazonaws.com`), so an unconstrained value reaches the
 * XML and the backup SQL literal exactly like the bucket does.
 *
 * @param context - Entry point name for the error message
 * @param field - Offending option path (e.g. `storage.region`)
 * @param value - The region received
 * @throws Error naming the option and the value when the region is not
 *   {@link AWS_REGION_PATTERN}-shaped
 */
export function assertAwsRegion(context: string, field: string, value: unknown): void {
  if (typeof value === 'string' && AWS_REGION_PATTERN.test(value)) return;
  throw new Error(
    `${context}: '${field}' must be an AWS region identifier matching ` +
      `${AWS_REGION_PATTERN.source} — two lowercase letters, one or more lowercase words, ` +
      `then a digit (e.g. 'us-east-2', 'eu-central-1', 'us-gov-west-1'); got ` +
      `${JSON.stringify(value)}. The value becomes part of the endpoint HOST ` +
      `(<bucket>.s3.<region>.amazonaws.com), which is rendered into the server's storage ` +
      `XML and into the \`BACKUP … TO S3('<url>')\` string literal.`
  );
}

// ============================================================================
// Storage resolution
// ============================================================================

/**
 * True when the storage input selects the object-storage mode.
 *
 * The predicate claims exactly what the check ESTABLISHES and no more: `mode`
 * is `'s3'`, so the S3-only options are the ones that MAY be present — hence
 * `Loosen<…>`, which leaves every one of them optional. Claiming the full
 * `ClickHouseS3StorageOptions` here would assert `bucket: string`,
 * `cache: { size: string }` and a valid `auth` on the strength of one
 * discriminant, and the compiler would then stop asking
 * {@link resolveClickHouseStorage} to check them — which is precisely the job
 * that function exists to do.
 */
export function isS3Storage(
  storage: ClickHouseStorageInput
): storage is ClickHouseStorageInput & Loosen<ClickHouseS3StorageOptions> {
  return (storage as { mode?: string }).mode === 's3';
}

/**
 * Host shape accepted for a custom `storage.endpoint`.
 *
 * A DNS name (`minio.minio.svc.cluster.local`, `s3.example.com`, `minio`) or a
 * dotted-quad IPv4 literal. Labels are the RFC 1123 shape the Kubernetes API
 * uses for a Service/DNS name. An IPv6 literal in brackets is deliberately not
 * accepted: ClickHouse's `<endpoint>` parser and the `BACKUP … TO S3()` URL
 * both take the value as a plain string, and a bracketed authority has not been
 * verified against either — an explicit refusal beats a silent surprise.
 */
const ENDPOINT_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Parse and VALIDATE a custom S3-compatible endpoint, returning it normalized
 * with no trailing slash so the caller can append `/<bucket>/<prefix>/`.
 *
 * STRUCTURE, not just characters. The character allow-list on the composed URL
 * ({@link ENDPOINT_URL_CHARACTERS}) stops injection into the storage XML and
 * the `BACKUP … TO S3('<url>')` SQL literal, but it happily accepts strings
 * that are not usable endpoints — a userinfo section that would write
 * credentials into `config.d/storage.xml`, a query string or fragment that the
 * appended bucket path turns into nonsense, or an out-of-range port. Each of
 * those is a different mistake and gets its own message.
 *
 * @param context - Entry point name for the error message
 * @param endpoint - The caller's `storage.endpoint` value
 * @returns The endpoint as `<scheme>://<host>[:<port>][<path>]`, no trailing
 *   slash
 * @throws Error naming the specific part of the URL that is unusable
 */
export function parseS3EndpointUrl(context: string, endpoint: string): string {
  const invalid = (why: string): never => {
    throw new Error(
      `${context}: 'storage.endpoint' must be an absolute http(s) URL of the ` +
        `S3-compatible service (e.g. 'http://minio.minio.svc.cluster.local:9000') — ${why} ` +
        `(got ${JSON.stringify(endpoint)}). The bucket and prefix are appended by the ` +
        `factory, so do not include them here; the value is rendered into the server's ` +
        `\`config.d/storage.xml\` and into the \`BACKUP … TO S3('<url>')\` string literal.`
    );
  };

  // Checked before parsing so the message can say `storage.endpoint` rather
  // than point at a composed URL the caller never typed.
  if (!ENDPOINT_URL_CHARACTERS.test(endpoint)) {
    invalid(
      `it uses characters outside ${ENDPOINT_URL_CHARACTERS.source} — no whitespace, ` +
        `quotes, angle brackets, '&', backslash, control characters or non-ASCII (pass an ` +
        `internationalized host in punycode)`
    );
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return invalid('it is not a parseable absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid(`its scheme is '${url.protocol.replace(/:$/, '')}', not http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    invalid(
      'it carries userinfo credentials — S3 keys come from `storage.auth` (IRSA or a ' +
        'Secret reference), never from the endpoint URL'
    );
  }
  if (url.search !== '') invalid('it carries a query string');
  if (url.hash !== '') invalid('it carries a fragment');
  if (url.hostname === '') invalid('it has no host');
  if (!ENDPOINT_HOST_PATTERN.test(url.hostname)) {
    invalid(
      `its host ${JSON.stringify(url.hostname)} is not a DNS name or IPv4 literal ` +
        `(matching ${ENDPOINT_HOST_PATTERN.source})`
    );
  }
  if (url.port !== '') {
    // `new URL` already rejects a non-numeric or >65535 port, and drops the
    // default port for the scheme. Re-check the range so a future parser
    // change cannot let one through, and so 0 is refused explicitly.
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      invalid(`its port ${JSON.stringify(url.port)} is not in 1-65535`);
    }
  }

  // A base PATH is legitimate (a gateway mounted under a prefix), but it is
  // joined with `/<bucket>/<prefix>/`, so it must be a clean path: no traversal
  // segment, no empty segment that would double a slash.
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  if (path !== '') {
    const segments = path.slice(1).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      invalid(
        `its path ${JSON.stringify(url.pathname)} has an empty or traversal segment; a base ` +
          `path is allowed but must be a plain '/a/b' prefix`
      );
    }
  }

  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Normalize and VALIDATE an object-key prefix.
 *
 * Takes the option path as `field` because both `storage.prefix` and
 * `storage.backup.prefix` come through here and the error has to name the one
 * the caller actually set.
 *
 * The character rule is an allow-list per segment, for the same reason the
 * endpoint has one: the prefix is appended verbatim into the composed URL that
 * the `BACKUP … TO S3('<url>')` literal is built from. `..` is refused
 * outright — as a path traversal it is meaningless against an S3 key namespace
 * but it is exactly the shape that walks a backup out of its own prefix if the
 * value is ever handed to something that resolves paths (the prune step's
 * `aws s3 rm --recursive`, for one).
 */
function normalizePrefix(context: string, field: string, prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const invalid = (why: string): never => {
    throw new Error(
      `${context}: '${field}' must be a safe object-key prefix — ${why} (got ` +
        `${JSON.stringify(prefix)}). Each '/'-separated segment must match ` +
        `${KEY_PREFIX_SEGMENT_CHARACTERS.source}: no quotes, whitespace, control ` +
        `characters, '&', '%' or '..'. The prefix is appended verbatim into the endpoint ` +
        `URL that the server's storage XML and the \`BACKUP … TO S3('<url>')\` string ` +
        `literal are both built from.`
    );
  };
  if (typeof prefix !== 'string') invalid('it is not a string');
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.includes('//')) {
    throw new Error(
      `${context}: '${field}' must not contain empty path segments — got ` +
        `${JSON.stringify(prefix)}.`
    );
  }
  if (trimmed === '') return '';
  if (trimmed.includes('..')) invalid("it contains '..'");
  for (const segment of trimmed.split('/')) {
    if (segment === '.') invalid("it contains a '.' segment");
    if (!KEY_PREFIX_SEGMENT_CHARACTERS.test(segment)) {
      invalid(`the segment ${JSON.stringify(segment)} uses a character no key prefix may`);
    }
  }
  return trimmed;
}

/**
 * Compose the disk/backup endpoint URL, then validate what was composed.
 *
 * ORDER IS THE POINT. Every component reaching this function is already
 * checked on its own — bucket ({@link assertS3BucketName}), region
 * ({@link assertAwsRegion}), prefix ({@link normalizePrefix}), and the
 * `endpoint` right below — and each of those checks exists so the error can
 * name the OPTION the caller set. But per-component checks are a set of doors
 * that has to be complete, and the string that actually matters is the one the
 * runtime sees: the `<endpoint>` text of `config.d/storage.xml` and the
 * `BACKUP … TO S3('<url>')` literal the CronJob builds, where a `'` is extra
 * SQL rather than a bad URL. So the composed result is re-checked against the
 * same RFC 3986 allow-list as a BACKSTOP — a component check that is ever
 * loosened, or a component that is ever added, cannot open that door quietly.
 *
 * @param context - Entry point name for the error message
 * @param field - Option path prefix for the error (`storage` or
 *   `storage.backup`), so a bad backup override does not report `storage.*`
 * @param bucket - Validated bucket name
 * @param prefix - Normalized, validated key prefix ('' for the bucket root)
 * @param region - Validated region; required when `endpoint` is absent
 * @param endpoint - Custom S3-compatible base URL, if any
 * @returns The composed URL, always with a trailing slash
 * @throws Error when the endpoint is not an absolute http(s) URL, when the
 *   region is missing for AWS, or when the COMPOSED URL carries a character
 *   the allow-list forbids
 */
export function composeS3EndpointUrl(
  context: string,
  field: string,
  bucket: string,
  prefix: string,
  region: string | undefined,
  endpoint: string | undefined
): string {
  const suffix = prefix === '' ? '' : `${prefix}/`;
  let composed: string;
  if (endpoint !== undefined) {
    // STRUCTURE first, characters second. An allow-list alone accepts strings
    // that are not URLs at all (`http:///x`, `http://a b`… well, not that one,
    // but `http://user:pw@host`, `http://host?x=1`, `http://host:99999`), and
    // every one of those either silently changes what the server talks to or
    // leaks credentials into `config.d/storage.xml`. So the endpoint is PARSED
    // and each part is checked, and the character allow-list stays as the
    // backstop on the composed result.
    const base = parseS3EndpointUrl(context, endpoint);
    // Path-style addressing: MinIO and most S3-compatible services serve
    // virtual-hosted-style only behind extra DNS configuration.
    composed = `${base}/${bucket}/${suffix}`;
  } else {
    if (region === undefined || region.trim() === '') {
      throw new Error(
        `${context}: 'storage.region' is required for AWS S3 (it forms the disk endpoint ` +
          `https://<bucket>.s3.<region>.amazonaws.com/<prefix>/). Set 'storage.endpoint' ` +
          `instead when targeting a custom S3-compatible service such as MinIO.`
      );
    }
    // A dot in the bucket name is legal S3 but breaks the VIRTUAL-HOSTED-style
    // URL this branch composes: the wildcard certificate for
    // `*.s3.<region>.amazonaws.com` does not cover a further label, so TLS
    // verification fails. AWS documents this restriction for virtual-hosted
    // access; path-style custom endpoints (the branch above) are unaffected.
    if (bucket.includes('.')) {
      throw new Error(
        `${context}: '${field}.bucket' ${JSON.stringify(bucket)} contains a '.', which is ` +
          `legal for S3 but not usable over HTTPS in the virtual-hosted-style endpoint this ` +
          `factory composes for AWS (https://<bucket>.s3.<region>.amazonaws.com/): the ` +
          `wildcard certificate does not cover an extra label, so TLS verification fails. ` +
          `Use a dot-free bucket name, or set 'storage.endpoint' to a path-style endpoint.`
      );
    }
    composed = `https://${bucket}.s3.${region}.amazonaws.com/${suffix}`;
  }

  if (!ENDPOINT_URL_CHARACTERS.test(composed)) {
    throw new Error(
      `${context}: the composed '${field}' endpoint URL ${JSON.stringify(composed)} must use ` +
        `only URL characters matching ${ENDPOINT_URL_CHARACTERS.source} — no whitespace, ` +
        `quotes, angle brackets, '&', backslash or control characters. Check ` +
        `'${field}.bucket', '${field}.prefix', 'storage.region' and 'storage.endpoint': the ` +
        `composed value is what lands in the server's storage XML and in the ` +
        `\`BACKUP … TO S3('<url>')\` string literal, so it is validated as a whole and not ` +
        `only component by component.`
    );
  }
  return composed;
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
  // The OVERRIDE is validated with the same validator as the primary bucket
  // (`storage.bucket`), naming whichever option the value actually came from.
  // It is appended into the composed backup URL, so "the disk bucket was
  // checked" says nothing about it.
  assertS3BucketName(
    context,
    backup.bucket === undefined ? 'storage.bucket' : 'storage.backup.bucket',
    bucket
  );
  const prefix = normalizePrefix(
    context,
    'storage.backup.prefix',
    backup.prefix ?? DEFAULT_BACKUP_PREFIX
  );
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
    endpointUrl: composeS3EndpointUrl(context, 'storage.backup', bucket, prefix, region, endpoint),
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
  assertS3BucketName(context, 'storage.bucket', storage.bucket);
  // Validated whenever it is set, not only on the AWS path: it also travels to
  // the prune container as `AWS_REGION`, and `storage.endpoint` being present
  // must not turn the region into an unchecked field.
  if (storage.region !== undefined) {
    assertAwsRegion(context, 'storage.region', storage.region);
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

  const prefix = normalizePrefix(context, 'storage.prefix', storage.prefix);
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

  const resolved = {
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
    endpointUrl: composeS3EndpointUrl(
      context,
      'storage',
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

  // THE RESOLUTION IS CHECKED AGAINST ITS OWN SCHEMA, at the boundary where it
  // stops being this function's local object and becomes a value the XML
  // renderer, the pod-template patch and the backup CronJob all field-select
  // from. The field-by-field guards above produce specific, actionable
  // messages and stay; this is the total one that cannot go stale — a key
  // added to the schema and forgotten here, or a value that reached the object
  // through a path with no guard of its own, fails HERE rather than several
  // calls deeper in a rendered manifest.
  const validated = ResolvedClickHouseS3StorageSchema(resolved);
  if (validated instanceof type.errors) {
    throw new Error(
      `${context}: internal error — the resolved S3 storage does not satisfy ` +
        `ResolvedClickHouseS3StorageSchema: ${validated.summary}. This is a bug in ` +
        `resolveClickHouseStorage(), not in the supplied 'storage'.`
    );
  }
  return validated;
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
