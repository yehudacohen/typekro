import { describe, expect, it, spyOn } from 'bun:test';
import { KubeConfig, type KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';
import { type } from 'arktype';
import { parse as parseYaml } from 'yaml';

import { DirectTypeKroDeployer } from '../../../src/alchemy/deployers.js';
import { resourceFromDirectArtifactRecordForTest } from '../../../src/alchemy/resource-registration.js';
import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DirectDeploymentEngine } from '../../../src/core/deployment/engine.js';
import { Cel } from '../../../src/core/references/cel.js';
import { CelEvaluator } from '../../../src/core/references/cel-evaluator.js';
import { DEFAULT_SINGLETON_NAMESPACE, singleton } from '../../../src/core/singleton/singleton.js';
import {
  DEFAULT_HARBOR_CHART_VERSION,
  DEFAULT_HARBOR_VERSION,
  HarborProductionInstallationConfigSchema,
  HarborRookS3CredentialsConfigSchema,
  harborHelmRelease,
  harborLocalInstallation,
  harborProductionInstallation,
  harborRookS3Credentials,
  mapHarborLocalInstallationToHelmValues,
  mapHarborProductionInstallationToHelmValues,
} from '../../../src/factories/harbor/index.js';
import type {
  HarborLocalInstallationConfig,
  HarborProductionInstallationConfig,
} from '../../../src/factories/harbor/types.js';
import { harbor as rootHarborNamespace } from '../../../src/factories/index.js';

const secrets = {
  encryptionKey: 'platform-harbor-encryption',
  core: 'platform-harbor-core',
  jobservice: 'platform-harbor-jobservice',
  registry: 'platform-harbor-registry',
  registryCredentials: 'platform-harbor-registry-credentials',
  xsrf: 'platform-harbor-xsrf',
};

function localConfig(
  overrides: Partial<HarborLocalInstallationConfig> = {}
): HarborLocalInstallationConfig {
  return {
    name: 'harbor',
    profile: 'local-development',
    exposure: {
      type: 'ingress',
      externalUrl: 'https://harbor.orb.local',
      tls: { enabled: true, source: 'secret', secretName: 'harbor-tls' },
      ingress: { host: 'harbor.orb.local', className: 'nginx' },
    },
    storage: {
      bucket: 'harbor-registry',
      region: 'us-east-1',
      regionEndpoint: 'https://rook-ceph-rgw.rook-ceph.svc',
      existingSecret: 'harbor-s3',
      caBundleSecretName: 'rook-ca',
    },
    adminPasswordSecret: { name: 'platform-harbor-admin' },
    componentSecrets: secrets,
    ...overrides,
  };
}

function productionConfig(): HarborProductionInstallationConfig {
  const resources = {
    requests: { cpu: '250m', memory: '512Mi' },
    limits: { cpu: '1', memory: '1Gi' },
  };
  return {
    ...localConfig(),
    profile: 'production',
    exposure: {
      type: 'ingress',
      externalUrl: 'https://harbor.orb.local',
      tls: { enabled: true, source: 'secret', secretName: 'harbor-tls' },
      ingress: { host: 'harbor.orb.local', className: 'nginx' },
    },
    certificate: {
      secretName: 'harbor-tls',
      issuerRef: { name: 'platform-ca', kind: 'ClusterIssuer' },
    },
    storage: {
      ...localConfig().storage,
      secure: true,
      skipVerify: false,
    },
    database: {
      host: 'harbor-rw.database.svc',
      username: 'harbor',
      database: 'harbor',
      existingSecret: 'harbor-database',
      sslMode: 'verify-full',
    },
    cache: {
      address: 'valkey-primary.valkey.svc:6379',
      existingSecret: 'harbor-valkey',
      tls: { enabled: true, caBundleSecretName: 'valkey-ca' },
    },
    networkPolicy: {
      enabled: true,
      ingressNamespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
      egressNamespaceLabels: [
        { 'kubernetes.io/metadata.name': 'database' },
        { 'kubernetes.io/metadata.name': 'valkey' },
        { 'kubernetes.io/metadata.name': 'rook-ceph' },
      ],
    },
    replicas: { core: 2, portal: 2, registry: 2, jobservice: 2, exporter: 2 },
    resources: {
      core: resources,
      portal: resources,
      registry: resources,
      jobservice: resources,
      exporter: resources,
    },
  };
}

