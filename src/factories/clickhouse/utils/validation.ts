/**
 * Shared build-time validation for ClickHouse topology counts.
 *
 * The Altinity operator rejects a CHI/CHK layout with `shardsCount: 0` /
 * `replicasCount: 0` (and fractional or negative counts are never valid), so
 * every entry point that compiles a layout — the plain homogeneous path, the
 * zone-pinned path, the keeper compiler, and the `makeClickHouseCluster`
 * constructor — validates counts here BEFORE emitting operator input.
 *
 * The cluster NAME is validated here for a second reason on top of the
 * operator's own rules: it is interpolated into the `ON CLUSTER '<name>'`
 * clause of the scheduled backup, so it has to be an identifier and not a
 * value that can terminate a SQL string literal.
 */

import { type } from 'arktype';

/**
 * Assert that a topology count is a positive integer (>= 1).
 *
 * @param context - The entry point name for the error message
 *   (e.g. `clickHouseInstallation`)
 * @param field - The offending config field (e.g. `replicas`)
 * @param value - The value received
 * @throws Error naming the entry point, field, and received value when the
 *   value is zero, negative, or not an integer
 */
export function assertPositiveIntegerCount(
  context: string,
  field: string,
  value: number
): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${context}: '${field}' must be a positive integer (got ${JSON.stringify(value)}). ` +
        `The clickhouse-operator rejects a layout with a zero/invalid count — ` +
        `use ${field} >= 1, or omit the field to use the default of 1.`
    );
  }
}

/**
 * Characters and length a ClickHouse cluster name may use.
 *
 * This is the INTERSECTION of two independent constraints, not a guess:
 *
 * - THE OPERATOR. The Altinity CRD (release-0.27.1, the version this family
 *   installs) constrains `spec.configuration.clusters[].name` to
 *   `pattern: "^[a-zA-Z0-9-]{0,15}$"` with `minLength: 1` / `maxLength: 15`,
 *   annotated `See namePartClusterMaxLen const` — the name becomes a fragment
 *   of generated Kubernetes object names (`chi-<chi>-<cluster>-<shard>-<replica>`).
 *   So an underscore, or anything past 15 characters, is rejected by the API
 *   server no matter what TypeKro accepts; allowing it here would only move
 *   the failure to apply time.
 * - CLICKHOUSE. The same value is an identifier in `<remote_servers>` and the
 *   target of `ON CLUSTER '<name>'`, which the backup CronJob interpolates
 *   into a SQL string literal. A quote, a semicolon or whitespace there is not
 *   a naming problem, it is extra SQL.
 *
 * The intersection additionally requires a LEADING LETTER (ClickHouse reads
 * the value as a bare identifier in the cluster configuration, and a leading
 * digit or dash is not one) and forbids a TRAILING dash (it would leave a
 * dangling separator in every generated object name).
 *
 * RE2-compatible on purpose: the same source is the `pattern=` marker of the
 * generated KRO schema, and Kubernetes validates OpenAPI patterns with RE2.
 */
export const CLICKHOUSE_CLUSTER_NAME_PATTERN = /^[a-zA-Z]([a-zA-Z0-9-]{0,13}[a-zA-Z0-9])?$/;

/**
 * ArkType schema for a runtime `clusterName`.
 *
 * Used as the spec-schema type of `makeClickHouseCluster`'s optional
 * `clusterName`, so the pattern and the length bound travel into the generated
 * RGD (`string | maxLength=15 pattern="…"`) and KRO rejects a bad INSTANCE —
 * the case a build-time check cannot reach, because in kro mode the value is a
 * schema reference at construction.
 */
export const ClickHouseClusterNameSchema = type(CLICKHOUSE_CLUSTER_NAME_PATTERN).and(
  'string <= 15'
);

/**
 * Assert that a CONCRETE cluster name is safe to compile into operator input
 * and into the `ON CLUSTER` clause.
 *
 * Only meaningful for literals: in kro mode `spec.clusterName` arrives as a
 * schema reference, and {@link ClickHouseClusterNameSchema} carries the same
 * rule into the RGD for that path.
 *
 * @param context - The entry point name for the error message
 * @param field - The offending config field (e.g. `clusterName`)
 * @param value - The value received; non-strings are ignored (they are
 *   references, validated by KRO instead)
 * @throws Error naming the entry point, field, and received value when a
 *   concrete string does not match {@link CLICKHOUSE_CLUSTER_NAME_PATTERN}
 */
export function assertClickHouseClusterName(
  context: string,
  field: string,
  value: unknown
): void {
  if (typeof value !== 'string') return;
  if (CLICKHOUSE_CLUSTER_NAME_PATTERN.test(value)) return;
  throw new Error(
    `${context}: '${field}' must match ${CLICKHOUSE_CLUSTER_NAME_PATTERN.source} — a letter, ` +
      `then up to 14 more letters, digits or dashes, not ending in a dash (got ` +
      `${JSON.stringify(value)}). The bound is the intersection of the Altinity CRD's own ` +
      `\`^[a-zA-Z0-9-]{0,15}\$\` / maxLength 15 on \`clusters[].name\` (the name is a fragment ` +
      `of every generated object name) and ClickHouse's use of the value as an identifier — ` +
      `including inside the \`ON CLUSTER '<name>'\` string literal of the backup statement, ` +
      `where a quote or a semicolon would be extra SQL rather than a bad name.`
  );
}

