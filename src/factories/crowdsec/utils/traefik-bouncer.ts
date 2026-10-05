/**
 * Traefik side of CrowdSec: the bouncer plugin declaration and a Middleware
 * spec that runs it. Both are plain objects, so this module needs nothing from
 * `typekro/traefik`; pass them to `makeTraefikBootstrap` and
 * `traefikMiddleware`.
 */

import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { TypeKroError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import { Cel } from '../../../core/references/cel.js';
import { KUBERNETES_REF_MARKER_SOURCE } from '../../../core/constants/brands.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
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
import { isAnyAddressRange, isCidr, isDeferredValue, isIp } from './net.js';

const logger = getComponentLogger('crowdsec-bouncer');
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^v\d+\.\d+\.\d+$/;
// Plugin names become Traefik CLI flag segments (`--experimental.plugins.<name>...`)
// and `Middleware.spec.plugin` keys, so they stay one flag-safe word. The same
// rule as Traefik's own plugin declarations.
const PLUGIN_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
// Kubernetes object names (DNS-1123 subdomain) and Secret data keys.
const DNS_SUBDOMAIN =
  /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const SECRET_KEY = /^[-._a-zA-Z0-9]+$/;
// `host`, `host:port` or `[ipv6]:port`: the plugin builds `http://<host>/...`.
const HOST_PORT = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9.]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function invalid(message: string, context?: Record<string, unknown>): never {
  throw new TypeKroError(message, 'CROWDSEC_INVALID_OPTIONS', context);
}

/** Concrete string, or `undefined` for a deferred one (validated at reconcile time). */
function concreteString(value: unknown): string | undefined {
  return typeof value === 'string' && !isDeferredValue(value) ? value : undefined;
}

function assertInteger(name: string, value: unknown, min: number): void {
  if (value === undefined || isDeferredValue(value)) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    invalid(`${name} must be an integer of at least ${min}, got ${String(value)}.`);
  }
}

function assertHost(name: string, value: unknown): void {
  const host = concreteString(value);
  if (host === undefined) return;
  if (host.includes('://')) invalid(`${name} "${host}" must be host[:port], without a scheme.`);
  if (!HOST_PORT.test(host)) invalid(`${name} "${host}" must be host[:port].`);
}

/**
 * `crowdsecAppsecEnabled` for a host only known at reconcile time: CEL
 * `host != ""`, so the bootstrap's `status.appsecHost` (`''` with AppSec off)
 * turns AppSec off instead of pointing the plugin at `http:///`.
 */
function deferredAppsecEnabled(host: unknown): boolean {
  if (isKubernetesRef(host) || isCelExpression(host)) {
    return Cel.expr<boolean>(host, ' != ""');
  }
  const text = String(host);
  const exact = new RegExp(`^${KUBERNETES_REF_MARKER_SOURCE}$`).exec(text);
  if (exact) {
    const [, resourceId, fieldPath] = exact;
    const path = resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
    return Cel.expr<boolean>(`${path} != ""`);
  }
  // A template with literal text around the references is never empty.
  if (text.replace(new RegExp(KUBERNETES_REF_MARKER_SOURCE, 'g'), '').trim() !== '') return true;
  invalid('appsecHost built only from references: pass the reference itself, or a concrete host.');
}

// A copy of a concrete list; a reference to a whole list stays as it is.
function copyList(list: readonly string[]): readonly string[] {
  return isDeferredValue(list) ? list : [...list];
}

function assertTrustedIps(name: string, list: readonly string[] | undefined, risk: string): void {
  if (list === undefined || isDeferredValue(list)) return;
  for (const entry of list) {
    const value = concreteString(entry);
    if (value === undefined) continue;
    if (!isIp(value) && !isCidr(value)) {
      invalid(`${name} entry "${value}" is not an IP address or CIDR range.`);
    }
    if (isAnyAddressRange(value))
      invalid(`${name} entry "${value}" matches every address: ${risk}`);
  }
}

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
 *
 * @throws {TypeKroError} `CROWDSEC_INVALID_SECRET_REF` for an empty name or key, or one with ":".
 */
