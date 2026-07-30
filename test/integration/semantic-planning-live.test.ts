import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { createEventMonitor } from '../../src/core/deployment/event-monitor.js';
import { migrateLegacyKroArtifactBindingCrd } from '../../src/core/deployment/kro-artifact-binding-migration.js';
import {
  kroArtifactOutputField,
  kroArtifactRequirementField,
} from '../../src/core/planning/values.js';
import type { ResourceDeletionResult } from '../../src/core/types/deployment.js';
import { artifactOutput } from '../../src/experimental-planning.js';
import { configMap } from '../../src/factories/kubernetes/config/config-map.js';
import { networkPolicy } from '../../src/factories/kubernetes/networking/network-policy.js';
import { job } from '../../src/factories/kubernetes/workloads/job.js';
import { yamlFile } from '../../src/factories/kubernetes/yaml/yaml-file.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  createTestNamespace,
  deleteGeneratedCrdAndWait,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  deleteTestNamespaceAndWait,
  deleteTestResourceAndWait,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  type TestNamespaceLease,
} from './shared-kubeconfig.js';

const clusterAvailable = await isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;
const runToken = Math.random().toString(36).slice(2, 8);
const namespace = `typekro-semantic-live-${runToken}`;

setDefaultTimeout(600_000);

async function waitUntil(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
}

class GeneratedCrdNotFoundError extends Error {
  constructor(group: string, kind: string) {
    super(`Generated CRD for ${group}/${kind} was not found`);
    this.name = 'GeneratedCrdNotFoundError';
  }
}

async function findGeneratedCrd(
  api: k8s.KubernetesObjectApi,
  group: string,
  kind: string
): Promise<{
  metadata?: { name?: string; deletionTimestamp?: string };
  spec?: {
    versions?: Array<{
      name?: string;
      storage?: boolean;
      schema?: {
        openAPIV3Schema?: {
          properties?: Record<string, unknown>;
        };
      };
    }>;
  };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}> {
  const result = (await api.list(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition'
  )) as unknown as {
    items?: Array<{
      metadata?: { name?: string; deletionTimestamp?: string };
      spec?: {
        group?: string;
        names?: { kind?: string };
        versions?: Array<{
          name?: string;
          storage?: boolean;
          schema?: {
            openAPIV3Schema?: {
              properties?: Record<string, unknown>;
            };
          };
        }>;
      };
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    }>;
  };
  const crd = result.items?.find(
    (candidate) => candidate.spec?.group === group && candidate.spec?.names?.kind === kind
  );
  if (!crd) throw new GeneratedCrdNotFoundError(group, kind);
  return crd;
}

function generatedCrdPropertySchema(
  crd: Awaited<ReturnType<typeof findGeneratedCrd>>,
  property: string
): unknown {
  const version =
    crd.spec?.versions?.find((candidate) => candidate.storage) ?? crd.spec?.versions?.[0];
  const rootProperties = version?.schema?.openAPIV3Schema?.properties;
  const specSchema = rootProperties?.spec;
  if (!specSchema || typeof specSchema !== 'object') return undefined;
  const specProperties = Reflect.get(specSchema, 'properties');
  return specProperties && typeof specProperties === 'object'
    ? Reflect.get(specProperties, property)
    : undefined;
}

function isNestedStringMapSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Reflect.get(value, 'type') !== 'object') {
    return false;
  }
  const outerValues = Reflect.get(value, 'additionalProperties');
  if (
    !outerValues ||
    typeof outerValues !== 'object' ||
    Reflect.get(outerValues, 'type') !== 'object'
  ) {
    return false;
  }
  const innerValues = Reflect.get(outerValues, 'additionalProperties');
  return Boolean(
    innerValues && typeof innerValues === 'object' && Reflect.get(innerValues, 'type') === 'string'
  );
}

function currentGraphAccepted(resource: {
  metadata?: { generation?: number };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      observedGeneration?: number;
    }>;
  };
}): boolean {
  const generation = resource.metadata?.generation;
  return (
    typeof generation === 'number' &&
    resource.status?.conditions?.some(
      (condition) =>
        condition.type === 'GraphAccepted' &&
        condition.status === 'True' &&
        typeof condition.observedGeneration === 'number' &&
        condition.observedGeneration >= generation
    ) === true
  );
}

