/**
 * SearXNG Settings Builder
 *
 * Constructs a settings.yml string from typed configuration fields.
 * Pass the result as `settingsYaml` to the bootstrap composition in direct
 * mode when you need full control over the generated ConfigMap. KRO mode
 * ignores `settingsYaml` from the schema because it is a proxy reference, not
 * a concrete string available at RGD generation time.
 *
 * @example
 * ```typescript
 * import { buildSearxngSettings } from 'typekro/searxng';
 *
 * const settings = buildSearxngSettings({
 *   server: { limiter: false },
 *   search: { formats: ['html', 'json'] },
 *   redisUrl: 'redis://valkey:6379/0',
 * });
 * // Returns a valid settings.yml string
 * ```
 */

import yaml from 'js-yaml';

export interface SearxngSettingsInput {
  /** Server configuration. secret_key is stripped (use SEARXNG_SECRET env var). */
  server?: {
    secret_key?: string;
    limiter?: boolean;
    bind_address?: string;
    method?: string;
  };
  /** Search configuration. */
  search?: {
    formats?: string[];
    default_lang?: string;
    autocomplete?: string;
    safe_search?: 0 | 1 | 2;
  };
  /** Redis/Valkey URL for the built-in rate limiter. */
  redisUrl?: string;
}

/**
 * Build a SearXNG settings.yml string from typed configuration.
 *
 * The secret_key is automatically stripped — it should be injected
 * via the SEARXNG_SECRET environment variable, not stored in the ConfigMap.
 */
export function buildSearxngSettings(input: SearxngSettingsInput): string {
  const settings: Record<string, unknown> = {
    use_default_settings: true,
  };

  if (input.server) {
    const { secret_key: _, ...serverWithoutSecret } = input.server;
    if (Object.keys(serverWithoutSecret).length > 0) {
      settings.server = serverWithoutSecret;
    }
  }

  if (input.search) {
    settings.search = input.search;
  }

  if (input.redisUrl) {
    if (!settings.server) settings.server = {};
    const server = settings.server as Record<string, unknown>;
    if (server.limiter !== false) {
      server.limiter = true;
    }
    settings.redis = { url: input.redisUrl };
  }

  return yaml.dump(settings, { lineWidth: -1 });
}
