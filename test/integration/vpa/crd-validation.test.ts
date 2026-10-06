/**
 * Vertical Pod Autoscaler against the real chart and CRDs — cluster-gated.
 *
 * 1. `vpaBootstrap` installs the pinned Fairwinds chart through Flux, with
 *    all three components and the bundled metrics-server.
 * 2. The manifests `verticalPodAutoscaler` renders pass server-side dry-run
 *    against the installed CRDs; an invalid update mode is rejected.
 * 3. A recommend-only VPA on a real Deployment becomes ready on
 *    `RecommendationProvided`, and a `Recreate` VPA's recommendation is
 *    written into a new pod by the admission webhook (certgen certificate).
 * 4. KRO accepts the RGDs and reports them `Active`, which means KRO
 *    type-checked every CEL path against the live CRD schemas.
 *
 * Prerequisites: a cluster with Flux and KRO (`bun run scripts/e2e-setup.ts`)
 * and outbound access to charts.fairwinds.com and registry.k8s.io.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../src/core/config/defaults.js';
import { resourceGraphDefinition } from '../../../src/factories/kro/resource-graph-definition.js';
import { Deployment } from '../../../src/factories/simple/workloads/deployment.js';
import {
  makeVpaBootstrap,
  vpaHelmRepositoryBootstrap,
} from '../../../src/factories/vpa/compositions/index.js';
import { vpaRecommendationProvided } from '../../../src/factories/vpa/resources/readiness.js';
import {
  verticalPodAutoscaler,
  vpaRecommendOnly,
} from '../../../src/factories/vpa/resources/vertical-pod-autoscaler.js';
import {
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const describeOrSkip = (await isClusterAvailable()) ? describe : describe.skip;
setDefaultTimeout(900_000);

const runToken = Date.now().toString(36).slice(-6);
const appNamespace = `vpa-e2e-${runToken}`;

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  spec?: Record<string, unknown>;
}

// kind's kubelets serve self-signed certificates. The InPlace update mode is
// behind a feature gate in VPA 1.7.
const inPlace = { 'feature-gates': 'InPlace=true' };
const vpa = makeVpaBootstrap({
  namespaceOwnership: 'owned',
  values: {
    'metrics-server': { args: ['--kubelet-insecure-tls'] },
    admissionController: { extraArgs: inPlace },
    updater: { extraArgs: inPlace },
  },
});

/** A Deployment with a recommend-only VPA and a Recreate VPA on a second one. */
const app = kubernetesComposition(
  {
    name: 'vpa-e2e-app',
    kind: 'VpaE2EApp',
    spec: type({ image: 'string' }),
    status: type({ recommended: 'boolean' }),
  },
  (spec) => {
    const web = Deployment({
      name: 'web',
      image: spec.image,
      replicas: 1,
      resources: { requests: { cpu: '10m', memory: '16Mi' } },
      id: 'web',
    });
    const webVpa = vpaRecommendOnly(web, { id: 'webVpa' });
    Deployment({
      name: 'worker',
      image: spec.image,
      replicas: 2,
      resources: { requests: { cpu: '10m', memory: '16Mi' } },
      id: 'worker',
    });
    const workerVpa = verticalPodAutoscaler({
      name: 'worker',
      spec: {
        targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'worker' },
        updatePolicy: { updateMode: 'Recreate', minReplicas: 2 },
        resourcePolicy: {
          containerPolicies: [
            {
              containerName: '*',
              minAllowed: { cpu: '20m', memory: '64Mi' },
              maxAllowed: { cpu: '1', memory: '1Gi' },
              controlledValues: 'RequestsOnly',
            },
          ],
        },
      },
      id: 'workerVpa',
    });
    return { recommended: vpaRecommendationProvided(webVpa, workerVpa) };
  }
);

function manifests(yaml: string): Manifest[] {
  return (loadAll(yaml) as Manifest[]).filter((doc) => doc && typeof doc === 'object');
}

async function dryRun(manifest: Manifest): Promise<{ ok: boolean; message: string }> {
  const [group, version] = manifest.apiVersion.split('/');
  try {
    await createCustomObjectsApiClient(getIntegrationTestKubeConfig()).createNamespacedCustomObject(
      {
        group: group ?? '',
        version: version ?? '',
        namespace: 'default',
        plural: 'verticalpodautoscalers',
        body: { ...manifest, metadata: { ...manifest.metadata, namespace: 'default' } },
        dryRun: 'All',
        fieldValidation: 'Strict',
      }
    );
    return { ok: true, message: '' };
  } catch (error: unknown) {
    const candidate = error as { body?: unknown; message?: string };
    return { ok: false, message: JSON.stringify(candidate.body ?? candidate.message ?? error) };
  }
}

