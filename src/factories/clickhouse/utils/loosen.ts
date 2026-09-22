/**
 * `Composable<T>` Input Loosening
 *
 * TypeKro's proxy mapping turns `x?: T` into `x: T | undefined`, which under
 * `exactOptionalPropertyTypes: true` does NOT assign to a plain `x?: T`. Every
 * ClickHouse helper that takes a slice of a `Composable<ClickHouseInstallationConfig>`
 * and validates it at RUN time therefore declares its input through this type:
 * the compile-time shape is a convenience, and the runtime check is the
 * contract.
 *
 * @module
 */

/**
 * Deeply loosen optional properties so a `Composable<T>` value assigns under
 * `exactOptionalPropertyTypes`.
 */
export type Loosen<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { readonly [K in keyof T]?: Loosen<T[K]> | undefined }
      : T;
