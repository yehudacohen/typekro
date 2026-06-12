import { spawnSync } from 'node:child_process';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test';
import type * as k8s from '@kubernetes/client-node';
import { buildContainer } from '../../../src/core/containers/index.js';
import { getKubeConfig } from '../../../src/core/kubernetes/client-provider.js';
import {
  createKubernetesObjectApiClient,
  deleteNamespaceIfExists,
  ensureNamespaceExists,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

setDefaultTimeout(900000);

const clusterAvailable = isClusterAvailable();
const requireClusterTests = process.env.REQUIRE_CLUSTER_TESTS === 'true';
const defaultValidationImageName = 'typekro-dagster-validation';
const defaultValidationImageTag = '1.13.8';
const defaultLocalValidationImage = `${defaultValidationImageName}:${defaultValidationImageTag}`;
const envConfiguredValidationImage = process.env.DAGSTER_TEST_VALIDATION_IMAGE;
const configuredValidationImage =
  envConfiguredValidationImage ??
  (hasLocalDockerImage(defaultLocalValidationImage) ? defaultLocalValidationImage : undefined);
const configuredUserCodeImage =
  configuredValidationImage ??
  process.env.DAGSTER_TEST_USER_CODE_IMAGE ??
  'docker.io/dagster/user-code-example:1.13.8';
const configuredDagsterSystemImage =
  configuredValidationImage ?? process.env.DAGSTER_TEST_DAGSTER_IMAGE;
const defaultDagsterImagesPullOnThisHost = process.arch !== 'arm64';
const liveImagesAvailable =
  defaultDagsterImagesPullOnThisHost ||
  configuredValidationImage !== undefined ||
  canBuildLocalValidationImage() ||
  (process.env.DAGSTER_TEST_USER_CODE_IMAGE !== undefined &&
    configuredDagsterSystemImage !== undefined);
const describeLiveOrSkip =
  (clusterAvailable && liveImagesAvailable) || requireClusterTests
    ? describe
    : describe.skip;

function splitImage(image: string): { repository: string; tag: string } {
  const separatorIndex = image.lastIndexOf(':');
  if (separatorIndex <= image.lastIndexOf('/')) {
    return { repository: image, tag: '1.13.8' };
  }

  return {
    repository: image.slice(0, separatorIndex),
    tag: image.slice(separatorIndex + 1),
  };
}

function hasLocalDockerImage(image: string): boolean {
  if (process.arch !== 'arm64') return false;

  const result = spawnSync('docker', ['image', 'inspect', image], {
    stdio: 'ignore',
    timeout: 10000,
  });
  return result.status === 0;
}

function canBuildLocalValidationImage(): boolean {
  if (process.arch !== 'arm64') return false;

  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
    timeout: 10000,
  });
  return result.status === 0;
}

async function resolveValidationImage(): Promise<string | undefined> {
  if (envConfiguredValidationImage) return envConfiguredValidationImage;
  if (process.arch !== 'arm64') return undefined;
  if (hasLocalDockerImage(defaultLocalValidationImage)) return defaultLocalValidationImage;

  const result = await buildContainer({
    context: 'test/integration/dagster/fixtures/arm64-validation',
    imageName: defaultValidationImageName,
    tag: defaultValidationImageTag,
    platform: 'linux/arm64',
    registry: { type: 'orbstack' },
    timeout: 900000,
  });

  return result.imageUri;
}

async function deleteClusterObjectIfExists(
  kubeConfig: k8s.KubeConfig,
  apiVersion: string,
  kind: string,
  name: string
): Promise<void> {
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  try {
    await objectApi.delete({ apiVersion, kind, metadata: { name } });
    await waitForClusterObjectDeleted(kubeConfig, apiVersion, kind, name);
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number; body?: { reason?: string } }).statusCode;
    const reason = (error as { body?: { reason?: string } }).body?.reason;
    if (statusCode !== 404 && reason !== 'NotFound') {
      throw error;
    }
  }
}

async function waitForClusterObjectDeleted(
  kubeConfig: k8s.KubeConfig,
  apiVersion: string,
  kind: string,
  name: string
): Promise<void> {
  const objectApi = createKubernetesObjectApiClient(kubeConfig);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      await objectApi.read({ apiVersion, kind, metadata: { name } });
    } catch (error: unknown) {
      const statusCode = (error as { statusCode?: number; body?: { reason?: string } }).statusCode;
      const reason = (error as { body?: { reason?: string } }).body?.reason;
      if (statusCode === 404 || reason === 'NotFound') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`${kind} ${name} was not deleted within 60000ms.`);
}

async function resetDagsterKroDefinition(kubeConfig: k8s.KubeConfig): Promise<void> {
  await deleteClusterObjectIfExists(
    kubeConfig,
    'kro.run/v1alpha1',
    'ResourceGraphDefinition',
    'dagster-bootstrap'
  );
  await deleteClusterObjectIfExists(
    kubeConfig,
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition',
    'dagsterbootstraps.kro.run'
  );
}

