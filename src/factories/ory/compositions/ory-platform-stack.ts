import { type Type, type } from 'arktype';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { cluster } from '../../cnpg/resources/cluster.js';
import { secret } from '../../kubernetes/config/secret.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { customResource } from '../../kubernetes/extensions/custom-resource.js';
import { simple } from '../../simple/index.js';
import {
  type OryDependencySource,
  type OryDependencySourceConfig,
  type OryEndpointStatus,
  type OryIdentityStackEndpointStatus,
  type OryPlatformStackConfig,
  OryPlatformStackConfigSchema,
  OryPlatformStackStatusSchema,
  type OryValueSource,
} from '../types.js';
import { oryIdentityStack } from './ory-identity-stack.js';
import { oathkeeperRule } from '../resources/oathkeeper-rule.js';

const apisixRouteSpecSchema = type({
  'http?': 'object[]',
});

function dependencySources(config: {
  hydraDatabaseSecretName: string;
  hydraSystemSecretName: string;
  kratosDatabaseSecretName: string;
  kratosSecretsName: string;
  ketoDatabaseSecretName: string;
  oathkeeperSecretsName: string;
  hydraPublicRouteName: string;
  hydraPublicRouteUrl: string;
  kratosPublicRouteName: string;
  kratosPublicRouteUrl: string;
  oathkeeperProxyRouteName: string;
  oathkeeperProxyRouteUrl: string;
  oathkeeperApiRouteName: string;
  oathkeeperApiRouteUrl: string;
  sampleUpstreamName: string;
  courierSesName: string;
}): OryDependencySourceConfig {
  return {
    hydra: {
      database: { dsn: { mode: 'managed', resourceName: config.hydraDatabaseSecretName, secretKey: 'uri' } },
      systemSecret: { mode: 'managed', secretName: config.hydraSystemSecretName, secretKey: 'system' },
      issuerUrl: { url: { mode: 'managed', resourceName: config.hydraPublicRouteName, url: config.hydraPublicRouteUrl } },
      loginUrl: { url: { mode: 'managed', resourceName: config.kratosPublicRouteName, url: config.kratosPublicRouteUrl } },
      consentUrl: { url: { mode: 'managed', resourceName: config.kratosPublicRouteName, url: config.kratosPublicRouteUrl } },
      logoutUrl: { url: { mode: 'managed', resourceName: config.kratosPublicRouteName, url: config.kratosPublicRouteUrl } },
    },
    kratos: {
      database: { dsn: { mode: 'managed', resourceName: config.kratosDatabaseSecretName, secretKey: 'uri' } },
      publicBaseUrl: { url: { mode: 'managed', resourceName: config.kratosPublicRouteName, url: config.kratosPublicRouteUrl } },
      browserBaseUrl: { url: { mode: 'managed', resourceName: config.kratosPublicRouteName, url: config.kratosPublicRouteUrl } },
      secrets: {
        cookie: { mode: 'managed', secretName: config.kratosSecretsName, secretKey: 'cookie' },
        cipher: { mode: 'managed', secretName: config.kratosSecretsName, secretKey: 'cipher' },
      },
    },
    keto: {
      database: { dsn: { mode: 'managed', resourceName: config.ketoDatabaseSecretName, secretKey: 'uri' } },
    },
    oathkeeper: {
      proxyRoute: { url: { mode: 'managed', resourceName: config.oathkeeperProxyRouteName, url: config.oathkeeperProxyRouteUrl } },
      apiRoute: { url: { mode: 'managed', resourceName: config.oathkeeperApiRouteName, url: config.oathkeeperApiRouteUrl } },
      upstream: { url: { mode: 'managed', resourceName: config.sampleUpstreamName } },
      mutatorIdTokenJwks: { mode: 'managed', secretName: config.oathkeeperSecretsName, secretKey: 'jwks' },
    },
  };
}

