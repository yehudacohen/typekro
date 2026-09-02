/**
 * SearXNG Bootstrap Composition Integration Tests
 *
 * Deploys a SearXNG instance to the cluster and verifies:
 * - All workload resources deploy successfully into an externally owned Namespace
 * - Health endpoint responds
 * - JSON API works when enabled
 * - Status fields are correct
 * - Cleanup terminates cleanly
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import { isValidationError } from '../../../src/core/kubernetes/errors.js';
import type { ResourceFactory } from '../../../src/core/types/deployment.js';
import type {
  SearxngBootstrapConfig,
  SearxngBootstrapStatus,
} from '../../../src/factories/searxng/types.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  isClusterAvailable,
  isNotFoundError,
  runTestPodAndReadLogs,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

setDefaultTimeout(120000);

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

async function waitForNamespace(
  coreApi: ReturnType<typeof createCoreV1ApiClient>,
  name: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await coreApi.readNamespace({ name });
      return;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Namespace/${name}`);
}

async function waitForKroReconciliation(
  customApi: ReturnType<typeof createCustomObjectsApiClient>,
  namespace: string,
  name: string,
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastObserved: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const raw = await customApi.getNamespacedCustomObject({
      group: 'kro.run',
      version: 'v1alpha1',
      namespace,
      plural: 'searxngbootstraps',
      name,
    });
    const live = ((raw as { body?: unknown }).body ?? raw) as Record<string, unknown>;
    lastObserved = live;
    const metadata = Reflect.get(live, 'metadata') as Record<string, unknown> | undefined;
    const status = Reflect.get(live, 'status') as Record<string, unknown> | undefined;
    const generation = Number(metadata?.generation ?? 0);
    const finalizers = Array.isArray(metadata?.finalizers) ? metadata.finalizers : [];
    const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
    const currentGenerationObserved = conditions.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      return Number(Reflect.get(candidate, 'observedGeneration') ?? 0) >= generation;
    });
    if (generation > 0 && finalizers.includes('kro.run/finalizer') && currentGenerationObserved) {
      return live;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for KRO to reconcile SearxngBootstrap/${name}: ${JSON.stringify(lastObserved)}`
  );
}

async function deleteSearxngKroDefinitionWhenUnused(kubeConfig: k8s.KubeConfig): Promise<void> {
  const customApi = createCustomObjectsApiClient(kubeConfig);
  try {
    const instances = await customApi.listClusterCustomObject({
      group: 'kro.run',
      version: 'v1alpha1',
      plural: 'searxngbootstraps',
    });
    if (instances.items.length > 0) {
      throw new Error(
        `Refusing to reset SearXNG KRO test definitions while ${instances.items.length} instance(s) remain`
      );
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  await deleteTestResourceAndWait(
    {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'searxng-bootstrap' },
    },
    kubeConfig,
    60_000
  );
  await deleteGeneratedCrdAndWait(
    {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'searxngbootstraps.kro.run' },
    },
    'kro.run/v1alpha1',
    'SearxngBootstrap',
    kubeConfig
  );
}

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
    appNamespaceLease = await createTestNamespace(appNamespace, kubeConfig);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (factory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          factory,
          directInstanceName,
          [],
          kubeConfig,
          30_000,
          { scopes: ['cluster'] }
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (appNamespaceLease) {
      try {
        await deleteTestNamespaceAndWait(appNamespaceLease, kubeConfig);
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

    const instance = await factory.deploy({
      name: directInstanceName,
      namespace: appNamespace,
      server: {
        secret_key: 'test-integration-key-not-for-production',
        limiter: false,
      },
    });

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
    const kroAppNamespaceLease = await createTestNamespace(kroAppNamespace, kubeConfig);

    let kroFactory: ResourceFactory<SearxngBootstrapConfig, SearxngBootstrapStatus> | undefined;
    let externalSecretLease:
      | { readonly name: string; readonly namespace: string; readonly uid: string }
      | undefined;
    const invalidRawInstanceName = `searxng-invalid-${suffix}`;
    const invalidRawAppNamespace = `searxng-invalid-app-${suffix}`;
    const plaintextRawInstanceName = `searxng-plaintext-${suffix}`;
    let invalidRawAppNamespaceLease: TestNamespaceLease | undefined;
    let invalidRawInstanceCreated = false;
    let testError: unknown;
    try {
      invalidRawAppNamespaceLease = await createTestNamespace(invalidRawAppNamespace, kubeConfig);
      await deleteSearxngKroDefinitionWhenUnused(kubeConfig);
      kroFactory = searxngBootstrap.factory('kro', {
        namespace: kroNamespace,
        waitForReady: true,
        timeout: 120000,
        kubeConfig,
      });

      const secretName = `${kroInstanceName}-external-secret`;
      const coreApi = createCoreV1ApiClient(kubeConfig);
      const createdSecret = await coreApi.createNamespacedSecret({
        namespace: kroAppNamespace,
        body: {
          metadata: { name: secretName },
          type: 'Opaque',
          stringData: { secret_key: 'kro-reference-only-test-key' },
        },
      });
      const uid = createdSecret.metadata?.uid;
      if (!uid) throw new Error(`Created Secret ${kroAppNamespace}/${secretName} has no UID`);
      externalSecretLease = { name: secretName, namespace: kroAppNamespace, uid };
      const instance = await kroFactory.deploy({
        name: kroInstanceName,
        namespace: kroAppNamespace,
        secretKeyRef: { name: secretName, key: 'secret_key' },
        server: { limiter: false },
      });

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

      // The generated CRD itself—not only the TypeScript factory—rejects a
      // plaintext value even when the required external reference is present.
      // This proves raw GitOps clients cannot persist the ambiguous form.
      const customApi = createCustomObjectsApiClient(kubeConfig);
      if (!externalSecretLease) throw new Error('External Secret lease was not recorded');
      let plaintextRejected = false;
      try {
        await customApi.createNamespacedCustomObject({
          group: 'kro.run',
          version: 'v1alpha1',
          namespace: kroNamespace,
          plural: 'searxngbootstraps',
          body: {
            apiVersion: 'kro.run/v1alpha1',
            kind: 'SearxngBootstrap',
            metadata: { name: plaintextRawInstanceName, namespace: kroNamespace },
            spec: {
              name: plaintextRawInstanceName,
              namespace: kroAppNamespace,
              secretKeyRef: { name: externalSecretLease.name, key: 'secret_key' },
              server: { secret_key: 'must-be-rejected-at-admission' },
            },
          },
        });
      } catch (error) {
        if (!isValidationError(error)) throw error;
        plaintextRejected = true;
      }
      expect(plaintextRejected).toBe(true);

      // Raw GitOps clients bypass ArkType's cross-field `.narrow()`. Prove
      // that the emitted KRO graph still fails closed: the CR can be admitted,
      // but without secretKeyRef it creates no workload resources in the
      // explicitly pre-existing external Namespace.
      await customApi.createNamespacedCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        namespace: kroNamespace,
        plural: 'searxngbootstraps',
        body: {
          apiVersion: 'kro.run/v1alpha1',
          kind: 'SearxngBootstrap',
          metadata: { name: invalidRawInstanceName, namespace: kroNamespace },
          spec: { name: invalidRawInstanceName, namespace: invalidRawAppNamespace },
        },
      });
      invalidRawInstanceCreated = true;
      const invalidRawInstance = await waitForKroReconciliation(
        customApi,
        kroNamespace,
        invalidRawInstanceName
      );
      expect(
        (Reflect.get(invalidRawInstance, 'metadata') as Record<string, unknown>).finalizers
      ).toContain('kro.run/finalizer');
      await waitForNamespace(createCoreV1ApiClient(kubeConfig), invalidRawAppNamespace);
      const invalidCoreApi = createCoreV1ApiClient(kubeConfig);
      const invalidAppsApi = createAppsV1ApiClient(kubeConfig);
      expect(
        (
          await invalidCoreApi.listNamespacedConfigMap({
            namespace: invalidRawAppNamespace,
            fieldSelector: `metadata.name=${invalidRawInstanceName}-config`,
          })
        ).items
      ).toHaveLength(0);
      expect(
        (
          await invalidCoreApi.listNamespacedService({
            namespace: invalidRawAppNamespace,
            fieldSelector: `metadata.name=${invalidRawInstanceName}`,
          })
        ).items
      ).toHaveLength(0);
      expect(
        (
          await invalidAppsApi.listNamespacedDeployment({
            namespace: invalidRawAppNamespace,
            fieldSelector: `metadata.name=${invalidRawInstanceName}`,
          })
        ).items
      ).toHaveLength(0);
    } catch (error) {
      testError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (testError !== undefined) cleanupErrors.push(testError);
    if (invalidRawInstanceCreated) {
      try {
        await deleteTestResourceAndWait(
          {
            apiVersion: 'kro.run/v1alpha1',
            kind: 'SearxngBootstrap',
            metadata: { name: invalidRawInstanceName, namespace: kroNamespace },
          },
          kubeConfig,
          30_000
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (kroFactory) {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          kroFactory,
          kroInstanceName,
          [],
          kubeConfig
        );
        await waitForNamespace(createCoreV1ApiClient(kubeConfig), kroAppNamespace);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (externalSecretLease) {
      try {
        await createCoreV1ApiClient(kubeConfig).deleteNamespacedSecret({
          name: externalSecretLease.name,
          namespace: externalSecretLease.namespace,
          body: { preconditions: { uid: externalSecretLease.uid } },
        });
      } catch (error) {
        if (!isNotFoundError(error)) cleanupErrors.push(error);
      }
    }
    try {
      // TypeKro intentionally retains generated CRDs during ordinary factory
      // teardown. This fixed-name integration definition is test-owned, so
      // remove it only after proving that every SearxngBootstrap instance is
      // gone. The helper waits for both RGD and CRD absence and fails closed
      // rather than leaving stale schema state for a later run.
      await deleteSearxngKroDefinitionWhenUnused(kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await deleteTestNamespaceAndWait(kroAppNamespaceLease, kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (invalidRawAppNamespaceLease) {
      try {
        await deleteTestNamespaceAndWait(invalidRawAppNamespaceLease, kubeConfig);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await deleteTestNamespaceAndWait(kroNamespaceLease, kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'SearXNG KRO integration did not complete safely');
    }
  }, 300000);
});
