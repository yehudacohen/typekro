/**
 * Traefik side of CrowdSec: the bouncer plugin declaration and a Middleware
 * spec that runs it. Both are plain objects, so this module needs nothing from
 * `typekro/traefik`; pass them to `makeTraefikBootstrap` and
 * `traefikMiddleware`.
 */

import { TypeKroError } from '../../../core/errors.js';
import {
  CROWDSEC_BOUNCER_PLUGIN_MODULE,
  DEFAULT_CROWDSEC_BOUNCER_PLUGIN_HASH,
  DEFAULT_CROWDSEC_BOUNCER_PLUGIN_VERSION,
  DEFAULT_CROWDSEC_PLUGIN_NAME,
} from '../constants.js';
import type {
  CrowdsecBouncerMiddlewareOptions,
  CrowdsecBouncerMiddlewareSpec,
  CrowdsecSecretKeyRef,
  CrowdsecTraefikPluginDeclaration,
} from '../types.js';

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^v\d+\.\d+\.\d+$/;

/**
 * Declare the bouncer plugin for Traefik's `experimental.plugins`.
 *
 * Defaults to the pinned v1.7.1 and its archive hash. Another version needs
 * its own `hash`: the SHA-256 of the archive Traefik downloads.
 *
 * @throws {TypeKroError} `CROWDSEC_INVALID_PLUGIN` for a missing or malformed hash or version.
 */
export function crowdsecTraefikPlugin(
  options: { version?: string; hash?: string } = {}
): CrowdsecTraefikPluginDeclaration {
  const version = options.version ?? DEFAULT_CROWDSEC_BOUNCER_PLUGIN_VERSION;
  const hash =
    options.hash ??
    (version === DEFAULT_CROWDSEC_BOUNCER_PLUGIN_VERSION
      ? DEFAULT_CROWDSEC_BOUNCER_PLUGIN_HASH
      : '');
  if (!EXACT_VERSION.test(version)) {
    throw new TypeKroError(
      `Plugin version "${version}" must be an exact release such as v1.7.1.`,
      'CROWDSEC_INVALID_PLUGIN',
      { version }
    );
  }
  if (!SHA256.test(hash)) {
    throw new TypeKroError(
      `Plugin ${version} needs hash: the archive's SHA-256 as 64 lowercase hex digits.`,
      'CROWDSEC_INVALID_PLUGIN',
      { version }
    );
  }
  return { moduleName: CROWDSEC_BOUNCER_PLUGIN_MODULE, version, hash };
}

/**
 * A `urn:k8s:secret:<name>:<key>` reference, which Traefik's CRD provider
 * resolves inside plugin configuration from the Middleware's namespace.
 */
export function crowdsecSecretUrn(secret: CrowdsecSecretKeyRef): string {
  if (secret.name.includes(':') || secret.key.includes(':')) {
    throw new TypeKroError(
      'Secret name and key may not contain ":"; Traefik splits the URN on it.',
      'CROWDSEC_INVALID_SECRET_REF',
      { name: secret.name, key: secret.key }
    );
  }
  return `urn:k8s:secret:${secret.name}:${secret.key}`;
}

/**
 * Build a Traefik `Middleware.spec` that runs the bouncer in stream mode.
 *
 * It only ever bans: no captcha provider is configured, so a captcha decision
 * is enforced as a ban. `failOpen` (the default) lets traffic through while
 * LAPI or AppSec is unreachable; `failOpen: false` blocks it instead.
 *
 * @example
 * ```typescript
 * traefikMiddleware({
 *   name: 'crowdsec',
 *   namespace: 'traefik',
 *   spec: crowdsecBouncerMiddleware({
 *     lapiHost: 'crowdsec-service.crowdsec.svc.cluster.local:8080',
 *     apiKeySecret: { name: 'crowdsec-bouncer', key: 'api-key' },
 *   }),
 * });
 * ```
 */
export function crowdsecBouncerMiddleware(
  options: CrowdsecBouncerMiddlewareOptions
): CrowdsecBouncerMiddlewareSpec {
  const failOpen = options.failOpen ?? true;
  const appsec = options.appsecHost !== undefined;
  const config: Record<string, unknown> = {
    enabled: true,
    logLevel: options.logLevel ?? 'INFO',
    crowdsecMode: 'stream',
    crowdsecLapiScheme: 'http',
    crowdsecLapiHost: options.lapiHost,
    crowdsecLapiKey: crowdsecSecretUrn(options.apiKeySecret),
    updateIntervalSeconds: options.updateIntervalSeconds ?? 15,
    // -1: a failed pull keeps the last decisions and never blocks everyone.
    // 0 (fail-closed): the first failed pull blocks all traffic until LAPI is back.
    updateMaxFailure: failOpen ? -1 : 0,
    // The first pull runs before Traefik serves, so known bans apply at once.
    streamStartupBlock: true,
    crowdsecAppsecEnabled: appsec,
    ...(appsec
      ? {
          crowdsecAppsecHost: options.appsecHost,
          crowdsecAppsecUnreachableBlock: !failOpen,
          crowdsecAppsecFailureBlock: !failOpen,
          crowdsecAppsecUnreadableBodyBlock: !failOpen,
          crowdsecAppsecBodyLimit: options.appsecBodyLimit ?? 10_485_760,
        }
      : {}),
    ...(options.forwardedHeadersTrustedIps
      ? { forwardedHeadersTrustedIps: [...options.forwardedHeadersTrustedIps] }
      : {}),
    ...(options.clientTrustedIps ? { clientTrustedIps: [...options.clientTrustedIps] } : {}),
  };
  return { plugin: { [options.pluginName ?? DEFAULT_CROWDSEC_PLUGIN_NAME]: config } };
}
