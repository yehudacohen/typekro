import { describe, expect, it } from 'bun:test';
import {
  CEL_EXPRESSION_BRAND,
  KUBERNETES_REF_BRAND,
} from '../../../src/core/constants/brands.js';
import { isValuesMergeExpression } from '../../../src/core/aspects/values-merge.js';
import {
  mapDagsterConfigToHelmValues,
  validateDagsterConfig,
} from '../../../src/factories/dagster/utils/helm-values-mapper.js';
import type {
  CelExpression,
  KubernetesRef,
  TypeKroValueTreeObject,
} from '../../../src/core/types/common.js';
import type {
  DagsterBootstrapConfig,
  DagsterHelmValues,
  DagsterMappedHelmValues,
} from '../../../src/factories/dagster/types.js';

const minimalConfig: DagsterBootstrapConfig = {
  name: 'analytics',
  namespace: 'dagster',
  userDeployments: {
    enabled: true,
    deployments: [
      {
        name: 'analytics-repo',
        image: {
          repository: 'ghcr.io/acme/dagster-analytics',
          tag: '2026.06.01',
        },
        codeServerArgs: ['-m', 'analytics.definitions'],
      },
    ],
  },
};

function concreteValues(values: DagsterMappedHelmValues): DagsterHelmValues {
  if (isValuesMergeExpression(values)) {
    throw new Error('Expected concrete Dagster Helm values in this test.');
  }
  return values;
}

