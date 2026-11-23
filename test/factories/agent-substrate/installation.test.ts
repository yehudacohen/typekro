import { describe, expect, test } from 'bun:test';
import { ReadinessEvaluatorRegistry } from '../../../src/core/readiness/index.js';
import type { KubernetesResource } from '../../../src/core/types/index.js';
import {
  agentSubstrateCommit,
  agentSubstrateInstallation,
} from '../../../src/factories/agent-substrate/index.js';
import {
  substrateDeploymentReadiness,
  substrateSandboxConfigReadiness,
  substrateWorkerPoolReadiness,
} from '../../../src/factories/agent-substrate/readiness.js';

const namespace = 'renderer-test';
const image = `registry.example.test/renderer@sha256:${'a'.repeat(64)}`;
function manifests(): KubernetesResource[] {
  const workload = (kind: string, name: string): KubernetesResource => ({
    apiVersion: 'apps/v1',
    kind,
    metadata: { name, namespace },
    spec: {
      template: {
        spec: { containers: [{ image, readinessProbe: { httpGet: { path: '/readyz' } } }] },
      },
    },
  });
  return [
    ...['workerpools', 'sandboxconfigs'].map((name) => ({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: `${name}.ate.dev` },
    })),
    ...['ate-api-server', 'ate-idp-server', 'atenet-router', 'atenet-egress', 'ate-controller'].map(
      (name) => workload('Deployment', name)
    ),
    ...['api', 'atenet-router', 'atenet-egress'].map((name) => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace },
    })),
    workload('DaemonSet', 'atelet'),
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'renderer', namespace },
    },
    { apiVersion: 'ate.dev/v1', kind: 'SandboxConfig', metadata: { name: 'renderer-pinned' } },
    {
      apiVersion: 'ate.dev/v1',
      kind: 'WorkerPool',
      metadata: { name: 'renderer', namespace },
      spec: { replicas: 1 },
    },
  ];
}

describe('Agent Substrate v1 installation', () => {
  test('lowers the pinned bundle through the direct composition', () => {
    const registry = ReadinessEvaluatorRegistry.getInstance();
    const deploymentEvaluator = registry.getEvaluatorForKind('Deployment');
    const graph = agentSubstrateInstallation({
      sourceCommit: agentSubstrateCommit,
      namespace,
      manifests: manifests(),
    });
    const yaml = graph.factory('direct', { namespace }).toYaml({});
    expect(yaml).toContain('kind: WorkerPool');
    expect(yaml).toContain('kind: SandboxConfig');
    expect(yaml).toContain('name: ate-api-server');
    expect(registry.getEvaluatorForKind('Deployment')).toBe(deploymentEvaluator);
  });

  test('refuses gRPC resources and unpinned images', () => {
    expect(() =>
      agentSubstrateInstallation({
        sourceCommit: agentSubstrateCommit,
        namespace,
        manifests: [
          ...manifests(),
          {
            apiVersion: 'ate.dev/v1',
            kind: 'ActorTemplate',
            metadata: { name: 'test', namespace },
          },
        ],
      })
    ).toThrow(/clean Kubernetes manifests/u);
    const changed = manifests().map((item) =>
      item.metadata.name === 'ate-api-server'
        ? { ...item, spec: { template: { spec: { containers: [{ image: 'neutral:latest' }] } } } }
        : item
    );
    expect(() =>
      agentSubstrateInstallation({
        sourceCommit: agentSubstrateCommit,
        namespace,
        manifests: changed,
      })
    ).toThrow(/pinned by digest/u);
    const uncheckedRouter = manifests().map((item) =>
      item.kind === 'Deployment' && item.metadata.name === 'atenet-router'
        ? { ...item, spec: { template: { spec: { containers: [{ image }] } } } }
        : item
    );
    expect(() =>
      agentSubstrateInstallation({
        sourceCommit: agentSubstrateCommit,
        namespace,
        manifests: uncheckedRouter,
      })
    ).toThrow(/atenet-router.*readyz/u);
  });

  test('waits for the current rollout and exact sandbox resolution', () => {
    const rollout = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'api', generation: 2 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        replicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 1,
      },
    };
    expect(substrateDeploymentReadiness(rollout).ready).toBe(true);
    expect(
      substrateDeploymentReadiness({ ...rollout, metadata: { ...rollout.metadata, generation: 3 } })
        .ready
    ).toBe(false);
    expect(
      substrateDeploymentReadiness({ ...rollout, status: { ...rollout.status, replicas: 2 } }).ready
    ).toBe(false);
    const sandboxClass = { name: 'gvisor', configRef: { name: 'renderer-pinned' } };
    const pool = {
      apiVersion: 'ate.dev/v1',
      kind: 'WorkerPool',
      metadata: { name: 'renderer', generation: 2 },
      spec: {
        replicas: 1,
        workerImage: image,
        template: { nodeSelector: { 'kubernetes.io/arch': 'arm64' } },
        sandboxClasses: [sandboxClass],
      },
      status: {
        replicas: 1,
        readyReplicas: 1,
        selector: 'pool=renderer',
        sandboxClasses: [
          {
            ...sandboxClass,
            conditions: [{ type: 'Resolved', status: 'True', observedGeneration: 2 }],
          },
        ],
      },
    };
    expect(substrateWorkerPoolReadiness(pool).ready).toBe(true);
    expect(
      substrateWorkerPoolReadiness({ ...pool, status: { ...pool.status, readyReplicas: 0 } }).ready
    ).toBe(false);
    expect(
      substrateWorkerPoolReadiness({ ...pool, metadata: { ...pool.metadata, generation: 3 } }).ready
    ).toBe(false);
    expect(
      substrateWorkerPoolReadiness({
        ...pool,
        spec: { ...pool.spec, workerImage: 'neutral:latest' },
      }).ready
    ).toBe(false);
    const config = {
      apiVersion: 'ate.dev/v1',
      kind: 'SandboxConfig',
      metadata: { name: 'renderer-pinned' },
      spec: {
        sandboxClass: 'gvisor',
        defaultVersion: 'qualified',
        versions: [
          {
            name: 'qualified',
            state: 'Enabled',
            assets: {
              arm64: { gvisor: { url: 'https://example.test/asset', sha256: '5'.repeat(64) } },
            },
          },
        ],
      },
    };
    expect(substrateSandboxConfigReadiness(config).ready).toBe(true);
    expect(
      substrateSandboxConfigReadiness({
        ...config,
        spec: { ...config.spec, defaultVersion: 'unknown' },
      }).ready
    ).toBe(false);
  });
});
