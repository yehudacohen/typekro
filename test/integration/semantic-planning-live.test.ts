import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as k8s from '@kubernetes/client-node';
import { type } from 'arktype';
import { kubernetesComposition } from '../../src/core/composition/imperative.js';
import { createEventMonitor } from '../../src/core/deployment/event-monitor.js';
import type { ResourceDeletionResult } from '../../src/core/types/deployment.js';
import { configMap } from '../../src/factories/kubernetes/config/config-map.js';
import { networkPolicy } from '../../src/factories/kubernetes/networking/network-policy.js';
import { job } from '../../src/factories/kubernetes/workloads/job.js';
import { yamlFile } from '../../src/factories/kubernetes/yaml/yaml-file.js';
import {
  createCoreV1ApiClient,
  createKubernetesObjectApiClient,
  deleteGeneratedCrdAndWait,
  deleteTestNamespaceAndWait,
  ensureNamespaceExists,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
  isNotFoundError,
  waitForResourceAbsent,
} from './shared-kubeconfig.js';

const clusterAvailable = isClusterAvailable();
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

async function findGeneratedCrd(
  api: k8s.KubernetesObjectApi,
  group: string,
  kind: string
): Promise<{
  metadata?: { name?: string; deletionTimestamp?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}> {
  const result = (await api.list(
    'apiextensions.k8s.io/v1',
    'CustomResourceDefinition'
  )) as unknown as {
    items?: Array<{
      metadata?: { name?: string; deletionTimestamp?: string };
      spec?: { group?: string; names?: { kind?: string } };
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    }>;
  };
  const crd = result.items?.find(
    (candidate) => candidate.spec?.group === group && candidate.spec?.names?.kind === kind
  );
  if (!crd) throw new Error(`Generated CRD for ${group}/${kind} was not found`);
  return crd;
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

  beforeAll(async () => {
    if (!clusterAvailable) return;
    kubeConfig = getIntegrationTestKubeConfig();
    coreApi = createCoreV1ApiClient(kubeConfig);
    objectApi = createKubernetesObjectApiClient(kubeConfig);
    await ensureNamespaceExists(namespace, kubeConfig);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    await deleteTestNamespaceAndWait(namespace, kubeConfig);
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
      await coreApi.deleteNamespacedEvent({ name: eventName, namespace }).catch(() => undefined);
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
      await factory.deleteInstance(`normalization-${runToken}`).catch(() => undefined);
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
    await upgradedFactory.deleteInstance(instanceName).catch((error) => cleanupErrors.push(error));

    await objectApi.delete(rgd).catch((error: unknown) => {
      if (!isNotFoundError(error)) cleanupErrors.push(error);
    });
    await waitForResourceAbsent(rgd, kubeConfig, 60_000).catch((error) =>
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
      await objectApi
        .delete({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: directName, namespace },
        })
        .catch(() => undefined);
      await objectApi
        .delete({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: yamlName, namespace },
        })
        .catch(() => undefined);
    }
  }, 180_000);
});
