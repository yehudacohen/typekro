import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { createBunCompatibleCustomObjectsApi } from '../../../src/core/kubernetes/index.js';
import { ensureNamespaceExists, isClusterAvailable } from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

// Live-verified: tearing down the operator + CHI + KRO graph + 5 namespaces
// exceeds bun's 5s default hook timeout on a real cluster.
setDefaultTimeout(300000);

describeOrSkip('ClickHouse Operator Bootstrap Composition Tests', () => {
  let kubeConfig: any;
  let factory: any;
  let operatorDeployed = false;
  const testNamespace = 'typekro-test-clickhouse-bootstrap';
  const operatorNs = 'clickhouse-test-op';
  const chiNs = 'clickhouse-test-chi';
  // KRO-mode namespaces: the instance CR lives in kroCrNs (factory
  // namespace), the CHI itself in kroNs (spec.namespace) — same split as the
  // searxng/dagster KRO-mode suites.
  const kroNs = 'clickhouse-test-kro';
  const kroCrNs = 'clickhouse-test-kro-cr';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await ensureNamespaceExists(testNamespace, kubeConfig);

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
    if (factory && operatorDeployed) {
      await factory
        .deleteInstance('clickhouse-operator', {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        })
        .catch(() => {});
    }

    // The shared Altinity HelmRepository singleton persists past
    // deleteInstance BY DESIGN (cluster-level Flux source). On an ephemeral
    // kind cluster that's moot; on a persistent cluster the suite sweeps its
    // own singleton artifact. Best-effort.
    try {
      const { createBunCompatibleKubernetesObjectApi } = await import(
        '../../../src/core/kubernetes/index.js'
      );
      const k8sApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
      await k8sApi
        .delete({
          apiVersion: 'source.toolkit.fluxcd.io/v1',
          kind: 'HelmRepository',
          metadata: { name: 'altinity', namespace: 'flux-system' },
        })
        .catch(() => {});
    } catch {
      // Best-effort singleton sweep only.
    }

    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
    await Promise.allSettled(
      [testNamespace, operatorNs, chiNs, kroNs, kroCrNs].map((ns) =>
        deleteNamespaceAndWait(ns, kubeConfig)
      )
    );
  });

  it('should deploy operator and hydrate all status fields', async () => {
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
    await ensureNamespaceExists(chiNs, kubeConfig);

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

    await ensureNamespaceExists(chiNs, kubeConfig);
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const chi = clickHouseInstallation({
      name: 'e2e-ch',
      namespace: chiNs,
      version: '25.3',
      shards: 1,
      replicas: 1,
      storage: { size: '1Gi' },
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
    const maxWait = 300000;
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

    // Cleanup the installation (operator stays for other tests)
    await customApi
      .deleteNamespacedCustomObject({
        group: 'clickhouse.altinity.com',
        version: 'v1',
        namespace: chiNs,
        plural: 'clickhouseinstallations',
        name: 'e2e-ch',
      })
      .catch(() => {});
  }, 900000);

  it('should deploy a cluster via the CURRENT public API (makeClickHouseCluster) and hydrate the connection contract', async () => {
    // The raw clickHouseInstallation() test above predates the
    // makeClickHouseCluster composition; this exercises the CURRENT public
    // surface end-to-end: direct factory deploy + the #93 typed connection
    // contract (host/nativeUrl/httpUrl/clusterName) hydrated from the live CHI.
    //
    // LIVE-VERIFIED SPLIT (found running this suite against a real cluster —
    // see the companion factory('kro') test below for the fully-hydrated
    // live CR proof): `ready`/`phase` and `installation.endpoint`/
    // `hostsCount`/`hostsCompletedCount` are built from PLAIN property
    // access on the CHI resource proxy (`clickhouse.status.*`) and DO
    // hydrate here, because direct mode's live-status re-execution re-runs
    // the composition function with the real resource substituted in and
    // these fields touch it as an ordinary JS value.
    //
    // `clickhouse.host`/`nativeUrl`/`httpUrl`/`clusterName` and
    // `installation.name`/`namespace` are different: they are built via a
    // RAW `Cel.expr("...literal CEL text...")` string that never touches
    // the real `clickhouse` resource object in JS (it's a hand-authored CEL
    // expression, required because plain proxy access on `.metadata.*`
    // gets misclassified as static/schema-derived and is dropped from KRO
    // status entirely — see the composition's doc comment). That technique
    // fixes KRO-mode reachability but is OPAQUE to direct mode's
    // re-execution, which has no CEL interpreter and can only hydrate
    // fields it can evaluate as plain JS against the live object. So in
    // `factory('direct')` mode ONLY, these five fields remain unresolved
    // `CelExpression` markers today — a genuine, narrow typekro limitation
    // (not a regression we can fix inside this factory; tracked as a
    // typekro#94 follow-up: "status derivations via the resources proxy
    // silently degrade to schema refs" is the sibling failure mode of the
    // same underlying gap). UPDATE: the root cause is fixed in typekro#97
    // (resource `.metadata.*` reads inside status builders no longer
    // silently degrade to schema refs); once that lands and this factory
    // bumps its typekro dependency, the raw `Cel.expr` workaround can be
    // dropped for natural proxy syntax, and this whole block collapses to
    // the same plain-property assertions as the resource-status fields
    // above. `factory('kro')` callers get the fully live
    // contract; `factory('direct')` callers needing these strings can
    // build them from `spec.name`/`spec.namespace`, which they already have
    // synchronously (the same naming rule, documented on the status type).
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');
    const { isCelExpression } = await import('../../../src/utils/type-guards.js');

    await ensureNamespaceExists(chiNs, kubeConfig);

    const clusterFactory = makeClickHouseCluster().factory('direct', {
      namespace: chiNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    try {
      const instance = await clusterFactory.deploy({
        name: 'e2e-cluster',
        namespace: chiNs,
        version: '25.7',
        storage: { size: '1Gi' },
        podResources: {
          requests: { cpu: '100m', memory: '512Mi' },
          limits: { memory: '1Gi' },
        },
      });

      // Resource-status-derived fields DO hydrate in direct mode.
      expect(instance.status.ready).toBe(true);
      expect(instance.status.phase).toBe('Ready');
      expect(instance.status.installation.endpoint).toBe(
        `clickhouse-e2e-cluster.${chiNs}.svc.cluster.local`
      );
      expect(instance.status.installation.hostsCount).toBe(1);

      // Metadata/spec-derived CEL-string fields do NOT hydrate in direct
      // mode today (see the block comment above) — assert the documented
      // reality rather than a value the framework cannot yet produce here.
      for (const value of [
        instance.status.clickhouse.host,
        instance.status.clickhouse.nativeUrl,
        instance.status.clickhouse.httpUrl,
        instance.status.clickhouse.clusterName,
        instance.status.installation.name,
        instance.status.installation.namespace,
      ]) {
        expect(isCelExpression(value)).toBe(true);
      }
      // The unresolved marker still carries the RIGHT expression text — the
      // KRO-mode serialization for the SAME field is exactly this string
      // (confirmed against the live KRO CR status in the companion test).
      expect((instance.status.clickhouse.host as unknown as { expression: string }).expression).toBe(
        '"clickhouse-" + clickhouse.metadata.name + "." + clickhouse.metadata.namespace + ".svc.cluster.local"'
      );
    } finally {
      // Cleanup the cluster instance (operator stays for other tests).
      await clusterFactory.deleteInstance('e2e-cluster').catch(() => {});
    }
  }, 900000);

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
    await ensureNamespaceExists(kroNs, kubeConfig);
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const kroFactory = makeClickHouseCluster().factory('kro', {
      namespace: kroCrNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instanceName = 'kro-cluster';
    let deployed = false;

    try {
      const instance = await kroFactory.deploy({
        name: instanceName,
        namespace: kroNs,
        version: '25.7',
        storage: { size: '1Gi' },
        podResources: {
          requests: { cpu: '100m', memory: '512Mi' },
          limits: { memory: '1Gi' },
        },
      });
      deployed = true;

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

      console.log(
        '🔎 LIVE ClickHouseCluster CR status:',
        JSON.stringify(liveCr?.status, null, 2)
      );

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
      if (deployed) {
        // Self-cleaning: deleteInstance removes the CR (waits for KRO's
        // finalizer), then — as the only instance — the RGD and the
        // generated CRD.
        await kroFactory.deleteInstance(instanceName);
      }
    }

    // Teardown assertions: instance CR, RGD, and generated CRD are gone.
    await expect(
      customApi.getNamespacedCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        namespace: kroCrNs,
        plural: 'clickhouseclusters',
        name: instanceName,
      })
    ).rejects.toThrow();

    await expect(
      customApi.getClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name: 'clickhouse-cluster',
      })
    ).rejects.toThrow();

    // The CHI child is deleted by KRO's graph deletion (the operator's
    // finalizer may lag a beat — poll to a short deadline).
    const chiGoneDeadline = Date.now() + 120000;
    let chiGone = false;
    while (!chiGone && Date.now() < chiGoneDeadline) {
      try {
        await customApi.getNamespacedCustomObject({
          group: 'clickhouse.altinity.com',
          version: 'v1',
          namespace: kroNs,
          plural: 'clickhouseinstallations',
          name: instanceName,
        });
        await new Promise((r) => setTimeout(r, 5000));
      } catch {
        chiGone = true;
      }
    }
    expect(chiGone).toBe(true);
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