// Test decision: keep the live deploy path gated by real cluster and image
// prerequisites while still testing KRO YAML generation without cluster reads.
// Always requiring a cluster was rejected because unit verification must remain
// local; unit-only coverage was rejected because the plan requires a direct-mode
// integration path when live prerequisites are available.
describeLiveOrSkip('Dagster bootstrap composition live deployment', () => {
  let kubeConfig: k8s.KubeConfig;
  let factory: { deleteInstance(instanceName: string): Promise<void> } | undefined;
  let kroFactory: { deleteInstance(instanceName: string): Promise<void> } | undefined;
  const suffix = Math.random().toString(36).slice(2, 7);
  const factoryNamespace = `typekro-dagster-${suffix}`;
  const kroFactoryNamespace = `typekro-dagster-kro-${suffix}`;
  const dagsterNamespace = `dagster-${suffix}`;
  const dagsterKroNamespace = `dagster-kro-${suffix}`;
  let userCodeImage = splitImage(configuredUserCodeImage);
  let dagsterSystemImage = configuredDagsterSystemImage
    ? splitImage(configuredDagsterSystemImage)
    : undefined;

  beforeAll(async () => {
    if (!clusterAvailable) {
      throw new Error('REQUIRE_CLUSTER_TESTS=true but no Kubernetes cluster is available.');
    }
    if (!liveImagesAvailable) {
      throw new Error(
        'REQUIRE_CLUSTER_TESTS=true but live Dagster images are unavailable. Set ' +
          'DAGSTER_TEST_VALIDATION_IMAGE to a locally built/loaded fixture image, or set ' +
          'DAGSTER_TEST_USER_CODE_IMAGE and DAGSTER_TEST_DAGSTER_IMAGE to images pullable ' +
          'by this cluster architecture.'
      );
    }

    const validationImage = await resolveValidationImage();
    if (validationImage) {
      userCodeImage = splitImage(validationImage);
      dagsterSystemImage = splitImage(validationImage);
    }

    kubeConfig = getKubeConfig({ skipTLSVerify: true });
    await resetDagsterKroDefinition(kubeConfig);
    await ensureNamespaceExists(factoryNamespace, kubeConfig);
    await ensureNamespaceExists(kroFactoryNamespace, kubeConfig);
  });

  afterAll(async () => {
    if (kroFactory) {
      try {
        await kroFactory.deleteInstance('dagster-kro-test');
      } catch (error) {
        console.error('Dagster KRO deleteInstance failed:', (error as Error).message);
      }
    }

    if (factory) {
      try {
        await factory.deleteInstance('dagster-test');
      } catch (error) {
        console.error('Dagster deleteInstance failed:', (error as Error).message);
      }
    }

    try {
      await deleteNamespaceIfExists(factoryNamespace, kubeConfig);
    } catch (error) {
      console.error('Dagster factory namespace cleanup failed:', (error as Error).message);
    }

    try {
      await deleteNamespaceIfExists(kroFactoryNamespace, kubeConfig);
    } catch (error) {
      console.error('Dagster KRO factory namespace cleanup failed:', (error as Error).message);
    }

    try {
      await deleteNamespaceIfExists(dagsterNamespace, kubeConfig);
    } catch (error) {
      console.error('Dagster app namespace cleanup failed:', (error as Error).message);
    }

    try {
      await deleteNamespaceIfExists(dagsterKroNamespace, kubeConfig);
    } catch (error) {
      console.error('Dagster KRO app namespace cleanup failed:', (error as Error).message);
    }

    try {
      await resetDagsterKroDefinition(kubeConfig);
    } catch (error) {
      console.error('Dagster KRO definition cleanup failed:', (error as Error).message);
    }
  });

  it('Deploy Dagster through the direct factory and hydrate HelmRelease status', async () => {
    const { dagsterBootstrap } = await import(
      '../../../src/factories/dagster/index.js'
    );

    const directFactory = dagsterBootstrap.factory('direct', {
      namespace: factoryNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });
    factory = directFactory;

    const instance = await directFactory.deploy({
      name: 'dagster-test',
      namespace: dagsterNamespace,
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'example-repo',
            image: { ...userCodeImage, pullPolicy: 'IfNotPresent' },
            codeServerArgs: ['-f', '/opt/dagster/app/definitions.py'],
            port: 3030,
          },
        ],
      },
      postgresql: { enabled: true },
      ...(dagsterSystemImage && {
        webserver: {
          image: { ...dagsterSystemImage, pullPolicy: 'IfNotPresent' },
        },
        daemon: {
          image: { ...dagsterSystemImage, pullPolicy: 'IfNotPresent' },
        },
      }),
      runLauncher: {
        type: 'K8sRunLauncher',
        k8sRunLauncher: { jobNamespace: dagsterNamespace },
      },
      values: { dagsterWebserver: { service: { type: 'ClusterIP' } } },
    });

    expect(instance.spec.name).toBe('dagster-test');
    expect(instance.spec.namespace).toBe(dagsterNamespace);
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.version).toBe('1.13.8');
    expect(instance.status.components.helmRepository).toBe(true);
    expect(instance.status.components.helmRelease).toBe(true);
    expect(instance.status.components.webserver).toBe(true);
    expect(instance.status.components.daemon).toBe(true);
    expect(instance.status.components.userDeployments).toBe(true);
  });

  it('Deploy Dagster through KRO and reconcile the HelmRelease to Ready', async () => {
    const { dagsterBootstrap } = await import(
      '../../../src/factories/dagster/index.js'
    );

    const createdKroFactory = dagsterBootstrap.factory('kro', {
      namespace: kroFactoryNamespace,
      waitForReady: true,
      timeout: 900000,
      kubeConfig,
    });
    kroFactory = createdKroFactory;

    const instance = await createdKroFactory.deploy({
      name: 'dagster-kro-test',
      namespace: dagsterKroNamespace,
      userDeployments: {
        enabled: true,
        deployments: [
          {
            name: 'example-repo',
            image: { ...userCodeImage, pullPolicy: 'IfNotPresent' },
            codeServerArgs: ['-f', '/opt/dagster/app/definitions.py'],
            port: 3030,
          },
        ],
      },
      postgresql: { enabled: true },
      ...(dagsterSystemImage && {
        webserver: {
          image: { ...dagsterSystemImage, pullPolicy: 'IfNotPresent' },
        },
        daemon: {
          image: { ...dagsterSystemImage, pullPolicy: 'IfNotPresent' },
        },
      }),
      runLauncher: {
        type: 'K8sRunLauncher',
        k8sRunLauncher: { jobNamespace: dagsterKroNamespace },
      },
      values: { dagsterWebserver: { service: { type: 'ClusterIP' } } },
    });

    expect(instance.spec.name).toBe('dagster-kro-test');
    expect(instance.spec.namespace).toBe(dagsterKroNamespace);
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
    expect(instance.status.failed).toBe(false);
    expect(instance.status.components.helmRepository).toBe(true);
    expect(instance.status.components.helmRelease).toBe(true);
    expect(instance.status.components.webserver).toBe(true);
    expect(instance.status.components.daemon).toBe(true);
    expect(instance.status.components.userDeployments).toBe(true);
  });
});

