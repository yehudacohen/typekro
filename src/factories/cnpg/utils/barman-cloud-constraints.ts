// Spec constraints of the Barman Cloud plugin compositions, each declared once and enforced in
// both deployment modes: the instance schema carries the pattern or enum and `required=true`, so
// the API server refuses a bad or missing value on a KRO instance, and the composition body
// refuses it in direct mode. The body uses the strict `enforce()`: a reference passes only when it
// is to a required spec field declared with the constraint's `type`, so a composition that
// composes these with an unconstrained, optional or derived field is refused when it is built.

import { type } from 'arktype';
import { Cel } from '../../../core/references/cel.js';
import { specConstraint } from '../../../core/validation/spec-constraint.js';
import {
  BARMAN_CLOUD_PLUGIN_CHART_VERSION,
  BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION,
} from '../constants.js';

/**
 * The shape of an S3 general-purpose bucket name: lowercase letters, digits, dots and hyphens,
 * starting and ending with a letter or digit, with no two adjacent dots. The length (3 to 63)
 * and the rules a pattern can't refuse are in {@link S3_BUCKET_NAME_RULE}.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */
export const S3_BUCKET_NAME = /^[a-z0-9](?:\.?[a-z0-9-])*\.?[a-z0-9]$/;

/** Prefixes S3 reserves: no general-purpose bucket name starts with one. */
export const S3_RESERVED_BUCKET_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'] as const;

/**
 * Suffixes S3 reserves for access point aliases (`-s3alias`), Object Lambda access point aliases
 * (`--ol-s3`), Multi-Region Access Points (`.mrap`), directory buckets (`--x-s3`) and table
 * buckets (`--table-s3`). `-an` (account regional namespace buckets) is allowed.
 */
export const S3_RESERVED_BUCKET_SUFFIXES = [
  '-s3alias',
  '--ol-s3',
  '.mrap',
  '--x-s3',
  '--table-s3',
] as const;

/** Four dot-separated groups of digits, the form of an IPv4 address, which S3 refuses. */
const IP_ADDRESS_FORM = '^[0-9]+([.][0-9]+){3}$';

/** A literal for a CEL regex: `.` in brackets, so no backslash escapes are needed. */
const celRegexLiteral = (text: string) => text.replaceAll('.', '[.]');

/**
 * The bucket naming rules {@link S3_BUCKET_NAME} can't express, as a CEL rule on the instance
 * schema: not in the form of an IP address, and no reserved prefix or suffix. It uses the
 * global `matches(string, regex)` overload of the CEL standard library.
 */
export const S3_BUCKET_NAME_RULE =
  `!matches(self, '${IP_ADDRESS_FORM}') && ` +
  `!matches(self, '^(${S3_RESERVED_BUCKET_PREFIXES.map(celRegexLiteral).join('|')})') && ` +
  `!matches(self, '(${S3_RESERVED_BUCKET_SUFFIXES.map(celRegexLiteral).join('|')})$')`;

/** {@link S3_BUCKET_NAME_RULE} in TypeScript. */
function bucketNameHolds(bucket: string): boolean {
  return (
    !new RegExp(IP_ADDRESS_FORM).test(bucket) &&
    !S3_RESERVED_BUCKET_PREFIXES.some((prefix) => bucket.startsWith(prefix)) &&
    !S3_RESERVED_BUCKET_SUFFIXES.some((suffix) => bucket.endsWith(suffix))
  );
}

/** An S3 general-purpose bucket name, by every rule AWS documents for one. */
export const S3_BUCKET_NAME_TYPE = type(S3_BUCKET_NAME)
  .and('3 <= string <= 63')
  .configure({ expected: 'an S3 bucket name' });

/** True when `bucket` is a valid S3 general-purpose bucket name. */
export function isS3BucketName(bucket: string): boolean {
  return !(S3_BUCKET_NAME_TYPE(bucket) instanceof type.errors) && bucketNameHolds(bucket);
}

/**
 * A key prefix inside the bucket: one or more `/`-separated segments of letters, digits, `.`,
 * `_` and `-`, with no leading, trailing or doubled `/`. The plugin adds `/<serverName>/`.
 */
export const S3_KEY_PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * `bucket`: a required S3 general-purpose bucket name. The pattern and length are markers on the
 * instance schema, and the IP-address and reserved prefix and suffix rules a CEL rule there.
 */
