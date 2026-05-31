import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { externalRef } from '../../../core/references/external-refs.js';
import { Cel } from '../../../core/references/cel.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  hydraHelmRelease,
  ketoHelmRelease,
  kratosHelmRelease,
  oathkeeperHelmRelease,
  ORY_CHART_VERSION,
  oryHelmRepository,
} from '../resources/helm.js';
import { oauth2Client } from '../resources/oauth2-client.js';
import { oathkeeperRule } from '../resources/oathkeeper-rule.js';
import {
  type OryDependencySource,
  type OryEndpointStatus,
  type OryIdentityStackConfig,
  OryIdentityStackConfigSchema,
  OryIdentityStackStatusSchema,
  type OryValueSource,
} from '../types.js';
import { mapOryConfigToHelmValues } from '../utils/helm-values-mapper.js';

interface ObservedServiceSpec {
  clusterIP?: string;
  ports: [{ port: number }, ...Array<{ port: number }>];
}

interface ObservedServiceStatus {
  loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> };
}

function readyCondition(conditions: unknown): boolean {
  return Cel.expr<boolean>(conditions, '.exists(c, c.type == "Ready" && c.status == "True")');
}

function withMaesterSubchartValues<T extends object>(
  values: T,
  key: string,
  maesterValues: object
): T {
  return { ...values, [key]: maesterValues };
}

function oathkeeperProbeValues(): Record<string, unknown> {
  const aliveProbe = {
    httpGet: {
      httpHeaders: [{ name: 'Host', value: '127.0.0.1' }],
      path: '/health/alive',
      port: 'http-api',
      scheme: 'HTTP',
    },
    failureThreshold: 5,
    periodSeconds: 10,
    successThreshold: 1,
    timeoutSeconds: 2,
  };

  return {
    deployment: {
      customReadinessProbe: aliveProbe,
      customStartupProbe: aliveProbe,
    },
    oathkeeper: { managedAccessRules: false },
  };
}

function serviceEndpoint(
  service: ReturnType<typeof externalRef<ObservedServiceSpec, ObservedServiceStatus>>,
  namespaceName: string,
  scheme = 'http'
): OryEndpointStatus {
  const serviceName = service.metadata.name;
  const serviceNamespace = service.metadata.namespace ?? namespaceName;
  const clusterIP = service.spec.clusterIP;
  const port = service.spec.ports[0]?.port;
  const hasConcreteServiceAddress =
    !isKubernetesRef(serviceName) && !isKubernetesRef(serviceNamespace);
  const host = hasConcreteServiceAddress
    ? `${serviceName}.${serviceNamespace}.svc.cluster.local`
    : clusterIP;
  return {
    url: `${scheme}://${clusterIP}:${port}`,
    scheme,
    host,
    ...(port ? { port } : {}),
    ...(clusterIP ? { clusterIP } : {}),
    ...(hasConcreteServiceAddress && serviceName ? { serviceName } : {}),
    ...(hasConcreteServiceAddress && serviceNamespace ? { namespace: serviceNamespace } : {}),
  };
}

function omitCustomValuesForGraph(config: OryIdentityStackConfig): OryIdentityStackConfig {
  const {
    customValues: _customValues,
    global: _global,
    hydra,
    kratos,
    keto,
    oathkeeper,
    maester,
    ...rest
  } = config;
  const {
    customValues: _hydraCustomValues,
    values: _hydraValues,
    ...hydraRest
  } = hydra ?? {};
  const { customValues: _kratosCustomValues, values: _kratosValues, ...kratosRest } = kratos ?? {};
  const {
    customValues: _ketoCustomValues,
    values: _ketoValues,
    ...ketoRest
  } = keto ?? {};
  const {
    customValues: _oathkeeperCustomValues,
    values: _oathkeeperValues,
    ...oathkeeperRest
  } = oathkeeper ?? {};
  const {
    hydraValues: _hydraMaesterValues,
    oathkeeperValues: _oathkeeperMaesterValues,
    ...maesterRest
  } = maester ?? {};

  return {
    ...rest,
    ...(hydra ? { hydra: hydraRest } : {}),
    ...(kratos ? { kratos: kratosRest } : {}),
    ...(keto ? { keto: ketoRest } : {}),
    ...(oathkeeper ? { oathkeeper: oathkeeperRest } : {}),
    ...(maester ? { maester: maesterRest } : {}),
  };
}

