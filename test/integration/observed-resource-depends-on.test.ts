/**
 * Live proof for issue #187: a composition observing a resource its own release creates.
 *
 * The chart installed by the HelmRelease creates the Service. Reading that Service before the
 * release is applied is a guaranteed 404, so the read has to be scheduled behind the release.
 * Both cases here start from an EMPTY namespace, which is the only state where the bug shows:
 *
 *   - with `dependsOn(release)` the deployment succeeds and the observed Service hydrates status;
 *   - without it the deployment fails fast, before anything is applied, naming the resource.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(900_000);

import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/index.js';
import { observedResource } from '../../src/core/references/index.js';
import { helmRelease, helmRepository } from '../../src/factories/helm/index.js';
import { namespace } from '../../src/factories/kubernetes/index.js';
import {
  createCoreV1ApiClient,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  ensureFluxInstalled,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  runWithExpectedTestNamespace,
  TestFactoryCleanupRegistry,
  type TestNamespaceLease,
} from './shared-kubeconfig.js';

const TEST_TIMEOUT = 660_000;

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

const testRunId = Date.now().toString().slice(-6);
// Separate namespaces so the negative case cannot observe a Service the positive case installed.
const observedNamespace = `typekro-observed-${testRunId}`;
const unorderedNamespace = `typekro-unordered-${testRunId}`;
// `fullnameOverride` makes the chart-created Service name deterministic rather than
// release-name-derived, so the observed reference can name it up front.
const CHART_SERVICE_NAME = 'observed-nginx';

const ObservedChartSpec = type({
  name: 'string',
  namespace: 'string',
  repoName: 'string',
  releaseName: 'string',
});

const ObservedChartStatus = type({
  releaseName: 'string',
  serviceName: 'string',
  clusterIP: 'string',
});

/**
 * @param orderRead whether the observed Service declares `dependsOn(release)`. The composition is
 * otherwise identical, which is the point: the ordering declaration is the whole difference.
 */
function makeComposition(orderRead: boolean) {
  return kubernetesComposition(
    {
      name: orderRead ? 'observed-chart-service' : 'observed-chart-service-unordered',
      apiVersion: 'platform.example.com/v1alpha1',
      kind: orderRead ? 'ObservedChartService' : 'UnorderedObservedChartService',
      spec: ObservedChartSpec,
      status: ObservedChartStatus,
    },
    (spec) => {
      namespace({ id: 'appNamespace', metadata: { name: spec.namespace } });

      helmRepository({
        id: 'chartRepo',
        name: spec.repoName,
        namespace: 'flux-system',
        url: 'oci://registry-1.docker.io/bitnamicharts',
        type: 'oci',
      });

      const release = helmRelease({
        id: 'nginxRelease',
        name: spec.releaseName,
        namespace: spec.namespace,
        chart: {
          repository: 'oci://registry-1.docker.io/bitnamicharts',
          name: 'nginx',
          version: '22.5.0',
        },
        sourceRef: { name: spec.repoName, namespace: 'flux-system' },
        values: {
          fullnameOverride: CHART_SERVICE_NAME,
          replicaCount: 1,
          service: { type: 'ClusterIP' },
          ingress: { enabled: false },
          resources: { requests: { cpu: '50m', memory: '64Mi' } },
        },
      });

      const observed = observedResource<{ clusterIP: string }, Record<string, never>>({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: CHART_SERVICE_NAME, namespace: spec.namespace },
        id: 'chartService',
      });
      const chartService = orderRead ? observed.dependsOn(release) : observed;

      return {
        releaseName: release.metadata.name,
        serviceName: chartService.metadata.name,
        clusterIP: chartService.spec.clusterIP,
      };
    }
  );
}

describeOrSkip('observed resources created by the graph itself', () => {
  let kc: k8s.KubeConfig;
  let coreApi: k8s.CoreV1Api;
  let observedNamespaceLease: TestNamespaceLease | undefined;
  const cleanupRegistry = new TestFactoryCleanupRegistry();

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kc = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kc);
    await ensureFluxInstalled({ kubeConfig: kc, verbose: true });
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    await cleanupRegistry.cleanup(kc);
  });

  it(
    'fails fast, naming the observed resource, when the read is not ordered behind the release',
    async () => {
      const factory = await makeComposition(false).factory('direct', {
        namespace: unorderedNamespace,
        kubeConfig: kc,
        timeout: 120_000,
      });

      const deployment = factory.deploy({
        name: `unordered-${testRunId}`,
        namespace: unorderedNamespace,
        repoName: `bitnami-unordered-${testRunId}`,
        releaseName: `nginx-unordered-${testRunId}`,
      });

      await expect(deployment).rejects.toThrow(/Service\/observed-nginx/);

      // Nothing was applied: the read is fatal before the first apply, so the namespace the
      // composition would have created does not exist.
      await expect(coreApi.readNamespace({ name: unorderedNamespace })).rejects.toBeDefined();
    },
    TEST_TIMEOUT
  );

  it(
    'deploys from an empty namespace and hydrates status from the chart-created Service',
    async () => {
      const instanceName = `observed-${testRunId}`;
      const factory = await makeComposition(true).factory('direct', {
        namespace: observedNamespace,
        kubeConfig: kc,
        timeout: 480_000,
      });
      cleanupRegistry.track(factory, instanceName);

      const started = Date.now();
      const instance = await runWithExpectedTestNamespace(
        observedNamespace,
        kc,
        (lease) => {
          observedNamespaceLease = lease;
        },
        () =>
          factory.deploy({
            name: instanceName,
            namespace: observedNamespace,
            repoName: `bitnami-observed-${testRunId}`,
            releaseName: `nginx-observed-${testRunId}`,
          })
      );
      console.log(`observed-resource deployment completed in ${Date.now() - started}ms`);

      expect(instance.status?.serviceName).toBe(CHART_SERVICE_NAME);
      // A cluster IP only exists on the live Service the chart created, so this value can only
      // have come from a read that happened after the release was applied and ready.
      expect(instance.status?.clusterIP).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

      const liveService = await coreApi.readNamespacedService({
        name: CHART_SERVICE_NAME,
        namespace: observedNamespace,
      });
      expect(instance.status?.clusterIP).toBe(liveService.spec?.clusterIP ?? '');

      if (!observedNamespaceLease) {
        throw new Error(`Missing retained namespace lease for ${observedNamespace}`);
      }
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        instanceName,
        [observedNamespaceLease],
        kc,
        120_000
      );
      observedNamespaceLease = undefined;
    },
    TEST_TIMEOUT
  );
});