function managedDependencySources(
  config: Parameters<typeof dependencySources>[0],
  managed: OryPlatformStackConfig['managed']
): OryDependencySourceConfig {
  const defaults = dependencySources(config);
  const manageDatabases = managed?.databases !== false;
  const manageSecrets = managed?.secrets !== false;
  const manageRoutes = managed?.routes !== false;
  const manageSampleUpstream = managed?.sampleUpstream !== false;
  const hydra: NonNullable<OryDependencySourceConfig['hydra']> = {};
  const kratos: NonNullable<OryDependencySourceConfig['kratos']> = {};
  const keto: NonNullable<OryDependencySourceConfig['keto']> = {};
  const oathkeeper: NonNullable<OryDependencySourceConfig['oathkeeper']> = {};

  if (manageDatabases) {
    if (defaults.hydra?.database) hydra.database = defaults.hydra.database;
    if (defaults.kratos?.database) kratos.database = defaults.kratos.database;
    if (defaults.keto?.database) keto.database = defaults.keto.database;
  }
  if (manageSecrets) {
    if (defaults.hydra?.systemSecret) hydra.systemSecret = defaults.hydra.systemSecret;
    if (defaults.kratos?.secrets) kratos.secrets = defaults.kratos.secrets;
    if (defaults.oathkeeper?.mutatorIdTokenJwks) {
      oathkeeper.mutatorIdTokenJwks = defaults.oathkeeper.mutatorIdTokenJwks;
    }
  }
  if (manageRoutes) {
    if (defaults.hydra?.issuerUrl) hydra.issuerUrl = defaults.hydra.issuerUrl;
    if (defaults.hydra?.loginUrl) hydra.loginUrl = defaults.hydra.loginUrl;
    if (defaults.hydra?.consentUrl) hydra.consentUrl = defaults.hydra.consentUrl;
    if (defaults.hydra?.logoutUrl) hydra.logoutUrl = defaults.hydra.logoutUrl;
    if (defaults.kratos?.publicBaseUrl) kratos.publicBaseUrl = defaults.kratos.publicBaseUrl;
    if (defaults.kratos?.browserBaseUrl) kratos.browserBaseUrl = defaults.kratos.browserBaseUrl;
    if (defaults.oathkeeper?.proxyRoute) oathkeeper.proxyRoute = defaults.oathkeeper.proxyRoute;
    if (defaults.oathkeeper?.apiRoute) oathkeeper.apiRoute = defaults.oathkeeper.apiRoute;
  }
  if (manageSampleUpstream) {
    if (defaults.oathkeeper?.upstream) oathkeeper.upstream = defaults.oathkeeper.upstream;
  }

  return {
    hydra,
    kratos,
    keto,
    oathkeeper,
    ...(managed?.courierSes ? { courier: { mode: 'managed' as const, resourceName: config.courierSesName } } : {}),
  };
}

function apisixRoute(
  id: string,
  name: string,
  namespace: string,
  host: string,
  serviceName: string,
  servicePort: number
) {
  return customResource<{ http?: object[] }, Record<string, never>>(
    { apiVersion: 'apisix.apache.org/v2', kind: 'ApisixRoute', spec: apisixRouteSpecSchema },
    {
      id,
      metadata: { name, namespace },
      spec: {
        http: [
          {
            name,
            match: { hosts: [host], paths: ['/*'] },
            backends: [{ serviceName, servicePort }],
          },
        ],
      },
    }
  );
}

