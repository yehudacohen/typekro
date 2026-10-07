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
// Exported for integrations that name a plugin (CrowdSec's bouncer); not
// re-exported from `typekro/traefik`.
export const TRAEFIK_PLUGIN_NAME: RegExp = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// The chart writes `moduleName`, `version`, a local plugin's `volumeName` and
// `subPath`, and inline source file names into its templates unescaped. A
// quote or newline there would add YAML of the caller's choosing (another
// argument, mount or manifest) behind every check TypeKro runs on the values,
// so each is held to the characters its real form uses.
// A Go module path: letters, digits and `-._~/`.
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/;
// A release tag such as `v1.4.2` or `v2.0.0-rc.1+build.5`.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// A Kubernetes volume name (DNS-1123 label).
const VOLUME_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
// A relative path inside the volume.
const SUB_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;
// A ConfigMap key: `[-._a-zA-Z0-9]+`, at most 253 characters, and neither
// `.`, `..` nor anything starting with `..` (Kubernetes' IsConfigMapKey).
const FILE_NAME = /^[-._A-Za-z0-9]{1,253}$/;
// A local plugin's name becomes a volume name (`inlinePlugin`) and part of the
// ConfigMap the chart creates, `<release>-local-plugin-<name>`, so it must be
// a DNS-1123 label. The release part is at most 63 characters (the chart
// truncates it), so that name is at most 63 + 14 + 63 = 140 characters, well
// inside the 253 a ConfigMap name allows.
const LOCAL_PLUGIN_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
// Volumes the chart itself adds to the pod, which an inline plugin's volume
// (named after the plugin) would collide with.
const CHART_VOLUME_NAMES = new Set(['data', 'tmp', 'plugins', 'hub-token', 'traefik-extra-config']);

/**
 * Volume names raw chart values add to the Traefik pod, where they are
 * literal: `volumes[].name` (with "." turned into "-", as the chart does),
 * `persistence.name` and `deployment.additionalVolumes[].name`.
 */
export function traefikRawVolumeNames(values: Readonly<Record<string, unknown>>): string[] {
  const names: string[] = [];
  const nameOf = (entry: unknown): unknown =>
    typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined;
  const listNames = (list: unknown, transform: (name: string) => string) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const name = nameOf(entry);
      // A templated name is only known at render time; skip it.
      if (typeof name === 'string' && !name.includes('{{')) names.push(transform(name));
    }
  };
  listNames(values.volumes, (name) => name.replaceAll('.', '-'));
  const persistenceName = nameOf(values.persistence);
  if (typeof persistenceName === 'string') names.push(persistenceName);
  const deployment = values.deployment;
  if (typeof deployment === 'object' && deployment !== null) {
    listNames(Reflect.get(deployment, 'additionalVolumes'), (name) => name);
  }
  return names;
}

function isConfigMapKey(key: string): boolean {
  return FILE_NAME.test(key) && key !== '.' && !key.startsWith('..');
}

function hasParentSegment(path: string): boolean {
  return path.split('/').includes('..');
}

/** Where Traefik loads a local plugin from: `./plugins-local/src/<moduleName>`. */
export function traefikLocalPluginMountPath(moduleName: string): string {
  return `/plugins-local/src/${moduleName}`;
}

/** Problems with plugin declarations; empty when there are none. */
export function traefikPluginIssues(
  plugins: Readonly<Record<string, TraefikPluginDeclaration>> = {},
  localPlugins: Readonly<Record<string, TraefikLocalPluginDeclaration>> = {},
  rawVolumeNames: readonly string[] = []
): string[] {
  const issues: string[] = [];
  const takenVolumeNames = new Set([...CHART_VOLUME_NAMES, ...rawVolumeNames]);
  for (const [name, plugin] of Object.entries(plugins)) {
    if (!TRAEFIK_PLUGIN_NAME.test(name)) {
      issues.push(`plugin name ${name} must match ${TRAEFIK_PLUGIN_NAME}.`);
    }
    if (!MODULE_NAME.test(plugin.moduleName)) {
      issues.push(`plugin ${name} needs a Go module path as its moduleName.`);
    }
    if (!VERSION.test(plugin.version) || plugin.version === 'latest') {
      issues.push(`plugin ${name} needs an exact version, not ${JSON.stringify(plugin.version)}.`);
    }
    if (!SHA256_HEX.test(plugin.hash)) {
      issues.push(`plugin ${name} hash must be the archive's SHA-256 as 64 lowercase hex digits.`);
    }
  }
  for (const [name, plugin] of Object.entries(localPlugins)) {
    if (!LOCAL_PLUGIN_NAME.test(name)) {
      issues.push(
        `local plugin name ${name} must be a DNS-1123 label (lowercase letters, digits and "-", ` +
          'at most 63 characters): the chart uses it in a volume and a ConfigMap name.'
      );
    } else if (plugin.type === 'inlinePlugin' && takenVolumeNames.has(name)) {
      issues.push(
        `local plugin name ${name} is a volume name the pod already has (the chart's own, ` +
          'or one from raw volumes, persistence or deployment.additionalVolumes).'
      );
    }
    if (name in plugins)
      issues.push(`plugin ${name} is declared both as a registry and a local plugin.`);
    if (!MODULE_NAME.test(plugin.moduleName) || plugin.moduleName.includes('..')) {
      issues.push(`local plugin ${name} needs a Go module path without ".." as its moduleName.`);
    }
    if (plugin.type === 'inlinePlugin') {
      const files = Object.keys(plugin.source);
      if (files.length === 0) issues.push(`local plugin ${name} has no source files.`);
      for (const file of files.filter((file) => !isConfigMapKey(file))) {
        issues.push(
          `local plugin ${name} source file ${JSON.stringify(file)} must be a ConfigMap key ` +
            '(letters, digits, "-", "_" and ".", not "." or starting with "..").'
        );
      }
    } else {
      if (!VOLUME_NAME.test(plugin.volumeName)) {
        issues.push(`local plugin ${name} volumeName must be a Kubernetes volume name.`);
      }
      if (
        plugin.subPath !== undefined &&
        (!SUB_PATH.test(plugin.subPath) || hasParentSegment(plugin.subPath))
      ) {
        issues.push(`local plugin ${name} subPath must be a relative path without "..".`);
      }
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
  localPlugins?: Readonly<Record<string, TraefikLocalPluginDeclaration>>,
  rawVolumeNames?: readonly string[]
): void {
  const issues = traefikPluginIssues(plugins, localPlugins, rawVolumeNames);
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