function expectCleanYaml(yaml: string): void {
  expect(yaml).not.toContain('__KUBERNETES_REF__');
  expect(yaml).not.toContain('__typekroSchemaKey');
  expect(yaml).not.toContain('[object Object]');
  expect(yaml).not.toContain('undefined');
}

describe('official Harbor platform', () => {
  const credentialCases: ReadonlyArray<{
    name: string;
    data?: Record<string, string>;
    valid: boolean;
  }> = [
    {
      name: 'valid',
      data: { AWS_ACCESS_KEY_ID: 'YWNjZXNz', AWS_SECRET_ACCESS_KEY: 'c2VjcmV0' },
      valid: true,
    },
    {
      name: 'empty-access',
      data: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: 'c2VjcmV0' },
      valid: false,
    },
    {
      name: 'empty-secret',
      data: { AWS_ACCESS_KEY_ID: 'YWNjZXNz', AWS_SECRET_ACCESS_KEY: '' },
      valid: false,
    },
    { name: 'missing-access', data: { AWS_SECRET_ACCESS_KEY: 'c2VjcmV0' }, valid: false },
    { name: 'missing-secret', data: { AWS_ACCESS_KEY_ID: 'YWNjZXNz' }, valid: false },
    { name: 'missing-data', valid: false },
  ];
  for (const testCase of credentialCases) {
    it(`validates ${testCase.name} Rook credentials before direct mutation and in emitted KRO expressions`, async () => {
      const config = {
        name: 'harbor-s3',
        namespace: 'registry-control',
        source: { namespace: 'bucket-system', claimName: 'registry-bucket' },
      };
      const source = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: config.source.claimName, namespace: config.source.namespace },
        ...(testCase.data ? { data: testCase.data } : {}),
      };
      const declarations = await harborRookS3Credentials
        .factory('direct', { namespace: config.namespace })
        .toAlchemyResources(config);
      const declaration = declarations[0]!;
      const restored = JSON.parse(JSON.stringify(declaration.props));
      const resource = resourceFromDirectArtifactRecordForTest(restored)!;
      const kubeConfig = new KubeConfig();
      kubeConfig.loadFromClusterAndUser(
        { name: 'inert', server: 'http://127.0.0.1:1', skipTLSVerify: false },
        { name: 'inert' }
      );
      const api = KubernetesObjectApi.makeApiClient(kubeConfig);
      const previous = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: config.name, namespace: config.namespace },
        data: {
          REGISTRY_STORAGE_S3_ACCESSKEY: 'cHJldmlvdXM=',
          REGISTRY_STORAGE_S3_SECRETKEY: 'cHJldmlvdXM=',
        },
      };
      let target: KubernetesObject = previous;
      const read = spyOn(api, 'read').mockImplementation(async (identity) =>
        JSON.parse(
          JSON.stringify(identity.metadata.namespace === config.source.namespace ? source : target)
        )
      );
      const create = spyOn(api, 'create').mockImplementation(async (value) => {
        target = value;
        return value;
      });
      const patch = spyOn(api, 'patch').mockImplementation(async (value) => {
        target = value;
        return value;
      });
      const remove = spyOn(api, 'delete').mockImplementation(async () => ({}));
      const deployer = new DirectTypeKroDeployer(new DirectDeploymentEngine(kubeConfig, api));
      try {
        const operation = deployer.deploy(resource, {
          mode: 'direct',
          namespace: config.namespace,
          timeout: 1000,
        });
        if (testCase.valid) {
          await operation;
          expect(target).toMatchObject({
            data: {
              REGISTRY_STORAGE_S3_ACCESSKEY: testCase.data?.AWS_ACCESS_KEY_ID,
              REGISTRY_STORAGE_S3_SECRETKEY: testCase.data?.AWS_SECRET_ACCESS_KEY,
            },
          });
          expect(patch).toHaveBeenCalledTimes(1);
          expect(patch.mock.calls[0]?.[0].metadata).toMatchObject({
            name: config.name, namespace: config.namespace,
          });
        } else {
          await expect(operation).rejects.toThrow(
            'Rook OBC credential Secret is missing required key'
          );
          expect(patch).not.toHaveBeenCalled();
          expect(target).toBe(previous);
        }
        expect(create).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(read.mock.calls[0]?.[0]).toEqual({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: source.metadata,
        });
        expect(JSON.stringify(declaration)).not.toContain('c2VjcmV0');

        // Evaluate the exact generated expressions, not a hand-authored equivalent.
        // Physical KRO rotation remains a separate qualification gate.
        const graph: {
          spec: { resources: Array<{ id: string; template?: { data?: Record<string, string> } }> };
        } = parseYaml(
          harborRookS3Credentials.factory('kro', { namespace: config.namespace }).toYaml()
        );
        const fields = graph.spec.resources.find((entry) => entry.id === 'harborStorageCredentials')
          ?.template?.data;
        expect(fields).toBeDefined();
        const evaluate = async () =>
          Object.fromEntries(
            await Promise.all(
              Object.entries(fields ?? {}).map(async ([key, expression]) => [
                key,
                await new CelEvaluator().evaluate(Cel.expr<string>(expression.slice(2, -1)), {
                  resources: new Map([['rookCredentials', source]]),
                }),
              ])
            )
          );
        if (testCase.valid) {
          expect(await evaluate()).toEqual({
            REGISTRY_STORAGE_S3_ACCESSKEY: 'YWNjZXNz',
            REGISTRY_STORAGE_S3_SECRETKEY: 'c2VjcmV0',
          });
        } else {
          await expect(evaluate()).rejects.toThrow(
            'Rook OBC credential Secret is missing required key'
          );
        }
      } finally {
        await deployer.dispose();
      }
    });
  }

  it('keeps Rook credentials external and models their encoded Harbor projection as an owned graph child', async () => {
    const config = {
      name: 'harbor-s3',
      namespace: 'registry-system',
      source: { namespace: 'bucket-system', claimName: 'registry-bucket' },
    };
    const yaml = harborRookS3Credentials.factory('kro', { namespace: 'registry-control' }).toYaml();
    expect(yaml).toContain('externalRef:');
    expect(yaml).toContain('id: rookCredentials');
    expect(yaml).toContain('id: harborStorageCredentials');
    expect(yaml).toContain(
      'has(rookCredentials.data.AWS_ACCESS_KEY_ID) && size(rookCredentials.data.AWS_ACCESS_KEY_ID) > 0'
    );
    expect(yaml).toContain(
      'has(rookCredentials.data.AWS_SECRET_ACCESS_KEY) && size(rookCredentials.data.AWS_SECRET_ACCESS_KEY) > 0'
    );
    expect(yaml).not.toContain('stringData:');
    expect(yaml).toContain(
      'schema.spec.namespace != schema.spec.source.namespace || schema.spec.name != schema.spec.source.claimName'
    );
    expectCleanYaml(yaml);
    const declarations = await harborRookS3Credentials
      .factory('direct', { namespace: 'registry-control' })
      .toAlchemyResources(config);
    const serialized = JSON.stringify(declarations);
    expect(serialized).toContain('REGISTRY_STORAGE_S3_ACCESSKEY');
    expect(serialized).toContain('registry-bucket');
    expect(serialized).toContain('harbor-s3');
    expect(serialized).not.toContain('AWS_SECRET_ACCESS_KEY_VALUE');
  });

  it('rejects a Harbor projection that would own the source OBC Secret identity', () => {
    const invalid = HarborRookS3CredentialsConfigSchema({
      name: 'registry-bucket',
      namespace: 'bucket-system',
      source: { namespace: 'bucket-system', claimName: 'registry-bucket' },
    });
    expect(invalid instanceof type.errors).toBe(true);
    expect(String(invalid)).toContain('distinct from the Rook OBC');
  });

  it('pins the reviewed official chart and application versions', () => {
    const release = harborHelmRelease({ name: 'harbor' });
    expect(release.spec.chart.spec.chart).toBe('harbor');
    expect(release.spec.chart.spec.version).toBe(DEFAULT_HARBOR_CHART_VERSION);
    expect(DEFAULT_HARBOR_CHART_VERSION).toBe('1.19.1');
    expect(DEFAULT_HARBOR_VERSION).toBe('v2.15.1');
    expect(release.spec.install).toEqual({
      timeout: '20m',
      remediation: { retries: 3 },
    });
    expect(release.spec.upgrade).toEqual({
      timeout: '20m',
      remediation: { retries: 0, remediateLastFailure: false },
    });
  });

  it('maps S3 and every credential through official existing-Secret fields', () => {
    const values = mapHarborLocalInstallationToHelmValues(localConfig());
    expect(values).toMatchObject({
      externalURL: 'https://harbor.orb.local',
      expose: {
        type: 'ingress',
        tls: { enabled: true, certSource: 'secret', secret: { secretName: 'harbor-tls' } },
        ingress: { hosts: { core: 'harbor.orb.local' }, className: 'nginx' },
      },
      persistence: {
        resourcePolicy: 'keep',
        imageChartStorage: {
          type: 's3',
          disableredirect: true,
          caBundleSecretName: 'rook-ca',
          s3: {
            existingSecret: 'harbor-s3',
            bucket: 'harbor-registry',
            region: 'us-east-1',
            regionendpoint: 'https://rook-ceph-rgw.rook-ceph.svc',
            secure: true,
            skipverify: false,
            v4auth: true,
          },
        },
      },
      existingSecretAdminPassword: 'platform-harbor-admin',
      existingSecretAdminPasswordKey: 'HARBOR_ADMIN_PASSWORD',
      existingSecretSecretKey: 'platform-harbor-encryption',
      core: {
        existingSecret: 'platform-harbor-core',
        existingXsrfSecret: 'platform-harbor-xsrf',
      },
      jobservice: {
        existingSecret: 'platform-harbor-jobservice',
        jobLoggers: ['database'],
      },
      registry: {
        existingSecret: 'platform-harbor-registry',
        credentials: { existingSecret: 'platform-harbor-registry-credentials' },
      },
      database: { type: 'internal' },
      redis: { type: 'internal' },
    });
  });

  it('rejects external Secret names owned by the official chart', () => {
    const invalid = HarborProductionInstallationConfigSchema({
      ...productionConfig(),
      componentSecrets: { ...secrets, core: 'harbor-core' },
    });
    expect(invalid instanceof type.errors).toBe(true);
    expect(String(invalid)).toContain('chart-owned Secret harbor-core');
  });

  it('deep-merges advanced values last without mutating or aliasing caller input', () => {
    const customValues = {
      core: { resources: { requests: { cpu: '333m' } } },
      portal: { podLabels: { team: 'platform' } },
    };
    const before = structuredClone(customValues);
    const values = mapHarborLocalInstallationToHelmValues(
      localConfig({ values: customValues })
    ) as Record<string, unknown>;
    expect(customValues).toEqual(before);
    (values.portal as { podLabels: { team: string } }).podLabels.team = 'changed';
    expect(customValues.portal.podLabels.team).toBe('platform');
    expect(values).toMatchObject({
      core: {
        existingSecret: 'platform-harbor-core',
        resources: { requests: { cpu: '333m' } },
      },
    });
  });

  it('requires production external state, HA replicas, and TLS safety', () => {
    const invalid = HarborProductionInstallationConfigSchema({
      ...productionConfig(),
      exposure: {
        type: 'clusterIP',
        externalUrl: 'http://harbor.harbor-system.svc',
        tls: { enabled: false, source: 'none' },
      },
      replicas: { core: 1, portal: 2, registry: 2, jobservice: 2, exporter: 2 },
    });
    expect(invalid instanceof type.errors).toBe(true);
    expect(() =>
      mapHarborProductionInstallationToHelmValues({
        ...productionConfig(),
        exposure: {
          type: 'clusterIP',
          externalUrl: 'http://harbor.harbor-system.svc',
          tls: { enabled: false, source: 'none' },
        },
      } as unknown as HarborProductionInstallationConfig)
    ).toThrow('Production Harbor requires TLS exposure');
  });

  it('maps the HA-oriented profile to external PostgreSQL and Valkey with PDBs', () => {
    const values = mapHarborProductionInstallationToHelmValues(productionConfig());
    expect(values).toMatchObject({
      database: {
        type: 'external',
        external: {
          host: 'harbor-rw.database.svc',
          port: '5432',
          username: 'harbor',
          coreDatabase: 'harbor',
          existingSecret: 'harbor-database',
          sslmode: 'verify-full',
        },
      },
      redis: {
        type: 'external',
        external: {
          addr: 'valkey-primary.valkey.svc:6379',
          existingSecret: 'harbor-valkey',
          coreDatabaseIndex: '0',
          jobserviceDatabaseIndex: '1',
          registryDatabaseIndex: '2',
          trivyAdapterIndex: '5',
          tlsOptions: { enable: true, caBundleSecretName: 'valkey-ca' },
        },
      },
      core: { replicas: 2, podDisruptionBudget: { enabled: true, minAvailable: 1 } },
      registry: { replicas: 2, podDisruptionBudget: { enabled: true, minAvailable: 1 } },
    });
  });

  it('preserves advanced production values without permitting safety overrides', () => {
    const values = mapHarborProductionInstallationToHelmValues({
      ...productionConfig(),
      values: {
        expose: { tls: { enabled: false }, customAnnotation: 'preserved' },
        persistence: { imageChartStorage: { s3: { skipverify: true } } },
        core: { replicas: 1, podLabels: { team: 'platform' } },
        database: { type: 'internal' },
        redis: { type: 'internal' },
      },
    });
    expect(values).toMatchObject({
      expose: { tls: { enabled: true }, customAnnotation: 'preserved' },
      persistence: { imageChartStorage: { s3: { secure: true, skipverify: false } } },
      core: { replicas: 2, podLabels: { team: 'platform' } },
      database: { type: 'external' },
      redis: { type: 'external' },
    });
  });

  it('renders direct mode without the optional cert-manager resource', () => {
    const yaml = harborLocalInstallation
      .factory('direct', { namespace: 'harbor-control' })
      .toYaml(localConfig({ namespace: 'harbor-workloads' }));
    expect(yaml).toContain('https://helm.goharbor.io');
    expect(yaml).toContain('chart: harbor');
    expect(yaml).toContain('version: 1.19.1');
    expect(yaml).toContain('existingSecret: harbor-s3');
    expect(yaml).not.toContain('kind: Certificate');
    expectCleanYaml(yaml);
  });

  it('emits cert-manager Certificate only when selected', () => {
    const config = localConfig({
      exposure: {
        type: 'ingress',
        externalUrl: 'https://harbor.orb.local',
        tls: { enabled: true, source: 'cert-manager' },
        ingress: { host: 'harbor.orb.local', className: 'nginx' },
      },
      certificate: {
        secretName: 'harbor-cert',
        issuerRef: { name: 'local-ca', kind: 'ClusterIssuer' },
      },
    });
    const yaml = harborLocalInstallation
      .factory('direct', { namespace: 'harbor-control' })
      .toYaml(config);
    expect(yaml).toContain('kind: Certificate');
    expect(yaml).toContain('secretName: harbor-cert');
    expect(yaml).toContain('certSource: secret');
    expectCleanYaml(yaml);
  });

  it('generates a KRO graph with graph-aware defaults and schema-complete status', () => {
    const yaml = harborLocalInstallation.factory('kro', { namespace: 'harbor-control' }).toYaml();
    expect(yaml).toContain(
      'harborRelease.status.observedGeneration >= harborRelease.metadata.generation'
    );
    expect(yaml).toContain(
      'c.status == "True" && (has(c.observedGeneration) ? c.observedGeneration >= harborRelease.metadata.generation : true)'
    );
    for (const field of [
      'ready',
      'failed',
      'phase',
      'endpoint',
      'chartVersion',
      'harborVersion',
      'profile',
      'observedGeneration',
      'tlsEnabled',
      'storageReady',
      'databaseReady',
      'cacheReady',
      'networkPolicyReady',
      'conditions',
    ]) {
      expect(yaml).toContain(`${field}:`);
    }
    expect(yaml).toContain('kind: Certificate');
    expect(yaml).toContain('- ${schema.spec.exposure.tls.source == "cert-manager"}');
    expect(yaml).not.toContain('depends-on-harborCertificate');
    expect(yaml).toContain('existingSecretAdminPassword');
    expect(yaml).toContain('imageChartStorage');
    expect(yaml).toContain('s3');
    for (const dependency of [
      'harborAdminCredentials',
      'harborEncryptionKey',
      'harborCoreCredentials',
      'harborJobserviceCredentials',
      'harborRegistryCredentials',
      'harborRegistryBasicAuth',
      'harborDatabaseCredentials',
      'harborCacheCredentials',
    ]) {
      expect(yaml).toContain(`depends-on-${dependency}`);
    }
    expect(yaml).toContain(
      'has(schema.spec.database) ? schema.spec.database.existingSecret : schema.spec.adminPasswordSecret.name'
    );
    expect(yaml).toContain(
      'has(schema.spec.cache) ? schema.spec.cache.existingSecret : schema.spec.adminPasswordSecret.name'
    );
    expect(yaml).toContain('has(schema.spec.database) && has(schema.spec.database.port)');
    expect(yaml).toContain('has(schema.spec.cache) && has(schema.spec.cache.tls)');
    expect(yaml).toContain('has(schema.spec.networkPolicy.ingressNamespaceLabels) ?');
    expect(yaml).toContain(
      'has(schema.spec.networkPolicy.egressNamespaceLabels) ? schema.spec.networkPolicy.egressNamespaceLabels : []'
    );
    expect(yaml).not.toContain('depends-on-harborNetworkPolicy');
    expect(yaml).not.toContain('depends-on-harborIngressNetworkPolicy');
    expectCleanYaml(yaml);
  });

  it('requires production network isolation before installing Harbor', () => {
    const yaml = harborProductionInstallation
      .factory('kro', { namespace: 'harbor-control' })
      .toYaml();
    expect(yaml).toContain('kind: NetworkPolicy');
    expect(yaml).toContain('depends-on-harborNetworkPolicy');
    expect(yaml).toContain('depends-on-harborIngressNetworkPolicy');
    expect(yaml).toContain('networkPolicyReady:');
    expect(yaml).toContain('enabled: boolean | validation="self == true"');
    expect(yaml).toContain('skipVerify: boolean | validation="self == false"');
    expect(yaml).toContain('exposure: HarborProductionInstallationExposure | validation=');
    expect(yaml).toContain('has(self.tls.secretName) && size(self.tls.secretName) > 0');
    expect(yaml).toContain(
      'certificate: HarborProductionInstallationCertificate | validation="size(self.secretName) > 0"'
    );
    expect(yaml).toContain('storage: HarborProductionInstallationStorage | validation=');
    expect(yaml).toContain(
      'networkPolicy: HarborProductionInstallationNetworkpolicy | validation='
    );
    expect(yaml).toContain(
      '(has(schema.spec.values) ? json.unmarshal(json.marshal(schema.spec.values)) : {}).merge'
    );
    expect(yaml).not.toContain('\\"type\\": \\"type\\" in');
    expect(yaml).not.toContain('enabled: string');
    expect(yaml).not.toContain('skipVerify: string');
    expect(yaml).toContain('from:');
    expect(yaml).not.toContain('_from:');
    expectCleanYaml(yaml);
  });

  it('owns custom repository namespaces unless callers explicitly declare them external', () => {
    const owned = harborLocalInstallation.factory('direct', { namespace: 'harbor-control' }).toYaml(
      localConfig({
        namespace: 'harbor-workloads',
        repositoryNamespace: 'harbor-sources',
      })
    );
    expect(owned).toMatch(/kind: Namespace[\s\S]*?name: harbor-sources/);
    expect(owned).toMatch(/name: harbor\n {2}namespace: harbor-sources/);

    const external = harborLocalInstallation
      .factory('direct', { namespace: 'harbor-control' })
      .toYaml(
        localConfig({
          namespace: 'harbor-workloads',
          repositoryNamespace: 'shared-sources',
          repositoryNamespaceOwnership: 'external',
        })
      );
    expect(external).not.toMatch(/kind: Namespace[\s\S]*?name: shared-sources/);
    expect(external).toMatch(/name: harbor\n {2}namespace: shared-sources/);

    const kroFactory = harborLocalInstallation.factory('kro', { namespace: 'harbor-control' });
    const kroOwned = kroFactory.toYaml(
      localConfig({
        namespace: 'harbor-workloads',
        repositoryNamespace: 'harbor-sources',
      })
    );
    expect(kroOwned).toContain(
      'typekro.io/hoisted-namespaces: \'["harbor-workloads","harbor-sources"]\''
    );

    const kroExternal = kroFactory.toYaml(
      localConfig({
        namespace: 'harbor-workloads',
        repositoryNamespace: 'shared-sources',
        repositoryNamespaceOwnership: 'external',
      })
    );
    expect(kroExternal).toContain('typekro.io/hoisted-namespaces: \'["harbor-workloads"]\'');
  });

  it('hoists same-namespace ownership outside KRO and honors an explicitly external namespace', () => {
    const factory = harborLocalInstallation.factory('kro', {
      namespace: 'harbor-system',
    });
    const owned = factory.toYaml(localConfig({ namespace: 'harbor-system' }));
    expect(owned).toContain("typekro.io/kro-instance-namespace: 'true'");
    expect(owned).toContain('kustomize.toolkit.fluxcd.io/prune: disabled');
    expect(owned).toContain('argocd.argoproj.io/sync-options: Prune=false,Delete=false');
    expect(owned).toContain('typekro.io/hoisted-namespaces: \'["harbor-system"]\'');

    const external = factory.toYaml(
      localConfig({ namespace: 'harbor-system', namespaceOwnership: 'external' })
    );
    expect(external).not.toContain('typekro.io/kro-instance-namespace');
    expect(external).toContain("typekro.io/hoisted-namespaces: '[]'");
  });

  it('preserves namespace hoisting through composition nesting', () => {
    const parent = kubernetesComposition(
      {
        name: 'nested-harbor-consumer',
        kind: 'NestedHarborConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const installation = harborLocalInstallation(localConfig({ namespace: 'harbor-system' }));
        return { ready: installation.status.ready };
      }
    );
    const yaml = parent.factory('kro', { namespace: 'harbor-system' }).toYaml({ name: 'consumer' });
    expect(yaml).toContain("typekro.io/kro-instance-namespace: 'true'");
    expect(yaml).toContain('typekro.io/hoisted-namespaces: \'["harbor-system"]\'');
  });

  it('hoists a singleton owner namespace before the owner and consumer instances', async () => {
    const consumer = kubernetesComposition(
      {
        name: 'singleton-harbor-consumer',
        kind: 'SingletonHarborConsumer',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const installation = singleton(harborLocalInstallation, {
          id: 'harbor-platform',
          spec: localConfig({ namespace: DEFAULT_SINGLETON_NAMESPACE }),
        });
        return { ready: installation.status.ready };
      }
    );
    const factory = consumer.factory('kro', { namespace: 'apps' });
    const spec = { name: 'consumer' };
    const yaml = factory.toYaml(spec);
    const namespaceIndex = yaml.indexOf('kind: Namespace');
    const ownerIndex = yaml.indexOf('kind: HarborLocalInstallation');
    const consumerIndex = yaml.indexOf('kind: SingletonHarborConsumer');

    expect(namespaceIndex).toBeGreaterThanOrEqual(0);
    expect(namespaceIndex).toBeLessThan(ownerIndex);
    expect(ownerIndex).toBeLessThan(consumerIndex);
    expect(yaml).toContain('typekro.io/hoisted-namespaces: \'["typekro-singletons"]\'');

    const declarations = await factory.toAlchemyResources(spec);
    expect(declarations[0]?.props.resource.kind).toBe('Namespace');
    expect(declarations[0]?.props.resource.metadata?.name).toBe(DEFAULT_SINGLETON_NAMESPACE);
  });

  it('exports focused and namespaced APIs', () => {
    expect(harborProductionInstallation).toBeDefined();
    expect(rootHarborNamespace.harborLocalInstallation).toBe(harborLocalInstallation);
  });
});
