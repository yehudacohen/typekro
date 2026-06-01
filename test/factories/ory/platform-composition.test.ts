import { describe, expect, it } from 'bun:test';
import { oryPlatformStack } from '../../../src/factories/ory/index.js';
import {
  OryPlatformStackConfigSchema,
  OryPlatformStackStatusSchema,
} from '../../../src/factories/ory/types.js';

function endpoint(url: string, host: string, port: number) {
  return { url, scheme: 'http', host, port };
}

// Platform tests live separately from `oryIdentityStack` tests because this composition
// owns graph-managed infrastructure selection in addition to Ory Helm wiring.
describe('Ory platform stack composition', () => {
  it('Accept managed local defaults through the platform stack config schema', () => {
    const result = OryPlatformStackConfigSchema({
      name: 'identity-local',
      namespace: 'ory-local',
      managed: {
        databases: true,
        secrets: true,
        routes: true,
        sampleUpstream: true,
        courierSes: false,
      },
      dependencySources: {
        hydra: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-local-hydra-db' } },
          systemSecret: {
            mode: 'managed',
            secretName: 'identity-local-hydra-secrets',
            secretKey: 'system',
          },
        },
        kratos: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-local-kratos-db' } },
          secrets: {
            cookie: {
              mode: 'managed',
              secretName: 'identity-local-kratos-secrets',
              secretKey: 'cookie',
            },
            cipher: {
              mode: 'managed',
              secretName: 'identity-local-kratos-secrets',
              secretKey: 'cipher',
            },
          },
        },
        keto: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-local-keto-db' } },
        },
        oathkeeper: {
          upstream: { url: { mode: 'managed', resourceName: 'identity-local-upstream' } },
          mutatorIdTokenJwks: {
            mode: 'managed',
            secretName: 'identity-local-oathkeeper-secrets',
            secretKey: 'jwks',
          },
        },
      },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Accept optional ACK SES courier sources without making baseline local email mandatory', () => {
    const result = OryPlatformStackConfigSchema({
      name: 'identity-ses',
      namespace: 'ory-ses',
      managed: {
        databases: true,
        secrets: true,
        routes: true,
        sampleUpstream: true,
        courierSes: true,
      },
      dependencySources: {
        courier: { mode: 'managed', resourceName: 'identity-ses-courier' },
        kratos: {
          courier: { mode: 'managed', resourceName: 'identity-ses-courier' },
        },
      },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Expose platform status fields for infrastructure readiness and dependency resolution', () => {
    const result = OryPlatformStackStatusSchema({
      ready: true,
      phase: 'Ready',
      infrastructure: { databases: true, secrets: true, routes: true, upstream: true, courier: false },
      dependencies: {
        hydraDatabase: 'managed',
        kratosDatabase: 'managed',
        ketoDatabase: 'managed',
        secrets: 'managed',
        routes: 'managed',
        upstream: 'managed',
        courier: 'external',
      },
      ory: {
        ready: true,
        phase: 'Ready',
        components: { hydra: true, kratos: true, keto: true, oathkeeper: true },
        maester: { hydra: true, oathkeeper: true },
        endpoints: {
          hydraPublic: endpoint('http://hydra-public.ory-local.svc.cluster.local:4444', 'hydra-public.ory-local.svc.cluster.local', 4444),
          hydraAdmin: endpoint('http://hydra-admin.ory-local.svc.cluster.local:4445', 'hydra-admin.ory-local.svc.cluster.local', 4445),
          kratosPublic: endpoint('http://kratos-public.ory-local.svc.cluster.local:4433', 'kratos-public.ory-local.svc.cluster.local', 4433),
          kratosAdmin: endpoint('http://kratos-admin.ory-local.svc.cluster.local:4434', 'kratos-admin.ory-local.svc.cluster.local', 4434),
          ketoRead: endpoint('http://keto-read.ory-local.svc.cluster.local:4466', 'keto-read.ory-local.svc.cluster.local', 4466),
          ketoWrite: endpoint('http://keto-write.ory-local.svc.cluster.local:4467', 'keto-write.ory-local.svc.cluster.local', 4467),
          oathkeeperProxy: endpoint('http://oathkeeper-proxy.ory-local.svc.cluster.local:4455', 'oathkeeper-proxy.ory-local.svc.cluster.local', 4455),
          oathkeeperApi: endpoint('http://oathkeeper-api.ory-local.svc.cluster.local:4456', 'oathkeeper-api.ory-local.svc.cluster.local', 4456),
        },
        version: '0.62.0',
      },
      endpoints: {
        hydraPublic: endpoint('http://hydra.localhost', 'hydra.localhost', 80),
        hydraAdmin: endpoint('http://hydra-admin.ory-local.svc.cluster.local:4445', 'hydra-admin.ory-local.svc.cluster.local', 4445),
        kratosPublic: endpoint('http://kratos.localhost', 'kratos.localhost', 80),
        kratosAdmin: endpoint('http://kratos-admin.ory-local.svc.cluster.local:4434', 'kratos-admin.ory-local.svc.cluster.local', 4434),
        ketoRead: endpoint('http://keto-read.ory-local.svc.cluster.local:4466', 'keto-read.ory-local.svc.cluster.local', 4466),
        ketoWrite: endpoint('http://keto-write.ory-local.svc.cluster.local:4467', 'keto-write.ory-local.svc.cluster.local', 4467),
        oathkeeperProxy: endpoint('http://identity.localhost', 'identity.localhost', 4455),
        oathkeeperApi: endpoint('http://oathkeeper-api.ory-local.svc.cluster.local:4456', 'oathkeeper-api.ory-local.svc.cluster.local', 4456),
      },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Create a graph-native ResourceGraphDefinition with managed infrastructure and Ory wiring', () => {
    const yaml = oryPlatformStack.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: ory-platform-stack');
    expect(yaml).toContain('cnpg');
    expect(yaml).toContain('Secret');
    expect(yaml).not.toContain('apisix.apache.org/v2');
    expect(yaml).toContain('sampleUpstream');
    expect(yaml).toContain('oryIdentityStack');
    expect(yaml).toContain('dependencies:');
    expect(yaml).toContain('hydra-db-app');
    expect(yaml).toContain('kratos-db-app');
    expect(yaml).toContain('keto-db-app');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.database.dsn');
    expect(yaml).toContain('schema.spec.dependencySources.kratos.database.dsn');
    expect(yaml).toContain('schema.spec.dependencySources.keto.database.dsn');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.issuerUrl.url');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.loginUrl.url');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.consentUrl.url');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.logoutUrl.url');
    expect(yaml).toContain('schema.spec.dependencySources.kratos.publicBaseUrl.url');
    expect(yaml).toContain('schema.spec.dependencySources.kratos.browserBaseUrl.url');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.database.dsn.value.secretRef.name');
    expect(yaml).toContain('schema.spec.dependencySources.hydra.database.dsn.value.secretRef.key');
    expect(yaml).toContain('schema.spec.dependencySources.kratos.secrets.cookie.value.secretRef.name');
    expect(yaml).toContain('identitySchemas.keys().map');
    expect(yaml).toContain('default_browser_return_url');
    expect(yaml).toContain('includeWhen');
    expect(yaml).toContain('schema.spec.managed.databases');
    expect(yaml).toContain('schema.spec.managed.secrets');
    expect(yaml).toContain('schema.spec.managed.sampleUpstream');
    expect(yaml).toMatch(/id: hydraDatabase[\s\S]*includeWhen:[\s\S]*schema\.spec\.managed\.databases/);
    expect(yaml).toMatch(/id: kratosDatabase[\s\S]*includeWhen:[\s\S]*schema\.spec\.managed\.databases/);
    expect(yaml).toMatch(/id: ketoDatabase[\s\S]*includeWhen:[\s\S]*schema\.spec\.managed\.databases/);
    expect(yaml).not.toContain('__typekroSchemaKey');
    expect(yaml).not.toContain('undefined');
  });

  it('Reject disabled managed dependencies unless external replacements are supplied', async () => {
    const factory = oryPlatformStack.factory('direct', { namespace: 'ory-system' });

    try {
      await factory.toYaml({
        name: 'identity-missing-externals',
        namespace: 'ory-system',
        managed: { databases: false, secrets: false, routes: false, sampleUpstream: false },
      });
      throw new Error('Expected missing external dependencies to fail');
    } catch (error) {
      expect(String(error)).toMatch(
        /Ory production configuration is incomplete|ORY_UNRESOLVED_DEPENDENCY_SOURCE/
      );
    }
  });

  it('Omit managed infrastructure resources when every dependency is externally supplied', async () => {
    const factory = oryPlatformStack.factory('direct', { namespace: 'ory-system' });
    const yaml = await factory.toYaml({
      name: 'identity-external',
      namespace: 'ory-system',
      managed: { databases: false, secrets: false, routes: false, sampleUpstream: false },
      dependencySources: {
        hydra: {
          database: { dsn: { mode: 'external', value: { secretRef: { name: 'ory-dsns', key: 'hydra' } } } },
          systemSecret: { mode: 'external', value: { secretRef: { name: 'ory-secrets', key: 'hydra-system' } } },
        },
        kratos: {
          database: { dsn: { mode: 'external', value: { secretRef: { name: 'ory-dsns', key: 'kratos' } } } },
          secrets: {
            cookie: { mode: 'external', value: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } } },
            cipher: { mode: 'external', value: { secretRef: { name: 'ory-secrets', key: 'kratos-cipher' } } },
          },
        },
        keto: {
          database: { dsn: { mode: 'external', value: { secretRef: { name: 'ory-dsns', key: 'keto' } } } },
        },
        oathkeeper: {
          proxyRoute: { url: { mode: 'external', url: 'https://identity.example.com' } },
          upstream: { url: { mode: 'external', url: 'https://api.example.com' } },
          mutatorIdTokenJwks: {
            mode: 'external',
            value: { secretRef: { name: 'ory-secrets', key: 'oathkeeper-jwks' } },
          },
        },
      },
    });

    expect(yaml).toContain('identity-external-hydra');
    expect(yaml).toContain('identity-external-kratos');
    expect(yaml).not.toContain('identity-external-hydra-db');
    expect(yaml).not.toContain('identity-external-kratos-db');
    expect(yaml).not.toContain('identity-external-keto-db');
    expect(yaml).not.toContain('sampleUpstream');
  });

  it('Order managed dependency resources before Ory Helm releases in direct-mode YAML', async () => {
    const factory = oryPlatformStack.factory('direct', { namespace: 'ory-local' });
    const yaml = await factory.toYaml({
      name: 'identity-local',
      namespace: 'ory-local',
      managed: { databases: true, secrets: true, routes: true, sampleUpstream: true },
    });

    const databaseIndex = yaml.indexOf('identity-local-hydra-db');
    const secretIndex = yaml.indexOf('identity-local-hydra-secrets');
    const hydraReleaseIndex = yaml.indexOf('name: identity-local-hydra\n');
    const routeIndex = yaml.indexOf('kind: ApisixRoute');

    expect(databaseIndex).toBeGreaterThanOrEqual(0);
    expect(secretIndex).toBeGreaterThanOrEqual(0);
    expect(hydraReleaseIndex).toBeGreaterThan(databaseIndex);
    expect(hydraReleaseIndex).toBeGreaterThan(secretIndex);
    expect(routeIndex).toBeGreaterThan(hydraReleaseIndex);
  });

  it('Include optional APISIX routes in concrete direct-mode YAML only', async () => {
    const factory = oryPlatformStack.factory('direct', { namespace: 'ory-local' });
    const yaml = await factory.toYaml({
      name: 'identity-local',
      namespace: 'ory-local',
      managed: { databases: true, secrets: true, routes: true, sampleUpstream: true },
    });

    expect(yaml).toContain('apisix.apache.org/v2');
    expect(yaml).toContain('identity-local-hydra-public-route');
    expect(yaml).toContain('identity-local-kratos-public-route');
    expect(yaml).toContain('identity-local-oathkeeper-proxy-route');
    expect(yaml).toContain('identity-local-oathkeeper-api-route');
    expect(yaml).toContain('issuer: http://hydra.localhost');
    expect(yaml).toContain('default_browser_return_url: http://kratos.localhost');
    expect(yaml).toMatch(/identity-local-hydra-public-route[\s\S]*servicePort: 4444/);
    expect(yaml).toMatch(/identity-local-kratos-public-route[\s\S]*servicePort: 4433/);
    expect(yaml).toMatch(/identity-local-oathkeeper-proxy-route[\s\S]*servicePort: 4455/);
    expect(yaml).toMatch(/identity-local-oathkeeper-api-route[\s\S]*servicePort: 4456/);
    expect(yaml).not.toContain('issuer: http://identity-local-hydra-public-route');
  });

  it('Omit route resource names in graph mode because APISIX routes are not emitted in the RGD', () => {
    const yaml = oryPlatformStack.toYaml();

    expect(yaml).not.toContain('identity-local-hydra-public-route');
    expect(yaml).not.toContain('-hydra-public-route');
    expect(yaml).not.toContain('-oathkeeper-proxy-route');
  });
});
