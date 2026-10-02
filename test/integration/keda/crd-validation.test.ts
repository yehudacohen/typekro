/**
 * KEDA against the real chart, CRDs and admission webhook — cluster-gated.
 *
 * 1. `kedaBootstrap` installs the pinned kedacore chart through Flux.
 * 2. The manifests the factories render (every typed trigger, the untyped
 *    escape hatch, ScaledJob, both trigger authentications) pass server-side
 *    dry-run against the installed CRDs and KEDA's webhook.
 * 3. What the validators reject, the API server rejects too: replica bounds
 *    (CRD rule), and a ScaledObject on a workload that already has an HPA
 *    (webhook).
 * 4. A cron-triggered ScaledObject becomes Ready and Active, KEDA creates its
 *    HPA, and the Deployment is scaled to the cron's replica count.
 * 5. KRO accepts the RGDs and reports them `Active`.
 *
 * Prerequisites: a cluster with Flux and KRO (`bun run scripts/e2e-setup.ts`)
 * and outbound access to kedacore.github.io and ghcr.io.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { V1Deployment } from '@kubernetes/client-node';
import { type } from 'arktype';
import { loadAll } from 'js-yaml';

import { kubernetesComposition } from '../../../src/core/composition/imperative.js';
import { DEFAULT_FLUX_NAMESPACE } from '../../../src/core/config/defaults.js';
import {
  kedaHelmRepositoryBootstrap,
  makeKedaBootstrap,
} from '../../../src/factories/keda/compositions/index.js';
import { kedaActive, kedaReady } from '../../../src/factories/keda/resources/readiness.js';
import { scaledJob } from '../../../src/factories/keda/resources/scaled-job.js';
import { scaledObject } from '../../../src/factories/keda/resources/scaled-object.js';
import {
  clusterTriggerAuthentication,
  triggerAuthentication,
} from '../../../src/factories/keda/resources/trigger-authentication.js';
import { kedaTrigger } from '../../../src/factories/keda/resources/triggers.js';
import type { KedaTrigger } from '../../../src/factories/keda/types.js';
import { validateScaledObjectSpec } from '../../../src/factories/keda/utils/validation.js';
import { resourceGraphDefinition } from '../../../src/factories/kro/resource-graph-definition.js';
import { deployment } from '../../../src/factories/kubernetes/workloads/deployment.js';
import {
  createAppsV1ApiClient,
  createCoreV1ApiClient,
  createCustomObjectsApiClient,
  deleteTestFactoryInstanceAndRecoverNamespaces,
  getIntegrationTestKubeConfig,
  isClusterAvailable,
} from '../shared-kubeconfig.js';

const describeOrSkip = (await isClusterAvailable()) ? describe : describe.skip;
setDefaultTimeout(900_000);

const runToken = Date.now().toString(36).slice(-6);
const appNamespace = `keda-e2e-${runToken}`;

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  spec?: Record<string, unknown>;
}

const PLURALS: Record<string, string> = {
  ScaledObject: 'scaledobjects',
  ScaledJob: 'scaledjobs',
  TriggerAuthentication: 'triggerauthentications',
  ClusterTriggerAuthentication: 'clustertriggerauthentications',
};

const keda = makeKedaBootstrap({ namespaceOwnership: 'owned' });

const prometheus: KedaTrigger = {
  type: 'prometheus',
  name: 'inflight',
  metadata: {
    serverAddress: 'http://prometheus.monitoring.svc:9090',
    query: 'sum(http_server_active_requests{service="web"})',
    threshold: '20',
    activationThreshold: '1',
  },
};

const typedTriggers: KedaTrigger[] = [
  prometheus,
  {
    type: 'prometheus',
    name: 'latency',
    metricType: 'Value',
    metadata: {
      serverAddress: 'http://prometheus.monitoring.svc:9090',
      query:
        'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[2m])) by (le))',
      threshold: '0.3',
    },
  },
  { type: 'cpu', metricType: 'Utilization', metadata: { value: '70' } },
  { type: 'memory', metricType: 'AverageValue', metadata: { value: '256Mi' } },
  {
    type: 'aws-sqs-queue',
    metadata: {
      queueURL: 'https://sqs.us-east-1.amazonaws.com/111122223333/jobs',
      awsRegion: 'us-east-1',
    },
    authenticationRef: { name: 'aws', kind: 'ClusterTriggerAuthentication' },
  },
  {
    type: 'aws-cloudwatch',
    metadata: {
      awsRegion: 'us-east-1',
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionName: 'QueueName',
      dimensionValue: 'jobs',
      targetMetricValue: '10',
      minMetricValue: '0',
    },
    authenticationRef: { name: 'aws', kind: 'ClusterTriggerAuthentication' },
  },
  {
    type: 'cron',
    metadata: {
      timezone: 'Etc/UTC',
      start: '0 8 * * 1-5',
      end: '0 18 * * 1-5',
      desiredReplicas: '4',
    },
  },
  {
    type: 'metrics-api',
    metadata: { url: 'http://stats.default.svc/queue', valueLocation: 'depth', targetValue: '100' },
  },
  {
    type: 'postgresql',
    metadata: {
      query: 'SELECT count(*) FROM jobs',
      targetQueryValue: '5',
      connectionFromEnv: 'PG_URL',
    },
  },
  {
    type: 'redis',
    metadata: { address: 'redis.default.svc:6379', listName: 'jobs', listLength: '5' },
  },
  kedaTrigger('rabbitmq', {
    queueName: 'jobs',
    mode: 'QueueLength',
    value: '10',
    hostFromEnv: 'AMQP_URL',
  }),
];

/** The workload the ScaledObjects target; requests make the cpu/memory triggers valid. */
function web(name: string) {
  return deployment({
    metadata: { name, labels: { app: name } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [
            {
              name: 'web',
              image: 'nginx:1.27-alpine',
              resources: { requests: { cpu: '10m', memory: '16Mi' } },
            },
          ],
        },
      },
    },
    id: name,
  });
}

