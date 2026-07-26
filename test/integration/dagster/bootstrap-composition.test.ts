import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type * as k8s from '@kubernetes/client-node';
import { buildContainer } from '../../../src/core/containers/index.js';
import {
  assertTestNamespaceAbsent,
  assertTestResourceAbsent,
  captureTestNamespaceLease,
  createTestNamespace,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  requireTestStorageClass,
  type TestDeletableFactory,
  type TestNamespaceLease,
} from '../shared-kubeconfig.js';

setDefaultTimeout(900000);

const clusterAvailable = await isClusterAvailable();
const requireClusterTests = process.env.REQUIRE_CLUSTER_TESTS === 'true';
const defaultValidationImageName = 'typekro-dagster-validation';
const defaultValidationImageTag = '1.13.8';
const defaultLocalValidationImage = `${defaultValidationImageName}:${defaultValidationImageTag}`;
let configuredStorageClass: string;
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
  (clusterAvailable && liveImagesAvailable) || requireClusterTests ? describe : describe.skip;

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

function loadLocalImageIntoKindIfNeeded(image: string, kubeConfig: k8s.KubeConfig): void {
  const inspect = spawnSync('docker', ['image', 'inspect', image], {
    stdio: 'ignore',
    timeout: 10000,
  });
  if (inspect.status !== 0) return;

  const currentContext = kubeConfig.getCurrentContext();
  if (!currentContext.startsWith('kind-')) return;

  const clusterName = currentContext.slice('kind-'.length);
  const load = spawnSync('kind', ['load', 'docker-image', image, '--name', clusterName], {
    encoding: 'utf8',
    timeout: 300000,
  });
  if (load.status !== 0) {
    throw new Error(
      `Failed to load local Dagster validation image ${image} into kind cluster ${clusterName}: ` +
        `${load.stderr || load.stdout}`.trim()
    );
  }
}

async function resetDagsterKroDefinition(kubeConfig: k8s.KubeConfig): Promise<void> {
  await deleteTestResourceAndWait(
    {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: 'dagster-bootstrap' },
    },
    kubeConfig,
    60_000
  );
  // Generated CRDs are intentionally reusable cluster APIs. Deleting one can
  // strand it in customresourcecleanup/Terminating and block the next RGD, so
  // reset only the definition and let KRO reuse the established CRD.
}

async function deployWithNamespaceLease<T>(
  namespace: string,
  kubeConfig: k8s.KubeConfig,
  deploy: () => Promise<T>,
  retainLease: (lease: TestNamespaceLease) => void
): Promise<T> {
  let result: T | undefined;
  let deploymentError: unknown;
  try {
    result = await deploy();
  } catch (error) {
    deploymentError = error;
  }

  let lease: TestNamespaceLease | undefined;
  let leaseError: unknown;
  try {
    lease = await captureTestNamespaceLease(namespace, kubeConfig);
    if (lease) retainLease(lease);
  } catch (error) {
    leaseError = error;
  }

  if (deploymentError !== undefined) {
    if (leaseError !== undefined) {
      throw new AggregateError(
        [deploymentError, leaseError],
        `Dagster deployment failed and ownership of ${namespace} could not be retained`
      );
    }
    throw deploymentError;
  }
  if (leaseError !== undefined) throw leaseError;
  if (!lease) {
    throw new Error(`Dagster deployment did not create expected namespace ${namespace}`);
  }
  return result as T;
}

