/**
 * E2E (live cluster): the alchemy **v2** direct-mode fan-out.
 *
 * `factory.toAlchemyResources(spec)` emits one declaration per resource; `materializeAlchemyResources`
 * instantiates them as `KroResource`s wiring `dependsOn` → alchemy `Output` dependencies. This proves
 * the whole chain against a real cluster:
 *   - per-resource state granularity (one alchemy resource per Kubernetes resource),
 *   - dependency ORDERING (the ConfigMap deploys only after the Deployment),
 *   - cross-resource REFERENCE RESOLUTION — the ConfigMap reads the Deployment's LIVE
 *     `status.readyReplicas`, which only resolves if the dependency deployed first, its live status
 *     was captured, and the (alchemy-serialized) CEL ref was re-evaluated in the reconcile,
 *   - reverse-topological TEARDOWN.
 *
 * Direct mode needs no KRO operator (it applies plain manifests), so this runs on any cluster
 * (e.g. OrbStack). Skipped automatically when no cluster is reachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import * as Alchemy from 'alchemy';
import * as Test from 'alchemy/Test/Core';
import * as StateMod from 'alchemy/State';
import { type } from 'arktype';
import { Cel, simple, toResourceGraph } from '../../../src/index.js';
import {
  KroResource,
  kroProvider,
  materializeAlchemyResources,
} from '../../../src/alchemy/index.js';
import { isClusterAvailable } from '../shared-kubeconfig';

const clusterAvailable = isClusterAvailable();
const describeOrSkip = clusterAvailable ? describe : describe.skip;

const NS = 'tk-alchemy-fanout-e2e';

const kubectl = async (...args: string[]): Promise<string> => {
  const p = Bun.spawn(['kubectl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
};

const SpecSchema = type({ name: 'string', image: 'string', replicas: 'number%1' });
const StatusSchema = type({ phase: '"pending" | "running" | "failed"', readyReplicas: 'number%1' });
type AppSpec = typeof SpecSchema.infer;

const makeGraph = () =>
  toResourceGraph(
    { name: 'fanoutapp', apiVersion: 'v1alpha1', kind: 'FanoutApp', spec: SpecSchema, status: StatusSchema },
    (schema) => {
      const deployment = simple.Deployment({
        name: schema.spec.name,
        image: schema.spec.image,
        replicas: schema.spec.replicas,
        id: 'appDeployment',
      });
      return {
        deployment,
        // Reads the Deployment's LIVE status → a genuine cross-resource dependency + reference.
        config: simple.ConfigMap({
          name: Cel.template('%s-cfg', schema.spec.name),
          data: { readyReplicas: Cel.template('%s', deployment.status.readyReplicas) },
          id: 'appConfig',
        }),
      };
    },
    (_schema, resources) => ({
      phase: Cel.expr<'pending' | 'running' | 'failed'>`'running'`,
      readyReplicas: resources.deployment?.status.readyReplicas,
    })
  );

const makeOptions = { providers: kroProvider, state: StateMod.inMemoryState() };
const runDeploy = (s: unknown) =>
  Effect.runPromise(Test.toEffect(Test.deploy(makeOptions, s as never) as never, makeOptions as never));
const runDestroy = (s: unknown) =>
  Effect.runPromise(Test.toEffect(Test.destroy(makeOptions, s as never) as never, makeOptions as never));

describeOrSkip('Alchemy v2 direct-mode fan-out (e2e)', () => {
  beforeAll(async () => {
    if (!clusterAvailable) return;
    await kubectl('create', 'namespace', NS);
  });

  afterAll(async () => {
    if (!clusterAvailable) return;
    await kubectl('delete', 'namespace', NS, '--wait=false', '--ignore-not-found');
  });

  it('deploys per-resource, in dependency order, resolving a cross-resource ref against live state, then tears down', async () => {
    const factory = await makeGraph().factory('direct', { namespace: NS, waitForReady: true, timeout: 120_000 });
    const spec: AppSpec = { name: 'fanapp', image: 'nginx:1.27-alpine', replicas: 1 };

    // Fan-out: one declaration per resource, topologically ordered, ConfigMap dependsOn Deployment.
    const decls = await factory.toAlchemyResources(spec);
    expect(decls.length).toBe(2);
    const deploymentDecl = decls.find((d) => d.props.resourceId === 'appDeployment');
    const configDecl = decls.find((d) => d.props.resourceId === 'appConfig');
    expect(deploymentDecl).toBeDefined();
    expect(configDecl).toBeDefined();
    expect(configDecl?.dependsOn).toContain(deploymentDecl?.id);
    expect(decls.indexOf(deploymentDecl!)).toBeLessThan(decls.indexOf(configDecl!));

    const stack = Alchemy.Stack(
      'tk-alchemy-fanout-e2e',
      makeOptions as never,
      materializeAlchemyResources(KroResource, decls) as never
    );

    try {
      await runDeploy(stack);

      // Both resources landed.
      expect(await kubectl('-n', NS, 'get', 'deployment', 'fanapp', '-o', 'name')).toBe('deployment.apps/fanapp');
      // The ConfigMap carries the Deployment's resolved LIVE readyReplicas (not the literal CEL string).
      const deployReady = await kubectl('-n', NS, 'get', 'deployment', 'fanapp', '-o', 'jsonpath={.status.readyReplicas}');
      const cfgValue = await kubectl('-n', NS, 'get', 'configmap', 'fanapp-cfg', '-o', 'jsonpath={.data.readyReplicas}');
      expect(deployReady).toBe('1');
      expect(cfgValue).toBe('1');
      expect(cfgValue).not.toContain('${');
    } finally {
      await runDestroy(stack);
    }

    // Reverse-topo teardown removed our resources.
    const remaining = await kubectl('-n', NS, 'get', 'deployment,configmap', '-l', 'app=fanapp', '-o', 'name');
    expect(remaining).toBe('');
  }, 180_000);
});
