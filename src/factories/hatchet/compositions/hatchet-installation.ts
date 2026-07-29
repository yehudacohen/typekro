import { mergeValuesExpression } from '../../../core/aspects/values-merge.js';
import { kubernetesComposition } from '../../../core/composition/imperative.js';
import { Cel } from '../../../core/references/cel.js';
import { observedResource } from '../../../core/references/external-refs.js';
import { isKubernetesRef } from '../../../utils/type-guards.js';
import { helmReleaseConditionSummary } from '../../helm/status.js';
import { configMap } from '../../kubernetes/config/config-map.js';
import { namespace } from '../../kubernetes/core/namespace.js';
import {
  DEFAULT_HATCHET_CHART_VERSION,
  DEFAULT_HATCHET_REPOSITORY_NAME,
  DEFAULT_HATCHET_REPOSITORY_URL,
  DEFAULT_HATCHET_SERVER_VERSION,
  hatchetHelmRelease,
  hatchetHelmRepository,
} from '../resources/helm.js';
import {
  type HatchetInstallationConfig,
  HatchetInstallationConfigSchema,
  HatchetInstallationStatusSchema,
} from '../types.js';

const DEFAULT_HATCHET_NAMESPACE = 'hatchet-system';
const HATCHET_CONFIGURATION_SECRET = 'hatchet-config';
const HATCHET_WORKER_TOKEN_SECRET = 'hatchet-client-config';

/**
 * Install the official Hatchet chart against an externally authoritative
 * PostgreSQL database.
 *
 * The composition deliberately disables the bundled PostgreSQL and RabbitMQ
 * charts. The database and admin credentials remain in external Kubernetes
 * Secrets and are mounted into Hatchet with chart-native `envFrom`; they are
 * never copied into Helm values, the KRO instance, or ResourceGraphDefinition.
 */