export const BARMAN_CLOUD_BUCKET_CONSTRAINT = specConstraint({
  path: 'bucket',
  type: S3_BUCKET_NAME_TYPE,
  rule: S3_BUCKET_NAME_RULE,
  holds: bucketNameHolds,
  required: true,
  code: 'CNPG_BARMAN_CLOUD_BUCKET_INVALID',
  declaredWith: 'BARMAN_CLOUD_BUCKET_CONSTRAINT.type',
  message: (bucket) =>
    `bucket must be an S3 general-purpose bucket name (3 to 63 lowercase letters, digits, dots ` +
    `and hyphens, starting and ending with a letter or digit, no adjacent dots, not an IP ` +
    `address, no reserved prefix or suffix); got ${JSON.stringify(bucket)}.`,
});

/**
 * `prefix`: a non-empty key prefix, so several clusters can share a bucket without sharing a
 * path. The pattern is on the instance schema.
 */
export const BARMAN_CLOUD_PREFIX_CONSTRAINT = specConstraint({
  path: 'prefix',
  type: type(S3_KEY_PREFIX).configure({ expected: 'a key prefix like "cnpg/production"' }),
  required: true,
  code: 'CNPG_BARMAN_CLOUD_PREFIX_INVALID',
  declaredWith: 'BARMAN_CLOUD_PREFIX_CONSTRAINT.type',
  message: (prefix) =>
    `prefix must be a non-empty key prefix like "cnpg/production", without a leading or ` +
    `trailing "/"; got ${JSON.stringify(prefix)}.`,
});

/**
 * `version` of the plugin install composition: exactly the pinned chart version, and required.
 * Its enum is on the instance schema, so the API server refuses a KRO instance asking for another
 * chart or none.
 */
export const BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT = specConstraint({
  path: 'version',
  type: type
    .unit(BARMAN_CLOUD_PLUGIN_CHART_VERSION)
    .configure({ expected: `the pinned chart version ${BARMAN_CLOUD_PLUGIN_CHART_VERSION}` }),
  required: true,
  code: 'CNPG_BARMAN_CLOUD_CHART_VERSION_MISMATCH',
  declaredWith: 'BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT.type',
  message: (version) =>
    `The Barman Cloud plugin chart is pinned at ${BARMAN_CLOUD_PLUGIN_CHART_VERSION}; ` +
    `got ${JSON.stringify(version)}.`,
});

/**
 * A CloudNativePG operator version the plugin supports: `1.<minor>.<patch>` with minor 30 or
 * later ({@link BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION}), without a `v` or a pre-release.
 */
export const BARMAN_CLOUD_COMPATIBLE_CNPG_VERSION = /^1\.(3[0-9]|[4-9][0-9])\.(0|[1-9][0-9]*)$/;

/**
 * `operatorVersion` of the plugin factories: the version of the CloudNativePG operator running
 * in the plugin's namespace, such as `1.30.2`, required and at least
 * {@link BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION}. The pattern is on the instance schema, so the
 * API server refuses a KRO instance that names an older operator or none; direct mode refuses it
 * too. `cnpgBootstrap`'s default chart, `DEFAULT_CNPG_CHART_VERSION`, installs 1.30.2; an
 * install pinned to chart 0.23.0 runs 1.25.0, which is too old.
 */
export const BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT = specConstraint({
  path: 'operatorVersion',
  type: type(BARMAN_CLOUD_COMPATIBLE_CNPG_VERSION).configure({
    expected: `a CloudNativePG version ${BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION} or later`,
  }),
  required: true,
  code: 'CNPG_BARMAN_CLOUD_OPERATOR_INCOMPATIBLE',
  declaredWith: 'BARMAN_CLOUD_OPERATOR_VERSION_CONSTRAINT.type',
  message: (version) =>
    `The Barman Cloud plugin needs CloudNativePG ${BARMAN_CLOUD_PLUGIN_MINIMUM_CNPG_VERSION} or ` +
    `later; set operatorVersion to the operator version running in the plugin's namespace, ` +
    `such as "1.30.2" (cnpgBootstrap's default chart, 0.29.2, installs it; chart 0.23.0 ` +
    `installs 1.25.0); got ` +
    `${JSON.stringify(version)}.`,
});

/** A Barman retention policy such as `30d`, `4w` or `6m`, as the `ObjectStore` CRD requires. */
export const BARMAN_RETENTION_POLICY = /^[1-9][0-9]*[dwm]$/;

/** The `s3://<bucket>/<prefix>` shape of an `ObjectStore` destination. */
const S3_DESTINATION_SHAPE = /^s3:\/\/([^/]+)\/(.+?)\/?$/;

