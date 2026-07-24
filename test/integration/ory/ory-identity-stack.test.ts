import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../../../src/core/kubernetes/index.js';
import {
  oathkeeperRule,
  oauth2Client,
  oryPlatformStack,
} from '../../../src/factories/ory/index.js';
import {
  createTestNamespace,
  deleteTestConfigMapAndWait,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestHelmHookResources,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  deleteTestSecretAndWait,
  isClusterAvailable,
  runTestPodAndReadLogs,
  type TestDeletableFactory,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip =
  clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

setDefaultTimeout(1500000);

type OryKroFactory = ReturnType<typeof oryPlatformStack.factory> & TestDeletableFactory;
type OryFactory = ReturnType<typeof oryPlatformStack.factory> & TestDeletableFactory;

async function isApisixRouteCrdAvailable(): Promise<boolean> {
  const objectApi = createBunCompatibleKubernetesObjectApi(getKubeConfig({ skipTLSVerify: true }));
  try {
    await objectApi.read({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'apisixroutes.apisix.apache.org' },
    });
    return true;
  } catch (error: unknown) {
    if (/not found|NotFound/i.test(String(error))) return false;
    throw error;
  }
}

function getItems(result: unknown): unknown[] {
  if (result && typeof result === 'object' && 'items' in result) {
    const items = (result as { items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  }
  if (result && typeof result === 'object' && 'body' in result) {
    const body = (result as { body?: { items?: unknown } }).body;
    return Array.isArray(body?.items) ? body.items : [];
  }
  return [];
}

function podIsRunningAndReady(pod: unknown): boolean {
  if (!pod || typeof pod !== 'object') return false;
  const status = (pod as { status?: { phase?: string; conditions?: unknown } }).status;
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  const ready = conditions.some((condition) => {
    if (!condition || typeof condition !== 'object') return false;
    const typedCondition = condition as { type?: string; status?: string };
    return typedCondition.type === 'Ready' && typedCondition.status === 'True';
  });

  return status?.phase === 'Running' && ready;
}

function podName(pod: unknown): string {
  if (!pod || typeof pod !== 'object') return '';
  return (pod as { metadata?: { name?: string } }).metadata?.name ?? '';
}

async function waitForPodsRunningAndReady(
  coreApi: ReturnType<typeof createBunCompatibleCoreV1Api>,
  namespace: string,
  prefixes: readonly string[],
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let missingPrefixes = [...prefixes];

  while (Date.now() <= deadline) {
    const pods = getItems(await coreApi.listNamespacedPod({ namespace }));
    missingPrefixes = prefixes.filter(
      (prefix) => !pods.some((pod) => podName(pod).startsWith(prefix) && podIsRunningAndReady(pod))
    );
    if (missingPrefixes.length === 0) return;
    await Bun.sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for Running/Ready Ory pods in ${namespace}: ${missingPrefixes.join(', ')}`
  );
}

async function deleteMaesterResources(
  namespace: string,
  kubeConfig: ReturnType<typeof getKubeConfig>
): Promise<void> {
  const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
  const resources = [
    ['hydra.ory.sh', 'oauth2clients', 'OAuth2Client', 'console'],
    ['oathkeeper.ory.sh', 'rules', 'Rule', 'api-rule'],
  ] as const;

  for (const [group, plural, kind, name] of resources) {
    const identity = {
      apiVersion: `${group}/v1alpha1`,
      kind,
      metadata: { name, namespace },
    };
    try {
      await deleteTestResourceAndWait(identity, kubeConfig, 60_000);
    } catch (initialError: unknown) {
      await customApi.patchNamespacedCustomObject({
        group,
        version: 'v1alpha1',
        namespace,
        plural,
        name,
        body: [{ op: 'add', path: '/metadata/finalizers', value: [] }],
      });
      try {
        await deleteTestResourceAndWait(identity, kubeConfig, 60_000);
      } catch (recoveryError: unknown) {
        throw new AggregateError(
          [initialError, recoveryError],
          `Maester resource ${kind}/${namespace}/${name} remained after finalizer recovery`
        );
      }
    }
  }
}

async function deleteInstanceIfPresent(
  factory: TestDeletableFactory | undefined,
  name: string,
  kubeConfig: ReturnType<typeof getKubeConfig>
): Promise<void> {
  if (!factory) return;
  await deleteTestFactoryInstanceAndRecoverNamespaces(factory, name, [], kubeConfig, 120_000);
}

async function deleteOryControllerArtifacts(
  namespace: string,
  instanceName: string,
  kubeConfig: ReturnType<typeof getKubeConfig>
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  await deleteTestHelmHookResources(
    namespace,
    ['hydra', 'kratos', 'keto', 'oathkeeper'].map((service) => `${instanceName}-${service}`),
    kubeConfig
  ).catch((error) => cleanupErrors.push(error));
  await deleteTestConfigMapAndWait(namespace, 'oathkeeper-rules', kubeConfig).catch((error) =>
    cleanupErrors.push(error)
  );
  await deleteTestSecretAndWait(namespace, 'console-oauth2-client', kubeConfig).catch((error) =>
    cleanupErrors.push(error)
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Failed to delete Ory controller artifacts for ${namespace}/${instanceName}`
    );
  }
}

async function waitForCustomObjectStatus(
  customApi: ReturnType<typeof createBunCompatibleCustomObjectsApi>,
  namespace: string,
  group: string,
  version: string,
  plural: string,
  name: string,
  predicate: (status: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastStatus: Record<string, unknown> = {};

  while (Date.now() - startedAt < 300000) {
    const live = await customApi.getNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      name,
    });
    const status =
      live && typeof live === 'object' ? (live as { status?: unknown }).status : undefined;
    lastStatus = status && typeof status === 'object' ? (status as Record<string, unknown>) : {};
    if (predicate(lastStatus)) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out waiting for ${plural}/${name} status: ${JSON.stringify(lastStatus)}`);
}

async function waitForHydraOAuth2Client(namespace: string, name: string): Promise<void> {
  const startedAt = Date.now();
  let lastError = '';

  while (Date.now() - startedAt < 300000) {
    try {
      const stdout = await runTestPodAndReadLogs({
        namespace,
        name: `hydra-client-probe-${crypto.randomUUID().slice(0, 8)}`,
        image: 'curlimages/curl:8.12.1',
        command: ['curl'],
        args: ['--fail', '--silent', `http://identity-test-hydra-admin:4445/admin/clients/${name}`],
      });
      const client = JSON.parse(stdout) as { client_id?: string };
      expect(client.client_id).toBe(name);
      return;
    } catch (error: unknown) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out waiting for Hydra OAuth2 client ${name}: ${lastError}`);
}

describeOrSkip('Ory platform stack Kubernetes integration', () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const namespace = `typekro-test-ory-identity-${suffix}`;
  const kroNamespace = `typekro-test-ory-kro-${suffix}`;
  const kroControlNamespace = `typekro-test-ory-control-${suffix}`;
  let apisixRoutesAvailable = false;
  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let directFactory: OryFactory | undefined;
  let kroFactory: OryKroFactory | undefined;
  let directNamespaceLease: TestNamespaceLease;
  let kroNamespaceLease: TestNamespaceLease;
  let kroControlNamespaceLease: TestNamespaceLease;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    apisixRoutesAvailable = await isApisixRouteCrdAvailable();

    directFactory = oryPlatformStack.factory('direct', {
      namespace,
      waitForReady: true,
      timeout: 1200000,
      kubeConfig,
    }) as OryFactory;
    kroFactory = oryPlatformStack.factory('kro', {
      namespace: kroControlNamespace,
      waitForReady: true,
      timeout: 1200000,
      kubeConfig,
    }) as OryKroFactory;

    [directNamespaceLease, kroNamespaceLease, kroControlNamespaceLease] = await Promise.all([
      createTestNamespace(namespace, kubeConfig),
      createTestNamespace(kroNamespace, kubeConfig),
      createTestNamespace(kroControlNamespace, kubeConfig),
    ]);
  });

  afterAll(async () => {
    if (!kubeConfig) return;
    const cleanupErrors: unknown[] = [];

    for (const cleanup of [
      () => deleteInstanceIfPresent(kroFactory, 'identity-kro', kubeConfig),
      () => deleteInstanceIfPresent(directFactory, 'identity-test', kubeConfig),
      () => deleteMaesterResources(kroNamespace, kubeConfig),
      () => deleteMaesterResources(namespace, kubeConfig),
      () => deleteOryControllerArtifacts(kroNamespace, 'identity-kro', kubeConfig),
      () => deleteOryControllerArtifacts(namespace, 'identity-test', kubeConfig),
      () => deleteTestNamespaceAndWait(directNamespaceLease, kubeConfig),
      () => deleteTestNamespaceAndWait(kroNamespaceLease, kubeConfig),
      () => deleteTestNamespaceAndWait(kroControlNamespaceLease, kubeConfig),
    ]) {
      await cleanup().catch((error) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Ory integration cleanup failed');
    }
  });

  it('E2E tests deploy the Ory platform stack to a real Kubernetes cluster', async () => {
    if (!directFactory) throw new Error('Direct factory was not initialized');

    const instance = await directFactory.deploy({
      name: 'identity-test',
      namespace,
      managed: {
        databases: true,
        secrets: true,
        routes: apisixRoutesAvailable,
        sampleUpstream: true,
        courierSes: false,
      },
      maester: {
        hydra: { enabled: true, singleNamespaceMode: false },
        oathkeeper: { enabled: true, singleNamespaceMode: true },
      },
    });
    expect(instance.spec.name).toBe('identity-test');
    expect(instance.spec.managed).toMatchObject({
      databases: true,
      secrets: true,
      routes: apisixRoutesAvailable,
      sampleUpstream: true,
    });
    expect(instance.status.ready).toBe(true);
    expect(instance.status.infrastructure.databases).toBe(true);
    expect(instance.status.infrastructure.secrets).toBe(true);
    expect(instance.status.infrastructure.routes).toBe(apisixRoutesAvailable);
    expect(instance.status.infrastructure.upstream).toBe(true);
    expect(instance.status.dependencies.hydraDatabase).toBe('managed');
    expect(instance.status.dependencies.kratosDatabase).toBe('managed');
    expect(instance.status.dependencies.ketoDatabase).toBe('managed');
    expect(instance.status.dependencies.secrets).toBe('managed');
    expect(instance.status.ory.components.hydra).toBe(true);
    expect(instance.status.ory.components.kratos).toBe(true);
    expect(instance.status.ory.components.keto).toBe(true);
    expect(instance.status.ory.components.oathkeeper).toBe(true);
    expect(instance.status.ory.maester.hydra).toBe(true);
    expect(instance.status.ory.maester.oathkeeper).toBe(true);
  }, 1200000);

  it('E2E tests verify graph-managed dependencies, Ory Helm resources, pods, and Maester CRDs exist', async () => {
    const objectApi = createBunCompatibleKubernetesObjectApi(kubeConfig);
    const coreApi = createBunCompatibleCoreV1Api(kubeConfig);
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);

    const repository = await objectApi.read({
      apiVersion: 'source.toolkit.fluxcd.io/v1',
      kind: 'HelmRepository',
      metadata: { name: 'ory', namespace },
    });
    expect(repository).toBeDefined();

    for (const name of ['hydra', 'kratos', 'keto', 'oathkeeper']) {
      const release = await objectApi.read({
        apiVersion: 'helm.toolkit.fluxcd.io/v2',
        kind: 'HelmRelease',
        metadata: { name: `identity-test-${name}`, namespace },
      });
      expect(release).toBeDefined();
    }

    const oauth2ClientCrd = await objectApi.read({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'oauth2clients.hydra.ory.sh' },
    });
    expect(oauth2ClientCrd).toBeDefined();

    const oathkeeperRuleCrd = await objectApi.read({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'rules.oathkeeper.ory.sh' },
    });
    expect(oathkeeperRuleCrd).toBeDefined();

    const managedSecret = await objectApi.read({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'identity-test-hydra-secrets', namespace },
    });
    expect(managedSecret).toBeDefined();

    const hydraDatabase = await customApi.getNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace,
      plural: 'clusters',
      name: 'identity-test-hydra-db',
    });
    expect(hydraDatabase).toBeDefined();

    await waitForPodsRunningAndReady(coreApi, namespace, [
      'identity-test-hydra-',
      'identity-test-hydra-hydra-maester-',
      'identity-test-kratos-',
      'identity-test-kratos-courier-',
      'identity-test-keto-',
      'identity-test-oathkeeper-',
      'identity-test-oathkeeper-oathkeeper-maester-',
    ]);

    const oauth2Clients = await customApi.listNamespacedCustomObject({
      group: 'hydra.ory.sh',
      version: 'v1alpha1',
      namespace,
      plural: 'oauth2clients',
    });
    expect(getItems(oauth2Clients)).toEqual(expect.any(Array));

    const rules = await customApi.listNamespacedCustomObject({
      group: 'oathkeeper.ory.sh',
      version: 'v1alpha1',
      namespace,
      plural: 'rules',
    });
    expect(getItems(rules)).toEqual(expect.any(Array));
  }, 300000);

  it('E2E tests create a representative OAuth2Client and observe Maester reconciliation', async () => {
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const coreApi = createBunCompatibleCoreV1Api(kubeConfig);

    await coreApi.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: 'console-oauth2-client' },
        stringData: {
          CLIENT_ID: 'console',
          CLIENT_SECRET: 'test-only-client-secret',
          client_secret: 'test-only-client-secret',
        },
      },
    });

    const client = oauth2Client({
      id: 'consoleOAuth2Client',
      name: 'console',
      namespace,
      spec: {
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        redirectUris: ['http://console.localhost/callback'],
        scope: 'openid offline',
        secretName: 'console-oauth2-client',
      },
    });

    await customApi.createNamespacedCustomObject({
      group: 'hydra.ory.sh',
      version: 'v1alpha1',
      namespace,
      plural: 'oauth2clients',
      body: {
        apiVersion: client.apiVersion,
        kind: client.kind,
        metadata: { name: client.metadata.name, namespace },
        spec: client.spec,
      },
    });

    await waitForHydraOAuth2Client(namespace, 'console');
  }, 360000);

  it('E2E tests create a representative Rule and observe Oathkeeper Maester validation', async () => {
    const customApi = createBunCompatibleCustomObjectsApi(kubeConfig);
    const rule = oathkeeperRule({
      id: 'apiRule',
      name: 'api-rule',
      namespace,
      spec: {
        match: { methods: ['GET'], url: 'http://api.localhost/<.*>' },
        upstream: { url: 'http://kubernetes.default.svc.cluster.local' },
        authenticators: [{ handler: 'anonymous' }],
        authorizer: { handler: 'allow' },
        mutators: [{ handler: 'noop' }],
        configMapName: 'oathkeeper-rules',
      },
    });

    await customApi.createNamespacedCustomObject({
      group: 'oathkeeper.ory.sh',
      version: 'v1alpha1',
      namespace,
      plural: 'rules',
      body: {
        apiVersion: rule.apiVersion,
        kind: rule.kind,
        metadata: { name: rule.metadata.name, namespace },
        spec: rule.spec,
      },
    });

    const status = await waitForCustomObjectStatus(
      customApi,
      namespace,
      'oathkeeper.ory.sh',
      'v1alpha1',
      'rules',
      'api-rule',
      (currentStatus) => 'validation' in currentStatus
    );

    expect(status.validation).toMatchObject({ valid: true });
  }, 360000);

  it('E2E tests deploy the Ory platform stack through Kro and wait for readiness', async () => {
    if (!kroFactory) throw new Error('KRO factory was not initialized');

    // This suite runs both full representations on a single-node development cluster.
    // Retire the already-verified direct stack so the KRO stack does not exceed maxPods.
    await deleteInstanceIfPresent(directFactory, 'identity-test', kubeConfig);
    directFactory = undefined;
    await deleteMaesterResources(namespace, kubeConfig);
    await deleteOryControllerArtifacts(namespace, 'identity-test', kubeConfig);
    await deleteTestNamespaceAndWait(directNamespaceLease, kubeConfig);

    const instance = await kroFactory.deploy({
      name: 'identity-kro',
      namespace: kroNamespace,
      managed: {
        databases: true,
        secrets: true,
        routes: apisixRoutesAvailable,
        sampleUpstream: true,
        courierSes: false,
      },
      maester: {
        hydra: { enabled: true, singleNamespaceMode: true },
        oathkeeper: { enabled: true, singleNamespaceMode: true },
      },
    });

    expect(instance.spec.name).toBe('identity-kro');
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.infrastructure.databases).toBe(true);
    expect(instance.status.infrastructure.secrets).toBe(true);
    expect(instance.status.infrastructure.routes).toBe(false);
    expect(instance.status.infrastructure.upstream).toBe(true);
    expect(instance.status.dependencies.hydraDatabase).toBe('managed');
    expect(instance.status.dependencies.kratosDatabase).toBe('managed');
    expect(instance.status.dependencies.ketoDatabase).toBe('managed');
    expect(instance.status.ory.components.hydra).toBe(true);
    expect(instance.status.ory.components.kratos).toBe(true);
    expect(instance.status.ory.components.keto).toBe(true);
    expect(instance.status.ory.components.oathkeeper).toBe(true);
  }, 1200000);
});