export const hatchetInstallation = kubernetesComposition(
  {
    name: 'hatchet-installation',
    kind: 'HatchetInstallation',
    spec: HatchetInstallationConfigSchema,
    status: HatchetInstallationStatusSchema,
  },
  (spec: HatchetInstallationConfig) => {
    const graphMode = isKubernetesRef(spec.name);
    if (!graphMode) validateSecretReferences(spec);
    const targetNamespace = graphMode
      ? Cel.expr<string>('has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system"')
      : (spec.namespace ?? DEFAULT_HATCHET_NAMESPACE);
    const ownsTargetNamespace = graphMode
      ? Cel.expr<boolean>(
          '!has(schema.spec.namespaceOwnership) || schema.spec.namespaceOwnership == "owned"'
        )
      : spec.namespaceOwnership !== 'external';
    const repositoryName = graphMode
      ? Cel.expr<string>(
          'has(schema.spec.repositoryName) ? schema.spec.repositoryName : string(size(has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system")) + "-" + string(has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system") + "-" + string(schema.spec.name) + "-hatchet"'
        )
      : (spec.repositoryName ??
        `${targetNamespace.length}-${targetNamespace}-${spec.name}-${DEFAULT_HATCHET_REPOSITORY_NAME}`);
    const repositoryNamespace = graphMode
      ? Cel.expr<string>(
          'has(schema.spec.repositoryNamespace) ? schema.spec.repositoryNamespace : (has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system")'
        )
      : (spec.repositoryNamespace ?? targetNamespace);
    const ownsRepositoryNamespace = graphMode
      ? Cel.expr<boolean>(
          '!has(schema.spec.repositoryNamespaceOwnership) || schema.spec.repositoryNamespaceOwnership == "owned"'
        )
      : spec.repositoryNamespaceOwnership !== 'external';
    const repositoryUrl = graphMode
      ? Cel.expr<string>(
          'has(schema.spec.repositoryUrl) ? schema.spec.repositoryUrl : "https://hatchet-dev.github.io/hatchet-charts"'
        )
      : (spec.repositoryUrl ?? DEFAULT_HATCHET_REPOSITORY_URL);
    const chartVersion = graphMode
      ? Cel.expr<string>('has(schema.spec.chartVersion) ? schema.spec.chartVersion : "0.13.3"')
      : (spec.chartVersion ?? DEFAULT_HATCHET_CHART_VERSION);
    const serverVersion = graphMode
      ? Cel.expr<string>('has(schema.spec.serverVersion) ? schema.spec.serverVersion : "v0.94.10"')
      : (spec.serverVersion ?? DEFAULT_HATCHET_SERVER_VERSION);
    const apiReplicas = graphMode
      ? Cel.expr<number>(
          'has(schema.spec.replicas) && has(schema.spec.replicas.api) ? schema.spec.replicas.api : 1'
        )
      : (spec.replicas?.api ?? 1);
    const engineReplicas = graphMode
      ? Cel.expr<number>(
          'has(schema.spec.replicas) && has(schema.spec.replicas.engine) ? schema.spec.replicas.engine : 1'
        )
      : (spec.replicas?.engine ?? 1);
    const frontendReplicas = graphMode
      ? Cel.expr<number>(
          'has(schema.spec.replicas) && has(schema.spec.replicas.frontend) ? schema.spec.replicas.frontend : 1'
        )
      : (spec.replicas?.frontend ?? 1);
    const dashboardEnabled = graphMode
      ? Cel.expr<boolean>('!has(schema.spec.dashboard) || schema.spec.dashboard')
      : (spec.dashboard ?? true);
    const workerTokenJob = graphMode
      ? Cel.expr<boolean>('!has(schema.spec.workerTokenJob) || schema.spec.workerTokenJob')
      : (spec.workerTokenJob ?? true);
    const endpoint = graphMode
      ? Cel.expr<string>(
          'has(schema.spec.serverUrl) ? schema.spec.serverUrl : "http://" + string(schema.spec.name) + "-api." + string(has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system") + ".svc:8080"'
        )
      : (spec.serverUrl ?? `http://${spec.name}-api.${targetNamespace}.svc:8080`);
    const grpcEndpoint = graphMode
      ? Cel.expr<string>(
          'has(schema.spec.grpcBroadcastAddress) ? schema.spec.grpcBroadcastAddress : string(schema.spec.name) + "-engine." + string(has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system") + ".svc:7070"'
        )
      : (spec.grpcBroadcastAddress ?? `${spec.name}-engine.${targetNamespace}.svc:7070`);
    const cookieDomain = graphMode
      ? Cel.expr<string>(
          'has(schema.spec.cookieDomain) ? schema.spec.cookieDomain : string(schema.spec.name) + "-api." + string(has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system") + ".svc"'
        )
      : (spec.cookieDomain ?? `${spec.name}-api.${targetNamespace}.svc`);
    const cookieInsecure = graphMode
      ? Cel.expr<boolean>('!has(schema.spec.cookieInsecure) || schema.spec.cookieInsecure')
      : (spec.cookieInsecure ?? true);
    const grpcInsecure = graphMode
      ? Cel.expr<boolean>('!has(schema.spec.grpcInsecure) || schema.spec.grpcInsecure')
      : (spec.grpcInsecure ?? true);
    const workerTokenSecret = graphMode
      ? Cel.expr<string>(
          `(!has(schema.spec.workerTokenJob) || schema.spec.workerTokenJob) ? "${HATCHET_WORKER_TOKEN_SECRET}" : ""`
        )
      : workerTokenJob
        ? HATCHET_WORKER_TOKEN_SECRET
        : '';
    const configurationSecret = HATCHET_CONFIGURATION_SECRET;
    const sharedConfigSecret = graphMode
      ? Cel.expr<string>('string(schema.spec.name) + "-shared-config"')
      : `${spec.name}-shared-config`;
    const externalEnvironment = [
      { secretRef: { name: sharedConfigSecret } },
      { secretRef: { name: spec.database.connectionSecret.name } },
      { secretRef: { name: spec.adminCredentialsSecret.name } },
    ];

    namespace({
      id: 'hatchetNamespace',
      metadata: {
        name: targetNamespace,
        labels: {
          'app.kubernetes.io/name': 'hatchet',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
    }).withIncludeWhen(ownsTargetNamespace);

    namespace({
      id: 'hatchetRepositoryNamespace',
      metadata: {
        name: repositoryNamespace,
        labels: {
          'app.kubernetes.io/name': 'hatchet-helm-source',
          'app.kubernetes.io/managed-by': 'typekro',
        },
      },
    }).withIncludeWhen(
      graphMode
        ? Cel.expr<boolean>(
            '(!has(schema.spec.repositoryNamespaceOwnership) || schema.spec.repositoryNamespaceOwnership == "owned") && has(schema.spec.repositoryNamespace) && schema.spec.repositoryNamespace != (has(schema.spec.namespace) ? schema.spec.namespace : "hatchet-system")'
          )
        : ownsRepositoryNamespace && repositoryNamespace !== targetNamespace
    );

    configMap({
      id: 'hatchetMetadata',
      metadata: {
        name: graphMode
          ? Cel.expr<string>('string(schema.spec.name) + "-typekro-metadata"')
          : `${spec.name}-typekro-metadata`,
        namespace: targetNamespace,
        labels: {
          'app.kubernetes.io/name': 'hatchet',
          'app.kubernetes.io/instance': spec.name,
          'app.kubernetes.io/managed-by': 'typekro',
        },
        annotations: {
          'typekro.dev/chart-version': chartVersion,
          'typekro.dev/server-version': serverVersion,
          'typekro.dev/endpoint': endpoint,
          'typekro.dev/grpc-endpoint': grpcEndpoint,
          'typekro.dev/configuration-secret': configurationSecret,
          'typekro.dev/worker-token-secret': workerTokenSecret,
          'typekro.dev/dashboard-enabled': graphMode
            ? Cel.expr<string>(dashboardEnabled, ' ? "true" : "false"')
            : String(dashboardEnabled),
        },
      },
      immutable: true,
      data: {},
    });

    const repository = hatchetHelmRepository({
      id: 'hatchetRepository',
      name: repositoryName,
      namespace: repositoryNamespace,
      url: repositoryUrl,
    });
    const databaseCredentials = graphMode
      ? observedResource<Record<string, never>, Record<string, never>>({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: spec.database.connectionSecret.name,
            namespace: targetNamespace,
          },
          id: 'hatchetDatabaseCredentials',
        })
      : undefined;
    const adminCredentials = graphMode
      ? observedResource<Record<string, never>, Record<string, never>>({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: spec.adminCredentialsSecret.name,
            namespace: targetNamespace,
          },
          id: 'hatchetAdminCredentials',
        })
      : undefined;

    const protectedValues = {
      global: {
        sharedConfigSecretName: sharedConfigSecret,
      },
      sharedConfig: {
        image: { tag: serverVersion },
        serverUrl: endpoint,
        serverAuthCookieDomain: cookieDomain,
        serverAuthCookieInsecure: graphMode
          ? Cel.expr<string>(cookieInsecure, ' ? "t" : "f"')
          : cookieInsecure
            ? 't'
            : 'f',
        grpcBroadcastAddress: grpcEndpoint,
        grpcInsecure: graphMode
          ? Cel.expr<string>(grpcInsecure, ' ? "t" : "f"')
          : grpcInsecure
            ? 't'
            : 'f',
        env: { SERVER_MSGQUEUE_KIND: 'postgres' },
      },
      postgres: { enabled: false },
      rabbitmq: { enabled: false },
      api: {
        replicaCount: apiReplicas,
        workerTokenJob: { enabled: workerTokenJob },
        envFrom: externalEnvironment,
      },
      engine: {
        replicaCount: engineReplicas,
        envFrom: externalEnvironment,
      },
      frontend: {
        enabled: dashboardEnabled,
        replicaCount: frontendReplicas,
      },
      caddy: { enabled: false },
    };
    const values = mergeHatchetValues(spec.values, protectedValues, graphMode);
    const release = hatchetHelmRelease({
      id: 'hatchetRelease',
      name: spec.name,
      namespace: targetNamespace,
      version: chartVersion,
      repositoryName,
      repositoryNamespace,
      repositoryUrl,
      values,
    });
    release.dependsOn(repository);
    if (databaseCredentials && adminCredentials) {
      release.dependsOn(databaseCredentials);
      release.dependsOn(adminCredentials);
    }

    return {
      ...helmReleaseConditionSummary(release),
      chartVersion: Cel.expr<string>(
        'hatchetMetadata.metadata.annotations["typekro.dev/chart-version"]'
      ),
      serverVersion: Cel.expr<string>(
        'hatchetMetadata.metadata.annotations["typekro.dev/server-version"]'
      ),
      endpoint: Cel.expr<string>('hatchetMetadata.metadata.annotations["typekro.dev/endpoint"]'),
      grpcEndpoint: Cel.expr<string>(
        'hatchetMetadata.metadata.annotations["typekro.dev/grpc-endpoint"]'
      ),
      configurationSecret: Cel.expr<string>(
        'hatchetMetadata.metadata.annotations["typekro.dev/configuration-secret"]'
      ),
      workerTokenSecret: Cel.expr<string>(
        'hatchetMetadata.metadata.annotations["typekro.dev/worker-token-secret"]'
      ),
      dashboardEnabled: Cel.expr<boolean>(
        'hatchetMetadata.metadata.annotations["typekro.dev/dashboard-enabled"] == "true"'
      ),
    };
  },
  {
    schemaFieldValidations: {
      'database.connectionSecret.name': 'size(self) > 0',
      'adminCredentialsSecret.name': 'size(self) > 0',
    },
  }
);

function validateSecretReferences(spec: HatchetInstallationConfig): void {
  const required = [
    ['database.connectionSecret.name', spec.database.connectionSecret.name],
    ['adminCredentialsSecret.name', spec.adminCredentialsSecret.name],
  ] as const;
  for (const [path, value] of required) {
    if (value.trim().length === 0) {
      throw new Error(`Hatchet ${path} must be a non-empty Secret reference.`);
    }
  }
}

function mergeHatchetValues(
  customValues: HatchetInstallationConfig['values'],
  protectedValues: Record<string, unknown>,
  graphMode: boolean
): HatchetInstallationConfig['values'] {
  if (!customValues) return protectedValues;
  if (graphMode || !isPlainObject(customValues)) {
    return mergeValuesExpression(
      customValues,
      protectedValues
    ) as HatchetInstallationConfig['values'];
  }
  const merged = cloneValue(customValues);
  deepMerge(merged, protectedValues);
  return merged;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      deepMerge(current, value);
    } else {
      target[key] = cloneValue(value);
    }
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)])
    ) as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
