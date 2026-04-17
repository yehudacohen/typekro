/**
 * Composable Type Utility
 *
 * Makes optional fields in config interfaces accept `undefined` values,
 * enabling seamless composition of resources from proxy-sourced values.
 *
 * ## Problem
 *
 * With `exactOptionalPropertyTypes: true`, TypeScript distinguishes between:
 * - `{ field?: string }` — key can be absent, but if present must be `string`
 * - `{ field?: string | undefined }` — key can be absent OR present with `undefined`
 *
 * In a `kubernetesComposition`, accessing an optional spec field like
 * `spec.database.instances` returns `number | undefined`. Passing this to a
 * factory that expects `instances?: number` causes a type error because
 * `undefined` is not assignable to `number`.
 *
 * ## Solution
 *
 * `Composable<T>` recursively transforms optional fields to accept `undefined`,
 * while keeping required fields strictly required. Apply it to factory function
 * parameters so the interface stays clean and compositions work naturally.
 *
 * @example
 * ```typescript
 * // Interface stays clean
 * interface ClusterConfig {
 *   name: string;           // required — stays required
 *   namespace?: string;     // optional — Composable adds | undefined
 *   spec: {
 *     instances?: number;   // optional — Composable adds | undefined
 *     storage: { size: string };  // required nested — stays required
 *   };
 * }
 *
 * // Factory accepts composable version
 * function cluster(config: Composable<ClusterConfig>): Enhanced<...> { ... }
 *
 * // In a composition — proxy values pass through cleanly
 * cluster({
 *   name: spec.name,                  // string — OK
 *   namespace: spec.namespace,        // string | undefined — OK with Composable
 *   spec: {
 *     instances: spec.db.instances,   // number | undefined — OK with Composable
 *     storage: { size: spec.db.size }, // string — OK
 *   },
 * });
 * ```
 */

/**
 * Recursively makes optional properties accept `undefined`.
 *
 * - Required fields stay strictly required (compile error if missing)
 * - Optional fields (`?:`) additionally accept `undefined` as a value
 * - Recurses into nested objects (but not arrays or primitives)
 *
 * @typeParam T - The strict config interface to make composition-friendly
 */
export type Composable<T> = {
  [K in keyof T]: undefined extends T[K]
    ? Exclude<T[K], undefined> extends object
      ? Exclude<T[K], undefined> extends unknown[] | Date | RegExp | Map<unknown, unknown> | Set<unknown> | ((...args: never[]) => unknown)
        ? T[K] | undefined
        : Composable<Exclude<T[K], undefined>> | undefined
      : T[K] | undefined
    : T[K] extends object
      ? T[K] extends unknown[] | Date | RegExp | Map<unknown, unknown> | Set<unknown> | ((...args: never[]) => unknown)
        ? T[K]
        : Composable<T[K]>
      : T[K];
};
