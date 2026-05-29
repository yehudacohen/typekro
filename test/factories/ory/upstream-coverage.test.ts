import { describe, expect, it } from 'bun:test';
import yaml from 'js-yaml';
import type {
  OAuth2ClientSpec,
  OAuth2ClientStatus,
  OathkeeperRuleSpec,
  OathkeeperRuleStatus,
  OryHydraChartValues,
  OryHydraMaesterChartValues,
  OryKetoChartValues,
  OryKratosChartValues,
  OryOathkeeperChartValues,
  OryOathkeeperMaesterChartValues,
  OryObjectMap,
} from '../../../src/factories/ory/types.js';
import {
  ORY_FREE_FORM_FIELD_PATHS,
  ORY_MAESTER_CRD_FIELD_PATHS,
  ORY_PINNED_CHART_VERSION,
  ORY_UPSTREAM_FIELD_PATHS,
} from './fixtures/upstream-field-paths.js';

type FieldProbe = object;

const ORY_K8S_TAG = 'v0.62.0';
const ORY_K8S_RAW_BASE = `https://raw.githubusercontent.com/ory/k8s/${ORY_K8S_TAG}`;

const UPSTREAM_VALUE_FILES = {
  hydra: 'helm/charts/hydra/values.yaml',
  kratos: 'helm/charts/kratos/values.yaml',
  keto: 'helm/charts/keto/values.yaml',
  oathkeeper: 'helm/charts/oathkeeper/values.yaml',
  hydraMaester: 'helm/charts/hydra-maester/values.yaml',
  oathkeeperMaester: 'helm/charts/oathkeeper-maester/values.yaml',
} as const;

const UPSTREAM_CRD_FILES = {
  oauth2Client: 'helm/charts/hydra-maester/crds/crd-oauth2clients.yaml',
  oathkeeperRule: 'helm/charts/oathkeeper-maester/crds/crd-rules.yaml',
} as const;

async function fetchPinnedYaml(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${ORY_K8S_RAW_BASE}/${path}`, { signal: controller.signal });
    expect(response.ok).toBe(true);
    return yaml.load(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

function collectYamlObjectPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];

  if (Array.isArray(value)) {
    const nested = value.flatMap((item) => collectYamlObjectPaths(item, prefix));
    return [...new Set(nested)];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...collectYamlObjectPaths(child, path)];
  });
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === 'object' ? (properties as Record<string, unknown>) : {};
}

function collectOpenApiPropertyPaths(schema: unknown, prefix = ''): string[] {
  return Object.entries(schemaProperties(schema)).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const typedChild = child as { items?: unknown; additionalProperties?: unknown };
    return [
      path,
      ...collectOpenApiPropertyPaths(child, path),
      ...collectOpenApiPropertyPaths(typedChild.items, path),
      ...collectOpenApiPropertyPaths(typedChild.additionalProperties, path),
    ];
  });
}

function getCrdVersionSchema(crd: unknown): unknown {
  if (!crd || typeof crd !== 'object') return undefined;
  const versions = (crd as { spec?: { versions?: unknown } }).spec?.versions;
  const versionList = Array.isArray(versions) ? versions : [];
  const servedVersion = versionList.find((version) => {
    return Boolean(version && typeof version === 'object' && (version as { served?: unknown }).served);
  });
  return (servedVersion as { schema?: { openAPIV3Schema?: unknown } } | undefined)?.schema
    ?.openAPIV3Schema;
}

function expectFixtureCoversAllUpstreamPaths(
  actual: readonly string[],
  expected: string[],
  freeFormRoots: readonly string[] = []
): void {
  const missing = expected.filter(
    (path) =>
      !actual.some(
        (coveredPath) =>
          coveredPath === path ||
          path.startsWith(`${coveredPath}.`) ||
          freeFormRoots.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}.`))
      )
  );
  expect(missing).toEqual([]);
}

const CHART_FREE_FORM_ROOTS = {
  hydra: ['hydra.config'],
  kratos: ['kratos.config'],
  keto: ['keto.config'],
  oathkeeper: ['oathkeeper.config'],
  hydraMaester: [],
  oathkeeperMaester: [],
} as const;

