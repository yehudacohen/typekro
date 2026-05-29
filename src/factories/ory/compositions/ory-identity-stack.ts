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

function endpointStatus(instanceName: string, serviceSuffix: string, namespaceName: string): string {
  return Cel.template('http://%s-%s.%s.svc.cluster.local', instanceName, serviceSuffix, namespaceName);
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

function defaultManagedDependencySources(name: string): OryIdentityStackConfig['dependencySources'] {
  return {
    hydra: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-hydra-db` } },
      systemSecret: { mode: 'managed', secretName: `${name}-hydra-secrets`, secretKey: 'system' },
    },
    kratos: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-kratos-db` } },
      secrets: {
        cookie: { mode: 'managed', secretName: `${name}-kratos-secrets`, secretKey: 'cookie' },
        cipher: { mode: 'managed', secretName: `${name}-kratos-secrets`, secretKey: 'cipher' },
      },
    },
    keto: {
      database: { dsn: { mode: 'managed', resourceName: `${name}-keto-db` } },
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
    let values = mapOryConfigToHelmValues({
      ...typedSpec,
      namespace: resolvedNamespace,
      version: resolvedVersion,
      dependencySources: defaultManagedDependencySources(typedSpec.name),
    } as OryIdentityStackConfig);
    try {
      values = mapOryConfigToHelmValues({
        ...typedSpec,
        namespace: resolvedNamespace,
        version: resolvedVersion,
      });
    } catch (error) {
      if (typeof typedSpec.name === 'string') {
        throw error;
      }
      // ResourceGraphDefinition generation runs with schema proxies, not a concrete user spec.
      // Managed defaults keep the graph serializable while concrete direct-mode calls still
      // resolve through the mapper when dependencySources are supplied.
    }

    const _oryNamespace = namespace({
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

    return {
      ready: Cel.expr<boolean>(
        'hydraHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && kratosHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && ketoHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && oathkeeperHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True")'
      ),
      phase: Cel.expr<'Ready' | 'Installing'>(
        'hydraHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && kratosHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && ketoHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") && oathkeeperHelmRelease.status.conditions.exists(c, c.type == "Ready" && c.status == "True") ? "Ready" : "Installing"'
      ),
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
        hydraPublic: endpointStatus(typedSpec.name, 'hydra-public', resolvedNamespace),
        hydraAdmin: endpointStatus(typedSpec.name, 'hydra-admin', resolvedNamespace),
        kratosPublic: endpointStatus(typedSpec.name, 'kratos-public', resolvedNamespace),
        kratosAdmin: endpointStatus(typedSpec.name, 'kratos-admin', resolvedNamespace),
        ketoRead: endpointStatus(typedSpec.name, 'keto-read', resolvedNamespace),
        ketoWrite: endpointStatus(typedSpec.name, 'keto-write', resolvedNamespace),
        oathkeeperProxy: endpointStatus(typedSpec.name, 'oathkeeper-proxy', resolvedNamespace),
        oathkeeperApi: endpointStatus(typedSpec.name, 'oathkeeper-api', resolvedNamespace),
      },
      version: Cel.template('%s', resolvedVersion),
    };
  }
);