function defaultManagedDependencySources(name: string): OryIdentityStackConfig['dependencySources'] {
  return {
    hydra: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-hydra-db-app`, secretKey: 'uri' } },
      systemSecret: { mode: 'managed', secretName: `${name}-hydra-secrets`, secretKey: 'system' },
    },
    kratos: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-kratos-db-app`, secretKey: 'uri' } },
      secrets: {
        cookie: { mode: 'managed', secretName: `${name}-kratos-secrets`, secretKey: 'cookie' },
        cipher: { mode: 'managed', secretName: `${name}-kratos-secrets`, secretKey: 'cipher' },
      },
    },
    keto: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-keto-db-app`, secretKey: 'uri' } },
    },
    oathkeeper: {
      mutatorIdTokenJwks: {
        mode: 'managed',
        secretName: `${name}-oathkeeper-secrets`,
        secretKey: 'jwks',
      },
    },
  };
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

function mergeDependencySourceDefaults(
  defaults: NonNullable<OryIdentityStackConfig['dependencySources']>,
  explicit: OryIdentityStackConfig['dependencySources']
): OryIdentityStackConfig['dependencySources'] {
  const hydra = explicit?.hydra;
  const kratos = explicit?.kratos;
  const keto = explicit?.keto;
  const oathkeeper = explicit?.oathkeeper;

  return defined({
    hydra: defined({
      database: defined({
        dsn: mergeDependencySource(defaults.hydra?.database?.dsn, hydra?.database?.dsn),
        databaseName: hydra?.database?.databaseName ?? defaults.hydra?.database?.databaseName,
      }),
      systemSecret: mergeDependencySource(defaults.hydra?.systemSecret, hydra?.systemSecret),
      issuerUrl: defined({
        url: mergeDependencySource(defaults.hydra?.issuerUrl?.url, hydra?.issuerUrl?.url),
      }),
      loginUrl: defined({
        url: mergeDependencySource(defaults.hydra?.loginUrl?.url, hydra?.loginUrl?.url),
      }),
      consentUrl: defined({
        url: mergeDependencySource(defaults.hydra?.consentUrl?.url, hydra?.consentUrl?.url),
      }),
      logoutUrl: defined({
        url: mergeDependencySource(defaults.hydra?.logoutUrl?.url, hydra?.logoutUrl?.url),
      }),
    }),
    kratos: defined({
      database: defined({
        dsn: mergeDependencySource(defaults.kratos?.database?.dsn, kratos?.database?.dsn),
        databaseName: kratos?.database?.databaseName ?? defaults.kratos?.database?.databaseName,
      }),
      publicBaseUrl: defined({
        url: mergeDependencySource(defaults.kratos?.publicBaseUrl?.url, kratos?.publicBaseUrl?.url),
      }),
      browserBaseUrl: defined({
        url: mergeDependencySource(defaults.kratos?.browserBaseUrl?.url, kratos?.browserBaseUrl?.url),
      }),
      secrets: defined({
        cookie: mergeDependencySource(defaults.kratos?.secrets?.cookie, kratos?.secrets?.cookie),
        cipher: mergeDependencySource(defaults.kratos?.secrets?.cipher, kratos?.secrets?.cipher),
      }),
      courier: mergeDependencySource(defaults.kratos?.courier, kratos?.courier),
    }),
    keto: defined({
      database: defined({
        dsn: mergeDependencySource(defaults.keto?.database?.dsn, keto?.database?.dsn),
        databaseName: keto?.database?.databaseName ?? defaults.keto?.database?.databaseName,
      }),
    }),
    oathkeeper: defined({
      proxyRoute: defined({
        url: mergeDependencySource(defaults.oathkeeper?.proxyRoute?.url, oathkeeper?.proxyRoute?.url),
      }),
      apiRoute: defined({
        url: mergeDependencySource(defaults.oathkeeper?.apiRoute?.url, oathkeeper?.apiRoute?.url),
      }),
      upstream: defined({
        url: mergeDependencySource(defaults.oathkeeper?.upstream?.url, oathkeeper?.upstream?.url),
      }),
      mutatorIdTokenJwks:
        mergeDependencySource(defaults.oathkeeper?.mutatorIdTokenJwks, oathkeeper?.mutatorIdTokenJwks),
    }),
    courier: mergeDependencySource(defaults.courier, explicit?.courier),
  });
}

function isSchemaSpec(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __schemaProxyBasePath?: unknown }).__schemaProxyBasePath === 'spec'
  );
}

/**
 * Production Ory identity stack composition.
 *
 * Creates the target namespace, official Ory Helm repository, Hydra/Kratos/Keto/Oathkeeper
 * HelmReleases, optional starter Maester resources, and status fields used by direct and KRO modes.
 */
export const oryIdentityStack = kubernetesComposition(
  {
    name: 'ory-identity-stack',
    kind: 'OryIdentityStack',
    spec: OryIdentityStackConfigSchema,
    status: OryIdentityStackStatusSchema,
  },
  (spec) => {
    const typedSpec = spec as unknown as OryIdentityStackConfig;
    const resolvedNamespace = typedSpec.namespace ?? 'ory-system';
    const resolvedVersion = typedSpec.version ?? ORY_CHART_VERSION;
    const concreteSpec =
      !isSchemaSpec(typedSpec) &&
      ![
        typedSpec.name,
        typedSpec.namespace,
        typedSpec.version,
        typedSpec.dependencySources,
      ].some((value) => isKubernetesRef(value));
    const graphSpec = omitCustomValuesForGraph(typedSpec);
    const graphFallbackSpec = graphSpec;
    const graphDependencySources = mergeDependencySourceDefaults(
      defaultManagedDependencySources(typedSpec.name) ?? {},
      graphFallbackSpec.dependencySources
    );
    let values = mapOryConfigToHelmValues({
      ...graphFallbackSpec,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      dependencySources: graphDependencySources,
    } as OryIdentityStackConfig);
    if (concreteSpec) {
      values = mapOryConfigToHelmValues({
        ...typedSpec,
        namespace: resolvedNamespace,
        version: resolvedVersion,
      });
    }

    if (concreteSpec) {
      namespace({
        id: 'oryNamespace',
        metadata: {
          name: resolvedNamespace,
          labels: {
            'app.kubernetes.io/name': 'ory-identity-stack',
            'app.kubernetes.io/instance': typedSpec.name,
            'app.kubernetes.io/version': resolvedVersion,
            'app.kubernetes.io/managed-by': 'typekro',
          },
        },
      });
    }

    const _oryHelmRepository = oryHelmRepository({
      id: 'oryHelmRepository',
      name: 'ory',
      namespace: resolvedNamespace,
    });

    const _oathkeeperRulesConfigMap = configMap({
      id: 'oathkeeperRulesConfigMap',
      metadata: {
        name: `${typedSpec.name}-oathkeeper-rules`,
        namespace: resolvedNamespace,
        labels: {
          'app.kubernetes.io/name': 'oathkeeper-rules',
          'app.kubernetes.io/instance': typedSpec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
      data: { 'access-rules.json': '[]' },
    });

    const hydra = hydraHelmRelease({
      id: 'hydraHelmRelease',
      name: `${typedSpec.name}-hydra`,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      repositoryName: 'ory',
      repositoryNamespace: resolvedNamespace,
      values: withMaesterSubchartValues(
        values.hydra,
        'hydra-maester',
        values.hydraMaester
      ),
    });

    const kratos = kratosHelmRelease({
      id: 'kratosHelmRelease',
      name: `${typedSpec.name}-kratos`,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      repositoryName: 'ory',
      repositoryNamespace: resolvedNamespace,
      values: values.kratos,
    });

    const keto = ketoHelmRelease({
      id: 'ketoHelmRelease',
      name: `${typedSpec.name}-keto`,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      repositoryName: 'ory',
      repositoryNamespace: resolvedNamespace,
      values: values.keto,
    });

    const oathkeeper = oathkeeperHelmRelease({
      id: 'oathkeeperHelmRelease',
      name: `${typedSpec.name}-oathkeeper`,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      repositoryName: 'ory',
      repositoryNamespace: resolvedNamespace,
      values: withMaesterSubchartValues(
        { ...values.oathkeeper, ...oathkeeperProbeValues() },
        'oathkeeper-maester',
        values.oathkeeperMaester
      ),
    });

    const starterClients = Array.isArray(typedSpec.resources?.oauth2Clients)
      ? typedSpec.resources.oauth2Clients
      : [];
    const starterRules = Array.isArray(typedSpec.resources?.oathkeeperRules)
      ? typedSpec.resources.oathkeeperRules
      : [];

    for (const client of starterClients) {
      oauth2Client({ ...client, namespace: client.namespace ?? resolvedNamespace });
    }

    for (const rule of starterRules) {
      oathkeeperRule({ ...rule, namespace: rule.namespace ?? resolvedNamespace });
    }

    const hydraReady = readyCondition(hydra.status.conditions);
    const kratosReady = readyCondition(kratos.status.conditions);
    const ketoReady = readyCondition(keto.status.conditions);
    const oathkeeperReady = readyCondition(oathkeeper.status.conditions);
    const allServicesReady = Cel.expr<boolean>(
      hydraReady,
      ' && ',
      kratosReady,
      ' && ',
      ketoReady,
      ' && ',
      oathkeeperReady
    );
    const hydraReleaseName = hydra.metadata.name ?? `${typedSpec.name}-hydra`;
    const kratosReleaseName = kratos.metadata.name ?? `${typedSpec.name}-kratos`;
    const ketoReleaseName = keto.metadata.name ?? `${typedSpec.name}-keto`;
    const oathkeeperReleaseName = oathkeeper.metadata.name ?? `${typedSpec.name}-oathkeeper`;
    const hydraPublicService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'hydraPublicService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${hydraReleaseName}-public`, namespace: resolvedNamespace },
    });
    const hydraAdminService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'hydraAdminService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${hydraReleaseName}-admin`, namespace: resolvedNamespace },
    });
    const kratosPublicService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'kratosPublicService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${kratosReleaseName}-public`, namespace: resolvedNamespace },
    });
    const kratosAdminService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'kratosAdminService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${kratosReleaseName}-admin`, namespace: resolvedNamespace },
    });
    const ketoReadService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'ketoReadService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${ketoReleaseName}-read`, namespace: resolvedNamespace },
    });
    const ketoWriteService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'ketoWriteService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${ketoReleaseName}-write`, namespace: resolvedNamespace },
    });
    const oathkeeperProxyService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'oathkeeperProxyService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${oathkeeperReleaseName}-proxy`, namespace: resolvedNamespace },
    });
    const oathkeeperApiService = externalRef<ObservedServiceSpec, ObservedServiceStatus>({
      id: 'oathkeeperApiService',
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${oathkeeperReleaseName}-api`, namespace: resolvedNamespace },
    });

    return {
      ready: allServicesReady,
      phase: Cel.expr<'Ready' | 'Installing'>(allServicesReady, ' ? "Ready" : "Installing"'),
      components: {
        hydra: hydraReady,
        kratos: kratosReady,
        keto: ketoReady,
        oathkeeper: oathkeeperReady,
      },
      maester: {
        hydra: hydraReady,
        oathkeeper: oathkeeperReady,
      },
      endpoints: {
        hydraPublic: serviceEndpoint(hydraPublicService, resolvedNamespace),
        hydraAdmin: serviceEndpoint(hydraAdminService, resolvedNamespace),
        kratosPublic: serviceEndpoint(kratosPublicService, resolvedNamespace),
        kratosAdmin: serviceEndpoint(kratosAdminService, resolvedNamespace),
        ketoRead: serviceEndpoint(ketoReadService, resolvedNamespace),
        ketoWrite: serviceEndpoint(ketoWriteService, resolvedNamespace),
        oathkeeperProxy: serviceEndpoint(oathkeeperProxyService, resolvedNamespace),
        oathkeeperApi: serviceEndpoint(oathkeeperApiService, resolvedNamespace),
      },
      version: Cel.template('%s', resolvedVersion),
    };
  }
);
