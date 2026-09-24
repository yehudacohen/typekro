/**
 * HyperDX OIDC sign-in for `makeClickstackBootstrap` — the `hyperdxOidc`
 * build option.
 *
 * HyperDX's open-source build authenticates only with email and password; its
 * SSO is a commercial feature. TypeKro ships an OIDC plugin (source:
 * `plugins/hyperdx-oidc/`) that joins HyperDX's own authentication path — it
 * registers one Passport strategy per provider on HyperDX's `passport`, adds
 * `/api/login/oidc/...` routes to its root router, and ends every login in
 * `req.logIn()`, so a signed-in user holds an ordinary HyperDX session.
 *
 * This module wires it in, without forking or rebuilding the HyperDX image:
 *
 * - a ConfigMap `<release>-hyperdx-oidc-plugin` carries the bundled plugin as
 *   `binaryData` (base64 keeps bundled JavaScript away from KRO's `${...}`
 *   template syntax);
 * - `NODE_OPTIONS=--require=<plugin>` loads it into the HyperDX container. The
 *   image's entry script overwrites the env it cares about, but not
 *   `NODE_OPTIONS`; the plugin activates only in the API process;
 * - the provider configuration comes from a caller-owned Secret, mounted as a
 *   whole directory (not `subPath`), so the kubelet refreshes the file when the
 *   Secret changes and the plugin applies it without a restart;
 * - a pod annotation carries the plugin's SHA-256, so a new plugin build rolls
 *   the pod (a running process never re-reads its code).
 *
 * The configuration document's format is defined by
 * `plugins/hyperdx-oidc/src/config.ts` and documented in
 * docs/api/clickstack/index.md.
 *
 * @module
 */

import {
  HYPERDX_OIDC_PLUGIN_BASE64,
  HYPERDX_OIDC_PLUGIN_BYTES,
  HYPERDX_OIDC_PLUGIN_SHA256,
} from './plugin-bundle.generated.js';

export { HYPERDX_OIDC_PLUGIN_BYTES, HYPERDX_OIDC_PLUGIN_SHA256 };

/** Build-time options for HyperDX OIDC sign-in. */
export interface ClickStackHyperdxOidcOptions {
  /**
   * The Secret holding the plugin's JSON configuration: providers (issuer,
   * client id and secret, claims, allow rules), `passwordLogin`,
   * `maxSessionAge`. Caller-owned — create it with kubectl, alchemy, or an
   * external-secrets controller. It must be in the release's namespace.
   */
  configSecretRef: {
    name: string;
    /** Key within the Secret. Default `oidc.json`. */
    key?: string;
  };
  /** How often the plugin re-reads the configuration, in seconds. Default 15. */
  reloadSeconds?: number;
  /**
   * The plugin hooks HyperDX internals (its Passport instance, root router and
   * user/team models), so it is enabled only on audited chart versions (see
   * {@link CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS}). The plugin also
   * self-checks at startup and disables itself if a hook point is missing.
   * Set this to accept an unaudited chart after verifying it.
   */
  allowUnvalidatedChartVersion?: boolean;
}

/** Chart versions the plugin is audited against (appVersion 2.35.0). */
export const CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS = ['3.2.0'] as const;

/** HyperDX app version of the audited chart. */
export const CLICKSTACK_HYPERDX_OIDC_VALIDATED_APP_VERSION = '2.35.0';

/** Default key of the configuration document in the caller's Secret. */
export const HYPERDX_OIDC_CONFIG_DEFAULT_KEY = 'oidc.json';

/** Directory the plugin ConfigMap is mounted at. */
export const HYPERDX_OIDC_PLUGIN_DIR = '/opt/typekro/hyperdx-oidc';
/** Directory the configuration Secret is mounted at. */
export const HYPERDX_OIDC_CONFIG_DIR = '/etc/typekro/hyperdx-oidc';
/** File name of the plugin inside its mount. */
export const HYPERDX_OIDC_PLUGIN_FILE = 'plugin.js';
/** File name of the configuration inside its mount. */
export const HYPERDX_OIDC_CONFIG_FILE = 'config.json';

/** Pod annotation carrying the plugin's SHA-256, so a new plugin rolls the pod. */
export const HYPERDX_OIDC_PLUGIN_HASH_ANNOTATION = 'typekro.io/hyperdx-oidc-plugin-sha256';

