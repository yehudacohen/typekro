import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { isValuesMergeExpression, mergeValuesExpression } from '../../../core/aspects/values-merge.js';
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

function readyCondition(conditions: unknown): boolean {
  return Cel.expr<boolean>(conditions, '.exists(c, c.type == "Ready" && c.status == "True")');
}

function withMaesterSubchartValues<T extends object>(
  values: T,
  key: string,
  maesterValues: object
): T {
  if (isValuesMergeExpression(values) || isValuesMergeExpression(maesterValues)) {
    return mergeValuesExpression(values, { [key]: maesterValues }) as T;
  }

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
  serviceName: string,
  namespaceName: string,
  port: number,
  scheme = 'http'
): OryEndpointStatus {
  const host = `${serviceName}.${namespaceName}.svc.cluster.local`;
  return {
    url: `${scheme}://${host}:${port}`,
    scheme,
    host,
    port,
    serviceName,
    namespace: namespaceName,
  };
}

function graphSafeConfig(
  config: OryIdentityStackConfig,
  forceSchemaRefs = false
): OryIdentityStackConfig {
  if (forceSchemaRefs || isSchemaSpec(config) || isKubernetesRef(config.name)) {
    return defined({
      name: config.name,
      namespace: config.namespace,
      version: config.version,
      dependencySources: config.dependencySources,
      shared: config.shared,
      global: config.global,
      hydra: defined({
        dsn: config.hydra?.dsn,
        issuerUrl: config.hydra?.issuerUrl,
        loginUrl: config.hydra?.loginUrl,
        consentUrl: config.hydra?.consentUrl,
        logoutUrl: config.hydra?.logoutUrl,
        systemSecret: config.hydra?.systemSecret,
        replicaCount: config.hydra?.replicaCount,
        resources: config.hydra?.resources,
        serviceMonitor: config.hydra?.serviceMonitor,
        values: config.hydra?.values,
      }),
      kratos: defined({
        dsn: config.kratos?.dsn,
        publicBaseUrl: config.kratos?.publicBaseUrl,
        browserBaseUrl: config.kratos?.browserBaseUrl,
        identitySchema: config.kratos?.identitySchema,
        courier: config.kratos?.courier,
        secrets: config.kratos?.secrets,
        replicaCount: config.kratos?.replicaCount,
        resources: config.kratos?.resources,
        serviceMonitor: config.kratos?.serviceMonitor,
        values: config.kratos?.values,
      }),
      keto: defined({
        dsn: config.keto?.dsn,
        namespaces: config.keto?.namespaces,
        replicaCount: config.keto?.replicaCount,
        resources: config.keto?.resources,
        serviceMonitor: config.keto?.serviceMonitor,
        values: config.keto?.values,
      }),
      oathkeeper: defined({
        managedAccessRules: config.oathkeeper?.managedAccessRules,
        mutatorIdTokenJwks: config.oathkeeper?.mutatorIdTokenJwks,
        replicaCount: config.oathkeeper?.replicaCount,
        resources: config.oathkeeper?.resources,
        serviceMonitor: config.oathkeeper?.serviceMonitor,
        values: config.oathkeeper?.values,
      }),
      maester: config.maester,
      resources: config.resources,
    });
  }

  const { hydra, kratos, keto, oathkeeper, maester, ...rest } = config;

  return {
    ...rest,
    ...(hydra ? { hydra } : {}),
    ...(kratos ? { kratos } : {}),
    ...(keto ? { keto } : {}),
    ...(oathkeeper ? { oathkeeper } : {}),
    ...(maester ? { maester } : {}),
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
    const graphSpec = graphSafeConfig(typedSpec, !concreteSpec);
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
        hydraPublic: serviceEndpoint(`${hydraReleaseName}-public`, resolvedNamespace, 4444),
        hydraAdmin: serviceEndpoint(`${hydraReleaseName}-admin`, resolvedNamespace, 4445),
        kratosPublic: serviceEndpoint(`${kratosReleaseName}-public`, resolvedNamespace, 4433),
        kratosAdmin: serviceEndpoint(`${kratosReleaseName}-admin`, resolvedNamespace, 4434),
        ketoRead: serviceEndpoint(`${ketoReleaseName}-read`, resolvedNamespace, 4466),
        ketoWrite: serviceEndpoint(`${ketoReleaseName}-write`, resolvedNamespace, 4467),
        oathkeeperProxy: serviceEndpoint(`${oathkeeperReleaseName}-proxy`, resolvedNamespace, 4455),
        oathkeeperApi: serviceEndpoint(`${oathkeeperReleaseName}-api`, resolvedNamespace, 4456),
      },
      version: Cel.template('%s', resolvedVersion),
    };
  }
);
