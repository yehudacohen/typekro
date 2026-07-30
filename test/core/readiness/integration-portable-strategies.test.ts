import { describe, expect, it } from 'bun:test';

import { getReadinessEvaluator } from '../../../src/core/metadata/resource-metadata.js';
import {
  getPortableReadinessStrategy,
  getRuntimeReadinessClassification,
  resolvePortableReadinessStrategy,
} from '../../../src/core/readiness/portable-strategies.js';
import type { ReadinessEvaluator } from '../../../src/core/types/kubernetes.js';
import { gitRepository } from '../../../src/factories/flux/git-repository.js';
import { kustomization } from '../../../src/factories/flux/kustomize/kustomization.js';
import { helmRelease } from '../../../src/factories/helm/helm-release.js';
import {
  createHelmRepositoryReadinessEvaluator,
  helmRepository,
} from '../../../src/factories/helm/helm-repository.js';
import {
  createComprehensiveHelmReadinessEvaluator,
  createHelmRevisionReadinessEvaluator,
  createHelmTestReadinessEvaluator,
  createHelmTimeoutReadinessEvaluator,
} from '../../../src/factories/helm/readiness-evaluators.js';
import {
  ciliumClusterwideNetworkPolicyReadinessEvaluator,
  ciliumNetworkPolicyReadinessEvaluator,
} from '../../../src/factories/cilium/resources/networking.js';
import {
  envoyGatewayPolicyReadinessEvaluator,
} from '../../../src/factories/envoy-ai-gateway/resources/gateway.js';
import { kroCustomResource } from '../../../src/factories/kro/kro-custom-resource.js';
import { resourceGraphDefinition } from '../../../src/factories/kro/resource-graph-definition.js';
import { namespace } from '../../../src/factories/kubernetes/core/namespace.js';
import { service } from '../../../src/factories/kubernetes/networking/service.js';
import { cronJob } from '../../../src/factories/kubernetes/workloads/cron-job.js';
import { deployment } from '../../../src/factories/kubernetes/workloads/deployment.js';
import { job } from '../../../src/factories/kubernetes/workloads/job.js';
import { replicationController } from '../../../src/factories/kubernetes/workloads/replication-controller.js';
import { statefulSet } from '../../../src/factories/kubernetes/workloads/stateful-set.js';

function expectPortableRoundTrip(
  evaluator: ReadinessEvaluator<unknown>,
  liveResource: unknown,
  expectedId: string
): void {
  const strategy = getPortableReadinessStrategy(evaluator);
  expect(strategy).toMatchObject({
    kind: 'registered',
    id: expectedId,
    revision: '1',
  });

  const restored = resolvePortableReadinessStrategy(structuredClone(strategy!));
  expect(restored).toBeDefined();
  expect(restored?.(liveResource)).toEqual(evaluator(liveResource));
}

