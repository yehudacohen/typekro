/**
 * CrowdSec bootstrap: values mapping, option validation, and the same values
 * shape in direct and KRO mode.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type } from 'arktype';
import { load, loadAll } from 'js-yaml';

import {
  assertCrowdsecBootstrapOptions,
  CrowdsecBootstrapConfigSchema,
  type CrowdsecBootstrapOptions,
  crowdsecBootstrap,
  DEFAULT_CROWDSEC_CHART_VERSION,
  DEFAULT_CROWDSEC_REPOSITORY_NAME,
  makeCrowdsecBootstrap,
  mapCrowdsecConfigToHelmValues,
  CROWDSEC_KUBECTL_IMAGE_TAG,
  renderCrowdsecAppsecPolicy,
  renderCrowdsecSimulation,
} from '../../../src/factories/crowdsec/index.js';

const ORIGINAL_STRICT = process.env.TYPEKRO_STRICT_CEL;
const ORIGINAL_KUBECONFIG = process.env.KUBECONFIG;
let kubeconfigDir: string | undefined;

beforeAll(() => {
  process.env.TYPEKRO_STRICT_CEL = '1';
  kubeconfigDir = mkdtempSync(join(tmpdir(), 'typekro-crowdsec-'));
  const path = join(kubeconfigDir, 'kubeconfig');
  writeFileSync(
    path,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters: [{ name: hermetic, cluster: { server: "https://127.0.0.1:1" } }]',
      'contexts: [{ name: hermetic, context: { cluster: hermetic, user: hermetic } }]',
      'current-context: hermetic',
      'users: [{ name: hermetic, user: {} }]',
      '',
    ].join('\n')
  );
  process.env.KUBECONFIG = path;
});

afterAll(() => {
  if (ORIGINAL_STRICT === undefined) delete process.env.TYPEKRO_STRICT_CEL;
  else process.env.TYPEKRO_STRICT_CEL = ORIGINAL_STRICT;
  if (ORIGINAL_KUBECONFIG === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = ORIGINAL_KUBECONFIG;
  if (kubeconfigDir) rmSync(kubeconfigDir, { recursive: true, force: true });
});

interface Doc {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: Record<string, unknown>;
}

type Values = Record<string, any>;

function docs(yaml: string): Doc[] {
  return loadAll(yaml).filter((d): d is Doc => d !== null && typeof d === 'object');
}

function directValues(options: CrowdsecBootstrapOptions = {}): { all: Doc[]; values: Values } {
  const yaml = makeCrowdsecBootstrap(options)
    .factory('direct', { namespace: 'flux-system' })
    .toYaml({ name: 'crowdsec', namespace: 'crowdsec' });
  const all = docs(yaml);
  const release = all.find((d) => d.kind === 'HelmRelease');
  return { all, values: (release?.spec?.values ?? {}) as Values };
}

const POLICY: CrowdsecBootstrapOptions = {
  bouncers: [{ name: 'traefik', keySecretRef: { name: 'crowdsec-bouncer', key: 'api-key' } }],
  allowlist: { ips: ['192.0.2.10'], cidrs: ['198.51.100.0/24', '2001:db8::/32'] },
  simulation: { global: true, enforce: ['crowdsecurity/http-cve-probing'] },
  collections: ['crowdsecurity/whitelist-good-actors'],
  appsec: {
    maxBodySize: 1_048_576,
    exclusions: [
      { ruleName: 'crowdsecurity/vpatch-env-access', pathPrefix: '/health' },
      { ruleId: 942100, phase: 'outofband' },
    ],
  },
};

describe('crowdsecBootstrap defaults', () => {
  const { all, values } = directValues();

  it('owns the namespace and references the shared repository by name', () => {
    expect(all.find((d) => d.kind === 'Namespace')?.metadata?.name).toBe('crowdsec');
    const release = all.find((d) => d.kind === 'HelmRelease') as Doc;
    const chart = (release.spec?.chart as Values).spec;
    expect(chart.version).toBe(DEFAULT_CROWDSEC_CHART_VERSION);
    expect(chart.sourceRef.name).toBe(DEFAULT_CROWDSEC_REPOSITORY_NAME);
    expect(release.spec?.releaseName).toBe('crowdsec');
    expect(release.spec?.targetNamespace).toBe('crowdsec');
  });

  it('runs LAPI on SQLite with one replica, offline, and never exposed', () => {
    expect(values.lapi.replicas).toBe(1);
    expect(values.lapi.persistentVolume.data.enabled).toBe(true);
    expect(values.lapi.persistentVolume.config.enabled).toBe(false);
    expect(values.lapi.strategy.type).toBe('Recreate');
    expect(values.lapi.ingress.enabled).toBe(false);
    expect(values.lapi.service.type).toBe('ClusterIP');
    expect(values.lapi.env).toContainEqual({ name: 'DISABLE_ONLINE_API', value: 'true' });
    // The chart's register Job has RBAC only with CAPI on.
    expect(values.lapi.storeLAPICscliCredentialsInSecret).toBe(false);
  });

  it('reads the Traefik pods from a DaemonSet with the Traefik collections', () => {
    expect(values.agent.isDeployment).toBe(false);
    expect(values.container_runtime).toBe('containerd');
    expect(values.agent.acquisition).toEqual([
      { namespace: 'traefik', podName: 'traefik-*', program: 'traefik' },
    ]);
    expect(values.agent.env).toEqual([
      {
        name: 'COLLECTIONS',
        value: 'crowdsecurity/traefik crowdsecurity/base-http-scenarios crowdsecurity/http-cve',
      },
    ]);
  });

  it('sets requests on every component and serves metrics', () => {
    for (const component of ['lapi', 'agent']) {
      expect(values[component].resources.requests.cpu).toBeString();
      expect(values[component].resources.requests.memory).toBeString();
      expect(values[component].metrics.enabled).toBe(true);
      // Memory limits only: CPU throttling would sit on the request path.
      expect(values[component].resources.limits.memory).toBeString();
      expect(values[component].resources.limits.cpu).toBeUndefined();
    }
    expect(values.appsec).toEqual({
      enabled: false,
      service: { type: 'ClusterIP', externalIPs: [], loadBalancerIP: '', loadBalancerClass: '' },
    });
  });

  it('pins the kubectl image of the register Jobs and creates no NetworkPolicy', () => {
    expect(values.image.kubectl.tag).toBe(CROWDSEC_KUBECTL_IMAGE_TAG);
    expect(all.some((d) => d.kind === 'NetworkPolicy')).toBe(false);
  });

  it('creates a non-blocking LAPI PDB and spreads LAPI across nodes', () => {
    const pdbs = all.filter((d) => d.kind === 'PodDisruptionBudget');
    expect(pdbs.map((d) => d.metadata?.name)).toEqual(['crowdsec-lapi']);
    expect(pdbs[0]?.spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { 'k8s-app': 'crowdsec', type: 'lapi' } },
    });
    expect(values.lapi.topologySpreadConstraints[0].topologyKey).toBe('kubernetes.io/hostname');
  });

  it('keeps the auto-registration token as an env reference KRO will not parse', () => {
    const local = load(values.config['config.yaml.local']) as Values;
    expect(local.api.server.auto_registration.token).toBe('$REGISTRATION_TOKEN');
    expect(values.config['config.yaml.local']).not.toContain('${');
  });
});

describe('crowdsecBootstrap policy options', () => {
  const { all, values } = directValues(POLICY);

  it('registers bouncers from secretKeyRef env', () => {
    expect(values.lapi.env).toContainEqual({
      name: 'BOUNCER_KEY_traefik',
      valueFrom: { secretKeyRef: { name: 'crowdsec-bouncer', key: 'api-key' } },
    });
  });

  it('renders the allowlist as a parser whitelist and, for AppSec, a postoverflow', () => {
    const parser = load(values.config.parsers['s02-enrich']['typekro-allowlist.yaml']) as Values;
    expect(parser.whitelist.ip).toEqual(['192.0.2.10']);
    expect(parser.whitelist.cidr).toEqual(['198.51.100.0/24', '2001:db8::/32']);
    expect(values.appsec.postoverflows['s01-whitelist']['typekro-allowlist.yaml']).toBe(
      values.config.parsers['s02-enrich']['typekro-allowlist.yaml']
    );
  });

  it('renders global simulation with exclusions and mounts it on AppSec too', () => {
    expect(load(values.config['simulation.yaml'])).toEqual({
      simulation: true,
      exclusions: ['crowdsecurity/http-cve-probing'],
    });
    expect(values.appsec.extraVolumeMounts[0].mountPath).toBe('/etc/crowdsec/simulation.yaml');
    expect(values.appsec.extraVolumes[0].configMap.name).toBe('crowdsec-simulation');
  });

  it('renders simulate-only scenarios when global simulation is off', () => {
    expect(
      load(
        renderCrowdsecSimulation({
          global: false,
          simulate: ['crowdsecurity/http-crawl-non_statics'],
        })
      )
    ).toEqual({ simulation: false, exclusions: ['crowdsecurity/http-crawl-non_statics'] });
    expect(load(renderCrowdsecSimulation({ global: false }))).toEqual({
      simulation: false,
      exclusions: [],
    });
    // Only global simulation keeps AppSec in-band from blocking.
    const policy = load(
      renderCrowdsecAppsecPolicy({ appsec: {}, simulation: { global: false, simulate: ['x/y'] } })
    ) as Values;
    expect(policy.default_remediation).toBe('ban');
  });

  it('appends extra collections once', () => {
    expect(values.agent.env[0].value.split(' ')).toEqual([
      'crowdsecurity/traefik',
      'crowdsecurity/base-http-scenarios',
      'crowdsecurity/http-cve',
      'crowdsecurity/whitelist-good-actors',
    ]);
  });

  it('runs virtual patching in-band, CRS out-of-band, then the policy config', () => {
    expect(values.appsec.enabled).toBe(true);
    expect(values.appsec.acquisitions[0].appsec_configs).toEqual([
      'crowdsecurity/appsec-default',
      'crowdsecurity/crs',
      'typekro/appsec-policy',
    ]);
    expect(values.appsec.env).toEqual([
      {
        name: 'COLLECTIONS',
        value:
          'crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-generic-rules crowdsecurity/appsec-crs',
      },
    ]);
    expect(all.some((d) => d.metadata?.name === 'crowdsec-appsec')).toBe(true);
  });

  it('writes the body limit and exclusions as AppSec hooks', () => {
    const policy = load(values.appsec.configs['typekro-appsec-policy.yaml']) as Values;
    // Global simulation keeps in-band matches from blocking.
    expect(policy.default_remediation).toBe('allow');
    expect(policy.on_load[0].apply).toEqual([
      'SetMaxBodySize(1048576)',
      "SetBodySizeExceededAction('partial')",
      'RemoveOutBandRuleByID(942100)',
    ]);
    expect(policy.pre_eval).toEqual([
      {
        filter: "req.URL.Path startsWith '/health'",
        apply: [
          "RemoveInBandRuleByName('crowdsecurity/vpatch-env-access')",
          "RemoveOutBandRuleByName('crowdsecurity/vpatch-env-access')",
        ],
      },
    ]);
  });

  it('bans in-band by default without simulation', () => {
    const policy = load(renderCrowdsecAppsecPolicy({ appsec: {} })) as Values;
    expect(policy.default_remediation).toBe('ban');
  });
});

describe('crowdsecBootstrap storage, CAPI and agents', () => {
  it('uses an existing Postgres and allows several replicas', () => {
    const { values } = directValues({
      storage: {
        type: 'postgres',
        host: 'postgres.db.svc.cluster.local',
        database: 'crowdsec',
        user: 'crowdsec',
        passwordSecretRef: { name: 'crowdsec-db', key: 'password' },
      },
      lapi: { replicas: 3 },
    });
    expect(values.lapi.replicas).toBe(3);
    expect(values.lapi.persistentVolume.data.enabled).toBe(false);
    expect(values.lapi.strategy.type).toBe('RollingUpdate');
    expect(values.lapi.env).toContainEqual({
      name: 'DB_PASSWORD',
      valueFrom: { secretKeyRef: { name: 'crowdsec-db', key: 'password' } },
    });
    const local = load(values.config['config.yaml.local']) as Values;
    expect(local.db_config).toEqual({
      type: 'postgresql',
      user: 'crowdsec',
      password: '$DB_PASSWORD',
      db_name: 'crowdsec',
      host: 'postgres.db.svc.cluster.local',
      port: 5432,
      sslmode: 'require',
    });
  });

  it('enrolls with CAPI from a secret and can opt out of the community blocklist', () => {
    const { values } = directValues({
      centralApi: {
        communityBlocklist: false,
        enrollment: {
          keySecretRef: { name: 'crowdsec-enroll', key: 'key' },
          instanceName: 'edge',
          tags: ['k8s', 'edge'],
        },
      },
    });
    expect(values.lapi.env).not.toContainEqual({ name: 'DISABLE_ONLINE_API', value: 'true' });
    expect(values.lapi.env).toContainEqual({
      name: 'ENROLL_KEY',
      valueFrom: { secretKeyRef: { name: 'crowdsec-enroll', key: 'key' } },
    });
    expect(values.lapi.env).toContainEqual({ name: 'ENROLL_TAGS', value: 'k8s edge' });
    expect(values.lapi.storeCAPICredentialsInSecret).toBe(true);
    const local = load(values.config['config.yaml.local']) as Values;
    expect(local.api.server.online_client).toEqual({ pull: { community: false } });
  });

  it('appends lapi.env and agent.env after the env this factory sets', () => {
    const { values } = directValues({
      lapi: { env: [{ name: 'LEVEL_DEBUG', value: 'true' }] },
      agent: { env: [{ name: 'DISABLE_PARSERS', value: 'crowdsecurity/whitelists' }] },
    });
    expect(values.lapi.env.at(-1)).toEqual({ name: 'LEVEL_DEBUG', value: 'true' });
    expect(values.lapi.env[0]).toEqual({ name: 'DISABLE_ONLINE_API', value: 'true' });
    expect(values.agent.env.map((e: { name: string }) => e.name)).toEqual([
      'COLLECTIONS',
      'DISABLE_PARSERS',
    ]);
  });

  it('restricts LAPI and AppSec ingress with the optional NetworkPolicies', () => {
    const { all } = directValues({
      appsec: {},
      networkPolicy: { traefikNamespace: 'edge', metricsNamespace: 'monitoring' },
    });
    const policies = all.filter((d) => d.kind === 'NetworkPolicy') as (Doc & {
      spec: Values;
    })[];
    expect(policies.map((d) => d.metadata?.name).sort()).toEqual([
      'crowdsec-appsec',
      'crowdsec-lapi',
    ]);
    const lapi = policies.find((d) => d.metadata?.name === 'crowdsec-lapi')?.spec as Values;
    expect(lapi.podSelector).toEqual({ matchLabels: { 'k8s-app': 'crowdsec', type: 'lapi' } });
    expect(lapi.ingress[0]).toEqual({
      from: [
        { podSelector: { matchLabels: { 'k8s-app': 'crowdsec', type: 'agent' } } },
        { podSelector: { matchLabels: { 'k8s-app': 'crowdsec', type: 'appsec' } } },
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'edge' } } },
      ],
      ports: [{ port: 8080, protocol: 'TCP' }],
    });
    expect(lapi.ingress[1]).toEqual({
      from: [
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'monitoring' } } },
      ],
      ports: [{ port: 6060, protocol: 'TCP' }],
    });
    const appsec = policies.find((d) => d.metadata?.name === 'crowdsec-appsec')?.spec as Values;
    expect(appsec.ingress[0]).toEqual({
      from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'edge' } } }],
      ports: [{ port: 7422, protocol: 'TCP' }],
    });
  });

  it('lets raw values fill gaps but never re-expose LAPI', () => {
    const { values } = directValues({
      values: {
        lapi: { ingress: { enabled: true }, dnsConfig: { options: [] } },
        podLabels: { a: 'b' },
      },
    });
    expect(values.lapi.ingress.enabled).toBe(false);
    expect(values.lapi.dnsConfig).toEqual({ options: [] });
    expect(values.podLabels).toEqual({ a: 'b' });
  });

  it('keeps every Service ClusterIP-only and TLS off whatever raw values say', () => {
    const publish = {
      type: 'LoadBalancer',
      externalIPs: ['203.0.113.10'],
      loadBalancerIP: '203.0.113.11',
      loadBalancerClass: 'example.com/lb',
    };
    const { values } = directValues({
      appsec: {},
      values: {
        lapi: { service: publish },
        agent: { service: publish },
        appsec: { service: publish },
        tls: { enabled: false, insecureSkipVerify: true },
      },
    });
    for (const component of ['lapi', 'agent', 'appsec']) {
      expect(values[component].service).toEqual({
        type: 'ClusterIP',
        externalIPs: [],
        loadBalancerIP: '',
        loadBalancerClass: '',
      });
    }
    expect(values.tls).toEqual({ enabled: false, insecureSkipVerify: true });
    expect(() => directValues({ values: { tls: { enabled: true } } })).toThrow(
      /values.tls.enabled is not supported/
    );
  });

  it('caps the release name at 33, for <name>-lapi-cscli-credentials-volume', () => {
    expect(CrowdsecBootstrapConfigSchema({ name: 'a'.repeat(33) })).toEqual({
      name: 'a'.repeat(33),
    });
    expect(`${'a'.repeat(33)}-lapi-cscli-credentials-volume`).toHaveLength(63);
    expect(CrowdsecBootstrapConfigSchema({ name: 'a'.repeat(34) })).toBeInstanceOf(type.errors);
  });

  it('single-quotes the Postgres password, which CrowdSec substitutes before parsing', () => {
    const { values } = directValues({
      storage: {
        type: 'postgres',
        host: 'postgres.db.svc.cluster.local',
        database: 'crowdsec',
        user: 'crowdsec',
        passwordSecretRef: { name: 'crowdsec-db', key: 'password' },
      },
    });
    const text: string = values.config['config.yaml.local'];
    expect(text).toContain("password: '$DB_PASSWORD'");
    // What CrowdSec parses after substituting a password with ", \ and #.
    const expanded = load(text.replace('$DB_PASSWORD', 'p"a\\s#s: x')) as Values;
    expect(expanded.db_config.password).toBe('p"a\\s#s: x');
  });
});

describe('assertCrowdsecBootstrapOptions', () => {
  const rejects = (options: CrowdsecBootstrapOptions, message: RegExp) =>
    expect(() => assertCrowdsecBootstrapOptions(options)).toThrow(message);

  it('rejects topologies CrowdSec cannot run', () => {
    rejects({ lapi: { replicas: 2 } }, /needs storage.type "postgres"/);
    rejects({ lapi: { replicas: 0 } }, /positive integer/);
    rejects({ acquisitions: [] }, /At least one acquisition/);
    rejects(
      { acquisitions: [{ namespace: 'traefik', podName: 'traefik-*/../x' }] },
      /pod-name glob/
    );
  });

  it('rejects strings KRO would parse as CEL', () => {
    rejects({ appsec: { exclusions: [{ ruleId: 1, pathPrefix: '/${x}' }] } }, /parse as CEL/);
    rejects({ allowlist: { ips: ['192.0.2.1'], reason: '${schema.spec.name}' } }, /parse as CEL/);
    rejects({ simulation: { global: true, enforce: ['${a}'] } }, /parse as CEL/);
    rejects({ collections: ['${a}'] }, /parse as CEL/);
    rejects({ lapi: { env: [{ name: 'X', value: '${a}' }] } }, /parse as CEL/);
    rejects(
      { agent: { env: [{ name: 'X', valueFrom: { secretKeyRef: { name: '${a}', key: 'k' } } }] } },
      /parse as CEL/
    );
    rejects({ networkPolicy: { traefikNamespace: '${a}' } }, /parse as CEL/);
    rejects({ networkPolicy: { traefikNamespace: 'Edge_NS' } }, /DNS-1123/);
    rejects(
      { networkPolicy: { traefikNamespace: 'edge', metricsNamespace: 'a'.repeat(64) } },
      /DNS-1123/
    );
  });

  it('rejects malformed policy', () => {
    rejects(
      { bouncers: [{ name: 'traefik-edge', keySecretRef: { name: 's', key: 'k' } }] },
      /env var/
    );
    rejects(
      {
        bouncers: [
          { name: 'a', keySecretRef: { name: 's', key: 'k' } },
          { name: 'a', keySecretRef: { name: 's', key: 'k' } },
        ],
      },
      /declared twice/
    );
    rejects({ allowlist: { ips: ['300.1.1.1'] } }, /not an IPv4 or IPv6/);
    rejects({ allowlist: { cidrs: ['10.0.0.0/33'] } }, /not a valid range/);
    rejects({ appsec: { virtualPatching: false, crs: false } }, /omit appsec/);
    rejects({ appsec: { exclusions: [{ ruleId: 1, ruleTag: 'x' }] } }, /exactly one/);
    rejects({ appsec: { exclusions: [{ ruleName: "a'b" }] } }, /quotes/);
    rejects({ appsec: { exclusions: [{ ruleId: 1, pathPrefix: 'api' }] } }, /start with/);
    rejects({ appsec: { maxBodySize: 0 } }, /positive integer/);
  });

  it('validates eagerly, at build time', () => {
    expect(() => makeCrowdsecBootstrap({ lapi: { replicas: 2 } })).toThrow(/postgres/);
  });
});

