/**
 * Which upstream sources a Traefik entrypoint believes.
 */
// Traefik trusts two things from an upstream: a PROXY protocol header
// (`entryPoints.<name>.proxyProtocol`) and `X-Forwarded-*` headers
// (`entryPoints.<name>.forwardedHeaders`). Both are scoped by `trustedIPs`, and
// both have an `insecure` switch that trusts every source.
//
// Behind a load balancer the client address Traefik logs, rate-limits on and
// passes upstream comes from whichever of these it trusts. A range with a `/0`
// prefix (`0.0.0.0/0`, `::/0`) or `insecure: true` lets ANY client that reaches
// the entrypoint write that address itself: send a forged PROXY header or
// `X-Forwarded-For`, and the edge believes it. So both are refused unless the
// caller opts in with the clearly named `dangerouslyTrustAnySource`.
//
// The check has two halves because the values may not be concrete:
// - Direct mode runs the composition with concrete values, so
//   `assertTraefikProxyTrust` inspects the final chart values in JavaScript.
// - KRO mode sees schema references there, which carry no value to inspect.
//   `traefikProxyTrustSchemaFieldValidations` turns the same rule into
//   `x-kubernetes-validations` on the generated CRD, so the API server refuses
//   an instance that asks for it.
// Raw `values` and `additionalArguments` are build-time and concrete in both
// modes, so the `insecure` half is always checked in JavaScript.

import { TypeKroError } from '../../../core/errors.js';
import { isCelExpression, isKubernetesRef } from '../../../utils/type-guards.js';
import type { TraefikHelmValues } from '../types.js';

/** CEL rule refusing any trusted range with a `/0` prefix. */
export const TRAEFIK_TRUSTED_IPS_VALIDATION_RULE = 'self.all(range, !range.endsWith("/0"))';

// Runtime spec paths that carry a `trustedIPs` list, for the KRO-mode rule.
const TRUSTED_IP_SPEC_PATHS = [
  'entrypoints.web.proxyProtocol.trustedIPs',
  'entrypoints.web.forwardedHeaders.trustedIPs',
  'entrypoints.websecure.proxyProtocol.trustedIPs',
  'entrypoints.websecure.forwardedHeaders.trustedIPs',
] as const;

// `--entryPoints.<name>.proxyProtocol.insecure` and the forwardedHeaders twin,
// with or without `=true`. Traefik's flag parser is case-insensitive.
const INSECURE_ARGUMENT = /\.(proxyprotocol|forwardedheaders)\.insecure(=true)?$/i;

/** Whether a range trusts every address. */
function trustsAnySource(range: string): boolean {
  // The same test the CRD rule applies, so both modes refuse the same ranges.
  return range.trim().endsWith('/0');
}

function isConcrete(value: unknown): boolean {
  return !isKubernetesRef(value) && !isCelExpression(value);
}

/**
 * Problems with the proxy trust in final chart values; empty when there are none.
 *
 * Schema references are skipped: KRO mode checks those on the CRD.
 */
export function traefikProxyTrustIssues(values: TraefikHelmValues): string[] {
  const issues: string[] = [];
  const ports = values.ports;
  if (ports && isConcrete(ports)) {
    for (const [name, port] of Object.entries(ports)) {
      if (!port || !isConcrete(port)) continue;
      for (const field of ['proxyProtocol', 'forwardedHeaders'] as const) {
        const trust = port[field];
        if (!trust || !isConcrete(trust)) continue;
        if (trust.insecure === true) {
          issues.push(`ports.${name}.${field}.insecure trusts every source.`);
        }
        const ranges = trust.trustedIPs;
        if (!Array.isArray(ranges) || !isConcrete(ranges)) continue;
        for (const range of ranges) {
          if (typeof range === 'string' && trustsAnySource(range)) {
            issues.push(
              `ports.${name}.${field}.trustedIPs contains ${range}, which trusts every source.`
            );
          }
        }
      }
    }
  }
  const args = values.additionalArguments;
  if (Array.isArray(args) && isConcrete(args)) {
    for (const arg of args) {
      if (typeof arg === 'string' && INSECURE_ARGUMENT.test(arg)) {
        issues.push(`additionalArguments contains ${arg}, which trusts every source.`);
      }
    }
  }
  return issues;
}

/**
 * Throw when final chart values trust every source for PROXY protocol or forwarded headers.
 *
 * @throws {TypeKroError} With code `TRAEFIK_UNTRUSTED_PROXY_SOURCE`.
 */
export function assertTraefikProxyTrust(values: TraefikHelmValues): void {
  const issues = traefikProxyTrustIssues(values);
  if (issues.length === 0) return;
  throw new TypeKroError(
    `Traefik would trust any client to set its own source address: ${issues.join(' ')} ` +
      'List the load balancer or proxy ranges instead (for an AWS NLB with IP targets, the VPC ' +
      'CIDR). Pass `dangerouslyTrustAnySource: true` to makeTraefikBootstrap only for a Traefik ' +
      'that no client can reach directly.',
    'TRAEFIK_UNTRUSTED_PROXY_SOURCE',
    { issues }
  );
}

/** `schemaFieldValidations` refusing `/0` trusted ranges on a KRO instance. */
export function traefikProxyTrustSchemaFieldValidations(): Record<string, string> {
  return Object.fromEntries(
    TRUSTED_IP_SPEC_PATHS.map((path) => [path, TRAEFIK_TRUSTED_IPS_VALIDATION_RULE])
  );
}
