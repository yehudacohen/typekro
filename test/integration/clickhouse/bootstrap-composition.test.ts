import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import {
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  isClusterAvailable,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

// Live-verified: tearing down the operator + CHI + KRO graph + 5 namespaces
// exceeds bun's 5s default hook timeout on a real cluster.
setDefaultTimeout(1500000);

describeOrSkip('ClickHouse Operator Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  let factory: any;
  let operatorDeployed = false;
  let reuseExistingOperator = false;
  let helmRepositoryPreexisting = false;
  const runId = crypto.randomUUID().slice(0, 8);
  const testNamespace = `typekro-test-clickhouse-${runId}`;
  const operatorNs = `clickhouse-test-op-${runId}`;
  const existingOperatorNs = 'clickhouse-system';
  const chiNs = `clickhouse-test-chi-${runId}`;
  // KRO-mode namespaces: the instance CR lives in kroCrNs (factory
  // namespace), the CHI itself in kroNs (spec.namespace) — same split as the
  // searxng/dagster KRO-mode suites.
  const kroNs = `clickhouse-test-kro-${runId}`;
  const kroCrNs = `clickhouse-test-kro-cr-${runId}`;
  const storageClass = process.env.TYPEKRO_TEST_STORAGE_CLASS;
  const namespaceLeases: TestNamespaceLease[] = [];

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      namespaceLeases.push(
        ...(await Promise.all(
          [testNamespace, operatorNs, chiNs, kroNs, kroCrNs].map((namespace) =>
            createTestNamespace(namespace, kubeConfig)
          )
        ))
      );

      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      try {
        await customApi.getNamespacedCustomObject({
          group: 'helm.toolkit.fluxcd.io',
          version: 'v2',
          namespace: existingOperatorNs,
          plural: 'helmreleases',
          name: 'clickhouse-operator',
        });
        reuseExistingOperator = true;
      } catch {
        // No canonical operator is installed; this suite owns a temporary one.
      }

      try {
        await customApi.getNamespacedCustomObject({
          group: 'source.toolkit.fluxcd.io',
          version: 'v1',
          namespace: 'flux-system',
          plural: 'helmrepositories',
          name: 'altinity',
        });
        helmRepositoryPreexisting = true;
      } catch {
        // The temporary bootstrap will create and later remove the repository.
      }

      const { clickhouseOperatorBootstrap } = await import(
        '../../../src/factories/clickhouse/compositions/clickhouse-operator-bootstrap.js'
      );

      factory = clickhouseOperatorBootstrap.factory('direct', {
        namespace: testNamespace,
        waitForReady: true,
        timeout: 600000,
        kubeConfig,
      });
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    if (factory && operatorDeployed) {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        'clickhouse-operator',
        [],
        kubeConfig,
        60_000,
        {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        }
      ).catch((error) => cleanupErrors.push(error));
    }

    // The shared Altinity HelmRepository singleton persists past
    // deleteInstance BY DESIGN. Remove it only when this suite created it;
    // deleting a pre-existing source would break the cluster's shared
    // operator release on persistent environments such as OrbStack.
    if (!helmRepositoryPreexisting) {
      await deleteTestResourceAndWait(
        {
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'HelmRepository',
          metadata: { name: 'altinity', namespace: 'flux-system' },
        },
        kubeConfig
      ).catch((error) => cleanupErrors.push(error));
    }

    const namespaceResults = await Promise.allSettled(
      namespaceLeases.map((lease) => deleteTestNamespaceAndWait(lease, kubeConfig))
    );
    cleanupErrors.push(
      ...namespaceResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'ClickHouse integration cleanup failed');
    }
  });

  it('should deploy operator and hydrate all status fields', async () => {
    if (reuseExistingOperator) {
      const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
      const raw: any = await customApi.getNamespacedCustomObject({
        group: 'helm.toolkit.fluxcd.io',
        version: 'v2',
        namespace: existingOperatorNs,
        plural: 'helmreleases',
        name: 'clickhouse-operator',
      });
      const helmRelease = raw?.body ?? raw;
      const ready = helmRelease.status?.conditions?.some(
        (condition: any) => condition.type === 'Ready' && condition.status === 'True'
      );

      expect(ready).toBe(true);
      expect(helmRelease.spec?.chart?.spec?.version).toBe('0.27.1');
      console.log(`✅ Reusing ready cluster operator clickhouse-operator in ${existingOperatorNs}`);
      return;
    }

    const instance = await factory.deploy({
      name: 'clickhouse-operator',
      namespace: operatorNs,
      version: '0.27.1',
      shared: false,
      // WATCH SCOPE (verified live): with an empty watch include list the
      // operator watches ONLY its own namespace unless it runs in
      // kube-system — a CHI in any other namespace is silently ignored.
      // Scope the watch explicitly to the suite's CHI namespaces (an
      // explicit list, not '.*', to stay polite on persistent/shared
      // clusters).
      customValues: {
        configs: {
          files: {
            'config.yaml': {
              watch: { namespaces: { include: [chiNs, kroNs] } },
            },
          },
        },
      },
    });
    operatorDeployed = true;

    // Spec fields
    expect(instance.spec.name).toBe('clickhouse-operator');
    expect(instance.spec.namespace).toBe(operatorNs);
    expect(instance.spec.version).toBe('0.27.1');

    // All status fields — hydrated after waitForReady
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.version).toBe('0.27.1');
  }, 900000);

  it('should make ClickHouse CRDs available after operator deploy', async () => {
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const result: any = await customApi.listNamespacedCustomObject({
      group: 'clickhouse.altinity.com',
      version: 'v1',
      namespace: chiNs,
      plural: 'clickhouseinstallations',
    });

    const items = result?.body?.items ?? result?.items ?? [];
    expect(Array.isArray(items)).toBe(true);
  }, 60000);

  it('should create a ClickHouse installation via typed factory', async () => {
    const { clickHouseInstallation } = await import(
      '../../../src/factories/clickhouse/resources/installation.js'
    );

    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const chi = clickHouseInstallation({
      name: 'e2e-ch',
      namespace: chiNs,
      version: '25.3',
      shards: 1,
      replicas: 1,
      storage: {
        size: '1Gi',
        ...(storageClass && { storageClassName: storageClass }),
      },
      podResources: {
        requests: { cpu: '100m', memory: '512Mi' },
        limits: { memory: '1Gi' },
      },
      id: 'e2eClickhouse',
    });

    // Typed assertions before apply
    expect(chi.kind).toBe('ClickHouseInstallation');
    expect(chi.spec.configuration?.clusters?.[0]?.name).toBe('cluster');
    expect(chi.spec.configuration?.clusters?.[0]?.layout?.replicasCount).toBe(1);

    await customApi.createNamespacedCustomObject({
      group: 'clickhouse.altinity.com',
      version: 'v1',
      namespace: chiNs,
      plural: 'clickhouseinstallations',
      body: {
        apiVersion: chi.apiVersion,
        kind: chi.kind,
        metadata: { name: chi.metadata.name, namespace: chiNs },
        spec: chi.spec,
      },
    });

    // Poll readiness using the typed evaluator (status.status == 'Completed').
    const maxWait = 600000;
    const start = Date.now();
    let lastStatus: any = null;

    while (Date.now() - start < maxWait) {
      const live: any = await customApi.getNamespacedCustomObject({
        group: 'clickhouse.altinity.com',
        version: 'v1',
        namespace: chiNs,
        plural: 'clickhouseinstallations',
        name: 'e2e-ch',
      });

      const liveResource = live?.body ?? live;
      lastStatus = chi.readinessEvaluator?.(liveResource);

      if (lastStatus?.ready) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    expect(lastStatus?.ready).toBe(true);
    expect(lastStatus?.reason).toBe('Completed');

    // Cleanup the exact fixture resource (operator stays for other tests).
    await deleteTestResourceAndWait(
      {
        apiVersion: 'clickhouse.altinity.com/v1',
        kind: 'ClickHouseInstallation',
        metadata: { name: 'e2e-ch', namespace: chiNs },
      },
      kubeConfig,
      180_000
    );
  }, 1200000);

  it('should deploy a cluster via the CURRENT public API (makeClickHouseCluster) and hydrate the connection contract', async () => {
    // The raw clickHouseInstallation() test above predates the
    // makeClickHouseCluster composition; this exercises the CURRENT public
    // surface end-to-end: direct factory deploy + the #93 typed connection
    // contract (host/nativeUrl/httpUrl/clusterName) hydrated from the live CHI.
    //
    // BIMODAL HYDRATION (live-verified on typekro 0.24.0). The whole
    // connection contract hydrates to concrete strings in direct mode:
    //   - metadata-anchored fields (`host`/`nativeUrl`/`httpUrl`,
    //     `installation.name`/`namespace`) are NATURAL JS template literals
    //     over the CHI proxy — direct mode's live-status re-execution
    //     evaluates them against the real resource;
    //   - the deep resource-path fields kept as raw `Cel.expr`
    //     (`clusterName`, `keeper.host`) resolve too — direct mode's
    //     reference resolver (cel-js) evaluates a resource-path CEL
    //     expression against the live resource read;
    //   - `ready`/`phase`/`installation.endpoint`/`hostsCount`/
    //     `hostsCompletedCount` hydrate via plain `clickhouse.status.*` reads.
    // This is the improvement over the pre-0.24.0 raw-`Cel.expr` gap
    // (typekro#94), where these came back as unresolved CelExpression markers.
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');

    const clusterFactory = makeClickHouseCluster().factory('direct', {
      namespace: chiNs,
      waitForReady: true,
      timeout: 900000,
      kubeConfig,
    });

    try {
      const instance = await clusterFactory.deploy({
        name: 'e2e-cluster',
        namespace: chiNs,
        version: '25.7',
        storage: {
          size: '1Gi',
          ...(storageClass && { storageClassName: storageClass }),
        },
        podResources: {
          requests: { cpu: '100m', memory: '512Mi' },
          limits: { memory: '1Gi' },
        },
      });

      // Resource-status-derived fields hydrate in direct mode.
      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Ready');
      expect(instance.status.installation.endpoint).toBe(
        `clickhouse-e2e-cluster.${chiNs}.svc.cluster.local`
      );
      expect(instance.status.installation.hostsCount).toBe(1);

      // The full connection contract hydrates to concrete strings.
      expect(instance.status.clickhouse.host).toBe(
        `clickhouse-e2e-cluster.${chiNs}.svc.cluster.local`
      );
      expect(instance.status.clickhouse.nativeUrl).toBe(
        `clickhouse://clickhouse-e2e-cluster.${chiNs}.svc.cluster.local:9000`
      );
      expect(instance.status.clickhouse.httpUrl).toBe(
        `http://clickhouse-e2e-cluster.${chiNs}.svc.cluster.local:8123`
      );
      expect(instance.status.clickhouse.clusterName).toBe('cluster');
      expect(instance.status.installation.name).toBe('e2e-cluster');
      expect(instance.status.installation.namespace).toBe(chiNs);
    } finally {
      // Cleanup the cluster instance (operator stays for other tests).
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        clusterFactory,
        'e2e-cluster',
        [],
        kubeConfig,
        60_000
      );
    }
  }, 1200000);

  it('should deploy a cluster via factory("kro") — RGD Active, KRO reconciles the CHI, LIVE CR status carries the connection contract', async () => {
    // KRO-mode counterpart of the direct-mode makeClickHouseCluster test:
    // the SAME composition goes through the RGD path — kro accepts the
    // (strict-CEL-clean) RGD, generates the ClickHouseCluster CRD, KRO
    // reconciles the CHI child, and — the point of the resource-anchored
    // status CEL — the LIVE instance CR's status carries the #93 connection
    // contract (host/nativeUrl/httpUrl/clusterName), not just the
    // client-hydrated proxy.
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');

    // The CHI's namespace must pre-exist: KRO applies children into
    // spec.namespace but the composition graph doesn't own a Namespace.
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const kroFactory = makeClickHouseCluster().factory('kro', {
      namespace: kroCrNs,
      waitForReady: true,
      timeout: 900000,
      kubeConfig,
    });

    const instanceName = 'kro-cluster';
    let deploymentAttempted = false;

    try {
      deploymentAttempted = true;
      const instance = await kroFactory.deploy({
        name: instanceName,
        namespace: kroNs,
        version: '25.7',
        storage: {
          size: '1Gi',
          ...(storageClass && { storageClassName: storageClass }),
        },
        podResources: {
          requests: { cpu: '100m', memory: '512Mi' },
          limits: { memory: '1Gi' },
        },
      });
      // Proxy-level contract (mixes KRO status + client-hydrated constants).
      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Ready');
      expect(instance.status.clickhouse.host).toBe(
        `clickhouse-${instanceName}.${kroNs}.svc.cluster.local`
      );

      // 1. The RGD reached Active on the live cluster.
      const rgdRaw: any = await customApi.getClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name: 'clickhouse-cluster',
      });
      const rgd = rgdRaw?.body ?? rgdRaw;
      expect(rgd.status?.state).toBe('Active');

      // 2. KRO created the CHI child and the operator completed it.
      const chiRaw: any = await customApi.getNamespacedCustomObject({
        group: 'clickhouse.altinity.com',
        version: 'v1',
        namespace: kroNs,
        plural: 'clickhouseinstallations',
        name: instanceName,
      });
      const chi = chiRaw?.body ?? chiRaw;
      expect(chi.metadata?.name).toBe(instanceName);
      expect(chi.status?.status).toBe('Completed');

      // 3. THE end-to-end proof of the status-reachability fix: the LIVE
      // instance CR (kubectl get clickhouseclusters -o json equivalent)
      // carries the resource-anchored connection contract in ITS status —
      // visible to GitOps/KRO consumers, not only to this client. KRO
      // projects status a reconcile after readiness, so poll briefly.
      const readLiveCr = async (): Promise<any> => {
        const raw: any = await customApi.getNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace: kroCrNs,
          plural: 'clickhouseclusters',
          name: instanceName,
        });
        return raw?.body ?? raw;
      };

      let liveCr = await readLiveCr();
      const statusDeadline = Date.now() + 120000;
      while (!liveCr?.status?.clickhouse?.host && Date.now() < statusDeadline) {
        await new Promise((r) => setTimeout(r, 5000));
        liveCr = await readLiveCr();
      }

      console.log('🔎 LIVE ClickHouseCluster CR status:', JSON.stringify(liveCr?.status, null, 2));

      expect(liveCr.status?.ready).toBe(true);
      expect(liveCr.status?.phase).toBe('Ready');
      expect(liveCr.status?.clickhouse?.host).toBe(
        `clickhouse-${instanceName}.${kroNs}.svc.cluster.local`
      );
      expect(liveCr.status?.clickhouse?.nativeUrl).toBe(
        `clickhouse://clickhouse-${instanceName}.${kroNs}.svc.cluster.local:9000`
      );
      expect(liveCr.status?.clickhouse?.httpUrl).toBe(
        `http://clickhouse-${instanceName}.${kroNs}.svc.cluster.local:8123`
      );
      expect(liveCr.status?.clickhouse?.clusterName).toBe('cluster');
      expect(liveCr.status?.installation?.name).toBe(instanceName);
      expect(liveCr.status?.installation?.namespace).toBe(kroNs);
    } finally {
      if (deploymentAttempted) {
        // Self-cleaning: deleteInstance removes the CR (waits for KRO's
        // finalizer), then — as the only instance — the RGD and the
        // generated CRD.
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          kroFactory,
          instanceName,
          [],
          kubeConfig,
          120_000
        );
      }
    }

    // Teardown assertions: instance CR, RGD, and CHI child are gone. TypeKro
    // intentionally retains the generated CRD in an Active, reusable state.
    // Each of these deletions is processed asynchronously by KRO/the operator
    // via finalizers and can lag a beat after `deleteInstance` returns — poll
    // each to a short deadline rather than asserting immediate absence.
    const pollGone = async (read: () => Promise<unknown>): Promise<boolean> => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        try {
          await read();
          await new Promise((r) => setTimeout(r, 5000));
        } catch {
          return true;
        }
      }
      return false;
    };

    // Instance CR gone.
    expect(
      await pollGone(() =>
        customApi.getNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace: kroCrNs,
          plural: 'clickhouseclusters',
          name: instanceName,
        })
      )
    ).toBe(true);

    // RGD gone (sole instance → the RGD is removed with it).
    expect(
      await pollGone(() =>
        customApi.getClusterCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          plural: 'resourcegraphdefinitions',
          name: 'clickhouse-cluster',
        })
      )
    ).toBe(true);

    // The CHI child is deleted by KRO's graph deletion.
    expect(
      await pollGone(() =>
        customApi.getNamespacedCustomObject({
          group: 'clickhouse.altinity.com',
          version: 'v1',
          namespace: kroNs,
          plural: 'clickhouseinstallations',
          name: instanceName,
        })
      )
    ).toBe(true);
  }, 1200000);

  it('should generate ResourceGraphDefinition YAML with CEL status expressions', async () => {
    const { clickhouseOperatorBootstrap } = await import(
      '../../../src/factories/clickhouse/compositions/clickhouse-operator-bootstrap.js'
    );

    const yaml: string = clickhouseOperatorBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: clickhouse-operator-bootstrap');
    expect(yaml).toContain('status:');
    expect(yaml).toContain('.exists(c, c.type == "Ready"');
    expect(yaml).toContain('Ready');
    expect(yaml).toContain('Installing');
    expect(yaml).toContain('chart: altinity-clickhouse-operator');
    expect(yaml).toContain('driftDetection:');
    expect(yaml).toContain('mode: enabled');
  });
});
