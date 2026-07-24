/**
 * SearXNG Bootstrap Composition Integration Tests
 *
 * Deploys a SearXNG instance to the cluster and verifies:
 * - All resources deploy successfully (Namespace, ConfigMap, Deployment, Service)
 * - Health endpoint responds
 * - JSON API works when enabled
 * - Status fields are correct
 * - Cleanup terminates cleanly
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import type { ResourceFactory } from '../../../src/core/types/deployment.js';
import type {
  SearxngBootstrapConfig,
  SearxngBootstrapStatus,
} from '../../../src/factories/searxng/types.js';
import {
  createCoreV1ApiClient,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  isClusterAvailable,
  runWithExpectedTestNamespace,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

setDefaultTimeout(120000);

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

describeOrSkip('SearXNG Bootstrap Composition', () => {
  let kubeConfig: k8s.KubeConfig;
  let factory: ResourceFactory<SearxngBootstrapConfig, SearxngBootstrapStatus> | undefined;
  let factoryNamespaceLease: TestNamespaceLease;
  let appNamespaceLease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
  const factoryNamespace = `typekro-searxng-${suffix}`;
  const appNamespace = `searxng-test-${suffix}`;
  const directInstanceName = `searxng-test-${suffix}`;
  const kroInstanceName = `searxng-kro-${suffix}`;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    factoryNamespaceLease = await createTestNamespace(factoryNamespace, kubeConfig);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (factory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          factory,
          directInstanceName,
          appNamespaceLease ? [appNamespaceLease] : [],
          kubeConfig,
          30_000,
          { scopes: ['cluster'] }
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await deleteTestNamespaceAndWait(factoryNamespaceLease, kubeConfig);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SearXNG direct cleanup did not complete safely');
    }
  });

  it('should deploy SearXNG and verify health endpoint', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    factory = searxngBootstrap.factory('direct', {
      namespace: factoryNamespace,
      waitForReady: true,
      timeout: 60000,
      kubeConfig,
    });

    const instance = await runWithExpectedTestNamespace(
      appNamespace,
      kubeConfig,
      (lease) => {
        appNamespaceLease = lease;
      },
      () =>
        factory!.deploy({
          name: directInstanceName,
          namespace: appNamespace,
          server: {
            secret_key: 'test-integration-key-not-for-production',
            limiter: false,
          },
        })
    );

    // Status assertions
    expect(instance.spec.name).toBe(directInstanceName);
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.url).toContain(directInstanceName);

    const coreApi = createCoreV1ApiClient(kubeConfig);
    const pods = (await coreApi.listNamespacedPod({ namespace: appNamespace })).items;

    expect(pods.length).toBeGreaterThan(0);
    for (const pod of pods) {
      expect(pod.status?.phase).toBe('Running');
      for (const cs of pod.status?.containerStatuses ?? []) {
        expect(cs.ready).toBe(true);
      }
    }

    await runTestPodAndReadLogs(
      {
        namespace: appNamespace,
        name: 'searxng-health-probe',
        image: 'busybox:1.37',
        command: ['wget', '-q', '-O-', `http://${directInstanceName}:8080/healthz`],
      },
      kubeConfig
    );
  }, 90000);

  it('should generate valid KRO YAML with CEL expressions', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    const yaml: string = searxngBootstrap.toYaml();

    // RGD structure
    expect(yaml).toContain('apiVersion: kro.run/v1alpha1');
    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('name: searxng-bootstrap');

    // All resource types present
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('kind: ConfigMap');
    // Owned namespaces are TypeKro-managed siblings, not KRO ApplySet
    // members, so the RGD must not contain a Namespace resource.
    expect(yaml).not.toContain('kind: Namespace');

    // CEL expressions in status (not raw property access)
    expect(yaml).toContain('.exists(c,');

    // ConfigMap settings YAML guards optional fields before reading them.
    expect(yaml).toContain(
      'string(has(schema.spec.server) && has(schema.spec.server.limiter) ? schema.spec.server.limiter : false)'
    );

    // REGRESSION: required fields in template literals (like `${spec.name}-config`)
    // should produce clean mixed templates, NOT be wrapped in has() conditionals.
    // Only OPTIONAL fields should get ternary wrapping.
    expect(yaml).toContain('name: ${string(schema.spec.name)}-config');
    expect(yaml).not.toContain('has(schema.spec.name)');

    // No proxy artifacts
    expect(yaml).not.toContain('undefined');
    expect(yaml).not.toContain('[object Object]');
  });

  it('should deploy via KRO controller and reconcile', async () => {
    const { searxngBootstrap } = await import(
      '../../../src/factories/searxng/compositions/searxng-bootstrap.js'
    );

    const kroNamespace = `typekro-kro-searxng-${suffix}`;
    const kroAppNamespace = `searxng-kro-${suffix}`;
    const kroNamespaceLease = await createTestNamespace(kroNamespace, kubeConfig);

    let kroFactory: ResourceFactory<SearxngBootstrapConfig, SearxngBootstrapStatus> | undefined;
    let kroAppNamespaceLease: TestNamespaceLease | undefined;
    let testError: unknown;
    try {
      kroFactory = searxngBootstrap.factory('kro', {
        namespace: kroNamespace,
        waitForReady: true,
        timeout: 120000,
        kubeConfig,
      });

      const instance = await runWithExpectedTestNamespace(
        kroAppNamespace,
        kubeConfig,
        (lease) => {
          kroAppNamespaceLease = lease;
        },
        () =>
          kroFactory!.deploy({
            name: kroInstanceName,
            namespace: kroAppNamespace,
            server: { secret_key: 'kro-test-key', limiter: false },
          })
      );

      expect(instance.spec.name).toBe(kroInstanceName);
      expect(instance.status.ready).toBe(true);

      const pods = (
        await createCoreV1ApiClient(kubeConfig).listNamespacedPod({
          namespace: kroAppNamespace,
        })
      ).items;
      expect(pods.length).toBeGreaterThan(0);
      for (const pod of pods) {
        expect(pod.status?.phase).toBe('Running');
      }
    } catch (error) {
      testError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (testError !== undefined) cleanupErrors.push(testError);
    try {
      if (kroFactory) {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          kroFactory,
          kroInstanceName,
          kroAppNamespaceLease ? [kroAppNamespaceLease] : [],
          kubeConfig
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await deleteTestNamespaceAndWait(kroNamespaceLease, kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'SearXNG KRO integration did not complete safely');
    }
  }, 180000);
});