// Test decision: keep the live deploy path gated by real cluster and image
// prerequisites while still testing KRO YAML generation without cluster reads.
// Always requiring a cluster was rejected because unit verification must remain
// local; unit-only coverage was rejected because the plan requires a direct-mode
// integration path when live prerequisites are available.
describeLiveOrSkip('Dagster bootstrap composition live deployment', () => {
  let kubeConfig: k8s.KubeConfig;
  let factory: TestDeletableFactory | undefined;
  let kroFactory: TestDeletableFactory | undefined;
  let factoryNamespaceLease: TestNamespaceLease | undefined;
  let kroFactoryNamespaceLease: TestNamespaceLease | undefined;
  let dagsterNamespaceLease: TestNamespaceLease | undefined;
  let dagsterKroNamespaceLease: TestNamespaceLease | undefined;
  const suffix = crypto.randomUUID().slice(0, 8);
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

    kubeConfig = getIntegrationTestKubeConfig();
    configuredStorageClass = await requireTestStorageClass({ kubeConfig });
    const validationImage = await resolveValidationImage();
    if (validationImage) {
      loadLocalImageIntoKindIfNeeded(validationImage, kubeConfig);
      userCodeImage = splitImage(validationImage);
      dagsterSystemImage = splitImage(validationImage);
    }

    await assertTestResourceAbsent(
      {
        apiVersion: 'kro.run/v1alpha1',
        kind: 'ResourceGraphDefinition',
        metadata: { name: 'dagster-bootstrap' },
      },
      kubeConfig
    );
    factoryNamespaceLease = await createTestNamespace(factoryNamespace, kubeConfig);
    kroFactoryNamespaceLease = await createTestNamespace(kroFactoryNamespace, kubeConfig);
    await assertTestNamespaceAbsent(dagsterNamespace, kubeConfig);
    await assertTestNamespaceAbsent(dagsterKroNamespace, kubeConfig);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (kroFactory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          kroFactory,
          'dagster-kro-test',
          dagsterKroNamespaceLease ? [dagsterKroNamespaceLease] : [],
          kubeConfig,
          120_000
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (factory) {
      try {
        await deleteTestFactoryInstanceAndRecoverNamespaces(
          factory,
          'dagster-test',
          dagsterNamespaceLease ? [dagsterNamespaceLease] : [],
          kubeConfig,
          120_000
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    for (const lease of [
      dagsterNamespaceLease,
      dagsterKroNamespaceLease,
      factoryNamespaceLease,
      kroFactoryNamespaceLease,
    ]) {
      if (!lease) continue;
      try {
        await deleteTestNamespaceAndWait(lease, kubeConfig);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await resetDagsterKroDefinition(kubeConfig);
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Dagster integration cleanup did not complete safely'
      );
    }
  });

  it('Deploy Dagster through the direct factory and hydrate HelmRelease status', async () => {
    const { dagsterBootstrap } = await import('../../../src/factories/dagster/index.js');

    const directFactory = dagsterBootstrap.factory('direct', {
      namespace: factoryNamespace,
      waitForReady: true,
      timeout: 600000,
      kubeConfig,
    });
    factory = directFactory;

    const instance = await deployWithNamespaceLease(
      dagsterNamespace,
      kubeConfig,
      () =>
        directFactory.deploy({
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
          postgresql: {
            enabled: true,
            storageClass: configuredStorageClass,
          },
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
        }),
      (lease) => {
        dagsterNamespaceLease = lease;
      }
    );

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
    const { dagsterBootstrap } = await import('../../../src/factories/dagster/index.js');

    const createdKroFactory = dagsterBootstrap.factory('kro', {
      namespace: kroFactoryNamespace,
      waitForReady: true,
      timeout: 900000,
      kubeConfig,
    });
    kroFactory = createdKroFactory;

    const instance = await deployWithNamespaceLease(
      dagsterKroNamespace,
      kubeConfig,
      () =>
        createdKroFactory.deploy({
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
          postgresql: {
            enabled: true,
            storageClass: configuredStorageClass,
          },
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
        }),
      (lease) => {
        dagsterKroNamespaceLease = lease;
      }
    );

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
    const dockerfile = Bun.file('test/integration/dagster/fixtures/arm64-validation/Dockerfile');
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
    const { dagsterBootstrap } = await import('../../../src/factories/dagster/index.js');

    const yaml = dagsterBootstrap.toYaml();

    expect(yaml).toContain('kind: ResourceGraphDefinition');
    // PR #113: the composition's self-owned workload Namespace is HOISTED OUT of the
    // shared RGD (emitted as a retained resource created deps-first, NOT an RGD child)
    // so deleting the instance can't garbage-collect the namespace holding its own
    // finalizer. The RGD therefore contains NEITHER the `dagsterNamespace` graph child
    // NOR a `kind: Namespace` template.
    expect(yaml).not.toContain('dagsterNamespace');
    expect(yaml).not.toContain('kind: Namespace');
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
    const { dagsterBootstrap } = await import('../../../src/factories/dagster/index.js');

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
