import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createBunCompatibleCoreV1Api,
  createBunCompatibleCustomObjectsApi,
  createBunCompatibleKubernetesObjectApi,
} from '../../../src/core/kubernetes/index.js';
import { oauth2Client, oathkeeperRule, oryPlatformStack } from '../../../src/factories/ory/index.js';
import {
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable || process.env.REQUIRE_CLUSTER_TESTS === 'true' ? describe : describe.skip;

setDefaultTimeout(1500000);

type OryKroFactory = ReturnType<typeof oryPlatformStack.factory> & {
  deleteInstance(name: string): Promise<unknown>;
};

type OryFactory = ReturnType<typeof oryPlatformStack.factory> & {
  deleteInstance(name: string): Promise<unknown>;
};

function isApisixRouteCrdAvailable(): boolean {
  const result = Bun.spawnSync(['kubectl', 'get', 'crd', 'apisixroutes.apisix.apache.org'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return result.exitCode === 0;
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

async function runKubectl(args: string[], ignoreNotFound = false): Promise<void> {
  const proc = Bun.spawn(['kubectl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 0) return;
  if (ignoreNotFound && /not found|NotFound/i.test(`${stdout}\n${stderr}`)) return;
  throw new Error(`kubectl ${args.join(' ')} failed: ${stderr || stdout}`);
}

async function deleteMaesterResources(namespace: string): Promise<void> {
  await runKubectl(
    ['delete', 'oauth2client.hydra.ory.sh', 'console', '-n', namespace, '--ignore-not-found=true', '--wait=false'],
    true
  );
  await runKubectl(
    ['delete', 'rule.oathkeeper.ory.sh', 'api-rule', '-n', namespace, '--ignore-not-found=true', '--wait=false'],
    true
  );
}

async function deleteInstanceIfPresent(factory: OryFactory | undefined, name: string): Promise<void> {
  if (!factory) return;
  try {
    await factory.deleteInstance(name);
  } catch (error) {
    if (!/not found|NotFound/i.test(String(error))) {
      throw error;
    }
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
    const status = live && typeof live === 'object' ? (live as { status?: unknown }).status : undefined;
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
    const proc = Bun.spawn(
      [
        'kubectl',
        'exec',
        '-n',
        namespace,
        'deploy/identity-test-hydra',
        '--',
        'hydra',
        'get',
        'client',
        name,
        '--endpoint',
        'http://localhost:4445',
        '--format',
        'json',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode === 0) {
      const client = JSON.parse(stdout) as { client_id?: string };
      expect(client.client_id).toBe(name);
      return;
    }

    lastError = stderr;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out waiting for Hydra OAuth2 client ${name}: ${lastError}`);
}

describeOrSkip('Ory platform stack Kubernetes integration', () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const namespace = `typekro-test-ory-identity-${suffix}`;
  const kroNamespace = `typekro-test-ory-kro-${suffix}`;
  const apisixRoutesAvailable = isApisixRouteCrdAvailable();
  let kubeConfig: ReturnType<typeof getKubeConfig>;
  let directFactory: OryFactory | undefined;
  let kroFactory: OryKroFactory | undefined;

  beforeAll(async () => {
    kubeConfig = getKubeConfig({ skipTLSVerify: true });

    directFactory = oryPlatformStack.factory('direct', {
      namespace,
      waitForReady: true,
      timeout: 1200000,
      kubeConfig,
    }) as OryFactory;
    kroFactory = oryPlatformStack.factory('kro', {
      namespace: kroNamespace,
      waitForReady: true,
      timeout: 1200000,
      kubeConfig,
    }) as OryKroFactory;

    await ensureNamespaceExists(namespace, kubeConfig);
    await ensureNamespaceExists(kroNamespace, kubeConfig);
  });

  afterAll(async () => {
    if (!kubeConfig) return;

    await deleteInstanceIfPresent(kroFactory, 'identity-kro');
    await deleteInstanceIfPresent(directFactory, 'identity-test');
    await deleteMaesterResources(namespace);
    await deleteMaesterResources(kroNamespace);
    await runKubectl(['delete', 'namespace', namespace, '--ignore-not-found=true', '--wait=false'], true);
    await runKubectl(['delete', 'namespace', kroNamespace, '--ignore-not-found=true', '--wait=false'], true);
    await deleteMaesterResources(namespace);
    await deleteMaesterResources(kroNamespace);
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

    const pods = await coreApi.listNamespacedPod({ namespace });
    const podItems = getItems(pods);
    expect(podItems.length).toBeGreaterThan(0);
    for (const prefix of [
      'identity-test-hydra-',
      'identity-test-hydra-hydra-maester-',
      'identity-test-kratos-',
      'identity-test-kratos-courier-',
      'identity-test-keto-',
      'identity-test-oathkeeper-',
      'identity-test-oathkeeper-oathkeeper-maester-',
    ]) {
      expect(podItems.some((pod) => podName(pod).startsWith(prefix) && podIsRunningAndReady(pod))).toBe(true);
    }

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
    expect(instance.status.infrastructure.routes).toBe(apisixRoutesAvailable);
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