describe('Dagster bootstrap composition integration surfaces', () => {
  const factoryNamespace = 'typekro-dagster-test';

  it('Provide an architecture-compatible live validation fixture image path', async () => {
    const dockerfile = Bun.file(
      'test/integration/dagster/fixtures/arm64-validation/Dockerfile'
    );
    const definitions = Bun.file(
      'test/integration/dagster/fixtures/arm64-validation/definitions.py'
    );

    expect(await dockerfile.exists()).toBe(true);
    expect(await definitions.exists()).toBe(true);

    const dockerfileText = await dockerfile.text();
    const definitionsText = await definitions.text();

    expect(dockerfileText).toContain('dagster==1.13.8');
    expect(dockerfileText).toContain('dagster-webserver==1.13.8');
    expect(dockerfileText).toContain('definitions.py');
    expect(definitionsText).toContain('Definitions');
    expect(definitionsText).not.toContain('password');
    expect(definitionsText).not.toContain('secret');
  });

  it('Generate ResourceGraphDefinition YAML for KRO mode without cluster reads', async () => {
    const { dagsterBootstrap } = await import(
      '../../../src/factories/dagster/index.js'
    );

    const yaml = dagsterBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    expect(yaml).toContain('dagsterNamespace');
    // The HelmRepository is a shared singleton owner, emitted as its own RGD (the GitOps singleton
    // contract); its url is the owner's schema input rather than a literal inlined in the RGD.
    expect(yaml).toContain('dagster-helm-repository');
    expect(yaml).toContain('kind: HelmRepository');
    expect(yaml).toContain('dagsterHelmRelease');
    expect(yaml).toContain('url: ${schema.spec.url}');
    expect(yaml).toContain('chart: dagster');
    expect(yaml).toContain('1.13.8');
    expect(yaml).toContain('dagsterHelmRelease.status.conditions');
    expect(yaml).not.toContain('__KUBERNETES_REF_');
    expect(yaml).not.toContain('[object Object]');
    expect(yaml).not.toContain('undefined');
  });

  it('Support both direct and KRO factory strategies for Dagster bootstrap', async () => {
    const { dagsterBootstrap } = await import(
      '../../../src/factories/dagster/index.js'
    );

    const directFactory = dagsterBootstrap.factory('direct', {
      namespace: factoryNamespace,
    });
    const kroFactory = dagsterBootstrap.factory('kro', {
      namespace: factoryNamespace,
    });

    expect(directFactory.mode).toBe('direct');
    expect(kroFactory.mode).toBe('kro');
  });
});