/** A Deployment scaled by a cron window that is open all day. */
const cronApp = kubernetesComposition(
  {
    name: 'keda-e2e-app',
    kind: 'KedaE2EApp',
    spec: type({ name: 'string', replicas: 'number.integer' }),
    status: type({ ready: 'boolean', active: 'boolean', hpa: 'string' }),
  },
  (spec) => {
    const clock = web('clock');
    const scaler = scaledObject({
      name: 'clock',
      spec: {
        // The resource itself: orders the ScaledObject after the Deployment,
        // which KEDA's webhook requires.
        scaleTargetRef: clock,
        minReplicaCount: 1,
        maxReplicaCount: 5,
        pollingInterval: 5,
        triggers: [
          {
            type: 'cron',
            name: 'always',
            metadata: {
              timezone: 'Etc/UTC',
              start: '0 0 * * *',
              end: '59 23 * * *',
              desiredReplicas: '2',
            },
          },
        ],
      },
      id: 'clockScaler',
    });
    triggerAuthentication({
      name: 'prometheus-auth',
      spec: {
        secretTargetRef: [{ parameter: 'bearerToken', name: 'prometheus-reader', key: 'token' }],
      },
      id: 'promAuth',
    });
    scaledJob({
      name: 'drain',
      spec: {
        jobTargetRef: {
          template: {
            spec: {
              restartPolicy: 'Never',
              containers: [{ name: 'drain', image: 'busybox:1.36' }],
            },
          },
        },
        maxReplicaCount: spec.replicas,
        triggers: [
          {
            type: 'cron',
            metadata: {
              timezone: 'Etc/UTC',
              start: '0 0 * * *',
              end: '59 23 * * *',
              desiredReplicas: '1',
            },
          },
        ],
      },
      id: 'drainJob',
    });
    return { ready: kedaReady(scaler), active: kedaActive(scaler), hpa: scaler.status.hpaName };
  }
);

function manifests(yaml: string): Manifest[] {
  return (loadAll(yaml) as Manifest[]).filter((doc) => doc && typeof doc === 'object');
}

function plain(resource: unknown): Manifest {
  return JSON.parse(JSON.stringify(resource)) as Manifest;
}

/** A plain Deployment manifest for `name` in the test namespace. */
function deploymentBody(name: string): V1Deployment {
  const manifest = plain(web(name)) as unknown as V1Deployment;
  return { ...manifest, metadata: { name, namespace: appNamespace, labels: { app: name } } };
}

async function dryRun(manifest: Manifest): Promise<{ ok: boolean; message: string }> {
  const [group, version] = manifest.apiVersion.split('/');
  const api = createCustomObjectsApiClient(getIntegrationTestKubeConfig());
  const plural = PLURALS[manifest.kind] ?? '';
  try {
    if (manifest.kind === 'ClusterTriggerAuthentication') {
      await api.createClusterCustomObject({
        group: group ?? '',
        version: version ?? '',
        plural,
        body: manifest,
        dryRun: 'All',
        fieldValidation: 'Strict',
      });
    } else {
      await api.createNamespacedCustomObject({
        group: group ?? '',
        version: version ?? '',
        namespace: appNamespace,
        plural,
        body: { ...manifest, metadata: { ...manifest.metadata, namespace: appNamespace } },
        dryRun: 'All',
        fieldValidation: 'Strict',
      });
    }
    return { ok: true, message: '' };
  } catch (error: unknown) {
    const candidate = error as { body?: unknown; message?: string };
    return { ok: false, message: JSON.stringify(candidate.body ?? candidate.message ?? error) };
  }
}

