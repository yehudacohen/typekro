/**
 * Dagster Integration for TypeKro.
 *
 * Provides type-safe deployment primitives for Dagster OSS on Kubernetes via
 * the official Dagster Helm chart.
 *
 * ## Resources
 * - `dagsterHelmRepository()` - official Dagster Helm chart repository
 * - `dagsterHelmRelease()` - Dagster deployment via Flux HelmRelease
 *
 * ## Compositions
 * - `dagsterBootstrap` - complete Dagster deployment using Namespace, HelmRepository, and HelmRelease
 *
 * @example
 * ```typescript
 * import { dagsterBootstrap } from 'typekro/dagster';
 *
 * const factory = dagsterBootstrap.factory('kro', {
 *   namespace: 'dagster',
 * });
 * ```
 *
 * @see https://dagster.io/
 * @see https://github.com/dagster-io/dagster/tree/master/helm/dagster
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';