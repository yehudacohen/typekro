/**
 * SearXNG Integration
 *
 * Privacy-respecting metasearch engine that aggregates results from
 * multiple search providers (Google, Bing, DuckDuckGo, Brave, etc.).
 *
 * @example
 * ```typescript
 * import { searxngBootstrap } from 'typekro/searxng';
 *
 * const factory = searxngBootstrap.factory('direct', {
 *   namespace: 'search',
 *   waitForReady: true,
 * });
 *
 * await factory.deploy({
 *   name: 'searxng',
 *   search: { formats: ['html', 'json'] },
 *   server: { limiter: false, secret_key: 'change-me' },
 * });
 * ```
 */

export { searxngBootstrap } from './compositions/index.js';
export { searxng, searxngConfigMap } from './resources/index.js';
export type {
  SearxngBootstrapConfig,
  SearxngBootstrapStatus,
  SearxngConfig,
  SearxngStatus,
} from './types.js';
export { DEFAULT_SEARXNG_IMAGE, DEFAULT_SEARXNG_PORT } from './types.js';
