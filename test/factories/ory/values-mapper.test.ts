import { describe, expect, it } from 'bun:test';
import {
  getOryHealthChecks,
  getOryHelmValueWarnings,
  getOryMetricSignals,
  mapOryConfigToHelmValues,
  validateOryConfig,
} from '../../../src/factories/ory/utils/helm-values-mapper.js';
import type { OryIdentityStackConfig } from '../../../src/factories/ory/types.js';

const externalConfig: OryIdentityStackConfig = {
  name: 'identity',
  namespace: 'ory-system',
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
    issuerUrl: 'https://hydra.example.com',
    loginUrl: 'https://login.example.com/login',
    consentUrl: 'https://login.example.com/consent',
    logoutUrl: 'https://login.example.com/logout',
  },
  kratos: {
    dsn: { secretRef: { name: 'ory-dsns', key: 'kratos' } },
    publicBaseUrl: 'https://kratos.example.com',
    browserBaseUrl: 'https://identity.example.com',
    secrets: {
      cookie: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } },
      cipher: { secretRef: { name: 'ory-secrets', key: 'kratos-cipher' } },
    },
  },
  keto: {
    dsn: { secretRef: { name: 'ory-dsns', key: 'keto' } },
    namespaces: [{ id: 1, name: 'documents' }],
  },
  oathkeeper: {
    managedAccessRules: true,
    mutatorIdTokenJwks: { secretRef: { name: 'ory-secrets', key: 'oathkeeper-jwks' } },
  },
  maester: {
    hydra: { enabled: true, singleNamespaceMode: true },
    oathkeeper: { enabled: true, singleNamespaceMode: true },
  },
};

