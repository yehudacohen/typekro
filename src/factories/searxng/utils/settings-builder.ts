/**
 * SearXNG Settings Builder
 *
 * Constructs a settings.yml string from typed configuration fields.
 * The result is passed as `settingsYaml` to the bootstrap composition,
 * which stores it in a ConfigMap. This approach works in both direct
 * and KRO mode because the YAML is a plain string, not proxy objects.
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