/**
 * Characters a value may use when it becomes a ClickHouse configuration
 * IDENTIFIER — a bare `<name>` element inside a server-configuration document.
 *
 * Deliberately narrower than the XML `Name` production. ClickHouse reads these
 * elements as identifiers (a disk name, a volume name, a storage-policy name
 * referenced later by `SETTINGS storage_policy = '…'`), and TypeKro also has to
 * be able to WRITE the name into an XML element name, where escaping does not
 * exist as an option: a `>` closes the tag early, a space starts an attribute,
 * a quote or an `&` makes the document malformed, and a leading digit is not a
 * legal Name at all. Restricting to the SQL-identifier shape keeps the value
 * usable in every position it reaches with no encoding step anywhere.
 *
 * Same shape as the `storage.backup.database` check in `utils/s3-storage.ts`,
 * for the same reason: a bare identifier needs no quoting to be safe.
 */
export const CLICKHOUSE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Length bound for a {@link CLICKHOUSE_IDENTIFIER_PATTERN} identifier.
 *
 * Not a ClickHouse limit — the server is far more permissive. It is a sanity
 * bound so a runaway or generated value fails at build time with a readable
 * message instead of producing a multi-kilobyte element name that only fails
 * when the server parses `config.d/storage.xml` at startup.
 */
export const CLICKHOUSE_IDENTIFIER_MAX_LENGTH = 64;

/**
 * Assert that a value is safe to compile into an XML ELEMENT NAME (and to
 * reference from SQL) inside a ClickHouse server-configuration document.
 *
 * Unlike {@link assertClickHouseClusterName} this does NOT skip non-strings:
 * every caller validates a value that is concrete by construction (the S3
 * storage branch rejects schema references wholesale before resolving, because
 * the values compile into an XML document), so a non-string here is a caller
 * bug rather than a reference to be validated by KRO later.
 *
 * @param context - The entry point name for the error message
 * @param field - The offending config field (e.g. `storage.policyName`)
 * @param value - The value received
 * @throws Error naming the entry point, field, and received value when the
 *   value is not a string, is empty, does not match
 *   {@link CLICKHOUSE_IDENTIFIER_PATTERN}, or exceeds
 *   {@link CLICKHOUSE_IDENTIFIER_MAX_LENGTH}
 */
export function assertClickHouseIdentifier(context: string, field: string, value: unknown): void {
  if (
    typeof value === 'string' &&
    value.length <= CLICKHOUSE_IDENTIFIER_MAX_LENGTH &&
    CLICKHOUSE_IDENTIFIER_PATTERN.test(value)
  ) {
    return;
  }
  throw new Error(
    `${context}: '${field}' must be a bare ClickHouse identifier matching ` +
      `${CLICKHOUSE_IDENTIFIER_PATTERN.source} — a letter or underscore, then letters, digits ` +
      `or underscores, at most ${CLICKHOUSE_IDENTIFIER_MAX_LENGTH} characters (got ` +
      `${JSON.stringify(value)}). The value is rendered as an XML ELEMENT NAME in the ` +
      `server's \`config.d/storage.xml\`, where escaping is not available: a '>' would close ` +
      `the tag, a space would start an attribute, and a leading digit is not a legal name — ` +
      `so the value has to be constrained rather than encoded.`
  );
}
