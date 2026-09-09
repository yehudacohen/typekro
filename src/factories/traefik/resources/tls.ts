/**
 * Traefik TLS resources: `TLSOption` and `TLSStore`.
 *
 * The intended cert-manager wiring is:
 *
 * 1. A cert-manager `Certificate` (`src/factories/cert-manager`) issues a
 *    certificate into a Secret in Traefik's namespace.
 * 2. A `TLSStore` named `default` points `defaultCertificate.secretName` at
 *    that Secret, so any HTTPS request whose SNI matches no router
 *    certificate is still served a valid certificate.
 * 3. Individual `IngressRoute`s reference the same Secret through
 *    `tls.secretName`, and reference the hardened `TLSOption` through
 *    `tls.options`.
 *
 * `TLSStore`/`TLSOption` named `default` are cluster-wide singletons in
 * Traefik. Only one namespace should own them; chart 41.5.0 can restrict which
 * namespace that is via `providers.kubernetesCRD.defaultTLSResourcesNamespace`.
 */

import type { Enhanced } from '../../../core/types/index.js';
import { createResource } from '../../shared.js';
import { TRAEFIK_API_VERSION } from '../constants.js';
import type { TraefikTLSOptionSpec, TraefikTLSStoreSpec } from '../types.js';
import {
  type TraefikResourceConfig,
  traefikResourceDefinition,
  traefikStatuslessReadinessEvaluator,
} from './common.js';
import type { TraefikNoStatus } from './routing.js';

/**
 * Hardened `TLSOption` defaults applied by {@link traefikTLSOption} when the
 * corresponding field is omitted.
 *
 * @security TLS 1.2 is the floor (TLS 1.0/1.1 are deprecated by RFC 8996), and
 * `sniStrict` rejects handshakes that would otherwise fall back to Traefik's
 * self-signed default certificate — a fallback that turns a certificate
 * misconfiguration into a silently insecure connection.
 */
export const TRAEFIK_TLS_OPTION_SECURE_DEFAULTS = {
  minVersion: 'VersionTLS12',
  sniStrict: true,
} as const;

/**
 * Create a Traefik `TLSOption`.
 *
 * Unspecified `minVersion` / `sniStrict` take the hardened values in
 * {@link TRAEFIK_TLS_OPTION_SECURE_DEFAULTS}. Pass them explicitly to opt out.
 *
 * @example A cluster default with mutual TLS for internal callers
 * ```typescript
 * traefikTLSOption({
 *   name: 'default',
 *   namespace: 'traefik',
 *   spec: {
 *     minVersion: 'VersionTLS13',
 *     clientAuth: {
 *       clientAuthType: 'VerifyClientCertIfGiven',
 *       secretNames: ['internal-ca'],
 *     },
 *   },
 *   id: 'defaultTlsOption',
 * });
 * ```
 */
export function traefikTLSOption(
  config: TraefikResourceConfig<TraefikTLSOptionSpec>
): Enhanced<TraefikTLSOptionSpec, TraefikNoStatus> {
  const spec: TraefikTLSOptionSpec = {
    ...config.spec,
    minVersion: config.spec.minVersion ?? TRAEFIK_TLS_OPTION_SECURE_DEFAULTS.minVersion,
    sniStrict: config.spec.sniStrict ?? TRAEFIK_TLS_OPTION_SECURE_DEFAULTS.sniStrict,
  };
  return createResource<TraefikTLSOptionSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'TLSOption', { ...config, spec }),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('TLSOption'));
}

/**
 * Create a Traefik `TLSStore`.
 *
 * @example Default certificate supplied by a cert-manager `Certificate`
 * ```typescript
 * const certificate = certManager.certificate({
 *   name: 'edge-wildcard',
 *   namespace: 'traefik',
 *   spec: {
 *     secretName: 'edge-wildcard-tls',
 *     dnsNames: ['*.example.com'],
 *     issuerRef: { name: 'letsencrypt', kind: 'ClusterIssuer' },
 *   },
 *   id: 'edgeCertificate',
 * });
 *
 * const store = traefikTLSStore({
 *   name: 'default',
 *   namespace: 'traefik',
 *   spec: { defaultCertificate: { secretName: 'edge-wildcard-tls' } },
 *   id: 'defaultTlsStore',
 * });
 * store.dependsOn(certificate);
 * ```
 */
export function traefikTLSStore(
  config: TraefikResourceConfig<TraefikTLSStoreSpec>
): Enhanced<TraefikTLSStoreSpec, TraefikNoStatus> {
  return createResource<TraefikTLSStoreSpec, TraefikNoStatus>(
    traefikResourceDefinition(TRAEFIK_API_VERSION, 'TLSStore', config),
    { scope: 'namespaced' }
  ).withReadinessEvaluator(traefikStatuslessReadinessEvaluator('TLSStore'));
}
