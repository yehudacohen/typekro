/**
 * Traefik plugin declarations (`experimental.plugins` / `experimental.localPlugins`).
 */
// Traefik downloads a registry plugin from plugins.traefik.io at startup and,
// when `hash` is set, compares the SHA-256 of the downloaded archive with it
// and refuses to load a mismatch (`pkg/plugins/manager.go`, InstallPlugin).
// Without a hash it only asks the registry whether the archive is intact, so
// whoever controls the registry, the network path or a re-tagged version
// decides what code runs inside the edge. That is why `hash` is required here.
//
// To find the hash, download the archive the edge would fetch and hash it:
//   curl -sL https://plugins.traefik.io/public/download/<moduleName>/<version> | sha256sum
// Traefik's own error for a wrong hash also prints the hash it computed.

import { TypeKroError } from '../../../core/errors.js';
import type { TraefikLocalPluginDeclaration, TraefikPluginDeclaration } from '../types.js';

// Plugin names become CLI flag segments (`--experimental.plugins.<name>...`)
// and `Middleware.spec.plugin` keys, so they stay to one flag-safe word.
const PLUGIN_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Where Traefik loads a local plugin from: `./plugins-local/src/<moduleName>`. */
export function traefikLocalPluginMountPath(moduleName: string): string {
  return `/plugins-local/src/${moduleName}`;
}

/** Problems with plugin declarations; empty when there are none. */
export function traefikPluginIssues(
  plugins: Readonly<Record<string, TraefikPluginDeclaration>> = {},
  localPlugins: Readonly<Record<string, TraefikLocalPluginDeclaration>> = {}
): string[] {
  const issues: string[] = [];
  for (const [name, plugin] of Object.entries(plugins)) {
    if (!PLUGIN_NAME.test(name)) issues.push(`plugin name ${name} must match ${PLUGIN_NAME}.`);
    if (plugin.moduleName.trim() === '') issues.push(`plugin ${name} needs a moduleName.`);
    if (plugin.version.trim() === '' || plugin.version === 'latest') {
      issues.push(`plugin ${name} needs an exact version, not ${JSON.stringify(plugin.version)}.`);
    }
    if (!SHA256_HEX.test(plugin.hash)) {
      issues.push(`plugin ${name} hash must be the archive's SHA-256 as 64 lowercase hex digits.`);
    }
  }
  for (const [name, plugin] of Object.entries(localPlugins)) {
    if (!PLUGIN_NAME.test(name))
      issues.push(`local plugin name ${name} must match ${PLUGIN_NAME}.`);
    if (name in plugins)
      issues.push(`plugin ${name} is declared both as a registry and a local plugin.`);
    if (plugin.moduleName.trim() === '' || plugin.moduleName.includes('..')) {
      issues.push(`local plugin ${name} needs a moduleName without "..".`);
    }
    if (plugin.type === 'inlinePlugin' && Object.keys(plugin.source).length === 0) {
      issues.push(`local plugin ${name} has no source files.`);
    }
  }
  return issues;
}

/**
 * Throw when a plugin declaration is malformed or unpinned.
 *
 * @throws {TypeKroError} With code `TRAEFIK_PLUGIN_INVALID`.
 */
export function assertTraefikPlugins(
  plugins?: Readonly<Record<string, TraefikPluginDeclaration>>,
  localPlugins?: Readonly<Record<string, TraefikLocalPluginDeclaration>>
): void {
  const issues = traefikPluginIssues(plugins, localPlugins);
  if (issues.length === 0) return;
  throw new TypeKroError(
    `Invalid Traefik plugin declaration: ${issues.join(' ')}`,
    'TRAEFIK_PLUGIN_INVALID',
    { issues }
  );
}

/**
 * A plugin configuration value Traefik reads from a Secret in the Middleware's namespace.
 *
 * Traefik's CRD provider resolves `urn:k8s:secret:<secret>:<key>` strings at any
 * depth of a `plugin` middleware's configuration. Only plugin configuration is
 * resolved this way.
 *
 * @example
 * ```typescript
 * traefikPluginMiddleware({
 *   name: 'bouncer', namespace: 'edge', plugin: 'crowdsec',
 *   config: { apiKey: traefikSecretValue('bouncer-key', 'api-key') },
 * });
 * ```
 */
export function traefikSecretValue(secretName: string, key: string): string {
  // Traefik splits the URN on ':' and expects exactly five parts.
  for (const [what, value] of [
    ['secret name', secretName],
    ['key', key],
  ] as const) {
    if (value === '' || value.includes(':')) {
      throw new TypeKroError(
        `Invalid Traefik secret reference: the ${what} must be non-empty and contain no ":".`,
        'TRAEFIK_SECRET_REFERENCE_INVALID',
        { secretName, key }
      );
    }
  }
  return `urn:k8s:secret:${secretName}:${key}`;
}
