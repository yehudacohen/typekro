/**
 * Traefik TLS resources (#175), including the cert-manager composition
 * pattern: a `Certificate` writes a Secret, a `TLSStore` names it as the
 * default certificate, and an `IngressRoute` references the same Secret.
 */
import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { Cel } from '../../../src/core/references/cel.js';
import { certificate } from '../../../src/factories/cert-manager/resources/certificates.js';
import { traefikIngressRoute } from '../../../src/factories/traefik/resources/routing.js';
import {
  TRAEFIK_TLS_OPTION_SECURE_DEFAULTS,
  traefikTLSOption,
  traefikTLSStore,
} from '../../../src/factories/traefik/resources/tls.js';

const NAMESPACE = 'traefik';

describe('traefikTLSOption', () => {
  it('applies the hardened defaults when the caller omits them', () => {
    const option = traefikTLSOption({
      name: 'default',
      namespace: NAMESPACE,
      spec: {},
      id: 'defaultTlsOption',
    });

    expect(option.apiVersion).toBe('traefik.io/v1alpha1');
    expect(option.kind).toBe('TLSOption');
    expect(option.spec.minVersion).toBe(TRAEFIK_TLS_OPTION_SECURE_DEFAULTS.minVersion);
    expect(option.spec.minVersion).toBe('VersionTLS12');
    expect(option.spec.sniStrict).toBe(true);
  });

  it('lets a caller raise the floor but keeps the explicit choice', () => {
    const option = traefikTLSOption({
      name: 'strict',
      namespace: NAMESPACE,
      spec: { minVersion: 'VersionTLS13', cipherSuites: ['TLS_AES_256_GCM_SHA384'] },
      id: 'strictTlsOption',
    });

    expect(option.spec.minVersion).toBe('VersionTLS13');
    expect(option.spec.cipherSuites).toEqual(['TLS_AES_256_GCM_SHA384']);
    expect(option.spec.sniStrict).toBe(true);
  });

  it('allows an explicit opt-out of sniStrict', () => {
    const option = traefikTLSOption({
      name: 'lenient',
      namespace: NAMESPACE,
      spec: { sniStrict: false },
      id: 'lenientTlsOption',
    });

    expect(option.spec.sniStrict).toBe(false);
  });

  it('carries mutual-TLS client authentication', () => {
    const option = traefikTLSOption({
      name: 'mtls',
      namespace: NAMESPACE,
      spec: {
        clientAuth: {
          clientAuthType: 'RequireAndVerifyClientCert',
          secretNames: ['internal-ca'],
        },
      },
      id: 'mtlsTlsOption',
    });

    expect(option.spec.clientAuth?.clientAuthType).toBe('RequireAndVerifyClientCert');
    expect(option.spec.clientAuth?.secretNames).toEqual(['internal-ca']);
  });

  it('is always ready because TLSOption has no status subresource', () => {
    const option = traefikTLSOption({
      name: 'ready-check',
      namespace: NAMESPACE,
      spec: {},
      id: 'readyCheckTlsOption',
    });

    expect(option.readinessEvaluator?.({})).toMatchObject({ ready: true });
  });
});

describe('traefikTLSStore', () => {
  it('names the default certificate Secret', () => {
    const store = traefikTLSStore({
      name: 'default',
      namespace: NAMESPACE,
      spec: { defaultCertificate: { secretName: 'edge-wildcard-tls' } },
      id: 'defaultTlsStore',
    });

    expect(store.kind).toBe('TLSStore');
    expect(store.spec.defaultCertificate?.secretName).toBe('edge-wildcard-tls');
  });

  it('supports an ACME resolver instead of a Secret', () => {
    const store = traefikTLSStore({
      name: 'acme',
      namespace: NAMESPACE,
      spec: {
        defaultGeneratedCert: {
          resolver: 'letsencrypt',
          domain: { main: 'example.com', sans: ['*.example.com'] },
        },
      },
      id: 'acmeTlsStore',
    });

    expect(store.spec.defaultGeneratedCert?.resolver).toBe('letsencrypt');
    expect(store.spec.defaultGeneratedCert?.domain?.sans).toEqual(['*.example.com']);
  });
});

describe('cert-manager → TLSStore → IngressRoute composition pattern', () => {
  it('wires one cert-manager Secret through the store and the router', () => {
    const secretName = 'edge-wildcard-tls';

    const edge = kubernetesComposition(
      {
        name: 'traefik-tls-pattern',
        kind: 'TraefikTlsPattern',
        spec: type({ name: 'string', hostname: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        const cert = certificate({
          name: 'edge-wildcard',
          namespace: NAMESPACE,
          spec: {
            secretName,
            dnsNames: ['*.example.com'],
            issuerRef: { name: 'letsencrypt', kind: 'ClusterIssuer' },
          },
          id: 'edgeCertificate',
        });

        const option = traefikTLSOption({
          name: 'default',
          namespace: NAMESPACE,
          spec: { minVersion: 'VersionTLS13' },
          id: 'defaultTlsOption',
        });

        const store = traefikTLSStore({
          name: 'default',
          namespace: NAMESPACE,
          spec: { defaultCertificate: { secretName } },
          id: 'defaultTlsStore',
        });
        // The store is only meaningful once the Secret exists.
        store.dependsOn(cert);

        const route = traefikIngressRoute({
          name: spec.name,
          namespace: NAMESPACE,
          spec: {
            entryPoints: ['websecure'],
            routes: [
              {
                match: 'Host(`api.example.com`)',
                services: [{ name: 'cost-api', port: 8080 }],
              },
            ],
            tls: {
              secretName,
              options: { name: 'default', namespace: NAMESPACE },
              store: { name: 'default', namespace: NAMESPACE },
            },
          },
          id: 'costApiRoute',
        });
        route.dependsOn(store);
        route.dependsOn(option);

        return {
          ready: Cel.expr<boolean>(
            cert.status.conditions,
            '.exists(c, c.type == "Ready" && c.status == "True")'
          ),
        };
      }
    );

    const documents = loadAll(edge.toYaml()).filter(
      (document): document is Record<string, unknown> =>
        document !== null && typeof document === 'object' && !Array.isArray(document)
    );
    const rgd = documents.find((document) => document.kind === 'ResourceGraphDefinition');
    expect(rgd).toBeDefined();

    const serialized = JSON.stringify(rgd);
    // One Secret name threads through the Certificate, the store and the router.
    expect(serialized).toContain('cert-manager.io/v1');
    expect(serialized).toContain('"kind":"TLSStore"');
    expect(serialized).toContain('"kind":"TLSOption"');
    expect(serialized).toContain('"kind":"IngressRoute"');
    const occurrences = serialized.split(secretName).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
    // No unresolved placeholder leaked into the graph.
    expect(serialized).not.toContain('[object Object]');
  });
});
