import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
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
  type OryIdentityStackConfig,
  OryIdentityStackConfigSchema,
  OryIdentityStackStatusSchema,
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

function omitCustomValuesForGraph(config: OryIdentityStackConfig): OryIdentityStackConfig {
  const { customValues: _customValues, global: _global, hydra, kratos, keto, oathkeeper, maester, ...rest } = config;
  const {
    customValues: _hydraCustomValues,
    values: _hydraValues,
    dsn: _hydraDsn,
    systemSecret: _hydraSystemSecret,
    ...hydraRest
  } = hydra ?? {};
  const {
    customValues: _kratosCustomValues,
    values: _kratosValues,
    dsn: _kratosDsn,
    identitySchemas: _kratosIdentitySchemas,
    publicBaseUrl: _kratosPublicBaseUrl,
    browserBaseUrl: _kratosBrowserBaseUrl,
    secrets: _kratosSecrets,
    ...kratosRest
  } = kratos ?? {};
  const {
    customValues: _ketoCustomValues,
    values: _ketoValues,
    dsn: _ketoDsn,
    ...ketoRest
  } = keto ?? {};
  const {
    customValues: _oathkeeperCustomValues,
    values: _oathkeeperValues,
    mutatorIdTokenJwks: _oathkeeperMutatorIdTokenJwks,
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
    const graphSpec = omitCustomValuesForGraph(typedSpec);
    const graphFallbackSpec =
      typeof typedSpec.name === 'string'
        ? graphSpec
        : { name: typedSpec.name, namespace: resolvedNamespace, version: resolvedVersion };
    let values = mapOryConfigToHelmValues({
      ...graphFallbackSpec,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      dependencySources: defaultManagedDependencySources(typedSpec.name),
    } as OryIdentityStackConfig);
    if (typeof typedSpec.name === 'string') {
      values = mapOryConfigToHelmValues({
        ...typedSpec,
        namespace: resolvedNamespace,
        version: resolvedVersion,
      });
    }

    if (typeof typedSpec.name === 'string') {
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
        hydraPublic: `http://${hydraReleaseName}-public.${resolvedNamespace}.svc.cluster.local`,
        hydraAdmin: `http://${hydraReleaseName}-admin.${resolvedNamespace}.svc.cluster.local`,
        kratosPublic: `http://${kratosReleaseName}-public.${resolvedNamespace}.svc.cluster.local`,
        kratosAdmin: `http://${kratosReleaseName}-admin.${resolvedNamespace}.svc.cluster.local`,
        ketoRead: `http://${ketoReleaseName}-read.${resolvedNamespace}.svc.cluster.local`,
        ketoWrite: `http://${ketoReleaseName}-write.${resolvedNamespace}.svc.cluster.local`,
        oathkeeperProxy: `http://${oathkeeperReleaseName}-proxy.${resolvedNamespace}.svc.cluster.local`,
        oathkeeperApi: `http://${oathkeeperReleaseName}-api.${resolvedNamespace}.svc.cluster.local`,
      },
      version: Cel.template('%s', resolvedVersion),
    };
  }
);
