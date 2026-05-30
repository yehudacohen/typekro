import { describe, expect, it } from 'bun:test';
import { oryIdentityStack } from '../../../src/factories/ory/index.js';
import { OryIdentityStackConfigSchema, OryIdentityStackStatusSchema } from '../../../src/factories/ory/types.js';

// Test decision: keep this file focused on Ory-only Helm wiring. Graph-managed
// infrastructure coverage lives in `platform-composition.test.ts`.
describe('Ory identity stack composition', () => {
  it('Accept explicit external dependency sources through the stack config schema', () => {
    const result = OryIdentityStackConfigSchema({
      name: 'identity',
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
          mutatorIdTokenJwks: {
            mode: 'external',
            value: { secretRef: { name: 'ory-secrets', key: 'oathkeeper-jwks' } },
          },
        },
      },
      hydra: {
        dsn: { secretRef: { name: 'ory-dsns', key: 'hydra' } },
        systemSecret: { secretRef: { name: 'ory-secrets', key: 'hydra-system' } },
      },
      kratos: {
        dsn: { secretRef: { name: 'ory-dsns', key: 'kratos' } },
        secrets: {
          cookie: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } },
          cipher: { secretRef: { name: 'ory-secrets', key: 'kratos-cipher' } },
        },
      },
      keto: {
        dsn: { secretRef: { name: 'ory-dsns', key: 'keto' } },
      },
      oathkeeper: {
        managedAccessRules: true,
        mutatorIdTokenJwks: { secretRef: { name: 'ory-secrets', key: 'oathkeeper-jwks' } },
      },
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Expose stack status fields for readiness, Maester health, endpoints, and version', () => {
    const result = OryIdentityStackStatusSchema({
      ready: true,
      phase: 'Ready',
      components: { hydra: true, kratos: true, keto: true, oathkeeper: true },
      maester: { hydra: true, oathkeeper: true },
      endpoints: {
        hydraPublic: 'http://hydra-public.ory-system.svc.cluster.local',
        hydraAdmin: 'http://hydra-admin.ory-system.svc.cluster.local',
        kratosPublic: 'http://kratos-public.ory-system.svc.cluster.local',
        kratosAdmin: 'http://kratos-admin.ory-system.svc.cluster.local',
        ketoRead: 'http://keto-read.ory-system.svc.cluster.local',
        ketoWrite: 'http://keto-write.ory-system.svc.cluster.local',
        oathkeeperProxy: 'http://oathkeeper-proxy.ory-system.svc.cluster.local',
        oathkeeperApi: 'http://oathkeeper-api.ory-system.svc.cluster.local',
      },
      version: '0.62.0',
    });

    expect(result instanceof Error).toBe(false);
  });

  it('Create an Ory identity stack ResourceGraphDefinition with all services and Maester controllers', () => {
    const yaml = oryIdentityStack.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: ory-identity-stack');
    expect(yaml).toContain('oryHelmRepository');
    expect(yaml).toContain('hydraHelmRelease');
    expect(yaml).toContain('kratosHelmRelease');
    expect(yaml).toContain('ketoHelmRelease');
    expect(yaml).toContain('oathkeeperHelmRelease');
    expect(yaml).toContain('maester:');
    expect(yaml).toContain('hydra: ${hydraHelmRelease.status.conditions');
    expect(yaml).toContain('oathkeeper: ${oathkeeperHelmRelease.status.conditions');
    expect(yaml).toContain('schema.spec.dependencySources');
    expect(yaml).toContain('schema.spec.hydra.replicaCount');
    expect(yaml).not.toContain('schema.spec.customValues');
    expect(yaml).not.toContain('schema.spec.resources');
    expect(yaml).not.toContain('undefined');
  });

  it('Generate direct-mode YAML for managed local dependency sources with starter OAuth2Client and Rule resources', async () => {
    const factory = oryIdentityStack.factory('direct', { namespace: 'ory-test' });
    const yaml = await factory.toYaml({
      name: 'identity-test',
      namespace: 'ory-test',
      dependencySources: {
        hydra: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-test-hydra-db' } },
          systemSecret: { mode: 'managed', secretName: 'identity-test-hydra-secrets', secretKey: 'system' },
        },
        kratos: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-test-kratos-db' } },
          secrets: {
            cookie: { mode: 'managed', secretName: 'identity-test-kratos-secrets', secretKey: 'cookie' },
            cipher: { mode: 'managed', secretName: 'identity-test-kratos-secrets', secretKey: 'cipher' },
          },
        },
        keto: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-test-keto-db' } },
        },
        oathkeeper: {
          mutatorIdTokenJwks: {
            mode: 'managed',
            secretName: 'identity-test-oathkeeper-secrets',
            secretKey: 'jwks',
          },
        },
      },
      maester: {
        hydra: { enabled: true, singleNamespaceMode: true },
        oathkeeper: { enabled: true, singleNamespaceMode: true },
      },
      resources: {
        oauth2Clients: [
          {
            id: 'consoleOAuth2Client',
            name: 'console',
            namespace: 'ory-test',
            spec: {
              grantTypes: ['authorization_code'],
              responseTypes: ['code'],
              redirectUris: ['http://console.localhost/callback'],
              secretName: 'console-oauth2-client',
            },
          },
        ],
        oathkeeperRules: [
          {
            id: 'apiRule',
            name: 'api-rule',
            namespace: 'ory-test',
            spec: {
              match: { methods: ['GET'], url: 'http://api.localhost/<.*>' },
              upstream: { url: 'http://api.default.svc.cluster.local' },
            },
          },
        ],
      },
    });

    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('kind: HelmRelease');
    expect(yaml).toContain('hydra-maester');
    expect(yaml).toContain('oathkeeper-maester');
    expect(yaml).toContain('singleNamespaceMode: true');
    expect(yaml).toContain('name: identity-test-hydra-db');
    expect(yaml).toContain('name: identity-test-kratos-db');
    expect(yaml).toContain('name: identity-test-keto-db');
    expect(yaml).toContain('managedAccessRules: false');
    expect(yaml).toContain("access-rules.json: '[]'");
    expect(yaml).toContain('path: /health/alive');
    expect(yaml).toContain('kind: OAuth2Client');
    expect(yaml).toContain('kind: Rule');
    expect(yaml).toContain('apiVersion: hydra.ory.sh/v1alpha1');
    expect(yaml).toContain('apiVersion: oathkeeper.ory.sh/v1alpha1');
    expect(yaml).not.toContain('undefined');
  });

});