const PLUGIN_VOLUME = 'typekro-hyperdx-oidc-plugin';
const CONFIG_VOLUME = 'typekro-hyperdx-oidc-config';
/** Env names the plugin wiring owns; a caller setting any of them is refused. */
const OWNED_ENV = [
  'NODE_OPTIONS',
  'TYPEKRO_HDX_OIDC_CONFIG',
  'TYPEKRO_HDX_OIDC_RELOAD_SECONDS',
  'TYPEKRO_HDX_OIDC_CREATE_TEAM',
] as const;

/** RFC 1123 subdomain: a Secret's name. */
const SECRET_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** A Secret data key. */
const SECRET_KEY = /^[-._a-zA-Z0-9]+$/;

/** The option with defaults applied and validated. */
export interface ResolvedClickStackHyperdxOidc {
  readonly configSecretName: string;
  readonly configSecretKey: string;
  readonly reloadSeconds: number;
  readonly allowUnvalidatedChartVersion: boolean;
}

/**
 * Validate the build option and apply defaults.
 *
 * @param context - Caller name, quoted in errors
 * @param options - The build option, or `undefined`
 */
export function resolveClickStackHyperdxOidc(
  context: string,
  options: ClickStackHyperdxOidcOptions | undefined
): ResolvedClickStackHyperdxOidc | undefined {
  if (options === undefined) return undefined;
  const name = options.configSecretRef?.name;
  if (typeof name !== 'string' || name.length > 253 || !SECRET_NAME.test(name)) {
    throw new Error(
      `${context}: hyperdxOidc.configSecretRef.name ${JSON.stringify(name)} is not a valid Secret name.`
    );
  }
  const key = options.configSecretRef.key ?? HYPERDX_OIDC_CONFIG_DEFAULT_KEY;
  if (typeof key !== 'string' || key.length > 253 || !SECRET_KEY.test(key)) {
    throw new Error(
      `${context}: hyperdxOidc.configSecretRef.key ${JSON.stringify(key)} is not a valid Secret key.`
    );
  }
  const reloadSeconds = options.reloadSeconds ?? 15;
  if (!Number.isInteger(reloadSeconds) || reloadSeconds < 1 || reloadSeconds > 3600) {
    throw new Error(
      `${context}: hyperdxOidc.reloadSeconds must be an integer between 1 and 3600 (got ${String(reloadSeconds)}).`
    );
  }
  return {
    configSecretName: name,
    configSecretKey: key,
    reloadSeconds,
    allowUnvalidatedChartVersion: options.allowUnvalidatedChartVersion === true,
  };
}

/** Whether a chart version is one the plugin is audited against. */
export function isClickStackHyperdxOidcValidatedChartVersion(version: string): boolean {
  return (CLICKSTACK_HYPERDX_OIDC_VALIDATED_CHART_VERSIONS as readonly string[]).includes(version);
}

/** Name of the ConfigMap carrying the plugin for a release. */
export function hyperdxOidcPluginConfigMapName(releaseName: string): string {
  return `${releaseName}-hyperdx-oidc-plugin`;
}

/** The ConfigMap body (minus metadata) that carries the plugin. */
export function hyperdxOidcPluginConfigMapData(): { binaryData: Record<string, string> } {
  return { binaryData: { [HYPERDX_OIDC_PLUGIN_FILE]: HYPERDX_OIDC_PLUGIN_BASE64 } };
}

type Values = Record<string, unknown>;