function managerOwnsConfigMapKey(
  resource: k8s.KubernetesObject,
  manager: string,
  key: string
): boolean {
  const entries = resource.metadata?.managedFields ?? [];
  return entries.some((entry) => {
    if (entry.manager !== manager) return false;
    const fields = entry.fieldsV1 as Record<string, unknown> | undefined;
    const data = fields?.['f:data'] as Record<string, unknown> | undefined;
    return Object.hasOwn(data ?? {}, `f:${key}`);
  });
}

describeOrSkip('semantic planning live acceptance', () => {
  let kubeConfig: k8s.KubeConfig;
  let coreApi: k8s.CoreV1Api;
  let objectApi: k8s.KubernetesObjectApi;
  let namespaceLease: TestNamespaceLease | undefined;

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kubeConfig = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kubeConfig);
    objectApi = createKubernetesObjectApiClient(kubeConfig);
    namespaceLease = await createTestNamespace(namespace, kubeConfig);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    if (namespaceLease) await deleteTestNamespaceAndWait(namespaceLease, kubeConfig);
  });

  it('authenticates Bun event watches and receives streamed Kubernetes events', async () => {
    const eventName = `watch-proof-${runToken}`;
    const received: Array<{ type: string; involvedObject?: { name?: string } }> = [];
    const monitor = createEventMonitor(kubeConfig, {
      namespace,
      eventTypes: ['Normal', 'Warning', 'Error'],
      includeChildResources: false,
      watchTimeoutSeconds: 5,
      progressCallback: (event) => {
        if (event.type === 'kubernetes-event') received.push(event);
      },
    });

    try {
      await monitor.startMonitoring([]);
      await Bun.sleep(250);
      await coreApi.createNamespacedEvent({
        namespace,
        body: {
          metadata: { name: eventName, namespace },
          involvedObject: {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            name: 'watch-proof',
            namespace,
          },
          message: 'TypeKro authenticated watch proof',
          reason: 'TypeKroWatchProof',
          source: { component: 'typekro-integration' },
          type: 'Normal',
        },
      });

      await waitUntil(
        'the authenticated watch event',
        async () => received.some((event) => event.involvedObject?.name === 'watch-proof'),
        30_000
      );
    } finally {
      await monitor.stopMonitoring();
      await deleteTestResourceAndWait(
        {
          apiVersion: 'v1',
          kind: 'Event',
          metadata: { name: eventName, namespace },
        },
        kubeConfig
      );
    }
  });

  it('reconciles an omitted-versus-empty NetworkPolicy without desired/live churn', async () => {
    const group = `normalization-${runToken}.typekro.dev`;
    const kind = `Normalization${runToken}`;
    const policyName = `deny-ingress-${runToken}`;
    const graph = kubernetesComposition(
      {
        name: `normalization-${runToken}`,
        apiVersion: `${group}/v1alpha1`,
        kind,
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        networkPolicy({
          id: 'policy',
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: { name: policyName, namespace },
          spec: { podSelector: {}, ingress: [], egress: [] },
        });
        return { ready: true };
      }
    );
    const factory = graph.factory('kro', {
      namespace,
      kubeConfig,
      timeout: 180_000,
      waitForReady: true,
    });

    try {
      await factory.deploy({ name: `normalization-${runToken}` });
      const live = (await objectApi.read({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: policyName, namespace },
      })) as k8s.KubernetesObject & { spec?: Record<string, unknown> };
      expect(live.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress'] });
      const liveGeneration = live.metadata?.generation;
      expect(liveGeneration).toBeDefined();

      await Bun.sleep(3_000);
      const stable = await objectApi.read({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: policyName, namespace },
      });
      expect(stable.metadata?.generation).toBe(liveGeneration!);
    } finally {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        `normalization-${runToken}`,
        [],
        kubeConfig,
        60_000
      );
    }
  });

  it('waits for an upgraded RGD schema before applying newly nested instance fields', async () => {
    const group = `schema-upgrade-${runToken}.typekro.dev`;
    const apiVersion = `${group}/v1alpha1`;
    const kind = `SchemaUpgrade${runToken}`;
    const rgdName = `schema-upgrade-${runToken}`;
    const instanceName = `schema-upgrade-${runToken}`;

    const originalGraph = kubernetesComposition(
      {
        name: rgdName,
        apiVersion,
        kind,
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        configMap({
          id: 'schemaUpgradeConfig',
          metadata: { name: spec.name, namespace },
          data: { nested: 'not-yet-declared' },
        });
        return { ready: true };
      }
    );
    const upgradedGraph = kubernetesComposition(
      {
        name: rgdName,
        apiVersion,
        kind,
        revision: '2',
        spec: type({
          name: 'string',
          settings: {
            nested: 'string',
          },
        }),
        status: type({ ready: 'boolean' }),
      },
      (spec) => {
        configMap({
          id: 'schemaUpgradeConfig',
          metadata: { name: spec.name, namespace },
          data: { nested: spec.settings.nested },
        });
        return { ready: true };
      }
    );
    const originalFactory = originalGraph.factory('kro', {
      namespace,
      kubeConfig,
      timeout: 180_000,
      waitForReady: true,
    });
    const upgradedFactory = upgradedGraph.factory('kro', {
      namespace,
      kubeConfig,
      timeout: 180_000,
      waitForReady: true,
    });
    const rgd = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: rgdName },
    };

    let testError: unknown;
    try {
      await originalFactory.deploy({ name: instanceName });
      await upgradedFactory.deploy({
        name: instanceName,
        settings: { nested: 'preserved-after-upgrade' },
      });

      const admitted = (await objectApi.read({
        apiVersion,
        kind,
        metadata: { name: instanceName, namespace },
      })) as { spec?: { settings?: { nested?: string } } };
      expect(admitted.spec?.settings?.nested).toBe('preserved-after-upgrade');

      const child = (await objectApi.read({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: instanceName, namespace },
      })) as { data?: { nested?: string } };
      expect(child.data?.nested).toBe('preserved-after-upgrade');
    } catch (error: unknown) {
      testError = error;
    }

    const cleanupErrors: unknown[] = [];
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      upgradedFactory,
      instanceName,
      [],
      kubeConfig,
      60_000
    ).catch((error) => cleanupErrors.push(error));

    await deleteTestResourceAndWait(rgd, kubeConfig, 60_000).catch((error) =>
      cleanupErrors.push(error)
    );

    const crds = await objectApi
      .list('apiextensions.k8s.io/v1', 'CustomResourceDefinition')
      .catch((error) => {
        cleanupErrors.push(error);
        return { items: [] };
      });
    for (const crd of crds.items) {
      if ((crd as { spec?: { group?: string } }).spec?.group !== group) continue;
      const crdName = crd.metadata?.name;
      if (!crdName) {
        cleanupErrors.push(new Error(`Generated CRD for ${group} has no metadata.name`));
        continue;
      }
      await deleteGeneratedCrdAndWait(
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: crdName },
        },
        apiVersion,
        kind,
        kubeConfig
      ).catch((error) => cleanupErrors.push(error));
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        'KRO schema-upgrade test or cleanup failed'
      );
    }

    if (testError !== undefined) throw testError;
  }, 300_000);

  it('upgrades v0.32 artifact-backed instances without changing their persisted value shape', async () => {
    const group = `artifact-upgrade-${runToken}.typekro.dev`;
    const apiVersion = `${group}/v1alpha1`;
    const kind = `ArtifactUpgrade${runToken}`;
    const rgdName = `artifact-upgrade-${runToken}`;
    const instanceName = `artifact-upgrade-${runToken}`;
    const requirementField = kroArtifactRequirementField('build');
    const imageOutputField = kroArtifactOutputField('image');
    const digestOutputField = kroArtifactOutputField('digest');
    const composition = (includeDigest: boolean) =>
      kubernetesComposition(
        {
          name: rgdName,
          apiVersion,
          kind,
          revision: '1',
          spec: type({ name: 'string' }),
          status: type({ ready: 'boolean' }),
        },
        (spec) => {
          configMap({
            id: 'artifactConfig',
            metadata: { name: spec.name, namespace },
            data: {
              image: artifactOutput('build', 'image'),
              ...(includeDigest ? { digest: artifactOutput('build', 'digest') } : {}),
            },
          });
          return { ready: true };
        }
      );
    const artifactPlan = (outputs: readonly string[]) => ({
      inputs: {
        build: {
          kind: 'artifact' as const,
          requirement: {
            id: 'build',
            kind: 'container-image',
            descriptor: { kind: 'literal' as const, value: instanceName },
            outputs,
          },
        },
      },
    });
    const v032Graph = composition(false);
    const upgradedGraph = composition(true);
    const v032Plan = artifactPlan(['image']);
    const upgradedPlan = artifactPlan(['image', 'digest']);
    const factory = upgradedGraph.factory('kro', {
      namespace,
      kubeConfig,
      timeout: 180_000,
      waitForReady: true,
      plan: upgradedPlan,
    });
    const upgradedRenderFactory = upgradedGraph.factory('kro', {
      namespace,
      timeout: 180_000,
      waitForReady: true,
      plan: upgradedPlan,
    });
    const upgradedDeclarations = await upgradedRenderFactory.toAlchemyResources({
      name: instanceName,
    });
    const upgradedRgdDeclaration = upgradedDeclarations.find(
      (declaration) => declaration.props.resource.kind === 'ResourceGraphDefinition'
    );
    if (!upgradedRgdDeclaration) throw new Error('Expected an upgraded RGD declaration');
    const upgradedRgd = JSON.parse(
      JSON.stringify(upgradedRgdDeclaration.props.resource)
    ) as k8s.KubernetesObject & {
      spec?: { schema?: { spec?: Record<string, unknown> } };
    };
    const newBindingSchema = upgradedRgd.spec?.schema?.spec?.typekroArtifactBindings;
    expect(newBindingSchema).toBe('map[string]map[string]string');

    // This is the exact persisted shape emitted by v0.32.0: topology-specific
    // object schema and two nested hashed keys in every instance.
    const v032RenderFactory = v032Graph.factory('kro', {
      namespace,
      timeout: 180_000,
      waitForReady: true,
      plan: v032Plan,
    });
    const v032Declarations = await v032RenderFactory.toAlchemyResources({
      name: instanceName,
    });
    const v032RgdDeclaration = v032Declarations.find(
      (declaration) => declaration.props.resource.kind === 'ResourceGraphDefinition'
    );
    if (!v032RgdDeclaration) throw new Error('Expected a v0.32 RGD declaration');
    const v032Rgd = JSON.parse(
      JSON.stringify(v032RgdDeclaration.props.resource)
    ) as typeof upgradedRgd;
    if (!v032Rgd.spec?.schema?.spec) throw new Error('Expected a KRO spec schema');
    v032Rgd.spec.schema.spec.typekroArtifactBindings = {
      [requirementField]: { [imageOutputField]: 'string' },
    };
    const instance = (
      image: string,
      digest?: string
    ): k8s.KubernetesObject & {
      spec: {
        name: string;
        typekroArtifactBindings: Record<string, Record<string, string>>;
      };
    } => ({
      apiVersion,
      kind,
      metadata: { name: instanceName, namespace },
      spec: {
        name: instanceName,
        typekroArtifactBindings: {
          [requirementField]: {
            [imageOutputField]: image,
            ...(digest ? { [digestOutputField]: digest } : {}),
          },
        },
      },
    });
    const rgdIdentity = {
      apiVersion: 'kro.run/v1alpha1',
      kind: 'ResourceGraphDefinition',
      metadata: { name: rgdName },
    };

    let testError: unknown;
    try {
      await objectApi.create(v032Rgd);
      await waitUntil('the v0.32 artifact RGD and generated CRD', async () => {
        try {
          const liveRgd = (await objectApi.read(rgdIdentity)) as {
            metadata?: { generation?: number };
            status?: {
              conditions?: Array<{
                type?: string;
                status?: string;
                observedGeneration?: number;
              }>;
            };
          };
          if (!currentGraphAccepted(liveRgd)) return false;
          const crd = await findGeneratedCrd(objectApi, group, kind);
          return (
            crd.status?.conditions?.some(
              (condition) => condition.type === 'Established' && condition.status === 'True'
            ) === true
          );
        } catch {
          return false;
        }
      });

      await objectApi.create(instance('registry.example/app:v1'));
      await waitUntil('the v0.32-bound child value', async () => {
        try {
          const child = (await objectApi.read({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: instanceName, namespace },
          })) as { data?: { image?: string } };
          return child.data?.image === 'registry.example/app:v1';
        } catch {
          return false;
        }
      });

      // Reproduce an interruption after the stable RGD write but before the
      // generated CRD migration. A retry must inspect the CRD rather than
      // treating the already-stable live RGD as proof that migration finished.
      await objectApi.patch(
        upgradedRgd,
        undefined,
        undefined,
        undefined,
        undefined,
        'application/merge-patch+json'
      );
      await waitUntil('the interrupted artifact migration state', async () => {
        try {
          const live = (await objectApi.read(rgdIdentity)) as {
            metadata?: { generation?: number };
            spec?: { schema?: { spec?: Record<string, unknown> } };
            status?: {
              conditions?: Array<{
                type?: string;
                status?: string;
                observedGeneration?: number;
              }>;
            };
          };
          const generation = live.metadata?.generation;
          const crd = await findGeneratedCrd(objectApi, group, kind);
          return (
            live.spec?.schema?.spec?.typekroArtifactBindings === 'map[string]map[string]string' &&
            typeof generation === 'number' &&
            live.status?.conditions?.some(
              (condition) =>
                condition.type === 'KindReady' &&
                condition.status === 'False' &&
                condition.observedGeneration === generation
            ) === true &&
            !isNestedStringMapSchema(generatedCrdPropertySchema(crd, 'typekroArtifactBindings'))
          );
        } catch {
          return false;
        }
      });
      await migrateLegacyKroArtifactBindingCrd(kubeConfig, upgradedRgd);
      let lastUpgradeObservation: unknown;
      try {
        await waitUntil(
          'the topology-independent artifact schema',
          async () => {
            try {
              const live = (await objectApi.read(rgdIdentity)) as {
                metadata?: { generation?: number };
                spec?: { schema?: { spec?: Record<string, unknown> } };
                status?: {
                  conditions?: Array<{
                    type?: string;
                    status?: string;
                    observedGeneration?: number;
                  }>;
                };
              };
              const crd = await findGeneratedCrd(objectApi, group, kind);
              const bindingSchema = generatedCrdPropertySchema(crd, 'typekroArtifactBindings');
              lastUpgradeObservation = {
                generation: live.metadata?.generation,
                conditions: live.status?.conditions,
                rgdBindingSchema: live.spec?.schema?.spec?.typekroArtifactBindings,
                generatedCrdBindingSchema: bindingSchema,
              };
              return (
                live.spec?.schema?.spec?.typekroArtifactBindings ===
                  'map[string]map[string]string' &&
                currentGraphAccepted(live) &&
                isNestedStringMapSchema(bindingSchema)
              );
            } catch (error: unknown) {
              lastUpgradeObservation = {
                error: error instanceof Error ? error.message : String(error),
              };
              return false;
            }
          },
          120_000
        );
      } catch (error: unknown) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; last observation: ${JSON.stringify(lastUpgradeObservation)}`
        );
      }

      await objectApi.patch(
        instance(
          'registry.example/app:v2',
          'sha256:2222222222222222222222222222222222222222222222222222222222222222'
        ),
        undefined,
        undefined,
        undefined,
        undefined,
        'application/merge-patch+json'
      );
      await waitUntil('the upgraded artifact binding value', async () => {
        try {
          const child = (await objectApi.read({
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: instanceName, namespace },
          })) as { data?: { image?: string; digest?: string } };
          return (
            child.data?.image === 'registry.example/app:v2' &&
            child.data?.digest ===
              'sha256:2222222222222222222222222222222222222222222222222222222222222222'
          );
        } catch {
          return false;
        }
      });

      const admitted = (await objectApi.read({
        apiVersion,
        kind,
        metadata: { name: instanceName, namespace },
      })) as {
        spec?: {
          typekroArtifactBindings?: Record<string, Record<string, string>>;
        };
      };
      expect(admitted.spec?.typekroArtifactBindings).toEqual({
        [requirementField]: {
          [imageOutputField]: 'registry.example/app:v2',
          [digestOutputField]:
            'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        },
      });
    } catch (error: unknown) {
      testError = error;
    }

    const cleanupErrors: unknown[] = [];
    await deleteTestFactoryInstanceAndRecoverNamespaces(
      factory,
      instanceName,
      [],
      kubeConfig,
      60_000
    ).catch((error) => cleanupErrors.push(error));
    await deleteTestResourceAndWait(rgdIdentity, kubeConfig, 60_000).catch((error) =>
      cleanupErrors.push(error)
    );
    let generatedCrd: Awaited<ReturnType<typeof findGeneratedCrd>> | undefined;
    try {
      generatedCrd = await findGeneratedCrd(objectApi, group, kind);
    } catch (error: unknown) {
      if (!(error instanceof GeneratedCrdNotFoundError)) {
        cleanupErrors.push(error);
      }
    }
    if (generatedCrd?.metadata?.name) {
      await deleteGeneratedCrdAndWait(
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          metadata: { name: generatedCrd.metadata.name },
        },
        apiVersion,
        kind,
        kubeConfig
      ).catch((error) => cleanupErrors.push(error));
    }
    try {
      const retainedCrd = await findGeneratedCrd(objectApi, group, kind);
      cleanupErrors.push(
        new Error(
          `Generated CRD ${retainedCrd.metadata?.name ?? `${group}/${kind}`} remained after cleanup`
        )
      );
    } catch (error: unknown) {
      if (!(error instanceof GeneratedCrdNotFoundError)) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        'KRO v0.32 artifact-binding upgrade test or cleanup failed'
      );
    }
    if (testError !== undefined) throw testError;
  }, 300_000);

  it('removes a completed Job and Pod while retaining its generated CRD Active', async () => {
    const group = `completed-${runToken}.typekro.dev`;
    const kind = `CompletedJob${runToken}`;
    const jobName = `completed-${runToken}`;
    const instanceName = `completed-${runToken}`;
    const graph = kubernetesComposition(
      {
        name: `completed-job-${runToken}`,
        apiVersion: `${group}/v1alpha1`,
        kind,
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        const completion = job({
          id: 'completion',
          metadata: { name: jobName, namespace },
          spec: {
            backoffLimit: 0,
            template: {
              metadata: { labels: { 'typekro.dev/completed-job': runToken } },
              spec: {
                restartPolicy: 'Never',
                containers: [
                  {
                    name: 'complete',
                    image: 'busybox:1.36.1',
                    command: ['/bin/sh', '-c', 'echo complete'],
                  },
                ],
              },
            },
          },
        });
        return { ready: completion.status.succeeded === 1 };
      }
    );
    const factory = graph.factory('kro', {
      namespace,
      kubeConfig,
      timeout: 300_000,
      waitForReady: true,
    });

    try {
      await factory.deploy({ name: instanceName });
      await waitUntil('the Job to complete', async () => {
        const live = await coreApi
          .listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` })
          .catch(() => ({ items: [] }));
        return live.items.some((pod) => pod.status?.phase === 'Succeeded');
      });

      const deletion = (await factory.deleteInstance(instanceName)) as ResourceDeletionResult;
      expect(deletion.status).toBe('complete');
      expect(deletion.retained).toEqual(
        expect.arrayContaining([expect.objectContaining({ policy: 'generated-crd' })])
      );
      await waitUntil('the completed Job Pod to be deleted', async () => {
        const pods = await coreApi.listNamespacedPod({
          namespace,
          labelSelector: `job-name=${jobName}`,
        });
        return pods.items.length === 0;
      });

      const crd = await findGeneratedCrd(objectApi, group, kind);
      expect(crd.metadata?.deletionTimestamp).toBeUndefined();
      expect(crd.status?.conditions).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'Established', status: 'True' })])
      );
    } finally {
      await deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        instanceName,
        [],
        kubeConfig,
        120_000
      );
    }
  }, 600_000);

  it('preserves direct and YAML SSA field ownership semantics', async () => {
    const directName = `ssa-direct-${runToken}`;
    const yamlName = `ssa-yaml-${runToken}`;
    const externalManager = `external-${runToken}`;
    const directManager = `typekro-direct-${runToken}`;
    const yamlManager = `typekro-yaml-${runToken}`;
    const graph = kubernetesComposition(
      {
        name: `ssa-direct-${runToken}`,
        apiVersion: `ssa-${runToken}.typekro.dev/v1alpha1`,
        kind: `SsaDirect${runToken}`,
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        configMap({
          id: 'ownedConfig',
          metadata: { name: directName, namespace },
          data: { owned: 'typekro', coexists: 'direct-only' },
        });
        return { ready: true };
      }
    );
    const failFactory = graph.factory('direct', {
      namespace,
      kubeConfig,
      waitForReady: true,
      timeout: 60_000,
      applyPolicy: {
        strategy: 'server-side-apply',
        fieldManager: directManager,
        fieldConflictPolicy: 'fail',
        immutableFieldPolicy: 'fail',
      },
    });
    const forceFactory = graph.factory('direct', {
      namespace,
      kubeConfig,
      waitForReady: true,
      timeout: 60_000,
      applyPolicy: {
        strategy: 'server-side-apply',
        fieldManager: directManager,
        fieldConflictPolicy: 'force-owned-fields',
        immutableFieldPolicy: 'fail',
      },
    });
    const yamlDirectory = mkdtempSync(join(tmpdir(), 'typekro-ssa-'));
    const yamlPath = join(yamlDirectory, 'config-map.yaml');
    writeFileSync(
      yamlPath,
      [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        `  name: ${yamlName}`,
        `  namespace: ${namespace}`,
        'data:',
        '  owned: yaml',
        '',
      ].join('\n')
    );
    const yamlGraph = kubernetesComposition(
      {
        name: `ssa-yaml-${runToken}`,
        apiVersion: `ssa-yaml-${runToken}.typekro.dev/v1alpha1`,
        kind: `SsaYaml${runToken}`,
        revision: '1',
        spec: type({ name: 'string' }),
        status: type({ ready: 'boolean' }),
      },
      () => {
        yamlFile({
          name: 'ssa-yaml',
          path: yamlPath,
          deploymentStrategy: 'serverSideApply',
          fieldManager: yamlManager,
        });
        return { ready: true };
      }
    );
    const yamlFactory = yamlGraph.factory('direct', {
      namespace,
      kubeConfig,
      waitForReady: true,
      timeout: 60_000,
    });

    try {
      await objectApi.create(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: directName, namespace },
          data: { owned: 'external', externalOnly: 'preserved' },
        },
        undefined,
        undefined,
        externalManager
      );

      await expect(failFactory.deploy({ name: directName })).rejects.toMatchObject({
        cause: {
          cause: {
            name: 'ServerSideApplyConflictError',
            code: 'SERVER_SIDE_APPLY_CONFLICT',
          },
        },
      });

      await forceFactory.deploy({ name: directName });
      const directLive = (await objectApi.read({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: directName, namespace },
      })) as k8s.KubernetesObject & { data?: Record<string, string> };
      expect(directLive.data).toEqual({
        owned: 'typekro',
        coexists: 'direct-only',
        externalOnly: 'preserved',
      });
      expect(managerOwnsConfigMapKey(directLive, directManager, 'owned')).toBe(true);
      expect(managerOwnsConfigMapKey(directLive, externalManager, 'owned')).toBe(false);
      expect(managerOwnsConfigMapKey(directLive, externalManager, 'externalOnly')).toBe(true);

      await yamlFactory.deploy({ name: yamlName });
      const yamlLive = await objectApi.read({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: yamlName, namespace },
      });
      expect(managerOwnsConfigMapKey(yamlLive, yamlManager, 'owned')).toBe(true);
    } finally {
      rmSync(yamlDirectory, { recursive: true, force: true });
      await deleteTestResourceAndWait(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: directName, namespace },
        },
        kubeConfig
      );
      await deleteTestResourceAndWait(
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: yamlName, namespace },
        },
        kubeConfig
      );
    }
  }, 180_000);
});