function mergeDependencySources(
  managed: OryDependencySourceConfig,
  explicit: OryDependencySourceConfig | undefined
): OryDependencySourceConfig {
  const hydra = explicit?.hydra;
  const kratos = explicit?.kratos;
  const keto = explicit?.keto;
  const oathkeeper = explicit?.oathkeeper;

  return defined({
    hydra: defined({
      database: defined({
        dsn: mergeDependencySource(managed.hydra?.database?.dsn, hydra?.database?.dsn),
        databaseName: hydra?.database?.databaseName ?? managed.hydra?.database?.databaseName,
      }),
      systemSecret: mergeDependencySource(managed.hydra?.systemSecret, hydra?.systemSecret),
      issuerUrl: defined({
        url: mergeDependencySource(managed.hydra?.issuerUrl?.url, hydra?.issuerUrl?.url),
      }),
      loginUrl: defined({
        url: mergeDependencySource(managed.hydra?.loginUrl?.url, hydra?.loginUrl?.url),
      }),
      consentUrl: defined({
        url: mergeDependencySource(managed.hydra?.consentUrl?.url, hydra?.consentUrl?.url),
      }),
      logoutUrl: defined({
        url: mergeDependencySource(managed.hydra?.logoutUrl?.url, hydra?.logoutUrl?.url),
      }),
    }),
    kratos: defined({
      database: defined({
        dsn: mergeDependencySource(managed.kratos?.database?.dsn, kratos?.database?.dsn),
        databaseName: kratos?.database?.databaseName ?? managed.kratos?.database?.databaseName,
      }),
      publicBaseUrl: defined({
        url: mergeDependencySource(managed.kratos?.publicBaseUrl?.url, kratos?.publicBaseUrl?.url),
      }),
      browserBaseUrl: defined({
        url: mergeDependencySource(managed.kratos?.browserBaseUrl?.url, kratos?.browserBaseUrl?.url),
      }),
      secrets: defined({
        cookie: mergeDependencySource(managed.kratos?.secrets?.cookie, kratos?.secrets?.cookie),
        cipher: mergeDependencySource(managed.kratos?.secrets?.cipher, kratos?.secrets?.cipher),
      }),
      courier: mergeDependencySource(managed.kratos?.courier, kratos?.courier),
      identitySchemas: mergeDependencySource(
        managed.kratos?.identitySchemas,
        kratos?.identitySchemas
      ),
    }),
    keto: defined({
      database: defined({
        dsn: mergeDependencySource(managed.keto?.database?.dsn, keto?.database?.dsn),
        databaseName: keto?.database?.databaseName ?? managed.keto?.database?.databaseName,
      }),
    }),
    oathkeeper: defined({
      proxyRoute: defined({
        url: mergeDependencySource(managed.oathkeeper?.proxyRoute?.url, oathkeeper?.proxyRoute?.url),
      }),
      apiRoute: defined({
        url: mergeDependencySource(managed.oathkeeper?.apiRoute?.url, oathkeeper?.apiRoute?.url),
      }),
      upstream: defined({
        url: mergeDependencySource(managed.oathkeeper?.upstream?.url, oathkeeper?.upstream?.url),
      }),
      mutatorIdTokenJwks:
        mergeDependencySource(managed.oathkeeper?.mutatorIdTokenJwks, oathkeeper?.mutatorIdTokenJwks),
    }),
    courier: mergeDependencySource(managed.courier, explicit?.courier),
  });
}

function defined<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function mergeDependencySource(
  defaults: OryDependencySource | undefined,
  explicit: OryDependencySource | undefined
): OryDependencySource | undefined {
  if (!defaults) return explicit;
  if (!explicit) return defaults;
  const explicitValue = (explicit as { value?: OryValueSource }).value;
  const defaultManaged = defaults.mode === 'managed' ? defaults : undefined;
  const explicitManaged = explicit.mode === 'managed' ? explicit : undefined;

  return defined({
    mode: explicit.mode ?? defaults.mode,
    value: explicitValue,
    url: explicit.url ?? defaults.url,
    resourceName: explicit.resourceName ?? defaults.resourceName,
    namespace: explicitManaged?.namespace ?? defaultManaged?.namespace,
    secretName: explicitManaged?.secretName ?? defaultManaged?.secretName,
    secretKey: explicitManaged?.secretKey ?? defaultManaged?.secretKey,
  }) as OryDependencySource;
}

function mode(value: { mode: 'external' | 'managed' } | undefined): 'external' | 'managed' {
  return value?.mode ?? 'external';
}

function routeEndpoint(url: string, port = 80): OryEndpointStatus {
  const parsed = new URL(url);
  const parsedPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : port;
  return {
    url,
    scheme: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port: parsedPort,
  };
}

function nestedEndpoint(endpoint: OryEndpointStatus): OryEndpointStatus {
  return {
    url: endpoint.url,
    scheme: endpoint.scheme,
    host: endpoint.host,
    ...(endpoint.clusterIP ? { clusterIP: endpoint.clusterIP } : {}),
    ...(endpoint.port ? { port: endpoint.port } : {}),
  };
}

