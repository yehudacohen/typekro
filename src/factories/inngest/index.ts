/**
 * Inngest Integration for TypeKro
 *
 * Provides type-safe deployment of Inngest on Kubernetes via the
 * official Helm chart. Inngest is a workflow orchestration platform
 * with no CRDs — all configuration is through Helm values.
 *
 * ## Resources
 * - `inngestHelmRepository()` — OCI Helm chart repository
 * - `inngestHelmRelease()` — Inngest deployment via Helm
 *
 * ## Compositions
 * - `inngestBootstrap` — Complete deployment (namespace + Helm repo + release)
 *
 * @example
 * ```typescript
 * import { inngestBootstrap } from 'typekro/inngest';
 *
 * const factory = inngestBootstrap.factory('kro', {
 *   namespace: 'inngest',
 * });
 *
 * await factory.deploy({
 *   name: 'inngest',
 *   namespace: 'inngest',
 *   inngest: {
 *     eventKey: 'your-event-key',
 *     signingKey: 'your-signing-key',
 *     postgres: { uri: 'postgresql://...' },
 *     redis: { uri: 'redis://...' },
 *   },
 *   postgresql: { enabled: false },
 *   redis: { enabled: false },
 * });
 * ```
 *
 * @see https://github.com/inngest/inngest-helm
 * @see https://www.inngest.com/docs/self-hosting
 * @module
 */
export * from './compositions/index.js';
export * from './resources/index.js';
export * from './types.js';
export * from './utils/index.js';
