/**
 * The JSON access log's field and header policy.
 */
// Traefik's JSON access log writes one object per request. Its fields
// (`ClientHost`, `RequestPath`, `DownstreamStatus`, ...) are kept by default.
// Request headers are dropped by default and appear as `request_<Name>` only
// when listed. This module decides which headers are listed, and makes sure the
// credential-bearing ones can never be:
//
// - `User-Agent` is kept. It is what bot and scanner detection keys on, and it
//   carries no credential.
// - `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` are
//   always dropped. The header policy covers request headers (`request_<Name>`)
//   and response headers (`downstream_<Name>`, `origin_<Name>`) alike, and a
//   `Set-Cookie` on a response carries the session it creates. A
//   log pipeline is not a secret store, and a bearer token in a log line is a
//   live credential for as long as the log is retained. They are listed
//   explicitly as well as covered by the `drop` default, so the policy still
//   holds if the default ever changes.
//
// The `crowdsec` preset also pins every field CrowdSec's
// `crowdsecurity/traefik-logs` parser reads from a JSON line, so per-field
// overrides cannot silently break detection.

import { TypeKroError } from '../../../core/errors.js';
import type {
  TraefikAccessLogFieldMode,
  TraefikAccessLogOptions,
  TraefikManagedHelmValues,
} from '../types.js';

/** Request and response headers the access log never keeps. */
export const TRAEFIK_ACCESS_LOG_DROPPED_HEADERS = [
  'Authorization',
  'Proxy-Authorization',
  'Cookie',
  'Set-Cookie',
] as const;

/** Access-log fields CrowdSec's `crowdsecurity/traefik-logs` parser reads from JSON. */
export const TRAEFIK_CROWDSEC_ACCESS_LOG_FIELDS = [
  'ClientHost',
  'ClientAddr',
  'RequestAddr',
  'RequestHost',
  'RequestMethod',
  'RequestPath',
  'RequestProtocol',
  'DownstreamStatus',
  'DownstreamContentSize',
  'Duration',
  'RouterName',
  'ServiceAddr',
] as const;

type AccessLogFields = NonNullable<NonNullable<TraefikManagedHelmValues['accessLog']>['fields']>;

/**
 * Chart `accessLog.fields` for a preset plus overrides.
 *
 * @throws {TypeKroError} `TRAEFIK_ACCESS_LOG_POLICY` when an override would keep
 *   a credential header or, under `crowdsec`, drop a field the parser needs.
 */
export function traefikAccessLogFields(options: TraefikAccessLogOptions = {}): AccessLogFields {
  const preset = options.preset ?? 'default';
  const issues: string[] = [];

  const headers: Record<string, TraefikAccessLogFieldMode> = {
    'User-Agent': 'keep',
    ...options.headers,
  };
  for (const name of TRAEFIK_ACCESS_LOG_DROPPED_HEADERS) {
    // Header names are case-insensitive, so `authorization` is refused too
    // rather than left as a second, unpinned entry.
    const aliases = Object.keys(headers).filter(
      (key) => key !== name && key.toLowerCase() === name.toLowerCase()
    );
    for (const alias of aliases) {
      issues.push(`header ${alias} is ${name}; spell it ${name}.`);
    }
    if (headers[name] === 'keep') {
      issues.push(`header ${name} carries credentials and is always dropped.`);
    }
    headers[name] = headers[name] === 'redact' ? 'redact' : 'drop';
  }

  const names: Record<string, TraefikAccessLogFieldMode> = {};
  if (preset === 'crowdsec') {
    for (const field of TRAEFIK_CROWDSEC_ACCESS_LOG_FIELDS) names[field] = 'keep';
    if (headers['User-Agent'] !== 'keep') {
      issues.push('the crowdsec preset needs header User-Agent kept.');
    }
  }
  for (const [field, mode] of Object.entries(options.fields ?? {})) {
    if (preset === 'crowdsec' && names[field] === 'keep' && mode !== 'keep') {
      issues.push(`the crowdsec preset needs field ${field} kept.`);
    }
    names[field] = mode;
  }

  if (issues.length > 0) {
    throw new TypeKroError(
      `Invalid Traefik access-log policy: ${issues.join(' ')}`,
      'TRAEFIK_ACCESS_LOG_POLICY',
      { issues }
    );
  }

  return {
    defaultMode: 'keep',
    ...(Object.keys(names).length > 0 && { names }),
    headers: { defaultMode: 'drop', names: headers },
    ...(options.queryParameters !== undefined && {
      queryParameters: { defaultMode: options.queryParameters },
    }),
  };
}