function platformEndpoints(
  oryEndpoints: OryIdentityStackEndpointStatus,
  emitRouteResources: boolean
): OryIdentityStackEndpointStatus {
  return {
    hydraPublic: emitRouteResources
      ? routeEndpoint('http://hydra.localhost')
      : nestedEndpoint(oryEndpoints.hydraPublic),
    hydraAdmin: nestedEndpoint(oryEndpoints.hydraAdmin),
    kratosPublic: emitRouteResources
      ? routeEndpoint('http://kratos.localhost')
      : nestedEndpoint(oryEndpoints.kratosPublic),
    kratosAdmin: nestedEndpoint(oryEndpoints.kratosAdmin),
    ketoRead: nestedEndpoint(oryEndpoints.ketoRead),
    ketoWrite: nestedEndpoint(oryEndpoints.ketoWrite),
    oathkeeperProxy: emitRouteResources
      ? routeEndpoint('http://identity.localhost', 4455)
      : nestedEndpoint(oryEndpoints.oathkeeperProxy),
    oathkeeperApi: emitRouteResources
      ? routeEndpoint('http://oathkeeper-api.localhost', 4456)
      : nestedEndpoint(oryEndpoints.oathkeeperApi),
  };
}

function isSchemaSpec(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __schemaProxyBasePath?: unknown }).__schemaProxyBasePath === 'spec'
  );
}

