/**
 * Traefik side of CrowdSec: the bouncer plugin declaration and a Middleware
 * spec that runs it. Both are plain objects; pass them to `makeTraefikBootstrap`
 * (`plugins`) and `traefikMiddleware`. The only thing taken from the Traefik
 * factories is the plugin-name rule, a runtime constant that appears in no
 * CrowdSec type, so `typekro/crowdsec` declarations stay free of Traefik.
 */

import { getCurrentCompositionContext } from '../../../core/composition/context.js';
import { TypeKroError } from '../../../core/errors.js';
import { getComponentLogger } from '../../../core/logging/index.js';
import { Cel } from '../../../core/references/cel.js';
import { KUBERNETES_REF_MARKER_SOURCE } from '../../../core/constants/brands.js';
import { REQUIRED_FIELD_SENTINEL } from '../../../core/serialization/schema.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import { TRAEFIK_PLUGIN_NAME } from '../../traefik/utils/plugins.js';
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
 * A reference as CEL parts: the reference itself (so its dependency is
 * tracked), a CEL expression, or the path of a template literal holding exactly
 * one reference. `undefined` for a template with literal text around references.
 */
function referenceOperand(value: unknown): unknown {
  if (isKubernetesRef(value) || isCelExpression(value)) return value;
  const exact = new RegExp(`^${KUBERNETES_REF_MARKER_SOURCE}$`).exec(String(value));
  if (!exact) return undefined;
  const [, resourceId, fieldPath] = exact;
  return resourceId === '__schema__' ? `schema.${fieldPath}` : `${resourceId}.${fieldPath}`;
}

/**
 * CEL parts for `(has(v) ? <set> : <fallback>)`. A field left unset on the
 * instance then takes the same default as in direct mode, instead of failing
 * the whole Middleware with "no such key". A CEL expression has no presence to
 * test and is used as is.
 */
function guarded(
  value: unknown,
  set: (operand: unknown) => unknown[],
  fallback: string
): unknown[] {
  const operand = referenceOperand(value);
  if (isCelExpression(value)) return ['(', ...set(['(', value, ')']), ')'];
  return ['(has(', operand, ') ? ', ...set(operand), ' : ', fallback, ')'];
}

// Flatten nested part lists (an operand may itself be a parts list).
function parts(list: unknown[]): unknown[] {
  return list.flatMap((part) => (Array.isArray(part) ? parts(part) : [part]));
}

/** Whether `value` is the placeholder the defaults-extraction pass substitutes. */
function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.includes(REQUIRED_FIELD_SENTINEL);
}

function assertReference(name: string, value: unknown): void {
  if (referenceOperand(value) === undefined) {
    invalid(
      `${name} built from a template literal: pass the reference itself, or a concrete value.`
    );
  }
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
  // The rule the Traefik bootstrap applies to the `plugins` key it declares.
  if (!TRAEFIK_PLUGIN_NAME.test(pluginName)) {
    invalid(
      `Plugin name "${pluginName}" must match ${TRAEFIK_PLUGIN_NAME}, the name Traefik's experimental.plugins declares.`,
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

  // `failOpen`, `failClosedAfter` and `appsecHost` may be references (KRO
  // mode). A reference is truthy at build time, so branching on it in
  // JavaScript would always pick fail-open; the decision is emitted as CEL,
  // with `has()` so an unset optional field takes the direct-mode default.
  const failOpenOption = isPlaceholder(options.failOpen) ? undefined : options.failOpen;
  const failOpen = failOpenOption ?? true;
  const deferredFailOpen = isDeferredValue(failOpen);
  if (deferredFailOpen) assertReference('failOpen', failOpen);
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
  const toleranceOption = isPlaceholder(options.failClosedAfter)
    ? undefined
    : options.failClosedAfter;
  const tolerance = toleranceOption ?? 4;
  const deferredTolerance = isDeferredValue(tolerance);
  if (deferredTolerance) assertReference('failClosedAfter', tolerance);
  // CEL parts, all of type int: a schema `number` is a CEL double, and cel-go
  // refuses a conditional mixing int and double branches, hence int(). A
  // negative value would mean "never block" (-1) or be refused by the plugin,
  // so it is clamped to 0, the fail-closed side.
  const toleranceInt = guarded(tolerance, (x) => ['int(', x, ')'], '4');
  const failClosedMaxFailure: unknown[] = deferredTolerance
    ? ['(', toleranceInt, ' < 0 ? 0 : ', toleranceInt, ')']
    : [String(tolerance)];
  const failOpenBool = guarded(failOpen, (x) => [x], 'true');
  const updateMaxFailure = deferredFailOpen
    ? Cel.expr<number>(...parts([failOpenBool, ' ? -1 : ', failClosedMaxFailure]))
    : failOpen
      ? -1
      : deferredTolerance
        ? Cel.expr<number>(...parts(failClosedMaxFailure))
        : tolerance;
  const block = deferredFailOpen ? Cel.expr<boolean>(...parts(['!', failOpenBool])) : !failOpen;

  // An empty host means AppSec is off: the bootstrap's `status.appsecHost` is
  // `''` then, and the plugin would otherwise call `http:///`.
  const appsecHost = isPlaceholder(options.appsecHost) ? undefined : options.appsecHost;
  const deferredAppsecHost = isDeferredValue(appsecHost);
  if (!deferredAppsecHost && concreteString(appsecHost)?.trim() !== '') {
    assertHost('appsecHost', appsecHost);
  }
  let appsecEnabled: boolean;
  if (!deferredAppsecHost) {
    appsecEnabled = appsecHost !== undefined && appsecHost.trim() !== '';
  } else if (referenceOperand(appsecHost) !== undefined) {
    appsecEnabled = Cel.expr<boolean>(...parts(guarded(appsecHost, (x) => [x, ' != ""'], 'false')));
  } else {
    // A template with literal text around the references is never empty.
    const text = String(appsecHost).replace(new RegExp(KUBERNETES_REF_MARKER_SOURCE, 'g'), '');
    if (text.trim() === '') {
      invalid(
        'appsecHost built only from references: pass the reference itself, or a concrete host.'
      );
    }
    appsecEnabled = true;
  }

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
