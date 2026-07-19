import { describe, expect, it } from 'bun:test';
import { type } from 'arktype';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_SINGLETON_NAMESPACE, singleton } from '../../../src/core/singleton/singleton.js';
import { harbor as rootHarborNamespace } from '../../../src/factories/index.js';
import {
  DEFAULT_HARBOR_CHART_VERSION,
  DEFAULT_HARBOR_VERSION,
  harborHelmRelease,
  harborLocalInstallation,
  HarborProductionInstallationConfigSchema,
  harborProductionInstallation,
  mapHarborLocalInstallationToHelmValues,
  mapHarborProductionInstallationToHelmValues,
} from '../../../src/factories/harbor/index.js';
import type {
  HarborLocalInstallationConfig,
  HarborProductionInstallationConfig,
} from '../../../src/factories/harbor/types.js';

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
    ]) {
      expect(yaml).toContain(`depends-on-${dependency}`);
    }
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
    expect(yaml).toContain('certificate: HarborProductionInstallationCertificate | validation="size(self.secretName) > 0"');
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

  it('preserves namespace safety for singleton owner instances', () => {
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
    expect(() =>
      consumer.factory('kro', { namespace: 'apps' }).toYaml({ name: 'consumer' })
    ).toThrow('cannot also be an owned Namespace');
  });

  it('exports focused and namespaced APIs', () => {
    expect(harborProductionInstallation).toBeDefined();
    expect(rootHarborNamespace.harborLocalInstallation).toBe(harborLocalInstallation);
  });
});