/**
 * True when `destination` is `s3://<bucket>/<prefix>` (optionally with a trailing `/`), with a
 * valid bucket name and a prefix as {@link S3_KEY_PREFIX} describes.
 */
export function isS3DestinationPath(destination: string): boolean {
  const match = S3_DESTINATION_SHAPE.exec(destination);
  return match !== null && isS3BucketName(match[1] ?? '') && S3_KEY_PREFIX.test(match[2] ?? '');
}

/**
 * The shape of an `ObjectStore` destination, as an instance-schema pattern: `s3://`, a bucket
 * shaped like {@link S3_BUCKET_NAME}, and a prefix like {@link S3_KEY_PREFIX}, optionally ending
 * in `/`. The bucket's length, IP-address and reserved-name rules are in
 * {@link S3_DESTINATION_PATH_RULE}.
 */
export const S3_DESTINATION_PATH = new RegExp(
  `^s3://${S3_BUCKET_NAME.source.slice(1, -1)}/${S3_KEY_PREFIX.source.slice(1, -1)}/?$`
);

/** {@link S3_BUCKET_NAME_RULE} and the bucket length, applied to the bucket of a destination. */
export const S3_DESTINATION_PATH_RULE =
  `matches(self, '^s3://[^/]{3,63}/') && ` +
  `!matches(self, '^s3://[0-9]+([.][0-9]+){3}/') && ` +
  `!matches(self, '^s3://(${S3_RESERVED_BUCKET_PREFIXES.map(celRegexLiteral).join('|')})') && ` +
  `!matches(self, '^s3://[^/]*(${S3_RESERVED_BUCKET_SUFFIXES.map(celRegexLiteral).join('|')})/')`;

/**
 * `destinationPath` of an `ObjectStore` from a composition spec: required, `s3://<bucket>/<prefix>`
 * with a valid bucket name. The pattern and the CEL rule are on the instance schema, so the API
 * server refuses a bad destination on a KRO instance. `objectStore()` accepts a destination only
 * known per instance when it comes from a required field declared with this type, or from
 * {@link s3DestinationPath} over constrained `bucket` and `prefix` fields.
 */
export const BARMAN_CLOUD_DESTINATION_PATH_CONSTRAINT = specConstraint({
  path: 'destinationPath',
  type: type(S3_DESTINATION_PATH).configure({ expected: 'an s3://<bucket>/<prefix> URL' }),
  rule: S3_DESTINATION_PATH_RULE,
  holds: isS3DestinationPath,
  required: true,
  code: 'CNPG_BARMAN_CLOUD_DESTINATION_INVALID',
  declaredWith: 'BARMAN_CLOUD_DESTINATION_PATH_CONSTRAINT.type',
  message: (destination) =>
    `ObjectStore destinationPath must be s3://<bucket>/<prefix> with a valid S3 bucket name ` +
    `and a non-empty prefix; got ${JSON.stringify(destination)}.`,
});

/** Destinations built by {@link s3DestinationPath} from constrained parts. */
const CHECKED_DESTINATIONS = new WeakSet<object>();

/**
 * `s3://<bucket>/<prefix>` for an `ObjectStore`. `bucket` and `prefix` are each checked with
 * {@link BARMAN_CLOUD_BUCKET_CONSTRAINT} and {@link BARMAN_CLOUD_PREFIX_CONSTRAINT}'s strict
 * `enforce()`: concrete values must be admitted, and values only known per instance must come
 * from required spec fields declared with those types, whose instance schema checks them. With
 * concrete parts the result is a string; otherwise a CEL template `objectStore()` accepts.
 */
export function s3DestinationPath(bucket: string, prefix: string): string {
  BARMAN_CLOUD_BUCKET_CONSTRAINT.enforce(bucket);
  BARMAN_CLOUD_PREFIX_CONSTRAINT.enforce(prefix);
  if (typeof bucket === 'string' && typeof prefix === 'string') return `s3://${bucket}/${prefix}`;
  const destination = Cel.template('s3://%s/%s', bucket, prefix);
  CHECKED_DESTINATIONS.add(destination as unknown as object);
  return destination;
}

/** True for a destination {@link s3DestinationPath} built from parts only known per instance. */
export function isCheckedDestination(destination: unknown): boolean {
  return (
    typeof destination === 'object' && destination !== null && CHECKED_DESTINATIONS.has(destination)
  );
}