export function crowdsecSecretUrn(secret: CrowdsecSecretKeyRef): string {
  const fail = (message: string): never => {
    throw new TypeKroError(message, 'CROWDSEC_INVALID_SECRET_REF', {
      name: secret.name,
      key: secret.key,
    });
  };
  for (const [what, value] of [
    ['name', secret.name],
    ['key', secret.key],
  ] as const) {
    if (typeof value === 'string' && value.trim() === '') fail(`Secret ${what} must not be empty.`);
    if (typeof value === 'string' && value.includes(':')) {
      fail('Secret name and key may not contain ":"; Traefik splits the URN on it.');
    }
  }
  const name = concreteString(secret.name);
  if (name !== undefined && !DNS_SUBDOMAIN.test(name)) {
    fail(`Secret name "${name}" is not a valid Kubernetes object name (DNS-1123 subdomain).`);
  }
  const key = concreteString(secret.key);
  if (key !== undefined && !SECRET_KEY.test(key)) {
    fail(`Secret key "${key}" may only contain letters, digits, "-", "_" and ".".`);
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
  if ((options.apiKeySecret === undefined) === (options.apiKeyFile === undefined)) {
    throw new TypeKroError(
      'Set exactly one of apiKeySecret and apiKeyFile.',
      'CROWDSEC_INVALID_SECRET_REF'
    );
  }
  if (concreteString(options.apiKeyFile)?.trim() === '') {
    throw new TypeKroError('apiKeyFile must not be empty.', 'CROWDSEC_INVALID_SECRET_REF');
  }
  const pluginName = options.pluginName ?? DEFAULT_CROWDSEC_PLUGIN_NAME;
  if (!PLUGIN_NAME.test(pluginName)) {
    invalid(
      `Plugin name "${pluginName}" must match ${PLUGIN_NAME}, the name Traefik's experimental.plugins declares.`,
      { pluginName }
    );
  }
  for (const value of [options.apiKeyFile, options.apiKeySecret?.name, options.apiKeySecret?.key]) {
    // The Middleware spec can be a KRO template, where `${` starts CEL.
    if (concreteString(value)?.includes('${')) {
      throw new TypeKroError(
        `"${value}" contains "\${", which KRO would parse as CEL.`,
        'CROWDSEC_INVALID_SECRET_REF'
      );
    }
  }

  // The plugin refuses these, and Traefik then drops every route using it.
  if (concreteString(options.lapiHost)?.trim() === '') invalid('lapiHost must not be empty.');
  assertHost('lapiHost', options.lapiHost);
  assertInteger('updateIntervalSeconds', options.updateIntervalSeconds, 1);
  assertInteger('appsecBodyLimit', options.appsecBodyLimit, 0);
  assertInteger('failClosedAfter', options.failClosedAfter, 0);
  assertTrustedIps(
    'forwardedHeadersTrustedIps',
    options.forwardedHeadersTrustedIps,
    'any client could set X-Forwarded-For and pick the IP the bouncer checks.'
  );
  assertTrustedIps(
    'clientTrustedIps',
    options.clientTrustedIps,
    'every client would bypass the bouncer and AppSec.'
  );

  // `failOpen` and `failClosedAfter` may be references (KRO mode). A reference
  // is truthy at build time, so branching on it in JavaScript would always pick
  // fail-open; the decision is emitted as CEL instead.
  const failOpen = options.failOpen ?? true;
  const deferredFailOpen = isDeferredValue(failOpen);
  // A warning, not an error: a composition may wire both from its spec, and a
  // fail-open instance with the schema's failClosedAfter default is legitimate.
  if (
    failOpen === true &&
    options.failClosedAfter !== undefined &&
    !getCurrentCompositionContext()?.suppressResourceDiagnostics
  ) {
    logger.warn(
      'crowdsecBouncerMiddleware: failClosedAfter is ignored with failOpen: true (the default); set failOpen: false to fail closed.'
    );
  }
  const tolerance = options.failClosedAfter ?? 4;
  // A negative reference would mean "never block" (-1) or be refused by the
  // plugin; clamp to 0, the fail-closed side.
  const failClosedMaxFailure = isDeferredValue(tolerance)
    ? Cel.expr<number>(tolerance, ' < 0 ? 0 : ', tolerance)
    : tolerance;
  const updateMaxFailure = deferredFailOpen
    ? Cel.expr<number>(failOpen, ' ? -1 : ', failClosedMaxFailure)
    : failOpen
      ? -1
      : failClosedMaxFailure;
  const block = deferredFailOpen ? Cel.expr<boolean>('!', failOpen) : !failOpen;

  // An empty host means AppSec is off: the bootstrap's `status.appsecHost` is
  // `''` then, and the plugin would otherwise call `http:///`.
  const appsecHost = options.appsecHost;
  const deferredAppsecHost = isDeferredValue(appsecHost);
  if (!deferredAppsecHost && concreteString(appsecHost)?.trim() !== '') {
    assertHost('appsecHost', appsecHost);
  }
  const appsecEnabled = deferredAppsecHost
    ? deferredAppsecEnabled(appsecHost)
    : appsecHost !== undefined && appsecHost.trim() !== '';

  const config: Record<string, unknown> = {
    enabled: true,
    logLevel: options.logLevel ?? 'INFO',
    crowdsecMode: 'stream',
    crowdsecLapiScheme: 'http',
    crowdsecLapiHost: options.lapiHost,
    ...(options.apiKeySecret
      ? { crowdsecLapiKey: crowdsecSecretUrn(options.apiKeySecret) }
      : { crowdsecLapiKeyFile: options.apiKeyFile }),
    updateIntervalSeconds: options.updateIntervalSeconds ?? 15,
    // -1: a failed pull keeps the last decisions and never blocks everyone.
    // Fail-closed: after `failClosedAfter` failed pulls in a row (about a
    // minute at 15s), all traffic is blocked until a pull succeeds.
    updateMaxFailure,
    // The first pull runs before Traefik serves, so known bans apply at once.
    streamStartupBlock: true,
    crowdsecAppsecEnabled: appsecEnabled,
    ...(appsecEnabled !== false
      ? {
          crowdsecAppsecHost: appsecHost,
          crowdsecAppsecUnreachableBlock: block,
          crowdsecAppsecFailureBlock: block,
          crowdsecAppsecUnreadableBodyBlock: block,
          crowdsecAppsecBodyLimit: options.appsecBodyLimit ?? 10_485_760,
        }
      : {}),
    ...(options.forwardedHeadersTrustedIps
      ? { forwardedHeadersTrustedIps: copyList(options.forwardedHeadersTrustedIps) }
      : {}),
    ...(options.clientTrustedIps ? { clientTrustedIps: copyList(options.clientTrustedIps) } : {}),
  };
  return { plugin: { [pluginName]: config } };
}
