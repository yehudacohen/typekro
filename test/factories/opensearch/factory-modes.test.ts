import { loadAll } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import {
  makeOpenSearchCluster,
  openSearchCluster,
  openSearchOperatorBootstrap,
  openSearchOperatorInstallation,
} from '../../../src/factories/opensearch/index.js';
import { openSearchClusterReadinessEvaluator } from '../../../src/factories/opensearch/resources/cluster.js';

function documents(yaml: string): Record<string, unknown>[] {
  return loadAll(yaml).filter(
    (document): document is Record<string, unknown> =>
      document !== null && typeof document === 'object'
  );
}

describe('OpenSearch integration', () => {
  test('waits for every declared node before reporting direct readiness', () => {
    const progressing = openSearchClusterReadinessEvaluator({
      spec: {
        general: { version: '3.2.0' },
        nodePools: [{ replicas: 3 }],
      },
      status: {
        initialized: true,
        availableNodes: 1,
        health: 'yellow',
        version: '3.2.0',
      },
    });
    const ready = openSearchClusterReadinessEvaluator({
      spec: {
        general: { version: '3.2.0' },
        nodePools: [{ replicas: 3 }],
      },
      status: {
        initialized: true,
        availableNodes: 3,
        health: 'green',
        version: '3.2.0',
      },
    });
    expect(progressing.ready).toBe(false);
    expect(ready.ready).toBe(true);
  });

  test('waits for the operator-observed version before completing an upgrade', () => {
    const stale = openSearchClusterReadinessEvaluator({
      spec: {
        general: { version: '3.2.0' },
        nodePools: [{ replicas: 3 }],
      },
      status: {
        initialized: true,
        availableNodes: 3,
        health: 'green',
        version: '3.1.0',
      },
    });
    expect(stale).toMatchObject({
      ready: false,
      reason: 'VersionProgressing',
    });
    expect(stale.message).toContain('version=3.1.0');
    expect(stale.message).toContain('desiredVersion=3.2.0');
  });

  test('emits a bounded development cluster in direct mode', () => {
    const yaml = openSearchCluster
      .factory('direct', {
        namespace: 'typekro-system',
      })
      .toYaml({
        name: 'search',
        namespace: 'search-system',
        storage: { size: '10Gi', storageClassName: 'local-path' },
        tls: { source: 'generated' },
        adminCredentialsSecret: { name: 'search-admin' },
        dashboardCredentialsSecret: { name: 'search-dashboards' },
      });
    expect(yaml).toContain('apiVersion: opensearch.org/v1');
    expect(yaml).toContain('kind: OpenSearchCluster');
    expect(yaml).toContain('name: search-system');
    expect(yaml).toContain('replicas: 3');
    expect(yaml).toContain('diskSize: 10Gi');
    expect(yaml).toContain('storageClass: local-path');
    expect(yaml).toContain('generate: true');
    expect(yaml).toContain('opensearchCredentialsSecret:');
    expect(yaml).toContain('name: search-dashboards');
    expect(yaml).not.toContain('__typekro');
  });

  test('rejects unsupported single-node topologies before deployment', () => {
    expect(() => makeOpenSearchCluster({ nodes: 1 })).toThrow('requires at least three nodes');
  });

  test('rejects a single node pool without cluster-manager-capable nodes', () => {
    expect(() => makeOpenSearchCluster({ roles: ['data'] })).toThrow(
      'roles must include cluster_manager'
    );
  });

  test('requires a PDB to preserve at least one node', () => {
    expect(() =>
      makeOpenSearchCluster({
        podDisruptionBudget: { minAvailable: 0 },
      })
    ).toThrow('must preserve at least one available node');
  });

  test('makes retained storage require an externally owned namespace by construction', () => {
    const yaml = openSearchCluster
      .factory('direct', {
        namespace: 'typekro-system',
      })
      .toYaml({
        name: 'retained',
        namespace: 'retained-search',
        lifecycle: 'external-retain',
        storage: { size: '20Gi' },
        tls: { source: 'generated' },
      });
    expect(
      documents(yaml).some(
        (document) =>
          document.kind === 'Namespace' &&
          (document.metadata as { name?: string })?.name === 'retained-search'
      )
    ).toBe(false);
    expect(yaml).toContain('typekro.dev/storage-retention');
  });

  test('emits production PDB, network isolation, cert-manager, and snapshots', () => {
    const cluster = makeOpenSearchCluster({
      profile: 'production',
      tls: 'cert-manager',
      snapshots: true,
      snapshotCredentialKeys: {
        accessKey: 'access',
        secretKey: 'secret',
      },
      networkPolicy: {
        enabled: true,
        ingressNamespaceLabels: {
          'kubernetes.io/metadata.name': 'application-system',
        },
        egressCidrs: ['10.0.0.0/8'],
      },
    });
    const yaml = cluster
      .factory('direct', {
        namespace: 'typekro-system',
      })
      .toYaml({
        name: 'evidence',
        namespace: 'search-system',
        lifecycle: 'external-retain',
        storage: { size: '100Gi', storageClassName: 'fast' },
        tls: {
          source: 'cert-manager',
          secretName: 'evidence-http-tls',
          adminSecretName: 'evidence-admin-tls',
          adminDn: ['CN=opensearch-admin'],
          issuerName: 'platform-ca',
          issuerKind: 'ClusterIssuer',
          dnsNames: ['evidence.search.example.com'],
        },
        snapshots: {
          repository: 'snapshots',
          bucket: 'evidence-search',
          endpoint: 'https://s3.example.com',
          credentialsSecret: {
            name: 'snapshot-credentials',
          },
        },
        monitoring: true,
      });
    expect(yaml).toContain('kind: Certificate');
    expect(yaml).toContain('secretName: evidence-http-tls');
    expect(yaml).toContain('kind: NetworkPolicy');
    expect(yaml).toContain('kubernetes.io/metadata.name: opensearch-operator-system');
    expect(yaml).toContain('kubernetes.io/metadata.name: application-system');
    expect(yaml).toContain('10.0.0.0/8');
    expect(yaml).toContain('minAvailable: 2');
    expect(yaml).toContain('repository-s3');
    expect(yaml).toContain('s3.client.default.access_key');
    expect(yaml).toContain('name: snapshots');
    expect(yaml).toContain('adminSecret:');
    expect(yaml).toContain('name: evidence-admin-tls');
  });

  test('serializes a complete KRO status and runtime spec contract', () => {
    const cluster = makeOpenSearchCluster({
      tls: 'secret',
      snapshots: true,
    });
    const factory = cluster.factory('kro', {
      namespace: 'typekro-system',
    });
    const yaml = factory.toYaml();
    const instance = factory.toYaml({
      name: 'search',
      namespace: 'search-system',
      lifecycle: 'external-retain',
      storage: { size: '20Gi' },
      tls: {
        source: 'secret',
        secretName: 'http-tls',
        adminSecretName: 'admin-tls',
        adminDn: ['CN=opensearch-admin'],
      },
      snapshots: {
        repository: 'snapshots',
        bucket: 'search',
        credentialsSecret: { name: 'snapshot-credentials' },
      },
    });
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('OpenSearchClusterInstallation');
    expect(yaml).not.toContain('__KUBERNETES_REF__');
    expect(yaml).toContain('${schema.spec.storage.size}');
    expect(yaml).toContain(
      'adminDn: \'[]string | minLength=1 | minItems=1 validation="size(self) > 0 && self.all(dn, size(dn) > 0)"\''
    );
    expect(yaml).toContain('${cluster.status.availableNodes}');
    expect(yaml).toContain('${cluster.status.health}');
    expect(yaml).toContain('${cluster.status.version}');
    expect(yaml).toContain('cluster.status.version == cluster.spec.general.version');
    expect(yaml).not.toContain('version: ${cluster.spec.general.version}');
    expect(yaml).toContain('cluster.spec.security.config.adminCredentialsSecret.name != ""');
    expect(yaml).toContain('cluster.spec.general.snapshotRepositories.size() > 0');
    expect(yaml).toContain('credentialsSecret:');
    expect(yaml).toContain('snapshotRepository:');
    expect(instance).toContain('kind: OpenSearchClusterInstallation');
    expect(instance).toContain('lifecycle: external-retain');

    const ownedInstance = factory.toYaml({
      name: 'owned',
      namespace: 'owned-search',
      lifecycle: 'owned-delete',
      storage: { size: '20Gi' },
      tls: {
        source: 'secret',
        secretName: 'http-tls',
        adminSecretName: 'admin-tls',
        adminDn: ['CN=opensearch-admin'],
      },
      snapshots: {
        repository: 'snapshots',
        bucket: 'search',
        credentialsSecret: { name: 'snapshot-credentials' },
      },
    });
    expect(ownedInstance).toContain('kind: Namespace');
    expect(instance).not.toContain('kind: Namespace');
  });

  test('owns the operator repository once and defaults shared lifecycle', () => {
    const factory = openSearchOperatorBootstrap.factory('kro', {
      namespace: 'typekro-system',
    });
    const yaml = factory.toYaml();
    const instance = factory.toYaml({
      name: 'opensearch-operator',
    });
    expect(yaml).toContain('opensearch-operator-bootstrap');
    expect(yaml).toContain('opensearch-operator-installation');
    expect(yaml).toContain('opensearch-helm-repository');
    expect(yaml).toContain('3.0.2');
    expect(yaml).toContain('version: ${operatorRelease.spec.chart.spec.version}');
    expect(instance).toContain('kind: OpenSearchOperatorBootstrap');
    expect(instance).toContain('kind: OpenSearchOperatorInstallation');
    expect(instance).toContain('namespace: typekro-singletons');
  });

  test('exposes local operator ownership only through the explicit installation composition', () => {
    const yaml = openSearchOperatorInstallation
      .factory('kro', {
        namespace: 'operator-control',
      })
      .toYaml({
        name: 'local-opensearch-operator',
        namespace: 'local-opensearch-operator-system',
      });
    expect(yaml).toContain('kind: OpenSearchOperatorInstallation');
    expect(yaml).toContain('name: local-opensearch-operator-system');
    expect(yaml).toContain('kind: OpenSearchHelmRepository');
    expect(yaml).toContain('namespace: typekro-singletons');
    expect(yaml).not.toContain('kind: OpenSearchOperatorBootstrap');
  });

  test('omits an all-namespace ingress rule when caller labels are absent', () => {
    const yaml = makeOpenSearchCluster({
      networkPolicy: { enabled: true },
    })
      .factory('direct', {
        namespace: 'typekro-system',
      })
      .toYaml({
        name: 'isolated',
        namespace: 'isolated-search',
        storage: { size: '20Gi' },
        tls: { source: 'generated' },
      });
    expect(yaml).not.toContain('matchLabels: {}');
    expect(yaml).toContain('kubernetes.io/metadata.name: opensearch-operator-system');
  });

  test('requires a non-empty external TLS admin DN in direct and KRO inputs', () => {
    const direct = makeOpenSearchCluster({ tls: 'secret' }).factory('direct', {
      namespace: 'typekro-system',
    });
    expect(() =>
      direct.toYaml({
        name: 'search',
        namespace: 'search-system',
        storage: { size: '20Gi' },
        tls: {
          source: 'secret',
          secretName: 'http-tls',
          adminSecretName: 'admin-tls',
          adminDn: [],
        },
      })
    ).toThrow();

    const kro = makeOpenSearchCluster({ tls: 'cert-manager' }).factory('kro', {
      namespace: 'typekro-system',
    });
    expect(() =>
      kro.toYaml({
        name: 'search',
        namespace: 'search-system',
        storage: { size: '20Gi' },
        tls: {
          source: 'cert-manager',
          secretName: 'http-tls',
          adminSecretName: 'admin-tls',
          adminDn: [],
          issuerName: 'platform-ca',
          dnsNames: ['search.example.test'],
        },
      })
    ).toThrow();
  });

  test('rejects an empty operator namespace in a NetworkPolicy topology', () => {
    expect(() =>
      makeOpenSearchCluster({
        profile: 'production',
        networkPolicy: {
          enabled: true,
          operatorNamespace: '',
          ingressNamespaceLabels: {
            'kubernetes.io/metadata.name': 'application-system',
          },
        },
      })
    ).toThrow(/operatorNamespace/);
  });
});
