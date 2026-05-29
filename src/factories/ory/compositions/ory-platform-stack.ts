import { type Type, type } from 'arktype';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { cluster } from '../../cnpg/resources/cluster.js';
import { secret } from '../../kubernetes/config/secret.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { customResource } from '../../kubernetes/extensions/custom-resource.js';
import { simple } from '../../simple/index.js';
import {
  type OryDependencySourceConfig,
  type OryPlatformStackConfig,
  OryPlatformStackConfigSchema,
  OryPlatformStackStatusSchema,
} from '../types.js';
import { oryIdentityStack } from './ory-identity-stack.js';
import { oathkeeperRule } from '../resources/oathkeeper-rule.js';

const apisixRouteSpecSchema = type({
  'http?': 'object[]',
});

function dependencySources(name: string): OryDependencySourceConfig {
  return {
    hydra: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-hydra-db-app`, secretKey: 'uri' } },
      systemSecret: { mode: 'managed', secretName: `${name}-hydra-secrets`, secretKey: 'system' },
      issuerUrl: { url: { mode: 'managed', resourceName: `${name}-hydra-public-route` } },
      loginUrl: { url: { mode: 'managed', resourceName: `${name}-kratos-public-route` } },
      consentUrl: { url: { mode: 'managed', resourceName: `${name}-kratos-public-route` } },
      logoutUrl: { url: { mode: 'managed', resourceName: `${name}-kratos-public-route` } },
    },
    kratos: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-kratos-db-app`, secretKey: 'uri' } },
      publicBaseUrl: { url: { mode: 'managed', resourceName: `${name}-kratos-public-route` } },
      browserBaseUrl: { url: { mode: 'managed', resourceName: `${name}-kratos-public-route` } },
      secrets: {
        cookie: { mode: 'managed', secretName: `${name}-kratos-secrets`, secretKey: 'cookie' },
        cipher: { mode: 'managed', secretName: `${name}-kratos-secrets`, secretKey: 'cipher' },
      },
    },
    keto: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-keto-db-app`, secretKey: 'uri' } },
    },
    oathkeeper: {
      proxyRoute: { url: { mode: 'managed', resourceName: `${name}-oathkeeper-proxy-route` } },
      apiRoute: { url: { mode: 'managed', resourceName: `${name}-oathkeeper-api-route` } },
      upstream: { url: { mode: 'managed', resourceName: `${name}-sample-upstream` } },
      mutatorIdTokenJwks: { mode: 'managed', secretName: `${name}-oathkeeper-secrets`, secretKey: 'jwks' },
    },
  };
}

function managedDependencySources(
  name: string,
  managed: OryPlatformStackConfig['managed']
): OryDependencySourceConfig {
  const defaults = dependencySources(name);
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
    ...(managed?.courierSes ? { courier: { mode: 'managed' as const, resourceName: `${name}-courier-ses` } } : {}),
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
  return {
    ...managed,
    ...explicit,
    hydra: { ...managed.hydra, ...explicit?.hydra },
    kratos: {
      ...managed.kratos,
      ...explicit?.kratos,
      secrets: { ...managed.kratos?.secrets, ...explicit?.kratos?.secrets },
    },
    keto: { ...managed.keto, ...explicit?.keto },
    oathkeeper: { ...managed.oathkeeper, ...explicit?.oathkeeper },
  };
}

function mode(value: { mode: 'external' | 'managed' } | undefined): 'external' | 'managed' {
  return value?.mode ?? 'external';
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
    const manageDatabases = spec.managed?.databases !== false;
    const manageSecrets = spec.managed?.secrets !== false;
    const manageRoutes = spec.managed?.routes !== false;
    const manageSampleUpstream = spec.managed?.sampleUpstream !== false;
    const managedSources = managedDependencySources(spec.name, spec.managed);
    const resolvedSources = mergeDependencySources(managedSources, spec.dependencySources);

    if (manageDatabases) {
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
      secret({
        id: 'ketoDsnSecret',
        metadata: { name: `${spec.name}-keto-db`, namespace: namespaceName },
        type: 'Opaque',
        stringData: { dsn: `postgres://keto@${spec.name}-keto-db-rw.${namespaceName}.svc.cluster.local:5432/keto` },
      });
    }

    if (manageSecrets) {
      secret({
        id: 'hydraSystemSecret',
        metadata: {
          name: `${spec.name}-hydra-secrets`,
          namespace: namespaceName,
          annotations: { 'typekro.dev/local-default': 'true' },
        },
        type: 'Opaque',
        stringData: { system: 'hydra-local-system-secret-000000' },
      });
      secret({
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
      secret({
        id: 'oathkeeperSecrets',
        metadata: {
          name: `${spec.name}-oathkeeper-secrets`,
          namespace: namespaceName,
          annotations: { 'typekro.dev/local-default': 'true' },
        },
        type: 'Opaque',
        stringData: { jwks: '{"keys":[]}' },
      });
    }

    if (manageSampleUpstream) {
      simple.Deployment({
        id: 'sampleUpstream',
        name: `${spec.name}-sample-upstream`,
        namespace: namespaceName,
        image: 'nginx:1.27-alpine',
        replicas: 1,
        ports: [{ containerPort: 80 }],
      });
      simple.Service({
        id: 'sampleUpstreamService',
        name: `${spec.name}-sample-upstream`,
        namespace: namespaceName,
        selector: { app: `${spec.name}-sample-upstream` },
        ports: [{ port: 80, targetPort: 80 }],
      });
    }

    const ory = oryIdentityStack({
      ...spec,
      namespace: namespaceName,
      dependencySources: resolvedSources,
    } as Parameters<typeof oryIdentityStack>[0]);

    configMap({
      id: 'oryPlatformStackMetadata',
      metadata: { name: `${spec.name}-platform-metadata`, namespace: namespaceName },
      data: {
        'oryIdentityStack': spec.name,
        'dependencies': 'managed-or-external',
      },
    });

    if (manageRoutes) {
      oathkeeperRule({
        id: 'sampleUpstreamOathkeeperRule',
        name: `${spec.name}-sample-upstream`,
        namespace: namespaceName,
        spec: {
          match: { methods: ['GET'], url: 'http://identity.localhost/<.*>' },
          upstream: { url: `http://${spec.name}-sample-upstream.${namespaceName}.svc.cluster.local` },
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
        `${spec.name}-hydra-public`,
        80
      );
      apisixRoute(
        'kratosPublicApisixRoute',
        `${spec.name}-kratos-public-route`,
        namespaceName,
        'kratos.localhost',
        `${spec.name}-kratos-public`,
        80
      );
      apisixRoute(
        'oathkeeperProxyApisixRoute',
        `${spec.name}-oathkeeper-proxy-route`,
        namespaceName,
        'identity.localhost',
        `${spec.name}-oathkeeper-proxy`,
        4455
      );
      apisixRoute(
        'oathkeeperApiApisixRoute',
        `${spec.name}-oathkeeper-api-route`,
        namespaceName,
        'oathkeeper-api.localhost',
        `${spec.name}-oathkeeper-api`,
        4456
      );
    }

    return {
      ready: ory.status.ready,
      phase: Cel.expr<'Ready' | 'Installing'>(ory.status.ready, ' ? "Ready" : "Installing"'),
      infrastructure: {
        databases: manageDatabases,
        secrets: manageSecrets,
        routes: manageRoutes,
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
      ory: ory.status,
      endpoints: ory.status.endpoints,
    };
  }
);
