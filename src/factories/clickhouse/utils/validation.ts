/**
 * Shared build-time validation for ClickHouse topology counts.
 *
 * The Altinity operator rejects a CHI/CHK layout with `shardsCount: 0` /
 * `replicasCount: 0` (and fractional or negative counts are never valid), so
 * every entry point that compiles a layout — the plain homogeneous path, the
 * zone-pinned path, the keeper compiler, and the `makeClickHouseCluster`
 * constructor — validates counts here BEFORE emitting operator input.
 */

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
