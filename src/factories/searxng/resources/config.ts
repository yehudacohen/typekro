/**
 * SearXNG ConfigMap Factory
 *
 * Creates a ConfigMap containing the SearXNG settings.yml.
 * Uses js-yaml for correct serialization. The secret_key is NOT
 * stored here — it's injected via the SEARXNG_SECRET env var from
 * a K8s Secret (see the bootstrap composition).
 */

import yaml from 'js-yaml';
import type { Composable, Enhanced } from '../../../core/types/index.js';
import { configMap } from '../../kubernetes/config/config-map.js';

export interface SearxngConfigMapConfig {
  name: string;
  namespace?: string;
  id?: string;
  /** SearXNG settings object — serialized to settings.yml. */
  settings: Record<string, unknown>;
}

/**
 * Create a ConfigMap for SearXNG settings.
 *
 * Note: secret_key should NOT be in the settings object. Use the
 * SEARXNG_SECRET environment variable via a K8s Secret instead.
 *
 * @example
 * ```typescript
 * const config = searxngConfigMap({
 *   name: 'my-searxng-config',
 *   settings: {
 *     use_default_settings: true,
 *     server: { limiter: false },
 *     search: { formats: ['html', 'json'] },
 *   },
 * });
 * ```
 */
function createSearxngConfigMap(
  config: Composable<SearxngConfigMapConfig>
): Enhanced<Record<string, unknown>, Record<string, never>> {
  // Deep-clone to strip proxy objects, then remove secret_key
  const plainSettings = JSON.parse(JSON.stringify(config.settings));
  const sanitizedSettings = stripSecretKey(plainSettings);
  const settingsYaml = yaml.dump(sanitizedSettings, { lineWidth: -1 });

  return configMap({
    metadata: {
      name: config.name,
      ...(config.namespace && { namespace: config.namespace }),
      labels: {
        'app.kubernetes.io/name': 'searxng',
        'app.kubernetes.io/component': 'config',
        'app.kubernetes.io/managed-by': 'typekro',
      },
    },
    data: {
      'settings.yml': settingsYaml,
    },
    ...(config.id && { id: config.id }),
  }) as Enhanced<Record<string, unknown>, Record<string, never>>;
}

/** Remove secret_key from settings (it belongs in a K8s Secret, not ConfigMap). */
function stripSecretKey(settings: Record<string, unknown>): Record<string, unknown> {
  const result = { ...settings };
  if (result.server && typeof result.server === 'object') {
    const server = { ...(result.server as Record<string, unknown>) };
    delete server.secret_key;
    result.server = server;
  }
  return result;
}

export const searxngConfigMap = createSearxngConfigMap;