const CRD_FREE_FORM_ROOTS = {
  oauth2ClientSpec: ORY_FREE_FORM_FIELD_PATHS.filter((path) => path.startsWith('oauth2ClientSpec.')).map(
    (path) => path.replace('oauth2ClientSpec.', '')
  ),
  oathkeeperRuleSpec: ORY_FREE_FORM_FIELD_PATHS.filter((path) => path.startsWith('oathkeeperRuleSpec.')).map(
    (path) => path.replace('oathkeeperRuleSpec.', '')
  ),
} as const;

function expectPath(object: FieldProbe, path: string): void {
  const segments = path.split('.');
  let current: unknown = object;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      expect(current.length).toBeGreaterThan(0);
      for (const item of current) {
        expect(item && typeof item === 'object').toBe(true);
        expect(segment in (item as Record<string, unknown>)).toBe(true);
      }
      current = (current[0] as Record<string, unknown>)[segment];
      continue;
    }

    expect(current && typeof current === 'object').toBe(true);
    expect(segment in (current as Record<string, unknown>)).toBe(true);
    current = (current as Record<string, unknown>)[segment];
  }
}

describe('Ory upstream chart and CRD coverage', () => {
  it('Verify the Hydra fixture includes every pinned upstream chart value field path', async () => {
    const upstream = await fetchPinnedYaml(UPSTREAM_VALUE_FILES.hydra);
    const expectedPaths = collectYamlObjectPaths(upstream);

    expectFixtureCoversAllUpstreamPaths(
      ORY_UPSTREAM_FIELD_PATHS.hydra,
      expectedPaths,
      CHART_FREE_FORM_ROOTS.hydra
    );
  });

  it('Verify the Kratos fixture includes every pinned upstream chart value field path', async () => {
    const upstream = await fetchPinnedYaml(UPSTREAM_VALUE_FILES.kratos);
    const expectedPaths = collectYamlObjectPaths(upstream);

    expectFixtureCoversAllUpstreamPaths(
      ORY_UPSTREAM_FIELD_PATHS.kratos,
      expectedPaths,
      CHART_FREE_FORM_ROOTS.kratos
    );
  });

  it('Verify the Keto fixture includes every pinned upstream chart value field path', async () => {
    const upstream = await fetchPinnedYaml(UPSTREAM_VALUE_FILES.keto);
    const expectedPaths = collectYamlObjectPaths(upstream);

    expectFixtureCoversAllUpstreamPaths(
      ORY_UPSTREAM_FIELD_PATHS.keto,
      expectedPaths,
      CHART_FREE_FORM_ROOTS.keto
    );
  });

  it('Verify the Oathkeeper fixture includes every pinned upstream chart value field path', async () => {
    const upstream = await fetchPinnedYaml(UPSTREAM_VALUE_FILES.oathkeeper);
    const expectedPaths = collectYamlObjectPaths(upstream);

    expectFixtureCoversAllUpstreamPaths(
      ORY_UPSTREAM_FIELD_PATHS.oathkeeper,
      expectedPaths,
      CHART_FREE_FORM_ROOTS.oathkeeper
    );
  });

  it('Verify the Hydra Maester fixture includes every pinned upstream chart field path', async () => {
    const upstream = await fetchPinnedYaml(UPSTREAM_VALUE_FILES.hydraMaester);
    const expectedPaths = collectYamlObjectPaths(upstream);

    expectFixtureCoversAllUpstreamPaths(
      ORY_UPSTREAM_FIELD_PATHS.hydraMaester,
      expectedPaths,
      CHART_FREE_FORM_ROOTS.hydraMaester
    );
  });

  it('Verify the Oathkeeper Maester fixture includes every pinned upstream chart field path', async () => {
    const upstream = await fetchPinnedYaml(UPSTREAM_VALUE_FILES.oathkeeperMaester);
    const expectedPaths = collectYamlObjectPaths(upstream);

    expectFixtureCoversAllUpstreamPaths(
      ORY_UPSTREAM_FIELD_PATHS.oathkeeperMaester,
      expectedPaths,
      CHART_FREE_FORM_ROOTS.oathkeeperMaester
    );
  });

  it('Verify the OAuth2Client fixture includes every pinned upstream CRD spec/status path', async () => {
    const crd = await fetchPinnedYaml(UPSTREAM_CRD_FILES.oauth2Client);
    const schema = getCrdVersionSchema(crd);
    const expectedSpecPaths = collectOpenApiPropertyPaths(schemaProperties(schema).spec);
    const expectedStatusPaths = collectOpenApiPropertyPaths(schemaProperties(schema).status);

    expectFixtureCoversAllUpstreamPaths(
      ORY_MAESTER_CRD_FIELD_PATHS.oauth2ClientSpec,
      expectedSpecPaths,
      CRD_FREE_FORM_ROOTS.oauth2ClientSpec
    );
    expectFixtureCoversAllUpstreamPaths(
      ORY_MAESTER_CRD_FIELD_PATHS.oauth2ClientStatus,
      expectedStatusPaths
    );
  });

  it('Verify the Oathkeeper Rule fixture includes every pinned upstream CRD spec/status path', async () => {
    const crd = await fetchPinnedYaml(UPSTREAM_CRD_FILES.oathkeeperRule);
    const schema = getCrdVersionSchema(crd);
    const expectedSpecPaths = collectOpenApiPropertyPaths(schemaProperties(schema).spec);
    const expectedStatusPaths = collectOpenApiPropertyPaths(schemaProperties(schema).status);

    expectFixtureCoversAllUpstreamPaths(
      ORY_MAESTER_CRD_FIELD_PATHS.oathkeeperRuleSpec,
      expectedSpecPaths,
      CRD_FREE_FORM_ROOTS.oathkeeperRuleSpec
    );
    expectFixtureCoversAllUpstreamPaths(
      ORY_MAESTER_CRD_FIELD_PATHS.oathkeeperRuleStatus,
      expectedStatusPaths
    );
  });

  it('Model every pinned Hydra chart field path in a physical hydra schema module', () => {
    const values: OryHydraChartValues = {
      global: {},
      replicaCount: 2,
      image: {},
      imagePullSecrets: [],
      nameOverride: 'hydra',
      fullnameOverride: 'hydra-full',
      priorityClassName: 'platform-critical',
      service: { public: {}, admin: {} },
      secret: {},
      ingress: { public: {}, admin: {} },
      hydra: {
        config: { serve: { public: { port: 4444 }, admin: { port: 4445 } }, secrets: {} },
        automigration: {},
        customMigrations: {},
        dev: false,
      },
      deployment: { extraEnv: [] },
      job: {},
      affinity: {},
      maester: { enabled: true },
      'hydra-maester': { adminService: {} },
      watcher: {},
      janitor: {},
      cronjob: { janitor: {} },
      pdb: {},
      serviceMonitor: {},
      configmap: {},
      test: {},
    };

    for (const path of ORY_UPSTREAM_FIELD_PATHS.hydra) {
      expectPath(values, path);
    }
  });

  it('Model every pinned Kratos chart field path in a physical kratos schema module', () => {
    const values: OryKratosChartValues = {
      global: {},
      replicaCount: 2,
      strategy: {},
      image: {},
      imagePullSecrets: [],
      nameOverride: 'kratos',
      fullnameOverride: 'kratos-full',
      service: { admin: {}, public: {}, courier: {} },
      secret: {},
      ingress: { admin: {}, public: {} },
      kratos: {
        development: false,
        automigration: {},
        identitySchemas: {},
        emailTemplates: {},
        config: { courier: {}, serve: { public: { port: 4433 }, admin: { port: 4434 } } },
      },
      deployment: { extraEnv: [] },
      statefulSet: { extraEnv: [] },
      securityContext: {},
      autoscaling: {},
      job: {},
      courier: { enabled: true },
      watcher: {},
      cleanup: {},
      cronjob: { cleanup: {} },
      pdb: {},
      serviceMonitor: {},
      configmap: {},
      test: {},
    };

    for (const path of ORY_UPSTREAM_FIELD_PATHS.kratos) {
      expectPath(values, path);
    }
  });

  it('Model every pinned Keto chart field path in a physical keto schema module', () => {
    const values: OryKetoChartValues = {
      global: {},
      replicaCount: 2,
      image: {},
      imagePullSecrets: [],
      nameOverride: 'keto',
      fullnameOverride: 'keto-full',
      priorityClassName: 'platform-critical',
      serviceAccount: {},
      podSecurityContext: {},
      securityContext: {},
      job: {},
      ingress: { read: {}, write: {} },
      service: { read: {}, write: {}, metrics: {} },
      extraServices: {},
      secret: {},
      keto: {
        command: ['serve'],
        customArgs: ['all'],
        automigration: {},
        config: {
          serve: { read: { port: 4466 }, write: { port: 4467 }, metrics: { port: 4468 } },
          namespaces: [],
          dsn: 'memory',
        },
      },
      deployment: { extraEnv: [] },
      watcher: {},
      pdb: {},
      serviceMonitor: {},
      configmap: {},
      test: {},
    };

    for (const path of ORY_UPSTREAM_FIELD_PATHS.keto) {
      expectPath(values, path);
    }
  });

  it('Model every pinned Oathkeeper chart field path in a physical oathkeeper schema module', () => {
    const values: OryOathkeeperChartValues = {
      global: {},
      replicaCount: 2,
      revisionHistoryLimit: 10,
      image: { initContainer: {} },
      sidecar: { image: {} },
      priorityClassName: 'platform-critical',
      imagePullSecrets: [],
      nameOverride: 'oathkeeper',
      fullnameOverride: 'oathkeeper-full',
      securityContext: {},
      podSecurityContext: {},
      demo: false,
      service: { proxy: {}, api: {}, metrics: {} },
      ingress: { proxy: {}, api: {} },
      oathkeeper: {
        helmTemplatedConfigEnabled: true,
        configFileOverride: {},
        config: { access_rules: { repositories: [] }, serve: { proxy: { port: 4455 } } },
        mutatorIdTokenJWKs: '{}',
        accessRulesOverride: {},
        accessRules: '[]',
        managedAccessRules: true,
      },
      secret: {},
      deployment: { extraEnv: [] },
      affinity: {},
      maester: { enabled: true },
      pdb: {},
      serviceMonitor: {},
      configmap: {},
      test: {},
    };

    for (const path of ORY_UPSTREAM_FIELD_PATHS.oathkeeper) {
      expectPath(values, path);
    }
  });

  it('Model every pinned Hydra Maester chart and OAuth2Client CRD field path', () => {
    const values: OryHydraMaesterChartValues = {
      global: {},
      replicaCount: 1,
      revisionHistoryLimit: 10,
      enabledNamespaces: ['ory-system'],
      singleNamespaceMode: true,
      image: {},
      imagePullSecrets: [],
      priorityClassName: 'platform-critical',
      adminService: {
        name: 'hydra-admin',
        port: 4445,
        endpoint: '/admin/clients',
        scheme: 'http',
        tlsTrustStorePath: '/var/run/secrets/ca.crt',
        insecureSkipVerify: false,
      },
      forwardedProto: 'https',
      deployment: { args: { syncPeriod: '10m' }, extraEnv: [], extraVolumes: [], extraVolumeMounts: [] },
      affinity: {},
      pdb: {},
      service: { metrics: {} },
      serviceMonitor: {},
    };
    const spec: OAuth2ClientSpec = {
      accessTokenStrategy: 'jwt',
      allowedCorsOrigins: [],
      audience: [],
      backChannelLogoutSessionRequired: false,
      backChannelLogoutURI: 'https://client.example.com/backchannel',
      clientName: 'console',
      clientSecretExpiresAt: 0,
      clientUri: 'https://client.example.com',
      contacts: [],
      deletionPolicy: 'delete',
      frontChannelLogoutSessionRequired: false,
      frontChannelLogoutURI: 'https://client.example.com/frontchannel',
      grantTypes: ['authorization_code'],
      hydraAdmin: { endpoint: '/admin/clients', forwardedProto: 'https', port: 4445, url: 'http://hydra-admin' },
      jwksUri: 'https://client.example.com/jwks.json',
      logoUri: 'https://client.example.com/logo.png',
      metadata: {},
      policyUri: 'https://client.example.com/policy',
      postLogoutRedirectUris: [],
      redirectUris: ['https://client.example.com/callback'],
      requestObjectSigningAlg: 'RS256',
      requestUris: [],
      responseTypes: ['code'],
      scope: 'openid offline',
      scopeArray: ['openid'],
      secretName: 'console-oauth2-client',
      sectorIdentifierUri: 'https://client.example.com/sector.json',
      skipConsent: false,
      skipLogoutConsent: false,
      subjectType: 'public',
      tokenEndpointAuthMethod: 'client_secret_basic',
      tokenEndpointAuthSigningAlg: 'RS256',
      tokenLifespans: { authorization_code_grant_access_token_lifespan: '1h' },
      tosUri: 'https://client.example.com/tos',
      userinfoSignedResponseAlg: 'RS256',
    };
    const status: OAuth2ClientStatus = {
      conditions: [{ status: 'True', type: 'Ready' }],
      observedGeneration: 1,
      reconciliationError: { description: 'none', statusCode: '200' },
    };

    for (const path of ORY_UPSTREAM_FIELD_PATHS.hydraMaester) expectPath(values, path);
    for (const path of ORY_MAESTER_CRD_FIELD_PATHS.oauth2ClientSpec) expectPath(spec, path);
    for (const path of ORY_MAESTER_CRD_FIELD_PATHS.oauth2ClientStatus) expectPath(status, path);
  });

  it('Model every pinned Oathkeeper Maester chart and Rule CRD field path', () => {
    const values: OryOathkeeperMaesterChartValues = {
      global: {},
      replicaCount: 1,
      revisionHistoryLimit: 10,
      singleNamespaceMode: true,
      rulesConfigmapNamespace: 'ory-system',
      rulesFileName: 'access-rules.json',
      image: {},
      imagePullSecrets: [],
      securityContext: {},
      podSecurityContext: {},
      deployment: { envs: {}, extraLabels: {}, annotations: {} },
      affinity: {},
      pdb: {},
    };
    const spec: OathkeeperRuleSpec = {
      authenticators: [{ handler: 'cookie_session', config: {} }],
      authorizer: { handler: 'allow', config: {} },
      configMapName: 'oathkeeper-rules',
      errors: [{ handler: 'json', config: {} }],
      match: { methods: ['GET'], url: 'https://api.example.com/<.*>' },
      mutators: [{ handler: 'id_token', config: {} }],
      upstream: { preserveHost: true, stripPath: '/api', url: 'http://backend.default.svc.cluster.local' },
    };
    const status: OathkeeperRuleStatus = {
      validation: { valid: true, validationError: '' },
    };

    for (const path of ORY_UPSTREAM_FIELD_PATHS.oathkeeperMaester) expectPath(values, path);
    for (const path of ORY_MAESTER_CRD_FIELD_PATHS.oathkeeperRuleSpec) expectPath(spec, path);
    for (const path of ORY_MAESTER_CRD_FIELD_PATHS.oathkeeperRuleStatus) expectPath(status, path);
  });

  it('Preserve upstream arbitrary object nodes as Record<string, unknown>', () => {
    const freeFormPayload: OryObjectMap = { nested: { provider: 'custom' }, list: [1, 2, 3] };

    expect(ORY_PINNED_CHART_VERSION).toBe('0.62.0');
    expect(ORY_FREE_FORM_FIELD_PATHS).toContain('oathkeeperRuleSpec.authenticators.config');
    expect(freeFormPayload).toEqual({ nested: { provider: 'custom' }, list: [1, 2, 3] });
  });
});
