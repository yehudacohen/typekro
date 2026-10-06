/**
 * The load-balancer front and TLS from cert-manager (no cluster).
 *
 * - `awsNlbServiceAnnotations`: TCP passthrough with PROXY protocol v2, and the
 *   conflicts the AWS Load Balancer Controller would otherwise reject late.
 * - The owned Service's `loadBalancerClass` / `externalTrafficPolicy` /
 *   `loadBalancerSourceRanges`, in direct and KRO mode.
 * - Entrypoint `proxyProtocol` / `forwardedHeaders` trust, and the refusal of
 *   `/0` ranges and `insecure` trust unless `dangerouslyTrustAnySource` is set.
 * - `traefikTlsCertificate` and the bootstrap-owned default certificate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { Cel } from '../../../src/core/references/cel.js';
import {
  makeTraefikBootstrap,
  traefikBootstrap,
} from '../../../src/factories/traefik/compositions/traefik-bootstrap.js';
import { traefikTlsCertificate } from '../../../src/factories/traefik/resources/tls.js';
import type { TraefikBootstrapConfig } from '../../../src/factories/traefik/types.js';
import { awsNlbServiceAnnotations } from '../../../src/factories/traefik/utils/aws-nlb.js';
import {
  mapTraefikConfigToHelmValues,
  validateTraefikHelmValues,
} from '../../../src/factories/traefik/utils/helm-values-mapper.js';
import { traefikProxyTrustIssues } from '../../../src/factories/traefik/utils/proxy-trust.js';

const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  // Some serialization paths read the active kubeconfig; keep them hermetic.
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-traefik-edge-front-'));
  const kubeconfigPath = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    kubeconfigPath,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- cluster: { server: "https://127.0.0.1:1" }',
      '  name: hermetic',
      'contexts:',
      '- context: { cluster: hermetic, user: hermetic }',
      '  name: hermetic',
      'current-context: hermetic',
      'users:',
      '- name: hermetic',
      '  user: {}',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = kubeconfigPath;
});

afterAll(() => {
  if (ORIGINAL_KUBECONFIG === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;
  if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true });
});

interface Document {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: Record<string, unknown>;
}

function documents(yaml: string): Document[] {
  return loadAll(yaml).filter(
    (document): document is Document =>
      document !== null && typeof document === 'object' && !Array.isArray(document)
  );
}

const NLB_SUBNET = '10.0.1.0/24';

const NLB_SPEC: TraefikBootstrapConfig = {
  name: 'traefik',
  namespace: 'traefik',
  service: {
    type: 'LoadBalancer',
    loadBalancerClass: 'service.k8s.aws/nlb',
    externalTrafficPolicy: 'Local',
    loadBalancerSourceRanges: ['203.0.113.0/24'],
    annotations: awsNlbServiceAnnotations({ scheme: 'internet-facing', crossZone: true }),
  },
  entrypoints: {
    web: { proxyProtocol: { trustedIPs: [NLB_SUBNET] } },
    websecure: {
      proxyProtocol: { trustedIPs: [NLB_SUBNET] },
      forwardedHeaders: { trustedIPs: ['198.51.100.0/24'] },
    },
  },
};

function directDocuments(spec: TraefikBootstrapConfig, bootstrap = traefikBootstrap): Document[] {
  return documents(bootstrap.factory('direct', { namespace: 'flux-system' }).toYaml(spec));
}

describe('awsNlbServiceAnnotations', () => {
  const p = 'service.beta.kubernetes.io/aws-load-balancer-';

  it('defaults to IP targets with PROXY protocol v2 and no TLS on the NLB', () => {
    const annotations = awsNlbServiceAnnotations({ scheme: 'internal' });

    expect(annotations).toEqual({
      [`${p}type`]: 'external',
      [`${p}scheme`]: 'internal',
      [`${p}nlb-target-type`]: 'ip',
      [`${p}proxy-protocol`]: '*',
    });
    // TCP passthrough: nothing that would make the NLB terminate TLS.
    for (const key of Object.keys(annotations)) {
      expect(key).not.toMatch(/ssl|backend-protocol/);
    }
  });

  it('maps cross-zone, attributes, tags, subnets and health checks', () => {
    const annotations = awsNlbServiceAnnotations({
      scheme: 'internet-facing',
      targetType: 'instance',
      proxyProtocol: false,
      crossZone: true,
      loadBalancerAttributes: { 'deletion_protection.enabled': 'true' },
      targetGroupAttributes: {
        'deregistration_delay.timeout_seconds': '30',
        'preserve_client_ip.enabled': 'false',
      },
      ipAddressType: 'dualstack',
      subnets: ['subnet-a', 'subnet-b'],
      name: 'edge-public',
      additionalResourceTags: { team: 'edge', env: 'prod' },
      healthCheck: { protocol: 'TCP', port: 'traffic-port', intervalSeconds: 10 },
    });

    expect(annotations[`${p}nlb-target-type`]).toBe('instance');
    expect(annotations[`${p}proxy-protocol`]).toBeUndefined();
    expect(annotations[`${p}attributes`]).toBe(
      'load_balancing.cross_zone.enabled=true,deletion_protection.enabled=true'
    );
    expect(annotations[`${p}target-group-attributes`]).toBe(
      'deregistration_delay.timeout_seconds=30,preserve_client_ip.enabled=false'
    );
    expect(annotations[`${p}ip-address-type`]).toBe('dualstack');
    expect(annotations[`${p}subnets`]).toBe('subnet-a,subnet-b');
    expect(annotations[`${p}name`]).toBe('edge-public');
    expect(annotations[`${p}additional-resource-tags`]).toBe('team=edge,env=prod');
    expect(annotations[`${p}healthcheck-protocol`]).toBe('TCP');
    expect(annotations[`${p}healthcheck-port`]).toBe('traffic-port');
    expect(annotations[`${p}healthcheck-interval`]).toBe('10');
  });

  it('refuses options the controller would reject at reconcile time', () => {
    const invalid = [
      { scheme: 'internal', targetGroupAttributes: { 'proxy_protocol_v2.enabled': 'true' } },
      {
        scheme: 'internal',
        crossZone: false,
        loadBalancerAttributes: { 'load_balancing.cross_zone.enabled': 'true' },
      },
      { scheme: 'internal', additionalResourceTags: { team: 'a,b' } },
      { scheme: 'internal', name: 'x'.repeat(33) },
      { scheme: 'internal', healthCheck: { path: '/ping' } },
    ] as const;
    for (const options of invalid) {
      expect(() => awsNlbServiceAnnotations(options)).toThrow(/Invalid AWS NLB annotation options/);
    }
  });
});

describe('owned Service in front of Traefik', () => {
  it('carries the load-balancer class, traffic policy and source ranges in direct mode', () => {
    const service = directDocuments(NLB_SPEC).find(
      (document) => document.kind === 'Service' && document.metadata?.name === 'traefik'
    );

    expect(service?.spec?.type).toBe('LoadBalancer');
    expect(service?.spec?.loadBalancerClass).toBe('service.k8s.aws/nlb');
    expect(service?.spec?.externalTrafficPolicy).toBe('Local');
    expect(service?.spec?.loadBalancerSourceRanges).toEqual(['203.0.113.0/24']);
  });

  it('omits them when unset, so a ClusterIP Service stays valid', () => {
    const service = directDocuments({ name: 'traefik', service: { type: 'ClusterIP' } }).find(
      (document) => document.kind === 'Service'
    );

    expect(service?.spec).not.toHaveProperty('loadBalancerClass');
    expect(service?.spec).not.toHaveProperty('externalTrafficPolicy');
    expect(service?.spec).not.toHaveProperty('loadBalancerSourceRanges');
  });

  it('leaves every mixed template in the RGD un-nested, which KRO requires', () => {
    // KRO rejects `${${...}/${...}}` ("nested expressions are not allowed").
    // A conditional spread written in the composition body once made the
    // analyzer re-wrap the published-service pathOverride that way.
    const yaml = traefikBootstrap.toYaml();

    expect(yaml).not.toContain('${${');
    expect(yaml).toContain(
      `pathOverride: '\${has(schema.spec.namespace) && dyn(schema.spec.namespace) != null ? schema.spec.namespace : "traefik"}/\${schema.spec.name}'`
    );
  });

  it('guards each with omit() in the KRO RGD', () => {
    const yaml = traefikBootstrap.toYaml();

    for (const field of [
      'loadBalancerClass',
      'externalTrafficPolicy',
      'loadBalancerSourceRanges',
    ]) {
      expect(yaml).toContain(
        `${field}: '\${has(schema.spec.service) && has(schema.spec.service.${field}) ? schema.spec.service.${field} : omit()}'`
      );
    }
  });
});

describe('entrypoint proxy trust', () => {
  function webAndWebsecure(values: ReturnType<typeof mapTraefikConfigToHelmValues>) {
    return { web: values.ports?.web, websecure: values.ports?.websecure };
  }

  it('maps PROXY protocol and forwarded-header trusted ranges per entrypoint', () => {
    const { web, websecure } = webAndWebsecure(mapTraefikConfigToHelmValues(NLB_SPEC));

    expect(web?.proxyProtocol).toEqual({ trustedIPs: [NLB_SUBNET] });
    expect(web?.forwardedHeaders).toBeUndefined();
    expect(websecure?.proxyProtocol).toEqual({ trustedIPs: [NLB_SUBNET] });
    expect(websecure?.forwardedHeaders).toEqual({ trustedIPs: ['198.51.100.0/24'] });
  });

  it('emits no trust blocks when the spec sets none', () => {
    const { web, websecure } = webAndWebsecure(mapTraefikConfigToHelmValues({ name: 'traefik' }));

    expect(web).not.toHaveProperty('proxyProtocol');
    expect(web).not.toHaveProperty('forwardedHeaders');
    expect(websecure).not.toHaveProperty('proxyProtocol');
  });

  it('refuses a /0 trusted range on either entrypoint and field', () => {
    for (const range of ['0.0.0.0/0', '::/0']) {
      expect(() =>
        mapTraefikConfigToHelmValues({
          name: 'traefik',
          entrypoints: { websecure: { forwardedHeaders: { trustedIPs: [NLB_SUBNET, range] } } },
        })
      ).toThrow(/trusts every source/);
      expect(() =>
        mapTraefikConfigToHelmValues({
          name: 'traefik',
          entrypoints: { web: { proxyProtocol: { trustedIPs: [range] } } },
        })
      ).toThrow(/TRAEFIK|trusts every source/);
    }
  });

  it('refuses insecure trust smuggled in through raw values', () => {
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        { baseValues: { additionalArguments: ['--entryPoints.websecure.proxyProtocol.insecure'] } }
      )
    ).toThrow(/additionalArguments/);
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        { baseValues: { ports: { metrics: { forwardedHeaders: { insecure: true } } } } }
      )
    ).toThrow(/ports\.metrics\.forwardedHeaders\.insecure/);
    for (const arg of [
      '--entryPoints.web.forwardedHeaders.insecure=true',
      '--entrypoints.web.forwardedheaders.insecure=1',
      '--entryPoints.web.proxyProtocol.insecure=T',
    ]) {
      expect(traefikProxyTrustIssues({ additionalArguments: [arg] })).toHaveLength(1);
    }
    expect(
      traefikProxyTrustIssues({
        additionalArguments: ['--entryPoints.web.proxyProtocol.insecure=false'],
      })
    ).toEqual([]);
    expect(
      traefikProxyTrustIssues({
        env: [{ name: 'TRAEFIK_ENTRYPOINTS_WEBSECURE_PROXYPROTOCOL_INSECURE', value: 'true' }],
      })
    ).toEqual([
      expect.stringContaining('env TRAEFIK_ENTRYPOINTS_WEBSECURE_PROXYPROTOCOL_INSECURE'),
    ]);
    expect(() =>
      mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        {
          baseValues: {
            env: [{ name: 'TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_INSECURE', value: '1' }],
          },
        }
      )
    ).toThrow(/trusts every source/);
  });

  // Values TypeKro cannot see: a Secret or ConfigMap could hold
  // TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_INSECURE=true or a /0 trustedIPs.
  const HIDDEN_TRUST_VALUES: Record<string, Record<string, unknown>> = {
    'envFrom secretRef': { envFrom: [{ secretRef: { name: 'traefik-env' } }] },
    'envFrom configMapRef': { envFrom: [{ configMapRef: { name: 'traefik-env' } }] },
    'valueFrom on an insecure name': {
      env: [
        {
          name: 'TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_INSECURE',
          valueFrom: { secretKeyRef: { name: 'traefik-env', key: 'insecure' } },
        },
      ],
    },
    'valueFrom on a lower-case PROXY protocol name': {
      env: [
        {
          name: 'traefik_entrypoints_websecure_proxyprotocol_insecure',
          valueFrom: { configMapKeyRef: { name: 'traefik-env', key: 'insecure' } },
        },
      ],
    },
    'valueFrom on a trustedIPs name': {
      env: [
        {
          name: 'TRAEFIK_ENTRYPOINTS_METRICS_PROXYPROTOCOL_TRUSTEDIPS',
          valueFrom: { secretKeyRef: { name: 'traefik-env', key: 'ranges' } },
        },
      ],
    },
  };

  for (const [label, baseValues] of Object.entries(HIDDEN_TRUST_VALUES)) {
    it(`refuses proxy trust it cannot see: ${label}`, () => {
      expect(() => mapTraefikConfigToHelmValues({ name: 'traefik' }, { baseValues })).toThrow(
        /cannot see that value[\s\S]*dangerouslyTrustAnySource: true/
      );
    });
  }

  it('refuses envFrom and hidden trust values from the bootstrap factory', () => {
    for (const values of Object.values(HIDDEN_TRUST_VALUES)) {
      expect(() =>
        makeTraefikBootstrap({ name: 'traefik-hidden-trust', kind: 'TraefikHiddenTrust', values })
      ).toThrow(/TypeKro cannot see that value/);
    }
  });

  it('refuses a /0 trustedIPs set through a literal env value or an argument', () => {
    expect(
      traefikProxyTrustIssues({
        env: [
          {
            name: 'TRAEFIK_ENTRYPOINTS_WEB_FORWARDEDHEADERS_TRUSTEDIPS',
            value: '10.0.0.0/8,0.0.0.0/0',
          },
        ],
      })
    ).toEqual([expect.stringContaining('trusts every source')]);
    for (const args of [
      ['--entryPoints.web.proxyProtocol.trustedIPs=10.0.0.0/8,::/0'],
      ['--entrypoints.web.forwardedheaders.trustedips', '0.0.0.0/0'],
    ]) {
      expect(traefikProxyTrustIssues({ additionalArguments: args })).toHaveLength(1);
    }
    expect(
      traefikProxyTrustIssues({
        additionalArguments: ['--entryPoints.web.proxyProtocol.trustedIPs=10.0.0.0/8'],
      })
    ).toEqual([]);
  });

  it('lets through env it can vouch for', () => {
    expect(
      traefikProxyTrustIssues({
        envFrom: [],
        env: [
          // valueFrom is fine outside the trust variables...
          { name: 'DNS_API_TOKEN', valueFrom: { secretKeyRef: { name: 'dns', key: 'token' } } },
          // ...and a trust variable with a visible, safe value passes.
          { name: 'TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_TRUSTEDIPS', value: NLB_SUBNET },
          { name: 'TRAEFIK_ENTRYPOINTS_WEB_PROXYPROTOCOL_INSECURE', value: 'false' },
        ],
      })
    ).toEqual([]);
  });

  // A static configuration file outranks every flag, so pointing Traefik at
  // one, or mounting over a path it searches, hides the trust settings.
  const STATIC_CONFIG_VALUES: Record<string, Record<string, unknown>> = {
    '--configFile=': { additionalArguments: ['--configFile=/config/traefik.yml'] },
    '--configfile and a separate value': {
      additionalArguments: ['--configfile', '/config/traefik.yml'],
    },
    '-CONFIGFILE': { additionalArguments: ['-CONFIGFILE=/config/traefik.yml'] },
    'a mount at /etc/traefik': {
      additionalVolumeMounts: [{ name: 'config', mountPath: '/etc/traefik' }],
    },
    'a mount of the file itself': {
      additionalVolumeMounts: [
        { name: 'config', mountPath: '/etc/traefik/traefik.yml', subPath: 'traefik.yml' },
      ],
    },
    'a mount at /etc': { additionalVolumeMounts: [{ name: 'config', mountPath: '/etc/' }] },
    'a mount at the working directory file': {
      additionalVolumeMounts: [{ name: 'config', mountPath: '/traefik.toml' }],
    },
    'a mount at $HOME/.config': {
      additionalVolumeMounts: [{ name: 'config', mountPath: '//.config/./' }],
    },
    'a templated mount path': {
      additionalVolumeMounts: [{ name: 'config', mountPath: '{{ .Values.configPath }}' }],
    },
    'a chart volume': {
      volumes: [{ name: 'config', type: 'configMap', mountPath: '/etc/traefik/../traefik' }],
    },
    'persistence.path': { persistence: { enabled: true, path: '/etc/traefik' } },
    'hub.tokenMountPath': { hub: { token: 'hub', tokenMountPath: '/.config/traefik.yaml' } },
    'a raw local plugin': {
      experimental: {
        localPlugins: {
          stamp: { moduleName: 'stamp', mountPath: '/etc/traefik', type: 'localPath' },
        },
      },
    },
    'a literal HOME with a mount under it': {
      env: [{ name: 'HOME', value: '/home/traefik' }],
      additionalVolumeMounts: [{ name: 'config', mountPath: '/home/traefik/.config' }],
    },
    'a literal XDG_CONFIG_HOME with a mount under it': {
      env: [{ name: 'XDG_CONFIG_HOME', value: '/xdg' }],
      additionalVolumeMounts: [{ name: 'config', mountPath: '/xdg' }],
    },
    'HOME from a reference': {
      env: [{ name: 'HOME', valueFrom: { configMapKeyRef: { name: 'env', key: 'home' } } }],
    },
  };

  for (const [label, baseValues] of Object.entries(STATIC_CONFIG_VALUES)) {
    it(`refuses a static configuration file it cannot see: ${label}`, () => {
      expect(() => mapTraefikConfigToHelmValues({ name: 'traefik' }, { baseValues })).toThrow(
        /static configuration[\s\S]*dangerouslyTrustAnySource: true/
      );
      expect(() =>
        mapTraefikConfigToHelmValues(
          { name: 'traefik' },
          { baseValues, dangerouslyTrustAnySource: true }
        )
      ).not.toThrow();
    });
  }

  it('lets through mounts and arguments that leave the static configuration alone', () => {
    const baseValues: Record<string, unknown> = {
      additionalArguments: ['--log.level=DEBUG', '--providers.file.directory=/config'],
      additionalVolumeMounts: [
        { name: 'dynamic', mountPath: '/etc/traefik/dynamic' },
        { name: 'extra', mountPath: '/etc/traefik-extra' },
        { name: 'certs', mountPath: '/etc/ssl/certs' },
      ],
      volumes: [{ name: 'config', type: 'configMap', mountPath: '/config' }],
      persistence: { path: '/data' },
      experimental: {
        localPlugins: {
          stamp: { moduleName: 'stamp', mountPath: '/plugins-local/src/stamp', type: 'localPath' },
        },
      },
    };
    expect(() => mapTraefikConfigToHelmValues({ name: 'traefik' }, { baseValues })).not.toThrow();
  });

  it('refuses additionalArguments entries that are not literal strings', () => {
    for (const arg of [
      Cel.expr<string>('"--log.level=" + schema.spec.level'),
      '--log.level=__KUBERNETES_REF___schema___spec.level__',
    ]) {
      expect(traefikProxyTrustIssues({ additionalArguments: [arg] })).toEqual([
        expect.stringContaining('additionalArguments[0] is not a literal string'),
      ]);
    }
  });

  it('accepts the hidden sources behind the dangerouslyTrustAnySource escape hatch', () => {
    for (const baseValues of Object.values(HIDDEN_TRUST_VALUES)) {
      const values = mapTraefikConfigToHelmValues(
        { name: 'traefik' },
        { baseValues, dangerouslyTrustAnySource: true }
      );
      expect(values).toMatchObject(baseValues);

      const bootstrap = makeTraefikBootstrap({
        name: 'traefik-hidden-trust-allowed',
        kind: 'TraefikHiddenTrustAllowed',
        dangerouslyTrustAnySource: true,
        values: baseValues,
      });
      expect(() => directDocuments({ name: 'traefik' }, bootstrap)).not.toThrow();
      expect(() => bootstrap.toYaml()).not.toThrow();
    }
  });

  it('accepts both behind the dangerouslyTrustAnySource escape hatch', () => {
    const values = mapTraefikConfigToHelmValues(
      { name: 'traefik', entrypoints: { web: { proxyProtocol: { trustedIPs: ['0.0.0.0/0'] } } } },
      { dangerouslyTrustAnySource: true }
    );
    expect(values.ports?.web?.proxyProtocol?.trustedIPs).toEqual(['0.0.0.0/0']);

    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-any-source',
      kind: 'TraefikAnySource',
      dangerouslyTrustAnySource: true,
    });
    expect(() =>
      directDocuments(
        { name: 'traefik', entrypoints: { web: { proxyProtocol: { trustedIPs: ['::/0'] } } } },
        bootstrap
      )
    ).not.toThrow();
    // ...and the KRO CRD carries no rule.
    expect(bootstrap.toYaml()).not.toContain('endsWith');
  });

  it('warns about a very broad trusted range without refusing it', () => {
    const values = mapTraefikConfigToHelmValues({
      name: 'traefik',
      entrypoints: {
        web: { proxyProtocol: { trustedIPs: ['10.0.0.0/8', '0.0.0.0/1'] } },
        websecure: { forwardedHeaders: { trustedIPs: ['2001:db8::/12', '2001:db8::/32'] } },
      },
    });
    const broad = validateTraefikHelmValues(values).filter((w) => w.includes('very large'));

    expect(broad).toEqual([
      expect.stringContaining('0.0.0.0/1'),
      expect.stringContaining('2001:db8::/12'),
    ]);
  });

  it('warns when the NLB sends PROXY headers an entrypoint will not accept', () => {
    const annotations = awsNlbServiceAnnotations({ scheme: 'internet-facing' });
    const values = mapTraefikConfigToHelmValues({
      name: 'traefik',
      entrypoints: { websecure: { proxyProtocol: { trustedIPs: [NLB_SUBNET] } } },
    });
    const warnings = validateTraefikHelmValues(values, { serviceAnnotations: annotations });

    expect(warnings.filter((warning) => warning.includes('PROXY protocol'))).toEqual([
      expect.stringContaining('`web` entrypoint'),
    ]);
  });
});

describe('TLS from cert-manager', () => {
  it('traefikTlsCertificate issues a rotating ECDSA key into <name>-tls', () => {
    const cert = traefikTlsCertificate({
      name: 'api',
      namespace: 'edge',
      hostnames: ['api.example.com', 'www.example.com'],
      issuerRef: { name: 'letsencrypt' },
      id: 'apiCertificate',
    });

    expect(cert.kind).toBe('Certificate');
    expect(cert.metadata.namespace).toBe('edge');
    expect(cert.spec.secretName).toBe('api-tls');
    expect(cert.spec.dnsNames).toEqual(['api.example.com', 'www.example.com']);
    expect(cert.spec.issuerRef).toMatchObject({ name: 'letsencrypt', kind: 'ClusterIssuer' });
    expect(cert.spec.privateKey).toEqual({
      algorithm: 'ECDSA',
      size: 256,
      rotationPolicy: 'Always',
    });
  });

  it('the bootstrap can own the Certificate behind the default TLSStore', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-default-cert',
      kind: 'TraefikDefaultCert',
      defaultTlsStore: {
        defaultCertificateSecretName: 'edge-default-tls',
        certificate: { hostnames: ['*.example.com'], issuerRef: { name: 'letsencrypt' } },
      },
    });
    const docs = directDocuments({ name: 'traefik', namespace: 'traefik' }, bootstrap);
    const cert = docs.find((document) => document.kind === 'Certificate');
    const store = docs.find((document) => document.kind === 'TLSStore');

    expect(cert?.metadata).toMatchObject({ name: 'edge-default-tls', namespace: 'traefik' });
    expect(cert?.spec?.secretName).toBe('edge-default-tls');
    expect(cert?.spec?.dnsNames).toEqual(['*.example.com']);
    expect(store?.spec?.defaultCertificate).toEqual({ secretName: 'edge-default-tls' });
  });

  it('owns no Certificate unless asked', () => {
    const bootstrap = makeTraefikBootstrap({
      name: 'traefik-store-only',
      kind: 'TraefikStoreOnly',
      defaultTlsStore: { defaultCertificateSecretName: 'edge-default-tls' },
    });
    const docs = directDocuments({ name: 'traefik' }, bootstrap);

    expect(docs.some((document) => document.kind === 'Certificate')).toBe(false);
    expect(docs.some((document) => document.kind === 'TLSStore')).toBe(true);
  });
});