describe('Dagster Helm values mapper', () => {
  it('Map typed Dagster user deployments into official chart values', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues(minimalConfig));
    const userDeployments = values['dagster-user-deployments'] as {
      enabled?: boolean;
      enableSubchart?: boolean;
      deployments?: Array<{
        name?: string;
        image?: { repository?: string; tag?: string; pullPolicy?: string };
        codeServerArgs?: string[];
        port?: number;
      }>;
    };

    expect(userDeployments.enabled).toBe(true);
    expect(userDeployments.enableSubchart).toBe(true);
    expect(userDeployments.deployments?.[0]).toMatchObject({
      name: 'analytics-repo',
      image: {
        repository: 'ghcr.io/acme/dagster-analytics',
        tag: '2026.06.01',
        pullPolicy: 'IfNotPresent',
      },
      codeServerArgs: ['-m', 'analytics.definitions'],
      port: 3030,
    });
  });

  it('Preserve explicit user deployment port and image pull policy overrides', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'analytics-repo',
            image: {
              repository: 'ghcr.io/acme/dagster-analytics',
              tag: '2026.06.01',
              pullPolicy: 'Always',
            },
            codeServerArgs: ['-m', 'analytics.definitions'],
            port: 4040,
          },
        ],
      },
    }));
    const userDeployments = values['dagster-user-deployments'] as {
      deployments?: Array<{ image?: { pullPolicy?: string }; port?: number }>;
    };

    expect(userDeployments.deployments?.[0]?.image?.pullPolicy).toBe('Always');
    expect(userDeployments.deployments?.[0]?.port).toBe(4040);
  });

  it('Map common Dagster chart convenience fields', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      webserver: {
        replicaCount: 2,
        pathPrefix: '/dagster',
        service: { type: 'ClusterIP', port: 8080 },
        logFormat: 'json',
      },
      daemon: {
        enabled: true,
        heartbeatTolerance: 120,
        runRetries: { enabled: true, maxRetries: 2 },
      },
      postgresql: {
        enabled: false,
        host: 'dagster-postgres.postgres.svc.cluster.local',
        username: 'dagster',
        database: 'dagster',
        passwordSecretName: 'dagster-postgres',
        servicePort: 5432,
      },
      runLauncher: {
        type: 'K8sRunLauncher',
        k8sRunLauncher: {
          jobNamespace: 'dagster-runs',
          envSecrets: [{ name: 'dagster-run-env' }],
          resources: { requests: { cpu: '250m', memory: '512Mi' } },
        },
      },
      ingress: {
        enabled: true,
        ingressClassName: 'nginx',
        dagsterWebserver: {
          host: 'dagster.example.com',
          path: '/',
          tls: { enabled: true, secretName: 'dagster-tls' },
        },
      },
      computeLogManager: {
        type: 'S3ComputeLogManager',
        config: { bucket: 'dagster-compute-logs', prefix: 'runs' },
      },
      nameOverride: 'dagster-short',
      fullnameOverride: 'dagster-analytics',
      rbacEnabled: true,
      imagePullSecrets: [{ name: 'dagster-registry' }],
    }));

    expect(values.nameOverride).toBe('dagster-short');
    expect(values.fullnameOverride).toBe('dagster-analytics');
    expect(values.rbacEnabled).toBe(true);
    expect(values.imagePullSecrets).toEqual([{ name: 'dagster-registry' }]);
    expect(values.dagsterWebserver).toMatchObject({
      replicaCount: 2,
      pathPrefix: '/dagster',
      service: { type: 'ClusterIP', port: 8080 },
      logFormat: 'json',
    });
    expect(values.dagsterDaemon).toMatchObject({
      enabled: true,
      heartbeatTolerance: 120,
      runRetries: { enabled: true, maxRetries: 2 },
    });
    expect(values.postgresql).toMatchObject({
      enabled: false,
      postgresqlHost: 'dagster-postgres.postgres.svc.cluster.local',
      postgresqlUsername: 'dagster',
      postgresqlDatabase: 'dagster',
      service: { port: 5432 },
    });
    expect(values.global).toMatchObject({ postgresqlSecretName: 'dagster-postgres' });
    expect(values.generatePostgresqlPasswordSecret).toBe(false);
    expect(values.runLauncher).toMatchObject({
      type: 'K8sRunLauncher',
      config: {
        k8sRunLauncher: {
          jobNamespace: 'dagster-runs',
          envSecrets: [{ name: 'dagster-run-env' }],
        },
      },
    });
    expect(values.ingress).toMatchObject({
      enabled: true,
      ingressClassName: 'nginx',
      dagsterWebserver: {
        host: 'dagster.example.com',
        path: '/',
        tls: { enabled: true, secretName: 'dagster-tls' },
      },
    });
    expect(values.computeLogManager).toMatchObject({
      type: 'S3ComputeLogManager',
      config: { bucket: 'dagster-compute-logs', prefix: 'runs' },
    });
  });

  it('Exclude bootstrap-only fields from Helm values', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      version: '1.13.8',
      repositoryName: 'dagster-source',
      repositoryNamespace: 'flux-system',
      serviceAccountName: 'dagster-runtime',
    }));

    expect('name' in values).toBe(false);
    expect('namespace' in values).toBe(false);
    expect('version' in values).toBe(false);
    expect('repositoryName' in values).toBe(false);
    expect('repositoryNamespace' in values).toBe(false);
    expect(values.global).toMatchObject({ serviceAccountName: 'dagster-runtime' });
  });

  it('Merge raw values last while preserving typed values at unrelated paths', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      webserver: { replicaCount: 1, pathPrefix: '/typed' },
      values: {
        dagsterWebserver: { replicaCount: 3 },
        busybox: { image: { repository: 'busybox', tag: '1.36' } },
      },
    }));

    expect(values.dagsterWebserver).toMatchObject({
      replicaCount: 3,
      pathPrefix: '/typed',
    });
    expect(values.busybox).toEqual({
      image: { repository: 'busybox', tag: '1.36' },
    });
  });

  it('Replace arrays and override primitive raw values during deep merge', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'typed-repo',
            image: { repository: 'ghcr.io/acme/typed', tag: '1' },
            dagsterApiGrpcArgs: ['-m', 'typed.repo'],
          },
        ],
      },
      values: {
        rbacEnabled: false,
        'dagster-user-deployments': {
          deployments: [
            {
              name: 'raw-repo',
              image: { repository: 'ghcr.io/acme/raw', tag: '2' },
              codeServerArgs: ['-m', 'raw.repo'],
            },
          ],
        },
      },
    }));
    const userDeployments = values['dagster-user-deployments'] as {
      deployments?: Array<{ name?: string; image?: { repository?: string } }>;
    };

    expect(values.rbacEnabled).toBe(false);
    expect(userDeployments.deployments).toHaveLength(1);
    expect(userDeployments.deployments?.[0]?.name).toBe('raw-repo');
    expect(userDeployments.deployments?.[0]?.image?.repository).toBe('ghcr.io/acme/raw');
  });

  it('Merge RabbitMQ and Redis raw sub-values into official chart blocks', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      global: { celeryConfigSecretName: 'dagster-celery-config' },
      runLauncher: { type: 'CeleryK8sRunLauncher' },
      rabbitmq: {
        enabled: true,
        username: 'dagster',
        servicePort: 5672,
        values: { persistence: { enabled: true } },
      },
      redis: {
        enabled: true,
        brokerDbNumber: 0,
        values: { master: { persistence: { enabled: true } } },
      },
    }));

    expect(values.generateCeleryConfigSecret).toBe(false);
    expect(values.global).toMatchObject({ celeryConfigSecretName: 'dagster-celery-config' });
    expect(values.rabbitmq).toMatchObject({
      enabled: true,
      rabbitmq: { username: 'dagster' },
      service: { port: 5672 },
      persistence: { enabled: true },
    });
    expect(values.rabbitmq?.values).toBeUndefined();
    expect(values.redis).toMatchObject({
      enabled: true,
      brokerDbNumber: 0,
      master: { persistence: { enabled: true } },
    });
    expect(values.redis?.values).toBeUndefined();
  });

  it('Preserve global chart fields unless top-level conveniences override them', () => {
    const globalOnly = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      global: {
        serviceAccountName: 'global-service-account',
        postgresqlSecretName: 'global-postgresql-secret',
      },
    }));
    const topLevelOverride = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      serviceAccountName: 'top-level-service-account',
      global: {
        serviceAccountName: 'global-service-account',
        postgresqlSecretName: 'global-postgresql-secret',
      },
      postgresql: {
        enabled: false,
        host: 'dagster-postgres.postgres.svc.cluster.local',
        passwordSecretName: 'top-level-postgresql-secret',
      },
    }));

    expect(globalOnly.global).toMatchObject({
      serviceAccountName: 'global-service-account',
      postgresqlSecretName: 'global-postgresql-secret',
    });
    expect(topLevelOverride.global).toMatchObject({
      serviceAccountName: 'top-level-service-account',
      postgresqlSecretName: 'top-level-postgresql-secret',
    });
  });

  it('Map RabbitMQ credentials to the official nested chart path', () => {
    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      global: { celeryConfigSecretName: 'dagster-celery-config' },
      runLauncher: { type: 'CeleryK8sRunLauncher' },
      rabbitmq: {
        enabled: true,
        username: 'dagster-user',
        password: 'dagster-password',
      },
    }));

    expect(values.rabbitmq).toMatchObject({
      enabled: true,
      rabbitmq: {
        username: 'dagster-user',
        password: 'dagster-password',
      },
    });
    expect(values.rabbitmq?.username).toBeUndefined();
    expect(values.rabbitmq?.password).toBeUndefined();
  });

  it('Preserve graph-aware subchart values as nested values merge expressions', () => {
    const postgresqlValues = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'postgresqlValues',
      fieldPath: 'status.values',
    } satisfies KubernetesRef<TypeKroValueTreeObject>;
    const rabbitmqValues = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'rabbitmqValues',
      fieldPath: 'status.values',
    } satisfies KubernetesRef<TypeKroValueTreeObject>;
    const redisValues = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'redisValues',
      fieldPath: 'status.values',
    } satisfies KubernetesRef<TypeKroValueTreeObject>;

    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      global: { celeryConfigSecretName: 'dagster-celery-config' },
      runLauncher: { type: 'CeleryK8sRunLauncher' },
      postgresql: { enabled: true, values: postgresqlValues },
      rabbitmq: { enabled: true, values: rabbitmqValues },
      redis: { enabled: true, values: redisValues },
    }));

    expect(isValuesMergeExpression(values.postgresql)).toBe(true);
    expect(isValuesMergeExpression(values.rabbitmq)).toBe(true);
    expect(isValuesMergeExpression(values.redis)).toBe(true);
    expect((values.postgresql as { overlays?: unknown[] }).overlays?.[0]).toBe(postgresqlValues);
    expect((values.rabbitmq as { overlays?: unknown[] }).overlays?.[0]).toBe(rabbitmqValues);
    expect((values.redis as { overlays?: unknown[] }).overlays?.[0]).toBe(redisValues);
  });

  it('Preserve TypeKro refs and CEL expressions inside nested raw values', () => {
    const secretName = {
      [KUBERNETES_REF_BRAND]: true,
      resourceId: 'postgresSecret',
      fieldPath: 'metadata.name',
    } satisfies KubernetesRef<string>;
    const hostname = {
      [CEL_EXPRESSION_BRAND]: true,
      expression: 'schema.spec.ingress.host',
    } satisfies CelExpression<string>;

    const values = concreteValues(mapDagsterConfigToHelmValues({
      ...minimalConfig,
      values: {
        global: { postgresqlSecretName: secretName },
        ingress: { dagsterWebserver: { host: hostname } },
      },
    }));
    const ingress = values.ingress as
      | { dagsterWebserver?: { host?: unknown } }
      | undefined;

    expect(values.global?.postgresqlSecretName).toBe(secretName);
    expect(ingress?.dagsterWebserver?.host).toBe(hostname);
  });

  it('Reject typed user deployments with missing or conflicting server arguments', () => {
    const missingArgs = validateDagsterConfig({
      ...minimalConfig,
      userDeployments: {
        enabled: true,
        deployments: [
          { name: 'broken', image: { repository: 'ghcr.io/acme/broken', tag: '1' } },
        ],
      },
    });
    const conflictingArgs = validateDagsterConfig({
      ...minimalConfig,
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'broken',
            image: { repository: 'ghcr.io/acme/broken', tag: '1' },
            dagsterApiGrpcArgs: ['-m', 'grpc'],
            codeServerArgs: ['-m', 'code_server'],
          },
        ],
      },
    });

    expect(missingArgs.valid).toBe(false);
    expect(missingArgs.issues).toContainEqual(
      expect.objectContaining({ path: 'userDeployments.deployments[0]' })
    );
    expect(conflictingArgs.valid).toBe(false);
    expect(conflictingArgs.issues).toContainEqual(
      expect.objectContaining({ path: 'userDeployments.deployments[0]' })
    );
  });

  it('Reject CeleryK8sRunLauncher without a broker path', () => {
    const result = validateDagsterConfig({
      ...minimalConfig,
      runLauncher: {
        type: 'CeleryK8sRunLauncher',
        celeryK8sRunLauncher: { workerQueues: [{ name: 'default' }] },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'DAGSTER_REQUIRED_CONFIG_MISSING',
        component: 'runLauncher',
      })
    );
  });

  it('Reject external PostgreSQL typed config without a host or raw PostgreSQL override', () => {
    const result = validateDagsterConfig({
      ...minimalConfig,
      postgresql: { enabled: false, username: 'dagster', database: 'dagster' },
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'DAGSTER_REQUIRED_CONFIG_MISSING',
        path: 'postgresql.host',
      })
    );
    expect(result.issues.every((issue) => !issue.message.includes('password'))).toBe(true);
  });

  it('Throw structured TypeKroError failures before deploy or YAML generation', () => {
    expect(() =>
      mapDagsterConfigToHelmValues({
        ...minimalConfig,
        userDeployments: {
          enabled: true,
          deployments: [
            {
              name: 'broken',
              image: { repository: 'ghcr.io/acme/broken', tag: '1' },
            },
          ],
        },
      })
    ).toThrow(/DAGSTER_REQUIRED_CONFIG_MISSING|DagsterConfigurationError/);
  });
});