describe('integration readiness portability', () => {
  it('round-trips HelmRelease readiness, labels, revision checks, and test checks', () => {
    const liveResource = {
      metadata: { generation: 4 },
      status: {
        phase: 'Ready',
        revision: 3,
        observedGeneration: 4,
        conditions: [{ type: 'TestSuccess', status: 'True' }],
      },
    };
    const resource = helmRelease({
      name: 'portable-release',
      chart: { repository: 'https://example.invalid/charts', name: 'portable' },
    });
    const evaluator = getReadinessEvaluator(resource);
    expect(evaluator).toBeDefined();

    expectPortableRoundTrip(evaluator!, liveResource, 'typekro.readiness.flux.helm-release');
    expectPortableRoundTrip(
      createHelmRevisionReadinessEvaluator(3),
      liveResource,
      'typekro.readiness.flux.helm-release-revision'
    );
    expectPortableRoundTrip(
      createHelmTestReadinessEvaluator(true),
      liveResource,
      'typekro.readiness.flux.helm-release-test'
    );
  });

  it('round-trips labeled and factory-attached HelmRepository readiness', () => {
    const liveResource = {
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
      spec: { type: 'default' },
      metadata: { generation: 1, resourceVersion: '1' },
    };
    const resource = helmRepository({
      name: 'portable-repository',
      url: 'https://example.invalid/charts',
    });
    const evaluator = getReadinessEvaluator(resource);
    expect(evaluator).toBeDefined();

    expectPortableRoundTrip(evaluator!, liveResource, 'typekro.readiness.flux.helm-repository');
    expectPortableRoundTrip(
      createHelmRepositoryReadinessEvaluator('Portable'),
      liveResource,
      'typekro.readiness.flux.helm-repository'
    );
  });

  it('round-trips Flux GitRepository and Kustomization readiness', () => {
    const repository = gitRepository({
      name: 'portable-source',
      url: 'https://example.invalid/repository.git',
      interval: '5m',
    });
    const repositoryEvaluator = getReadinessEvaluator(repository);
    expect(repositoryEvaluator).toBeDefined();
    expectPortableRoundTrip(
      repositoryEvaluator!,
      {
        status: {
          artifact: { revision: 'main@sha1:abc' },
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
      'typekro.readiness.flux.git-repository'
    );

    const overlay = kustomization({
      name: 'portable-overlay',
      source: { kind: 'GitRepository', name: 'portable-source' },
    });
    const overlayEvaluator = getReadinessEvaluator(overlay);
    expect(overlayEvaluator).toBeDefined();
    expectPortableRoundTrip(
      overlayEvaluator!,
      {
        status: {
          conditions: [
            { type: 'Ready', status: 'True' },
            { type: 'Healthy', status: 'True' },
          ],
          inventory: { entries: [{ id: 'apps_v1_Deployment_default_app' }] },
        },
      },
      'typekro.readiness.flux.kustomization'
    );
  });

  it('classifies clock-dependent Helm evaluators as runtime-only', () => {
    expect(getRuntimeReadinessClassification(createHelmTimeoutReadinessEvaluator(5))).toEqual({
      reason: 'ambient-clock',
      description:
        'Helm timeout readiness compares resource timestamps with the host clock (5 minute limit).',
    });
    expect(
      getRuntimeReadinessClassification(
        createComprehensiveHelmReadinessEvaluator({ timeoutMinutes: 7 })
      )
    ).toEqual({
      reason: 'ambient-clock',
      description: 'Comprehensive Helm readiness includes a host-clock timeout (7 minute limit).',
    });
  });

  it('classifies clock-dependent Cilium policies as runtime-only', () => {
    for (const evaluator of [
      ciliumNetworkPolicyReadinessEvaluator,
      ciliumClusterwideNetworkPolicyReadinessEvaluator,
    ]) {
      expect(getRuntimeReadinessClassification(evaluator)).toEqual({
        reason: 'ambient-clock',
        description:
          'Cilium policy readiness uses resource age as a fallback when the operator has not reported status.',
      });
      expect(getPortableReadinessStrategy(evaluator)).toBeUndefined();
    }
  });

  it('round-trips Envoy Gateway policy readiness without losing terminal failures', () => {
    expectPortableRoundTrip(
      envoyGatewayPolicyReadinessEvaluator,
      {
        metadata: { generation: 2 },
        status: {
          ancestors: [
            {
              conditions: [
                {
                  type: 'ResolvedRefs',
                  status: 'False',
                  reason: 'InvalidReference',
                  observedGeneration: 2,
                },
              ],
            },
          ],
        },
      },
      'typekro.readiness.envoy-ai-gateway.policy'
    );
  });

  it('round-trips parameterized Kubernetes workload and Service readiness', () => {
    const application = deployment({
      metadata: { name: 'portable-deployment' },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'portable' } },
        template: {
          metadata: { labels: { app: 'portable' } },
          spec: { containers: [{ name: 'app', image: 'example.invalid/app' }] },
        },
      },
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(application)!,
      { status: { readyReplicas: 3, availableReplicas: 3, updatedReplicas: 3 } },
      'typekro.readiness.kubernetes.deployment'
    );

    const database = statefulSet({
      metadata: { name: 'portable-stateful-set' },
      spec: {
        replicas: 2,
        serviceName: 'portable-stateful-set',
        selector: { matchLabels: { app: 'database' } },
        template: {
          metadata: { labels: { app: 'database' } },
          spec: { containers: [{ name: 'database', image: 'example.invalid/database' }] },
        },
        updateStrategy: { type: 'OnDelete' },
      },
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(database)!,
      { status: { readyReplicas: 2, currentReplicas: 2, updatedReplicas: 1 } },
      'typekro.readiness.kubernetes.stateful-set'
    );

    const endpoint = service({
      metadata: { name: 'portable-service' },
      spec: {
        type: 'LoadBalancer',
        ports: [{ port: 443 }],
        selector: { app: 'portable' },
      },
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(endpoint)!,
      { status: { loadBalancer: { ingress: [{ hostname: 'portable.example.invalid' }] } } },
      'typekro.readiness.kubernetes.service'
    );

    const migration = job({
      metadata: { name: 'portable-job' },
      spec: {
        completions: 3,
        parallelism: 2,
        completionMode: 'Indexed',
        backoffLimit: 4,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [{ name: 'migration', image: 'example.invalid/migration' }],
          },
        },
      },
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(migration)!,
      { status: { succeeded: 2, active: 1, failed: 0 } },
      'typekro.readiness.kubernetes.job'
    );
  });

  it('round-trips remaining parameterized and static Kubernetes readiness families', () => {
    const scheduled = cronJob({
      metadata: { name: 'portable-cron-job' },
      spec: {
        schedule: '0 * * * *',
        suspend: true,
        jobTemplate: {
          spec: {
            template: {
              spec: {
                restartPolicy: 'Never',
                containers: [{ name: 'task', image: 'example.invalid/task' }],
              },
            },
          },
        },
      },
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(scheduled)!,
      { status: { active: [] } },
      'typekro.readiness.kubernetes.cron-job'
    );

    const replicated = replicationController({
      metadata: { name: 'portable-replication-controller' },
      spec: { replicas: 2 },
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(replicated)!,
      { status: { readyReplicas: 2, availableReplicas: 2 } },
      'typekro.readiness.kubernetes.replication-controller'
    );

    const isolated = namespace({ metadata: { name: 'portable-namespace' } });
    expectPortableRoundTrip(
      getReadinessEvaluator(isolated)!,
      { status: { phase: 'Active' } },
      'typekro.readiness.kubernetes.namespace'
    );
  });

  it('round-trips TypeKro KRO lifecycle readiness', () => {
    const graph = resourceGraphDefinition({ metadata: { name: 'portable-graph' }, spec: {} });
    expectPortableRoundTrip(
      getReadinessEvaluator(graph)!,
      {
        metadata: { generation: 1 },
        status: {
          state: 'Active',
          conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
        },
      },
      'typekro.readiness.kro.resource-graph-definition'
    );

    const instance = kroCustomResource<Record<string, never>, Record<string, never>>({
      apiVersion: 'testing.kro.run/v1alpha1',
      kind: 'PortableApplication',
      metadata: { name: 'portable-application' },
      spec: {},
    });
    expectPortableRoundTrip(
      getReadinessEvaluator(instance)!,
      {
        status: {
          state: 'ACTIVE',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
      'typekro.readiness.kro.custom-resource'
    );
  });
});