async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describeOrSkip('Vertical Pod Autoscaler (pinned Fairwinds chart)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const factory = vpa.factory('direct', {
      namespace: DEFAULT_FLUX_NAMESPACE,
      kubeConfig,
      waitForReady: true,
      timeout: 600_000,
    });
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'vpa', [], kubeConfig, 300_000)
    );
    // The certgen Secret and the admission controller's Lease are not part of
    // the release; they outlive the uninstall and keep the namespace.
    cleanups.unshift(() =>
      createCoreV1ApiClient(kubeConfig)
        .deleteNamespace({ name: 'vpa' })
        .catch(() => undefined)
    );
    const instance = await factory.deploy({
      name: 'vpa',
      namespace: 'vpa',
      metricsServer: { enabled: true },
    });
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'VPA e2e cleanup failed');
  });

  it('accepts the rendered VerticalPodAutoscalers', async () => {
    const docs = manifests(
      app.factory('direct', { namespace: 'default' }).toYaml({ image: 'nginx' })
    ).filter((doc) => doc.kind === 'VerticalPodAutoscaler');
    expect(docs.map((doc) => doc.metadata.name).sort()).toEqual(['web', 'worker']);
    for (const doc of docs) {
      expect(await dryRun(doc)).toEqual({ ok: true, message: '' });
    }
    for (const updateMode of ['Initial', 'InPlaceOrRecreate', 'InPlace'] as const) {
      const doc = verticalPodAutoscaler({
        name: `mode-${updateMode.toLowerCase()}`,
        spec: {
          targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
          updatePolicy: {
            updateMode,
            evictionRequirements: [
              { resources: ['cpu'], changeRequirement: 'TargetHigherThanRequests' },
            ],
          },
          recommenders: [{ name: 'default' }],
        },
      });
      expect(await dryRun(JSON.parse(JSON.stringify(doc)) as Manifest)).toEqual({
        ok: true,
        message: '',
      });
    }
  });

  it('rejects an unknown update mode in the API server', async () => {
    const bad: Manifest = {
      apiVersion: 'autoscaling.k8s.io/v1',
      kind: 'VerticalPodAutoscaler',
      metadata: { name: `bad-${runToken}` },
      spec: {
        targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
        updatePolicy: { updateMode: 'Sometimes' },
      },
    };
    expect((await dryRun(bad)).ok).toBe(false);
  });

  it('recommends, and the admission webhook applies the recommendation', async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const factory = app.factory('direct', {
      namespace: appNamespace,
      kubeConfig,
      waitForReady: true,
      timeout: 600_000,
    });
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'vpa-e2e-app', [], kubeConfig, 180_000)
    );
    const core = createCoreV1ApiClient(kubeConfig);
    await core.createNamespace({ body: { metadata: { name: appNamespace } } });
    cleanups.push(() => core.deleteNamespace({ name: appNamespace }));

    // waitForReady covers both VPAs' RecommendationProvided condition.
    const instance = await factory.deploy({ image: 'nginx:1.27-alpine' });
    expect(instance.status.recommended).toBe(true);

    const pods = await core.listNamespacedPod({
      namespace: appNamespace,
      labelSelector: 'app=worker',
    });
    const victim = pods.items[0]?.metadata?.name;
    expect(victim).toBeDefined();
    await core.deleteNamespacedPod({ name: victim as string, namespace: appNamespace });

    const updated = await waitFor(
      'a worker pod admitted with VPA requests',
      async () => {
        const list = await core.listNamespacedPod({
          namespace: appNamespace,
          labelSelector: 'app=worker',
        });
        return list.items.find(
          (pod) =>
            pod.metadata?.name !== victim &&
            pod.metadata?.annotations?.vpaUpdates?.includes('container')
        );
      },
      180_000
    );
    // minAllowed raises the 10m / 16Mi requests.
    const requests = updated.spec?.containers?.[0]?.resources?.requests ?? {};
    expect(requests.memory).not.toBe('16Mi');
    expect(requests.cpu).not.toBe('10m');
  });

  it('KRO accepts the VPA RGDs against the live CRD schemas', async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const rgds = [vpaHelmRepositoryBootstrap.toYaml(), vpa.toYaml(), app.toYaml()]
      .flatMap(manifests)
      .filter((doc) => doc.kind === 'ResourceGraphDefinition');
    const names = [...new Set(rgds.map((rgd) => rgd.metadata.name))];
    expect(names.sort()).toEqual(['vpa-bootstrap', 'vpa-e2e-app', 'vpa-helm-repository']);

    const installer = kubernetesComposition(
      {
        name: 'vpa-e2e-rgds',
        kind: 'VpaE2ERgds',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const install = (name: string, id: string) =>
          resourceGraphDefinition({
            id,
            metadata: { name },
            spec: rgds.find((rgd) => rgd.metadata.name === name)?.spec ?? {},
          });
        const repository = install('vpa-helm-repository', 'repositoryRgd');
        // The bootstrap's externalRef needs the singleton's generated CRD first.
        install('vpa-bootstrap', 'bootstrapRgd').dependsOn(repository);
        install('vpa-e2e-app', 'appRgd');
        return { ready: true };
      }
    );
    const factory = installer.factory('direct', {
      namespace: 'default',
      kubeConfig,
      waitForReady: true,
      timeout: 180_000,
    });
    const instanceName = `vpa-rgds-${runToken}`;
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        instanceName,
        [],
        kubeConfig,
        120_000,
        { scopes: ['cluster'], includeUnscopedResources: true }
      )
    );
    await factory.deploy({ name: instanceName });

    const customApi = createCustomObjectsApiClient(kubeConfig);
    for (const name of names) {
      const raw = (await customApi.getClusterCustomObject({
        group: 'kro.run',
        version: 'v1alpha1',
        plural: 'resourcegraphdefinitions',
        name,
      })) as { body?: { status?: { state?: string } }; status?: { state?: string } };
      const rgd = raw.body ?? raw;
      expect({ name, state: rgd.status?.state }).toEqual({ name, state: 'Active' });
    }
  });
});