describe('crowdsecBootstrap KRO mode', () => {
  const rgd = () =>
    docs(makeCrowdsecBootstrap(POLICY).factory('kro', { namespace: 'crowdsec' }).toYaml()).find(
      (d) =>
        d.kind === 'ResourceGraphDefinition' &&
        (d.spec?.schema as Values | undefined)?.kind === 'CrowdsecBootstrap'
    );

  it('projects every status field from the owned release', () => {
    const status = (rgd()?.spec?.schema as Values).status as Record<string, string>;
    for (const field of ['ready', 'failed', 'phase', 'lapiHost', 'appsecHost', 'version']) {
      expect(status[field]).toContain('crowdsecHelmRelease');
    }
    expect(status.lapiHost).toContain('-service.');
    expect(status.appsecHost).toContain('spec.values.appsec.enabled');
  });

  it('keeps the same values shape as direct mode', () => {
    const resources = rgd()?.spec?.resources as { id: string; template: Doc }[];
    const kroValues = resources.find((r) => r.id === 'crowdsecHelmRelease')?.template.spec
      ?.values as Values;
    const { values } = directValues(POLICY);
    const shape = (tree: Values): unknown =>
      Object.fromEntries(
        Object.entries(tree).map(([key, value]) => [
          key,
          value && typeof value === 'object' && !Array.isArray(value) ? shape(value) : typeof value,
        ])
      );
    // Sizing is a CEL default in KRO, so compare everything but the resources leaves.
    const strip = (tree: Values) => {
      const copy = structuredClone(tree);
      for (const component of ['lapi', 'agent', 'appsec']) {
        delete copy[component].resources;
        delete copy[component].replicas;
        delete copy[component].topologySpreadConstraints;
      }
      return copy;
    };
    expect(shape(strip(kroValues))).toEqual(shape(strip(values)));
    expect(kroValues.config).toEqual(values.config);
    expect(kroValues.lapi.env).toEqual(values.lapi.env);
  });

  it('guards the runtime sizing fields with CEL defaults', () => {
    const yaml = makeCrowdsecBootstrap(POLICY).factory('kro', { namespace: 'crowdsec' }).toYaml();
    expect(yaml).toContain('has(schema.spec.lapi) && has(schema.spec.lapi.resources)');
    expect(yaml).toContain('has(schema.spec.appsec) && has(schema.spec.appsec.replicas)');
    expect(yaml).toContain(`: "${DEFAULT_CROWDSEC_CHART_VERSION}"`);
    // Only CEL that TypeKro emits; `$REGISTRATION_TOKEN` stays a plain string.
    expect(yaml).not.toContain('${REGISTRATION_TOKEN}');
  });

  it('emits the singleton owner before the instance', () => {
    const parsed = docs(
      crowdsecBootstrap.factory('kro', { namespace: 'crowdsec' }).toYaml({ name: 'crowdsec' })
    );
    const owner = parsed.findIndex((d) => d.kind === 'CrowdsecHelmRepository');
    const instance = parsed.findIndex((d) => d.kind === 'CrowdsecBootstrap');
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(instance);
  });
});

describe('mapCrowdsecConfigToHelmValues', () => {
  it('uses the spec sizing when given', () => {
    const values = mapCrowdsecConfigToHelmValues(
      {
        name: 'crowdsec',
        lapi: { resources: { requests: { cpu: '1', memory: '1Gi' } } },
        appsec: { replicas: 2 },
      },
      { appsec: {} }
    ) as Values;
    expect(values.lapi.resources).toEqual({ requests: { cpu: '1', memory: '1Gi' } });
    expect(values.appsec.replicas).toBe(2);
  });
});
