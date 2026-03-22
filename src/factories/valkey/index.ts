/**
 * Hyperspike Valkey Operator Integration for TypeKro
 *
 * Provides type-safe factories for managing Valkey clusters on Kubernetes
 * using the Hyperspike Valkey operator.
 *
 * ## Resources
 * - `valkey()` — Valkey cluster (sharded with optional replicas)
 * - `valkeyHelmRepository()` — Helm chart repository (OCI)
 * - `valkeyHelmRelease()` — Operator installation via Helm
 *
 * ## Compositions
 * - `valkeyBootstrap` — Complete operator deployment (namespace + Helm repo + release)
 *
 * @example
 * ```typescript
 * import { valkeyBootstrap, valkey } from 'typekro/valkey';
 *
 * // Install the operator
 * const operatorFactory = valkeyBootstrap.factory('kro', {
 *   namespace: 'valkey-operator-system',
 * });
 * await operatorFactory.deploy({
 *   name: 'valkey-operator',
 *   namespace: 'valkey-operator-system',
 * });
 *
 * // Create a Valkey cluster
 * const cache = valkey({
 *   name: 'app-cache',
 *   namespace: 'default',
 *   spec: {
 *     shards: 3,
 *     replicas: 1,
 *     storage: {
 *       resources: { requests: { storage: '10Gi' } },
 *     },
 *   },
 *   id: 'appCache',
 * });
 * ```
 *
 * @see https://github.com/hyperspike/valkey-operator
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