export const oryPlatformStack = kubernetesComposition(
  {
    name: 'ory-platform-stack',
    kind: 'OryPlatformStack',
    spec: OryPlatformStackConfigSchema as unknown as Type<OryPlatformStackConfig>,
    status: OryPlatformStackStatusSchema,
  },
  (spec: OryPlatformStackConfig) => {
    const namespaceName = spec.namespace ?? 'ory-system';
    const concreteSpec =
      !isSchemaSpec(spec) &&
      ![spec.name, spec.namespace, spec.managed, spec.dependencySources].some((value) =>
        isKubernetesRef(value)
      );
    const manageDatabases = spec.managed?.databases !== false;
    const manageSecrets = spec.managed?.secrets !== false;
    const manageRoutes = spec.managed?.routes !== false;
    const manageSampleUpstream = spec.managed?.sampleUpstream !== false;
    const emitRouteResources = manageRoutes && concreteSpec;
    let hydraDatabaseSecretName = `${spec.name}-hydra-db-app`;
    let kratosDatabaseSecretName = `${spec.name}-kratos-db-app`;
    let ketoDatabaseSecretName = `${spec.name}-keto-db-app`;
    let hydraSystemSecretName = `${spec.name}-hydra-secrets`;
    let kratosSecretsName = `${spec.name}-kratos-secrets`;
    let oathkeeperSecretsName = `${spec.name}-oathkeeper-secrets`;
    let sampleUpstreamName = `${spec.name}-sample-upstream`;

    if (spec.managed?.databases !== false) {
      cluster({
        id: 'hydraDatabase',
        name: `${spec.name}-hydra-db`,
        namespace: namespaceName,
        spec: {
          instances: 1,
          storage: { size: '1Gi' },
          bootstrap: { initdb: { database: 'hydra', owner: 'hydra' } },
        },
      });
      hydraDatabaseSecretName = `${spec.name}-hydra-db-app`;
      secret({
        id: 'hydraDsnSecret',
        metadata: { name: `${spec.name}-hydra-db`, namespace: namespaceName },
        type: 'Opaque',
        stringData: { dsn: `postgres://hydra@${spec.name}-hydra-db-rw.${namespaceName}.svc.cluster.local:5432/hydra` },
      });
      cluster({
        id: 'kratosDatabase',
        name: `${spec.name}-kratos-db`,
        namespace: namespaceName,
        spec: {
          instances: 1,
          storage: { size: '1Gi' },
          bootstrap: { initdb: { database: 'kratos', owner: 'kratos' } },
        },
      });
      kratosDatabaseSecretName = `${spec.name}-kratos-db-app`;
      secret({
        id: 'kratosDsnSecret',
        metadata: { name: `${spec.name}-kratos-db`, namespace: namespaceName },
        type: 'Opaque',
        stringData: { dsn: `postgres://kratos@${spec.name}-kratos-db-rw.${namespaceName}.svc.cluster.local:5432/kratos` },
      });
      cluster({
        id: 'ketoDatabase',
        name: `${spec.name}-keto-db`,
        namespace: namespaceName,
        spec: {
          instances: 1,
          storage: { size: '1Gi' },
          bootstrap: { initdb: { database: 'keto', owner: 'keto' } },
        },
      });
      ketoDatabaseSecretName = `${spec.name}-keto-db-app`;
      secret({
        id: 'ketoDsnSecret',
        metadata: { name: `${spec.name}-keto-db`, namespace: namespaceName },
        type: 'Opaque',
        stringData: { dsn: `postgres://keto@${spec.name}-keto-db-rw.${namespaceName}.svc.cluster.local:5432/keto` },
      });
    }

    if (spec.managed?.secrets !== false) {
      const hydraSystemSecret = secret({
        id: 'hydraSystemSecret',
        metadata: {
          name: `${spec.name}-hydra-secrets`,
          namespace: namespaceName,
          annotations: { 'typekro.dev/local-default': 'true' },
        },
        type: 'Opaque',
        stringData: { system: 'hydra-local-system-secret-000000' },
      });
      hydraSystemSecretName = hydraSystemSecret.metadata.name ?? hydraSystemSecretName;
      const kratosSecrets = secret({
        id: 'kratosSecrets',
        metadata: {
          name: `${spec.name}-kratos-secrets`,
          namespace: namespaceName,
          annotations: { 'typekro.dev/local-default': 'true' },
        },
        type: 'Opaque',
        stringData: {
          cookie: 'kratos-local-cookie-secret-00000',
          cipher: 'kratos-local-cipher-secret-00010',
        },
      });
      kratosSecretsName = kratosSecrets.metadata.name ?? kratosSecretsName;
      const oathkeeperSecrets = secret({
        id: 'oathkeeperSecrets',
        metadata: {
          name: `${spec.name}-oathkeeper-secrets`,
          namespace: namespaceName,
          annotations: { 'typekro.dev/local-default': 'true' },
        },
        type: 'Opaque',
        stringData: { jwks: '{"keys":[]}' },
      });
      oathkeeperSecretsName = oathkeeperSecrets.metadata.name ?? oathkeeperSecretsName;
    }

    if (spec.managed?.sampleUpstream !== false) {
      simple.Deployment({
        id: 'sampleUpstream',
        name: `${spec.name}-sample-upstream`,
        namespace: namespaceName,
        image: 'nginx:1.27-alpine',
        replicas: 1,
        ports: [{ containerPort: 80 }],
      });
      const sampleUpstreamService = simple.Service({
        id: 'sampleUpstreamService',
        name: `${spec.name}-sample-upstream`,
        namespace: namespaceName,
        selector: { app: `${spec.name}-sample-upstream` },
        ports: [{ port: 80, targetPort: 80 }],
      });
      sampleUpstreamName = sampleUpstreamService.metadata.name ?? sampleUpstreamName;
    }

    const managedSources = managedDependencySources(
      {
        hydraDatabaseSecretName,
        hydraSystemSecretName,
        kratosDatabaseSecretName,
        kratosSecretsName,
        ketoDatabaseSecretName,
        oathkeeperSecretsName,
        hydraPublicRouteName: `${spec.name}-hydra-public-route`,
        hydraPublicRouteUrl: 'http://hydra.localhost',
        kratosPublicRouteName: `${spec.name}-kratos-public-route`,
        kratosPublicRouteUrl: 'http://kratos.localhost',
        oathkeeperProxyRouteName: `${spec.name}-oathkeeper-proxy-route`,
        oathkeeperProxyRouteUrl: 'http://identity.localhost',
        oathkeeperApiRouteName: `${spec.name}-oathkeeper-api-route`,
        oathkeeperApiRouteUrl: 'http://oathkeeper-api.localhost',
        sampleUpstreamName,
        courierSesName: `${spec.name}-courier-ses`,
      },
      { ...spec.managed, routes: emitRouteResources }
    );
    const resolvedSources = mergeDependencySources(managedSources, spec.dependencySources);

    const ory = oryIdentityStack({
      ...spec,
      namespace: namespaceName,
      dependencySources: resolvedSources,
    } as Parameters<typeof oryIdentityStack>[0]);
    const oryStatus = {
      ready: ory.status.ready,
      phase: Cel.expr<'Ready' | 'Installing'>(ory.status.ready, ' ? "Ready" : "Installing"'),
      components: {
        hydra: ory.status.components.hydra,
        kratos: ory.status.components.kratos,
        keto: ory.status.components.keto,
        oathkeeper: ory.status.components.oathkeeper,
      },
      maester: {
        hydra: ory.status.maester.hydra,
        oathkeeper: ory.status.maester.oathkeeper,
      },
      endpoints: platformEndpoints(ory.status.endpoints, emitRouteResources),
      version: Cel.template('%s', spec.version ?? '0.62.0'),
    };

    configMap({
      id: 'oryPlatformStackMetadata',
      metadata: { name: `${spec.name}-platform-metadata`, namespace: namespaceName },
      data: {
        'oryIdentityStack': spec.name,
        'dependencies': 'managed-or-external',
      },
    });

    if (emitRouteResources) {
      oathkeeperRule({
        id: 'sampleUpstreamOathkeeperRule',
        name: `${spec.name}-sample-upstream`,
        namespace: namespaceName,
        spec: {
          match: { methods: ['GET'], url: 'http://identity.localhost/<.*>' },
          upstream: { url: `http://${sampleUpstreamName}.${namespaceName}.svc.cluster.local` },
          authenticators: [{ handler: 'anonymous' }],
          authorizer: { handler: 'allow' },
          mutators: [{ handler: 'noop' }],
        },
      });
      apisixRoute(
        'hydraPublicApisixRoute',
        `${spec.name}-hydra-public-route`,
        namespaceName,
        'hydra.localhost',
        ory.status.endpoints.hydraPublic.serviceName ?? `${spec.name}-hydra-public`,
        4444
      );
      apisixRoute(
        'kratosPublicApisixRoute',
        `${spec.name}-kratos-public-route`,
        namespaceName,
        'kratos.localhost',
        ory.status.endpoints.kratosPublic.serviceName ?? `${spec.name}-kratos-public`,
        4433
      );
      apisixRoute(
        'oathkeeperProxyApisixRoute',
        `${spec.name}-oathkeeper-proxy-route`,
        namespaceName,
        'identity.localhost',
        ory.status.endpoints.oathkeeperProxy.serviceName ?? `${spec.name}-oathkeeper-proxy`,
        4455
      );
      apisixRoute(
        'oathkeeperApiApisixRoute',
        `${spec.name}-oathkeeper-api-route`,
        namespaceName,
        'oathkeeper-api.localhost',
        ory.status.endpoints.oathkeeperApi.serviceName ?? `${spec.name}-oathkeeper-api`,
        4456
      );
    }

    return {
      ready: ory.status.ready,
      phase: Cel.expr<'Ready' | 'Installing'>(ory.status.ready, ' ? "Ready" : "Installing"'),
      infrastructure: {
        databases: manageDatabases,
        secrets: manageSecrets,
        routes: emitRouteResources,
        upstream: manageSampleUpstream,
        courier: spec.managed?.courierSes ?? false,
      },
      dependencies: {
        hydraDatabase: mode(resolvedSources.hydra?.database?.dsn),
        kratosDatabase: mode(resolvedSources.kratos?.database?.dsn),
        ketoDatabase: mode(resolvedSources.keto?.database?.dsn),
        secrets: mode(resolvedSources.hydra?.systemSecret),
        routes: mode(resolvedSources.oathkeeper?.proxyRoute?.url),
        upstream: mode(resolvedSources.oathkeeper?.upstream?.url),
        courier: mode(resolvedSources.courier),
      },
      ory: oryStatus,
      endpoints: oryStatus.endpoints,
    };
  }
);
