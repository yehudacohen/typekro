/**
 * ClickStack bootstrap — cluster-gated integration suite.
 *
 * Mirrors test/integration/clickhouse/'s describeOrSkip pattern: the whole
 * suite SKIPS cleanly when no cluster is reachable (set
 * REQUIRE_CLUSTER_TESTS=true to force it on in CI environments that
 * guarantee a cluster).
 *
 * LIVE-PATH PREREQUISITES (best-effort; skipping without a cluster is the
 * hard requirement, a live pass needs all of these):
 * - A reachable Kubernetes cluster on the current kubeconfig context with
 *   the TypeKro runtime installed: Flux source/helm controllers (the
 *   compositions deploy HelmRepository/HelmRelease resources) — i.e. the
 *   `bun run scripts/e2e-setup.ts` environment.
 * - Outbound network access to pull the Altinity operator chart, the
 *   official clickstack chart (https://clickhouse.github.io/ClickStack-helm-charts)
 *   and images (mongo:7, HyperDX app, otel-collector-contrib).
 * - EXTERNAL CLICKHOUSE: this family is external-ClickHouse-only, so the
 *   suite deploys its own minimal prerequisite first — the Altinity operator
 *   plus a 1x1 `makeClickHouseCluster()` (small storage, no keeper) — and
 *   wires clickstack at the cluster's status-contract host. The operator's
 *   default user config must allow connections from the clickstack namespace
 *   (default operator settings do).
 *
 * The suite deploys in dependency order inside sequential `it` blocks
 * (operator → CHI → clickstack) and tears everything down in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { ensureNamespaceExists, isClusterAvailable } from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

describeOrSkip('ClickStack Bootstrap Composition Integration Tests', () => {
  let kubeConfig: any;
  let operatorFactory: any;
  let clickhouseFactory: any;
  let clickstackFactory: any;
  let operatorDeployed = false;
  let clickhouseDeployed = false;
  let clickstackDeployed = false;
  let clickhouseHost: string | undefined;

  const operatorNs = 'clickstack-test-op';
  const chiNs = 'clickstack-test-chi';
  const stackNs = 'clickstack-test-stack';

  const chiName = 'clickstack-e2e-ch';
  const stackName = 'clickstack-e2e';

  beforeAll(async () => {
    try {
      kubeConfig = getKubeConfig({ skipTLSVerify: true });
      await Promise.all([operatorNs, chiNs, stackNs].map((ns) => ensureNamespaceExists(ns, kubeConfig)));
    } catch (error) {
      console.error('❌ Failed to connect to cluster:', error);
      throw error;
    }
  });

  afterAll(async () => {
    // Teardown in reverse dependency order, best-effort: clickstack first
    // (its HelmRelease must uninstall while flux is still healthy), then the
    // CHI (while the operator can still process its finalizer), then the
    // operator, then the namespaces.
    if (clickstackFactory && clickstackDeployed) {
      await clickstackFactory.deleteInstance(stackName).catch(() => {});
    }
    if (clickhouseFactory && clickhouseDeployed) {
      await clickhouseFactory.deleteInstance(chiName).catch(() => {});
    }
    if (operatorFactory && operatorDeployed) {
      await operatorFactory
        .deleteInstance('clickhouse-operator', {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        })
        .catch(() => {});
    }

    const { deleteNamespaceAndWait } = await import('../shared-kubeconfig.js');
    await Promise.allSettled(
      [stackNs, chiNs, operatorNs].map((ns) => deleteNamespaceAndWait(ns, kubeConfig))
    );
  });

  it('deploys the Altinity operator (external-ClickHouse prerequisite)', async () => {
    const { clickhouseOperatorBootstrap } = await import(
      '../../../src/factories/clickhouse/index.js'
    );

    operatorFactory = clickhouseOperatorBootstrap.factory('direct', {
      namespace: operatorNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await operatorFactory.deploy({
      name: 'clickhouse-operator',
      namespace: operatorNs,
      version: '0.27.1',
      shared: false,
    });
    operatorDeployed = true;

    expect(instance.status.ready).toBe(true);
  }, 900000);

  it('deploys a minimal 1x1 external ClickHouse via makeClickHouseCluster', async () => {
    const { makeClickHouseCluster } = await import('../../../src/factories/clickhouse/index.js');

    // Lean prerequisite sizing: single shard/replica (no keeper), small PVC.
    const clickhouse = makeClickHouseCluster();
    clickhouseFactory = clickhouse.factory('direct', {
      namespace: chiNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    const instance = await clickhouseFactory.deploy({
      name: chiName,
      namespace: chiNs,
      version: '25.7',
      storage: { size: '1Gi' },
      podResources: {
        requests: { cpu: '100m', memory: '512Mi' },
        limits: { memory: '1Gi' },
      },
    });
    clickhouseDeployed = true;

    // The typed service contract from #93 is the wiring seam for clickstack.
    expect(instance.status.ready).toBe(true);
    expect(instance.status.clickhouse.host).toBe(
      `clickhouse-${chiName}.${chiNs}.svc.cluster.local`
    );
    clickhouseHost = instance.status.clickhouse.host;
  }, 900000);

  it('deploys clickstack wired at the external ClickHouse and hydrates the status contract', async () => {
    expect(clickhouseHost).toBeDefined();

    const { clickstackBootstrap } = await import('../../../src/factories/clickstack/index.js');

    clickstackFactory = clickstackBootstrap.factory('direct', {
      namespace: stackNs,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });

    // Internal-Mongo default variant; the operator's default user allows
    // in-cluster connections, so the collector's goose migrations can create
    // the otel_* tables in the external ClickHouse at startup.
    const instance = await clickstackFactory.deploy({
      name: stackName,
      namespace: stackNs,
      clickhouse: { host: clickhouseHost! },
      apiKey: 'clickstack-e2e-api-key',
    });
    clickstackDeployed = true;

    // Readiness is workload-aware (helm-controller waits for the chart's
    // HyperDX app + gateway collector before reporting Ready).
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');

    // The status/endpoint contract hydrates to the fullnameOverride-pinned
    // service names — downstream compositions consume these instead of
    // reconstructing chart naming rules.
    expect(instance.status.ui.url).toBe(`http://${stackName}.${stackNs}.svc.cluster.local:3000`);
    expect(instance.status.gateway.otlpHttpEndpoint).toBe(
      `http://${stackName}-otel-collector.${stackNs}.svc.cluster.local:4318`
    );
    expect(instance.status.gateway.otlpGrpcEndpoint).toBe(
      `http://${stackName}-otel-collector.${stackNs}.svc.cluster.local:4317`
    );
    expect(instance.status.app.host).toBe(`${stackName}.${stackNs}.svc.cluster.local`);
    expect(instance.status.app.appPort).toBe(3000);
    expect(instance.status.app.apiPort).toBe(8000);
  }, 1200000);

  it('generates ResourceGraphDefinition YAML with the connection-contract CEL preserved', async () => {
    const { clickstackBootstrap } = await import('../../../src/factories/clickstack/index.js');

    const yaml: string = clickstackBootstrap.toYaml();

    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: clickstack-bootstrap');
    expect(yaml).toContain('chart: clickstack');
    expect(yaml).toMatch(/ready: \$\{clickstackHelmRelease\.status\.conditions\.exists/);
    expect(yaml).toContain('otlpHttpEndpoint:');
    expect(yaml).toContain('driftDetection:');
    expect(yaml).toContain('mode: enabled');
  });
});