describeOrSkip('KEDA (pinned kedacore chart)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const factory = keda.factory('direct', {
      namespace: DEFAULT_FLUX_NAMESPACE,
      kubeConfig,
      waitForReady: true,
      timeout: 600_000,
    });
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(factory, 'keda', [], kubeConfig, 300_000)
    );
    // The CRDs are kept on uninstall (`keepCrdsOnUninstall`); remove them last.
    cleanups.unshift(async () => {
      const crds = [
        'scaledobjects.keda.sh',
        'scaledjobs.keda.sh',
        'triggerauthentications.keda.sh',
        'clustertriggerauthentications.keda.sh',
        'cloudeventsources.eventing.keda.sh',
        'clustercloudeventsources.eventing.keda.sh',
      ];
      const api = createCustomObjectsApiClient(kubeConfig);
      for (const crd of crds) {
        await api
          .deleteClusterCustomObject({
            group: 'apiextensions.k8s.io',
            version: 'v1',
            plural: 'customresourcedefinitions',
            name: crd,
          })
          .catch(() => undefined);
      }
      await createCoreV1ApiClient(kubeConfig)
        .deleteNamespace({ name: 'keda' })
        .catch(() => undefined);
    });
    const instance = await factory.deploy({ name: 'keda', namespace: 'keda' });
    expect(instance.status.ready).toBe(true);
    expect(instance.status.phase).toBe('Ready');

    // The webhook validates cpu/memory triggers against the target's requests,
    // so the dry-run target must exist.
    const core = createCoreV1ApiClient(kubeConfig);
    await core.createNamespace({ body: { metadata: { name: appNamespace } } });
    cleanups.unshift(() => core.deleteNamespace({ name: appNamespace }).catch(() => undefined));
    await createAppsV1ApiClient(kubeConfig).createNamespacedDeployment({
      namespace: appNamespace,
      body: deploymentBody('web'),
    });
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
    if (failures.length > 0) throw new AggregateError(failures, 'KEDA e2e cleanup failed');
  });

  it('accepts every typed trigger, ScaledJob and both trigger authentications', async () => {
    const resources = [
      scaledObject({
        name: 'web',
        spec: {
          scaleTargetRef: { name: 'web' },
          minReplicaCount: 1,
          maxReplicaCount: 10,
          idleReplicaCount: 0,
          fallback: { failureThreshold: 3, replicas: 4, behavior: 'currentReplicasIfHigher' },
          advanced: {
            restoreToOriginalReplicaCount: true,
            horizontalPodAutoscalerConfig: {
              behavior: {
                scaleDown: {
                  stabilizationWindowSeconds: 300,
                  policies: [{ type: 'Percent', value: 25, periodSeconds: 60 }],
                },
              },
            },
          },
          triggers: typedTriggers,
        },
      }),
      scaledObject({
        name: 'web-formula',
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' },
          minReplicaCount: 1,
          advanced: {
            scalingModifiers: {
              formula: 'latency > 0.3 ? inflight * 1.5 : inflight',
              target: '20',
              metricType: 'AverageValue',
            },
          },
          triggers: typedTriggers.slice(0, 2),
        },
      }),
      scaledJob({
        name: 'drain',
        spec: {
          jobTargetRef: {
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [{ name: 'drain', image: 'busybox:1.36' }],
              },
            },
          },
          rollout: { strategy: 'gradual' },
          scalingStrategy: { strategy: 'accurate', multipleScalersCalculation: 'max' },
          triggers: [prometheus],
        },
      }),
      triggerAuthentication({
        name: 'prometheus-auth',
        spec: {
          secretTargetRef: [{ parameter: 'bearerToken', name: 'prometheus-reader', key: 'token' }],
          configMapTargetRef: [{ parameter: 'ca', name: 'prometheus-ca', key: 'ca.crt' }],
          env: [{ parameter: 'username', name: 'PROM_USER', containerName: 'web' }],
          boundServiceAccountToken: [{ parameter: 'token', serviceAccountName: 'default' }],
        },
      }),
      triggerAuthentication({
        name: 'azure',
        spec: {
          podIdentity: {
            provider: 'azure-workload',
            identityId: '00000000-0000-0000-0000-000000000000',
          },
        },
      }),
      clusterTriggerAuthentication({
        name: `aws-${runToken}`,
        spec: {
          podIdentity: {
            provider: 'aws',
            roleArn: 'arn:aws:iam::111122223333:role/sqs-reader',
            identityOwner: 'keda',
          },
        },
      }),
      clusterTriggerAuthentication({
        name: `gcp-${runToken}`,
        spec: { podIdentity: { provider: 'gcp' } },
      }),
    ];
    for (const resource of resources) {
      const manifest = plain(resource);
      expect({ name: manifest.metadata.name, result: await dryRun(manifest) }).toEqual({
        name: manifest.metadata.name,
        result: { ok: true, message: '' },
      });
    }
  });

  it('rejects in the API server what the validators reject', async () => {
    const bounds = {
      scaleTargetRef: { name: 'web' },
      minReplicaCount: 5,
      maxReplicaCount: 2,
      triggers: [prometheus],
    };
    expect(validateScaledObjectSpec(bounds).some((issue) => issue.severity === 'error')).toBe(true);
    const crd = await dryRun({
      apiVersion: 'keda.sh/v1alpha1',
      kind: 'ScaledObject',
      metadata: { name: 'bounds' },
      spec: bounds,
    });
    expect(crd.ok).toBe(false);
    expect(crd.message).toContain('minReplicaCount must be less than or equal to maxReplicaCount');

    // KEDA's webhook refuses a second autoscaler on a workload with an HPA.
    const kubeConfig = getIntegrationTestKubeConfig();
    await createAppsV1ApiClient(kubeConfig).createNamespacedDeployment({
      namespace: appNamespace,
      body: deploymentBody('scaled'),
    });
    await createCustomObjectsApiClient(kubeConfig).createNamespacedCustomObject({
      group: 'autoscaling',
      version: 'v2',
      namespace: appNamespace,
      plural: 'horizontalpodautoscalers',
      body: {
        apiVersion: 'autoscaling/v2',
        kind: 'HorizontalPodAutoscaler',
        metadata: { name: 'scaled' },
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'scaled' },
          minReplicas: 1,
          maxReplicas: 3,
        },
      },
    });
    const webhook = await dryRun(
      plain(
        scaledObject({
          name: 'scaled',
          spec: { scaleTargetRef: { name: 'scaled' }, triggers: [prometheus] },
        })
      )
    );
    expect(webhook.ok).toBe(false);
    expect(webhook.message.toLowerCase()).toContain('hpa');
  });

  it('scales a Deployment from a cron trigger and reports Ready and Active', async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const factory = cronApp.factory('direct', {
      namespace: appNamespace,
      kubeConfig,
      waitForReady: true,
      timeout: 300_000,
    });
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        'keda-e2e-app',
        [],
        kubeConfig,
        180_000
      )
    );
    const instance = await factory.deploy({ name: 'keda-e2e-app', replicas: 3 });
    expect(instance.status.ready).toBe(true);
    expect(instance.status.hpa).toBe('keda-hpa-clock');

    const apps = createAppsV1ApiClient(kubeConfig);
    const deadline = Date.now() + 180_000;
    let replicas = 0;
    let active = false;
    while (Date.now() < deadline && (replicas !== 2 || !active)) {
      const live = await apps.readNamespacedDeployment({ name: 'clock', namespace: appNamespace });
      replicas = live.spec?.replicas ?? 0;
      const so = (await createCustomObjectsApiClient(kubeConfig).getNamespacedCustomObject({
        group: 'keda.sh',
        version: 'v1alpha1',
        namespace: appNamespace,
        plural: 'scaledobjects',
        name: 'clock',
      })) as { status?: { conditions?: Array<{ type: string; status: string }> } };
      active =
        so.status?.conditions?.some((c) => c.type === 'Active' && c.status === 'True') ?? false;
      if (replicas !== 2 || !active) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    expect({ replicas, active }).toEqual({ replicas: 2, active: true });
  });

  it('KRO accepts the KEDA RGDs against the live CRD schemas', async () => {
    const kubeConfig = getIntegrationTestKubeConfig();
    const rgds = [kedaHelmRepositoryBootstrap.toYaml(), keda.toYaml(), cronApp.toYaml()]
      .flatMap(manifests)
      .filter((doc) => doc.kind === 'ResourceGraphDefinition');
    const names = [...new Set(rgds.map((rgd) => rgd.metadata.name))];
    expect(names.sort()).toEqual(['keda-bootstrap', 'keda-e2e-app', 'keda-helm-repository']);

    const installer = kubernetesComposition(
      {
        name: 'keda-e2e-rgds',
        kind: 'KedaE2ERgds',
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
        const repository = install('keda-helm-repository', 'repositoryRgd');
        // The bootstrap's externalRef needs the singleton's generated CRD first.
        install('keda-bootstrap', 'bootstrapRgd').dependsOn(repository);
        install('keda-e2e-app', 'appRgd');
        return { ready: true };
      }
    );
    const factory = installer.factory('direct', {
      namespace: 'default',
      kubeConfig,
      waitForReady: true,
      timeout: 180_000,
    });
    const instanceName = `keda-rgds-${runToken}`;
    cleanups.push(() =>
      deleteTestFactoryInstanceAndRecoverNamespaces(
        factory,
        instanceName,
        [],
        kubeConfig,
        120_000,
        {
          scopes: ['cluster'],
          includeUnscopedResources: true,
        }
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