function isRecord(value: unknown): value is Values {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(parent: Values, key: string, path: string): Values {
  const existing = parent[key];
  if (existing === undefined) {
    const created: Values = {};
    parent[key] = created;
    return created;
  }
  if (!isRecord(existing)) throw new Error(`values.${path} must be an object to combine with hyperdxOidc`);
  return existing;
}

function listAt(parent: Values, key: string, path: string): unknown[] {
  const existing = parent[key];
  if (existing === undefined) return [];
  if (!Array.isArray(existing)) throw new Error(`values.${path} must be a list to combine with hyperdxOidc`);
  return existing;
}

function namesOf(list: unknown[]): string[] {
  return list.flatMap((item) => (isRecord(item) && typeof item.name === 'string' ? [item.name] : []));
}

/**
 * Fold the plugin wiring into the caller's static chart `values`.
 *
 * Chart values arrive through a deep merge that REPLACES lists, so the
 * plugin's env, volumes and mounts are appended to whatever the caller already
 * set rather than layered on top of it. A caller who already sets one of the
 * env vars or volume names the wiring owns is refused rather than silently
 * overridden.
 *
 * @param context - Caller name, quoted in errors
 * @param values - The caller's static chart values, if any (not mutated)
 * @param oidc - The resolved option
 * @param releaseName - The release name; the plugin ConfigMap is named from it
 * @param createTeam - Whether a first OIDC login may create HyperDX's team.
 *   False when `initialUser` claims the instance: otherwise the first OIDC
 *   login could create the team and the break-glass account would never be
 *   registered.
 * @returns New values with the wiring folded in
 */
export function applyHyperdxOidcValues(
  context: string,
  values: Values | undefined,
  oidc: ResolvedClickStackHyperdxOidc,
  releaseName: string,
  createTeam = true
): Values {
  const merged: Values = structuredClone(values ?? {});
  try {
    const hyperdx = recordAt(merged, 'hyperdx', 'hyperdx');
    const deployment = recordAt(hyperdx, 'deployment', 'hyperdx.deployment');

    const env = listAt(deployment, 'env', 'hyperdx.deployment.env');
    const clashingEnv = namesOf(env).filter((name) => (OWNED_ENV as readonly string[]).includes(name));
    if (clashingEnv.length > 0) {
      throw new Error(
        `values.hyperdx.deployment.env already sets ${clashingEnv.join(', ')}, which hyperdxOidc owns`
      );
    }
    deployment.env = [
      ...env,
      { name: 'NODE_OPTIONS', value: `--require=${HYPERDX_OIDC_PLUGIN_DIR}/${HYPERDX_OIDC_PLUGIN_FILE}` },
      { name: 'TYPEKRO_HDX_OIDC_CONFIG', value: `${HYPERDX_OIDC_CONFIG_DIR}/${HYPERDX_OIDC_CONFIG_FILE}` },
      { name: 'TYPEKRO_HDX_OIDC_RELOAD_SECONDS', value: String(oidc.reloadSeconds) },
      { name: 'TYPEKRO_HDX_OIDC_CREATE_TEAM', value: String(createTeam) },
    ];

    const volumes = listAt(deployment, 'volumes', 'hyperdx.deployment.volumes');
    const mounts = listAt(deployment, 'volumeMounts', 'hyperdx.deployment.volumeMounts');
    const clashingVolumes = [...namesOf(volumes), ...namesOf(mounts)].filter(
      (name) => name === PLUGIN_VOLUME || name === CONFIG_VOLUME
    );
    if (clashingVolumes.length > 0) {
      throw new Error(`values.hyperdx.deployment already uses volume name(s) ${clashingVolumes.join(', ')}`);
    }
    deployment.volumes = [
      ...volumes,
      { name: PLUGIN_VOLUME, configMap: { name: hyperdxOidcPluginConfigMapName(releaseName) } },
      {
        name: CONFIG_VOLUME,
        secret: {
          secretName: oidc.configSecretName,
          items: [{ key: oidc.configSecretKey, path: HYPERDX_OIDC_CONFIG_FILE }],
        },
      },
    ];
    deployment.volumeMounts = [
      ...mounts,
      { name: PLUGIN_VOLUME, mountPath: HYPERDX_OIDC_PLUGIN_DIR, readOnly: true },
      // No subPath: a subPath mount never sees Secret updates, and the plugin
      // hot-reloads its configuration.
      { name: CONFIG_VOLUME, mountPath: HYPERDX_OIDC_CONFIG_DIR, readOnly: true },
    ];

    const annotations = recordAt(deployment, 'podAnnotations', 'hyperdx.deployment.podAnnotations');
    annotations[HYPERDX_OIDC_PLUGIN_HASH_ANNOTATION] = HYPERDX_OIDC_PLUGIN_SHA256;
  } catch (error) {
    throw new Error(`${context}: ${(error as Error).message}.`);
  }
  return merged;
}
