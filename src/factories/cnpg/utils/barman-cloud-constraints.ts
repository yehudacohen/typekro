// Spec constraints of the Barman Cloud plugin compositions, each declared once and enforced in
// both deployment modes: the instance schema carries the pattern or enum, so the API server
// refuses a bad KRO instance, and the composition body refuses it in direct mode.

import { type } from 'arktype';
import { specConstraint } from '../../../core/validation/spec-constraint.js';
import { BARMAN_CLOUD_PLUGIN_CHART_VERSION } from '../constants.js';

/**
 * An S3 general-purpose bucket name: 3 to 63 lowercase letters, digits, dots and hyphens,
 * starting and ending with a letter or digit.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
 */
export const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * A key prefix inside the bucket: one or more `/`-separated segments of letters, digits, `.`,
 * `_` and `-`, with no leading, trailing or doubled `/`. The plugin adds `/<serverName>/`.
 */
export const S3_KEY_PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** `bucket`: a non-empty S3 bucket name. The pattern is on the instance schema. */
export const BARMAN_CLOUD_BUCKET_CONSTRAINT = specConstraint({
  path: 'bucket',
  type: type(S3_BUCKET_NAME).configure({ expected: 'an S3 bucket name' }),
  code: 'CNPG_BARMAN_CLOUD_BUCKET_INVALID',
  message: (bucket) => `bucket must be an S3 bucket name; got ${JSON.stringify(bucket)}.`,
});

/**
 * `prefix`: a non-empty key prefix, so several clusters can share a bucket without sharing a
 * path. The pattern is on the instance schema.
 */
export const BARMAN_CLOUD_PREFIX_CONSTRAINT = specConstraint({
  path: 'prefix',
  type: type(S3_KEY_PREFIX).configure({ expected: 'a key prefix like "cnpg/production"' }),
  code: 'CNPG_BARMAN_CLOUD_PREFIX_INVALID',
  message: (prefix) =>
    `prefix must be a non-empty key prefix like "cnpg/production", without a leading or ` +
    `trailing "/"; got ${JSON.stringify(prefix)}.`,
});

/**
 * `version` of the plugin install composition: exactly the pinned chart version. Its enum is on
 * the instance schema, so the API server refuses a KRO instance asking for another chart.
 */
export const BARMAN_CLOUD_PLUGIN_VERSION_CONSTRAINT = specConstraint({
  path: 'version',
  type: type
    .unit(BARMAN_CLOUD_PLUGIN_CHART_VERSION)
    .configure({ expected: `the pinned chart version ${BARMAN_CLOUD_PLUGIN_CHART_VERSION}` }),
  code: 'CNPG_BARMAN_CLOUD_CHART_VERSION_MISMATCH',
  message: (version) =>
    `The Barman Cloud plugin chart is pinned at ${BARMAN_CLOUD_PLUGIN_CHART_VERSION}; ` +
    `got ${JSON.stringify(version)}.`,
});

/** A Barman retention policy such as `30d`, `4w` or `6m`, as the `ObjectStore` CRD requires. */
export const BARMAN_RETENTION_POLICY = /^[1-9][0-9]*[dwm]$/;

/** The `s3://<bucket>/<prefix>` destination of an `ObjectStore`. */
export const S3_DESTINATION_PATH = new RegExp(
  `^s3://${S3_BUCKET_NAME.source.slice(1, -1)}/${S3_KEY_PREFIX.source.slice(1, -1)}/?$`
);