describe('Ory Helm values mapper', () => {
  it('Require Ory dependencies to resolve through external values or graph-managed resources', () => {
    const result = validateOryConfig({ name: 'identity' });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['ORY_UNRESOLVED_DEPENDENCY_SOURCE'])
    );
    expect(result.issues.every((issue) => !issue.message.includes('postgres://'))).toBe(true);
  });

  it('Accept complete external Secret references through dependencySources', () => {
    const result = validateOryConfig(externalConfig);

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('Provide graph-managed local configuration without external databases or public DNS', () => {
    const values = mapOryConfigToHelmValues({
      name: 'identity-test',
      namespace: 'ory-test',
      dependencySources: {
        hydra: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-hydra-db' } },
          systemSecret: { mode: 'managed', secretName: 'identity-hydra-secrets', secretKey: 'system' },
        },
        kratos: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-kratos-db' } },
          secrets: {
            cookie: { mode: 'managed', secretName: 'identity-kratos-secrets', secretKey: 'cookie' },
            cipher: { mode: 'managed', secretName: 'identity-kratos-secrets', secretKey: 'cipher' },
          },
        },
        keto: { database: { dsn: { mode: 'managed', resourceName: 'identity-keto-db' } } },
        oathkeeper: {
          mutatorIdTokenJwks: {
            mode: 'managed',
            secretName: 'identity-oathkeeper-secrets',
            secretKey: 'jwks',
          },
        },
      },
      maester: {
        hydra: { enabled: true, singleNamespaceMode: true },
        oathkeeper: { enabled: true, singleNamespaceMode: true },
      },
    });

    expect(values.hydra.deployment?.extraEnv).toContainEqual({
      name: 'DSN',
      valueFrom: { secretKeyRef: { name: 'identity-hydra-db', key: 'dsn' } },
    });
    expect(values.hydra.hydra?.dev).toBe(true);
    expect(values.kratos.kratos?.development).toBe(true);
    expect(values.kratos.kratos?.config?.selfservice).toEqual({
      default_browser_return_url: 'http://identity-test-kratos-public.ory-test.svc.cluster.local',
    });
    expect(values.hydraMaester.singleNamespaceMode).toBe(true);
    expect(values.oathkeeperMaester.singleNamespaceMode).toBe(true);
    expect(values.oathkeeper.oathkeeper?.managedAccessRules).toBe(true);
  });

  it('Resolve managed route dependency URLs from their runtime URL, not resource name', () => {
    const values = mapOryConfigToHelmValues({
      name: 'identity-local',
      namespace: 'ory-local',
      dependencySources: {
        hydra: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-local-hydra-db' } },
          systemSecret: {
            mode: 'managed',
            secretName: 'identity-local-hydra-secrets',
            secretKey: 'system',
          },
          issuerUrl: {
            url: {
              mode: 'managed',
              resourceName: 'identity-local-hydra-public-route',
              url: 'http://hydra.localhost',
            },
          },
          loginUrl: {
            url: {
              mode: 'managed',
              resourceName: 'identity-local-kratos-public-route',
              url: 'http://kratos.localhost',
            },
          },
        },
        kratos: {
          database: { dsn: { mode: 'managed', resourceName: 'identity-local-kratos-db' } },
          publicBaseUrl: {
            url: {
              mode: 'managed',
              resourceName: 'identity-local-kratos-public-route',
              url: 'http://kratos.localhost',
            },
          },
          browserBaseUrl: {
            url: {
              mode: 'managed',
              resourceName: 'identity-local-kratos-public-route',
              url: 'http://kratos.localhost',
            },
          },
          secrets: {
            cookie: { mode: 'managed', secretName: 'identity-local-kratos-secrets', secretKey: 'cookie' },
            cipher: { mode: 'managed', secretName: 'identity-local-kratos-secrets', secretKey: 'cipher' },
          },
        },
        keto: { database: { dsn: { mode: 'managed', resourceName: 'identity-local-keto-db' } } },
        oathkeeper: {
          mutatorIdTokenJwks: {
            mode: 'managed',
            secretName: 'identity-local-oathkeeper-secrets',
            secretKey: 'jwks',
          },
        },
      },
    });

    expect(values.hydra.hydra?.config?.urls).toMatchObject({
      self: { issuer: 'http://hydra.localhost' },
      login: 'http://kratos.localhost',
    });
    expect(values.kratos.kratos?.config?.selfservice).toEqual({
      default_browser_return_url: 'http://kratos.localhost',
    });
    expect(JSON.stringify(values)).not.toContain('identity-local-hydra-public-route');
  });

  it('Map Ory chart config to upstream runtime shapes for URLs and local Kratos schema defaults', () => {
    const values = mapOryConfigToHelmValues(externalConfig);

    expect(values.hydra.hydra?.config?.urls).toMatchObject({
      self: { issuer: 'https://hydra.example.com' },
      login: 'https://login.example.com/login',
    });
    expect(values.kratos.kratos?.config?.serve).toMatchObject({
      public: { base_url: 'https://kratos.example.com' },
    });
    expect(values.kratos.kratos?.config?.selfservice).toEqual({
      default_browser_return_url: 'https://identity.example.com',
    });
    expect(values.kratos.kratos?.config?.identity).toEqual({
      schemas: [{ id: 'default', url: 'file:///etc/config/identity.default.schema.json' }],
    });
    expect(values.kratos.kratos?.identitySchemas?.['identity.default.schema.json']).toContain(
      'Default Identity'
    );
  });

  it('Point Kratos identity config at custom schema filenames', () => {
    const values = mapOryConfigToHelmValues({
      ...externalConfig,
      kratos: {
        ...externalConfig.kratos,
        identitySchemas: {
          'customer.schema.json': JSON.stringify({ type: 'object' }),
        },
      },
    });

    expect(values.kratos.kratos?.identitySchemas?.['customer.schema.json']).toBeDefined();
    expect(values.kratos.kratos?.config?.identity).toEqual({
      schemas: [{ id: 'customer', url: 'file:///etc/config/customer.schema.json' }],
    });
  });

  it('Reject unsafe chart value combinations outside explicit managed local dependencies', () => {
    expect(() =>
      mapOryConfigToHelmValues({
        ...externalConfig,
        hydra: {
          ...externalConfig.hydra,
          values: { hydra: { dev: true } },
        },
      })
    ).toThrow(/ORY_UNSAFE_PRODUCTION_VALUE|dev/i);
  });

  it('Reject per-service dev mode when only another service database is managed', () => {
    expect(() =>
      mapOryConfigToHelmValues({
        ...externalConfig,
        dependencySources: {
          ...externalConfig.dependencySources,
          hydra: {
            ...externalConfig.dependencySources?.hydra,
            database: { dsn: { mode: 'managed', resourceName: 'identity-hydra-db' } },
          },
        },
        kratos: {
          ...externalConfig.kratos,
          values: { kratos: { development: true } },
        },
      })
    ).toThrow(/ORY_UNSAFE_PRODUCTION_VALUE|kratos.*development/i);

    expect(() =>
      mapOryConfigToHelmValues({
        ...externalConfig,
        dependencySources: {
          ...externalConfig.dependencySources,
          kratos: {
            ...externalConfig.dependencySources?.kratos,
            database: { dsn: { mode: 'managed', resourceName: 'identity-kratos-db' } },
          },
        },
        hydra: {
          ...externalConfig.hydra,
          values: { hydra: { dev: true } },
        },
      })
    ).toThrow(/ORY_UNSAFE_PRODUCTION_VALUE|hydra.*dev/i);
  });

  it('Require both Kratos cookie and cipher Secret sources', () => {
    const result = validateOryConfig({
      ...externalConfig,
      kratos: {
        ...externalConfig.kratos,
        secrets: { cookie: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } } },
      },
      dependencySources: {
        ...externalConfig.dependencySources,
        kratos: {
          ...externalConfig.dependencySources?.kratos,
          secrets: {
            cookie: {
              mode: 'external',
              value: { secretRef: { name: 'ory-secrets', key: 'kratos-cookie' } },
            },
          },
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'kratos.secrets.cipher' })
    );
  });

  it('Merge typed values before customValues and validate final unsafe-value safety after all merges', () => {
    expect(() =>
      mapOryConfigToHelmValues({
        ...externalConfig,
        hydra: {
          ...externalConfig.hydra,
          values: { replicaCount: 2, hydra: { dev: false } },
        },
        customValues: {
          hydra: { hydra: { dev: true } },
        },
      })
    ).toThrow(/ORY_UNSAFE_PRODUCTION_VALUE|dev/i);
  });

  it('Preserve required generated env when merging nested chart values', () => {
    const values = mapOryConfigToHelmValues({
      ...externalConfig,
      hydra: {
        ...externalConfig.hydra,
        values: { deployment: { annotations: { owner: 'platform' }, extraEnv: [{ name: 'EXTRA', value: '1' }] } },
      },
      kratos: {
        ...externalConfig.kratos,
        values: { deployment: { annotations: { owner: 'identity' } } },
      },
    });

    expect(values.hydra.deployment?.annotations).toEqual({ owner: 'platform' });
    expect(values.hydra.deployment?.extraEnv).toContainEqual({
      name: 'DSN',
      valueFrom: { secretKeyRef: { name: 'ory-dsns', key: 'hydra' } },
    });
    expect(values.hydra.deployment?.extraEnv).toContainEqual({ name: 'EXTRA', value: '1' });
    expect(values.kratos.deployment?.extraEnv).toContainEqual({
      name: 'DSN',
      valueFrom: { secretKeyRef: { name: 'ory-dsns', key: 'kratos' } },
    });
  });

  it('Map explicit external DSN Secret references into chart environment values without leaking literals', () => {
    const values = mapOryConfigToHelmValues(externalConfig);
    const hydraExtraEnv = values.hydra.deployment?.extraEnv ?? [];
    const kratosExtraEnv = values.kratos.deployment?.extraEnv ?? [];
    const ketoExtraEnv = values.keto.deployment?.extraEnv ?? [];

    expect(hydraExtraEnv).toContainEqual({
      name: 'DSN',
      valueFrom: { secretKeyRef: { name: 'ory-dsns', key: 'hydra' } },
    });
    expect(kratosExtraEnv).toContainEqual({
      name: 'DSN',
      valueFrom: { secretKeyRef: { name: 'ory-dsns', key: 'kratos' } },
    });
    expect(ketoExtraEnv).toContainEqual({
      name: 'DSN',
      valueFrom: { secretKeyRef: { name: 'ory-dsns', key: 'keto' } },
    });
    expect(hydraExtraEnv).toContainEqual({
      name: 'SECRETS_SYSTEM',
      valueFrom: { secretKeyRef: { name: 'ory-secrets', key: 'hydra-system' } },
    });
    expect(kratosExtraEnv).toContainEqual({
      name: 'SECRETS_COOKIE',
      valueFrom: { secretKeyRef: { name: 'ory-secrets', key: 'kratos-cookie' } },
    });
    expect(values.hydra.hydra?.config?.dsn).toBeUndefined();
    expect(values.hydra.hydra?.config?.secrets?.system).toBeUndefined();
    expect(values.kratos.kratos?.config?.dsn).toBeUndefined();
    expect(values.kratos.kratos?.config?.secrets).toBeUndefined();
    expect(values.keto.keto?.config?.dsn).toBeUndefined();
    expect(JSON.stringify(values)).not.toContain('postgres://');
  });

  it('Allow explicit external literal value sources while still rejecting unsafe customValues literals', () => {
    const values = mapOryConfigToHelmValues({
      ...externalConfig,
      hydra: {
        ...externalConfig.hydra,
        dsn: { value: 'postgres://hydra.example.com:5432/hydra' },
        systemSecret: { value: 'hydra-system-secret' },
      },
      kratos: {
        ...externalConfig.kratos,
        dsn: { value: 'postgres://kratos.example.com:5432/kratos' },
        secrets: { cookie: { value: 'kratos-cookie-secret' } },
      },
      keto: {
        ...externalConfig.keto,
        dsn: { value: 'postgres://keto.example.com:5432/keto' },
      },
    });

    expect(values.hydra.hydra?.config?.dsn).toBe('postgres://hydra.example.com:5432/hydra');
    expect(values.kratos.kratos?.config?.secrets?.cookie).toBe('kratos-cookie-secret');
    expect(values.keto.keto?.config?.dsn).toBe('postgres://keto.example.com:5432/keto');
  });

  it('Map high-level global and resource convenience fields before typed values and customValues', () => {
    const values = mapOryConfigToHelmValues({
      ...externalConfig,
      global: { imageRegistry: 'registry.example.com', imagePullSecrets: ['registry-creds'] },
      hydra: {
        ...externalConfig.hydra,
        resources: { requests: { cpu: '100m', memory: '128Mi' } },
      },
      kratos: {
        ...externalConfig.kratos,
        resources: { requests: { cpu: '150m', memory: '256Mi' } },
      },
      keto: {
        ...externalConfig.keto,
        resources: { requests: { cpu: '50m', memory: '64Mi' } },
      },
      oathkeeper: {
        ...externalConfig.oathkeeper,
        resources: { requests: { cpu: '75m', memory: '96Mi' } },
      },
    });

    expect(values.hydra.global?.imageRegistry).toBe('registry.example.com');
    expect(values.kratos.imagePullSecrets).toEqual([{ name: 'registry-creds' }]);
    expect(values.hydra.deployment?.resources?.requests?.cpu).toBe('100m');
    expect(values.kratos.statefulSet?.resources?.requests?.memory).toBe('256Mi');
    expect(values.keto.deployment?.resources?.requests?.cpu).toBe('50m');
    expect(values.oathkeeper.deployment?.resources?.requests?.memory).toBe('96Mi');
  });

  it('Emit operational warnings without logging DSNs, secrets, or tokens', () => {
    const warnings = getOryHelmValueWarnings({
      ...externalConfig,
      hydra: {
        ...externalConfig.hydra,
        replicaCount: 1,
      },
    });

    expect(warnings.some((warning) => warning.path.includes('hydra.replicaCount'))).toBe(true);
    expect(warnings.every((warning) => !warning.message.includes('ory-secrets'))).toBe(true);
  });

  it('Expose health check contracts for all Ory services and Maester resources', () => {
    const checks = getOryHealthChecks(externalConfig);

    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'helmRepositoryReady',
        'hydraReady',
        'kratosReady',
        'ketoReady',
        'oathkeeperReady',
        'hydraMaesterReady',
        'oathkeeperMaesterReady',
      ])
    );
    expect(checks.every((check) => typeof check.healthy === 'boolean')).toBe(true);
  });

  it('Expose metrics signal contracts for ServiceMonitor and Maester monitoring configuration', () => {
    const signals = getOryMetricSignals({
      ...externalConfig,
      hydra: { ...externalConfig.hydra, serviceMonitor: { enabled: true } },
      maester: {
        hydra: { enabled: true, singleNamespaceMode: true, serviceMonitor: { enabled: true } },
        oathkeeper: { enabled: true, singleNamespaceMode: true },
      },
    });

    expect(signals).toContainEqual(
      expect.objectContaining({ name: 'serviceMonitorEnabled', component: 'hydra', enabled: true })
    );
    expect(signals).toContainEqual(
      expect.objectContaining({ name: 'maesterMetricsConfigured', component: 'hydra', enabled: true })
    );
  });
});
